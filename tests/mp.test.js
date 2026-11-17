'use strict';
// 联机协议测试（node --test）：房间、轮次、校验、脱敏、重复消息、重开、断线、重连
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
process.env.RESTART_TIMEOUT_MS = '400';   // 缩短超时，便于验证『超时』分支
const srv = require('../server.js');

let port;

before(async () => {
  const addr = await srv.start(0, '127.0.0.1');
  port = addr.port;
});

after(async () => {
  await srv.stop();
});

// ---------- 测试用客户端 ----------
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
    raw: s => ws.send(s),
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
  const j = await r.json();
  assert.ok(j.ok && j.roomId, '创建房间应返回 roomId');
  return j.roomId;
}

async function joinRoom(id, token, role) {
  const c = makeClient();
  await c.ready;
  c.send({ t: 'join', room: id, token, role });
  const m = await c.next(x => x.t === 'joined' || x.t === 'error');
  return { c, m };
}

/** 等服务端把房间广播出去（避免用例之间的消息竞态） */
const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));

/** 用脱敏视图 + 一份独立引擎找一步合法走法（也顺便验证视图足以支撑走子判定） */
function findMove(view, seat, preferCapture = false) {
  const E = srv.loadEngine();
  E.loadState(JSON.stringify(view));
  const cands = [];
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = E.board[r][c];
    if (!p || E.sideOf(p) !== seat) continue;
    for (const m of E.getLegalMoves(r, c)) cands.push({ from: { r, c }, to: { r: m.r, c: m.c }, cap: !!E.board[m.r][m.c] });
  }
  if (!cands.length) return null;
  if (preferCapture) {
    const cap = cands.find(x => x.cap);
    if (cap) return cap;
  }
  return cands[0];
}

// ---------- 用例 ----------
test('1) 两人占满玩家位；第三人只能观战；观战满员后拒绝', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  assert.equal(a.m.t, 'joined');
  assert.equal(a.m.role, 'player');
  assert.equal(a.m.side, 'red', '首位加入者执红');
  assert.equal(a.m.owner, true);

  const b = await joinRoom(roomId);
  assert.equal(b.m.role, 'player');
  assert.equal(b.m.side, 'black', '第二位加入者执黑');
  assert.equal(b.m.players, 2);

  const c = await joinRoom(roomId);
  assert.equal(c.m.t, 'joined', '玩家位满时应能作为观战者加入');
  assert.equal(c.m.role, 'spec');
  assert.ok(c.m.notice && c.m.notice.indexOf('观战') >= 0, '应提示已转为观战');

  const d = await joinRoom(roomId);
  const e = await joinRoom(roomId);
  assert.equal(d.m.role, 'spec');
  assert.equal(e.m.specCount, 3, '默认 3 个观战位');

  const f = await joinRoom(roomId);
  assert.equal(f.m.t, 'error');
  assert.equal(f.m.code, 'room_full');

  for (const x of [a, b, c, d, e, f]) x.c.close();
});

test('2) 轮流走棋：红先，双方各自收到同一局面', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);

  const mv = findMove(a.m.state, 'red');
  assert.ok(mv, '红方应有合法走法');
  a.c.clear(); b.c.clear();
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });

  const sa = await a.c.next(x => x.t === 'state');
  const sb = await b.c.next(x => x.t === 'state');
  assert.equal(sa.state.handNo, 1);
  assert.equal(sa.state.currentTurn, 'black');
  assert.deepEqual(sa.state.board, sb.state.board, '双方看到的棋盘必须一致');
  assert.deepEqual(sa.state.moveLog, sb.state.moveLog);

  const mv2 = findMove(sa.state, 'black');
  assert.ok(mv2, '黑方应有合法走法');
  a.c.clear(); b.c.clear();
  b.c.send({ t: 'move', from: mv2.from, to: mv2.to, mid: 1 });
  const s2 = await a.c.next(x => x.t === 'state');
  assert.equal(s2.state.handNo, 2);
  assert.equal(s2.state.currentTurn, 'red');

  a.c.close(); b.c.close();
});

test('3) 非当前回合不能走棋，且不改变服务端状态', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);

  const mv = findMove(a.m.state, 'red');
  a.c.clear(); b.c.clear();
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });
  const afterRed = await a.c.next(x => x.t === 'state');
  assert.equal(afterRed.state.currentTurn, 'black');

  // 轮到黑方时，红方再发走子
  const mvRed = findMove(afterRed.state, 'red');
  a.c.clear();
  a.c.send({ t: 'move', from: mvRed.from, to: mvRed.to, mid: 2 });
  const err = await a.c.next(x => x.t === 'error');
  assert.equal(err.code, 'not_your_turn');

  // 黑方正常走一步后 handNo 必须是 2（说明红方那步没被处理）
  const mvBlack = findMove(afterRed.state, 'black');
  b.c.clear(); a.c.clear();
  b.c.send({ t: 'move', from: mvBlack.from, to: mvBlack.to, mid: 1 });
  const s = await b.c.next(x => x.t === 'state');
  assert.equal(s.state.handNo, 2);

  a.c.close(); b.c.close();
});

test('4) 非法走法被拒绝，状态不变', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);

  // 找一个"不合法"的目标：把红方第一枚棋子的起点配到 (0,0) 附近任意空格
  const view = a.m.state;
  let from = null;
  const E = srv.loadEngine();
  E.loadState(JSON.stringify(view));
  for (let r = 0; r < 10 && !from; r++) for (let c = 0; c < 9 && !from; c++) {
    const p = E.board[r][c];
    if (p && E.sideOf(p) === 'red' && E.getLegalMoves(r, c).length) from = { r, c };
  }
  assert.ok(from);
  const legalSet = new Set(E.getLegalMoves(from.r, from.c).map(m => m.r + ',' + m.c));
  let bad = null;
  for (let r = 0; r < 10 && !bad; r++) for (let c = 0; c < 9 && !bad; c++) {
    if (!legalSet.has(r + ',' + c) && !(r === from.r && c === from.c)) bad = { r, c };
  }
  assert.ok(bad, '应能构造一个非法目标');

  a.c.clear();
  a.c.send({ t: 'move', from, to: bad, mid: 1 });
  const err = await a.c.next(x => x.t === 'error');
  assert.equal(err.code, 'illegal_move');

  // 仍然轮到红方、handNo 0
  const mv = findMove(view, 'red');
  b.c.clear(); a.c.clear();
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 2 });
  const s = await a.c.next(x => x.t === 'state');
  assert.equal(s.state.handNo, 1, '非法走法未污染局面');

  a.c.close(); b.c.close();
});

test('5) 未翻开的暗子不下发真实身份（脱敏）', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const view = a.m.state;
  let dark = 0, leaked = 0;
  for (const row of view.board) for (const p of row) {
    if (!p) continue;
    if (!p.faceUp) {
      dark++;
      if ('color' in p || 'type' in p) leaked++;
      if (!p.darkOwner) leaked++;
    } else {
      if (!p.color || !p.type) leaked++;
    }
  }
  assert.equal(dark, 30, '开局应有 30 枚暗子');
  assert.equal(leaked, 0, '脱敏视图不得包含暗子的 color/type');
  a.c.close();
});

test('6) 重复 mid 不会重复落子', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  const mv = findMove(a.m.state, 'red');

  a.c.clear(); b.c.clear();
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 7 });
  const s1 = await a.c.next(x => x.t === 'state');
  assert.equal(s1.state.handNo, 1);

  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 7 });   // 同一 mid 重发
  await new Promise(r => setTimeout(r, 250));
  const states = a.c.got.filter(x => x.t === 'state');
  assert.equal(states.length, 1, '重复消息不应产生第二次广播');
  assert.equal(states[0].state.handNo, 1);

  a.c.close(); b.c.close();
});

test('7) 重开对局由服务端统一重置，双方一致', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  const mv = findMove(a.m.state, 'red');
  a.c.clear(); b.c.clear();
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });
  await a.c.next(x => x.t === 'state');
  await b.c.next(x => x.t === 'state');       // 等双方都收到，避免与下面的 restart 广播串位

  a.c.clear(); b.c.clear();
  b.c.send({ t: 'restart' });
  const ra = await a.c.next(x => x.t === 'state');
  const rb = await b.c.next(x => x.t === 'state');
  assert.equal(ra.restart, true);
  assert.equal(ra.state.handNo, 0);
  assert.equal(ra.state.currentTurn, 'red');
  assert.equal(ra.state.gameOver, false);
  assert.deepEqual(ra.state.board, rb.state.board);
  // 重开后轮到红方，红方可以正常走
  const mv2 = findMove(ra.state, 'red');
  a.c.clear();
  a.c.send({ t: 'move', from: mv2.from, to: mv2.to, mid: 2 });
  const s = await a.c.next(x => x.t === 'state');
  assert.equal(s.state.handNo, 1);

  a.c.close(); b.c.close();
});

test('8) 对手断线：另一方收到提示，且不能再提交走子', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);

  a.c.clear();
  b.c.close();
  const peer = await a.c.next(x => x.t === 'peer' && x.event === 'leave');
  assert.equal(peer.side, 'black');
  assert.equal(peer.players, 1);
  assert.equal(peer.paused, true);

  const mv = findMove(a.m.state, 'red');
  a.c.clear();
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });
  const err = await a.c.next(x => x.t === 'error');
  assert.equal(err.code, 'paused');

  a.c.close();
});

test('9) 用 token 重连坐回原座位，暂停解除', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  const tokenB = b.m.token;

  a.c.clear();
  b.c.close();
  await a.c.next(x => x.t === 'peer' && x.event === 'leave');

  const b2 = await joinRoom(roomId, tokenB);
  assert.equal(b2.m.t, 'joined');
  assert.equal(b2.m.side, 'black', '重连应坐回黑方');
  assert.equal(b2.m.paused, false);
  assert.equal(b2.m.players, 2);

  const peer = await a.c.next(x => x.t === 'peer' && x.event === 'rejoin');
  assert.equal(peer.players, 2);

  // 重连后照常可以走棋
  const mv = findMove(a.m.state, 'red');
  a.c.clear();
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });
  const s = await b2.c.next(x => x.t === 'state');
  assert.equal(s.state.handNo, 1);

  a.c.close(); b2.c.close();
});

test('10) 基本参数校验：非法 JSON / 未知类型 / 越界坐标 / 未加入房间', async () => {
  const c = makeClient();
  await c.ready;
  c.raw('not-json');
  assert.equal((await c.next(x => x.t === 'error')).code, 'bad_json');

  c.send({ t: 'whatever' });
  assert.equal((await c.next(x => x.t === 'error' && x.code === 'bad_type')).code, 'bad_type');

  c.send({ t: 'move', from: { r: 99, c: 99 }, to: { r: 0, c: 0 }, mid: 1 });
  assert.equal((await c.next(x => x.t === 'error' && x.code === 'not_in_room')).code, 'not_in_room');

  const roomId = await newRoom();
  c.send({ t: 'join', room: 'ZZ9999' });
  assert.equal((await c.next(x => x.t === 'error' && x.code === 'no_room')).code, 'no_room');

  c.send({ t: 'join', room: 'bad id!' });
  assert.equal((await c.next(x => x.t === 'error' && x.code === 'bad_params')).code, 'bad_params');

  const d = await joinRoom(roomId);
  d.c.send({ t: 'move', from: { r: 99, c: 99 }, to: { r: 0, c: 0 }, mid: 1 });
  const e = await d.c.next(x => x.t === 'error');
  assert.equal(e.code, 'bad_params');

  c.close(); d.c.close();
});

test('11) 房间状态查询接口', async () => {
  const roomId = await newRoom();
  const r1 = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}`)).json();
  assert.deepEqual([r1.ok, r1.players, r1.full], [true, 0, false]);

  const a = await joinRoom(roomId);
  const r2 = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}`)).json();
  assert.equal(r2.players, 1);

  const b = await joinRoom(roomId);
  const r3 = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}`)).json();
  assert.equal(r3.full, true);

  const r4 = await fetch(`http://127.0.0.1:${port}/api/rooms/000000`);
  assert.equal(r4.status, 404);

  a.c.close(); b.c.close();
});

test('12) 部署相关：/healthz 与首页可达', async () => {
  const h = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(h.status, 200);
  const j = await h.json();
  assert.equal(j.ok, true);
  assert.ok(typeof j.uptime === 'number' && j.uptime >= 0);

  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /联机对战/);
});

test('13) token 过长被拒绝', async () => {
  const roomId = await newRoom();
  const c = makeClient();
  await c.ready;
  c.send({ t: 'join', room: roomId, token: 'x'.repeat(65) });
  const e = await c.next(x => x.t === 'error');
  assert.equal(e.code, 'bad_params');
  c.close();
});

test('14) 服务重启后房间丢失（内存态，不做持久化承诺）', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  assert.equal(a.m.t, 'joined');
  const token = a.m.token;

  srv.rooms.clear();                       // 等价于进程重启：内存里的房间全部消失
  const b = await joinRoom(roomId, token);
  assert.equal(b.m.t, 'error');
  assert.equal(b.m.code, 'no_room');
  a.c.close(); b.c.close();
});

test('15) 房间数上限：超出后返回 503 busy', async () => {
  srv.rooms.clear();
  for (let i = 0; i < 500; i++) srv.createRoom();
  const r = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST' });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'busy');
  srv.rooms.clear();
});

// ---------- 房主透视 ----------
test('16) 房主标记与透视权限：非房主被拒绝', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  assert.equal(a.m.owner, true, '第一位入座者应为房主');
  assert.equal(b.m.owner, false);

  b.c.clear();
  b.c.send({ t: 'peek', on: true });
  const err = await b.c.next(x => x.t === 'error');
  assert.equal(err.code, 'forbidden');

  a.c.clear();
  a.c.send({ t: 'peek', on: true });
  const p = await a.c.next(x => x.t === 'peek');
  assert.equal(p.on, true);
  assert.equal(p.pieces.length, 30, '开局应返回 30 枚暗子的身份');
  for (const x of p.pieces) {
    assert.ok(x.color === 'red' || x.color === 'black');
    assert.ok(typeof x.type === 'string' && x.type.length > 0);
  }
  a.c.close(); b.c.close();
});

test('17) 透视数据只发给房主，对手报文永远不含 peek', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  a.c.send({ t: 'peek', on: true });
  await a.c.next(x => x.t === 'peek');

  const mv = findMove(a.m.state, 'red');
  a.c.clear(); b.c.clear();
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });
  const sa = await a.c.next(x => x.t === 'state');
  const sb = await b.c.next(x => x.t === 'state');

  assert.ok(Array.isArray(sa.peek), '房主应收到 peek 快照');
  assert.equal('peek' in sb, false, '非房主绝不能收到 peek 字段');
  // peek 只包含仍未翻开的棋子
  for (const x of sa.peek) {
    const cell = sa.state.board[x.r][x.c];
    assert.ok(cell && cell.faceUp === false, 'peek 不应包含已翻开的棋子');
  }
  // 对手的 state 里，未翻开棋子仍然没有 color/type
  for (const row of sb.state.board) for (const p of row) {
    if (p && !p.faceUp) assert.ok(!('color' in p) && !('type' in p));
  }

  // 关闭透视后不再附带
  a.c.clear();
  a.c.send({ t: 'peek', on: false });
  await a.c.next(x => x.t === 'peek' && x.on === false);

  const mv2 = findMove(sa.state, 'black');
  a.c.clear(); b.c.clear();
  b.c.send({ t: 'move', from: mv2.from, to: mv2.to, mid: 1 });
  const sa2 = await a.c.next(x => x.t === 'state');
  assert.equal('peek' in sa2, false, '关闭后不应再收到 peek');

  a.c.close(); b.c.close();
});

test('18) 房主重连后仍是房主，透视状态保留', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  a.c.send({ t: 'peek', on: true });
  await a.c.next(x => x.t === 'peek');
  const tokenA = a.m.token;

  a.c.close();
  await b.c.next(x => x.t === 'peer' && x.event === 'leave');

  const a2 = await joinRoom(roomId, tokenA);
  assert.equal(a2.m.owner, true, '重连后应仍是房主');
  assert.ok(Array.isArray(a2.m.peek) && a2.m.peek.length === 30, '重连后透视状态应保留');

  const b2Guest = await joinRoom(roomId, b.m.token);
  assert.equal(b2Guest.m.owner, false);
  assert.equal('peek' in b2Guest.m, false);

  a2.c.close(); b2Guest.c.close();
});

// ==================== 观战位 / 席位切换 / 重开协商 ====================

test('19) 观战位上限：3/4/5、非法值与调低保护', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  const c = await joinRoom(roomId);
  assert.equal(c.m.role, 'spec');

  // 默认 3
  assert.equal(c.m.specCap, 3);

  // 房主调成 4 → 广播给所有人
  a.c.clear(); c.c.clear();
  a.c.send({ t: 'specCap', value: 4 });
  const r1 = await a.c.next(x => x.t === 'room' && x.specCap === 4);
  assert.equal(r1.specCap, 4);
  assert.equal(r1.specCount, 1);

  const d = await joinRoom(roomId);
  assert.equal(d.m.role, 'spec');

  // 非法值
  a.c.clear(); a.c.send({ t: 'specCap', value: 6 });
  assert.equal((await a.c.next(x => x.t === 'error')).code, 'bad_params');

  // 非房主不能设置
  b.c.clear(); b.c.send({ t: 'specCap', value: 5 });
  assert.equal((await b.c.next(x => x.t === 'error')).code, 'forbidden');

  // 与当前人数一致可以，低于当前人数拒绝（当前 2 人，调到 3 合法但无变化；再造到 4 人后降 3）
  const e = await joinRoom(roomId);
  const f = await joinRoom(roomId);
  assert.equal(f.m.specCount, 4);
  a.c.clear(); a.c.send({ t: 'specCap', value: 3 });
  assert.equal((await a.c.next(x => x.t === 'error')).code, 'cap_too_small');

  for (const x of [a, b, c, d, e, f]) x.c.close();
});

test('20) 观战位满员后再以观战身份加入失败', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  const s1 = await joinRoom(roomId);
  const s2 = await joinRoom(roomId);
  const s3 = await joinRoom(roomId);
  assert.equal(s3.m.specCount, 3);

  const extra = await joinRoom(roomId, null, 'spec');
  assert.equal(extra.m.t, 'error');
  assert.equal(extra.m.code, 'room_full');

  for (const x of [a, b, s1, s2, s3, extra]) x.c.close();
});

test('21) 玩家主动离开释放玩家位，新玩家可直接补位', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);

  a.c.clear();
  b.c.send({ t: 'leave' });
  const roomMsg = await a.c.next(x => x.t === 'room' && x.seatCount === 1);
  assert.equal(roomMsg.seatCount, 1);

  const c = await joinRoom(roomId);
  assert.equal(c.m.role, 'player');
  assert.equal(c.m.side, 'black', '应补到空出的黑方');
  assert.equal(c.m.owner, false);

  for (const x of [a, b, c]) x.c.close();
});

test('22) 观战者离开释放观战位，新人可补进观战位', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  const s1 = await joinRoom(roomId);
  const s2 = await joinRoom(roomId);
  const s3 = await joinRoom(roomId);

  a.c.clear();
  s2.c.send({ t: 'leave' });
  const msg = await a.c.next(x => x.t === 'room' && x.specCount === 2);
  assert.equal(msg.specCount, 2);

  const s4 = await joinRoom(roomId);
  assert.equal(s4.m.role, 'spec');
  assert.equal(s4.m.specCount, 3);

  for (const x of [a, b, s1, s3, s4]) x.c.close();
});

test('23) 断线保留席位；重连/重复连接不重复占位', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);

  // 异常断线：席位保留（seatCount 仍 2），在线玩家降为 1
  a.c.clear();
  b.c.close();
  const peer = await a.c.next(x => x.t === 'peer' && x.event === 'leave');
  assert.equal(peer.players, 1);
  const st1 = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}`)).json();
  assert.equal(st1.seatCount, 2, '断线不应释放玩家位');
  assert.equal(st1.players, 1);
  assert.equal(st1.paused, true);

  // 重连：坐回黑方
  const b2 = await joinRoom(roomId, b.m.token);
  assert.equal(b2.m.role, 'player');
  assert.equal(b2.m.side, 'black');
  assert.equal(b2.m.seatCount, 2);

  // 同一 token 再次连接：顶掉旧连接，仍只占 1 个席位
  const b3 = await joinRoom(roomId, b.m.token);
  await tick();
  const st2 = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}`)).json();
  assert.equal(st2.seatCount, 2);
  assert.equal(st2.players, 2);

  a.c.close(); b2.c.close(); b3.c.close();
});

test('24) 房主离开→移交；最后一人离开→房间关闭', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);   // 房主 red
  const b = await joinRoom(roomId);   // black
  const s = await joinRoom(roomId);   // spec

  a.c.clear(); s.c.clear();
  a.c.send({ t: 'leave' });
  // 玩家位优先接管：B 成为房主
  const rm = await s.c.next(x => x.t === 'room' && x.owner === false);
  assert.equal(rm.you.role, 'spec');
  assert.equal(rm.owner, false);
  // B 那边应收到 owner=true（房间广播可能早于这里的清理，直接查已收消息）
  await tick(200);
  const roomsForB = b.c.got.filter(x => x.t === 'room');
  const roomForB = roomsForB[roomsForB.length - 1];
  assert.ok(roomForB, 'B 应收到房间广播');
  assert.equal(roomForB.owner, true, '房主应移交给剩余玩家');

  // 全员离开 → 房间删除
  b.c.send({ t: 'leave' });
  s.c.send({ t: 'leave' });
  await tick(200);
  const after = await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}`);
  assert.equal(after.status, 404, '无人房间应被关闭');

  a.c.close(); b.c.close(); s.c.close();
});

test('25) 观战者 → 玩家：空位成功、满位失败', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  const s1 = await joinRoom(roomId);
  const s2 = await joinRoom(roomId);

  // 满位时申请失败
  s1.c.clear();
  s1.c.send({ t: 'seat' });
  assert.equal((await s1.c.next(x => x.t === 'error')).code, 'seats_full');

  // 黑方离开 → 观战者补位
  b.c.send({ t: 'leave' });
  await tick();
  s1.c.clear();
  s1.c.send({ t: 'seat' });
  const sc = await s1.c.next(x => x.t === 'seatChanged');
  assert.equal(sc.role, 'player');
  assert.equal(sc.side, 'black');

  const st = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}`)).json();
  assert.equal(st.seatCount, 2);
  assert.equal(st.specCount, 1, '入座后必须离开观战位');

  for (const x of [a, b, s1, s2]) x.c.close();
});

test('26) 玩家 → 观战：观战位满时失败且不释放玩家位', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  const s1 = await joinRoom(roomId);
  const s2 = await joinRoom(roomId);
  const s3 = await joinRoom(roomId);

  a.c.clear(); a.c.send({ t: 'spectate' });
  const err = await a.c.next(x => x.t === 'error');
  assert.equal(err.code, 'spec_full');

  const st1 = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}`)).json();
  assert.equal(st1.seatCount, 2, '失败后玩家位必须保留');
  assert.equal(st1.specCount, 3);

  // 腾出一个观战位后可转
  s3.c.send({ t: 'leave' });
  await tick();
  a.c.clear(); a.c.send({ t: 'spectate' });
  const sc = await a.c.next(x => x.t === 'seatChanged');
  assert.equal(sc.role, 'spec');

  const st2 = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}`)).json();
  assert.equal(st2.seatCount, 1);
  assert.equal(st2.specCount, 3);
  assert.equal(st2.paused, true);

  for (const x of [a, b, s1, s2]) x.c.close();
});

test('27) 对局中玩家转观战 → 房主收到询问并可批准重开', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);   // 房主/red
  const b = await joinRoom(roomId);   // black
  const mv = findMove(a.m.state, 'red');
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });
  await a.c.next(x => x.t === 'state');
  await b.c.next(x => x.t === 'state');

  a.c.clear();
  b.c.send({ t: 'spectate' });
  const req = await a.c.next(x => x.t === 'restartRequest');
  assert.equal(req.by, 'black');
  assert.equal(req.timeoutMs, 400);

  a.c.clear(); b.c.clear();
  a.c.send({ t: 'restart', reqId: 'approve-1' });
  const sa = await a.c.next(x => x.t === 'state' && x.restart);
  const sb = await b.c.next(x => x.t === 'state' && x.restart);
  assert.equal(sa.state.handNo, 0, '重开后手数应为 0');
  assert.equal(sa.state.currentTurn, 'red');
  assert.equal(sb.state.handNo, 0);

  a.c.close(); b.c.close();
});

test('28) 房主拒绝重开：旧局保留、房主未响应不重置', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  const mv = findMove(a.m.state, 'red');
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });
  const s1 = await a.c.next(x => x.t === 'state');
  await b.c.next(x => x.t === 'state');
  assert.equal(s1.state.handNo, 1);

  b.c.send({ t: 'spectate' });
  await a.c.next(x => x.t === 'restartRequest');

  a.c.clear(); b.c.clear();
  a.c.send({ t: 'declineRestart' });
  const res = await b.c.next(x => x.t === 'restartResolved');
  assert.equal(res.result, 'declined');

  // 补位后继续旧局：手数应为 1 → 2，而不是从 0 开始
  const c = await joinRoom(roomId);
  assert.equal(c.m.role, 'player');
  c.c.clear(); a.c.clear();
  const mv2 = findMove(s1.state, s1.state.currentTurn);
  const mover = s1.state.currentTurn === 'red' ? a.c : c.c;
  mover.send({ t: 'move', from: mv2.from, to: mv2.to, mid: 1 });
  const s2 = await a.c.next(x => x.t === 'state');
  assert.equal(s2.state.handNo, 2, '拒绝重开不得重置棋局');

  a.c.close(); b.c.close(); c.c.close();
});

test('29) 房主超时未响应：自动保留旧局（不重置）', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  const mv = findMove(a.m.state, 'red');
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });
  await a.c.next(x => x.t === 'state');
  await b.c.next(x => x.t === 'state');

  b.c.send({ t: 'spectate' });
  await a.c.next(x => x.t === 'restartRequest');

  a.c.clear();
  const res = await a.c.next(x => x.t === 'restartResolved', 2000);
  assert.equal(res.result, 'expired', '超时应自动过期，而不是永久卡住');
  const st = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}`)).json();
  assert.equal(st.pendingRestart, false);

  a.c.close(); b.c.close();
});

test('30) 两名观战者同时抢同一玩家位：只有一人成功', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  const s1 = await joinRoom(roomId);
  const s2 = await joinRoom(roomId);

  b.c.send({ t: 'leave' });
  await tick(150);

  s1.c.clear(); s2.c.clear();
  s1.c.send({ t: 'seat' });
  s2.c.send({ t: 'seat' });
  await tick(300);

  const got = [];
  for (const c of [s1.c, s2.c]) {
    const ch = c.got.find(x => x.t === 'seatChanged');
    const er = c.got.find(x => x.t === 'error' && x.code === 'seats_full');
    got.push(ch ? 'seat' : (er ? 'err' : 'none'));
  }
  got.sort();
  assert.deepEqual(got, ['err', 'seat'], '必须恰好一成一败');

  const st = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}`)).json();
  assert.equal(st.seatCount, 2);

  for (const x of [a, b, s1, s2]) x.c.close();
});

test('31) 重开重复提交只生效一次', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  const mv = findMove(a.m.state, 'red');
  a.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });
  await a.c.next(x => x.t === 'state');
  await b.c.next(x => x.t === 'state');

  a.c.clear(); b.c.clear();
  a.c.send({ t: 'restart', reqId: 'same-1' });
  a.c.send({ t: 'restart', reqId: 'same-1' });
  await tick(300);
  const restarts = a.c.got.filter(x => x.t === 'state' && x.restart);
  assert.equal(restarts.length, 1, '同 reqId 只能重置一次');
  assert.equal(restarts[0].state.handNo, 0);

  a.c.close(); b.c.close();
});

test('32) 观战者收到脱敏棋盘、不能走棋、不能透视', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  const s = await joinRoom(roomId);

  // 观战者不能走棋（即使强行发 move）
  s.c.clear();
  const mv = findMove(s.m.state, 'red');
  s.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });
  assert.equal((await s.c.next(x => x.t === 'error')).code, 'spectator');

  // 观战者不能透视
  s.c.clear();
  s.c.send({ t: 'peek', on: true });
  assert.equal((await s.c.next(x => x.t === 'error')).code, 'forbidden');

  // 观战者收到的 state 里暗子没有真实身份
  const sView = s.m.state;
  let dark = 0, leaked = 0;
  for (const row of sView.board) for (const p of row) {
    if (p && !p.faceUp) { dark++; if ('color' in p || 'type' in p) leaked++; }
  }
  assert.equal(dark, 30);
  assert.equal(leaked, 0);

  // 观战者不能设置观战位
  s.c.clear();
  s.c.send({ t: 'specCap', value: 5 });
  assert.equal((await s.c.next(x => x.t === 'error')).code, 'forbidden');

  a.c.close(); b.c.close(); s.c.close();
});

test('33) 所有客户端看到的房间人数/容量/席位一致', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  const s = await joinRoom(roomId);

  a.c.clear(); b.c.clear(); s.c.clear();
  a.c.send({ t: 'specCap', value: 5 });
  const [ra, rb, rs] = await Promise.all([
    a.c.next(x => x.t === 'room' && x.specCap === 5),
    b.c.next(x => x.t === 'room' && x.specCap === 5),
    s.c.next(x => x.t === 'room' && x.specCap === 5),
  ]);
  for (const r of [ra, rb, rs]) {
    assert.equal(r.seatCount, 2);
    assert.equal(r.specCount, 1);
    assert.equal(r.specCap, 5);
    assert.equal(r.paused, false);
    assert.deepEqual(r.seats, { red: { connected: true }, black: { connected: true } });
  }
  assert.equal(ra.owner, true);
  assert.equal(rb.owner, false);
  assert.equal(rs.owner, false);

  a.c.close(); b.c.close(); s.c.close();
});

test('34) 断线重连后 mid 从 1 重新计数，走子不被静默丢弃', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  await tick();

  // 双方各走一步，红方服务端 mid 达到 1
  let view = a.m.state, seq = a.m.seq;
  const mvA = findMove(view, 'red');
  a.c.send({ t: 'move', from: mvA.from, to: mvA.to, mid: 1 });
  let st = await a.c.next(x => x.t === 'state' && x.seq > seq); seq = st.seq; view = st.state;
  const mvB = findMove(view, 'black');
  b.c.send({ t: 'move', from: mvB.from, to: mvB.to, mid: 1 });
  st = await a.c.next(x => x.t === 'state' && x.seq > seq); seq = st.seq; view = st.state;
  assert.equal(view.handNo, 2);

  // 红方断线（非主动离开），凭 token 重连 —— 真实前端收到 joined 会把本地 mid 重置为 0
  a.c.close();
  await tick(300);
  const a2 = await joinRoom(roomId, a.m.token);
  assert.equal(a2.m.t, 'joined');
  view = a2.m.state; seq = a2.m.seq;
  await tick();

  // 重连后红方按前端行为用 mid=1 发合法走子：必须生效（修复前会被当重复消息静默丢弃）
  const mv = findMove(view, 'red');
  assert.ok(mv, '此时应轮到红方且有合法走法');
  a2.c.send({ t: 'move', from: mv.from, to: mv.to, mid: 1 });
  const st2 = await a2.c.next(x => x.t === 'state' && x.seq > seq, 2000);
  assert.equal(st2.state.handNo, 3, '重连后第一条走子应被接受并广播');

  a2.c.close(); b.c.close();
});

test('35) 观战者不能重开对局；房主在观战位仍可裁决重开', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);   // 房主，执红
  const b = await joinRoom(roomId);   // 执黑
  await tick();

  // 走成进行中的对局
  let view = a.m.state, seq = a.m.seq;
  const mvA = findMove(view, 'red');
  a.c.send({ t: 'move', from: mvA.from, to: mvA.to, mid: 1 });
  let st = await a.c.next(x => x.t === 'state' && x.seq > seq); seq = st.seq; view = st.state;
  const mvB = findMove(view, 'black');
  b.c.send({ t: 'move', from: mvB.from, to: mvB.to, mid: 1 });
  st = await a.c.next(x => x.t === 'state' && x.seq > seq); seq = st.seq; view = st.state;

  // 普通观战者 restart：应被拒绝，且双方不应收到重置广播
  const c = await joinRoom(roomId, null, 'spec');
  a.c.clear(); b.c.clear(); c.c.clear();
  c.c.send({ t: 'restart', reqId: 'spec-r1' });
  assert.equal((await c.c.next(x => x.t === 'error')).code, 'spectator');
  await tick(200);
  assert.ok(!a.c.got.some(x => x.t === 'state' && x.restart), '观战者 restart 不得重置对局');
  assert.ok(!b.c.got.some(x => x.t === 'state' && x.restart), '观战者 restart 不得重置对局');

  // 房主转观战（对局进行中）→ 触发 pendingRestart → 房主在观战位仍可批准重开
  a.c.clear();
  a.c.send({ t: 'spectate' });
  const seatMsg = await a.c.next(x => x.t === 'seatChanged' && x.role === 'spec');
  assert.equal(seatMsg.owner, true, '转观战后仍是房主');
  const ask = await a.c.next(x => x.t === 'restartRequest');
  assert.equal(ask.by, 'red');
  a.c.send({ t: 'restart', reqId: 'owner-r1' });
  const rs = await a.c.next(x => x.t === 'state' && x.restart === true, 2000);
  assert.equal(rs.state.handNo, 0, '房主（观战位）应能裁决重开');

  a.c.close(); b.c.close(); c.c.close();
});

// ==================== 走子规则（服务端权威）：飞将 / 禁止送将 ====================
/** 把房间的权威状态换成构造局面（只用于测试：正常走子无法一步造出被将死/对望局面） */
function injectPosition(roomId, pieces, turn) {
  const s = JSON.parse(srv.rooms.get(roomId).state);
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) s.board[r][c] = null;
  pieces.forEach(([r, c, p]) => { s.board[r][c] = p; });
  s.currentTurn = turn;
  s.gameOver = false; s.winner = null; s.winReason = null;
  s.capturedRed = []; s.capturedBlack = []; s.moveLog = []; s.handNo = 0;
  s.lastMove = null; s.moveTrail = []; s.historyLength = 0;
  const str = JSON.stringify(s);
  srv.rooms.get(roomId).state = str;
  return str;
}

test('34) 服务端拒绝"送将"：返回 self_check，不广播、不改状态、不换手', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);        // 红
  const b = await joinRoom(roomId);        // 黑
  assert.equal(a.m.side, 'red');

  // 黑车 (5,4) 将红帅 (9,4)；红车 (8,0) 只有垫到 (8,4) 才能解将
  const injected = injectPosition(roomId, [
    [0, 4, { color: 'black', type: 'king', faceUp: true }],
    [5, 4, { color: 'black', type: 'rook', faceUp: true }],
    [9, 4, { color: 'red', type: 'king', faceUp: true }],
    [8, 0, { color: 'red', type: 'rook', faceUp: true }],
  ], 'red');
  await tick(100);

  a.c.clear(); b.c.clear();
  a.c.send({ t: 'move', from: { r: 8, c: 0 }, to: { r: 5, c: 0 }, mid: 1 });
  const err = await a.c.next(x => x.t === 'error');
  assert.equal(err.code, 'self_check', '应明确区分"送将"而不是笼统的 illegal_move');
  assert.match(err.msg, /将帅/);

  await tick(250);
  assert.equal(a.c.got.some(x => x.t === 'state'), false, '非法走法不得向任何人广播 state');
  assert.equal(b.c.got.some(x => x.t === 'state'), false);
  const after = srv.rooms.get(roomId).state;
  assert.equal(after, injected, '被拒绝的走法不得改动房间权威状态');
  assert.equal(JSON.parse(after).currentTurn, 'red', '回合不得切换');
  assert.equal(JSON.parse(after).handNo, 0, '手数不得增加');
  a.c.close(); b.c.close();
});

test('35) 被将军时合法的解将走法可以走，双方收到同一状态', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  injectPosition(roomId, [
    [0, 4, { color: 'black', type: 'king', faceUp: true }],
    [5, 4, { color: 'black', type: 'rook', faceUp: true }],
    [9, 4, { color: 'red', type: 'king', faceUp: true }],
    [8, 0, { color: 'red', type: 'rook', faceUp: true }],
  ], 'red');
  await tick(100);

  a.c.clear(); b.c.clear();
  a.c.send({ t: 'move', from: { r: 8, c: 0 }, to: { r: 8, c: 4 }, mid: 1 });
  const sa = await a.c.next(x => x.t === 'state');
  const sb = await b.c.next(x => x.t === 'state');
  assert.equal(sa.state.currentTurn, 'black');
  assert.equal(sa.state.board[8][4].type, 'rook', '垫子应落在 (8,4)');
  assert.equal(sb.state.board[8][4].type, 'rook', '对手看到的棋盘一致');
  a.c.close(); b.c.close();
});

test('36) 飞将：将帅同列无子时，服务端允许直接吃将并判定胜负', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  injectPosition(roomId, [
    [0, 4, { color: 'black', type: 'king', faceUp: true }],
    [9, 4, { color: 'red', type: 'king', faceUp: true }],
  ], 'red');
  await tick(100);

  a.c.clear(); b.c.clear();
  a.c.send({ t: 'move', from: { r: 9, c: 4 }, to: { r: 0, c: 4 }, mid: 1 });
  const sa = await a.c.next(x => x.t === 'state');
  const sb = await b.c.next(x => x.t === 'state');
  assert.equal(sa.state.gameOver, true);
  assert.equal(sa.state.winner, 'red');
  assert.equal(sa.state.winReason, 'king');
  assert.equal(sb.state.gameOver, true);
  a.c.close(); b.c.close();
});

test('37) 飞将被挡：中间有子时服务端拒绝隔空吃将', async () => {
  const roomId = await newRoom();
  const a = await joinRoom(roomId);
  const b = await joinRoom(roomId);
  injectPosition(roomId, [
    [0, 4, { color: 'black', type: 'king', faceUp: true }],
    [5, 4, { color: 'red', type: 'rook', faceUp: true }],
    [9, 4, { color: 'red', type: 'king', faceUp: true }],
  ], 'red');
  await tick(100);

  a.c.clear(); b.c.clear();
  a.c.send({ t: 'move', from: { r: 9, c: 4 }, to: { r: 0, c: 4 }, mid: 1 });
  const err = await a.c.next(x => x.t === 'error');
  assert.equal(err.code, 'illegal_move');
  await tick(200);
  assert.equal(a.c.got.some(x => x.t === 'state'), false);
  a.c.close(); b.c.close();
});

test('S2) 先 spectate 再 seat 连发：不产生 ws=null 的幽灵席位', async () => {
  // 缺陷背景：handleTakeSeat / handleSpectate 在取房间锁**之前**用 currentMember(ws)
  // 取到成员对象 m，再把 m 传进锁内的 *Locked。spectateLocked 会执行
  // `m.ws.member = spec; m.connected = false; m.ws = null;`，使旧 m 变成死对象。
  // 同一连接的两条席位消息在同一事件循环里先后入队同一把锁时，第二条拿死 m 继续，
  // 走到 `m.ws.member = ...` 抛 TypeError → 房间留下 connected=true 但 ws=null 的幽灵成员
  // （人数虚高、误判对局可继续，持久化与广播都没执行）。
  // 修法：三个 *Locked 函数进锁后重取 currentMember(ws)，不一致则拒绝（与 moveLocked 对齐）。

  // 同一 TCP 包连发：cork/uncork 让两条消息落进同一个数据段，服务端必然在同一个事件
  // 循环里连续 dispatch 两次（两次读到的都是同一份旧 m），时序才稳定可复现。
  const burst = (cl, msgs) => {
    const sock = cl.ws._socket;
    if (sock && typeof sock.cork === 'function') {
      sock.cork();
      for (const m of msgs) cl.send(m);
      sock.uncork();
    } else {
      for (const m of msgs) cl.send(m);   // 兜底：至少保证发送顺序
    }
  };
  const allMembers = room => [room.seats.red, room.seats.black, ...room.specs].filter(Boolean);
  const ghostsOf = room => allMembers(room).filter(m => m.connected === true && m.ws == null);

  // ---------- 场景一：玩家同包连发两条 spectate（真正撞上 m.ws=null 的时序） ----------
  const roomId1 = await newRoom();
  const a = await joinRoom(roomId1);      // red
  const b = await joinRoom(roomId1);      // black
  const s = await joinRoom(roomId1);      // 观战者
  assert.equal(b.m.role, 'player');
  assert.equal(s.m.role, 'spec');
  const room1 = srv.rooms.get(roomId1);
  assert.ok(room1, '房间应在内存 Map 中');

  a.c.clear(); b.c.clear(); s.c.clear();
  burst(b.c, [{ t: 'spectate' }, { t: 'spectate' }]);
  await tick(300);

  assert.deepEqual(ghostsOf(room1), [],
    '出现 connected=true 但 ws=null 的幽灵席位：人数被虚高、持久化与广播都没执行');
  assert.equal(allMembers(room1).length, 3, '成员总数必须守恒：3 人进、3 人出');
  assert.ok(room1.specs.length <= room1.specCap,
    '观战人数不得超过上限，实际 ' + room1.specs.length + '/' + room1.specCap);
  assert.ok(b.c.got.some(x => x.t === 'error'),
    '第二条 spectate 必须收到 error（席位已变化），不能两个请求都静默成功');

  const ra = a.c.got.filter(x => x.t === 'room').pop();
  const rs = s.c.got.filter(x => x.t === 'room').pop();
  assert.ok(ra && rs, '席位变化后应向所有在线成员广播 room');
  assert.equal(ra.players, rs.players, '不同客户端看到的玩家数不一致');
  assert.equal(ra.specCount, rs.specCount, '不同客户端看到的观战数不一致');

  // ---------- 场景二：玩家同包连发 spectate → seat（团队要求的时序） ----------
  const roomId2 = await newRoom();
  const a2 = await joinRoom(roomId2);     // red
  const b2 = await joinRoom(roomId2);     // black
  const s2 = await joinRoom(roomId2);     // 观战者
  assert.equal(a2.m.side, 'red');
  const room2 = srv.rooms.get(roomId2);
  assert.ok(room2, '房间应在内存 Map 中');

  a2.c.clear(); b2.c.clear(); s2.c.clear();
  burst(a2.c, [{ t: 'spectate' }, { t: 'seat' }]);
  await tick(300);

  assert.deepEqual(ghostsOf(room2), [],
    '出现 connected=true 但 ws=null 的幽灵席位（spectate 后再 seat 的时序）');
  assert.equal(allMembers(room2).length, 3, '成员总数必须守恒：3 人进、3 人出');
  assert.ok(a2.c.got.some(x => x.t === 'error'),
    '连发的两个请求不能都静默成功，至少一个要回 error（席位已变化 / 已在玩家位 / 玩家位已满）');

  // 仍在玩家位的 b2 与观战者 s2 看到的人数/观战数必须一致
  const rb2 = b2.c.got.filter(x => x.t === 'room').pop();
  const rs2 = s2.c.got.filter(x => x.t === 'room').pop();
  assert.ok(rb2 && rs2, '席位变化后应向所有在线成员广播 room');
  assert.equal(rb2.players, rs2.players, '不同客户端看到的玩家数不一致');
  assert.equal(rb2.specCount, rs2.specCount, '不同客户端看到的观战数不一致');

  // ---------- 连接未被写坏：两个房间的客户端都还能收发 ----------
  for (const c of [a.c, b.c, s.c, a2.c, b2.c, s2.c]) {
    c.clear();
    c.send({ t: 'ping' });
  }
  for (const c of [a.c, b.c, s.c, a2.c, b2.c, s2.c]) {
    const pong = await c.next(x => x.t === 'pong');
    assert.ok(pong, '连发席位消息后连接必须仍可用（ping 应回 pong）');
  }

  for (const x of [a, b, s, a2, b2, s2]) x.c.close();
});
