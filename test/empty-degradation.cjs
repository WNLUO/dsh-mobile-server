'use strict';

/**
 * 中转侧「空降级」硬化测试（对应真机症状：侧边栏设备下的项目/对话整树消失、设备仍显示
 * 「在线」、点不开、零错误提示、只有下拉刷新能恢复）。
 *
 * 覆盖三条中转侧的放大器：
 *  1) 响应缓存：`cacheResponse` 不得用后到的空篮子覆盖已有的非空清单
 *     （serve-stale-while-revalidate 会把它再供 RELAY_CACHE_TTL_MS，30s 足以让
 *      App 连吃两次 15s 轮询，把好列表整个变成空列表）；
 *  2) 镜像回写：`applyMirrorRefresh` 不得用一次回源的空结果覆盖刚推来的非空快照
 *     （旧实现还会 markMirrorSlot 把它标成新鲜，于是空镜像被无限期回给手机）；
 *  3) `?fresh=1`：带 fresh 的读既不读镜像也不读响应缓存、不写缓存——它是移动端
 *     从被污染的代读副本里脱身的唯一手段，被堵死就等于「下拉刷新也救不回来」。
 *
 * 运行：node test/empty-degradation.cjs
 */

process.env.PORT = String(process.env.EMPTY_PORT || 18715);
process.env.HOST = '127.0.0.1';
process.env.RELAY_SECRET = 'empty-secret-0123456789';
process.env.RELAY_CACHE_TTL_MS = String(process.env.RELAY_CACHE_TTL_MS || 400);
process.env.DEVICE_CREDENTIALS_FILE = require('node:path').join(__dirname, '.empty-test-credentials.json');
process.env.MIRROR_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'relay-empty-test-'));

const http = require('node:http');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { server } = require('../server.js');
const { RelayTunnel } = require('./fake-desktop.js');
const { T } = require('../lib/protocol.js');

const PORT = Number(process.env.PORT);
const RELAY_HTTP = 'http://127.0.0.1:' + PORT;
const RELAY_WS = 'ws://127.0.0.1:' + PORT;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 假上游：可以在「非空」与「空」之间切换，用来模拟宿主降级读 ──
const hits = { normal: 0, fresh: 0 };
let upstreamMode = 'nonempty';
const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/api/mobile/v1/sessions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, items: [] }));
  }
  if (url.searchParams.get('fresh') === '1') hits.fresh += 1;
  else hits.normal += 1;
  const body = upstreamMode === 'empty'
    ? { ok: true, items: [] }
    : { ok: true, items: [{ id: 'sess-1' }, { id: 'sess-2' }] };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed += 1;
    failures.push(name + ': ' + err.message);
    console.error('  ✗ ' + name + ' — ' + err.message);
  }
}

let mobileToken = '';
let deviceCredential = '';

function get(pathname) {
  return fetch(RELAY_HTTP + pathname, {
    headers: {
      'X-Dsh-Instance': 'empty01',
      'X-Dsh-Device-Credential': deviceCredential,
      'Authorization': 'Bearer ' + mobileToken,
    },
  });
}
const itemsOf = async (pathname) => (await (await get(pathname)).json()).items;

async function main() {
  const credFile = process.env.DEVICE_CREDENTIALS_FILE;
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  try { fs.unlinkSync(credFile); } catch { /* ignore */ }

  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upBase = 'http://127.0.0.1:' + upstream.address().port;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('relay on ' + RELAY_HTTP + ', upstream on ' + upBase + ' (empty-degradation)\n');

  const t = new RelayTunnel({
    relayUrl: RELAY_WS,
    instanceId: 'empty01',
    pairingCode: '654321',
    name: 'empty tester',
    upstream: upBase,
  });
  await t.start();

  const p = await fetch(RELAY_HTTP + '/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: 'empty01', code: '654321', device: { name: 'Phone-B' } }),
  });
  assert.strictEqual(p.status, 200);
  const pj = await p.json();
  mobileToken = pj.token;
  deviceCredential = pj.deviceCredential;
  assert.ok(mobileToken && deviceCredential);

  await test('live 200 的空清单不得覆盖已缓存的非空清单', async () => {
    upstreamMode = 'nonempty';
    let j = await (await get('/api/mobile/v1/sessions')).json();
    assert.strictEqual(j.items.length, 2, '首次 live 应拿到非空清单');

    // 缓存过期（TTL 400ms）后，命中 stale 分支并在后台回源；这次上游回空。
    upstreamMode = 'empty';
    await delay(500);
    j = await (await get('/api/mobile/v1/sessions')).json();
    assert.strictEqual(j.items.length, 2, '过期命中必须仍回上一份好列表（stale:true）');
    assert.strictEqual(j.stale, true);

    await delay(300); // 等后台刷新落地（它会尝试用空结果覆盖缓存）
    j = await (await get('/api/mobile/v1/sessions')).json();
    assert.strictEqual(j.items.length, 2, '空降级不得被写进响应缓存（否则再供 30s）');
  });

  await test('镜像回写：回源的空结果不得覆盖刚推来的非空快照', async () => {
    t.sendJson(T.sync, 0, {
      kind: 'sync',
      at: Date.now(),
      sessions: { ok: true, items: [{ id: 'mirror-sess' }] },
      workspaces: { ok: true, items: [{ id: 'mirror-ws' }] },
    });
    await delay(150);
    let j = await (await get('/api/mobile/v1/sessions')).json();
    assert.deepStrictEqual(j.items, [{ id: 'mirror-sess' }], '应命中新鲜镜像');

    // 让镜像槽位过期并让上游回空：后台刷新会把空结果交给 applyMirrorRefresh。
    await delay(500);
    j = await (await get('/api/mobile/v1/sessions')).json();
    assert.deepStrictEqual(j.items, [{ id: 'mirror-sess' }], '过期镜像仍应回好快照');
    assert.strictEqual(j.stale, true);

    await delay(400); // 等后台刷新写回
    j = await (await get('/api/mobile/v1/sessions')).json();
    assert.deepStrictEqual(j.items, [{ id: 'mirror-sess' }], '空回源结果不得覆盖镜像槽位');
    assert.strictEqual(j.stale, true, '被拒绝的刷新不得把槽位标成新鲜（否则空镜像被冻结）');
  });

  await test('?fresh=1 绕过镜像与响应缓存，直接回源（恢复手段不能被堵死）', async () => {
    // 上一轮断言里的 stale 命中会各自留下一个后台回源（serve-stale-while-revalidate /
    // 过期镜像回源都是异步的），它们走的是普通读那条路。先让它们落地，否则本例里
    // 「普通读请求数不该变」会数到上一轮遗留的后台刷新。
    await delay(300);
    // 此刻镜像装着非空快照、响应缓存里也有非空清单，两条路都不该被 fresh 读走。
    const beforeNormal = hits.normal;
    const beforeFresh = hits.fresh;
    const j = await (await get('/api/mobile/v1/sessions?fresh=1')).json();
    assert.strictEqual(hits.fresh, beforeFresh + 1, 'fresh 读必须回源一次');
    assert.strictEqual(hits.normal, beforeNormal, 'fresh 读不得被普通读那条路顶掉');
    assert.ok(Array.isArray(j.items), 'fresh 读应回上游响应');
    // 对照：普通读仍然命中镜像（快路径不能被这次修复关掉）。
    const control = await (await get('/api/mobile/v1/sessions')).json();
    assert.deepStrictEqual(control.items, [{ id: 'mirror-sess' }], '普通读仍应命中镜像');
  });

  await test('未确认的空镜像推送不得顶掉非空快照，fresh 读仍能自救', async () => {
    // 桌面推来一份**未经确认**的空快照（items:[] 但没有 emptyConfirmed:true）。
    // 这通常不是「真的清空了」，而是宿主侧的瞬时抖动/降级结果；直接顶掉之后侧边栏会在
    // 整个 grace 窗口里空白（旧行为：普通读立刻看到空列表）。新口径：拒绝覆盖，
    // 保留上一份非空清单 —— 想真删空的推送必须带 emptyConfirmed:true。
    t.sendJson(T.sync, 0, {
      kind: 'sync',
      at: Date.now(),
      sessions: { ok: true, items: [] },
      workspaces: { ok: true, items: [] },
    });
    await delay(150);
    const j = await (await get('/api/mobile/v1/sessions')).json();
    assert.deepStrictEqual(j.items, [{ id: 'mirror-sess' }], '未确认的空推送不得顶掉非空镜像');

    upstreamMode = 'nonempty';
    const beforeFresh = hits.fresh;
    const fresh = await (await get('/api/mobile/v1/sessions?fresh=1')).json();
    assert.strictEqual(hits.fresh, beforeFresh + 1, 'fresh 读必须绕过镜像回源');
    assert.strictEqual(fresh.items.length, 2, 'fresh 读必须拿到上游的真实清单');
  });

  await test('宿主显式确认的空清单必须放行（真删空不能被保护拦死）', async () => {
    t.sendJson(T.sync, 0, {
      kind: 'sync',
      at: Date.now(),
      sessions: { ok: true, items: [], emptyConfirmed: true },
      workspaces: { ok: true, items: [], emptyConfirmed: true },
    });
    await delay(150);
    const j = await (await get('/api/mobile/v1/sessions')).json();
    assert.deepStrictEqual(j.items, [], '带 emptyConfirmed:true 的空清单是「真清空」，必须生效');
    assert.strictEqual(j.stale, false, '被接受的推送应当把槽位标成新鲜');
  });

  await test('fresh 读不写响应缓存：两次 fresh 读都要回源', async () => {
    const beforeFresh = hits.fresh;
    await get('/api/mobile/v1/sessions?fresh=1');
    await get('/api/mobile/v1/sessions?fresh=1');
    assert.strictEqual(hits.fresh, beforeFresh + 2, 'fresh 读之间不得互相顶掉');
  });

  t.stop();
  upstream.close();
  server.close();
  try { fs.unlinkSync(credFile); } catch { /* ignore */ }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
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
