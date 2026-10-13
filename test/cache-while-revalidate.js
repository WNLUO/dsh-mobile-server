'use strict';

/**
 * relay 缓存硬化（serve-stale-while-revalidate + 镜像消息/统计）测试：
 *  1) 首请求回源并写缓存；
 *  2) 缓存未过期 → 立即回 stale:false，不碰慢桌面；
 *  3) 缓存过期 → 立即回 stale:true（0 等待），后台限流刷新缓存；
 *  4) 桌面镜像新鲜 → 直接回镜像（sessions/workspaces/messages/stats 按路径解析）；
 *  5) 镜像缺 messages/stats（或缺失的 sessionId）→ 优雅回退到缓存/回源。
 *
 * 运行：node test/cache-while-revalidate.js
 */

process.env.PORT = String(process.env.CACHE_PORT || 18704);
process.env.HOST = '127.0.0.1';
process.env.RELAY_SECRET = 'cache-secret-0123456789';
// 缩小 TTL 以便在测试中快速制造 stale（影响缓存期限 + 镜像新鲜窗口）。
process.env.RELAY_CACHE_TTL_MS = String(process.env.RELAY_CACHE_TTL_MS || 1000);
// 隔离凭据与镜像缓存：镜像目录默认是仓库内 data/，上一轮遗留的 mirror-*.json
// 会让本轮的"首请求"直接命中陈旧缓存，2/3/4 三个场景随之全部误判。
process.env.DEVICE_CREDENTIALS_FILE = require('node:path').join(__dirname, '.cache-test-credentials.json');
const MIRROR_TEST_DIR = (process.env.MIRROR_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'relay-cache-test-')));

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

// ── 假上游：/api/mobile/v1/sessions 首击快、后续慢（模拟桌面被高负载占用）──
const hitCount = {};
const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = url.pathname + url.search;
  const n = (hitCount[key] = (hitCount[key] || 0) + 1);
  const mirrorOverflow = url.pathname === '/api/mobile/v1/session/messages'
    && url.searchParams.get('sessionId') === 'mirror-overflow';
  const slow = url.pathname === '/api/mobile/v1/sessions'
    && url.searchParams.get('large') !== '1'
    && url.searchParams.get('overflow-refresh') !== '1'
    && n > 1;
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mirrorOverflow) {
      const body = JSON.stringify({ ok: true, items: [], lastSeq: 2, payload: 'x'.repeat(4 * 1024 * 1024 + 64 * 1024) });
      for (let i = 0; i < body.length; i += 64 * 1024) res.write(body.slice(i, i + 64 * 1024));
      res.end();
    } else if (url.pathname === '/api/mobile/v1/sessions'
      && (url.searchParams.get('large') === '1'
        || (url.searchParams.get('overflow-refresh') === '1' && n > 1))) {
        const body = JSON.stringify({ ok: true, items: [], counter: n, payload: 'x'.repeat(2 * 1024 * 1024 + 64 * 1024) });
        for (let i = 0; i < body.length; i += 64 * 1024) res.write(body.slice(i, i + 64 * 1024));
        res.end();
      } else if (url.pathname === '/api/mobile/v1/sessions') {
      res.end(JSON.stringify({ ok: true, items: [{ id: 'sess-1' }], counter: n - 1 }));
    } else if (url.pathname === '/api/mobile/v1/session/messages') {
      res.end(JSON.stringify({ ok: true, items: [], fallthrough: true, counter: n - 1 }));
    } else if (url.pathname === '/api/mobile/v1/session/stats') {
      res.end(JSON.stringify({ ok: true, projections: {}, fallthrough: true, counter: n - 1 }));
    } else {
      res.end(JSON.stringify({ ok: true, items: [], counter: n - 1 }));
    }
  }, slow ? 1500 : 0);
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

let cookie = '';
let mobileToken = '';
let deviceCredential = '';

function mobileHeaders(instanceId) {
  return {
    'X-Dsh-Instance': instanceId,
    'X-Dsh-Device-Credential': deviceCredential,
    'Authorization': 'Bearer ' + mobileToken,
  };
}
function get(pathname, instanceId) {
  return fetch(RELAY_HTTP + pathname, { headers: mobileHeaders(instanceId || 'cach01') });
}

async function main() {
  const credFile = process.env.DEVICE_CREDENTIALS_FILE;
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  try { fs.unlinkSync(credFile); } catch (e) { /* ignore */ }

  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upBase = 'http://127.0.0.1:' + upstream.address().port;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('relay on ' + RELAY_HTTP + ', upstream on ' + upBase + ' (cache-while-revalidate)\n');

  const t = new RelayTunnel({
    relayUrl: RELAY_WS,
    instanceId: 'cach01',
    pairingCode: '123456',
    name: 'cache tester',
    upstream: upBase,
  });
  await t.start();

  const p = await fetch(RELAY_HTTP + '/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: 'cach01', code: '123456', device: { name: 'Phone-A' } }),
  });
  assert.strictEqual(p.status, 200);
  const pj = await p.json();
  mobileToken = pj.token;
  deviceCredential = pj.deviceCredential;
  assert.ok(mobileToken && deviceCredential);
  const sc = p.headers.get('set-cookie') || '';
  const m = sc.match(/dsh_pair=([^;]+)/);
  assert.ok(m, '缺少 set-cookie');
  cookie = 'dsh_pair=' + m[1];

  assert.ok(cookie);

  await test('首请求回源并写缓存（counter 0，不自动带 stale 字段）', async () => {
    const res = await get('/api/mobile/v1/sessions');
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.counter, 0);
    assert.strictEqual(j.stale, undefined, 'live 代理响应不自动带 stale');
  });

  await test('超过 2 MiB 的 live JSON 完整流式返回且不进入缓存', async () => {
    const path = '/api/mobile/v1/sessions?large=1';
    const first = await get(path);
    assert.strictEqual(first.status, 200);
    const firstBody = await first.json();
    assert.strictEqual(firstBody.counter, 1);
    assert.strictEqual(firstBody.payload.length, 2 * 1024 * 1024 + 64 * 1024);
    assert.strictEqual(hitCount[path], 1);

    const second = await get(path);
    assert.strictEqual(second.status, 200);
    const secondBody = await second.json();
    assert.strictEqual(secondBody.counter, 2, '超过缓存上限的响应应再次回源');
    assert.strictEqual(hitCount[path], 2);
  });

  await test('缓存未过期 → 立即回 stale:false，不等待慢桌面', async () => {
    const res = await get('/api/mobile/v1/sessions');
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.stale, false);
    assert.strictEqual(j.counter, 0, '应从缓存读取（counter 仍为 0）');
  });

  await test('缓存过期 → 立即回 stale:true（0 等待）并触发后台刷新', async () => {
    await delay(1100);
    const before = Date.now();
    const res = await get('/api/mobile/v1/sessions');
    const elapsed = Date.now() - before;
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.stale, true, '过期缓存应带 stale:true');
    assert.strictEqual(j.counter, 0, '后台刷新尚未完成，cache 仍为旧值');
    assert.ok(elapsed < 1000, 'stale 命中应即时返回，实际 ' + elapsed + 'ms');
    await delay(1600); // 等后台刷新打到慢上游（~1.5s）
  });

  await test('后台刷新完成后缓存更新（stale:false，counter 递增）', async () => {
    const res = await get('/api/mobile/v1/sessions');
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.stale, false, '刷新后的缓存应为新鲜');
    assert.strictEqual(j.counter, 1, '后台刷新应命中上游并更新缓存');
  });

  await test('并发 stale 命中不刷屏（refreshInFlight 守卫）', async () => {
    await delay(1100);
    const results = await Promise.all([
      get('/api/mobile/v1/sessions'),
      get('/api/mobile/v1/sessions'),
      get('/api/mobile/v1/sessions'),
    ]);
    for (const r of results) {
      assert.strictEqual(r.status, 200);
      const j = await r.json();
      assert.strictEqual(j.stale, true);
      assert.strictEqual(j.counter, 1, '刷新在途，仍应返回旧缓存值');
    }
    await delay(1600); // 让本次后台刷新收尾
  });

  await test('超限的 stale 后台刷新按 key 冷却，仍返回旧缓存', async () => {
    const path = '/api/mobile/v1/sessions?overflow-refresh=1';
    const seed = await get(path);
    assert.strictEqual(seed.status, 200);
    assert.strictEqual((await seed.json()).counter, 0);
    await delay(1100);

    const stale = await get(path);
    assert.strictEqual(stale.status, 200);
    const staleBody = await stale.json();
    assert.strictEqual(staleBody.stale, true);
    assert.strictEqual(staleBody.counter, 0);
    await delay(500); // 等 2MiB+ 回源完成并登记 overflow cooldown。
    assert.strictEqual(hitCount[path], 2, '首次 stale 命中只触发一次 oversized refresh');

    const stillStale = await get(path);
    assert.strictEqual(stillStale.status, 200);
    assert.strictEqual((await stillStale.json()).counter, 0);
    await delay(100);
    assert.strictEqual(hitCount[path], 2, 'cooldown 窗口内不重复回源');
  });

  await test('镜像新鲜：sessions / workspaces / messages / stats 按路径回镜像', async () => {
    const mirrorObj = {
      kind: 'sync',
      at: Date.now(),
      activeSessionId: 's1',
      sessions: { ok: true, items: [{ id: 'mirror-sess' }] },
      workspaces: { ok: true, items: [{ id: 'mirror-ws' }] },
      messages: { s1: { ok: true, items: [{ role: 'user', content: 'hi' }], lastSeq: 5, hasMore: false } },
      stats: { s2: { ok: true, projections: { tokens: 42, sessionStats: { turns: 3, secret: 'drop-me' }, secret: 'drop-me' } } },
      models: { s1: { ok: true, revision: 7, meta: { source: 'host', revision: 7, secret: 'drop-me' }, current: { provider: 'openai', model: 'gpt-test', secret: 'drop-me' }, routable: true, groups: [{ id: 'main', name: 'Main', models: [{ id: 'm1', name: 'Model 1', description: 'safe', secret: 'drop-me' }] }] } },
    };
    t.sendJson(T.sync, 0, mirrorObj);
    await delay(100);

    let j = await (await get('/api/mobile/v1/sessions')).json();
    assert.deepStrictEqual(j.items, [{ id: 'mirror-sess' }]);
    assert.strictEqual(j.stale, false);

    j = await (await get('/api/mobile/v1/workspaces')).json();
    assert.deepStrictEqual(j.items, [{ id: 'mirror-ws' }]);
    assert.strictEqual(j.stale, false);

    j = await (await get('/api/mobile/v1/session/messages?sessionId=s1')).json();
    assert.strictEqual(j.lastSeq, 5);
    assert.strictEqual(j.hasMore, false);
    assert.strictEqual(j.stale, false);

    j = await (await get('/api/mobile/v1/session/models?sessionId=s1')).json();
    assert.strictEqual(j.revision, 7);
    assert.strictEqual(j.meta.revision, 7);
    assert.strictEqual(j.groups[0].models[0].id, 'm1');
    assert.strictEqual(j.current.secret, undefined);
    assert.strictEqual(j.meta.secret, undefined);
    assert.strictEqual(j.groups[0].models[0].secret, undefined);
    assert.strictEqual(j.stale, false);

    j = await (await get('/api/mobile/v1/session/stats?sessionId=s2')).json();
    assert.strictEqual(j.projections.tokens, 42);
    assert.strictEqual(j.projections.sessionStats.turns, 3);
    assert.strictEqual(j.projections.sessionStats.secret, undefined);
    assert.strictEqual(j.projections.secret, undefined);
    assert.strictEqual(j.stale, false);
  });

  // Global model snapshot remains valid for any sessionId.
  await test('镜像 models 全局快照与 stale-while-revalidate', async () => {
    t.sendJson(T.sync, 0, { kind: 'sync', at: Date.now(), models: { ok: true, revision: 8, meta: { source: 'host', revision: 8 }, current: { provider: 'global', model: 'fallback-model' } } });
    await delay(100);
    let j = await (await get('/api/mobile/v1/session/models?sessionId=other')).json();
    assert.strictEqual(j.revision, 8);
    assert.strictEqual(j.current.model, 'fallback-model');
    assert.strictEqual(j.stale, false);
    await delay(1100);
    j = await (await get('/api/mobile/v1/session/models?sessionId=other')).json();
    assert.strictEqual(j.revision, 8);
    assert.strictEqual(j.stale, true);
  });

  // 镜像槽位过期后必须被后台刷新回写：修复前 backgroundRefresh 只写 responseCache，
  // 而镜像分支在查 responseCache 之前就 return，于是冻结的镜像被无限期回给手机。
  await test('镜像槽位过期 → 后台刷新回写快照，不再无限期回冻结镜像', async () => {
    t.sendJson(T.sync, 0, {
      kind: 'sync',
      at: Date.now(),
      sessions: { ok: true, items: [{ id: 'frozen-sess' }], revision: 41 },
    });
    await delay(100);

    // 新鲜：直接回镜像
    let j = await (await get('/api/mobile/v1/sessions')).json();
    assert.strictEqual(j.items[0].id, 'frozen-sess');
    assert.strictEqual(j.stale, false);

    // 过期：仍然立刻回镜像（stale:true），同时触发后台刷新
    await delay(1100);
    j = await (await get('/api/mobile/v1/sessions')).json();
    assert.strictEqual(j.items[0].id, 'frozen-sess');
    assert.strictEqual(j.stale, true);

    // 后台刷新必须把上游的新鲜 body 写回镜像槽位本身（上游 sessions 第二击起故意慢 1.5s）
    await delay(2200);
    j = await (await get('/api/mobile/v1/sessions')).json();
    assert.strictEqual(j.items[0].id, 'sess-1', '刷新后的快照必须回写镜像槽位');
    assert.strictEqual(typeof j.counter, 'number', '应来自上游而非冻结镜像');
    assert.strictEqual(j.stale, false, '回写后该槽位应重新变新鲜');
  });

  await test('超过 4MiB 的镜像刷新不留存，冷却期内不重复回源', async () => {
    const sessionId = 'mirror-overflow';
    const path = `/api/mobile/v1/session/messages?sessionId=${sessionId}`;
    const key = `${path}`;
    t.sendJson(T.sync, 0, {
      kind: 'sync',
      at: Date.now(),
      messages: { [sessionId]: { ok: true, items: [{ seq: 1, role: 'assistant', content: 'frozen' }], lastSeq: 1, hasMore: false } },
    });
    await delay(100);

    const fresh = await (await get(path)).json();
    assert.strictEqual(fresh.stale, false);
    assert.strictEqual(fresh.lastSeq, 1);

    await delay(1100);
    const stale = await (await get(path)).json();
    assert.strictEqual(stale.stale, true);
    assert.strictEqual(stale.lastSeq, 1, '超限回源不能写回或污染原镜像');
    await delay(500); // 等待 4MiB+ 回源完成并登记镜像 refreshKey cooldown。
    assert.strictEqual(hitCount[key], 1, '首次 stale 命中只触发一次超限镜像刷新');

    const stillStale = await (await get(path)).json();
    assert.strictEqual(stillStale.stale, true);
    assert.strictEqual(stillStale.lastSeq, 1);
    await delay(100);
    assert.strictEqual(hitCount[key], 1, 'cooldown 窗口内不重复回源');
  });

  await test('镜像 messages 按 afterSeq 增量过滤（seq>afterSeq，lastSeq 重算）', async () => {
    const mirrorMsgs = {
      kind: 'sync',
      at: Date.now(),
      activeSessionId: 's1',
      messages: {
        s1: {
          ok: true,
          items: [
            { seq: 1, role: 'user', content: 'a' },
            { seq: 2, role: 'assistant', content: 'b' },
            { seq: 5, role: 'user', content: 'c' },
          ],
          lastSeq: 5,
          hasMore: true,
        },
      },
    };
    t.sendJson(T.sync, 0, mirrorMsgs);
    await delay(100);

    // afterSeq=2 → 只留 seq>2，lastSeq 收敛到 5
    let j = await (await get('/api/mobile/v1/session/messages?sessionId=s1&afterSeq=2')).json();
    assert.strictEqual(j.items.length, 1);
    assert.strictEqual(j.items[0].seq, 5);
    assert.strictEqual(j.lastSeq, 5);
    assert.strictEqual(j.hasMore, true);
    assert.strictEqual(j.stale, false);

    // afterSeq 超过最大值 → 空 items，lastSeq 回退 afterSeq
    j = await (await get('/api/mobile/v1/session/messages?sessionId=s1&afterSeq=10')).json();
    assert.strictEqual(j.items.length, 0);
    assert.strictEqual(j.lastSeq, 10);
    assert.strictEqual(j.hasMore, true);
    assert.strictEqual(j.stale, false);

    // Historical paging and oversized limits must return to the desktop.
    j = await (await get('/api/mobile/v1/session/messages?sessionId=s1&beforeSeq=4')).json();
    assert.strictEqual(j.fallthrough, true);
    j = await (await get('/api/mobile/v1/session/messages?sessionId=s1&limit=99')).json();
    assert.strictEqual(j.fallthrough, true);

    // 无 afterSeq → 返回完整快照
    j = await (await get('/api/mobile/v1/session/messages?sessionId=s1')).json();
    assert.strictEqual(j.items.length, 3);
    assert.strictEqual(j.lastSeq, 5);
  });

  await test('镜像缺 messages/stats 或 sessionId 缺失 → 优雅回退', async () => {
    const mirrorNoMsgs = { kind: 'sync', at: Date.now(), sessions: { ok: true, items: [{ id: 'mirror-sess' }] }, workspaces: { ok: true, items: [{ id: 'mirror-ws' }] } };
    t.sendJson(T.sync, 0, mirrorNoMsgs);
    await delay(100);
    const res = await get('/api/mobile/v1/session/messages?sessionId=unknown');
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.fallthrough, true, '缺镜像应回源而非报错');
    const s = await (await get('/api/mobile/v1/session/stats?sessionId=unknown')).json();
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.fallthrough, true);
    const m = await (await get('/api/mobile/v1/session/models?sessionId=unknown')).json();
    assert.strictEqual(m.ok, true);
    assert.strictEqual(m.revision, undefined, '无模型镜像应回源而非镜像响应');
    assert.strictEqual(m.stale, undefined, '回源响应不应伪造 stale');
  });

  await test('无设备凭据的会话（局域网配对）不得使用镜像与响应缓存', async () => {
    // 中转端无法验证宿主签发的 Bearer token（局域网配对只写桌面的凭据库），
    // 因此这类请求必须回源到桌面，由上游强制吊销与授权。镜像此刻装着
    // items:[{id:'mirror-sess'}]（上游从不产生这个 id），只有回源才拿不到它。
    t.sendJson(T.sync, 0, {
      kind: 'sync',
      at: Date.now(),
      sessions: { ok: true, items: [{ id: 'mirror-sess' }] },
      workspaces: { ok: true, items: [{ id: 'mirror-ws' }] },
    });
    await delay(100);

    // 对照：同一个 URL 带设备凭据时必须命中镜像，且不碰上游。
    const beforeMirror = hitCount['/api/mobile/v1/sessions'] || 0;
    const mirrored = await (await get('/api/mobile/v1/sessions')).json();
    assert.deepStrictEqual(mirrored.items, [{ id: 'mirror-sess' }], '对照：带设备凭据应命中镜像');
    assert.strictEqual(hitCount['/api/mobile/v1/sessions'] || 0, beforeMirror, '对照：命中镜像不应回源');

    // 只带宿主 Bearer token（局域网配对会话）→ 必须被路由并回源，而不是被拒。
    const before = hitCount['/api/mobile/v1/sessions'] || 0;
    const res = await fetch(RELAY_HTTP + '/api/mobile/v1/sessions', {
      headers: { 'X-Dsh-Instance': 'cach01', 'Authorization': 'Bearer ' + mobileToken },
    });
    assert.strictEqual(res.status, 200, '无设备凭据的会话应被路由并回源，而不是被拒');
    const j = await res.json();
    assert.ok(
      !(Array.isArray(j.items) && j.items.some((it) => it && it.id === 'mirror-sess')),
      '无设备凭据的会话不得读到镜像内容',
    );
    assert.strictEqual(hitCount['/api/mobile/v1/sessions'] || 0, before + 1, '无设备凭据的会话必须回源（上游命中数 +1）');
  });

  // ── 清理 ──
  t.stop();
  upstream.close();
  server.close();
  try { fs.unlinkSync(credFile); } catch (e) { /* ignore */ }
  try { fs.rmSync(MIRROR_TEST_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
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

