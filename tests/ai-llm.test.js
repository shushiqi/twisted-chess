'use strict';
// 大模型 AI 对弈测试（node --test）
// 覆盖：脱敏（暗子真实身份不外泄）、未配置拦截、合法走法采纳、
//       非法走法/非法 JSON 的有限重试、重试后修正、HTTP 接口连通。
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const srv = require('../server.js');

const AI_KEYS = ['AI_API_BASE', 'AI_API_TOKEN', 'AI_MODEL', 'AI_TIMEOUT_MS', 'AI_MAX_ATTEMPTS'];
const savedEnv = {};
for (const k of AI_KEYS) savedEnv[k] = process.env[k];

function setAIEnv(obj) { for (const k of AI_KEYS) if (k in obj) process.env[k] = obj[k]; }
function clearAIEnv() { for (const k of AI_KEYS) delete process.env[k]; }

after(() => {
  for (const k of AI_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// 启动一个 OpenAI 兼容的 mock 模型服务，记录每次请求
function startMockModel(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) {}
      requests.push({ url: req.url, headers: req.headers, body, json: parsed });
      const out = handler(requests.length - 1, parsed, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
  });
}

function completion(content) {
  return { choices: [{ message: { content } }] };
}

// 构造一个固定局面：红帅、黑将、一枚红方暗车（真实身份 rook，但只能显示为「红?」）
function makeBoard() {
  const board = Array.from({ length: 10 }, () => Array(9).fill(null));
  board[9][4] = { color: 'red', type: 'king', faceUp: true };
  board[0][3] = { color: 'black', type: 'king', faceUp: true };
  board[5][0] = { color: 'red', type: 'rook', faceUp: false, darkOwner: 'red', startType: 'rook' };
  return board;
}

// 与前端 buildAIView 同口径的脱敏视图
function buildView(board, turn) {
  return {
    board: board.map(row => row.map(p => {
      if (!p) return null;
      if (p.faceUp) return { faceUp: true, color: p.color, type: p.type, darkOwner: p.darkOwner || p.color };
      return { faceUp: false, darkOwner: p.darkOwner, startType: p.startType, startForward: p.startForward };
    })),
    currentTurn: turn, gameOver: false, winner: null, winReason: null,
    capturedRed: [], capturedBlack: [], moveLog: [], handNo: 0, lastMove: null, moveTrail: [],
  };
}

// 用独立引擎算出当前局面的合法走法（与服务端同一套规则）
function legalFromView(view) {
  const E = srv.loadEngine();
  E.loadState(JSON.stringify(view));
  return E.collectMoves(E.turn);
}

test('sanitizeBoardForAI：未翻开棋子不保留真实 color/type', () => {
  const dark = { color: 'red', type: 'rook', faceUp: false, darkOwner: 'black', startType: 'pawn', startForward: 1 };
  const out = srv.sanitizeBoardForAI([[dark]])[0][0];
  assert.equal(out.faceUp, false);
  assert.equal(out.darkOwner, 'black');
  assert.equal(out.startType, 'pawn');
  assert.equal(out.startForward, 1);
  assert.equal(out.color, undefined, '暗子不得保留真实 color');
  assert.equal(out.type, undefined, '暗子不得保留真实 type');

  const light = { color: 'red', type: 'rook', faceUp: true };
  const out2 = srv.sanitizeBoardForAI([[light]])[0][0];
  assert.equal(out2.faceUp, true);
  assert.equal(out2.color, 'red');
  assert.equal(out2.type, 'rook');
});

test('aiMoveFromView：未配置时返回 ai_not_configured', async () => {
  clearAIEnv();
  const r = await srv.aiMoveFromView({ board: [[null]], currentTurn: 'red' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ai_not_configured');
});

test('aiMoveFromView：模型返回合法走法 → 采纳，且提示不泄露暗子身份', async () => {
  const view = buildView(makeBoard(), 'red');
  const legal = legalFromView(view);
  assert.ok(legal.length > 0, '红方应有合法走法');
  const mv = legal[0];

  const mock = await startMockModel(() => completion(JSON.stringify({
    from: { r: mv.fr, c: mv.fc }, to: { r: mv.tr, c: mv.tc }, reason: '试探',
  })));
  try {
    setAIEnv({ AI_API_BASE: 'http://127.0.0.1:' + mock.port, AI_API_TOKEN: 'test-token', AI_MODEL: 'test-model', AI_MAX_ATTEMPTS: '3' });
    const r = await srv.aiMoveFromView(view);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.from, { r: mv.fr, c: mv.fc });
    assert.deepEqual(r.to, { r: mv.tr, c: mv.tc });
    assert.equal(r.reason, '试探');

    const body = mock.requests[0].body;
    // 暗子真实身份不得在「棋盘表示」中泄漏；知识库内容可合理出现通用棋子名「车」，
    // 因此只检查棋盘段落（棋盘使用 红?/黑? 归属标记，不出现真实身份）。
    const req = JSON.parse(body);
    const userMsg = req.messages.find(m => m.role === 'user').content;
    const boardSection = userMsg.split('合法走法列表')[0];
    assert.ok(!boardSection.includes('车'), '棋盘表示中不得出现暗子真实身份「车」');
    assert.ok(boardSection.includes('红?'), '暗子应以归属标记「红?」出现');
    assert.ok(!body.includes('test-token'), 'Token 不得出现在请求体');
  } finally {
    mock.server.close();
    clearAIEnv();
  }
});

test('aiMoveFromView：模型返回非法走法 → 有限重试后失败', async () => {
  const view = buildView(makeBoard(), 'red');
  const mock = await startMockModel(() => completion(JSON.stringify({ from: { r: 0, c: 0 }, to: { r: 0, c: 0 }, reason: 'x' })));
  try {
    setAIEnv({ AI_API_BASE: 'http://127.0.0.1:' + mock.port, AI_API_TOKEN: 't', AI_MODEL: 'm', AI_MAX_ATTEMPTS: '2' });
    const r = await srv.aiMoveFromView(view);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ai_move_invalid');
    assert.equal(mock.requests.length, 2, '应重试到上限');
  } finally {
    mock.server.close();
    clearAIEnv();
  }
});

test('aiMoveFromView：模型返回非 JSON → 有限重试后失败', async () => {
  const view = buildView(makeBoard(), 'red');
  const mock = await startMockModel(() => completion('这不是 JSON'));
  try {
    setAIEnv({ AI_API_BASE: 'http://127.0.0.1:' + mock.port, AI_API_TOKEN: 't', AI_MODEL: 'm', AI_MAX_ATTEMPTS: '2' });
    const r = await srv.aiMoveFromView(view);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ai_move_invalid');
    assert.equal(mock.requests.length, 2, '应重试到上限');
  } finally {
    mock.server.close();
    clearAIEnv();
  }
});

test('aiMoveFromView：首次非法、重试后合法 → 采纳', async () => {
  const view = buildView(makeBoard(), 'red');
  const legal = legalFromView(view);
  const mv = legal[0];
  let n = 0;
  const mock = await startMockModel(() => {
    n++;
    const content = n === 1
      ? JSON.stringify({ from: { r: 0, c: 0 }, to: { r: 0, c: 0 } })
      : JSON.stringify({ from: { r: mv.fr, c: mv.fc }, to: { r: mv.tr, c: mv.tc }, reason: '修正' });
    return completion(content);
  });
  try {
    setAIEnv({ AI_API_BASE: 'http://127.0.0.1:' + mock.port, AI_API_TOKEN: 't', AI_MODEL: 'm', AI_MAX_ATTEMPTS: '3' });
    const r = await srv.aiMoveFromView(view);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(mock.requests.length, 2, '第一次非法后重试一次即成功');
  } finally {
    mock.server.close();
    clearAIEnv();
  }
});

test('HTTP：/api/ai/status 与 /api/ai/move 可用', async () => {
  const view = buildView(makeBoard(), 'red');
  const legal = legalFromView(view);
  const mv = legal[0];
  const mock = await startMockModel(() => completion(JSON.stringify({
    from: { r: mv.fr, c: mv.fc }, to: { r: mv.tr, c: mv.tc }, reason: '接口测试',
  })));
  const addr = await srv.start(0, '127.0.0.1');
  const port = addr.port;
  try {
    setAIEnv({ AI_API_BASE: 'http://127.0.0.1:' + mock.port, AI_API_TOKEN: 't', AI_MODEL: 'm', AI_MAX_ATTEMPTS: '2' });

    const s = await (await fetch(`http://127.0.0.1:${port}/api/ai/status`)).json();
    assert.equal(s.ok, true);
    assert.equal(typeof s.configured, 'boolean');
    assert.equal(s.model, 'm');

    const r = await fetch(`http://127.0.0.1:${port}/api/ai/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(view),
    });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.ok, true);
    assert.deepEqual(j.from, { r: mv.fr, c: mv.fc });
    assert.deepEqual(j.to, { r: mv.tr, c: mv.tc });
  } finally {
    await srv.stop();
    mock.server.close();
    clearAIEnv();
  }
});
