'use strict';

/**
 * SSE 请求的「上游 header 阶段」超时守卫测试。
 *
 * 背景：宿主收到 httpRequest 后一直不回 httpHead（桌面端卡死/隧道半死）时，SSE 条目会永久挂在
 * pending 里：`res` 永不结束、不发 httpCancel、手机侧那条 EventSource 一直「连接中」。
 * 此前只有非 SSE 请求装了 headerTimer，SSE 是唯一没有 header 阶段超时的通路 —— 而 SSE 恰恰是
 * 实时同步最常用的那条（post-head 的 30s 空闲哨兵 armSseIdle 只在 httpHead 之后才武装，
 * 覆盖不到 header 阶段）。
 *
 * 现在的口径：SSE 与非 SSE 都在同一个 UPSTREAM_HEADER_TIMEOUT_MS 上超时（该超时量的是「桌面端
 * 多久回 httpHead」，与响应是否长连接无关）；httpHead 到达时清掉它、交接给 armSseIdle。
 *
 * 运行：node test/sse-header-timeout.cjs
 */

// 必须在 require config/proxy-http 之前设好，且刻意与 SSE_IDLE_TIMEOUT_MS(30s) 区分开，
// 这样「哪条定时器还活着」在断言里不会有歧义。
process.env.UPSTREAM_HEADER_TIMEOUT_MS = '40000';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { proxyRequest } = require('../lib/proxy-http.js');
const { handleTunnelFrame } = require('../lib/tunnel-handler.js');
const { T, createFrameDecoder } = require('../lib/protocol.js');
const { UPSTREAM_HEADER_TIMEOUT_MS } = require('../lib/config.js');

const SSE_IDLE_TIMEOUT_MS = 30_000; // lib/proxy-http.js:18

function fakeTimers() {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (fn, ms) => {
    const handle = { fn, ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => { if (handle) handle.cleared = true; };
  return {
    all: () => timers,
    live: (ms) => timers.filter((t) => t.ms === ms && !t.cleared),
    fire(handle) { handle.cleared = true; handle.fn(); },
    restore() { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; },
  };
}
function fakeRes() {
  return {
    headersSent: false,
    destroyed: false,
    status: null,
    headers: null,
    chunks: [],
    ended: false,
    handlers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    write(chunk) { this.chunks.push(chunk); return true; },
    end(chunk) { if (chunk !== undefined) this.chunks.push(chunk); this.ended = true; },
    on(event, cb) { (this.handlers[event] = this.handlers[event] || []).push(cb); return this; },
    emit(event, ...args) { for (const cb of this.handlers[event] || []) cb(...args); },
    destroy() { this.destroyed = true; },
  };
}
function fakeReq(accept) {
  return {
    method: 'GET',
    url: '/api/mobile/v1/session/messages?sessionId=s1',
    headers: { 'x-dsh-instance': 'sse-1', accept },
    on() { return this; },
  };
}
function fakeInst() {
  return {
    instanceId: 'sse-1',
    pending: new Map(),
    frames: [],
    tunnel: {
      readyState: 1,
      bufferedAmount: 0,
      owner: null,
      send(frame) { this.owner.frames.push(Buffer.from(frame)); },
    },
  };
}
function decodeAll(buffers) {
  const out = [];
  const push = createFrameDecoder((f) => out.push(f));
  for (const b of buffers) push(b);
  return out;
}
function startSse() {
  const inst = fakeInst();
  inst.tunnel.owner = inst;
  const res = fakeRes();
  proxyRequest(inst, fakeReq('text/event-stream'), res, {});
  return { inst, res, id: [...inst.pending.keys()][0] };
}

test('SSE 请求也武装 header 超时；超时后 504 + 清 pending + httpCancel', () => {
  const timers = fakeTimers();
  try {
    const { inst, res } = startSse();
    assert.equal(inst.pending.size, 1, '请求应挂在 pending 上');
    const armed = timers.live(UPSTREAM_HEADER_TIMEOUT_MS);
    assert.equal(armed.length, 1, 'SSE 必须和非 SSE 一样武装 header 超时');
    assert.equal(decodeAll(inst.frames)[0].type, T.httpRequest, '前置：httpRequest 已发出');

    timers.fire(armed[0]);

    assert.equal(res.status, 504, '超时必须给手机一个明确的失败响应，而不是永远挂着');
    assert.equal(res.ended, true);
    assert.equal(inst.pending.size, 0, '条目必须清掉');
    assert.ok(
      decodeAll(inst.frames).some((f) => f.type === T.httpCancel),
      '必须通知上游取消，否则宿主那边会一直留着一个没人读的请求',
    );
  } finally { timers.restore(); }
});

test('非 SSE 请求的 header 超时行为不变（回归）', () => {
  const timers = fakeTimers();
  try {
    const inst = fakeInst();
    inst.tunnel.owner = inst;
    const res = fakeRes();
    proxyRequest(inst, fakeReq('application/json'), res, {});
    const armed = timers.live(UPSTREAM_HEADER_TIMEOUT_MS);
    assert.equal(armed.length, 1);
    timers.fire(armed[0]);
    assert.equal(res.status, 504);
    assert.equal(inst.pending.size, 0);
  } finally { timers.restore(); }
});

test('httpHead 到达：清掉 header 超时、交接给 SSE 空闲哨兵', () => {
  const timers = fakeTimers();
  try {
    const { inst, res, id } = startSse();
    const headerTimer = timers.live(UPSTREAM_HEADER_TIMEOUT_MS)[0];

    handleTunnelFrame(inst, {
      type: T.httpHead,
      id,
      payload: Buffer.from(JSON.stringify({ status: 200, headers: { 'content-type': 'text/event-stream' } })),
    });

    assert.equal(res.status, 200, '上游 header 应原样透传');
    assert.equal(headerTimer.cleared, true, 'header 到了就不能再被 header 超时打断');
    const idle = timers.live(SSE_IDLE_TIMEOUT_MS);
    assert.equal(idle.length, 1, 'post-head 必须武装 30s 空闲哨兵');
    assert.equal(inst.pending.size, 1, '长连接条目必须留着');

    timers.fire(idle[0]);
    assert.equal(res.ended, true, '空闲超时要收尾这条 SSE');
    assert.equal(inst.pending.size, 0);
  } finally { timers.restore(); }
});

test('header 超时之后迟到的 httpHead 不再写响应（条目已不在）', () => {
  const timers = fakeTimers();
  try {
    const { inst, res, id } = startSse();
    timers.fire(timers.live(UPSTREAM_HEADER_TIMEOUT_MS)[0]);
    assert.equal(res.status, 504);

    handleTunnelFrame(inst, {
      type: T.httpHead,
      id,
      payload: Buffer.from(JSON.stringify({ status: 200, headers: {} })),
    });
    assert.equal(res.status, 504, '已超时收尾的条目不能被迟到的 header 重新激活');
    assert.equal(res.headersSent, true);
  } finally { timers.restore(); }
});

test('源码契约：headerTimer 不再被 isSse 排除', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'proxy-http.js'), 'utf8');
  assert.match(src, /entry\.headerTimer = setTimeout\(/);
  assert.doesNotMatch(
    src,
    /if \(!isSse\) \{\s*\n\s*entry\.headerTimer = setTimeout\(/,
    'header 超时不能再只给非 SSE 装',
  );
});
