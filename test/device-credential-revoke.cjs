'use strict';

/**
 * 设备凭据吊销路由回归测试。
 *
 * 锁定两条很容易被后人改坏的语义：
 *  1) 同一台手机重复配对会在中转累积多条活跃凭据 —— issue() 刻意不把 deviceId
 *     当唯一约束（App 数据迁移/克隆会撞号），而 App 每次配对都带上自己安装期
 *     稳定的 deviceId。所以「删除设备」必须按 deviceId 整批吊销，只吊销手机手上
 *     那一条的话，更早那条仍能一直访问到凭据自身的 365 天过期。
 *  2) 整批吊销只能波及这一台设备，别的设备的凭据必须原样存活。
 *
 * 运行：node test/device-credential-revoke.cjs
 */

process.env.PORT = String(process.env.REVOKE_PORT || 18707);
process.env.HOST = '127.0.0.1';
process.env.RELAY_SECRET = 'device-revoke-secret-0123456789';

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

// 用临时文件隔离设备凭据存储，避免污染真实 ~/.dsh。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-revoke-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(tmp, 'relay-device-credentials.json');

require('ws');
const { server } = require('../server.js');
const { instances } = require('../lib/registry.js');
const credentials = require('../../dsh-mobile-plugin/dsh-mobile-credentials/lib/credentials.js');
const { RelayTunnel } = require('../../dsh-mobile-plugin/lib/relay/tunnel.js');

const PORT = Number(process.env.PORT);
const RELAY_HTTP = `http://127.0.0.1:${PORT}`;
const INSTANCE = 'revoke01';
const PAIRING_CODE = '424242';

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

/** 配对一次，返回 { deviceCredential, deviceId }。deviceId 由调用方给定，模拟安装期稳定。 */
async function pair(deviceId, name) {
  const r = await fetch(`${RELAY_HTTP}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: INSTANCE, code: PAIRING_CODE, device: { deviceId, name } }),
  });
  assert.strictEqual(r.status, 200, `配对应成功，实际 ${r.status}`);
  return r.json();
}

function revoke(credential) {
  const headers = { 'x-dsh-instance': INSTANCE };
  if (credential) headers['x-dsh-device-credential'] = credential;
  return fetch(`${RELAY_HTTP}/api/mobile/v1/device-credential/revoke`, { method: 'POST', headers });
}

async function main() {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ live: true, path: req.url }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`relay on ${RELAY_HTTP}\n`);

  const t = new RelayTunnel({
    relayUrl: `ws://127.0.0.1:${PORT}/tunnel`,
    instanceId: INSTANCE,
    pairingCode: PAIRING_CODE,
    name: 'device-revoke',
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    onPairRequest: (msg) => t.sendPairConfirm(msg.requestId, true, 'revoke-token'),
  });
  await t.start();

  const first = await pair('dev-stable', 'Phone-Stable');
  const second = await pair('dev-stable', 'Phone-Stable');
  const other = await pair('dev-other', 'Phone-Other');

  await test('同一 deviceId 重复配对会累积多条活跃凭据', () => {
    assert.notStrictEqual(first.deviceCredential, second.deviceCredential, '两次配对应签发不同凭据');
    assert.strictEqual(first.deviceId, second.deviceId, '安装期稳定的 deviceId 应保持一致');
    assert.ok(credentials.find(first.deviceCredential, INSTANCE), '旧凭据在吊销前应仍然有效');
    assert.ok(credentials.find(second.deviceCredential, INSTANCE), '新凭据应有效');
    assert.ok(credentials.find(other.deviceCredential, INSTANCE), '另一台设备的凭据应有效');
  });

  await test('吊销一台设备会连同它更早的凭据一起失效', async () => {
    const r = await revoke(second.deviceCredential);
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.revoked, 2, `应吊销该设备全部 2 条凭据，实际 ${j.revoked}`);
    assert.strictEqual(credentials.find(second.deviceCredential, INSTANCE), null, '手机手上的凭据应失效');
    assert.strictEqual(credentials.find(first.deviceCredential, INSTANCE), null, '更早那条也必须失效');
  });

  await test('整批吊销不波及其它设备', () => {
    assert.ok(credentials.find(other.deviceCredential, INSTANCE), '别的设备的凭据必须存活');
  });

  await test('吊销响应清除 dsh_pair cookie', async () => {
    const r = await revoke(other.deviceCredential);
    assert.strictEqual(r.status, 200);
    const setCookie = typeof r.headers.getSetCookie === 'function'
      ? r.headers.getSetCookie().join(';')
      : String(r.headers.get('set-cookie') || '');
    assert.match(setCookie, /dsh_pair=/, '应下发清除 cookie');
    assert.match(setCookie, /Max-Age=0/, 'cookie 应立即过期');
    assert.strictEqual(credentials.find(other.deviceCredential, INSTANCE), null);
  });

  await test('已吊销的凭据再次吊销 → 401', async () => {
    const r = await revoke(other.deviceCredential);
    assert.strictEqual(r.status, 401);
  });

  await test('伪造凭据 → 401', async () => {
    const r = await revoke('dshc_forged');
    assert.strictEqual(r.status, 401);
  });

  await test('缺少凭据头 → 401', async () => {
    const r = await revoke(null);
    assert.strictEqual(r.status, 401);
  });

  await test('吊销后旧凭据无法再经中转路由到桌面', async () => {
    const r = await fetch(`${RELAY_HTTP}/api/mobile/v1/probe`, {
      headers: { 'x-dsh-instance': INSTANCE, 'x-dsh-device-credential': second.deviceCredential, authorization: 'Bearer revoke-token' },
    });
    assert.strictEqual(r.status, 401, '已吊销设备不能借 Bearer 继续访问');
  });

  await test('桌面隧道离线时仍可吊销（中转本机凭据库）', async () => {
    const offline = await pair('dev-offline', 'Phone-Offline');
    t.stop();
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(instances.get(INSTANCE), undefined, '隧道应已下线');
    const r = await revoke(offline.deviceCredential);
    assert.strictEqual(r.status, 200, '吊销不应要求桌面在线');
    const j = await r.json();
    assert.strictEqual(j.revoked, 1, `应吊销 1 条，实际 ${j.revoked}`);
    assert.strictEqual(credentials.find(offline.deviceCredential, INSTANCE), null, '凭据应立即失效');
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
