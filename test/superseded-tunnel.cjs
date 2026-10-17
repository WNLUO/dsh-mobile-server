'use strict';

/**
 * 单隧道语义：新连接直接取代旧的，旧隧道上没结束的请求一次性失败。
 *
 * 自建版没有实例注册，也就没有「顶点认证」那一层 —— 取代是无条件的。但**取代之后
 * 必须做两件事**，否则会留下两类幽灵：
 *   - 旧隧道对象上挂着没结束的 HTTP/SSE/WS 条目 → 客户端永远等不到结束（SSE 实测挂 600s）；
 *   - 旧连接关断时把 `current` 清掉 → 新连接明明在，却变成「没有宿主」。
 *
 * 运行：node test/superseded-tunnel.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { createTunnel, getTunnel, setTunnel, clearTunnel } = require('../lib/tunnel.js');
const { failAllPending } = require('../lib/tunnel-handler.js');

function fakeWs() {
  return { readyState: 1, bufferedAmount: 0, sent: [], send(frame) { this.sent.push(frame); } };
}
function fakeRes() {
  return {
    headersSent: false, destroyed: false, status: null, ended: false,
    writeHead(status) { this.status = status; this.headersSent = true; },
    end() { this.ended = true; },
    destroy() { this.destroyed = true; },
  };
}

test('装上第二条隧道会把第一条顶掉，且不动新连接', () => {
  const first = createTunnel(fakeWs());
  assert.equal(setTunnel(first), null, '第一条没有前驱');
  assert.equal(getTunnel(), first);

  const second = createTunnel(fakeWs());
  assert.equal(setTunnel(second), first, '第二条要把第一条交回来，便于失败它在途请求');
  assert.equal(getTunnel(), second);

  // 被取代的旧连接随后断开：不能把新隧道一起清掉
  assert.equal(clearTunnel(first), false);
  assert.equal(getTunnel(), second, '旧连接关断不得清掉新隧道');
  assert.equal(clearTunnel(second), true);
  assert.equal(getTunnel(), null);
});

test('failAllPending：HTTP 回 502、WS 关 1011、条目清空、定时器停掉', () => {
  const tunnel = createTunnel(fakeWs());
  const res = fakeRes();
  const closed = [];
  const phone = { readyState: WebSocket.OPEN, close(code, reason) { closed.push({ code, reason }); }, terminate() { closed.push({ code: 'terminate' }); } };
  let cleared = 0;
  tunnel.pending.set(1, { kind: 'http', res, headerTimer: setTimeout(() => {}, 60_000), idleTimer: setTimeout(() => {}, 60_000) });
  tunnel.pending.set(2, { kind: 'ws', phone, pingTimer: setInterval(() => {}, 60_000) });
  const realClearTimeout = global.clearTimeout;
  global.clearTimeout = (h) => { cleared += 1; return realClearTimeout(h); };

  try {
    failAllPending(tunnel, 'replaced');
  } finally {
    global.clearTimeout = realClearTimeout;
  }

  assert.equal(res.status, 502);
  assert.equal(res.ended, true);
  assert.equal(cleared, 2, 'HTTP 条目的两条超时都要停掉');
  assert.deepEqual(closed, [{ code: 1011, reason: 'replaced' }]);
  assert.equal(tunnel.pending.size, 0);
});

test('failAllPending：已经关掉的手机 WS 不得再被 close 一次', () => {
  const tunnel = createTunnel(fakeWs());
  let closedCount = 0;
  tunnel.pending.set(1, { kind: 'ws', phone: { readyState: WebSocket.CLOSED, close() { closedCount += 1; } } });
  failAllPending(tunnel, 'bye');
  assert.equal(closedCount, 0);
  assert.equal(tunnel.pending.size, 0);
});
