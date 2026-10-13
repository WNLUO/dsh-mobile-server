'use strict';

/**
 * 回源刷新必须带设备凭据的守卫测试。
 *
 * 背景：`backgroundRefresh` 用的是请求入口那份 `proxyOptions`，而它此前只放了
 * `authorization: Bearer <hostToken>`（见 server.js 构造 proxyOptions 处）。宿主侧
 * `lib/mobile/auth.js` 的判定是：**出示了本机签发的设备凭据 → 以凭据的吊销状态为准**
 * （不回退 Bearer）；只带 Bearer 时走的是另一条路（verifyMobileToken）。于是后台刷新
 * 等于「用一个不再代表那台设备的身份回源」：被吊销的设备仍然让中转持续为它做工，宿主也无从
 * 发现设备已死。
 *
 * 这个用例把真实 server.js 跑起来，用一个记录请求头的假上游：先 `?fresh=1` 走 live 代理，
 * 再让镜像过期走 stale 读触发 backgroundRefresh，断言**每一次**回源请求都带着
 * `x-dsh-device-credential`（把实现改回旧写法时，后台刷新那条会缺这个头 → 红）。
 *
 * 运行：node test/background-refresh-credential.cjs
 */

process.env.PORT = String(process.env.BG_REFRESH_PORT || 18722);
process.env.HOST = '127.0.0.1';
process.env.RELAY_SECRET = 'bg-refresh-secret-0123456789';
process.env.RELAY_CACHE_TTL_MS = '300'; // 让镜像很快过期，触发后台刷新

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bg-refresh-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(tmp, 'relay-device-credentials.json');
process.env.MIRROR_DATA_DIR = path.join(tmp, 'mirror-data');

require('ws');
const { server } = require('../server.js');
const { instances } = require('../lib/registry.js');
const { T } = require('../lib/protocol.js');
const { RelayTunnel } = require('./fake-desktop.js');

const PORT = Number(process.env.PORT);
const RELAY_HTTP = `http://127.0.0.1:${PORT}`;
const INSTANCE = 'bgcred01';
const PAIRING_CODE = '424242';
const HOST_TOKEN = `test-token-${INSTANCE}`;
const UPSTREAM_HEADER = 'x-dsh-device-credential';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await delay(25);
  }
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name} — ${err.message}`);
  }
}

/** 记录每次回源请求的 URL 与请求头。 */
const upstreamRequests = [];
const upstream = http.createServer((req, res) => {
  upstreamRequests.push({ url: req.url, headers: req.headers });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, items: [{ id: `live-${upstreamRequests.length}` }], lastSeq: 1 }));
});

const mobileHeaders = (credential) => ({
  'x-dsh-instance': INSTANCE,
  authorization: `Bearer ${HOST_TOKEN}`,
  'x-dsh-device-credential': credential,
});

async function main() {
  fs.mkdirSync(process.env.MIRROR_DATA_DIR, { recursive: true });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upBase = `http://127.0.0.1:${upstream.address().port}`;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`relay on ${RELAY_HTTP}, upstream on ${upBase}\n`);

  const tunnel = new RelayTunnel({
    relayUrl: `ws://127.0.0.1:${PORT}`,
    instanceId: INSTANCE,
    pairingCode: PAIRING_CODE,
    name: 'bg-refresh',
    upstream: upBase,
  });
  await tunnel.start();

  let credential = '';
  await test('配对拿到设备凭据', async () => {
    const r = await fetch(`${RELAY_HTTP}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: INSTANCE, code: PAIRING_CODE, device: { name: 'Phone-BG' } }),
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    credential = j.deviceCredential;
    assert.ok(credential && credential.startsWith('dshc_'));
  });

  await test('live 回源（?fresh=1）带设备凭据', async () => {
    const r = await fetch(`${RELAY_HTTP}/api/mobile/v1/sessions?fresh=1`, { headers: mobileHeaders(credential) });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    await waitFor('live 回源到达上游', () => upstreamRequests.length >= 1);
    assert.strictEqual(upstreamRequests[0].headers[UPSTREAM_HEADER], credential);
  });

  await test('镜像过期后的 stale 读触发后台刷新，回源同样带设备凭据', async () => {
    // 桌面推一份镜像，让它过期（RELAY_CACHE_TTL_MS=300）。
    tunnel.sendJson(T.sync, 0, {
      sessions: { ok: true, items: [{ id: 'mirror-item' }] },
      workspaces: { ok: true, items: [] },
    });
    await waitFor('镜像落地', () => {
      const inst = instances.get(INSTANCE);
      return inst && inst.mirror && inst.mirror.sessions && inst.mirror.sessions.items[0].id === 'mirror-item';
    });
    await delay(400);

    const before = upstreamRequests.length;
    const r = await fetch(`${RELAY_HTTP}/api/mobile/v1/sessions`, { headers: mobileHeaders(credential) });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.items[0].id, 'mirror-item', '过期镜像仍然先回给手机（serve-stale）');
    assert.strictEqual(j.stale, true, '前提：这次读被判定为 stale，才会触发后台刷新');

    await waitFor('后台刷新回源', () => upstreamRequests.length > before);
    const refreshReq = upstreamRequests[upstreamRequests.length - 1];
    assert.strictEqual(
      refreshReq.headers[UPSTREAM_HEADER],
      credential,
      '后台刷新必须带设备凭据：否则宿主无法按吊销状态判定，会继续为已吊销设备做工',
    );
    assert.strictEqual(refreshReq.headers.authorization, `Bearer ${HOST_TOKEN}`, '原有的 hostToken 仍要带上');
  });

  await test('每一次回源请求都带设备凭据，且确实发生了不止一次', async () => {
    assert.ok(upstreamRequests.length >= 2, `至少应有 live + 后台刷新两次回源，实际 ${upstreamRequests.length}`);
    const missing = upstreamRequests.filter((req) => req.headers[UPSTREAM_HEADER] !== credential);
    assert.deepStrictEqual(missing.map((r) => r.url), [], '存在没带设备凭据的回源请求');
  });

  tunnel.stop();
  server.close();
  upstream.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
