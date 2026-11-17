'use strict';
// 规则引擎回归：确认联机改造没有动到原有引擎（含 AI 入口）
const { test } = require('node:test');
const assert = require('node:assert');
const srv = require('../server.js');

function fresh() {
  const E = srv.loadEngine();
  E.setup();
  return E;
}

test('开局：32 子、双帅明置九宫、其余 30 枚暗子按半场归属', () => {
  const E = fresh();
  let total = 0, faceUp = 0, dark = 0, bad = 0;
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = E.board[r][c];
    if (!p) continue;
    total++;
    if (p.faceUp) faceUp++;
    else {
      dark++;
      if (p.darkOwner !== (r <= 4 ? 'black' : 'red')) bad++;
      if (!p.startType) bad++;
    }
  }
  assert.equal(total, 32);
  assert.equal(faceUp, 2);
  assert.equal(dark, 30);
  assert.equal(bad, 0);
  assert.equal(E.board[9][4].type, 'king');
  assert.equal(E.board[9][4].color, 'red');
  assert.equal(E.board[0][4].color, 'black');
});

test('走子：翻牌、换手、日志、吃子记录', () => {
  const E = fresh();
  assert.equal(E.turn, 'red');
  let mv = null;
  for (let r = 9; r >= 5 && !mv; r--) for (let c = 0; c < 9 && !mv; c++) {
    const p = E.board[r][c];
    if (p && E.sideOf(p) === 'red') {
      const ms = E.getLegalMoves(r, c);
      if (ms.length) mv = { r, c, m: ms[0] };
    }
  }
  assert.ok(mv, '红方应有合法走法');
  const piece = E.board[mv.r][mv.c];
  const wasDark = !piece.faceUp;
  E.makeMove(mv.r, mv.c, mv.m.r, mv.m.c);
  assert.equal(E.turn, 'black');
  assert.equal(E.board[mv.m.r][mv.m.c].faceUp, true, '暗子移动后必须翻开');
  assert.equal(wasDark ? E.moveLog.length === 1 : true, true);
  assert.equal(E.handNo, 1);
});

test('saveState / loadState 往返一致（联机权威状态的基础）', () => {
  const E = fresh();
  E.makeMove(9, 4, 8, 4);
  const s1 = E.saveState();
  E.makeMove(0, 4, 1, 4);
  const s2 = E.saveState();
  assert.notEqual(s1, s2);
  E.loadState(s1);
  assert.equal(E.saveState(), s1, '恢复后快照应完全一致');
  assert.equal(E.turn, 'black');
  assert.equal(E.handNo, 1);
});

test('undo 仍然可用（单机悔棋依赖）', () => {
  const E = fresh();
  const before = E.saveState();
  E.makeMove(9, 4, 8, 4);
  assert.equal(E.undo(), true);
  assert.equal(E.saveState(), before);
  assert.equal(E.undo(), false, '空栈时 undo 返回 false');
});

test('AI 入口仍可用：初级返回合法走法，规则层未被改动', () => {
  const E = fresh();
  const mv = E.chooseAIMove('red', 'easy');
  assert.ok(mv && Number.isInteger(mv.fr) && Number.isInteger(mv.tc), 'AI 应返回走法对象');
  const legal = E.getLegalMoves(mv.fr, mv.fc);
  assert.ok(legal.some(x => x.r === mv.tr && x.c === mv.tc), 'AI 走法必须合法');
});

test('终局：吃掉帅/将即结束并给出赢家与原因', () => {
  const E = fresh();
  // 构造一个"红车贴着黑将"的局面：直接改棋盘再走一步
  const s = JSON.parse(E.saveState());
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) s.board[r][c] = null;
  s.board[0][4] = { color: 'black', type: 'king', faceUp: true };
  s.board[1][4] = { color: 'red', type: 'rook', faceUp: true };
  s.board[9][4] = { color: 'red', type: 'king', faceUp: true };
  s.currentTurn = 'red';
  E.loadState(JSON.stringify(s));
  assert.ok(E.getLegalMoves(1, 4).some(m => m.r === 0 && m.c === 4));
  E.makeMove(1, 4, 0, 4);
  assert.equal(E.gameOver, true);
  assert.equal(E.winner, 'red');
  assert.equal(E.winReason, 'king');
});

// ---------- 暗士九宫限制（本轮新增规则） ----------
function emptyState(E) {
  const s = JSON.parse(E.saveState());
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) s.board[r][c] = null;
  s.capturedRed = []; s.capturedBlack = []; s.moveLog = []; s.handNo = 0;
  s.lastMove = null; s.moveTrail = []; s.historyLength = 0;
  s.gameOver = false; s.winner = null; s.winReason = null;
  return s;
}

test('暗士：未翻开只能在本方九宫内走', () => {
  const E = fresh();
  const s = emptyState(E);
  // 黑方暗士在 (0,3)，隐藏身份故意给红方士（规则只看棋位类型）
  s.board[0][3] = { color: 'red', type: 'advisor', faceUp: false, darkOwner: 'black', startType: 'advisor' };
  s.board[0][4] = { color: 'black', type: 'king', faceUp: true };
  s.board[9][4] = { color: 'red', type: 'king', faceUp: true };
  s.currentTurn = 'black';
  E.loadState(JSON.stringify(s));

  const moves = E.getLegalMoves(0, 3).map(m => m.r + ',' + m.c).sort();
  assert.deepEqual(moves, ['1,4'], '暗士在九宫角只能走九宫内斜线');

  // 红方暗士在 (9,3)，同理只能走 (8,4)
  s.board[0][3] = null;
  s.board[9][3] = { color: 'black', type: 'advisor', faceUp: false, darkOwner: 'red', startType: 'advisor' };
  s.currentTurn = 'red';
  E.loadState(JSON.stringify(s));
  assert.deepEqual(E.getLegalMoves(9, 3).map(m => m.r + ',' + m.c).sort(), ['8,4']);
});

test('暗士：翻开后恢复全盘斜走（不受九宫限制）', () => {
  const E = fresh();
  const s = emptyState(E);
  s.board[0][3] = { color: 'black', type: 'advisor', faceUp: true, darkOwner: 'black' };
  s.board[0][4] = { color: 'black', type: 'king', faceUp: true };
  // 红帅放在第 3 列：避免与黑将同列对望（新规则下"对望"=被将军，走法必须应将）
  s.board[9][3] = { color: 'red', type: 'king', faceUp: true };
  s.currentTurn = 'black';
  E.loadState(JSON.stringify(s));

  const moves = E.getLegalMoves(0, 3).map(m => m.r + ',' + m.c).sort();
  assert.ok(moves.includes('1,2'), '明士可离开九宫，得到：' + moves.join(' '));
  assert.ok(moves.includes('1,4'));
});

test('暗士限制不影响其他暗子（暗车仍可离开九宫区域）', () => {
  const E = fresh();
  const s = emptyState(E);
  s.board[5][0] = { color: 'red', type: 'rook', faceUp: false, darkOwner: 'black', startType: 'rook' };
  // 黑将放在 (2,4)：暗车真实颜色是红，走到第 2 行/第 4 列会让它"翻开即归红方"并将军，
  // 因此那几格被"禁止送将"过滤；其余走法必须原样保留。
  s.board[2][4] = { color: 'black', type: 'king', faceUp: true };
  s.board[9][3] = { color: 'red', type: 'king', faceUp: true };
  s.currentTurn = 'black';
  E.loadState(JSON.stringify(s));

  const moves = E.getLegalMoves(5, 0).map(m => m.r + ',' + m.c);
  assert.ok(moves.includes('0,0'), '暗车应能走到棋盘顶部');
  assert.ok(moves.length > 10, '暗车走法数量不应被九宫限制');
});

test('开局不变量：所有暗士的合法走法都落在本方九宫内', () => {
  const E = fresh();
  let checked = 0;
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = E.board[r][c];
    if (!p || p.faceUp || p.startType !== 'advisor') continue;
    checked++;
    const [rMin, rMax] = p.darkOwner === 'red' ? [7, 9] : [0, 2];
    for (const m of E.getLegalMoves(r, c)) {
      assert.ok(m.r >= rMin && m.r <= rMax && m.c >= 3 && m.c <= 5,
        `暗士 (${r},${c}) 出现九宫外走法 (${m.r},${m.c})`);
    }
  }
  assert.ok(checked > 0, '开局应存在暗士（士位共 8 个）');
});

// ==================== 本轮新增：飞将（隔空吃将）+ 禁止送将 ====================
const K = c => ({ color: c, type: 'king', faceUp: true });
const R = c => ({ color: c, type: 'rook', faceUp: true });
const DARK = (owner, st, color, type) => ({ color: color || owner, type: type || st, faceUp: false, darkOwner: owner, startType: st });

function placeState(E, pieces, turn) {
  const s = emptyState(E);
  pieces.forEach(([r, c, p]) => { s.board[r][c] = p; });
  s.currentTurn = turn || 'red';
  E.loadState(JSON.stringify(s));
  return s;
}
const rc = ms => ms.map(m => m.r + ',' + m.c);

test('飞将：将帅同列且中间无子时，可以直接隔空吃掉对方将帅', () => {
  const E = fresh();
  placeState(E, [[0, 4, K('black')], [9, 4, K('red')]], 'red');
  assert.equal(E.isKingAttacked('red'), true, '对望本身对双方都是威胁');
  assert.equal(E.isKingAttacked('black'), true);

  assert.ok(rc(E.getLegalMoves(9, 4)).includes('0,4'), '红帅应能隔空吃黑将');
  E.makeMove(9, 4, 0, 4);
  assert.equal(E.gameOver, true);
  assert.equal(E.winner, 'red');
  assert.equal(E.winReason, 'king');
});

test('飞将：中间存在任何棋子时不能隔空吃将（棋子可以是我方或对方）', () => {
  const E = fresh();
  placeState(E, [[0, 4, K('black')], [5, 4, R('red')], [9, 4, K('red')]], 'red');
  assert.equal(rc(E.getLegalMoves(9, 4)).includes('0,4'), false, '我方子阻挡时不可飞将');
  assert.equal(E.isKingAttacked('red'), false);

  placeState(E, [[0, 4, K('black')], [6, 4, DARK('black', 'pawn')], [9, 4, K('red')]], 'red');
  assert.equal(rc(E.getLegalMoves(9, 4)).includes('0,4'), false, '暗子阻挡时同样不可飞将');
});

test('禁止送将：走后己方将帅被将军的走法不出现在合法走法里', () => {
  const E = fresh();
  // 黑将 (0,4) 与黑车 (5,4) 同列（被自己的车挡住，不构成飞将）；
  // 黑车直线将军红帅 (9,4)；红车 (8,0) 走到 (5,0) 解不了将，走到 (8,4) 才能垫住
  placeState(E, [[0, 4, K('black')], [5, 4, R('black')], [9, 4, K('red')], [8, 0, R('red')]], 'red');
  assert.equal(E.isKingAttacked('red'), true);
  const moves = rc(E.getLegalMoves(8, 0));
  assert.equal(moves.includes('5,0'), false, '不能走一步无关的棋继续被将军');
  assert.equal(E.isSelfCheckMove(8, 0, 5, 0), true, '应能识别为"送将"');
  assert.ok(moves.length > 0, '红车仍有可以解将的走法（垫到第 4 列）');
  assert.ok(moves.includes('9,4') === false, '帅占的格子不能落子');
});

test('被将军时：能解将的走法依然合法（躲将 / 垫子）', () => {
  const E = fresh();
  placeState(E, [
    [0, 4, K('black')], [5, 4, R('black')], [9, 4, K('red')],
    [7, 2, { color: 'red', type: 'knight', faceUp: true }],
  ], 'red');
  const kingMoves = rc(E.getLegalMoves(9, 4));
  assert.ok(kingMoves.includes('9,3'), '躲到不受攻击的格子应合法');
  assert.equal(kingMoves.includes('8,4'), false, '仍留在黑车线上应被拒');

  const knightMoves = rc(E.getLegalMoves(7, 2));
  assert.ok(knightMoves.includes('8,4'), '垫在黑车与帅之间应合法');
});

test('被将军时：走完仍被将军的走法被拒绝', () => {
  const E = fresh();
  placeState(E, [[0, 4, K('black')], [5, 4, R('black')], [9, 4, K('red')], [7, 2, { color: 'red', type: 'knight', faceUp: true }]], 'red');
  assert.equal(rc(E.getLegalMoves(7, 2)).includes('6,0'), false, '跳到无关位置仍被将军，禁止');
  assert.equal(E.isSelfCheckMove(7, 2, 6, 0), true);
});

test('禁止送将：走子后暴露将帅（车线/飞将）的走法被拒绝', () => {
  const E = fresh();
  // 红车 (8,4) 挡着黑车 (0,4) 对红帅 (9,4) 的直线：横走即暴露
  placeState(E, [[0, 4, R('black')], [8, 4, R('red')], [9, 4, K('red')]], 'red');
  const moves = rc(E.getLegalMoves(8, 4));
  assert.equal(moves.includes('8,0'), false, '横走会让红帅被黑车将军');
  assert.ok(moves.includes('7,4'), '沿同列走仍然挡着，合法');
  assert.equal(E.isSelfCheckMove(8, 4, 8, 0), true);

  // 挡子遮住"将帅对望"：移开挡子同样属于送将
  placeState(E, [[0, 4, K('black')], [5, 4, R('red')], [9, 4, K('red')]], 'red');
  assert.equal(rc(E.getLegalMoves(5, 4)).includes('5,0'), false, '移开挡子会让将帅对望');
  assert.equal(E.isSelfCheckMove(5, 4, 5, 0), true);
});

test('被拒绝的走法不改动棋局状态（试走必须完整还原）', () => {
  const E = fresh();
  placeState(E, [[0, 4, R('black')], [8, 4, R('red')], [9, 4, K('red')]], 'red');
  const before = E.saveState();
  E.getLegalMoves(8, 4);                       // 内部会 probe/unprobe
  assert.equal(E.saveState(), before, '生成走法不得改动棋盘');
  assert.equal(E.isSelfCheckMove(8, 4, 8, 0), true);
  assert.equal(E.saveState(), before, '判定送将不得改动棋盘');
  assert.equal(E.turn, 'red');
  assert.equal(E.handNo, 0);
  assert.equal(E.moveLog.length, 0);
  assert.equal(E.gameOver, false);
});

test('暗子参与判定：按棋位类型计算攻击，不用真实身份也不泄露', () => {
  const E = fresh();
  // 黑方暗"车"（真实类型是兵、真实颜色是红）：攻击仍按 startType=rook 计算。
  // 黑将放 (0,5)，避免和红帅同列产生额外干扰。
  placeState(E, [
    [0, 5, K('black')], [9, 4, K('red')],
    [5, 4, DARK('black', 'rook', 'red', 'pawn')],
  ], 'red');
  assert.equal(E.isKingAttacked('red'), true, '暗车按棋位类型将军');
  assert.equal(rc(E.getLegalMoves(5, 4)).length > 10, true, '暗车走法按 startType，不按真实类型');

  const kingMoves = rc(E.getLegalMoves(9, 4));
  assert.equal(kingMoves.includes('8,4'), false, '留在暗车线上仍被将军，禁止');
  assert.ok(kingMoves.includes('9,3'), '躲开暗车线路应合法');

  // 暗士按九宫限制：黑方暗士在 (2,4)，斜格 (3,3) 已在九宫外，够不到红帅
  placeState(E, [
    [0, 4, K('black')], [3, 3, K('red')],
    [2, 4, DARK('black', 'advisor')],
  ], 'black');
  assert.equal(E.isKingAttacked('red'), false, '未翻开的暗士受九宫限制，不能攻击宫外的帅');
  // 同样位置换成明士：翻开后全盘斜走，就能攻击到 (3,3)
  placeState(E, [
    [0, 4, K('black')], [3, 3, K('red')],
    [2, 4, { color: 'black', type: 'advisor', faceUp: true }],
  ], 'black');
  assert.equal(E.isKingAttacked('red'), true, '翻开后的士可全盘斜走，能攻击到帅');
});

test('禁止送将：走到将帅同横线正好成为对方炮的炮架，也属于非法', () => {
  const E = fresh();
  placeState(E, [
    [0, 3, K('black')],
    [9, 0, { color: 'black', type: 'cannon', faceUp: true }],   // 与红帅同排，中间无子（此时不将军）
    [9, 4, K('red')],
    [5, 2, { color: 'red', type: 'rook', faceUp: true }],
  ], 'red');
  assert.equal(E.isKingAttacked('red'), false, '无炮架时炮不构成将军');
  const moves = rc(E.getLegalMoves(5, 2));
  assert.equal(moves.includes('9,2'), false, '走到 (9,2) 会成为炮架，自己送将');
  assert.equal(E.isSelfCheckMove(5, 2, 9, 2), true);
  // 不走同排则不受影响
  assert.ok(moves.includes('5,5'));
  // 直接吃掉炮是允许的（消除威胁），但红车一回合够不到 (9,0)
  assert.equal(moves.includes('9,0'), false);
});

test('不变量：随机局面中，每个合法走法走完后行棋方都不会被将军', () => {
  const E = fresh();
  for (let i = 0; i < 12 && !E.gameOver; i++) {
    const side = E.turn;
    const all = E.collectMoves(side);
    if (!all.length) break;
    const mv = all[Math.floor(Math.random() * all.length)];
    E.makeMove(mv.fr, mv.fc, mv.tr, mv.tc);
  }
  if (E.gameOver) return;                      // 极少数随机局会提前结束

  const side = E.turn;
  let checkedMoves = 0;
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = E.board[r][c];
    if (!p || E.sideOf(p) !== side) continue;
    for (const m of E.getLegalMoves(r, c)) {
      const rec = E.probeMove(r, c, m.r, m.c);
      const bad = E.isKingAttacked(side);
      E.unprobeMove(rec);
      assert.equal(bad, false, `(${r},${c})→(${m.r},${m.c}) 走完后仍被将军`);
      checkedMoves++;
    }
  }
  assert.ok(checkedMoves > 0, '随机局面应存在合法走法');
});

test('受攻判定：车/炮/马/兵/象各自的攻击几何（含阻挡）', () => {
  const E = fresh();
  const BK = [0, 3, K('black')];

  // 车：同排有子阻挡则不算
  placeState(E, [BK, [9, 4, K('red')], [9, 0, R('black')]], 'red');
  assert.equal(E.isKingAttacked('red'), true, '空线车将军');
  placeState(E, [BK, [9, 4, K('red')], [9, 0, R('black')], [9, 2, { color: 'red', type: 'pawn', faceUp: true }]], 'red');
  assert.equal(E.isKingAttacked('red'), false, '车被挡住不算将军');

  // 炮：必须恰好一个炮架
  placeState(E, [BK, [9, 4, K('red')], [9, 0, { color: 'black', type: 'cannon', faceUp: true }]], 'red');
  assert.equal(E.isKingAttacked('red'), false, '炮无架不将军');
  placeState(E, [BK, [9, 4, K('red')], [9, 0, { color: 'black', type: 'cannon', faceUp: true }], [9, 2, { color: 'red', type: 'pawn', faceUp: true }]], 'red');
  assert.equal(E.isKingAttacked('red'), true, '炮隔一子将军');
  placeState(E, [BK, [9, 4, K('red')], [9, 0, { color: 'black', type: 'cannon', faceUp: true }],
    [9, 1, { color: 'red', type: 'pawn', faceUp: true }], [9, 2, { color: 'red', type: 'pawn', faceUp: true }]], 'red');
  assert.equal(E.isKingAttacked('red'), false, '炮隔两子不将军');

  // 马：蹩马腿
  placeState(E, [BK, [9, 4, K('red')], [7, 3, { color: 'black', type: 'knight', faceUp: true }]], 'red');
  assert.equal(E.isKingAttacked('red'), true, '马攻帅');
  placeState(E, [BK, [9, 4, K('red')], [7, 3, { color: 'black', type: 'knight', faceUp: true }], [8, 3, { color: 'red', type: 'pawn', faceUp: true }]], 'red');
  assert.equal(E.isKingAttacked('red'), false, '蹩马腿后不将军');

  // 兵：正面一步；过河后可横吃
  placeState(E, [BK, [9, 4, K('red')], [8, 4, { color: 'black', type: 'pawn', faceUp: true }]], 'red');
  assert.equal(E.isKingAttacked('red'), true, '黑卒向下攻帅');
  placeState(E, [BK, [8, 3, K('red')], [8, 4, { color: 'black', type: 'pawn', faceUp: true }]], 'red');
  assert.equal(E.isKingAttacked('red'), true, '过河卒横吃');

  // 象：塞象眼
  placeState(E, [BK, [9, 4, K('red')], [7, 2, { color: 'black', type: 'elephant', faceUp: true }]], 'red');
  assert.equal(E.isKingAttacked('red'), true, '象攻帅');
  placeState(E, [BK, [9, 4, K('red')], [7, 2, { color: 'black', type: 'elephant', faceUp: true }], [8, 3, { color: 'red', type: 'pawn', faceUp: true }]], 'red');
  assert.equal(E.isKingAttacked('red'), false, '塞象眼后不将军');
});
