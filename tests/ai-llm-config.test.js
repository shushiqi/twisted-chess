'use strict';
// 用户自定义大模型 API 配置测试（node --test）
// 覆盖：配置优先级（用户 config > .env）、baseUrl/Token/Model 校验、Token 不外泄、
//       无用户配置时兼容 .env、错误分类，以及前端 localStorage 配置读写逻辑。
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const srv = require('../server.js');

const AI_KEYS = ['AI_API_BASE', 'AI_API_TOKEN', 'AI_MODEL', 'AI_STRATEGY'];
const savedEnv = {};
for (const k of AI_KEYS) savedEnv[k] = process.env[k];
after(() => {
  for (const k of AI_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ---------- 服务端：配置解析与校验 ----------
test('normalizeBaseUrl：规范化与非法地址校验', () => {
  assert.equal(srv.normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(srv.normalizeBaseUrl('https://api.example.com/v1'), 'https://api.example.com/v1');
  assert.equal(srv.normalizeBaseUrl('http://api.example.com'), 'http://api.example.com');
  assert.equal(srv.normalizeBaseUrl('ftp://x'), null);
  assert.equal(srv.normalizeBaseUrl('not-a-url'), null);
  assert.equal(srv.normalizeBaseUrl(''), null);
  assert.equal(srv.normalizeBaseUrl('https://user:pass@host/v1'), null);  // 带用户凭据拒绝
});

test('validateAiConfig：必填字段校验', () => {
  assert.equal(srv.validateAiConfig({ baseUrl:'https://a.com/v1', apiToken:'t', model:'m' }), true);
  assert.equal(srv.validateAiConfig({ baseUrl:'https://a.com/v1', apiToken:'', model:'m' }), false);
  assert.equal(srv.validateAiConfig({ baseUrl:'https://a.com/v1', apiToken:'t', model:'' }), false);
  assert.equal(srv.validateAiConfig({ baseUrl:'bad', apiToken:'t', model:'m' }), false);
  assert.equal(srv.validateAiConfig(null), false);
});

test('resolveAiConfig：用户 config 优先于 .env', () => {
  process.env.AI_API_BASE = 'https://env.example.com/v1';
  process.env.AI_API_TOKEN = 'env-token';
  process.env.AI_MODEL = 'env-model';
  const fromUser = srv.resolveAiConfig({ config: { baseUrl:'https://user.example.com/v1', apiToken:'user-token', model:'user-model' } });
  assert.equal(fromUser.source, 'user');
  assert.equal(fromUser.token, 'user-token');
  assert.equal(fromUser.model, 'user-model');
  assert.equal(fromUser.baseUrl, 'https://user.example.com/v1');

  const fromEnv = srv.resolveAiConfig({});
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.token, 'env-token');
  assert.equal(fromEnv.model, 'env-model');

  delete process.env.AI_API_BASE;
  delete process.env.AI_API_TOKEN;
  delete process.env.AI_MODEL;
});

// ---------- 服务端：/api/ai/move 用户配置优先 + Token 不外泄 ----------
function startMock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) {}
      requests.push({ url: req.url, headers: req.headers, body, json: parsed });
      const out = handler(requests.length - 1, parsed, body);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
  });
}

function buildView() {
  const E = srv.loadEngine();
  E.setup();
  const s = JSON.parse(E.saveState());
  const board = s.board.map(row => row.map(p => {
    if (!p) return null;
    if (p.faceUp) return { faceUp: true, color: p.color, type: p.type, darkOwner: p.darkOwner || p.color };
    return { faceUp: false, darkOwner: p.darkOwner, startType: p.startType, startForward: p.startForward };
  }));
  return {
    board, currentTurn: s.currentTurn, gameOver: s.gameOver, winner: s.winner, winReason: s.winReason,
    capturedRed: s.capturedRed, capturedBlack: s.capturedBlack, moveLog: s.moveLog, handNo: s.handNo,
    lastMove: s.lastMove, moveTrail: s.moveTrail,
  };
}

test('/api/ai/move：用户 config 优先，Token 只用于请求不出现在响应', async () => {
  const mock = await startMock(() => ({
    status: 200,
    body: { choices: [{ message: { content: JSON.stringify({ from: { r: 9, c: 4 }, to: { r: 8, c: 4 }, reason: 'x' }) } }] },
  }));
  const addr = await srv.start(0, '127.0.0.1');
  const port = addr.port;
  try {
    // 用户 config 指向 mock，.env 指向别处（确保用的是用户 config）
    process.env.AI_API_BASE = 'https://env-should-not-be-used.example.com/v1';
    process.env.AI_API_TOKEN = 'env-token-should-not-leak';
    process.env.AI_MODEL = 'env-model';

    const r = await fetch(`http://127.0.0.1:${port}/api/ai/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign(buildView(), {
        config: { baseUrl: 'http://127.0.0.1:' + mock.port, apiToken: 'user-token-abc', model: 'user-model' },
      })),
    });
    const j = await r.json();
    assert.equal(j.ok, true, JSON.stringify(j));
    // 请求确实发到用户配置的 mock
    assert.equal(mock.requests.length, 1);
    // 用的是用户 Token，而非 .env Token
    assert.equal(mock.requests[0].headers.authorization, 'Bearer user-token-abc');
    // 响应中不含任何 Token
    const raw = JSON.stringify(j);
    assert.ok(!raw.includes('user-token-abc'), '响应不得含用户 Token');
    assert.ok(!raw.includes('env-token-should-not-leak'), '响应不得含 .env Token');
  } finally {
    await srv.stop();
    mock.server.close();
    delete process.env.AI_API_BASE;
    delete process.env.AI_API_TOKEN;
    delete process.env.AI_MODEL;
  }
});

test('/api/ai/move：无用户配置时兼容 .env', async () => {
  const mock = await startMock(() => ({
    status: 200,
    body: { choices: [{ message: { content: JSON.stringify({ from: { r: 9, c: 4 }, to: { r: 8, c: 4 }, reason: 'x' }) } }] },
  }));
  const addr = await srv.start(0, '127.0.0.1');
  const port = addr.port;
  try {
    process.env.AI_API_BASE = 'http://127.0.0.1:' + mock.port;
    process.env.AI_API_TOKEN = 'env-token-xyz';
    process.env.AI_MODEL = 'env-model';

    const r = await fetch(`http://127.0.0.1:${port}/api/ai/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildView()),   // 不带 config
    });
    const j = await r.json();
    assert.equal(j.ok, true, JSON.stringify(j));
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].headers.authorization, 'Bearer env-token-xyz');
  } finally {
    await srv.stop();
    mock.server.close();
    delete process.env.AI_API_BASE;
    delete process.env.AI_API_TOKEN;
    delete process.env.AI_MODEL;
  }
});

test('/api/ai/move：非法用户配置返回 400 invalid_config', async () => {
  const addr = await srv.start(0, '127.0.0.1');
  const port = addr.port;
  try {
    process.env.AI_API_BASE = 'https://env.example.com/v1';
    process.env.AI_API_TOKEN = 't';
    process.env.AI_MODEL = 'm';
    const r = await fetch(`http://127.0.0.1:${port}/api/ai/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign(buildView(), {
        config: { baseUrl: 'not-a-url', apiToken: 't', model: 'm' },
      })),
    });
    const j = await r.json();
    assert.equal(r.status, 400);
    assert.equal(j.ok, false);
    assert.equal(j.error, 'invalid_config');
    assert.equal(j.category, 'config');
  } finally {
    await srv.stop();
    delete process.env.AI_API_BASE;
    delete process.env.AI_API_TOKEN;
    delete process.env.AI_MODEL;
  }
});

test('/api/ai/move：模型 401 错误分类为 auth', async () => {
  const mock = await startMock(() => ({ status: 401, body: { error: 'unauthorized' } }));
  const addr = await srv.start(0, '127.0.0.1');
  const port = addr.port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ai/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign(buildView(), {
        config: { baseUrl: 'http://127.0.0.1:' + mock.port, apiToken: 'bad-token', model: 'm' },
      })),
    });
    const j = await r.json();
    assert.equal(r.status, 401);
    assert.equal(j.ok, false);
    assert.equal(j.error, 'auth_error');
    assert.equal(j.category, 'auth');
    assert.ok(!JSON.stringify(j).includes('bad-token'), '错误响应不得含 Token');
  } finally {
    await srv.stop();
    mock.server.close();
  }
});

// ---------- 前端：localStorage 配置读写逻辑 ----------
// 从 jieqi.html 内联脚本中提取配置相关函数，用 mock localStorage 验证。
function loadFrontendConfigFns(llmStatusArg) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'jieqi.html'), 'utf8');
  const a = html.indexOf('<script>');
  const b = html.lastIndexOf('</script>');
  const script = html.slice(a + 8, b);
  const start = script.indexOf('let llmConfig = null;');
  const end = script.indexOf('function syncConfigUI()');
  assert.ok(start >= 0 && end > start, '应能在前端脚本中找到配置函数块');
  const snippet = script.slice(start, end);
  const localStorage = {
    _store: {},
    getItem(k) { return this._store[k] !== undefined ? this._store[k] : null; },
    setItem(k, v) { this._store[k] = String(v); },
    removeItem(k) { delete this._store[k]; },
  };
  const fn = new Function('localStorage', 'document', 'llmStatus', snippet +
    '; return { loadLlmConfig, saveLlmConfig, clearLlmConfig, cfgSaved, llmConfigKey, getValidLlmConfig,' +
    ' getLlmConfig(){return llmConfig;}, setLlmConfig(v){llmConfig=v;}, localStorage };');
  const serverStatus = llmStatusArg || { configured: false, model: null, baseUrl: null, error: '' };
  return fn(localStorage, { getElementById: () => null }, serverStatus);
}

test('前端 localStorage：首次无配置返回 null', () => {
  const f = loadFrontendConfigFns();
  assert.equal(f.loadLlmConfig(), null);
  assert.equal(f.cfgSaved(), false);
});

test('前端 localStorage：保存后可读取，且必填校验', () => {
  const f = loadFrontendConfigFns();
  assert.equal(f.saveLlmConfig({ baseUrl:'https://a.com/v1', apiToken:'t', model:'m' }), true);
  const cfg = f.loadLlmConfig();
  assert.equal(cfg.baseUrl, 'https://a.com/v1');
  assert.equal(cfg.apiToken, 't');
  assert.equal(cfg.model, 'm');
  // 缺字段不保存
  assert.equal(f.saveLlmConfig({ baseUrl:'', apiToken:'t', model:'m' }), false);
  assert.equal(f.saveLlmConfig({ baseUrl:'https://a.com', apiToken:'', model:'m' }), false);
  assert.equal(f.saveLlmConfig({ baseUrl:'https://a.com', apiToken:'t', model:'' }), false);
});

test('前端 localStorage：JSON 解析异常降级为无配置', () => {
  const f = loadFrontendConfigFns();
  // 写入非法 JSON，loadLlmConfig 必须走 try/catch 返回 null，而不是抛错或崩溃
  f.localStorage.setItem(f.llmConfigKey(), '{not valid json');
  assert.equal(f.loadLlmConfig(), null);
  // 写入合法 JSON 后可正常读取
  f.saveLlmConfig({ baseUrl:'https://a.com', apiToken:'t', model:'m' });
  const cfg = f.loadLlmConfig();
  assert.equal(cfg.model, 'm');
});

test('前端 localStorage：清除后重新读取为 null', () => {
  const f = loadFrontendConfigFns();
  f.saveLlmConfig({ baseUrl:'https://a.com/v1', apiToken:'t', model:'m' });
  assert.equal(f.loadLlmConfig() !== null, true);
  f.clearLlmConfig();
  assert.equal(f.loadLlmConfig(), null);
});

// ---------- 前端：统一配置检查 getValidLlmConfig ----------
// 覆盖验收场景：无配置 / 非法 JSON / 缺字段 / 完整配置 / 服务端 .env 兜底
test('前端配置检查：无任何配置时判定无效并给出提示', () => {
  const f = loadFrontendConfigFns();   // llmStatus.configured=false，localStorage 为空
  const r = f.getValidLlmConfig();
  assert.equal(r.ok, false);
  assert.equal(r.source, 'none');
  assert.ok(r.reason && r.reason.includes('尚未配置大模型 AI'), '应给出未配置提示');
});

test('前端配置检查：localStorage 非法 JSON 时判定无效', () => {
  const f = loadFrontendConfigFns();
  f.localStorage.setItem(f.llmConfigKey(), '{broken json');
  assert.equal(f.getValidLlmConfig().ok, false);
});

test('前端配置检查：必要字段缺失时判定无效', () => {
  const f = loadFrontendConfigFns();
  // 只有 Base URL，缺 Token/Model
  f.localStorage.setItem(f.llmConfigKey(), JSON.stringify({ baseUrl:'https://a.com/v1' }));
  assert.equal(f.getValidLlmConfig().ok, false);
  // 缺 Model
  f.localStorage.setItem(f.llmConfigKey(), JSON.stringify({ baseUrl:'https://a.com/v1', apiToken:'t' }));
  assert.equal(f.getValidLlmConfig().ok, false);
  // Base URL 非 http/https
  f.localStorage.setItem(f.llmConfigKey(), JSON.stringify({ baseUrl:'not-a-url', apiToken:'t', model:'m' }));
  assert.equal(f.getValidLlmConfig().ok, false);
});

test('前端配置检查：本地配置完整时判定有效（source=local）', () => {
  const f = loadFrontendConfigFns();
  f.saveLlmConfig({ baseUrl:'https://a.com/v1', apiToken:'t', model:'m' });
  f.setLlmConfig({ baseUrl:'https://a.com/v1', apiToken:'t', model:'m' });
  const r = f.getValidLlmConfig();
  assert.equal(r.ok, true);
  assert.equal(r.source, 'local');
  assert.equal(r.config.baseUrl, 'https://a.com/v1');
  assert.equal(r.config.model, 'm');
  // 清除后重新判定无效
  f.clearLlmConfig();
  assert.equal(f.getValidLlmConfig().ok, false);
});

test('前端配置检查：无本地配置但服务端 .env 已配置时判定有效（source=server）', () => {
  const f = loadFrontendConfigFns({ configured:true, model:'env-model', baseUrl:'https://env.example.com/v1' });
  const r = f.getValidLlmConfig();
  assert.equal(r.ok, true);
  assert.equal(r.source, 'server');
  assert.equal(r.config, null);   // 服务端兜底时请求不携带本地 config
});

test('前端配置检查：本地配置优先于服务端 .env', () => {
  const f = loadFrontendConfigFns({ configured:true, model:'env-model', baseUrl:'https://env.example.com/v1' });
  f.saveLlmConfig({ baseUrl:'https://local.example.com/v2', apiToken:'local-t', model:'local-m' });
  f.setLlmConfig({ baseUrl:'https://local.example.com/v2', apiToken:'local-t', model:'local-m' });
  const r = f.getValidLlmConfig();
  assert.equal(r.ok, true);
  assert.equal(r.source, 'local');
  assert.equal(r.config.baseUrl, 'https://local.example.com/v2');
});

// ---------- 服务端：Token 脱敏 ----------
test('sanitizeToken：错误文本中的 Token 被脱敏', () => {
  assert.equal(srv.sanitizeToken('Bearer sk-abcdef123456', 'sk-abcdef123456'), 'Bearer ***');
  assert.equal(srv.sanitizeToken('token=sk-abcdef123456 ok', 'sk-abcdef123456'), 'token=*** ok');
  // 任意 Bearer / sk- 片段也兜底脱敏
  assert.equal(srv.sanitizeToken('Authorization: Bearer xyz-1234567890', ''), 'Authorization: Bearer ***');
  assert.equal(srv.sanitizeToken('key sk-abcdefghijklmnop', ''), 'key ***');
});

// ---------- 服务端：错误分类保留 HTTP 语义 ----------
test('classifyAiError：401/403/404/429 保留分类与状态', () => {
  const e401 = srv.classifyAiError({ error:'ai_move_invalid', category:'auth', msg:'x' }, 401);
  assert.equal(e401.status, 401); assert.equal(e401.category, 'auth'); assert.equal(e401.error, 'auth_error');
  const e403 = srv.classifyAiError({ error:'ai_move_invalid', msg:'x' }, 403);
  assert.equal(e403.status, 403); assert.equal(e403.category, 'forbidden');
  const e404 = srv.classifyAiError({ error:'ai_move_invalid', msg:'x' }, 404);
  assert.equal(e404.status, 404); assert.equal(e404.category, 'route');
  const e429 = srv.classifyAiError({ error:'ai_move_invalid', msg:'x' }, 429);
  assert.equal(e429.status, 429); assert.equal(e429.category, 'rate_limit');
  // invalid_config 分支
  const eCfg = srv.classifyAiError({ error:'invalid_config', msg:'baseUrl 不合法' }, null);
  assert.equal(eCfg.status, 400); assert.equal(eCfg.error, 'invalid_config'); assert.equal(eCfg.category, 'config');
});

// ---------- 服务端：/api/ai/status 不泄露 Token ----------
test('/api/ai/status：响应不含任何 Token', async () => {
  const addr = await srv.start(0, '127.0.0.1');
  const port = addr.port;
  try {
    process.env.AI_API_BASE = 'https://status.example.com/v1';
    process.env.AI_API_TOKEN = 'status-secret-token';
    process.env.AI_MODEL = 'status-model';
    const r = await fetch(`http://127.0.0.1:${port}/api/ai/status`);
    const j = await r.json();
    assert.equal(j.ok, true);
    const raw = JSON.stringify(j);
    assert.ok(!raw.includes('status-secret-token'), 'status 不得返回 Token');
    assert.equal(j.configured, true);
    assert.equal(j.model, 'status-model');
    assert.equal(j.source, 'env');
  } finally {
    await srv.stop();
    delete process.env.AI_API_BASE;
    delete process.env.AI_API_TOKEN;
    delete process.env.AI_MODEL;
  }
});

// ---------- 服务端：模型错误信息不含 Token ----------
test('/api/ai/move：上游错误文本回显 Token 时被脱敏，不外泄', async () => {
  // 模拟上游把请求里的 Token 回显在错误正文中
  const mock = await startMock(() => ({
    status: 401,
    body: { error: 'unauthorized', echo: 'Bearer bad-token-1234567890' },
  }));
  const addr = await srv.start(0, '127.0.0.1');
  const port = addr.port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ai/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign(buildView(), {
        config: { baseUrl: 'http://127.0.0.1:' + mock.port, apiToken: 'bad-token-1234567890', model: 'm' },
      })),
    });
    const j = await r.json();
    const raw = JSON.stringify(j);
    assert.equal(r.status, 401);
    assert.equal(j.error, 'auth_error');
    assert.ok(!raw.includes('bad-token-1234567890'), '错误响应不得含 Token');
  } finally {
    await srv.stop();
    mock.server.close();
  }
});
