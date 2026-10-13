'use strict';

/**
 * 集成测试：用桌面插件真实的 lib/tunnel.js（协议 v2）连接中转服务器，
 * 验证「手机 → relay → 真实隧道 → 假上游」全链路。
 *
 * 运行：node test/integration-tunnel.js（或 npm run test:integration）
 * 依赖：dsh-mobile-server/node_modules 已安装（ws）。
 */

process.env.PORT = String(process.env.INTEG_PORT || 18702);
process.env.HOST = '127.0.0.1';
process.env.RELAY_SECRET = 'integration-secret-0123456789';

const http = require('node:http');
const assert = require('node:assert');
const { WebSocketServer, WebSocket } = require('ws');
const { server } = require('../server.js');
const { RelayTunnel } = require('../../dsh-mobile-plugin/lib/relay/tunnel.js');

const PORT = Number(process.env.PORT);
const RELAY_HTTP = `http://127.0.0.1:${PORT}`;
const RELAY_WS = `ws://127.0.0.1:${PORT}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>REAL-TUNNEL-ROOT</body></html>');
  } else if (url.pathname === '/api/echo') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: JSON.parse(b || '{}') }));
    });
  } else if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: sse-1\n\n');
    setTimeout(() => { res.write('data: sse-2\n\n'); res.end(); }, 30);
  } else {
    res.writeHead(404);
    res.end('nf');
  }
});
const upWss = new WebSocketServer({ server: upstream, path: '/ws' });
upWss.on('connection', (ws) => ws.on('message', (d) => ws.send(d)));

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
let cookie = '';
let deviceCredential = '';
async function req(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookie) headers.cookie = cookie;
  if (opts.json) headers['content-type'] = 'application/json';
  return fetch(RELAY_HTTP + path, { method: opts.method || 'GET', headers, body: opts.body });
}

async function main() {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upBase = `http://127.0.0.1:${upstream.address().port}`;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`relay on ${RELAY_HTTP}, upstream on ${upBase} (真实插件隧道)\n`);

  const t = new RelayTunnel({
    relayUrl: `${RELAY_WS}/tunnel`,
    instanceId: 'real01',
    pairingCode: '123456',
    name: 'real-tunnel',
    upstream: upBase,
    // 模拟桌面用户点「允许」：自动回 pairConfirm（真实桌面由 main.js 弹窗驱动）
    onPairRequest: (msg) => {
      t.sendPairConfirm(msg.requestId, true, 'integration-token');
    },
  });
  await t.start();

  await test('真实隧道注册 + 配对 + 代理 GET', async () => {
    const r1 = await req('/pair', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ instanceId: 'real01', code: '123456', device: { name: 'Phone-1' } }),
    });
    assert.strictEqual(r1.status, 200);
    const j = await r1.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.token, 'integration-token', '应拿到桌面端签发的 token');
    assert.ok(j.cookie && j.cookie.startsWith('dsh_pair='), '响应体应包含 dsh_pair cookie');
    cookie = j.cookie;
    deviceCredential = j.deviceCredential;
    const r2 = await req('/');
    assert.strictEqual(r2.status, 404);
    assert.match(r2.headers.get('content-type') || '', /^application\/json/i);
    assert.doesNotMatch(await r2.text(), /<html/i);
  });

  await test('真实隧道 SSE 流式透传', async () => {
    const res = await req('/api/events');
    let text = '';
    for await (const chunk of res.body) text += Buffer.from(chunk).toString('utf8');
    assert.ok(text.includes('sse-1') && text.includes('sse-2'), `SSE 内容不完整: ${JSON.stringify(text.slice(0, 100))}`);
  });

  await test('真实隧道大请求体流式透传', async () => {
    const payload = JSON.stringify({ big: 'y'.repeat(256 * 1024) });
    const res = await req('/api/echo', { method: 'POST', json: true, body: payload });
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.echo.big.length, 256 * 1024);
  });

  await test('真实隧道 WS 桥接回环', async () => {
    const ws = new WebSocket(`${RELAY_WS}/ws`, { headers: { cookie, 'x-dsh-instance': 'real01', 'x-dsh-device-credential': deviceCredential, authorization: 'Bearer integration-token' } });
    const got = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws echo 超时')), 5000);
      ws.on('open', () => ws.send('ping-real'));
      ws.on('message', (d) => { clearTimeout(timer); resolve(d.toString()); });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    ws.close();
    assert.strictEqual(got, 'ping-real');
  });

  await test('真实隧道 updatePairing 同步', async () => {
    t.updatePairingCode('999999');
    await delay(150);
    const rOld = await req('/pair', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ instanceId: 'real01', code: '123456' }),
    });
    assert.strictEqual(rOld.status, 401, '旧码应失效');
    const rNew = await req('/pair', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ instanceId: 'real01', code: '999999' }),
    });
    assert.strictEqual(rNew.status, 200, '新码应可配对');
  });

  t.stop();
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
