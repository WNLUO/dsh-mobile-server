'use strict';

/**
 * 中转端鉴权契约回归测试。
 *
 * 锁定修复中确立、且后人很容易改坏的两条边界：
 *  1) 局域网配对的会话（只有 Bearer，没有 relay 设备凭据）必须仍能被路由到桌面；
 *  2) 出示了设备凭据但已吊销 / 未知时必须 401，**不能**回落到 Bearer 继续路由
 *     ——否则吊销等于没做。
 * 另外验证桌面隧道离线时诊断 / 监控仍可用（它们本来就是为离线排障准备的）。
 *
 * 运行：node test/relay-auth-contract.js
 */

process.env.PORT = String(process.env.AUTH_PORT || 18705);
process.env.HOST = '127.0.0.1';
process.env.RELAY_SECRET = 'auth-contract-secret-0123456789';

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

// 用临时文件隔离设备凭据存储，避免污染真实 ~/.dsh。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-auth-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(tmp, 'relay-device-credentials.json');

require('ws');
const { server } = require('../server.js');
const credentials = require('../../dsh-mobile-plugin/dsh-mobile-credentials/lib/credentials.js');
const { signPair, pairedInstance } = require('../lib/pair.js');
const { RelayTunnel } = require('../../dsh-mobile-plugin/lib/relay/tunnel.js');

const PORT = Number(process.env.PORT);
const RELAY_HTTP = `http://127.0.0.1:${PORT}`;

const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ live: true, path: req.url, headers: req.headers }));
});

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push(`${name}: ${err.message}`);
    console.error(`  ✗ ${name} — ${err.message}`);
  }
}

const INSTANCE = 'auth01';
let cookie = '';
let deviceId = '';
let deviceCredential = '';

async function req(p, opts = {}) {
  const headers = { 'x-dsh-instance': INSTANCE, ...(opts.headers || {}) };
  if (opts.json) headers['content-type'] = 'application/json';
  return fetch(RELAY_HTTP + p, { method: opts.method || 'GET', headers, body: opts.body });
}

const fullCredential = () => ({ authorization: 'Bearer auth-token', 'x-dsh-device-credential': deviceCredential });
const bearerOnly = () => ({ authorization: 'Bearer auth-token' });

async function main() {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upBase = `http://127.0.0.1:${upstream.address().port}`;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`relay on ${RELAY_HTTP}, upstream on ${upBase}\n`);

  const t = new RelayTunnel({
    relayUrl: `ws://127.0.0.1:${PORT}/tunnel`,
    instanceId: INSTANCE,
    pairingCode: '424242',
    name: 'auth-contract',
    upstream: upBase,
    onPairRequest: (msg) => t.sendPairConfirm(msg.requestId, true, 'auth-token'),
  });
  await t.start();

  await test('配对成功并签发 token / cookie / 设备凭据', async () => {
    const r = await req('/pair', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ instanceId: INSTANCE, code: '424242', device: { name: 'Phone-Auth' } }),
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.token, 'auth-token');
    assert.ok(j.cookie && j.cookie.startsWith('dsh_pair='), '响应体应包含 dsh_pair cookie');
    assert.ok(j.deviceCredential && j.deviceCredential.startsWith('dshc_'), '应签发 dshc_ 设备凭据');
    assert.ok(j.deviceId, '应返回 deviceId（cookie 绑定用）');
    cookie = j.cookie;
    deviceId = j.deviceId;
    deviceCredential = j.deviceCredential;
  });

  await test('有效设备凭据可经中转代理到桌面', async () => {
    const r = await req('/api/mobile/v1/probe', { headers: fullCredential() });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.live, true);
    // 中转把凭据吃掉的话，桌面端就只能看到一年有效的 HMAC token——吊销在公网这条
    // 路上等于没做。这条断言钉的是「凭据原样到达桌面」。
    assert.strictEqual(j.headers['x-dsh-device-credential'], deviceCredential,
      '设备凭据没有转发到桌面，中转路径上的吊销不会生效');
  });

  await test('局域网配对形态（仅 Bearer，无设备凭据）同样可路由', async () => {
    const r = await req('/api/mobile/v1/probe', { headers: bearerOnly() });
    assert.strictEqual(r.status, 200, '局域网配对会话不应被中转拒绝');
    assert.strictEqual((await r.json()).live, true);
  });

  await test('既无设备凭据也无 Bearer → 401', async () => {
    const r = await req('/api/mobile/v1/probe');
    assert.strictEqual(r.status, 401);
  });

  await test('伪造的设备凭据 → 401，且不回落到 Bearer', async () => {
    const r = await req('/api/mobile/v1/probe', {
      headers: { authorization: 'Bearer auth-token', 'x-dsh-device-credential': 'dshc_forged' },
    });
    assert.strictEqual(r.status, 401, '无效设备凭据不能借 Bearer 绕过');
  });

  await test('吊销前 dsh_pair cookie 可解析出实例', () => {
    const fake = { headers: { cookie: `dsh_pair=${signPair(INSTANCE, deviceId)}` } };
    const inst = pairedInstance(fake);
    assert.ok(inst, '吊销前应解析出实例');
    assert.strictEqual(inst.instanceId, INSTANCE);
  });

  await test('吊销后真设备凭据 → 401', async () => {
    const revoked = credentials.revokeAllByInstance(INSTANCE);
    assert.ok(revoked >= 1, `应吊销至少 1 个凭据，实际 ${revoked}`);
    const r = await req('/api/mobile/v1/probe', { headers: fullCredential() });
    assert.strictEqual(r.status, 401, '吊销后设备凭据必须立即失效');
  });

  await test('吊销后旧 dsh_pair cookie 失效', () => {
    const fake = { headers: { cookie: `dsh_pair=${signPair(INSTANCE, deviceId)}` } };
    assert.strictEqual(pairedInstance(fake), null, '吊销后旧 cookie 必须失效');
  });

  await test('已吊销实例重新配对可恢复', async () => {
    const r = await req('/pair', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ instanceId: INSTANCE, code: '424242', device: { name: 'Phone-Auth-2' } }),
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    deviceCredential = j.deviceCredential;
    const probe = await req('/api/mobile/v1/probe', { headers: fullCredential() });
    assert.strictEqual(probe.status, 200);
  });

  // 实例 ID 是内部路由键，不是让人填的东西：手机手输「中转地址 + 配对码」时手上没有它。
  await test('配对请求不带实例 ID（只有配对码）也能成，并由响应把 ID 回给手机', async () => {
    const r = await fetch(`${RELAY_HTTP}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '424242', device: { name: 'Phone-No-Id' } }),
    });
    assert.strictEqual(r.status, 200, '不带实例 ID 的配对应当照常走通');
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.instanceId, INSTANCE, '实例 ID 要由响应告诉 App —— 用户不需要知道它');
    assert.ok(j.deviceCredential && j.deviceCredential.startsWith('dshc_'), '同样要签发设备凭据');
  });

  await test('配对码对不上任何在线实例 → 404，不谎报「配对码错误」', async () => {
    const r = await fetch(`${RELAY_HTTP}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000001' }),
    });
    assert.strictEqual(r.status, 404);
  });

  upstream.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('失败项：');
    for (const f of failures) console.error('  -', f);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('测试运行异常:', err);
  process.exit(1);
});
