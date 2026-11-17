'use strict';
// 房间持久化测试（node --test）：通过注入内存仓库（createMemoryRepo）验证
// 建房/走棋持久化、写库失败不广播、重启恢复、token 找回席位、过期/坏文档隔离、
// revision 冲突收敛。不依赖真实 CloudBase（真实环境的可选集成见 cloudbase-integration.mjs）。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
process.env.RESTART_TIMEOUT_MS = '120000';   // 询问超时足够长，用过期文档路径单独验证
const srv = require('../server.js');
const { createMemoryRepo, SCHEMA_VERSION } = require('../roomRepository.js');

let port;
let repo;        // 注入的内存仓库（跨"重启"保留，充当数据库）

function makeClient() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs = [];
  const waiters = [];
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    msgs.push(m);
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].pred(m)) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(m);
        return;
      }
    }
  });
  return {
    ws,
    ready: new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    got: msgs,
    send: o => ws.send(JSON.stringify(o)),
    next(pred, ms = 3000) {
      const hit = msgs.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待消息超时')), ms);
        waiters.push({ pred, resolve, timer });
      });
    },
    clear() { msgs.length = 0; },
    close() { try { ws.close(); } catch (e) {} },
  };
}

async function newRoom() {
  const r = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST' });
  return (await r.json()).roomId;
}
async function joinRoom(id, token, role) {
  const c = makeClient();
  await c.ready;
  c.send({ t: 'join', room: id, token, role });
  const m = await c.next(x => x.t === 'joined' || x.t === 'error');
  return { c, m };
}
const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));

function findMove(view, seat) {
  const E = srv.loadEngine();
  E.loadState(JSON.stringify(view));
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = E.board[r][c];
    if (!p || E.sideOf(p) !== seat) continue;
    for (const m of E.getLegalMoves(r, c)) return { from: { r, c }, to: { r: m.r, c: m.c } };
  }
  return null;
}

async function playOneMove(client, view, seat, mid) {
  const mv = findMove(view, seat);
  assert.ok(mv, seat + ' 应有合法走法');
  client.send({ t: 'move', from: mv.from, to: mv.to, mid });
  return mv;
}

/** 模拟服务重启：清空内存房间，从仓库重新恢复（等价于进程重启后的 initPersistence） */
async function restartServer() {
  srv.rooms.clear();
  return await srv.initPersistence({ repo });
}

before(async () => {
  repo = createMemoryRepo();
  const r = await srv.initPersistence({ repo, ttlMs: 24 * 60 * 60 * 1000 });
  assert.equal(r.state, 'ok');
  const addr = await srv.start(0, '127.0.0.1');
  port = addr.port;
});

after(async () => {
  await srv.stop();
});

// ---------- 1/2. 建房与走棋都会落库 ----------
test('P1) 创建房间后数据库文档存在（schemaVersion/revision/state）', async () => {
  const roomId = await newRoom();
  const docs = repo.dump().filter(d => d._id === roomId);
  assert.equal(docs.length, 1, '建房必须先落库');
  assert.equal(docs[0].schemaVersion, SCHEMA_VERSION);
  assert.equal(docs[0].revision, 1);
  assert.equal(docs[0].metadata.seats.red, null);
  assert.ok(JSON.parse(docs[0].state).board, '文档保存完整 saveState()');
  assert.ok(Number.isFinite(new Date(docs[0].expiresAt).getTime()));
});

test('P2) 走棋后最新快照与 revision 已保存', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  await tick();

  await playOneMove(a.c, a.m.state, 'red', 1);
  const s = await a.c.next(x => x.t === 'state');
  assert.equal(s.state.handNo, 1);

  const doc = repo.dump().find(d => d._id === roomId);
  assert.ok(doc, '房间文档存在');
  assert.equal(doc.revision, 4, '建房 1 + 两次入座 + 一次走子 = revision 4');
  const st = JSON.parse(doc.state);
  assert.equal(st.handNo, 1, '文档里的棋局是最新的');
  assert.equal(doc.metadata.seats.red.token, a.m.token, '席位 token 已保存');
  assert.equal(doc.metadata.seats.black.token, b.m.token);
  a.c.close(); b.c.close();
});

// ---------- 3. 写库失败：不广播未保存的状态，内存回滚 ----------
test('P3) 数据库写入失败：走子收到错误、双方都收不到 state、棋局停在上一步', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  await tick();

  // 先正常走一步，记下当时的文档
  await playOneMove(a.c, a.m.state, 'red', 1);
  await a.c.next(x => x.t === 'state');
  const docBefore = repo.dump().find(d => d._id === roomId);

  // 注入一次 update 故障：黑方走子必然失败
  repo.setFailure(['update'], 1);
  a.c.clear(); b.c.clear();
  await playOneMove(b.c, JSON.parse(docBefore.state), 'black', 1);
  const err = await b.c.next(x => x.t === 'error');
  assert.equal(err.code, 'storage_error', '走子方应收到存储错误');

  await tick(300);
  assert.ok(!a.c.got.some(x => x.t === 'state'), '对手绝不能收到未保存的状态');
  assert.ok(!b.c.got.some(x => x.t === 'state' && x.state.handNo === 2), '走子方自己也拿不到新局面');

  // 数据库仍停留在第一步；内存房间也回滚到第一步（走子失败可重试）
  const docAfter = repo.dump().find(d => d._id === roomId);
  assert.equal(JSON.parse(docAfter.state).handNo, 1, '文档未被失败写入污染');
  const room = srv.rooms.get(roomId);
  assert.equal(JSON.parse(room.state).handNo, 1, '内存已回滚到最后保存的快照');

  // 故障解除后重试（客户端会带新 mid）：恢复正常
  b.c.clear(); a.c.clear();
  await playOneMove(b.c, JSON.parse(docAfter.state), 'black', 2);
  const s2 = await b.c.next(x => x.t === 'state');
  assert.equal(s2.state.handNo, 2, '存储恢复后走子成功');
  a.c.close(); b.c.close();
});

// ---------- 4. 同一 mid 重复请求不重复落子 ----------
test('P4) 同一 mid 重复到达：只落一子（幂等保留）', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  await tick();

  const mv = findMove(a.m.state, 'red');
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });
  await a.c.next(x => x.t === 'state');
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });   // 重发同 mid
  await tick(300);
  assert.ok(!a.c.got.some(x => x.t === 'state' && x.state.handNo === 2), '重复 mid 不得重复落子');
  const doc = repo.dump().find(d => d._id === roomId);
  assert.equal(JSON.parse(doc.state).handNo, 1);
  a.c.close(); b.c.close();
});

// ---------- 5/6/7. 服务重启恢复 ----------
test('P5) 服务重启后房间、棋盘、元数据全部恢复', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  await tick();
  await playOneMove(a.c, a.m.state, 'red', 1);
  const s1 = await a.c.next(x => x.t === 'state');
  assert.equal(s1.state.handNo, 1);
  b.c.clear(); a.c.clear();
  await playOneMove(b.c, s1.state, 'black', 1);
  const s2 = await a.c.next(x => x.t === 'state' && x.state.handNo === 2);
  const stateBefore = s2.state;

  a.c.close(); b.c.close();
  const r = await restartServer();
  assert.equal(r.restored >= 1, true, '至少恢复了本用例的房间');

  const room = srv.rooms.get(roomId);
  assert.ok(room, '房间已恢复到内存');
  const st = JSON.parse(room.state);
  assert.equal(st.handNo, 2, '棋局恢复到重启前的手数');
  assert.equal(st.currentTurn, 'red');
  assert.equal(room.metadata === undefined, true);   // 房间对象不该把文档字段原样挂上来
  assert.equal(room.seats.red && !!room.seats.red.token, true, '红方席位 token 已恢复');
  assert.equal(room.ownerToken, a.m.token, '房主身份恢复');
});

test('P6) 原 token 重启后能找回席位；无 token 的新人只能观战', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  await tick();
  await playOneMove(a.c, a.m.state, 'red', 1);
  await a.c.next(x => x.t === 'state');
  const tokens = { a: a.m.token, b: b.m.token };
  a.c.close(); b.c.close();
  await restartServer();

  // 双方凭原 token 重连，坐回原位
  const a2 = await joinRoom(roomId, tokens.a);
  assert.equal(a2.m.t, 'joined');
  assert.equal(a2.m.side, 'red', '原红方 token 找回红方席位');
  const b2 = await joinRoom(roomId, tokens.b);
  assert.equal(b2.m.side, 'black');

  // 无 token 的第三人：席位被占，只能进观战位
  const c = await joinRoom(roomId);
  assert.equal(c.m.role, 'spec', '恢复的席位被离线原主占着，新人进观战位');
  a2.c.close(); b2.c.close(); c.c.close();
});

test('P7) 恢复后全员离线：必须重新连接才能继续（恢复不等于在线）', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  await tick();
  a.c.close(); b.c.close();
  await restartServer();

  const room = srv.rooms.get(roomId);
  assert.equal(room.paused, true, '恢复出的房间处于暂停（无人在线）');
  assert.equal(room.seats.red.connected, false);
  assert.equal(room.seats.black.connected, false);

  // 只有原主之一重连时仍暂停，不能走子
  const a2 = await joinRoom(roomId, a.m.token);
  assert.equal(a2.m.paused, true, '只回来一个人：本局仍暂停');
  const mv = findMove(a2.m.state, 'red');
  a2.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });
  assert.equal((await a2.c.next(x => x.t === 'error')).code, 'paused');
  a2.c.close();
});

// ---------- 8. 观战容量 / 房主权限 / 重开流程恢复 ----------
test('P8) specCap、房主裁决权、pendingRestart 均随重启恢复', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);   // 房主
  const b = await joinRoom(roomId);
  await tick();
  await playOneMove(a.c, a.m.state, 'red', 1);
  await a.c.next(x => x.t === 'state');
  await playOneMove(b.c, JSON.parse(repo.dump().find(d => d._id === roomId).state), 'black', 1);
  await a.c.next(x => x.t === 'state' && x.state.handNo === 2);

  // 房主调观战位到 5；黑方对局中转观战 → 触发询问
  a.c.clear();
  a.c.send({ t: 'specCap', value: 5 });
  await a.c.next(x => x.t === 'room' && x.specCap === 5);
  await tick();
  b.c.clear(); a.c.clear();
  b.c.send({ t: 'spectate' });
  await b.c.next(x => x.t === 'seatChanged' && x.role === 'spec');
  await a.c.next(x => x.t === 'restartRequest');

  a.c.close(); b.c.close();
  await restartServer();
  const room = srv.rooms.get(roomId);
  assert.equal(room.specCap, 5, '观战容量已恢复');
  assert.equal(room.pendingRestart && room.pendingRestart.by, 'black', '待处理询问已恢复');
  assert.equal(room.seats.black, null, '黑方转观战后的席位状态已恢复');
  assert.equal(room.specs.length, 1, '观战位成员已恢复');

  // 房主（红方）重连后仍可拒绝询问，流程照常走完
  const a2 = await joinRoom(roomId, a.m.token);
  assert.equal(a2.m.owner, true, '房主身份恢复');
  a2.c.send({ t: 'declineRestart' });
  const resolved = await a2.c.next(x => x.t === 'restartResolved');
  assert.equal(resolved.result, 'declined');
  const doc = repo.dump().find(d => d._id === roomId);
  assert.equal(doc.metadata.pendingRestart, null, '拒绝结果已落库');
  a2.c.close();
});

// ---------- 9. 过期房间不恢复且被清理 ----------
test('P9) 过期房间不会被恢复，且启动清理时删除', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  a.c.close();
  await tick();

  // 把文档改成已过期，再"重启"
  const doc = repo.dump().find(d => d._id === roomId);
  doc.expiresAt = new Date(Date.now() - 1000).toISOString();
  repo.seed(doc);
  const r = await restartServer();
  assert.equal(srv.rooms.has(roomId), false, '过期房间不进内存');
  assert.equal(repo.dump().find(d => d._id === roomId), undefined, '过期文档被删除');
  assert.ok(r.expiredDeleted >= 1);
});

// ---------- 10. 坏文档隔离 ----------
test('P10) 不兼容/损坏的文档不会被当作有效房间', async () => {
  const good = repo.dump()[0] || null;
  const bad1 = { _id: 'bad1001', schemaVersion: 99, revision: 1, state: '{}', metadata: {}, expiresAt: new Date(Date.now() + 3600e3).toISOString() };
  const bad2 = { _id: 'bad1002', schemaVersion: SCHEMA_VERSION, revision: 1, state: 'not-json{', metadata: { seats: {} }, expiresAt: new Date(Date.now() + 3600e3).toISOString() };
  repo.seed(bad1); repo.seed(bad2);
  const r = await restartServer();
  assert.equal(srv.rooms.has('bad1001'), false, 'schemaVersion 不符：隔离');
  assert.equal(srv.rooms.has('bad1002'), false, 'state 无法解析：隔离');
  assert.equal(r.badDocs, 2, '坏文档被计数并上报');
  if (good) assert.ok(srv.rooms.has(good._id), '好房间不受影响');
});

// ---------- 11. revision 冲突：旧快照不能覆盖新快照 ----------
test('P11) 并发/陈旧更新不会静默覆盖较新的快照（乐观锁）', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  await tick();

  // 直接在"数据库"里把 revision 推高（模拟另一写入者已写入更新快照）
  const doc = repo.dump().find(d => d._id === roomId);
  doc.revision += 5;
  doc.state = JSON.stringify(Object.assign(JSON.parse(doc.state), { handNo: 7, currentTurn: 'black' }));
  repo.seed(doc);

  // 内存房间的 revision 已落后：此时走子必然冲突 → 收到错误且本地从数据库收敛
  a.c.clear();
  const mv = findMove(JSON.parse(srv.rooms.get(roomId).state), 'red');
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });
  const err = await a.c.next(x => x.t === 'error');
  assert.equal(err.code, 'storage_conflict', '陈旧写入应报告冲突');
  await tick(200);
  const room = srv.rooms.get(roomId);
  assert.equal(JSON.parse(room.state).handNo, 7, '内存已收敛到数据库中的最新快照');
  assert.equal(room.revision, doc.revision, 'revision 已对齐');
  a.c.close(); b.c.close();
});

// ---------- 12. 暗子脱敏与透视权限在持久化路径下保持不变 ----------
test('P12) 恢复后的房间：暗子仍脱敏、非房主仍不能透视', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  await tick();
  await playOneMove(a.c, a.m.state, 'red', 1);
  await a.c.next(x => x.t === 'state');
  a.c.close(); b.c.close();
  await restartServer();

  // 数据库文档里存的是完整身份（服务端私有），但客户端视图必须脱敏
  const doc = repo.dump().find(d => d._id === roomId);
  const full = JSON.parse(doc.state).board;
  let darkFull = 0;
  for (const row of full) for (const p of row) if (p && !p.faceUp) darkFull++;
  assert.ok(darkFull >= 29, '文档保存了完整暗子身份（服务端权威数据）');

  const a2 = await joinRoom(roomId, a.m.token);
  let dark = 0, leaked = 0;
  for (const row of a2.m.state.board) for (const p of row) {
    if (p && !p.faceUp) { dark++; if ('color' in p || 'type' in p) leaked++; }
  }
  assert.ok(dark >= 29);
  assert.equal(leaked, 0, '下发视图绝不含暗子真实身份');

  // 非房主（黑方）透视被拒
  const room = srv.rooms.get(roomId);
  const bMember = room.seats.black;
  const bc = makeClient(); await bc.ready;
  bc.send({ t: 'join', room: roomId, token: bMember.token });
  await bc.next(x => x.t === 'joined');
  bc.send({ t: 'peek', on: true });
  assert.equal((await bc.next(x => x.t === 'error')).code, 'forbidden');
  a2.c.close(); bc.close();
});

// ---------- 附加：建房持久化失败不宣告成功 ----------
test('P13) 建房写库失败：返回 503 且房间不留在内存', async () => {
  repo.setFailure(['insert', 'get'], 2);
  const r = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST' });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'storage_unavailable');
  const before = srv.rooms.size;
  await tick(100);
  assert.equal(srv.rooms.size, before, '失败的房间不应留在内存');
  // healthz 如实反映 degraded
  const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(h.persistence.mode, 'memory');
  assert.equal(h.persistence.state, 'degraded');
});

// ---------- 附加：关房删除文档 / 并发按需恢复 / 查询接口故障 ----------

test('P14) 最后一人主动离开：房间文档被真正删除（不是 fire-and-forget）', async () => {
  repo.clearFailures();                           // P13 注入的故障可能未消费完，先清空
  await srv.initPersistence({ repo });            // 清掉 P13 留下的 degraded
  assert.equal(srv.storageInfo().state, 'ok');
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  assert.ok(repo.dump().some(d => d._id === roomId), '建房/入座后文档存在');

  a.c.send({ t: 'leave' });
  a.c.close();

  let gone = false;
  for (let i = 0; i < 40; i++) {
    await tick(50);
    if (!repo.dump().some(d => d._id === roomId)) { gone = true; break; }
  }
  assert.equal(gone, true, '关房后必须同步删除文档（否则重启会复活僵尸房间）');
  assert.equal(srv.rooms.has(roomId), false, '内存房间也应移除');
});

test('P15) 并发按需恢复同一房间：只读库一次、只建一个房间对象', async () => {
  const roomId = await newRoom();
  const a0 = await joinRoom(roomId);              // 让文档里有席位
  srv.rooms.clear();                              // 模拟重启后内存为空
  a0.c.close();

  // 记录 getRoomDoc 调用次数，并在首次读库时延迟，确保两个 join 同时在途
  const realGet = repo.getRoomDoc.bind(repo);
  let getCalls = 0;
  const slowRepo = Object.create(repo);
  slowRepo.getRoomDoc = async id => {
    if (id === roomId) {
      getCalls++;
      if (getCalls === 1) await tick(120);
    }
    return realGet(id);
  };

  await srv.initPersistence({ repo: slowRepo });  // 恢复流程会重新 list，因此先清内存
  srv.rooms.clear();

  const [c1, c2] = await Promise.all([
    (async () => { const c = makeClient(); await c.ready; c.send({ t: 'join', room: roomId }); const m = await c.next(x => x.t === 'joined' || x.t === 'error'); return { c, m }; })(),
    (async () => { const c = makeClient(); await c.ready; c.send({ t: 'join', room: roomId }); const m = await c.next(x => x.t === 'joined' || x.t === 'error'); return { c, m }; })(),
  ]);

  assert.equal(getCalls, 1, '同一房间的并发恢复只应读库一次，实际 ' + getCalls);
  assert.equal(c1.m.t, 'joined');
  assert.equal(c2.m.t, 'joined');
  const room = srv.rooms.get(roomId);
  assert.ok(room);
  assert.equal(srv.rooms.size, 1);
  assert.equal((room.seats.red ? 1 : 0) + (room.seats.black ? 1 : 0), 2, '两人都要挂在同一个房间对象上');

  c1.c.close(); c2.c.close();
  await srv.initPersistence({ repo });            // 还原仓库，供后续用例使用
});

test('P16) 查询房间接口读库失败返回 503，而不是伪装成 404', async () => {
  const roomId = await newRoom();
  srv.rooms.clear();                              // 强制走按需恢复（读库）
  repo.setFailure(['get'], 1);
  const r = await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}`);
  assert.equal(r.status, 503, '存储故障不能返回 404');
  assert.equal((await r.json()).error, 'storage_unavailable');

  const ok = await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}`);
  assert.equal(ok.status, 200, '故障恢复后应能正常查询');
});

// ---------- 走子规则：被拒绝的走法不得落库 ----------
test('P17) 被拒绝的"送将"走法不会写入持久化快照', async () => {
  repo.clearFailures();
  await srv.initPersistence({ repo });
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);

  // 构造：黑车 (5,4) 将红帅 (9,4)，红车 (8,0) 只能垫到 (8,4)
  const room = srv.rooms.get(roomId);
  const s = JSON.parse(room.state);
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) s.board[r][c] = null;
  s.board[0][4] = { color: 'black', type: 'king', faceUp: true };
  s.board[5][4] = { color: 'black', type: 'rook', faceUp: true };
  s.board[9][4] = { color: 'red', type: 'king', faceUp: true };
  s.board[8][0] = { color: 'red', type: 'rook', faceUp: true };
  s.currentTurn = 'red';
  room.state = JSON.stringify(s);
  await tick(100);

  const before = repo.dump().find(d => d._id === roomId);
  a.c.clear();
  a.c.send({ t: 'move', from: { r: 8, c: 0 }, to: { r: 5, c: 0 }, mid: 1 });
  assert.equal((await a.c.next(x => x.t === 'error')).code, 'self_check');

  await tick(250);
  const after = repo.dump().find(d => d._id === roomId);
  assert.equal(after.revision, before.revision, '被拒绝的走法不得推进 revision');
  assert.equal(after.state, before.state, '文档里的棋局必须是旧的（没被写脏）');
  assert.equal(after.metadata.seats.red.mid, 0, 'mid 不应被消费');

  // 合法解将走法仍然照常落库
  a.c.clear();
  a.c.send({ t: 'move', from: { r: 8, c: 0 }, to: { r: 8, c: 4 }, mid: 2 });
  await a.c.next(x => x.t === 'state');
  const saved = repo.dump().find(d => d._id === roomId);
  assert.ok(saved.revision > before.revision);
  assert.equal(JSON.parse(saved.state).board[8][4].type, 'rook');

  a.c.close(); b.c.close();
});
