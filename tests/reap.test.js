'use strict';
// 空闲房间回收条件测试（node --test）
// shouldReapRoom(room, now) 是纯函数：只读 room.seats / room.specs / room.updatedAt，
// 因此这里直接构造对象断言，**不依赖真实定时器、也不改 ROOM_TTL_MS**。
// 防的事故：只看玩家位（playerCount）会把「两名玩家都掉线、但还有在线观战者」的房间
// 从内存 Map 里删掉 —— 观战者的 ws.room 指向孤儿对象，界面冻结、点入座进幽灵房间。
const { test } = require('node:test');
const assert = require('node:assert');
const srv = require('../server.js');

const TTL_MS = 30 * 60 * 1000;      // 与 server.js 的 ROOM_TTL_MS 一致
const MIN_MS = 60 * 1000;

/** 造一个成员对象（回收判定只关心 connected） */
function makeMember(connected) {
  return { connected, ws: connected ? { id: 'ws' } : null };
}

/** 造一个最小 room 对象：只含回收判定需要的字段 */
function makeRoom(opts) {
  const o = opts || {};
  return {
    seats: { red: o.red || null, black: o.black || null },
    specs: o.specs || [],
    updatedAt: o.updatedAt,
  };
}

test('shouldReapRoom 已导出（回收逻辑必须可被测试直接验证）', () => {
  assert.equal(typeof srv.shouldReapRoom, 'function', 'server.js 应导出 shouldReapRoom(room, now)');
});

test('两玩家掉线 + 在线观战者 + 超时：不回收（核心修复点）', () => {
  const now = Date.now();
  const room = makeRoom({
    red: makeMember(false),
    black: makeMember(false),
    specs: [makeMember(true)],
    updatedAt: now - 31 * MIN_MS,
  });
  assert.equal(srv.shouldReapRoom(room, now), false,
    '还有在线观战者时回收房间会把观战者的 ws.room 变成孤儿（界面冻结、入座进幽灵房间）');
});

test('两玩家掉线 + 观战者也掉线 + 超时：回收', () => {
  const now = Date.now();
  const room = makeRoom({
    red: makeMember(false),
    black: makeMember(false),
    specs: [makeMember(false)],
    updatedAt: now - 31 * MIN_MS,
  });
  assert.equal(srv.shouldReapRoom(room, now), true,
    '全员离线且静默超过 TTL，应回收（文档仍在数据库，重进房间时按需恢复）');
});

test('无观战者 + 两玩家掉线 + 超时：回收（保持旧行为，防回归）', () => {
  const now = Date.now();
  const room = makeRoom({
    red: makeMember(false),
    black: makeMember(false),
    specs: [],
    updatedAt: now - TTL_MS - MIN_MS,
  });
  assert.equal(srv.shouldReapRoom(room, now), true, '旧行为（只看玩家位）在这个场景下也回收，不能被改坏');
});

test('两玩家都在线 + 超时：不回收', () => {
  const now = Date.now();
  const room = makeRoom({
    red: makeMember(true),
    black: makeMember(true),
    specs: [],
    updatedAt: now - 31 * MIN_MS,
  });
  assert.equal(srv.shouldReapRoom(room, now), false, '有在线玩家时永远不回收');
});

test('全员离线但仅静默 10 分钟：不回收（未到 TTL）', () => {
  const now = Date.now();
  const room = makeRoom({
    red: makeMember(false),
    black: makeMember(false),
    specs: [makeMember(false)],
    updatedAt: now - 10 * MIN_MS,
  });
  assert.equal(srv.shouldReapRoom(room, now), false, '未到 TTL 时保留房间，让掉线玩家有机会重连');
});
