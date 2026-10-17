'use strict';

/**
 * 隧道背压：两个方向各自的口径。
 *
 * 响应方向（宿主 → 手机）一直有背压：手机读得慢就发 `httpPause` 请宿主停
 * （见 lib/tunnel-handler.js）。请求方向（手机 → 宿主）以前没有：body 把隧道发往宿主的
 * 队列灌到 16MB 硬门槛时，这个请求直接被掐成 502 —— 用户看到的是「传了一半失败」，而
 * 宿主那边其实只是读得慢，重传一遍结局相同。
 *
 * 现在的口径：
 *   - 到高水位就**停读**手机的请求流（协议上不需要任何新帧，宿主只是暂时收不到
 *     httpBody），回落到低水位再放行；
 *   - 硬门槛仍然在，但它退居兜底：正常路径下应该永远走不到；
 *   - 取消 / 暂停 / 恢复 / 关闭这四个小控制帧不受积压门槛管 —— 积压恰恰是最需要它们的
 *     时候（取消送不出去宿主会继续灌，关闭送不出去宿主本机的上游连接永远等不到收尾）。
 *
 * 运行：node test/tunnel-backpressure.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { proxyRequest, sendTunnelFrame } = require('../lib/proxy-http.js');
const { T } = require('../lib/protocol.js');

const MAX = 16 * 1024 * 1024;
const HIGH_WATER = MAX / 2;
const LOW_WATER = MAX / 4;
const POLL_MS = 25;

/** 定时器替身：proxyRequest 会挂 header 超时与回落轮询，真的等下去测试进程会一直活着。 */
function fakeTimers() {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const timers = [];
  const make = (fn, ms) => { const handle = { fn, ms, cleared: false }; timers.push(handle); return handle; };
  global.setTimeout = make;
  global.setInterval = make;
  global.clearTimeout = (handle) => { if (handle) handle.cleared = true; };
  global.clearInterval = (handle) => { if (handle) handle.cleared = true; };
  return {
    intervals: () => timers.filter((t) => t.ms === POLL_MS),
    restore() {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    },
  };
}

function fakeRes() {
  return {
    headersSent: false,
    destroyed: false,
    status: null,
    body: null,
    ended: false,
    handlers: {},
    writeHead(status) { this.status = status; this.headersSent = true; },
    write() { return true; },
    end(chunk) { if (chunk !== undefined) this.body = String(chunk); this.ended = true; },
    on(event, cb) { (this.handlers[event] = this.handlers[event] || []).push(cb); return this; },
    emit(event, ...args) { for (const cb of this.handlers[event] || []) cb(...args); },
    destroy() { this.destroyed = true; },
  };
}

function fakeReq(overrides = {}) {
  const handlers = {};
  return {
    method: 'POST',
    url: '/api/mobile/v1/upload/chunk',
    headers: { 'content-type': 'application/octet-stream' },
    complete: false,
    pauses: 0,
    resumes: 0,
    destroyed: false,
    on(event, cb) { (handlers[event] = handlers[event] || []).push(cb); return this; },
    pause() { this.pauses += 1; },
    resume() { this.resumes += 1; },
    destroy() { this.destroyed = true; },
    emit(event, ...args) { for (const cb of handlers[event] || []) cb(...args); },
    ...overrides,
  };
}

function fakeTunnel(bufferedAmount = 0) {
  return {
    pending: new Map(),
    nextId: 0,
    ws: {
      readyState: 1,
      bufferedAmount,
      sent: [],
      send(frame) { this.sent.push(Buffer.from(frame)); },
    },
  };
}

/** 起一条上传请求，返回它的帧 id。 */
function startUpload(tunnel, req, res) {
  proxyRequest(tunnel, req, res, {});
  return [...tunnel.pending.keys()][0];
}

test('数据帧积压到上限时被挡下，隧道本身不动', () => {
  const tunnel = fakeTunnel(MAX + 1);
  assert.equal(sendTunnelFrame(tunnel, T.httpBody, 7, Buffer.from('x')), false);
  assert.equal(sendTunnelFrame(tunnel, T.httpRequest, 8, '{}'), false, '新请求也该快速失败，而不是排进堵死的队列');
  assert.equal(tunnel.ws.sent.length, 0);
});

test('控制帧不受积压门槛管：取消 / 暂停 / 恢复 / 关闭照发', () => {
  const tunnel = fakeTunnel(MAX + 1);
  assert.equal(sendTunnelFrame(tunnel, T.httpCancel, 7, Buffer.alloc(0)), true);
  assert.equal(sendTunnelFrame(tunnel, T.httpPause, 7, Buffer.alloc(0)), true);
  assert.equal(sendTunnelFrame(tunnel, T.httpResume, 7, Buffer.alloc(0)), true);
  assert.equal(sendTunnelFrame(tunnel, T.wsClose, 7, Buffer.from([0x03, 0xe8])), true);
  assert.equal(tunnel.ws.sent.length, 4, '积压正是最需要这些帧的时候');
});

test('隧道不通时控制帧同样不发', () => {
  const tunnel = fakeTunnel(0);
  tunnel.ws.readyState = 3;
  assert.equal(sendTunnelFrame(tunnel, T.httpCancel, 7, Buffer.alloc(0)), false);
  assert.equal(tunnel.ws.sent.length, 0);
});

test('手机上行的 body 把隧道压过高水位：停读这个请求', () => {
  const timers = fakeTimers();
  try {
    const tunnel = fakeTunnel(0);
    const req = fakeReq();
    const res = fakeRes();
    startUpload(tunnel, req, res);
    assert.equal(req.pauses, 0, '前置：还没积压就不该停读');

    tunnel.ws.bufferedAmount = HIGH_WATER + 1;
    req.emit('data', Buffer.alloc(1024));

    assert.equal(req.pauses, 1, '过线必须停读手机上行');
    assert.equal(timers.intervals().length, 1, '同时挂上回落轮询');
    assert.equal(timers.intervals()[0].ms, POLL_MS);
  } finally { timers.restore(); }
});

test('回落到低水位才恢复读，并撤掉轮询', () => {
  const timers = fakeTimers();
  try {
    const tunnel = fakeTunnel(HIGH_WATER + 1);
    const req = fakeReq();
    startUpload(tunnel, req, fakeRes());
    req.emit('data', Buffer.alloc(1024));

    const poll = timers.intervals()[0];
    assert.ok(poll, '前置：已经停读');
    poll.fn();
    assert.equal(req.resumes, 0, '还压着就不能放行');
    assert.equal(poll.cleared, false, '没回落就继续等下一轮');

    tunnel.ws.bufferedAmount = LOW_WATER;
    poll.fn();
    assert.equal(req.resumes, 1, '回落到低水位必须放行');
    assert.equal(poll.cleared, true, '放行后轮询要撤掉');
  } finally { timers.restore(); }
});

test('没到高水位就不停读', () => {
  const timers = fakeTimers();
  try {
    const tunnel = fakeTunnel(HIGH_WATER);
    const req = fakeReq();
    startUpload(tunnel, req, fakeRes());
    req.emit('data', Buffer.alloc(1024));
    assert.equal(req.pauses, 0);
    assert.equal(timers.intervals().length, 0);
  } finally { timers.restore(); }
});

test('已收完的报文即使积压过线也不停读', () => {
  const timers = fakeTimers();
  try {
    const tunnel = fakeTunnel(0);
    const req = fakeReq({ complete: true });
    startUpload(tunnel, req, fakeRes());
    tunnel.ws.bufferedAmount = HIGH_WATER + 1;
    req.emit('data', Buffer.alloc(1024));
    // 报文已经收完，剩下的字节都在本地缓冲里：停读只会把 body 结束帧一起推迟，
    // 宿主那边表现为「请求发了却一直没结束」。
    assert.equal(req.pauses, 0);
    assert.equal(timers.intervals().length, 0);
  } finally { timers.restore(); }
});

test('请求取消时撤掉回落轮询', () => {
  const timers = fakeTimers();
  try {
    const tunnel = fakeTunnel(HIGH_WATER + 1);
    const req = fakeReq();
    const res = fakeRes();
    startUpload(tunnel, req, res);
    req.emit('data', Buffer.alloc(1024));

    const poll = timers.intervals()[0];
    assert.equal(poll.cleared, false);
    res.emit('close');
    assert.equal(poll.cleared, true, '请求没了就不该再有轮询在跑');
    assert.equal(tunnel.pending.size, 0);
  } finally { timers.restore(); }
});

test('硬门槛仍然兜底：body 帧被挡时这个请求以 502 收场', () => {
  const timers = fakeTimers();
  try {
    const tunnel = fakeTunnel(0);
    const req = fakeReq();
    const res = fakeRes();
    startUpload(tunnel, req, res);
    tunnel.ws.bufferedAmount = MAX + 1;
    req.emit('data', Buffer.alloc(1024));

    assert.equal(res.status, 502, '压死时必须给手机一个明确的失败，而不是挂着');
    assert.equal(res.ended, true);
    assert.equal(tunnel.pending.size, 0);
    assert.equal(req.destroyed, true);
  } finally { timers.restore(); }
});
