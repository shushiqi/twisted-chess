'use strict';
/**
 * 揭棋 · 本地联机服务端（最小可用版）
 *  - 静态页：GET /  → jieqi.html
 *  - 房间接口：POST /api/rooms 创建，GET /api/rooms/:id 查询
 *  - 实时通道：WebSocket /ws（房间内最多 2 人）
 *
 * 设计要点：
 *  1) 规则完全复用 jieqi.html 里的引擎源码（按标记截取 + new Function），不重写规则；
 *  2) 服务端持有每个房间的**完整** saveState()，客户端只能收到脱敏视图（未翻开的暗子不含 color/type）；
 *  3) 每条走子消息都由服务端重新校验（轮次 / 归属 / 合法性）后才 makeMove 并广播。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { SCHEMA_VERSION, createRoomRepositoryFromEnv } = require('./roomRepository');

const ROOT = __dirname;
const PAGE_FILE = path.join(ROOT, 'jieqi.html');
const ROWS = 10, COLS = 9;

const MAX_MSG_BYTES = 8 * 1024;          // 单条消息上限（走子消息 < 200B，这里只防滥用）
const ROOM_TTL_MS = 30 * 60 * 1000;      // 无人房间在内存中的保留时长（文档另有 ROOM_DOC_TTL_MS）
const HEARTBEAT_MS = 30 * 1000;
const ROOM_ID_RE = /^[A-Za-z0-9]{1,10}$/;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;   // 公网部署时的内存保护（房间是纯内存态）
const MAX_TOKEN_LEN = 64;                                // 重连 token 长度上限
const DEFAULT_ROOM_DOC_TTL_MS = 24 * 60 * 60 * 1000;      // 房间文档默认 24 小时过期

// ---------- 持久化状态（roomRepository 提供 CloudBase / 内存两种实现） ----------
// storageState: 'disabled' 未启用（本地/测试）| 'ok' 正常 | 'degraded' 最近一次写失败 | 'error' 初始化失败
let roomRepo = null;
let storageState = 'disabled';
let roomDocTtlMs = Number(process.env.ROOM_DOC_TTL_MS) > 0 ? Number(process.env.ROOM_DOC_TTL_MS) : DEFAULT_ROOM_DOC_TTL_MS;

// ---------- 引擎加载（复用页面内的规则引擎，不复制第二份实现） ----------
const ENGINE_BEGIN = '/*<<ENGINE_SRC_START>>*/';
const ENGINE_END = '/*<<ENGINE_SRC_END>>*/';

function loadEngine(file = PAGE_FILE) {
  const html = fs.readFileSync(file, 'utf8');
  const a = html.indexOf(ENGINE_BEGIN);
  const b = html.indexOf(ENGINE_END);
  if (a < 0 || b < 0 || b < a) throw new Error('jieqi.html 中未找到引擎源码标记');
  const src = html.slice(a, b);
  const mod = { exports: {} };
  // 引擎源码末尾用 module.exports 导出，并在导出后 return
  new Function('module', 'exports', 'require', src)(mod, mod.exports, require);
  return mod.exports;
}

// 注意：全服所有房间共享这一个引擎实例，引擎内的 history 数组会随各房间 loadState
// 互相截断/重写。服务端绝不调用 undo()，因此无正确性影响；
// 若将来要在服务端实现悔棋，必须改为每个房间独立引擎实例。
const engine = loadEngine();

// ---------- 房间 ----------
// 权威结构：seats(固定 2 个玩家位) + specs(观战位数组，上限 specCap=3/4/5) + ownerToken
// 所有人数/容量都由这三个字段派生，客户端上报的一切人数/席位信息一律不采信。
const rooms = new Map();
const SPEC_CAP_MIN = 3, SPEC_CAP_MAX = 5, SPEC_CAP_DEFAULT = 3;
const RESTART_TIMEOUT_MS = Number(process.env.RESTART_TIMEOUT_MS) || 60000;

function newRoomId() {
  let id;
  do { id = String(crypto.randomInt(100000, 1000000)); } while (rooms.has(id));
  return id;
}

function freshState() {
  engine.setup();
  return engine.saveState();
}

function createRoom() {
  const room = {
    id: newRoomId(),
    state: freshState(),
    seq: 0,
    seats: { red: null, black: null },   // 玩家位（固定 2 个）
    specs: [],                           // 观战位（上限 specCap）
    specCap: SPEC_CAP_DEFAULT,
    specNextId: 1,
    ownerToken: null,                    // 房主令牌：入座/观战后第一位成员即房主
    paused: true,
    pendingRestart: null,                // 玩家转观战后等待房主决定
    reqSeen: [],                         // 重开请求幂等去重（reqId）
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 0,                         // 持久化乐观锁版本（每次成功写入 +1）
    _lock: Promise.resolve(),            // 每房间串行锁：状态变更在锁内完成（含异步持久化）
    _lastGood: null,                     // 最近一次成功写入的文档（故障回滚参照）
    frozen: false,                       // 存储故障冻结标记：冻结期间拒绝一切状态变更
  };
  rooms.set(room.id, room);
  return room;
}

// ======================================================================
// 持久化：文档序列化 / 条件写入 / 故障恢复 / 启动恢复
// ----------------------------------------------------------------------
// 文档结构（game_rooms 集合，_id = 房间号）：
//   { schemaVersion, revision, state(=saveState() 字符串), metadata{
//       seq, specCap, specNextId, ownerToken,
//       seats{red/black: {token,mid,peek}|null}, specs[{id,token}],
//       pendingRestart{by,at}|null },
//     createdAt, updatedAt, expiresAt }
// 绝不序列化：WebSocket 引用、connected 标记、pendingRestart.timer、reqSeen。
// 并发控制（双防线）：
//   1) 单实例内每房间串行锁（withRoomLock）：同一房间的状态变更完全串行；
//   2) revision 条件更新（updateRoomDoc）：旧快照无法覆盖新快照，跨重启/异常时
//      冲突方从数据库读回最新文档并重建内存（resyncRoomFromStorage）。
// ======================================================================

function seatMeta(m) { return { token: m.token, mid: m.mid || 0, peek: !!m.peek }; }
function specMeta(m) { return { id: m.id, token: m.token }; }

function roomMetadata(room) {
  return {
    seq: room.seq,
    specCap: room.specCap,
    specNextId: room.specNextId,
    ownerToken: room.ownerToken,
    seats: {
      red: room.seats.red ? seatMeta(room.seats.red) : null,
      black: room.seats.black ? seatMeta(room.seats.black) : null,
    },
    specs: room.specs.map(specMeta),
    pendingRestart: room.pendingRestart ? { by: room.pendingRestart.by, at: room.pendingRestart.at } : null,
  };
}

function roomToDoc(room, stateStr, revision) {
  const now = new Date();
  return {
    _id: room.id,
    schemaVersion: SCHEMA_VERSION,
    revision,
    state: stateStr,
    metadata: roomMetadata(room),
    createdAt: new Date(room.createdAt),
    updatedAt: now,
    expiresAt: new Date(now.getTime() + roomDocTtlMs),
  };
}

function isValidRoomDoc(doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (doc.schemaVersion !== SCHEMA_VERSION) return false;
  if (typeof doc.state !== 'string' || !doc.state) return false;
  if (!Number.isInteger(doc.revision) || doc.revision < 1) return false;
  const meta = doc.metadata;
  if (!meta || typeof meta !== 'object' || !meta.seats) return false;
  if (!Number.isFinite(new Date(doc.expiresAt).getTime())) return false;
  try {
    const s = JSON.parse(doc.state);
    if (!s || !Array.isArray(s.board) || !s.currentTurn) return false;
  } catch (e) { return false; }
  return true;
}

// 每房间串行锁：同一房间内所有会改变状态的处理（含异步持久化）完全串行。
// 注意：锁不可重入——已持锁的代码路径里绝不能再 await withRoomLock。
function withRoomLock(room, fn) {
  const run = room._lock.then(fn, fn);
  room._lock = run.then(() => {}, () => {});
  return run;
}

// 驱逐一个不在最新文档里的成员（持久化回滚 / 存储同步时使用）
function evictMember(m, reason) {
  const ws = m.ws;
  m.connected = false; m.ws = null;
  if (ws) {
    ws.room = null; ws.member = null; ws.seat = null;
    if (reason === 'storage_resync') {
      send(ws, { t: 'error', code: 'storage_error', msg: '存储同步：房间已回滚到最后保存的状态，请重新加入' });
      try { ws.close(1013, 'storage resync'); } catch (e) {}
    }
  }
}

// 用文档重建房间的可序列化状态。preserveConnected=true 时，token 命中的现有成员
// 对象被原地复用（保留其 ws/connected），文档里已不存在的成员被驱逐——这是
// 「写库失败后从最后保存的快照恢复」的实现。
function applyDocToRoom(room, doc, opts) {
  const byToken = new Map();
  if (opts && opts.preserveConnected) {
    for (const m of members(room)) if (m.token && !byToken.has(m.token)) byToken.set(m.token, m);
  }
  if (room.pendingRestart && room.pendingRestart.timer) clearTimeout(room.pendingRestart.timer);
  room.pendingRestart = null;

  const meta = doc.metadata;
  const claim = token => {
    const cur = byToken.get(token);
    if (cur) { byToken.delete(token); return cur; }
    return null;   // 占位成员由调用处构造（默认离线）
  };
  const placeSeat = side => {
    const s = meta.seats[side];
    if (!s || !s.token) return null;
    const m = claim(s.token) || { role: 'player', side, token: s.token, ws: null, mid: 0, connected: false, peek: false };
    m.role = 'player'; m.side = side; m.mid = s.mid || 0; m.peek = !!s.peek;
    if (!m.ws) m.connected = false;
    return m;
  };
  room.seats.red = placeSeat('red');
  room.seats.black = placeSeat('black');
  room.specs = (meta.specs || []).map(s => {
    const m = claim(s.token) || { role: 'spec', id: s.id, token: s.token, ws: null, mid: 0, connected: false, peek: false };
    m.role = 'spec'; m.id = s.id; m.peek = false;
    if (!m.ws) m.connected = false;
    return m;
  });
  for (const m of members(room)) if (m.ws) { m.ws.member = m; m.ws.seat = m.role === 'player' ? m.side : null; }
  for (const m of byToken.values()) evictMember(m, 'storage_resync');

  room.seq = meta.seq || 0;
  room.specCap = meta.specCap || room.specCap;
  room.specNextId = Math.max(room.specNextId || 1, meta.specNextId || 1);
  room.ownerToken = meta.ownerToken || null;
  room.state = doc.state;
  room.revision = doc.revision;
  room._lastGood = doc;
  room.frozen = false;

  const pr = meta.pendingRestart;
  if (pr) armPendingRestart(room, pr.by, pr.at);   // 已超时的询问会在 arm 内部走过期收敛
  recomputePaused(room);
}

function buildRoomFromDoc(doc) {
  const room = {
    id: doc._id,
    state: doc.state,
    seq: doc.metadata.seq || 0,
    seats: { red: null, black: null },
    specs: [],
    specCap: doc.metadata.specCap || SPEC_CAP_DEFAULT,
    specNextId: doc.metadata.specNextId || 1,
    ownerToken: doc.metadata.ownerToken || null,
    paused: true,
    pendingRestart: null,
    reqSeen: [],
    createdAt: Number.isFinite(new Date(doc.createdAt).getTime()) ? new Date(doc.createdAt).getTime() : Date.now(),
    updatedAt: Date.now(),
    revision: doc.revision,
    _lock: Promise.resolve(),
    _lastGood: doc,
    frozen: false,
  };
  applyDocToRoom(room, doc, { preserveConnected: false });   // 恢复出的成员全部离线，等待重连
  return room;
}

// 写入当前房间状态（乐观锁）。成功后推进内存 revision/state；失败返回 conflict 或抛错。
// 调用方必须持有房间锁。nextState：走子等场景先算好的新快照（此时 room.state 尚未替换）。
async function persistRoom(room, nextState) {
  const stateStr = nextState != null ? nextState : room.state;
  const doc = roomToDoc(room, stateStr, room.revision + 1);
  const r = await roomRepo.updateRoomDoc(room.id, room.revision, doc);
  if (!r || !r.ok) return (r && { ok: false, reason: r.reason }) || { ok: false, reason: 'conflict' };
  room.revision += 1;
  room.state = stateStr;
  room.updatedAt = Date.now();
  room._lastGood = doc;
  return { ok: true };
}

function freezeRoom(room, err) {
  if (room.frozen) return;
  room.frozen = true;
  console.error('[storage] 房间 %s 已冻结（存储故障）：%s', room.id, (err && err.message) || err);
  for (const m of members(room)) {
    if (m.connected && m.ws) send(m.ws, { t: 'error', code: 'storage_frozen', msg: '存储暂时不可用，房间已冻结；存储恢复后可继续对局' });
  }
  broadcastRoom(room);
}

// 从数据库读最新文档并重建内存（写库失败 / revision 冲突时使用）。
// 调用方必须持有房间锁（sweeper 的解冻重试会自行加锁）。返回是否恢复成功。
async function resyncRoomFromStorage(room) {
  if (!roomRepo) return false;
  const doc = await roomRepo.getRoomDoc(room.id);
  if (!doc) { freezeRoom(room, new Error('房间文档在数据库中缺失')); return false; }
  if (!isValidRoomDoc(doc)) { freezeRoom(room, new Error('房间文档损坏')); return false; }
  applyDocToRoom(room, doc, { preserveConnected: true });
  room.frozen = false;
  storageState = 'ok';
  recomputePaused(room);
  broadcastRoom(room);
  return true;
}

// 统一的「变更 → 持久化 → 确认」出口（调用方已持锁、已完成内存变更）：
//   成功：执行 onOk（广播/回包），返回 true
//   revision 冲突：从数据库恢复内存，回 false
//   数据库异常：尝试恢复内存；恢复不了则冻结房间。绝不广播未保存的状态。
async function persistOrFail(room, ws, nextState, onOk) {
  if (!roomRepo) {
    // 未启用持久化（本地/测试）：直接应用新快照再确认
    if (nextState != null) { room.state = nextState; room.updatedAt = Date.now(); }
    if (onOk) try { onOk(); } catch (e) {}
    return true;
  }
  if (room.frozen) {
    if (ws) sendErr(ws, 'storage_error', '房间已冻结（存储故障），请稍后重试');
    return false;
  }
  try {
    const r = await persistRoom(room, nextState);
    if (r.ok) {
      storageState = 'ok';
      if (onOk) try { onOk(); } catch (e) {}
      return true;
    }
    const synced = await resyncRoomFromStorage(room).catch(() => false);
    if (ws) sendErr(ws, 'storage_conflict', synced ? '存储状态冲突，房间已恢复到最新快照，请重试' : '存储状态冲突，房间已冻结，请稍后重新加入');
    return false;
  } catch (e) {
    storageState = 'degraded';
    console.error('[storage] 房间 %s 写入失败：%s', room.id, (e && e.message) || e);
    let synced = false;
    try { synced = await resyncRoomFromStorage(room); }
    catch (e2) { console.error('[storage] 房间 %s 回读失败：%s', room.id, (e2 && e2.message) || e2); }
    if (!synced) freezeRoom(room, e);
    if (ws) sendErr(ws, 'storage_error', synced ? '存储暂时不可用，已回滚到最后保存的状态，请重试' : '存储暂时不可用，房间已冻结，请稍后重新加入');
    return false;
  }
}

// 按需从数据库恢复一个不在内存中的房间（加入房间 / REST 查询时用）。
// 并发保护：同一房间同时被多个请求触发时，只做一次读库与一次 build，
// 所有调用方拿到同一个房间对象；否则后建的对象会覆盖 Map，先建对象上的
// ws 会挂在孤儿房间上（表现为"加入了但走子无效"）。
const restoreInFlight = new Map();
async function restoreRoomFromStorage(id) {
  if (!roomRepo) return null;
  const cached = rooms.get(id);
  if (cached) return cached;
  const running = restoreInFlight.get(id);
  if (running) return running;

  const task = (async () => {
    const doc = await roomRepo.getRoomDoc(id);
    if (!doc) return null;
    if (new Date(doc.expiresAt).getTime() <= Date.now()) {
      try { await roomRepo.deleteRoomDoc(id); } catch (e) { console.error('[storage] 过期房间 %s 删除失败：%s', id, (e && e.message) || e); }
      return null;
    }
    if (!isValidRoomDoc(doc)) {
      console.warn('[storage] 房间 %s 文档损坏（schemaVersion=%s），已隔离', id, doc.schemaVersion);
      return null;
    }
    const raced = rooms.get(id);          // 读库期间可能已被启动恢复等路径放入
    if (raced) return raced;
    const room = buildRoomFromDoc(doc);
    rooms.set(room.id, room);
    return room;
  })();

  restoreInFlight.set(id, task);
  try {
    return await task;
  } finally {
    restoreInFlight.delete(id);
  }
}

// 初始化持久化并执行启动恢复。测试可通过 opts.repo 注入内存仓库。
// 返回值供 /healthz 与日志使用；数据库不可用时 storageState='error'（服务继续监听，
// 但拒绝新建/加入房间，避免以纯内存模式静默运行）。
async function initPersistence(opts) {
  const o = opts || {};
  if (Number(o.ttlMs) > 0) roomDocTtlMs = Math.max(60 * 1000, o.ttlMs | 0);
  if ('repo' in o) {
    roomRepo = o.repo || null;
  } else {
    const built = createRoomRepositoryFromEnv();
    roomRepo = built.enabled ? built.repo : null;
    if (!built.enabled && process.env.CLOUDBASE_ENV_ID) {
      storageState = 'error';
      console.error('[storage] 持久化配置不完整：%s', built.reason);
      return { enabled: false, state: 'error', error: built.reason };
    }
  }
  if (!roomRepo) {
    storageState = 'disabled';
    return { enabled: false, state: 'disabled' };
  }
  try {
    const now = new Date();
    const expiredDeleted = await roomRepo.deleteExpiredRooms(now);
    const docs = await roomRepo.listActiveRoomDocs(now);
    let restored = 0, badDocs = 0;
    for (const doc of docs) {
      if (!isValidRoomDoc(doc)) { badDocs++; console.warn('[storage] 跳过损坏房间文档 %s（schemaVersion=%s）', doc && doc._id, doc && doc.schemaVersion); continue; }
      rooms.set(doc._id, buildRoomFromDoc(doc));
      restored++;
    }
    storageState = 'ok';
    return { enabled: true, state: 'ok', restored, badDocs, expiredDeleted };
  } catch (e) {
    storageState = 'error';
    console.error('[storage] 启动恢复失败，暂不接受新建/加入房间：%s', (e && e.message) || e);
    return { enabled: true, state: 'error', error: String((e && e.message) || e) };
  }
}

function storageInfo() {
  return { mode: roomRepo ? roomRepo.kind : 'memory', state: storageState, ttlMs: roomDocTtlMs };
}

// 是否禁止新建房间。注意不能用 `roomRepo && ...` 判断——配置了 CLOUDBASE_ENV_ID
// 却缺少凭据时 roomRepo 为 null、storageState='error'，若按 roomRepo 判断会静默
// 降级成纯内存房间，让用户误以为房间可持久化。storageState==='error' 只会在
// 「要求持久化但初始化/配置失败」时出现，因此它就是"必须拒绝"的标志。
function storageBlocked() {
  if (storageState === 'error') return true;                 // 配置了持久化但初始化失败（含缺凭据）
  if (roomRepo && storageState !== 'ok') return true;        // 已启用但最近写入失败（degraded）
  return false;
}

function playerCount(room) {          // 在线玩家数（沿用旧语义，供 peer/room 消息使用）
  return (room.seats.red && room.seats.red.connected ? 1 : 0) +
         (room.seats.black && room.seats.black.connected ? 1 : 0);
}
function seatCount(room) { return (room.seats.red ? 1 : 0) + (room.seats.black ? 1 : 0); }
function freeSeats(room) { return ['red', 'black'].filter(s => !room.seats[s]); }
function members(room) {
  const out = [];
  for (const s of ['red', 'black']) if (room.seats[s]) out.push(room.seats[s]);
  for (const m of room.specs) out.push(m);
  return out;
}
// 空闲房间回收条件：全员离线且静默超过 TTL。只数玩家位（playerCount）会漏掉在线观战者——
// 两名玩家都掉线、观战者还在看时把房间从 rooms 删掉，观战者的 ws.room 会指向孤儿对象
// （收不到广播、界面冻结、点入座走进幽灵房间），只能整页重连自愈。
function shouldReapRoom(room, now) {
  return members(room).every(m => !m.connected) && now - room.updatedAt > ROOM_TTL_MS;
}
function findMember(room, token) {
  if (!token) return null;
  return members(room).find(m => m.token === token) || null;
}

/** 不足两名在线玩家就不能走棋：对手掉线时本局暂停 */
function recomputePaused(room) {
  room.paused = playerCount(room) < 2;
  return room.paused;
}

function isGameInProgress(room) {
  try {
    const s = JSON.parse(room.state);
    return !s.gameOver && s.handNo > 0;
  } catch (e) { return false; }
}

// ---------- 客户端可见状态（脱敏） ----------
// 进行中：未翻开的暗子只给 darkOwner / startType / startForward（都是公开信息），
//         绝不下发真实 color / type；终局才随"揭晓全部棋子"下发身份。
function toView(room) {
  const s = JSON.parse(room.state);
  const reveal = !!s.gameOver;
  const board = s.board.map(row => row.map(p => {
    if (!p) return null;
    const owner = p.darkOwner || (p.faceUp ? p.color : null);
    if (p.faceUp || reveal) {
      return {
        faceUp: !!p.faceUp, color: p.color, type: p.type, darkOwner: owner,
        startType: p.startType, startForward: p.startForward,
      };
    }
    return { faceUp: false, darkOwner: owner, startType: p.startType, startForward: p.startForward };
  }));
  return {
    board,
    currentTurn: s.currentTurn,
    gameOver: s.gameOver,
    winner: s.winner,
    winReason: s.winReason,
    capturedRed: s.capturedRed,
    capturedBlack: s.capturedBlack,
    moveLog: s.moveLog,
    handNo: s.handNo,
    lastMove: s.lastMove,
    moveTrail: s.moveTrail,
    historyLength: 0,
  };
}

// ---------- 消息工具 ----------
function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* 连接已断，忽略 */ }
}
function sendErr(ws, code, msg) { send(ws, { t: 'error', code, msg }); }

// 房主透视：只返回"当前仍未翻开"的棋子真实身份；只发给房主本人，且房主必须在玩家位
function peekList(room) {
  const s = JSON.parse(room.state);
  if (s.gameOver) return [];                 // 终局本来就全部揭晓，无需透视
  const out = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const p = s.board[r][c];
    if (p && !p.faceUp) out.push({ r, c, color: p.color, type: p.type });
  }
  return out;
}
function canPeek(room, member) {
  return !!member && member.role === 'player' && !!member.peek && room.ownerToken === member.token;
}

// 房间快照（按接收者定制 owner / you 字段）
function roomInfo(room, member) {
  return {
    t: 'room',
    room: room.id,
    players: playerCount(room),
    seatCount: seatCount(room),
    seats: {
      red: room.seats.red ? { connected: !!room.seats.red.connected } : null,
      black: room.seats.black ? { connected: !!room.seats.black.connected } : null,
    },
    specs: room.specs.map(s => ({ id: s.id, connected: !!s.connected })),
    specCount: room.specs.length,
    specCap: room.specCap,
    paused: !!room.paused,
    owner: !!member && room.ownerToken === member.token,
    you: member ? { role: member.role, side: member.side || null, id: member.id || null } : null,
    pendingRestart: room.pendingRestart ? { by: room.pendingRestart.by, at: room.pendingRestart.at } : null,
  };
}

function broadcastRoom(room) {
  for (const m of members(room)) {
    if (!m.connected || !m.ws) continue;
    send(m.ws, roomInfo(room, m));
  }
}

function broadcastState(room, extra) {
  const view = toView(room);
  for (const m of members(room)) {
    if (!m.connected || !m.ws) continue;
    const msg = Object.assign({
      t: 'state', seq: room.seq, players: playerCount(room), paused: !!room.paused,
      seatCount: seatCount(room), specCount: room.specs.length, specCap: room.specCap,
      state: view,
    }, extra || {});
    if (canPeek(room, m)) msg.peek = peekList(room);
    send(m.ws, msg);
  }
}

function broadcastPeer(room, fromSide, event) {
  for (const s of ['red', 'black']) {
    const p = room.seats[s];
    if (!p || !p.connected || !p.ws || s === fromSide) continue;
    send(p.ws, { t: 'peer', event, side: fromSide, players: playerCount(room), paused: !!room.paused });
  }
}

// ---------- 待处理：玩家转观战后的重开询问 ----------
// 通知房主（在线才发）：有玩家退到观战位，等待裁决
function notifyOwnerRestartRequest(room, by) {
  const owner = members(room).find(m => m.token === room.ownerToken);
  if (owner && owner.connected && owner.ws) {
    send(owner.ws, { t: 'restartRequest', by, timeoutMs: RESTART_TIMEOUT_MS });
  }
}

// 武装一个重开询问。at 支持传历史时间（恢复场景）；已超时的询问推迟到下一个宏任务
// 走过期收敛——不能在这里同步加锁，因为调用方可能已持有该房间的锁。
function armPendingRestart(room, by, at) {
  const pr = { by, at, timer: null };
  room.pendingRestart = pr;
  const left = RESTART_TIMEOUT_MS - (Date.now() - at);
  if (left > 0) {
    pr.timer = setTimeout(() => {
      withRoomLock(room, () => expirePendingRestartLocked(room, pr))
        .catch(e => console.error('[restart] 询问过期处理失败：', e));
    }, left);
    if (pr.timer.unref) pr.timer.unref();
  } else {
    setImmediate(() => {
      withRoomLock(room, () => expirePendingRestartLocked(room, pr))
        .catch(e => console.error('[restart] 询问过期处理失败：', e));
    });
  }
}

// 询问超期：保留旧局并通知全员。定时器路径由 armPendingRestart 加锁后调用。
async function expirePendingRestartLocked(room, pr) {
  if (!pr || room.pendingRestart !== pr) return;
  clearPendingRestart(room, null, false);
  await persistOrFail(room, null, null, () => {
    for (const m of members(room)) {
      if (m.connected && m.ws) send(m.ws, { t: 'restartResolved', result: 'expired' });
    }
    broadcastRoom(room);
  });
}

function clearPendingRestart(room, result, broadcast) {
  if (!room.pendingRestart) return false;
  if (room.pendingRestart.timer) clearTimeout(room.pendingRestart.timer);
  room.pendingRestart = null;
  if (broadcast) {
    for (const m of members(room)) {
      if (m.connected && m.ws) send(m.ws, { t: 'restartResolved', result });
    }
    broadcastRoom(room);
  }
  return true;
}

// ---------- 席位操作（服务端原子处理） ----------
function makePlayer(side, ws, token, prev) {
  return {
    role: 'player', side, token: token || crypto.randomBytes(8).toString('hex'),
    // mid 必须归零：换位成功后前端收到 seatChanged 会把本地 mid 重置为 0，
    // 服务端若继承旧值，会把重置后的前 N 条走子当成重复消息静默丢弃
    ws, mid: 0, connected: true, peek: !!(prev && prev.peek),
  };
}
function makeSpec(room, ws, token, prev) {
  return {
    role: 'spec', id: room.specNextId++, token: token || crypto.randomBytes(8).toString('hex'),
    ws, mid: 0, connected: true, peek: false,
  };
}

// 关闭房间（调用方持有房间锁）。文档删除必须 await：若 fire-and-forget，
// 进程在删除前退出会让"已关闭"的房间在下次启动恢复时被重新创建（僵尸房间）。
async function closeRoom(room) {
  if (room.pendingRestart && room.pendingRestart.timer) clearTimeout(room.pendingRestart.timer);
  room.pendingRestart = null;
  for (const m of members(room)) {
    const w = m.ws;
    m.connected = false; m.ws = null;
    if (w) { try { w.room = null; w.member = null; w.seat = null; } catch (e) {} }
  }
  if (roomRepo) {
    try {
      await roomRepo.deleteRoomDoc(room.id);
    } catch (e) {
      // 删不掉也要从内存移除；残留文档会在 expiresAt 后被过期清理收敛
      console.error('[storage] 关房删除文档失败 %s：%s', room.id, (e && e.message) || e);
    }
  }
  rooms.delete(room.id);
}

// ---------- 参数校验 ----------
function isCoord(o) {
  return !!o && Number.isInteger(o.r) && Number.isInteger(o.c) &&
    o.r >= 0 && o.r < ROWS && o.c >= 0 && o.c < COLS;
}

// ---------- 协议处理 ----------
function currentMember(ws) {
  const room = ws.room, m = ws.member;
  if (!room || !m) return null;
  if (m.role === 'player' && room.seats[m.side] === m) return m;
  if (m.role === 'spec' && room.specs.includes(m)) return m;
  return null;
}

async function handleJoin(ws, msg) {
  const id = String(msg.room || '').trim();
  if (!ROOM_ID_RE.test(id)) return sendErr(ws, 'bad_params', '房间号格式不正确');
  if (msg.token != null && (typeof msg.token !== 'string' || msg.token.length > MAX_TOKEN_LEN))
    return sendErr(ws, 'bad_params', 'token 非法');
  if (msg.role != null && msg.role !== 'player' && msg.role !== 'spec')
    return sendErr(ws, 'bad_params', 'role 非法');
  // 持久化配置/初始化失败：房间不可能存在，直接告知"存储不可用"，
  // 而不是伪装成"房间不存在"（那会让用户以为房间被删了）
  if (storageState === 'error') return sendErr(ws, 'storage_error', '存储暂不可用，无法查找房间');

  let room = rooms.get(id);
  if (!room && roomRepo) {
    // 内存里没有（服务重启后被回收）：尝试从数据库按需恢复
    try { room = await restoreRoomFromStorage(id); }
    catch (e) {
      storageState = 'degraded';
      console.error('[storage] 按需恢复房间 %s 失败：%s', id, (e && e.message) || e);
      return sendErr(ws, 'storage_error', '存储暂时不可用，无法查找房间');
    }
  }
  if (!room) return sendErr(ws, 'no_room', '房间不存在');

  if (ws.room && ws.room !== room) await detach(ws, { explicit: true });   // 显式离开自带房间锁

  await withRoomLock(room, () => joinLocked(ws, msg, room));
}

// 加入房间（持有房间锁）。席位成员发生变化时：先持久化、成功后才回 joined；
// 失败则由 resync 驱逐新成员并断开其连接（evictMember 负责通知），不确认加入。
async function joinLocked(ws, msg, roomRef) {
  const room = rooms.get(roomRef.id) || roomRef;   // 并发按需恢复可能替换 Map 内对象，以后者为准
  if (storageState === 'error') return sendErr(ws, 'storage_error', '存储暂不可用，无法加入房间');

  let member = findMember(room, typeof msg.token === 'string' ? msg.token : null);

  // 冻结的房间只允许既有成员重连（重连不产生数据库写入），不接受新成员
  if (room.frozen && !member) return sendErr(ws, 'storage_error', '房间已冻结（存储故障），暂不能加入');

  let notice = null;
  let firstTime = false;
  let dirty = false;

  if (member) {
    // 凭 token 重连：坐回原席位，不新增人数。
    // 关闭前先解绑旧连接：close 事件会触发 detach，若不解绑会在 rejoin 广播之后
    // 又补发一条 leave，把对手端的 peerLeft 误置为 true
    if (member.ws && member.ws !== ws) {
      const old = member.ws;
      old.room = null; old.member = null; old.seat = null;
      try { old.close(4001, 'replaced'); } catch (e) {}
    }
    member.ws = ws; member.connected = true;
    member.mid = 0;   // 前端收到 joined 会把 mid 归零，服务端同步归零，否则重连后走子被当重复丢弃
  } else {
    const free = freeSeats(room);
    const wantSpec = msg.role === 'spec';
    if (!wantSpec && free.length) {
      member = makePlayer(free[0], ws, null, null);
      room.seats[free[0]] = member;
    } else if (room.specs.length < room.specCap) {
      member = makeSpec(room, ws, null, null);
      room.specs.push(member);
      if (!wantSpec && !free.length) notice = '玩家位已满（2/2），已作为观战者加入';
    } else {
      const why = free.length ? '观战位已满' : '玩家位与观战位均已满';
      return sendErr(ws, 'room_full', why + '，无法加入');
    }
    firstTime = true;
    dirty = true;
  }

  if (!room.ownerToken) { room.ownerToken = member.token; dirty = true; }   // 第一位成员成为房主
  ws.room = room; ws.member = member; ws.seat = member.role === 'player' ? member.side : null;
  room.updatedAt = Date.now();
  recomputePaused(room);

  const finish = () => {
    const joined = {
      t: 'joined', room: room.id, role: member.role, side: member.side || null, specId: member.id || null,
      token: member.token, owner: room.ownerToken === member.token, seq: room.seq,
      players: playerCount(room), seatCount: seatCount(room), seats: roomInfo(room, member).seats,
      specs: roomInfo(room, member).specs, specCount: room.specs.length, specCap: room.specCap,
      paused: !!room.paused, state: toView(room),
      pendingRestart: room.pendingRestart ? { by: room.pendingRestart.by, at: room.pendingRestart.at } : null,
    };
    if (msg.role === 'spec' && freeSeats(room).length) joined.notice = '已按观战身份加入（还有空余玩家位）';
    if (notice) joined.notice = notice;
    if (canPeek(room, member)) joined.peek = peekList(room);
    send(ws, joined);

    if (member.role === 'player' && !firstTime) broadcastPeer(room, member.side, 'rejoin');
    else if (member.role === 'player') broadcastPeer(room, member.side, 'join');
    broadcastRoom(room);
  };

  if (dirty && roomRepo) return await persistOrFail(room, null, null, finish);
  finish();
}

async function handleMove(ws, msg) {
  const room = ws.room, m = currentMember(ws);
  if (!room || !m) return sendErr(ws, 'not_in_room', '请先加入房间');
  if (m.role !== 'player') return sendErr(ws, 'spectator', '观战者不能走棋');
  await withRoomLock(room, () => moveLocked(ws, msg, room));
}

// 走子（持有房间锁）：权威校验 → 引擎试走出新快照 → 持久化成功后才切换内存并广播。
// makeMove 会原地修改共享引擎；room.state 只在持久化成功后才替换，写库失败时内存
// 自然停留在旧快照（引擎全局态会被下一条消息的 loadState 覆盖，无需显式回滚）。
// mid 在成功前不消费；失败回滚由 resync 从最后保存的快照恢复。
async function moveLocked(ws, msg, roomRef) {
  const room = rooms.get(roomRef.id) || roomRef;
  const m = currentMember(ws);
  if (!room || !m) return sendErr(ws, 'not_in_room', '请先加入房间');
  const seatObj = room.seats[m.side];
  if (!seatObj || seatObj.ws !== ws) return sendErr(ws, 'not_in_room', '座位已失效');

  // 幂等：同一 mid 的重发直接忽略（不报错，避免重复动画/状态抖动）
  if (msg.mid !== undefined) {
    if (!Number.isInteger(msg.mid)) return sendErr(ws, 'bad_params', 'mid 非法');
    if (msg.mid <= seatObj.mid) return;
  }

  const from = msg.from, to = msg.to;
  if (!isCoord(from) || !isCoord(to)) return sendErr(ws, 'bad_params', '坐标非法');
  if (recomputePaused(room)) return sendErr(ws, 'paused', '对手不在，本局暂停');
  if (room.frozen) return sendErr(ws, 'storage_error', '房间已冻结（存储故障），请稍后重试');

  engine.loadState(room.state);                     // 还原该房间的权威局面
  if (engine.gameOver) return sendErr(ws, 'game_over', '对局已结束');
  if (engine.turn !== m.side) return sendErr(ws, 'not_your_turn', '还没轮到你走棋');

  const piece = engine.board[from.r][from.c];
  if (!piece || !engine.canControl(engine.turn, piece)) return sendErr(ws, 'not_your_piece', '这枚棋子不属于你');

  const legal = engine.getLegalMoves(from.r, from.c);
  if (!legal.some(x => x.r === to.r && x.c === to.c)) {
    // 区分"走法本身不成立"与"走法成立但走后己方将帅仍被将军"（含飞将对望），
    // 让前端能给出准确原因；两种情况都不改动任何状态。
    if (engine.isSelfCheckMove(from.r, from.c, to.r, to.c))
      return sendErr(ws, 'self_check', '此步不合法：走子后己方将帅仍处于被将军状态，不能这样走');
    return sendErr(ws, 'illegal_move', '该走法不合法');
  }

  engine.makeMove(from.r, from.c, to.r, to.c);
  const nextState = engine.saveState();
  room.seq++;
  room.updatedAt = Date.now();
  if (msg.mid !== undefined) seatObj.mid = msg.mid;

  await persistOrFail(room, ws, nextState, () => broadcastState(room));
}

async function handlePeek(ws, msg) {
  const room = ws.room, m = currentMember(ws);
  if (!room || !m) return sendErr(ws, 'not_in_room', '请先加入房间');
  if (m.role !== 'player') return sendErr(ws, 'forbidden', '观战者不能使用透视');
  if (room.ownerToken !== m.token) return sendErr(ws, 'forbidden', '只有房主可以使用透视');
  const on = !!msg.on;
  await withRoomLock(room, async () => {
    // 等锁期间席位可能已被别的消息改掉（同一连接连发 spectate/seat 时必然如此），
    // 入参 m 可能已是死对象：持锁后重取一次引用，不一致就拒绝（与 moveLocked 对齐）
    const cur = currentMember(ws);
    if (cur !== m) return sendErr(ws, 'not_in_room', '席位已变化，请重新操作');
    cur.peek = on;
    await persistOrFail(room, ws, null, () => send(ws, { t: 'peek', on, pieces: on ? peekList(room) : [] }));
  });
}

// 观战者 → 玩家位（只允许有唯一空位，服务端原子占位；持有房间锁）
async function handleTakeSeat(ws) {
  const room = ws.room, m = currentMember(ws);
  if (!room || !m) return sendErr(ws, 'not_in_room', '请先加入房间');
  if (m.role === 'player') return sendErr(ws, 'already_player', '你已经在玩家位');
  if (room.frozen) return sendErr(ws, 'storage_error', '房间已冻结（存储故障），请稍后重试');
  await withRoomLock(room, () => takeSeatLocked(ws, m, room));
}

async function takeSeatLocked(ws, m, roomRef) {
  const room = rooms.get(roomRef.id) || roomRef;
  // 等锁期间席位可能已被上一条消息改掉：spectateLocked 会把旧成员置为
  // `connected=false, ws=null`，此时继续用入参 m 会在 `m.ws.member = p` 抛 TypeError，
  // 房间留下 connected=true 但 ws=null 的幽灵玩家（人数虚高、持久化与广播都没执行）。
  // 因此与 moveLocked 一致：持锁后重取成员引用，变化了就拒绝本次操作。
  const cur = currentMember(ws);
  if (cur !== m) return sendErr(ws, 'not_in_room', '席位已变化，请重新操作');
  const free = freeSeats(room);
  if (!free.length) return sendErr(ws, 'seats_full', '玩家位已满（2/2），暂时无法入座');

  const side = free[0];
  room.specs = room.specs.filter(x => x !== cur);    // 先离开观战位（同一 token，不会占两个席位）
  const p = makePlayer(side, cur.ws, cur.token, cur);
  p.peek = false;
  room.seats[side] = p;
  cur.ws.member = p; cur.ws.seat = side;
  cur.connected = false; cur.ws = null;

  const hadAsk = !!room.pendingRestart;
  if (hadAsk) clearPendingRestart(room, null, false);   // 有人补位：询问自动结束
  room.updatedAt = Date.now();
  recomputePaused(room);

  await persistOrFail(room, ws, null, () => {
    if (hadAsk) {
      for (const x of members(room)) if (x.connected && x.ws) send(x.ws, { t: 'restartResolved', result: 'seat-taken' });
    }
    send(p.ws, {
      t: 'seatChanged', role: 'player', side, token: p.token, owner: room.ownerToken === p.token,
      seq: room.seq, state: toView(room), players: playerCount(room),
      seats: roomInfo(room, p).seats, specs: roomInfo(room, p).specs,
      specCount: room.specs.length, specCap: room.specCap, paused: !!room.paused,
    });
    broadcastPeer(room, side, 'join');
    broadcastRoom(room);
  });
}

// 玩家 → 观战位（先校验观战容量，再释放玩家位，绝不先放后卡；持有房间锁）
async function handleSpectate(ws) {
  const room = ws.room, m = currentMember(ws);
  if (!room || !m) return sendErr(ws, 'not_in_room', '请先加入房间');
  if (m.role === 'spec') return sendErr(ws, 'already_spec', '你已经在观战位');
  if (room.frozen) return sendErr(ws, 'storage_error', '房间已冻结（存储故障），请稍后重试');
  await withRoomLock(room, () => spectateLocked(ws, m, room));
}

async function spectateLocked(ws, m, roomRef) {
  const room = rooms.get(roomRef.id) || roomRef;
  // 同 takeSeatLocked：持锁后重取成员引用，避免用上一条消息留下的死对象
  // （连续两次 spectate 会在 `m.ws.member = spec` 抛 TypeError，并留下 ws=null 的幽灵观战者）
  const cur = currentMember(ws);
  if (cur !== m) return sendErr(ws, 'not_in_room', '席位已变化，请重新操作');
  if (room.specs.length >= room.specCap) {
    return sendErr(ws, 'spec_full', '观战位已满（' + room.specs.length + '/' + room.specCap + '），无法转为观战');
  }

  const side = cur.side;
  const wasPlaying = isGameInProgress(room);
  room.seats[side] = null;
  const spec = makeSpec(room, cur.ws, cur.token, cur);
  room.specs.push(spec);
  cur.ws.member = spec; cur.ws.seat = null;
  cur.connected = false; cur.ws = null;

  recomputePaused(room);
  room.updatedAt = Date.now();

  // 对局进行中退出玩家位：进入"等待房主决定"状态（不偷偷重开、不删除棋谱）。
  // 询问先在内存武装（进入本次持久化的 metadata），成功后才通知房主。
  if (wasPlaying) {
    if (room.pendingRestart) clearPendingRestart(room, 'replaced', false);
    armPendingRestart(room, side, Date.now());
  }

  await persistOrFail(room, ws, null, () => {
    send(spec.ws, {
      t: 'seatChanged', role: 'spec', side: null, id: spec.id, token: spec.token,
      owner: room.ownerToken === spec.token, seq: room.seq,
      players: playerCount(room), seats: roomInfo(room, spec).seats,
      specs: roomInfo(room, spec).specs, specCount: room.specs.length,
      specCap: room.specCap, paused: !!room.paused,
    });
    broadcastPeer(room, side, 'leave');
    if (wasPlaying) notifyOwnerRestartRequest(room, side);
    broadcastRoom(room);
  });
}

// 房主设置观战位上限（3/4/5；只允许调高到当前人数以上，不踢人）
async function handleSpecCap(ws, msg) {
  const room = ws.room, m = currentMember(ws);
  if (!room || !m) return sendErr(ws, 'not_in_room', '请先加入房间');
  if (room.ownerToken !== m.token) return sendErr(ws, 'forbidden', '只有房主可以设置观战位');
  const v = Number(msg.value);
  if (!Number.isInteger(v) || v < SPEC_CAP_MIN || v > SPEC_CAP_MAX)
    return sendErr(ws, 'bad_params', '观战位只能是 3、4 或 5');
  if (v < room.specs.length)
    return sendErr(ws, 'cap_too_small', '当前有 ' + room.specs.length + ' 名观战者，不能把上限降到 ' + v);
  await withRoomLock(room, async () => {
    room.specCap = v;
    room.updatedAt = Date.now();
    await persistOrFail(room, ws, null, () => broadcastRoom(room));
  });
}

// 重开：玩家位随时可以（房主例外规则见下）；其他玩家只在没有待处理询问时可以
async function handleRestart(ws, msg) {
  const room = ws.room, m = currentMember(ws);
  if (!room || !m) return sendErr(ws, 'not_in_room', '请先加入房间');

  // 观战者不能重开对局；房主例外——pendingRestart 裁决时房主可能正处在观战位
  if (m.role !== 'player' && room.ownerToken !== m.token)
    return sendErr(ws, 'spectator', '观战者不能重开对局');
  if (room.frozen) return sendErr(ws, 'storage_error', '房间已冻结（存储故障），请稍后重试');

  await withRoomLock(room, () => restartLocked(ws, msg, m, room));
}

async function restartLocked(ws, msg, m, roomRef) {
  const room = rooms.get(roomRef.id) || roomRef;

  // 幂等：同一 reqId 只处理一次，避免重复点击造成多次重置/广播
  if (msg.reqId != null) {
    if (typeof msg.reqId !== 'string' || msg.reqId.length > 64) return sendErr(ws, 'bad_params', 'reqId 非法');
    if (room.reqSeen.includes(msg.reqId)) return;
    room.reqSeen.push(msg.reqId);
    if (room.reqSeen.length > 50) room.reqSeen.shift();
  }

  const isOwner = room.ownerToken === m.token;
  if (room.pendingRestart && !isOwner)
    return sendErr(ws, 'owner_only', '有玩家退出对局，等待房主决定是否新开一局');

  await restartGame(room);
}

async function handleDeclineRestart(ws) {
  const room = ws.room, m = currentMember(ws);
  if (!room || !m) return sendErr(ws, 'not_in_room', '请先加入房间');
  if (room.ownerToken !== m.token) return sendErr(ws, 'forbidden', '只有房主可以决定');
  if (!room.pendingRestart) return sendErr(ws, 'no_pending', '没有待处理的重开请求');
  await withRoomLock(room, async () => {
    clearPendingRestart(room, null, false);
    await persistOrFail(room, ws, null, () => {
      for (const x of members(room)) if (x.connected && x.ws) send(x.ws, { t: 'restartResolved', result: 'declined' });
      broadcastRoom(room);
    });
  });
}

// 重开对局（调用方持有房间锁）：重置成功持久化后才广播 restart
async function restartGame(room) {
  clearPendingRestart(room, 'approved', false);
  engine.setup();
  const nextState = engine.saveState();
  room.seq++;
  room.updatedAt = Date.now();
  for (const s of ['red', 'black']) if (room.seats[s]) room.seats[s].mid = 0;
  for (const sp of room.specs) sp.mid = 0;
  recomputePaused(room);
  await persistOrFail(room, null, nextState, () => {
    broadcastState(room, { restart: true });
    broadcastRoom(room);
  });
}

function detach(ws, opts) {
  const room = ws.room, m = ws.member;
  const explicit = !!(opts && opts.explicit);
  ws.room = null; ws.member = null; ws.seat = null;
  if (!room || !m) return;

  if (!explicit) {
    // 临时断线：保留席位与 token，等待重连（不计入新增人数）。
    // connected 是纯运行时状态，不写数据库
    if (m.ws === ws) { m.connected = false; m.ws = null; }
    room.updatedAt = Date.now();
    recomputePaused(room);
    if (m.role === 'player') broadcastPeer(room, m.side, 'leave');
    broadcastRoom(room);
    return;
  }

  // 主动离开：席位释放/房主移交要持久化，放到房间锁里串行处理
  withRoomLock(room, () => detachExplicitLocked(room, m))
    .catch(e => console.error('[ws] 主动离开处理失败：', e));
}

// 主动离开（持有房间锁）：释放席位、移交房主；持久化成功后才广播。
// 失败时 resync 会按最后保存的快照重建（离线成员仍在席位上，等待重连）。
async function detachExplicitLocked(room, m) {
  const wasPlayer = m.role === 'player';
  const side = m.side;
  if (wasPlayer) { if (room.seats[side] === m) room.seats[side] = null; }
  else room.specs = room.specs.filter(x => x !== m);
  m.connected = false; m.ws = null;
  room.updatedAt = Date.now();
  recomputePaused(room);

  if (room.ownerToken === m.token) {
    const rest = members(room);
    const next = rest.find(x => x.connected && x.role === 'player') ||
                 rest.find(x => x.connected) || rest[0] || null;
    room.ownerToken = next ? next.token : null;
  }

  if (members(room).length === 0) { await closeRoom(room); return; }

  await persistOrFail(room, null, null, () => {
    if (wasPlayer) broadcastPeer(room, side, 'leave');
    broadcastRoom(room);
  });
}

// ---------- HTTP ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function servePage(res) {
  fs.readFile(PAGE_FILE, (err, buf) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('页面读取失败'); return; }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/jieqi.html')) return servePage(res);
  // 健康检查：/healthz 给平台（Render）用，/api/health 保留给本地脚本。
  // persistence 如实反映存储状态，不因瞬时故障导致无休止重启（Render 只看 HTTP 状态码）
  if (req.method === 'GET' && (p === '/healthz' || p === '/api/health')) {
    return sendJSON(res, 200, {
      ok: true, uptime: Math.round(process.uptime()), rooms: rooms.size, ws: wss.clients.size,
      persistence: storageInfo(),
    });
  }

  if (req.method === 'POST' && p === '/api/rooms') {
    if (rooms.size >= MAX_ROOMS) return sendJSON(res, 503, { ok: false, error: 'busy' });
    if (storageBlocked()) return sendJSON(res, 503, { ok: false, error: 'storage_unavailable' });
    const room = createRoom();
    if (roomRepo) {
      // 先持久化初始快照，成功才对外宣告建房成功
      try {
        const doc = roomToDoc(room, room.state, 1);
        await roomRepo.insertRoomDoc(doc);
        room.revision = 1;
        room._lastGood = doc;
      } catch (e) {
        rooms.delete(room.id);
        console.error('[storage] 创建房间持久化失败：%s', (e && e.message) || e);
        if (storageState !== 'error') storageState = 'degraded';
        return sendJSON(res, 503, { ok: false, error: 'storage_unavailable' });
      }
    }
    return sendJSON(res, 200, { ok: true, roomId: room.id });
  }
  const m = p.match(/^\/api\/rooms\/([A-Za-z0-9]{1,10})$/);
  if (req.method === 'GET' && m) {
    let room = rooms.get(m[1]);
    if (!room && roomRepo) {
      try {
        room = await restoreRoomFromStorage(m[1]);
      } catch (e) {
        // 读库异常 ≠ 房间不存在：返回 503，避免把存储故障伪装成 404。
        // 这里不改 storageState——单次只读请求失败不应影响其它房间的正常写入。
        console.error('[storage] 查询房间 %s 失败：%s', m[1], (e && e.message) || e);
        return sendJSON(res, 503, { ok: false, error: 'storage_unavailable' });
      }
    }
    if (!room) return sendJSON(res, 404, { ok: false, error: 'no_room' });
    return sendJSON(res, 200, {
      ok: true, roomId: room.id, players: playerCount(room),
      seatCount: seatCount(room), specCount: room.specs.length, specCap: room.specCap,
      full: !!(room.seats.red && room.seats.black),
      paused: !!room.paused, pendingRestart: !!room.pendingRestart,
      frozen: !!room.frozen,
    });
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG_BYTES });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null; ws.seat = null; ws.member = null;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return sendErr(ws, 'bad_json', '消息不是合法 JSON'); }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return sendErr(ws, 'bad_params', '缺少消息类型');

    let out;
    try { out = dispatchMessage(ws, msg); }
    catch (e) { console.error('[ws] 处理消息异常：', e); return; }
    // 处理器可能返回 Promise（持久化是异步的）；异常只记日志，绝不让连接挂掉
    if (out && typeof out.catch === 'function') out.catch(e => console.error('[ws] 异步处理消息异常：', e));
  });

  ws.on('close', () => detach(ws));
});

// 消息分发（与原 switch 一致；独立出来便于统一捕获同步/异步异常）
function dispatchMessage(ws, msg) {
  switch (msg.t) {
    case 'join':    return handleJoin(ws, msg);
    case 'move':    return handleMove(ws, msg);
    case 'restart': return handleRestart(ws, msg);
    case 'peek':    return handlePeek(ws, msg);
    case 'seat':    return handleTakeSeat(ws);
    case 'spectate':return handleSpectate(ws);
    case 'specCap': return handleSpecCap(ws, msg);
    case 'declineRestart': return handleDeclineRestart(ws);
    case 'leave':   detach(ws, { explicit: true }); try { ws.close(1000, 'leave'); } catch (e) {} return;
    case 'ping':    return send(ws, { t: 'pong', ts: Date.now() });
    default:        return sendErr(ws, 'bad_type', '未知消息类型：' + msg.t.slice(0, 20));
  }
}

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, HEARTBEAT_MS);
heartbeat.unref();          // 不阻止进程退出（测试/脚本里 require 本文件时不会被拖住）

const cleaner = setInterval(async () => {
  const now = Date.now();
  // 内存中的无人房间照旧回收（文档仍在数据库，重进房间时按需恢复）
  for (const [id, room] of rooms) {
    if (shouldReapRoom(room, now)) rooms.delete(id);
  }
  if (!roomRepo) return;
  // 存储自愈：初始化失败/瞬时故障后周期探测，恢复即解除新建/加入限制
  try {
    if (storageState !== 'ok') {
      await roomRepo.ping();
      storageState = 'ok';
      console.log('[storage] 存储恢复可用');
    }
    // 过期文档清理（幂等；Render 休眠期间定时任务不跑，重启后 initPersistence 也会清一次）
    await roomRepo.deleteExpiredRooms(new Date());
  } catch (e) { /* 保持 degraded/error，下一轮再试 */ }
  // 冻结房间逐个尝试解冻（resync 需持房间锁）
  for (const room of Array.from(rooms.values())) {
    if (!room.frozen) continue;
    try {
      const ok = await withRoomLock(room, () => resyncRoomFromStorage(room));
      if (ok) {
        for (const mm of members(room)) {
          if (mm.connected && mm.ws) send(mm.ws, { t: 'storageRecovered' });
        }
      }
    } catch (e) { /* 下一轮再试 */ }
  }
}, 60 * 1000);
cleaner.unref();

function start(port = process.env.PORT || 3000, host = '0.0.0.0') {
  return (async () => {
    // 配置了持久化（CLOUDBASE_ENV_ID）时：先初始化并恢复房间，再开始监听。
    // 恢复失败不退出进程：/healthz 如实上报，且拒绝新建/加入（storageState 门禁），
    // 避免以纯内存模式静默运行、也避免无休止的崩溃重启循环。
    if (process.env.CLOUDBASE_ENV_ID && !roomRepo) {
      const r = await initPersistence();
      console.log('[storage] 启动持久化初始化：' + JSON.stringify(r));
      if (r.state === 'error') {
        // 不退出进程（避免平台重启循环），但明确告知：建房/加入会被拒绝，不会静默降级
        console.error('[storage] 持久化不可用，已禁用建房/加入：' + (r.error || 'unknown'));
      }
    }
    return await new Promise(resolve => {
      server.listen(port, host, () => resolve(server.address()));
    });
  })();
}

function stop() {
  clearInterval(heartbeat);
  clearInterval(cleaner);
  try { wss.clients.forEach(c => { try { c.terminate(); } catch (e) {} }); } catch (e) {}
  try { wss.close(); } catch (e) {}
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise(resolve => server.close(() => resolve()));
}

// 启动/关闭日志里的存储说明：必须与真实模式一致，不能固定写"内存态"
function storageSummaryLine() {
  const si = storageInfo();
  if (si.mode === 'cloudbase') {
    const hours = Math.max(1, Math.round(si.ttlMs / 3600000));
    return '房间存储：CloudBase 文档数据库（state=' + si.state + '，快照过期 ' + hours + ' 小时）；' +
      '服务重启后房间会从数据库恢复，但双方需要重新连接。';
  }
  if (si.state === 'error') {
    return '房间存储：内存（持久化配置失败，已拒绝建房/加入）；服务重启后房间与棋局都会丢失。';
  }
  return '房间存储：内存（未启用 CloudBase 持久化）；服务重启 / 免费实例休眠后房间与棋局都会丢失。';
}

// 平台（Render 等）停实例/重新部署时会发 SIGTERM：先告知客户端再关闭，便于前端提示"服务重启"
function shutdown(sig) {
  const persistent = storageInfo().mode === 'cloudbase' && storageState === 'ok';
  console.log('[%s] 正在关闭服务：%s', sig,
    persistent ? '房间快照已在 CloudBase，重启后可从数据库恢复（玩家需重新连接）'
               : '房间仅保存在内存，重启后房间与棋局都会丢失');
  try { wss.clients.forEach(c => { try { c.close(1001, 'server restart'); } catch (e) {} }); } catch (e) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  start().then(addr => {
    console.log(`揭棋联机服务已启动：http://localhost:${addr.port}（监听 0.0.0.0，PORT=${process.env.PORT || 3000}）`);
    console.log('同一台电脑：浏览器打开上面地址；局域网：用 http://<本机IP>:' + addr.port);
    console.log(storageSummaryLine());
  });
}

module.exports = { server, wss, start, stop, shutdown, loadEngine, createRoom, rooms, toView, playerCount, shouldReapRoom, initPersistence, storageInfo };
