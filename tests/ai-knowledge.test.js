'use strict';
// 揭棋 AI 本地知识体系测试（node --test）
// 覆盖：知识文件读取、Core 加载、按棋局特征动态加载 Skill、默认棋风、System Prompt 组合、
//       以及原有 AI 请求格式 / 合法走法校验 / thinking 配置未被破坏。
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const srv = require('../server.js');
const aiKnowledge = require('../aiKnowledge.js');

const AI_KEYS = ['AI_API_BASE', 'AI_API_TOKEN', 'AI_MODEL', 'AI_STRATEGY'];
const savedEnv = {};
for (const k of AI_KEYS) savedEnv[k] = process.env[k];
after(() => {
  for (const k of AI_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const K = c => ({ color: c, type: 'king', faceUp: true });
const R = c => ({ color: c, type: 'rook', faceUp: true });
const P = c => ({ color: c, type: 'pawn', faceUp: true });

function fresh() { const E = srv.loadEngine(); E.setup(); return E; }

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

// ---------- 1. 知识文件读取 ----------
test('知识文件能正常读取（index 与各模块内容齐全）', () => {
  const k = aiKnowledge.loadAll();
  assert.equal(k.index.core.length, 3);
  assert.equal(k.index.skills.length, 7);
  assert.equal(k.index.strategies.length, 3);
  assert.ok(k.core.role && k.core.rules && k.core['decision-principles']);
  assert.ok(k.skills.opening && k.skills.attack && k.skills.defense &&
    k.skills['hidden-pieces'] && k.skills['piece-value'] && k.skills['positional-play'] && k.skills.endgame);
  assert.ok(k.strategies.aggressive && k.strategies.defensive && k.strategies.balanced);
});

// ---------- 2. Core 加载 ----------
test('Core 能正确加载到 System Prompt', () => {
  const p = aiKnowledge.buildSystemPrompt('balanced');
  assert.ok(p.includes('角色与任务'));
  assert.ok(p.includes('揭棋规则'));
  assert.ok(p.includes('决策原则'));
  assert.ok(p.includes('棋风策略：均衡'));
});

// ---------- 3. 默认 Strategy ----------
test('默认 Strategy 为 balanced，且可指定/回退', () => {
  assert.equal(aiKnowledge.resolveStrategyName({}), 'balanced');
  assert.equal(aiKnowledge.resolveStrategyName(null), 'balanced');
  assert.equal(aiKnowledge.resolveStrategyName({ strategy: 'aggressive' }), 'aggressive');
  assert.equal(aiKnowledge.resolveStrategyName({ strategy: 'nonexistent' }), 'balanced');
});

// ---------- 4. 不同棋局特征加载对应 Skill ----------
test('开局阶段（handNo 小）加载 opening，不误触发 endgame/positional-play', () => {
  const E = fresh();
  E.setup();                      // 完整开局棋盘（32 子）
  const st = aiKnowledge.computeState(E, { handNo: 5 });
  const skills = aiKnowledge.selectSkills(st).map(s => s.id);
  assert.ok(skills.includes('opening'));
  assert.ok(skills.includes('hidden-pieces'));   // 存在暗子
  assert.ok(!skills.includes('endgame'));          // 32 子，非残局
  assert.ok(!skills.includes('positional-play'));  // handNo 5 < 11
});

test('被将军时加载 defense', () => {
  const E = fresh();
  // 红帅 [9][4]，黑车 [4][4] 同列无子 → 红方被将军
  place(E, [[9, 4, K('red')], [4, 4, R('black')]], 'red');
  const st = aiKnowledge.computeState(E, { handNo: 20 });
  assert.equal(st.inCheck, true);
  const skills = aiKnowledge.selectSkills(st).map(s => s.id);
  assert.ok(skills.includes('defense'));
});

test('存在吃子机会时加载 attack 与 piece-value', () => {
  const E = fresh();
  // 红车 [4][0]，黑卒 [4][4] 同排无子 → 红车可吃卒
  place(E, [[9, 4, K('red')], [0, 4, K('black')], [4, 0, R('red')], [4, 4, P('black')]], 'red');
  const st = aiKnowledge.computeState(E, { handNo: 20 });
  assert.equal(st.hasCapture, true);
  const skills = aiKnowledge.selectSkills(st).map(s => s.id);
  assert.ok(skills.includes('attack'));
  assert.ok(skills.includes('piece-value'));
});

test('剩余棋子少时加载 endgame', () => {
  const E = fresh();
  place(E, [[9, 4, K('red')], [0, 4, K('black')], [5, 0, R('red')]], 'red');  // 3 子
  const st = aiKnowledge.computeState(E, { handNo: 30 });
  assert.ok(st.remainingPieces <= 8);
  const skills = aiKnowledge.selectSkills(st).map(s => s.id);
  assert.ok(skills.includes('endgame'));
});

test('手数较多时加载 positional-play，不加载 opening', () => {
  const E = fresh();
  E.setup();
  const st = aiKnowledge.computeState(E, { handNo: 20 });
  const skills = aiKnowledge.selectSkills(st).map(s => s.id);
  assert.ok(skills.includes('positional-play'));
  assert.ok(!skills.includes('opening'));
});

// ---------- 5. System Prompt 组合 ----------
test('System Prompt 组合包含 Core + Strategy + 命中 Skills', () => {
  const E = fresh();
  E.setup();
  const res = aiKnowledge.buildSystemPromptForState(E, { handNo: 5 }, 'balanced');
  assert.ok(res.prompt.includes('角色与任务'));
  assert.ok(res.prompt.includes('揭棋规则'));
  assert.ok(res.prompt.includes('决策原则'));
  assert.ok(res.prompt.includes('棋风策略：均衡'));
  assert.ok(res.prompt.includes('开局策略'));     // opening skill
  assert.ok(res.prompt.includes('暗子策略'));     // hidden-pieces skill
});

// ---------- 6. 集成：原有 AI 请求格式 / 校验 / thinking 未被破坏 ----------
test('集成：/api/ai/move 仍正常，System Prompt 含知识，thinking 仍 disabled', async () => {
  let captured = null;
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ from: { r: 9, c: 4 }, to: { r: 8, c: 4 }, reason: 'x' }) } }] }));
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;

  process.env.AI_API_BASE = 'http://127.0.0.1:' + mockPort;
  process.env.AI_API_TOKEN = 't';
  process.env.AI_MODEL = 'm';

  const addr = await srv.start(0, '127.0.0.1');
  const port = addr.port;
  try {
    const E = srv.loadEngine();
    E.setup();
    const s = JSON.parse(E.saveState());
    const board = s.board.map(row => row.map(p => {
      if (!p) return null;
      if (p.faceUp) return { faceUp: true, color: p.color, type: p.type, darkOwner: p.darkOwner || p.color };
      return { faceUp: false, darkOwner: p.darkOwner, startType: p.startType, startForward: p.startForward };
    }));
    const view = {
      board, currentTurn: s.currentTurn, gameOver: s.gameOver, winner: s.winner, winReason: s.winReason,
      capturedRed: s.capturedRed, capturedBlack: s.capturedBlack, moveLog: s.moveLog, handNo: s.handNo,
      lastMove: s.lastMove, moveTrail: s.moveTrail,
    };

    const r = await fetch(`http://127.0.0.1:${port}/api/ai/move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(view),
    });
    const j = await r.json();
    assert.equal(j.ok, true, JSON.stringify(j));
    assert.deepEqual(j.from, { r: 9, c: 4 });
    assert.deepEqual(j.to, { r: 8, c: 4 });

    // System Prompt 含知识内容
    const sysMsg = captured.messages.find(m => m.role === 'system');
    assert.ok(sysMsg, '应包含 system 消息');
    assert.ok(sysMsg.content.includes('决策原则'), 'System Prompt 应包含决策原则');
    assert.ok(sysMsg.content.includes('棋风策略：均衡'), 'System Prompt 应包含默认均衡策略');

    // thinking disabled 保持不变
    assert.deepEqual(captured.thinking, { type: 'disabled' });
    // 不传 temperature
    assert.equal(captured.temperature, undefined);
  } finally {
    await srv.stop();
    mock.close();
    for (const k of AI_KEYS) delete process.env[k];
  }
});

// ---------- 7. 热重载接口 ----------
test('热重载接口 /api/ai/knowledge/reload 可用', async () => {
  const addr = await srv.start(0, '127.0.0.1');
  const port = addr.port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ai/knowledge/reload`, { method: 'POST' });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.equal(j.core, 3);
    assert.equal(j.skills, 7);
    assert.equal(j.strategies, 3);
  } finally {
    await srv.stop();
  }
});
