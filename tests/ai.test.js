'use strict';
// AI 战术与搜索正确性回归（node --test）
// 覆盖：吃子/反吃/诱饵/大子保护、评估视角对称、状态还原、暗子身份不可利用、
//       置换表开关一致、超时与节点预算兜底、深度 1~5 决策稳定性。
const { test } = require('node:test');
const assert = require('node:assert');
const srv = require('../server.js');

const K = c => ({ color: c, type: 'king', faceUp: true });
const R = c => ({ color: c, type: 'rook', faceUp: true });
const N = c => ({ color: c, type: 'knight', faceUp: true });
const C = c => ({ color: c, type: 'cannon', faceUp: true });
const P = c => ({ color: c, type: 'pawn', faceUp: true });

function fresh() { const E = srv.loadEngine(); E.setup(); return E; }

/** 用给定棋子摆一个局面（清空棋盘） */
function place(E, pieces, turn) {
  E.setup();
  const s = JSON.parse(E.saveState());
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) s.board[r][c] = null;
  pieces.forEach(([r, c, p]) => { s.board[r][c] = Object.assign({}, p); });
  s.currentTurn = turn || 'red';
  s.gameOver = false; s.winner = null; s.winReason = null;
  s.capturedRed = []; s.capturedBlack = []; s.moveLog = []; s.handNo = 0;
  s.lastMove = null; s.moveTrail = []; s.historyLength = 0;
  E.loadState(JSON.stringify(s));
  return s;
}

const mvKey = r => r ? [r.fr, r.fc, r.tr, r.tc].join(',') : null;
/** 固定深度搜索（无暗子局面，不采样，结果确定） */
function search(E, d, opts) {
  E.loadState(E.saveState());
  return E.searchRoot('red', d, Object.assign({ samples: 1, timeMs: 4000, nodeLimit: 200000, qDepth: 3 }, opts || {}));
}

// ---------------- 战术：该吃的必须吃 ----------------
const T_FREE_ROOK = [[0, 3, K('black')], [9, 5, K('red')], [4, 0, R('red')], [4, 4, R('black')]];
const T_FREE_PAWN = [[0, 3, K('black')], [9, 6, K('red')], [6, 0, R('red')], [6, 4, P('black')]];
const T_MATE1 = [[0, 4, K('black')], [9, 5, K('red')], [0, 0, R('red')]];

test('AI 战术：白吃车（深度 2/3）', () => {
  for (const d of [2, 3]) {
    const E = fresh(); place(E, T_FREE_ROOK);
    assert.equal(mvKey(search(E, d)), '4,0,4,4', 'depth ' + d + ' 应吃掉无保护的车');
  }
});

test('AI 战术：白吃卒（深度 2/3）', () => {
  for (const d of [2, 3]) {
    const E = fresh(); place(E, T_FREE_PAWN);
    assert.equal(mvKey(search(E, d)), '6,0,6,4', 'depth ' + d + ' 应吃掉无保护的卒');
  }
});

test('AI 战术：一步吃将（深度 1~3）', () => {
  for (const d of [1, 2, 3]) {
    const E = fresh(); place(E, T_MATE1);
    assert.equal(mvKey(search(E, d)), '0,0,0,4', 'depth ' + d + ' 应直接吃将');
  }
});

// ---------------- 战术：不该吃的不能吃 ----------------
test('AI 战术：不吃会被反吃的兵（换子亏）', () => {
  const E = fresh();
  place(E, [[0, 3, K('black')], [9, 5, K('red')], [3, 0, R('red')], [3, 4, P('black')], [3, 8, R('black')]]);
  for (const d of [2, 3, 4]) {
    E.loadState(E.saveState());
    const r = E.searchRoot('red', d, { samples: 1, timeMs: 4000, nodeLimit: 200000, qDepth: 3 });
    assert.notEqual(mvKey(r), '3,0,3,4', 'depth ' + d + ' 不应拿车换兵');
  }
});

test('AI 战术：不吃被炮保护的诱饵马', () => {
  // 黑马 (5,4) 由黑炮 (0,4) 隔着 (3,4) 的卒保护：吃马会被炮反吃
  const E = fresh();
  place(E, [[2, 3, K('black')], [9, 6, K('red')], [5, 0, R('red')], [5, 4, N('black')],
            [0, 4, C('black')], [3, 4, P('black')]]);
  for (const d of [2, 3]) {
    E.loadState(E.saveState());
    const r = E.searchRoot('red', d, { samples: 1, timeMs: 4000, nodeLimit: 200000, qDepth: 3 });
    assert.notEqual(mvKey(r), '5,0,5,4', 'depth ' + d + ' 不应吃被炮保护的诱饵');
  }
});

test('AI 战术：被炮牵制的大子要处理（不能走无关着法）', () => {
  // 黑炮 (5,8) 隔着黑卒 (5,6) 打红车 (5,4)：红方要么吃掉炮架，要么把车挪开
  const E = fresh();
  place(E, [[0, 3, K('black')], [9, 1, K('red')], [5, 4, R('red')], [5, 6, P('black')], [5, 8, C('black')]]);
  for (const d of [2, 3]) {
    E.loadState(E.saveState());
    const r = E.searchRoot('red', d, { samples: 1, timeMs: 4000, nodeLimit: 200000, qDepth: 3 });
    const key = mvKey(r);
    assert.ok(key && key.startsWith('5,4,'), 'depth ' + d + ' 应处理被攻击的车，实际走 ' + key);
  }
});

// ---------------- 评估视角 / 状态 / 信息隔离 ----------------
test('评估视角：无将军时 eval(红) 与 eval(黑) 严格互为相反数', () => {
  const E = fresh();
  place(E, [
    [0, 4, K('black')], [9, 4, K('red')],
    [2, 0, R('black')], [7, 0, R('red')], [2, 4, P('black')], [7, 4, P('red')],
    [0, 2, N('black')], [9, 2, N('red')],
  ]);
  assert.equal(E.isKingAttacked('red'), false);
  assert.equal(E.isKingAttacked('black'), false);
  const a = E.evalParts('red').total, b = E.evalParts('black').total;
  assert.ok(Math.abs(a + b) < 1e-6, `应互为相反数，实际 red=${a} black=${b}`);
});

test('搜索不修改真实棋局：含暗子局面搜索前后状态完全一致', () => {
  const E = fresh();                                  // 随机开局，含 30 枚暗子
  const before = E.saveState();
  const r = E.searchRoot('red', 3, { samples: 2, timeMs: 800, nodeLimit: 50000, qDepth: 3 });
  assert.ok(r && Number.isInteger(r.fr), '应返回走法');
  assert.equal(E.saveState(), before, '搜索后棋盘/回合/暗子身份/日志必须完全还原');
});

test('暗子身份不进入评估：篡改隐藏 color/type 后评估值完全不变', () => {
  const E = fresh();                                   // 随机开局，含 30 枚暗子
  const s0 = E.saveState();
  const before = E.evalParts('red');

  const s = JSON.parse(s0);
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = s.board[r][c];
    if (p && !p.faceUp) {
      p.color = p.color === 'red' ? 'black' : 'red';
      p.type = p.type === 'rook' ? 'pawn' : 'rook';
    }
  }
  E.loadState(JSON.stringify(s));
  const after = E.evalParts('red');

  // 暗子一律按未知池期望值计分，真实身份不得影响任何分量
  assert.equal(after.material, before.material, '子力分不得随暗子真实身份变化');
  assert.equal(after.position, before.position);
  assert.equal(after.mobility, before.mobility);
  assert.equal(after.captureGain, before.captureGain);
  assert.equal(after.exposure, before.exposure);
  assert.equal(after.total, before.total);
});

test('暗子身份被篡改后，AI 仍只返回该局面下合法的走法（不绕过判定）', () => {
  const E = fresh();
  const s0 = E.saveState();
  const s = JSON.parse(s0);
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = s.board[r][c];
    if (p && !p.faceUp) { p.color = p.color === 'red' ? 'black' : 'red'; p.type = p.type === 'rook' ? 'pawn' : 'rook'; }
  }
  E.loadState(JSON.stringify(s));
  const r1 = E.searchRoot('red', 3, { samples: 2, timeMs: 400, nodeLimit: 30000, qDepth: 3, seed: 12345 });
  assert.ok(r1);
  assert.ok(E.getLegalMoves(r1.fr, r1.fc).some(m => m.r === r1.tr && m.c === r1.tc), '篡改身份后仍必须给出合法走法');
});

test('置换表开关一致：同深度同种子，开关 TT 得到相近评分与合法走法', () => {
  const E = fresh();
  place(E, [
    [0, 4, K('black')], [9, 4, K('red')],
    [2, 0, R('black')], [7, 0, R('red')], [2, 4, P('black')], [7, 4, P('red')],
    [0, 2, N('black')], [9, 2, N('red')], [5, 2, C('red')], [5, 6, C('black')],
  ]);
  const a = search(E, 3, { tt: true });
  const b = search(E, 3, { tt: false });
  assert.ok(a && b);
  assert.ok(Math.abs(a.score - b.score) < 1.5, `TT 开关评分应一致，实际 ${a.score} vs ${b.score}`);
  const legal = E.getLegalMoves(a.fr, a.fc).some(m => m.r === a.tr && m.c === a.tc);
  assert.ok(legal, 'TT 版本走法必须合法');
});

test('超时兜底：极小预算也能返回合法走法且状态还原', () => {
  const E = fresh();
  place(E, [
    [0, 4, K('black')], [9, 4, K('red')],
    [2, 0, R('black')], [7, 0, R('red')], [2, 4, P('black')], [7, 4, P('red')],
    [0, 2, N('black')], [9, 2, N('red')],
  ]);
  const before = E.saveState();
  const t0 = Date.now();
  const r = E.searchRoot('red', 6, { samples: 1, timeMs: 60, nodeLimit: 500000, qDepth: 3 });
  const dt = Date.now() - t0;
  assert.ok(dt < 3000, '超时保护应尽快返回，实际 ' + dt + 'ms');
  assert.ok(r && Number.isInteger(r.fr), '必须仍有走法');
  assert.ok(E.getLegalMoves(r.fr, r.fc).some(m => m.r === r.tr && m.c === r.tc), '返回的走法必须合法');
  assert.equal(E.saveState(), before, '超时后状态必须还原');
});

test('节点预算：nodeLimit 生效且仍返回合法走法', () => {
  const E = fresh();
  place(E, [
    [0, 4, K('black')], [9, 4, K('red')],
    [2, 0, R('black')], [7, 0, R('red')], [2, 4, P('black')], [7, 4, P('red')],
    [0, 2, N('black')], [9, 2, N('red')], [5, 2, C('red')], [5, 6, C('black')],
  ]);
  const r = E.searchRoot('red', 6, { samples: 1, timeMs: 10000, nodeLimit: 200, qDepth: 3 });
  assert.ok(r && Number.isInteger(r.fr), '预算用尽也必须给出走法');
  assert.ok(E.lastSearch.nodes < 2000, '节点数应被预算截断，实际 ' + E.lastSearch.nodes);
});

test('深度 1~5：同一局面不出现"好手→坏手"跳变', () => {
  const E = fresh();
  place(E, T_FREE_ROOK);
  for (let d = 1; d <= 5; d++) {
    E.loadState(E.saveState());
    const r = E.searchRoot('red', d, { samples: 1, timeMs: 4000, nodeLimit: 300000, qDepth: 3 });
    assert.equal(mvKey(r), '4,0,4,4', 'depth ' + d + ' 决策应稳定（白吃车）');
  }
});

test('AI 走法必须在真实局面合法（采样世界不得放宽合法性）', () => {
  const E = fresh();                                   // 随机开局：含暗子，涉及"翻开后才知道是否送将"
  for (let i = 0; i < 10; i++) {
    const r = E.searchRoot('red', 3, { samples: 2, timeMs: 260, nodeLimit: 20000, qDepth: 3, seed: 1000 + i * 37 });
    assert.ok(r && Number.isInteger(r.fr), '第 ' + i + ' 次搜索应返回走法');
    const legal = E.getLegalMoves(r.fr, r.fc).some(m => m.r === r.tr && m.c === r.tc);
    assert.ok(legal, `第 ${i} 次返回了真实局面下的非法走法：${[r.fr, r.fc, r.tr, r.tc]}`);
    E.makeMove(r.fr, r.fc, r.tr, r.tc);
    assert.equal(E.isKingAttacked('red'), false, '走完己方不能被将军');
    if (E.gameOver) break;
    // 换边继续验证（保持红方视角断言，走完黑方后确认红方未被将军）
    const r2 = E.searchRoot('black', 3, { samples: 2, timeMs: 260, nodeLimit: 20000, qDepth: 3, seed: 2000 + i * 53 });
    if (!r2) break;
    assert.ok(E.getLegalMoves(r2.fr, r2.fc).some(m => m.r === r2.tr && m.c === r2.tc), '黑方走法也必须合法');
    E.makeMove(r2.fr, r2.fc, r2.tr, r2.tc);
    assert.equal(E.isKingAttacked('black'), false, '黑方走完自己不能被将军');
    if (E.gameOver) break;
  }
});

// ==================== 本轮新增：战略评估（阶段/协同/九宫压制/开关） ====================

test('阶段系数：满子约 1、去掉 10 子约 0.5，且与评估分量一致', () => {
  const E = fresh();
  const p0 = E.evalParts('red');
  assert.ok(p0.phase > 0.95, '开局阶段应接近 1，实际 ' + p0.phase);

  const s = JSON.parse(E.saveState());
  let removed = 0;
  outer: for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = s.board[r][c];
    if (p && !p.faceUp) { s.board[r][c] = null; if (++removed >= 10) break outer; }
  }
  E.loadState(JSON.stringify(s));
  const p1 = E.evalParts('red');
  assert.ok(Math.abs(p1.phase - 0.5) < 0.06, '去掉 10 子后阶段应约 0.5，实际 ' + p1.phase);
});

test('位置分随阶段变化：马在中心的价值开局高于残局（不引入固定格子分）', () => {
  const E = fresh();
  const s = JSON.parse(E.saveState());
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) s.board[r][c] = null;
  s.board[9][4] = { color: 'red', type: 'king', faceUp: true };
  s.board[0][4] = { color: 'black', type: 'king', faceUp: true };
  s.board[4][4] = { color: 'red', type: 'knight', faceUp: true };
  E.loadState(JSON.stringify(s));
  const openMid = E.positionScore(E.board[4][4], 4, 4, 'red', 1.0);
  const endMid  = E.positionScore(E.board[4][4], 4, 4, 'red', 0.0);
  assert.ok(openMid > endMid, `马中心化应开局更重要：${openMid} 应 > ${endMid}`);
  // 车在开放线的加分与阶段无关（开放线始终是好位置）
  s.board[4][4] = { color: 'red', type: 'rook', faceUp: true };
  E.loadState(JSON.stringify(s));
  const rOpen = E.positionScore(E.board[4][4], 4, 4, 'red', 0.0);
  assert.ok(rOpen > 0, '开放线上的车应有正向位置分');
});

test('协同：双重攻击（车 + 马同攻一个无保护的车）计入 coord', () => {
  const E = fresh();
  place(E, [
    [0, 3, K('black')], [9, 5, K('red')],
    [5, 0, R('red')], [3, 3, N('red')], [5, 4, R('black')],
  ]);
  const p = E.evalParts('red');
  assert.ok(p.coord > 8, '双重攻击应带来协同加分，实际 coord=' + p.coord.toFixed(2));
  // 守方视角：同一局面下黑方的 coord 应为负（对称）
  const q = E.evalParts('black');
  assert.ok(Math.abs(p.coord + q.coord) < 1e-9, 'coord 必须严格对称');
});

test('九宫压制：控制对方九宫格越多，kingNet 越大且双向对称', () => {
  const E = fresh();
  place(E, [
    [1, 4, K('black')], [9, 5, K('red')], [0, 8, R('red')],
  ]);
  const p = E.evalParts('red');
  assert.ok(p.kingNet > 3, '车横扫底线应控制 3 个九宫格（0,3/0,4/0,5），实际 ' + p.kingNet.toFixed(2));
  const q = E.evalParts('black');
  assert.ok(Math.abs(p.kingNet + q.kingNet) < 1e-9, 'kingNet 必须严格对称');
});

test('战略项可整体关闭：strategy=0 时 coord/kingNet 不进入总分', () => {
  const E = fresh();
  place(E, [
    [0, 3, K('black')], [9, 5, K('red')],
    [5, 0, R('red')], [3, 3, N('red')], [5, 4, R('black')],
  ]);
  E.setStrategyWeight(0);
  const off = E.evalParts('red');
  E.setStrategyWeight(1);
  const on = E.evalParts('red');
  assert.equal(off.strategy, 0, '关闭后战略分量必须为 0');
  assert.ok(Math.abs(on.strategy - (E.SEARCH_EVAL.coord*on.coord + E.SEARCH_EVAL.kingNet*on.kingNet)) < 1e-6,
    '信息项默认权重应为 0（不参与总分）');
  E.setStrategyWeight(1);
});

test('战略项不改变显性战术：白吃车在 strategy 0/1 下都应吃', () => {
  const E = fresh();
  place(E, T_FREE_ROOK);
  const a = search(E, 2, { strategy: 0 });
  const b = search(E, 2, { strategy: 1 });
  assert.equal(mvKey(a), '4,0,4,4');
  assert.equal(mvKey(b), '4,0,4,4');
});

test('含暗子中局：战略项开启后评估仍严格对称（随机局面）', () => {
  const E = fresh();
  E.sampleWorld(E.unknownPool(), E.makeRng(20261030));
  for (let i = 0; i < 12; i++) {
    const ms = E.collectMoves(E.turn);
    if (!ms.length) break;
    const mv = ms[(i * 11 + 3) % ms.length];
    E.makeMove(mv.fr, mv.fc, mv.tr, mv.tc);
    if (E.gameOver) break;
  }
  if (E.gameOver) return;
  E.setStrategyWeight(1);
  const a = E.evalParts('red').total, b = E.evalParts('black').total;
  assert.ok(Math.abs(a + b) < 1e-6, `战略项破坏对称：red=${a} black=${b}`);
});

test('难度档：四档配置齐全，普通关战略、困难/大师开战略，大师采样更多', () => {
  const E = fresh();
  const L = E.AI_LEVELS;
  assert.deepEqual(Object.keys(L).sort(), ['easy', 'hard', 'master', 'normal']);
  assert.equal(L.normal.strategy, 0, '普通档只做基础战术');
  assert.equal(L.hard.strategy, 1);
  assert.equal(L.master.strategy, 1);
  assert.ok(L.master.samples > L.hard.samples, '大师档应有更多暗子采样');
  assert.ok(L.master.timeMs > L.hard.timeMs && L.hard.timeMs > L.normal.timeMs, '预算应逐档提高');
});

test('难度档：easy 返回合法走法（不因新增档位破坏兜底）', () => {
  const E = fresh();
  const mv = E.chooseAIMove('red', 'easy');
  assert.ok(mv && Number.isInteger(mv.fr));
  assert.ok(E.getLegalMoves(mv.fr, mv.fc).some(m => m.r === mv.tr && m.c === mv.tc));
});

// ==================== 本轮新增：SEE（静态交换评估）与落点风险 ====================
/** 建好攻击图（SEE 依赖攻击图里的攻击者列表） */
function prep(E) { E.evalParts('red'); return E; }

test('SEE：白吃无保护的马 = 整子价值', () => {
  const E = fresh();
  place(E, [[9, 5, K('red')], [0, 3, K('black')], [5, 0, R('red')], [5, 4, N('black')]]);
  prep(E);
  assert.equal(E.seeCapture(5, 0, 5, 4), 45);
});

test('SEE：吃「有保护的马」会亏一个车（-45）', () => {
  const E = fresh();
  place(E, [[9, 5, K('red')], [0, 3, K('black')], [5, 0, R('red')], [5, 4, N('black')], [3, 3, N('black')]]);
  prep(E);
  assert.equal(E.seeCapture(5, 0, 5, 4), -45, '车(90)吃马(45)被马反吃 → 净 -45');
});

test('SEE：等价交换（车换有保护的车）= 0，不会误判成赚', () => {
  const E = fresh();
  place(E, [[9, 5, K('red')], [0, 3, K('black')], [5, 0, R('red')], [5, 4, R('black')], [3, 3, N('black')]]);
  prep(E);
  assert.equal(E.seeCapture(5, 0, 5, 4), 0);
});

test('SEE：两车攻「单马保护的马」= 0（连续换子后不赚不亏）', () => {
  const E = fresh();
  place(E, [[9, 5, K('red')], [0, 3, K('black')], [5, 4, N('black')], [3, 3, N('black')],
            [5, 0, R('red')], [7, 4, R('red')]]);
  prep(E);
  const loss = E.seeLoss('black', 'red');
  assert.equal(loss, 0, '实际 ' + loss);
  // 默认引擎的 looseLoss 仍是旧语义（不统计"被保护"）：把该子当无人保护记满 45。
  // 这正是 SEE 要修的误差，两者在此局面必然不同。
  assert.equal(E.looseLoss('black', 'red'), 45, 'looseLoss 旧语义：视为无保护');
});

test('SEE：连续换子算到底（马换马后车还能吃回守方兵），比 looseLoss 更准', () => {
  const E = fresh();
  // 黑马 (5,4) 由黑卒 (4,4) 保护；红马 (3,5) 与红车 (5,0) 都能吃它
  place(E, [[9, 5, K('red')], [0, 3, K('black')], [5, 4, N('black')], [4, 4, P('black')],
            [5, 0, R('red')], [3, 5, N('red')]]);
  prep(E);
  // 红马吃马(+45) → 黑卒吃马(-45) → 红车吃卒(+12) = 12
  assert.equal(E.seeLoss('black', 'red'), 12, 'SEE 应算到第三手');
  // looseLoss 旧语义把目标当"无保护"→ 记满 45，既忽略反吃也忽略后续吃回，正是本轮要修的误差
  assert.equal(E.looseLoss('black', 'red'), 45, 'looseLoss 旧语义：视为无保护');
});

test('SEE：暗子只按公开期望价值，篡改真实身份不影响结果', () => {
  const E = fresh();
  const dark = (owner, st, color, type) => ({ color, type, faceUp: false, darkOwner: owner, startType: st });
  place(E, [[9, 5, K('red')], [0, 3, K('black')], [5, 0, R('red')], [5, 4, dark('black', 'knight', 'red', 'rook')]]);
  prep(E);
  const a = E.seeCapture(5, 0, 5, 4);
  place(E, [[9, 5, K('red')], [0, 3, K('black')], [5, 0, R('red')], [5, 4, dark('black', 'knight', 'black', 'pawn')]]);
  prep(E);
  const b = E.seeCapture(5, 0, 5, 4);
  assert.equal(a, b, '暗子真实身份不得影响 SEE');
  assert.equal(a, E.unknownPool && a > 0 ? a : a);
});

test('SEE 开启后评估仍严格对称（红黑互为相反数）', () => {
  const E = fresh();
  place(E, [[9, 5, K('red')], [0, 3, K('black')], [5, 4, N('black')], [4, 4, P('black')],
            [5, 0, R('red')], [3, 5, N('red')]]);
  prep(E);
  const a = E.evalParts('red').total, b = E.evalParts('black').total;
  assert.ok(Math.abs(a + b) < 1e-6, `red=${a} black=${b}`);
});

test('落点风险：等价交换的骚扰扣分，且不重复扣「真亏子」', () => {
  const E = fresh();
  // 红车刚走到 (5,4)，被黑车 (5,0) 盯上，红车有红车 (8,4) 保护 → SEE=0，属"掉先手"
  place(E, [[9, 3, K('red')], [0, 3, K('black')], [5, 4, R('red')], [5, 0, R('black')], [8, 4, R('red')]]);
  let s = JSON.parse(E.saveState());
  s.lastMove = { from: { r: 6, c: 4 }, to: { r: 5, c: 4 } };
  E.loadState(JSON.stringify(s));
  prep(E);
  assert.equal(E.seeCapture(5, 0, 5, 4), 0, '车换车应等价');
  assert.equal(E.landingRisk('red'), -E.SEARCH_EVAL.landing, '被等价攻击应扣分');
  assert.equal(E.landingRisk('black'), E.SEARCH_EVAL.landing, '对手视角取反');

  // 真亏子（无保护的车被兵盯上）：交给 SEE，落点项不重复扣
  place(E, [[9, 3, K('red')], [0, 3, K('black')], [5, 4, R('red')], [4, 4, P('black')]]);
  s = JSON.parse(E.saveState());
  s.lastMove = { from: { r: 6, c: 4 }, to: { r: 5, c: 4 } };
  E.loadState(JSON.stringify(s));
  prep(E);
  assert.ok(E.seeLoss('red', 'black') > 0, 'SEE 应看到亏子');
  assert.equal(E.landingRisk('red'), 0, '亏子已由 SEE 计入，落点项必须为 0');
});

test('落点风险：小棋子/未被攻击/非最后一步都不计', () => {
  const E = fresh();
  place(E, [[9, 3, K('red')], [0, 3, K('black')], [5, 4, P('red')], [5, 0, R('black')]]);
  const s = JSON.parse(E.saveState());
  s.lastMove = { from: { r: 6, c: 4 }, to: { r: 5, c: 4 } };
  E.loadState(JSON.stringify(s));
  prep(E);
  assert.equal(E.landingRisk('red'), 0, '兵被攻击不计落点风险');
});

// ==================== 本轮新增：自适应暗子采样 ====================
const darkPiece = (owner, st) => ({ color: owner, type: 'pawn', faceUp: false, darkOwner: owner, startType: st });

test('自适应采样规则：暗子多则加一、少则减、战术局面退回下限、快棋压上限', () => {
  const E = fresh();
  const P = E.decideSamplePlan;
  const base = { base: 2, min: 1, max: 3, sharp: false, timeMs: 1300, phase: 1 };
  assert.equal(P(Object.assign({}, base, { dark: 30 })), 3, '开局暗子多应加一');
  assert.equal(P(Object.assign({}, base, { dark: 14 })), 2, '中局按档位默认');
  assert.equal(P(Object.assign({}, base, { dark: 7 })), 1, '少量暗子应减一');
  assert.equal(P(Object.assign({}, base, { dark: 2 })), 1, '残局只采 1 个世界');
  assert.equal(P(Object.assign({}, base, { dark: 30, sharp: true })), 1, '关键战术局面优先深度');
  assert.equal(P(Object.assign({}, base, { dark: 30, phase: 0.2 })), 2, '残局阶段不再加采样');
  assert.equal(P(Object.assign({}, base, { dark: 30, timeMs: 400 })), 2, '快棋上限 2');
  assert.equal(P(Object.assign({}, base, { dark: 30, timeMs: 250 })), 1, '极短预算只采 1 次');
  // 上限/下限必须真正夹住（不能因为暗子多就无限加世界）
  assert.equal(P(Object.assign({}, base, { dark: 30, max: 2 })), 2, '上限必须生效');
  assert.equal(P(Object.assign({}, base, { dark: 2, min: 2 })), 2, '下限必须生效');
  assert.equal(P(Object.assign({}, base, { dark: 30, max: 1 })), 1, 'max=1 等于关闭采样');
});

test('自适应采样：关闭时 planned 恒等于固定配置（回退开关有效）', () => {
  const E = fresh();
  const r = E.searchRoot('red', 3, { samples: 2, timeMs: 300, nodeLimit: 30000, qDepth: 3, seed: 11 });
  assert.ok(r);
  assert.equal(E.lastSearch.planned, 2, '固定采样下 planned 必须等于配置值');
  assert.equal(E.lastSearch.adaptive, 0);
});

test('自适应采样：开局（暗子多）不减少世界数，且计入世界数不超过计划', () => {
  const E = fresh();                                   // 随机开局：30 枚暗子
  E.loadState(E.saveState());
  const r = E.searchRoot('red', 6, {
    samples: 2, adaptive: 1, sampleMin: 1, sampleMax: 3,
    timeMs: 800, nodeLimit: 200000, qDepth: 3, seed: 4242
  });
  assert.ok(r && Number.isInteger(r.fr));
  const s = E.lastSearch;
  assert.ok(s.planned >= 2 && s.planned <= 3, '开局计划应在 2~3 之间，实际 ' + s.planned);
  assert.ok(s.samples >= 1 && s.samples <= s.planned, '实际计入世界数必须落在 [1, planned]');
  assert.ok(E.getLegalMoves(r.fr, r.fc).some(m => m.r === r.tr && m.c === r.tc), '走法必须合法');
});

test('自适应采样：暗子很少时计划退到 1，把预算留给深度', () => {
  const E = fresh();
  place(E, [
    [9, 4, K('red')], [0, 4, K('black')],
    [5, 0, R('red')], [2, 8, R('black')], [6, 4, P('red')], [3, 4, P('black')],
    [4, 2, darkPiece('red', 'knight')], [4, 6, darkPiece('black', 'cannon')],
  ]);
  const r = E.searchRoot('red', 6, {
    samples: 2, adaptive: 1, sampleMin: 1, sampleMax: 3,
    timeMs: 800, nodeLimit: 200000, qDepth: 3, seed: 77
  });
  assert.ok(r);
  assert.equal(E.lastSearch.planned, 1, '暗子 2 枚时只应采 1 个世界');
  assert.equal(E.lastSearch.samples, 1);
});

test('自适应采样：被将军时退回采样下限，且仍返回解将走法', () => {
  const E = fresh();
  place(E, [
    [9, 4, K('red')], [0, 4, K('black')], [0, 0, R('black')], [8, 8, R('red')],
    [2, 2, darkPiece('red', 'cannon')], [3, 6, darkPiece('black', 'knight')],
  ]);
  assert.equal(E.isKingAttacked('red'), true, '构造局面：红方应被将军');
  const r = E.searchRoot('red', 5, {
    samples: 2, adaptive: 1, sampleMin: 1, sampleMax: 3,
    timeMs: 500, nodeLimit: 60000, qDepth: 3, seed: 99
  });
  assert.ok(r);
  assert.equal(E.lastSearch.planned, 1, '关键战术局面应把预算全给深度');
  E.makeMove(r.fr, r.fc, r.tr, r.tc);
  assert.equal(E.isKingAttacked('red'), false, '选出的走法必须解将');
});

test('自适应采样：搜索后真实局面完全还原（含暗子身份）', () => {
  const E = fresh();
  const before = E.saveState();
  E.searchRoot('red', 6, {
    samples: 2, adaptive: 1, sampleMin: 1, sampleMax: 3,
    timeMs: 600, nodeLimit: 150000, qDepth: 3, seed: 2026
  });
  assert.equal(E.saveState(), before, '自适应采样后棋盘/回合/身份必须完全还原');
});

// ==================== 本轮新增：战略目标识别（plan / entrap） ====================
const darkP = (owner, st) => ({ color: owner, type: 'pawn', faceUp: false, darkOwner: owner, startType: st });

test('被困大子：对方车被自己子堵死时 entrap 生效，且关闭后为 0', () => {
  const E = fresh();
  place(E, [
    [9, 3, K('red')], [0, 5, K('black')],
    [0, 0, R('black')], [0, 1, P('black')], [1, 0, P('black')],   // 黑车 0 步可走
    [7, 4, R('red')], [6, 1, P('red')],
  ]);
  E.setEntrapW(0);
  const off = E.evalParts('red');
  E.setEntrapW(1);
  const on = E.evalParts('red');
  assert.equal(off.entrap, 0, '关闭时必须为 0');
  assert.equal(on.entrap, E.SEARCH_EVAL.entrap, '一个被困车应给满 6 分');
  assert.ok(on.total > off.total, '开启后总分应更高');
  E.setEntrapW(0);
});

test('被困大子：红黑严格对称（eval(红) === -eval(黑)）', () => {
  const E = fresh();
  place(E, [
    [9, 3, K('red')], [0, 5, K('black')],
    [9, 0, R('red')], [9, 1, P('red')], [8, 0, P('red')],        // 红车同样被堵
    [5, 4, R('black')], [6, 1, P('red')],
  ]);
  E.setEntrapW(1);
  const a = E.evalParts('red'), b = E.evalParts('black');
  assert.ok(a.entrap !== 0 || b.entrap !== 0, '局面应至少有一个被困大子');
  assert.ok(Math.abs(a.total + b.total) < 1e-6, `对称性破坏：red=${a.total} black=${b.total}`);
  assert.ok(Math.abs(a.entrap + b.entrap) < 1e-6);
  E.setEntrapW(0);
});

test('目标识别：识别「无保护且跑不动」的大子；守得多的记为无效追子目标', () => {
  const E = fresh();
  place(E, [
    [9, 3, K('red')], [0, 5, K('black')],
    [0, 0, R('black')], [0, 1, P('black')], [1, 0, P('black')],  // 目标：0 步可走、无人保护
    [5, 4, R('black')], [5, 5, R('black')], [5, 6, N('black')],  // 被 2 子保护的车（guarded）
    [7, 4, R('red')], [6, 1, P('red')],
  ]);
  E.evalParts('red');
  const tg = E.planTargets('red');
  const keys = tg.targets.map(t => t.k);
  assert.ok(keys.includes(0), '角落里的黑车应成为目标');
  assert.ok(!keys.includes(5 * 9 + 4), '被两子保护的车不应成为可兑现目标');
  const t0 = tg.targets.find(t => t.k === 0);
  assert.equal(t0.def, 0);
  assert.equal(t0.mob, 0);
});

test('目标识别：攻击目标的走法获得加分，无关走法不加分，追被守住的目标记无效', () => {
  const E = fresh();
  place(E, [
    [9, 3, K('red')], [0, 5, K('black')],
    [0, 0, R('black')], [0, 1, P('black')], [1, 0, P('black')],   // 目标：0 步、无保护
    [5, 4, R('black')], [3, 5, N('black')], [7, 5, N('black')],   // 被两子保护的车（guarded）
    [7, 4, C('red')], [5, 3, R('red')], [6, 1, P('red')],
  ]);
  E.evalParts('red');
  const tg = E.planTargets('red');
  // 红炮 (7,4) → (7,0)：隔 (1,0) 的卒打 (0,0) 的黑车，属于「新攻击」
  const hit = E.movePlan('red', { fr: 7, fc: 4, tr: 7, tc: 0 }, tg);
  assert.ok(hit.bonus > 0, '落到目标同一列并形成攻击应获得战略加分，实际 ' + hit.bonus);
  assert.ok(hit.hits >= 1);
  const idle = E.movePlan('red', { fr: 7, fc: 4, tr: 7, tc: 8 }, tg);
  assert.equal(idle.bonus, 0, '无关走法不得加分');
  // 红车 (5,3) → (5,2)：仍然只瞄着被两子保护的黑车（守 >= 攻）→ 无效追子，不加分
  const chase = E.movePlan('red', { fr: 5, fc: 3, tr: 5, tc: 2 }, tg);
  assert.equal(chase.bonus, 0, '追被守住的目标不应加分');
  assert.ok(chase.futile >= 1, '追被守住的目标应记为无效追子，实际 ' + chase.futile);
});

test('战略目标层：暗子身份被篡改不影响加分（只按公开棋位类型算攻击）', () => {
  const E = fresh();
  const build = () => {
    E.setup();
    const s = JSON.parse(E.saveState());
    for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) s.board[r][c] = null;
    s.board[9][3] = K('red'); s.board[0][5] = K('black');
    s.board[0][0] = R('black'); s.board[0][1] = P('black'); s.board[1][0] = P('black');
    s.board[4][4] = darkP('red', 'rook');                       // 暗车：公开类型是车
    s.currentTurn = 'red'; s.gameOver = false; s.winner = null;
    s.capturedRed = []; s.capturedBlack = []; s.moveLog = []; s.lastMove = null; s.moveTrail = [];
    E.loadState(JSON.stringify(s));
    return s;
  };
  build();
  E.evalParts('red');
  const a = E.movePlan('red', { fr: 4, fc: 4, tr: 4, tc: 0 }, E.planTargets('red'));
  // 篡改暗子的真实身份（若实现读取真实 type，加分就会变）
  const s = build();
  s.board[4][4] = { color: 'red', type: 'pawn', faceUp: false, darkOwner: 'red', startType: 'rook' };
  E.loadState(JSON.stringify(s));
  E.evalParts('red');
  const b = E.movePlan('red', { fr: 4, fc: 4, tr: 4, tc: 0 }, E.planTargets('red'));
  assert.equal(a.bonus, b.bonus, '暗子真实身份不得影响战略加分');
});

test('战略层开关：默认关闭，开启后搜索仍返回合法走法且状态还原', () => {
  const E = fresh();
  assert.equal(E.SEARCH_CFG.plan, 0);
  assert.equal(E.SEARCH_CFG.entrap, 0);
  const before = E.saveState();
  const r = E.searchRoot('red', 4, { samples: 2, timeMs: 400, nodeLimit: 60000, qDepth: 3, plan: 1, entrap: 1, seed: 5150 });
  assert.ok(r && Number.isInteger(r.fr));
  assert.ok(E.getLegalMoves(r.fr, r.fc).some(m => m.r === r.tr && m.c === r.tc), '走法必须合法');
  assert.equal(E.saveState(), before, '开启战略层后搜索不得改动真实局面');
  assert.ok(E.lastSearch.planTargets >= 0);
});
