'use strict';

/**
 * 冒烟：协议编解码 + 中转自己那点 HTTP 面。
 *
 * 自建版是纯转发，自己认领的路径只有 `/healthz` 与 `/api/mobile/v1/health`（地址体检），
 * 其余全部交给隧道；没有隧道时如实回 503。业务语义、鉴权、缓存都不在这里。
 *
 * 运行：node test/smoke.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { T, TYPE_NAME, encodeFrame, createFrameDecoder, parseJson, encodeClosePayload, decodeClosePayload } = require('../lib/protocol.js');
const { start, stop } = require('../server.js');

// ── 协议 ────────────────────────────────────────────────────────────
test('帧类型编号是线上契约，不得漂移', () => {
  assert.equal(T.httpRequest, 0x04);
  assert.equal(T.httpBody, 0x05);
  assert.equal(T.httpHead, 0x06);
  assert.equal(T.httpChunk, 0x07);
  assert.equal(T.httpEnd, 0x08);
  assert.equal(T.wsUpgrade, 0x0a);
  assert.equal(T.wsOpen, 0x0b);
  assert.equal(T.ping, 0x10);
  assert.equal(T.pong, 0x11);
  assert.equal(TYPE_NAME[0x04], 'httpRequest');
});

test('编解码：头 9 字节 + 原样 payload', () => {
  const frame = encodeFrame(T.httpChunk, 259, Buffer.from('你好'));
  assert.equal(frame.readUInt8(0), T.httpChunk);
  assert.equal(frame.readUInt32BE(1), 259);
  assert.equal(frame.readUInt32BE(5), 6);
  const seen = [];
  createFrameDecoder((f) => seen.push(f))(frame);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 259);
  assert.equal(seen[0].payload.toString('utf8'), '你好');
});

test('解码器能吃下半个帧与粘在一起的多个帧', () => {
  const a = encodeFrame(T.httpHead, 1, JSON.stringify({ status: 200 }));
  const b = encodeFrame(T.httpEnd, 1, Buffer.alloc(0));
  const both = Buffer.concat([a, b]);
  const seen = [];
  const push = createFrameDecoder((f) => seen.push(f));
  push(both.subarray(0, 5));   // 半个头
  assert.equal(seen.length, 0);
  push(both.subarray(5));      // 剩下的（半个 a + 完整的 b）
  assert.equal(seen.length, 2);
  assert.deepEqual(parseJson(seen[0].payload), { status: 200 });
  assert.equal(seen[1].type, T.httpEnd);
});

test('超长帧交给 onError，不吞不崩', () => {
  const seen = [];
  const errors = [];
  const push = createFrameDecoder((f) => seen.push(f), { maxFrameBytes: 8, onError: (e) => errors.push(e) });
  push(encodeFrame(T.httpChunk, 1, Buffer.alloc(16)));
  assert.equal(seen.length, 0);
  assert.equal(errors.length, 1);
});

test('wsClose 的 code 编解码：保留值不得出现在线上', () => {
  const ok = decodeClosePayload(encodeClosePayload(1000, '正常'));
  assert.equal(ok.code, 1000);
  assert.equal(ok.reason, '正常');
  // 编码端会把非法 code 归一到 1000，所以「解码端拒绝保留值」要手搓原始 payload 才测得到。
  const bad = decodeClosePayload(Buffer.from([0x03, 0xee])); // 1006 是保留值，不得上线
  assert.equal(bad.raw, 1006);
  assert.equal(bad.validCode, false);
  assert.equal(bad.code, 1000, '非法 code 必须退回 1000，否则 ws.close 会抛');
  const long = decodeClosePayload(encodeClosePayload(1000, '汉'.repeat(200)));
  assert.ok(Buffer.byteLength(long.reason, 'utf8') <= 123);
  assert.match('汉'.repeat(200), new RegExp(`^${long.reason}`), '截断只能砍尾巴，不能切出半个码点');
});

// ── HTTP 面 ─────────────────────────────────────────────────────────
function request(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('中转自己认领的路径与「没有隧道」的答复', async (t) => {
  const relay = await start({ host: '127.0.0.1', port: 0 });
  t.after(() => stop());

  assert.deepEqual(await request(relay.port, '/healthz'), { status: 200, body: 'ok' });

  const probe = await request(relay.port, '/api/mobile/v1/health');
  assert.equal(probe.status, 200);
  const parsed = JSON.parse(probe.body);
  assert.equal(parsed.service, 'dsh-mobile-relay');
  assert.equal(typeof parsed.version, 'string');
  assert.equal(Object.keys(parsed).sort().join(','), 'ok,service,version', '地址体检不得泄露别的东西');

  assert.equal((await request(relay.port, '/api/mobile/v1/health', 'POST')).status, 405);

  // 没有隧道就如实说，别让手机等到超时
  const noTunnel = await request(relay.port, '/api/mobile/v1/sessions');
  assert.equal(noTunnel.status, 503);
  assert.equal(JSON.parse(noTunnel.body).ok, false);
});

test('额外模块先于转发接管请求', async (t) => {
  const seen = [];
  const module = {
    handle: (req, res, url) => {
      if (!url.pathname.startsWith('/extra')) return false;
      seen.push(url.pathname);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('from-module');
      return true;
    },
    close: async () => { seen.push('closed'); },
  };
  const relay = await start({ host: '127.0.0.1', port: 0, modules: [module] });
  assert.equal((await request(relay.port, '/extra/thing')).body, 'from-module');
  assert.deepEqual(seen, ['/extra/thing']);
  await stop();
  assert.deepEqual(seen, ['/extra/thing', 'closed'], '关停时要关掉挂上来的模块');
});
