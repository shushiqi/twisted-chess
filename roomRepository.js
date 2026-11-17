'use strict';
/**
 * 揭棋 · 房间持久化仓库（roomRepository）
 * ---------------------------------------------------------------------------
 * 两种实现，接口完全一致（所有方法返回 Promise）：
 *   createCloudBaseRepo(config)  腾讯云 CloudBase 文档数据库（@cloudbase/js-sdk v3，
 *                                官方说明自 v3.1 起内置 Node 适配器、取代 node-sdk）
 *   createMemoryRepo()           纯内存实现，仅供测试注入（支持故障注入与访问记录）
 *   createRoomRepositoryFromEnv() 按 CLOUDBASE_ENV_ID 等环境变量决定是否启用
 *
 * 接口约定：
 *   ping()                                   健康检查（读一次集合）
 *   insertRoomDoc(doc)                       新建文档，_id 已存在时抛 DUPLICATE
 *   getRoomDoc(id)                           读取，不存在返回 null
 *   updateRoomDoc(id, expectedRevision, doc) 条件更新（乐观锁）：
 *                                            → { ok:true }
 *                                            → { ok:false, reason:'conflict' }（revision 不匹配）
 *                                            数据库故障时直接抛错
 *   deleteRoomDoc(id)                        删除
 *   listActiveRoomDocs(now)                  expiresAt > now 的全部文档（启动恢复用）
 *   deleteExpiredRooms(now)                  批量删除 expiresAt <= now 的文档，返回删除数（幂等）
 *
 * 环境变量（CloudBase，认证二选一，均为官方 SDK 原生支持的方式）：
 *   CLOUDBASE_ENV_ID     必填；存在即视为启用持久化
 *   CLOUDBASE_APIKEY     CloudBase API Key（服务端身份，控制台获取）
 *   TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY   腾讯云密钥对（备选认证）
 *   CLOUDBASE_REGION     可选，默认 ap-shanghai（CloudBase 文档库目前仅上海地域）
 *   CLOUDBASE_COLLECTION 可选，集合名，默认 game_rooms
 *
 * 安全：文档内含席位 token（服务端私有数据），本模块与调用方均不得把
 *       token / 密钥写进日志或下发客户端。
 */

const SCHEMA_VERSION = 1;
const DEFAULT_COLLECTION = 'game_rooms';

// ---------- 错误包装：保留原始信息，附上可读上下文 ----------
function wrapDbError(op, id, e) {
  const err = new Error('CloudBase ' + op + (id ? '(' + id + ')' : '') + ' 失败：' + ((e && (e.message || e.code)) || e));
  err.cause = e;
  return err;
}
function duplicateError(id) {
  const e = new Error('房间文档已存在：' + id);
  e.code = 'DUPLICATE';
  return e;
}

// ---------- CloudBase 文档数据库实现 ----------
function createCloudBaseRepo(config) {
  const cfg = config || {};
  if (!cfg.envId) throw new Error('缺少 CLOUDBASE_ENV_ID');

  let sdk;
  try { sdk = require('@cloudbase/js-sdk'); }
  catch (e) {
    const err = new Error('未安装 @cloudbase/js-sdk（请先 npm install）');
    err.code = 'SDK_MISSING';
    throw err;
  }

  // 认证参数：显式传入与 SDK 自动读取环境变量（CLOUDBASE_APIKEY / TENCENTCLOUD_*）等价，
  // 这里显式传入便于本地测试与错误定位。API Key 与云密钥二选一。
  const initParams = { env: cfg.envId };
  if (cfg.accessKey) initParams.accessKey = cfg.accessKey;
  if (cfg.secretId && cfg.secretKey) { initParams.secretId = cfg.secretId; initParams.secretKey = cfg.secretKey; }
  if (cfg.region) initParams.region = cfg.region;
  // 官方初始化参数名是 timeout（毫秒，默认 15000），不是 timeoutMs；
  // 字段名写错不会报错，只会被 SDK 忽略而退回默认值，因此在这里统一映射。
  const timeout = Number(cfg.timeoutMs);
  if (Number.isFinite(timeout) && timeout > 0) initParams.timeout = timeout;

  const app = sdk.init(initParams);
  const db = app.database();
  const col = db.collection(cfg.collection || DEFAULT_COLLECTION);
  const cmd = db.command;

  // set/update 的 data 不允许包含 _id
  const strip = doc => { const d = Object.assign({}, doc); delete d._id; return d; };
  const first = r => (r && Array.isArray(r.data) ? r.data[0] : (r && r.data)) || null;

  return {
    kind: 'cloudbase',

    async ping() {
      await col.limit(1).get().catch(e => { throw wrapDbError('ping', null, e); });
      return { ok: true };
    },

    async insertRoomDoc(doc) {
      const exist = await col.doc(doc._id).get().catch(e => { throw wrapDbError('get', doc._id, e); });
      if (first(exist)) throw duplicateError(doc._id);
      await col.doc(doc._id).set(strip(doc)).catch(e => { throw wrapDbError('insert', doc._id, e); });
    },

    async getRoomDoc(id) {
      const r = await col.doc(id).get().catch(e => { throw wrapDbError('get', id, e); });
      return first(r);
    },

    // 条件更新：where(_id + revision) 命中才写入，updated===1 即乐观锁通过。
    // 这是本项目的并发防线之二（防线之一是服务端每房间串行锁，见 server.js）。
    async updateRoomDoc(id, expectedRevision, doc) {
      const r = await col.where({ _id: id, revision: expectedRevision })
        .update(strip(doc))
        .catch(e => { throw wrapDbError('update', id, e); });
      if (r && r.updated === 1) return { ok: true };
      return { ok: false, reason: 'conflict' };
    },

    async deleteRoomDoc(id) {
      await col.doc(id).remove().catch(e => { throw wrapDbError('delete', id, e); });
    },

    async listActiveRoomDocs(now) {
      const r = await col.where({ expiresAt: cmd.gt(now || new Date()) })
        .limit(1000)
        .get()
        .catch(e => { throw wrapDbError('list', null, e); });
      return (r && r.data) || [];
    },

    async deleteExpiredRooms(now) {
      const r = await col.where({ expiresAt: cmd.lte(now || new Date()) })
        .remove()
        .catch(e => { throw wrapDbError('purge', null, e); });
      return (r && r.deleted) || 0;
    },
  };
}

// ---------- 内存实现（测试专用） ----------
function cloneDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}

function createMemoryRepo() {
  const docs = new Map();
  const failures = [];   // { ops:[..], times:n, error }  故障注入
  const access = [];     // { op, id, at }                访问记录（断言用）
  const rec = (op, id) => ({ op, id: id || null, at: Date.now() });

  function failFor(op) {
    for (let i = 0; i < failures.length; i++) {
      const f = failures[i];
      if (f.ops.indexOf(op) >= 0 && f.times > 0) {
        f.times--;
        if (f.times <= 0) failures.splice(i, 1);
        return f.error || new Error('注入的存储故障');
      }
    }
    return null;
  }

  return {
    kind: 'memory',
    access,
    /** 故障注入：ops 如 ['update'] 或 ['update','insert']，times 生效次数 */
    setFailure(ops, times, error) {
      failures.push({ ops: Array.isArray(ops) ? ops : [ops], times, error });
    },
    /** 清空所有未消费的故障注入（用例之间隔离用） */
    clearFailures() { failures.length = 0; },
    /** 直接放入/覆盖一个文档（构造测试数据用，绕过接口） */
    seed(doc) { docs.set(doc._id, cloneDoc(doc)); },
    dump() { return Array.from(docs.values()).map(cloneDoc); },
    docCount() { return docs.size; },

    async ping() { access.push(rec('ping')); return { ok: true }; },

    async insertRoomDoc(doc) {
      access.push(rec('insert', doc._id));
      const f = failFor('insert'); if (f) throw f;
      if (docs.has(doc._id)) throw duplicateError(doc._id);
      docs.set(doc._id, cloneDoc(doc));
    },

    async getRoomDoc(id) {
      access.push(rec('get', id));
      const f = failFor('get'); if (f) throw f;
      return docs.has(id) ? cloneDoc(docs.get(id)) : null;
    },

    async updateRoomDoc(id, expectedRevision, doc) {
      access.push(rec('update', id));
      const f = failFor('update'); if (f) throw f;
      const cur = docs.get(id);
      if (!cur || cur.revision !== expectedRevision) return { ok: false, reason: 'conflict' };
      const next = cloneDoc(doc); next._id = id;
      docs.set(id, next);
      return { ok: true };
    },

    async deleteRoomDoc(id) {
      access.push(rec('delete', id));
      const f = failFor('delete'); if (f) throw f;
      docs.delete(id);
    },

    async listActiveRoomDocs(now) {
      access.push(rec('list'));
      const f = failFor('list'); if (f) throw f;
      const t = (now || new Date()).getTime();
      return Array.from(docs.values())
        .filter(d => new Date(d.expiresAt).getTime() > t)
        .map(cloneDoc);
    },

    async deleteExpiredRooms(now) {
      access.push(rec('purge'));
      const t = (now || new Date()).getTime();
      let n = 0;
      for (const [id, d] of docs) {
        if (new Date(d.expiresAt).getTime() <= t) { docs.delete(id); n++; }
      }
      return n;
    },
  };
}

// ---------- 按环境变量构造（服务启动入口用） ----------
function createRoomRepositoryFromEnv(env) {
  const e = env || process.env;
  const envId = e.CLOUDBASE_ENV_ID;
  if (!envId) return { enabled: false, reason: '未配置 CLOUDBASE_ENV_ID（房间仅保存在内存）' };

  const accessKey = e.CLOUDBASE_APIKEY;
  const secretId = e.TENCENTCLOUD_SECRETID;
  const secretKey = e.TENCENTCLOUD_SECRETKEY;
  if (!accessKey && !(secretId && secretKey)) {
    return { enabled: false, reason: '已配置 CLOUDBASE_ENV_ID，但缺少凭据（需要 CLOUDBASE_APIKEY，或 TENCENTCLOUD_SECRETID+TENCENTCLOUD_SECRETKEY）' };
  }

  return {
    enabled: true,
    repo: createCloudBaseRepo({
      envId,
      accessKey,
      secretId, secretKey,
      region: e.CLOUDBASE_REGION,
      collection: e.CLOUDBASE_COLLECTION,
    }),
  };
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_COLLECTION,
  createCloudBaseRepo,
  createMemoryRepo,
  createRoomRepositoryFromEnv,
};
