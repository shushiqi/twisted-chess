'use strict';
// 持久化配置门禁测试（独立进程，因为 process.env 在模块加载后被读取）
// 目的：配置了 CLOUDBASE_ENV_ID 但缺少凭据时，绝不能静默降级成纯内存房间。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

// 保证初始为"未配置持久化"状态
delete process.env.CLOUDBASE_ENV_ID;
delete process.env.CLOUDBASE_APIKEY;
delete process.env.TENCENTCLOUD_SECRETID;
delete process.env.TENCENTCLOUD_SECRETKEY;

const srv = require('../server.js');

let port;

before(async () => {
  const addr = await srv.start(0, '127.0.0.1');
  port = addr.port;
});

after(async () => { await srv.stop(); });

function wsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs = [];
    ws.on('message', raw => { try { msgs.push(JSON.parse(raw.toString())); } catch (e) {} });
    ws.once('open', () => resolve({
      ws, msgs,
      send: o => ws.send(JSON.stringify(o)),
      next(pred, ms = 3000) {
        const hit = msgs.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const t0 = Date.now();
          const timer = setInterval(() => {
            const m = msgs.find(pred);
            if (m) { clearInterval(timer); res(m); }
            else if (Date.now() - t0 > ms) { clearInterval(timer); rej(new Error('等待消息超时')); }
          }, 30);
        });
      },
      close: () => { try { ws.close(); } catch (e) {} },
    }));
    ws.once('error', reject);
  });
}

test('C1) 未配置 CLOUDBASE_ENV_ID：内存模式可用，healthz 如实上报 disabled', async () => {
  const r = await srv.initPersistence();
  assert.equal(r.state, 'disabled');
  assert.deepEqual(srv.storageInfo(), { mode: 'memory', state: 'disabled', ttlMs: srv.storageInfo().ttlMs });

  const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(h.persistence.mode, 'memory');
  assert.equal(h.persistence.state, 'disabled');

  const created = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST' });
  assert.equal(created.status, 200, '未启用持久化时应允许建房（本地/测试）');
  const { roomId } = await created.json();
  assert.ok(roomId);
  srv.rooms.clear();
});

test('C2) 配置了 ENV_ID 但缺凭据：建房返回 503，不静默降级为内存房', async () => {
  process.env.CLOUDBASE_ENV_ID = 'env-without-credentials';
  const r = await srv.initPersistence();
  assert.equal(r.state, 'error');
  assert.equal(srv.storageInfo().mode, 'memory');
  assert.equal(srv.storageInfo().state, 'error');

  const created = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST' });
  assert.equal(created.status, 503, '缺少凭据时绝不能返回建房成功');
  assert.equal((await created.json()).error, 'storage_unavailable');
  assert.equal(srv.rooms.size, 0, '失败时不得留下内存房间');

  const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(h.ok, true, '/healthz 仍应 200，避免平台重启循环');
  assert.equal(h.persistence.state, 'error');
});

test('C3) 存储配置失败时加入房间返回 storage_error（而不是"房间不存在"）', async () => {
  const c = await wsClient();
  c.send({ t: 'join', room: 'ABC123' });
  const m = await c.next(x => x.t === 'error');
  assert.equal(m.code, 'storage_error');
  c.close();
});

test('C4) 存储恢复后门禁解除（模拟清理任务自愈）', async () => {
  // 注入一个可用的内存仓库，等价于配置修好后重启/自愈
  const { createMemoryRepo } = require('../roomRepository.js');
  const repo = createMemoryRepo();
  const r = await srv.initPersistence({ repo });
  assert.equal(r.state, 'ok');
  const created = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST' });
  assert.equal(created.status, 200);
  const { roomId } = await created.json();
  assert.ok(repo.dump().some(d => d._id === roomId), '建房必须落库');
  srv.rooms.clear();
});
