/**
 * CloudBase 真实环境集成验证（可选，不进 npm test）
 * ---------------------------------------------------------------------------
 * 用途：用户在腾讯云控制台创建环境与 game_rooms 集合、配置好本地环境变量后，
 *       手动运行本脚本验证接入是否可用。只创建/删除 `_test-` 前缀的临时文档，
 *       绝不读写真实房间文档。
 *
 * 运行（ESM 文件，不能用 require）：
 *   CLOUDBASE_ENV_ID=xxx CLOUDBASE_APIKEY=xxx node tests/cloudbase-integration.mjs
 *   （或使用 TENCENTCLOUD_SECRETID/TENCENTCLOUD_SECRETKEY 认证）
 *
 * 干跑（无凭据时验证脚本流程与仓库接口契约，使用内存实现，不连接 CloudBase）：
 *   node tests/cloudbase-integration.mjs --dry-run
 *   （等价于 CLOUDBASE_DRYRUN=1）
 */
import repoModule from '../roomRepository.js';

const { createCloudBaseRepo, createMemoryRepo } = repoModule;

const dryRun = process.argv.includes('--dry-run') || process.env.CLOUDBASE_DRYRUN === '1';

function buildRepo() {
  if (dryRun) {
    console.log('[干跑] 使用内存实现验证脚本流程与仓库接口契约，不连接 CloudBase、不产生任何云端读写。\n');
    return { repo: createMemoryRepo(), label: '干跑（内存实现）' };
  }
  if (!process.env.CLOUDBASE_ENV_ID) {
    console.error('缺少 CLOUDBASE_ENV_ID（可再配 CLOUDBASE_APIKEY 或 TENCENTCLOUD_SECRETID/SECRETKEY）。');
    console.error('若只想验证脚本本身，可加 --dry-run 使用内存实现干跑。');
    process.exit(2);
  }
  return {
    repo: createCloudBaseRepo({
      envId: process.env.CLOUDBASE_ENV_ID,
      accessKey: process.env.CLOUDBASE_APIKEY,
      secretId: process.env.TENCENTCLOUD_SECRETID,
      secretKey: process.env.TENCENTCLOUD_SECRETKEY,
      region: process.env.CLOUDBASE_REGION,
      collection: process.env.CLOUDBASE_COLLECTION,
    }),
    label: 'CloudBase（env=' + process.env.CLOUDBASE_ENV_ID + '）',
  };
}

const results = [];
function step(name, ok, extra) {
  results.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
}
/** 执行一个检查：异常只记 FAIL，不中断后续步骤（便于一次看到全部问题） */
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === undefined) return step(name, true);
    if (r && typeof r === 'object' && 'ok' in r) return step(name, !!r.ok, r.extra);
    step(name, !!r);
  } catch (e) {
    step(name, false, (e && e.message) || String(e));
  }
}

async function main() {
  const { repo, label } = buildRepo();
  console.log('目标：' + label + '\n');

  const id = '_test-' + Date.now().toString(36);
  const baseDoc = {
    _id: id,
    schemaVersion: 1,
    revision: 1,
    state: '{"board":[["x"]],"currentTurn":"red"}',
    metadata: { seq: 0, specCap: 3, specNextId: 1, ownerToken: null, seats: { red: null, black: null }, specs: [], pendingRestart: null },
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600 * 1000),
  };

  // 1) 健康检查（集合不存在/权限不足会在这里给出明确错误）
  await check('ping（集合可读）', async () => { await repo.ping(); return true; });

  // 2) 插入 + 读取
  let inserted = false;
  await check('insertRoomDoc', async () => { await repo.insertRoomDoc(baseDoc); inserted = true; return true; });
  await check('getRoomDoc 读回一致', async () => {
    const got = await repo.getRoomDoc(id);
    return { ok: !!got && got._id === id && got.revision === 1, extra: got ? 'revision=' + got.revision : '未读到文档' };
  });
  await check('重复插入被拒（DUPLICATE）', async () => {
    try { await repo.insertRoomDoc(baseDoc); return { ok: false, extra: '重复 _id 竟然插入成功' }; }
    catch (e) { return { ok: e && e.code === 'DUPLICATE', extra: e && (e.code || e.message) }; }
  });
  await check('listActiveRoomDocs 包含该文档', async () => {
    const list = await repo.listActiveRoomDocs(new Date());
    return { ok: list.some(d => d._id === id), extra: 'count=' + list.length };
  });

  // 3) 条件更新：revision 匹配 → 成功
  await check('updateRoomDoc(revision=1 命中)', async () => {
    const r = await repo.updateRoomDoc(id, 1, Object.assign({}, baseDoc, { revision: 2 }));
    return { ok: r.ok === true, extra: JSON.stringify(r) };
  });

  // 4) 条件更新：revision 不匹配 → 必须 conflict 且不覆盖新快照
  await check('updateRoomDoc(旧 revision 被拒)', async () => {
    const r = await repo.updateRoomDoc(id, 1, Object.assign({}, baseDoc, { revision: 99 }));
    return { ok: r.ok === false && r.reason === 'conflict', extra: JSON.stringify(r) };
  });
  await check('旧 revision 未覆盖新快照', async () => {
    const got = await repo.getRoomDoc(id);
    return { ok: !!got && got.revision === 2, extra: '实际 revision=' + (got && got.revision) };
  });

  // 5) 过期清理（用一个已过期文档验证，不影响真实房间：只操作 _test- 前缀）
  const staleId = '_test-stale-' + Date.now().toString(36);
  await check('过期文档可被清理', async () => {
    await repo.insertRoomDoc(Object.assign({}, baseDoc, {
      _id: staleId, revision: 1, expiresAt: new Date(Date.now() - 60 * 1000),
    }));
    const n = await repo.deleteExpiredRooms(new Date());
    const gone = await repo.getRoomDoc(staleId);
    return { ok: n >= 1 && gone === null, extra: 'deleted=' + n };
  });

  // 6) 清理临时文档
  await check('deleteRoomDoc（清理完成）', async () => {
    await repo.deleteRoomDoc(id);
    const got = await repo.getRoomDoc(id);
    return { ok: got === null, extra: got ? '文档仍存在' : '' };
  });

  const failed = results.filter(r => !r.ok);
  console.log('\n合计 ' + results.length + ' 项：通过 ' + (results.length - failed.length) + '，失败 ' + failed.length);
  if (failed.length) {
    console.log('失败项：' + failed.map(r => r.name).join('、'));
    if (!dryRun) console.log('（请到控制台检查环境 ID、集合名 game_rooms、API Key 权限；临时文档前缀 _test- 可手动删除）');
    process.exit(1);
  }
  console.log(dryRun
    ? '干跑通过：脚本流程与仓库接口契约正确。配置真实凭据后去掉 --dry-run 再跑一次即可验证 CloudBase。'
    : '集成验证结束：全部 PASS，可按 README 的「房间持久化（可选）」一节配置 Render 环境变量。');
}

main().catch(e => { console.error('集成验证异常：', (e && e.message) || e); process.exit(1); });
