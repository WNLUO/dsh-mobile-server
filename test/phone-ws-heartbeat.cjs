'use strict';

/**
 * 手机 WS 保活（pong 超时）守卫测试。
 *
 * 背景：中转只定期向手机 ping，从不判定 pong。对端消失或 NAT 超时后这条连接会一直停在
 * OPEN（半开）：它永久占着 pending 名额（MAX_PENDING_PER_INSTANCE=128）与
 * MAX_WS_CONNECTIONS，手机重连还会继续被拒 —— 手机侧表现为「一直连不上/连上没反应」。
 * 现在照隧道心跳的形状补上超时：超时就 terminate **这一条**手机 WS（close 处理器会清
 * pending 并向上游发 wsClose），隧道本身不动；pong 或任何上行帧都算活性。
 *
 * 运行：node test/phone-ws-heartbeat.cjs
 */

// 必须在 require config/bridge-ws 之前设好：配置在 require 时读环境变量。
process.env.WS_HEARTBEAT_MS = '20';
process.env.WS_PONG_TIMEOUT_MS = '50';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { handlePhoneWs } = require('../lib/bridge-ws.js');
const { T, createFrameDecoder } = require('../lib/protocol.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function fakePhone() {
  const handlers = new Map();
  return {
    readyState: 1,
    pingCount: 0,
    terminated: false,
    closed: null,
    on(event, cb) { handlers.set(event, cb); return this; },
    emit(event, ...args) { const cb = handlers.get(event); if (cb) cb(...args); },
    ping() { this.pingCount += 1; },
    terminate() { this.terminated = true; this.emit('close', 1006, 'terminated'); },
    close(code, reason) { this.closed = { code, reason }; this.emit('close', code, reason); },
    send() {},
  };
}
function fakeInst(instanceId = 'pong-1') {
  return {
    instanceId,
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
function openPhoneWs(inst) {
  const phone = fakePhone();
  inst.tunnel.owner = inst;
  handlePhoneWs(phone, { url: '/api/mobile/v1/ws', headers: { 'x-dsh-instance': inst.instanceId } }, inst);
  return phone;
}
const wsCloseFrames = (inst) => {
  const out = [];
  const push = createFrameDecoder((f) => out.push(f));
  for (const b of inst.frames) push(b);
  return out.filter((f) => f.type === T.wsClose);
};

test('半开连接：既没 pong 也没上行帧 → terminate 并释放名额', async () => {
  const inst = fakeInst();
  const phone = openPhoneWs(inst);
  assert.equal(inst.pending.size, 1, '建链后应占一个 pending 名额');

  await delay(220);

  assert.ok(phone.pingCount > 0, '保活 ping 必须照常发（不能因为加了超时就停止 ping）');
  assert.equal(phone.terminated, true, '超过 WS_PONG_TIMEOUT_MS 没活性必须 terminate');
  assert.equal(inst.pending.size, 0, 'close 处理器必须清掉 pending 名额');
  assert.equal(wsCloseFrames(inst).length, 1, '必须通知上游关闭对应的 WS');
});

test('pong 正常：连接不被误杀', async () => {
  const inst = fakeInst('pong-2');
  const phone = openPhoneWs(inst);
  const keep = setInterval(() => phone.emit('pong'), 10);
  await delay(220);
  clearInterval(keep);

  assert.equal(phone.terminated, false, '有 pong 就不该被当成半开');
  assert.equal(inst.pending.size, 1, '条目必须还在');
  phone.emit('close', 1000, 'test cleanup');
  assert.equal(inst.pending.size, 0);
});

test('安静但有上行帧的连接不被误杀', async () => {
  const inst = fakeInst('pong-3');
  const phone = openPhoneWs(inst);
  const keep = setInterval(() => phone.emit('message', Buffer.from('x'), false), 10);
  await delay(220);
  clearInterval(keep);

  assert.equal(phone.terminated, false, '上行帧也算活性（避免误杀「安静但健康」的连接）');
  phone.emit('close', 1000, 'test cleanup');
});

test('源码契约：保活必须带 pong 判定与超时 terminate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'bridge-ws.js'), 'utf8');
  assert.match(src, /ws\.on\('pong'/);
  assert.match(src, /Date\.now\(\) - lastPong > WS_PONG_TIMEOUT_MS/);
  assert.match(src, /ws\.terminate\(\)/);
  assert.match(src, /phone ws heartbeat timeout/);
});
