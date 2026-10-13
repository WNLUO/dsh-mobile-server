'use strict';

/**
 * 手机 WS 建链瞬间「队列冲刷」的守卫测试（T.wsOpen）。
 *
 * 背景：手机 WS 在 ready 之前发来的上行帧会先排队（entry.queued）。收到宿主回执
 * T.wsOpen 时把这些帧冲进隧道 —— 此前忽略 `sendWsFrame` 的返回值，隧道缓冲压满时它们
 * **静默消失**且 `queuedBytes` 不清零（全链路唯一一处静默丢帧）：手机侧只看到「连接建立
 * 成功但第一条消息没到」，中转日志里一行都没有。
 *
 * 现在的口径：冲不出去就断开这条手机 WS（close 1013，与 bridge-ws 实时路径一致），让客户端
 * 重连重发，而不是留一段看起来正常的假连接；队列无论成败都清零，不能把已丢弃的字节留在
 * `queuedBytes` 里继续占额度。
 *
 * 运行：node test/ws-queue-flush.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { handleTunnelFrame } = require('../lib/tunnel-handler.js');
const { T, createFrameDecoder } = require('../lib/protocol.js');

function fakePhone() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    closed: null,
    sent: [],
    close(code, reason) { this.closed = { code, reason }; },
    send(data, opts) { this.sent.push({ data, opts }); },
  };
}
function fakeInst(tunnelOverrides = {}) {
  return {
    instanceId: 'ws-1',
    pending: new Map(),
    frames: [],
    tunnel: {
      readyState: 1,
      bufferedAmount: 0,
      send(frame) { this.owner.frames.push(Buffer.from(frame)); },
      ...tunnelOverrides,
    },
  };
}
function entryWith(phone, queued) {
  return { kind: 'ws', phone, ready: false, queued, queuedBytes: queued.reduce((n, q) => n + q.data.length, 0) };
}
function decodeAll(buffers) {
  const out = [];
  const push = createFrameDecoder((f) => out.push(f));
  for (const b of buffers) push(b);
  return out;
}
const q = (text, isBinary = false) => ({ data: Buffer.from(text), isBinary });

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = original; }
  return lines;
}

test('T.wsOpen：隧道写不进去 → 记日志、清队列、断开这条手机 WS（不静默丢帧）', () => {
  const phone = fakePhone();
  const inst = fakeInst();
  inst.tunnel.owner = inst;
  inst.tunnel.bufferedAmount = 17 * 1024 * 1024; // 超过 MAX_TUNNEL_BUFFERED_BYTES
  const entry = entryWith(phone, [q('hello'), q('world')]);
  inst.pending.set(7, entry);

  const lines = captureLog(() => {
    handleTunnelFrame(inst, { type: T.wsOpen, id: 7, payload: Buffer.alloc(0) });
  });

  assert.equal(inst.frames.length, 0, '隧道压满时一帧都不该发出去');
  assert.equal(inst.pending.has(7), false, '条目要清掉，不能挂着假连接');
  assert.deepEqual(phone.closed, { code: 1013, reason: 'relay buffer limit exceeded' }, '必须断开这条手机 WS');
  assert.deepEqual(entry.queued, [], '队列必须清零');
  assert.equal(entry.queuedBytes, 0, 'queuedBytes 必须清零（已丢弃的字节不能继续占额度）');
  assert.ok(lines.some((l) => l.includes('ws open queue flush failed')), '必须记日志');
});

test('T.wsOpen：正常冲刷按原顺序送出，队列清零且不断连接', () => {
  const phone = fakePhone();
  const inst = fakeInst();
  inst.tunnel.owner = inst;
  const entry = entryWith(phone, [q('first'), q('second', true)]);
  inst.pending.set(11, entry);

  handleTunnelFrame(inst, { type: T.wsOpen, id: 11, payload: Buffer.alloc(0) });

  const frames = decodeAll(inst.frames);
  assert.equal(frames.length, 2, '排队的帧必须都送达');
  assert.deepEqual(frames.map((f) => f.type), [T.wsText, T.wsBinary]);
  assert.deepEqual(frames.map((f) => f.payload.toString()), ['first', 'second']);
  assert.deepEqual(frames.map((f) => f.id), [11, 11]);
  assert.equal(entry.ready, true);
  assert.deepEqual(entry.queued, []);
  assert.equal(entry.queuedBytes, 0);
  assert.equal(phone.closed, null, '正常路径不得断开手机 WS');
  assert.equal(inst.pending.get(11), entry, '条目仍归这条连接所有');
});

test('T.wsOpen：冲到一半失败 → 已送出的不重复、队列清零、断开连接', () => {
  const phone = fakePhone();
  let sends = 0;
  const inst = fakeInst({
    send(frame) {
      sends += 1;
      if (sends === 2) throw new Error('socket write failed');
      this.owner.frames.push(Buffer.from(frame));
    },
  });
  inst.tunnel.owner = inst;
  const entry = entryWith(phone, [q('a'), q('b'), q('c')]);
  inst.pending.set(13, entry);

  const lines = captureLog(() => {
    handleTunnelFrame(inst, { type: T.wsOpen, id: 13, payload: Buffer.alloc(0) });
  });

  const frames = decodeAll(inst.frames);
  assert.equal(frames.length, 1, '失败点之后的帧不再尝试（连接马上要断）');
  assert.equal(frames[0].payload.toString(), 'a');
  assert.deepEqual(entry.queued, []);
  assert.equal(entry.queuedBytes, 0);
  assert.deepEqual(phone.closed, { code: 1013, reason: 'relay buffer limit exceeded' });
  assert.equal(inst.pending.has(13), false);
  assert.ok(lines.some((l) => l.includes('ws open queue flush failed')));
});

test('T.wsOpen 幂等：重复回执不得重放队列', () => {
  const phone = fakePhone();
  const inst = fakeInst();
  inst.tunnel.owner = inst;
  const entry = entryWith(phone, [q('once')]);
  inst.pending.set(17, entry);

  handleTunnelFrame(inst, { type: T.wsOpen, id: 17, payload: Buffer.alloc(0) });
  handleTunnelFrame(inst, { type: T.wsOpen, id: 17, payload: Buffer.alloc(0) });
  assert.equal(decodeAll(inst.frames).length, 1);
});

test('源码契约：冲刷必须检查返回值并清零 queuedBytes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tunnel-handler.js'), 'utf8');
  assert.match(src, /if \(!sendWsFrame\(inst, id, q\)\) \{ delivered = false; break; \}/);
  assert.match(src, /entry\.queuedBytes = 0;/);
  assert.match(src, /ws open queue flush failed/);
});
