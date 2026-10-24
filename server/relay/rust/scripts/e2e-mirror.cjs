'use strict';

/**
 * 端到端验收：宿主离线时的镜像兜底（`MIRROR_CACHE`）。
 *
 * 单元测试钉的是判定逻辑，这里钉的是**接线**——隧道帧有没有走到 mirror、HTTP 入口
 * 有没有在隧道消失之后去问它、凭据对不对得上、以及关掉开关之后是否一个字都不给。
 * 这几处任何一处漏接，单测都会绿。
 *
 *   node server/relay/rust/scripts/e2e-mirror.cjs <rust-relay-binary>
 */

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const { RelayTunnel } = require(path.join(ROOT, 'test', 'fake-desktop.js'));
const { T } = require(path.join(ROOT, '..', '..', 'relay-core', 'protocol-types.js'));

const RELAY_PORT = 18710;
const UPSTREAM_PORT = 18711;
const INSTANCE = 'e2e-mirror-a';
// T1 形状：每设备凭据本身就是一段任意 Bearer（`<instanceId>.<exp>.<random>`），
// 没有 `dshc_` 前缀。中转只按原文的 sha256 认，e2e 用这个形状才盖得住「不看前缀」。
const CREDENTIAL = 'e2e0m1rr.1800000000.bG9jYWwtcmFuZG9t';

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const SESSIONS_REVISION = 'rev-sessions-1';
const WORKSPACES_REVISION = 'rev-workspaces-1';

/** 宿主推上来的那份镜像，形状与插件 `pushMirrorPayload` 一致。 */
function mirrorPayload() {
  return {
    kind: 'sync',
    at: Date.now(),
    activeSessionId: 's1',
    sessions: {
      ok: true,
      items: [{ sessionId: 's1', title: '离线还看得见', running: false, updatedAt: 1 }],
      hasMore: false,
      generatedAt: 111,
      revision: SESSIONS_REVISION,
      emptyConfirmed: false,
    },
    workspaces: {
      ok: true,
      items: [{ workspaceId: 'w1', title: '项目' }],
      archivedSessionIds: [],
      generatedAt: 222,
      revision: WORKSPACES_REVISION,
      emptyConfirmed: false,
    },
    messages: {},
    stats: {},
    models: {},
    creds: [{ hash: sha256(CREDENTIAL) }],
  };
}

/**
 * 慢宿主开关：打开之后上游故意拖 5 秒才吐响应头，用来演「两段链路都慢，但都还活着」。
 * 这是弱网兜底唯一要验的场景——隧道在，只是迟迟不回头。
 */
let SLOW = false;
const SLOW_MS = 5_000;

function startUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reply = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, forwarded: req.url }));
      };
      if (SLOW && (req.url.startsWith('/api/mobile/v1/sessions') || req.url.startsWith('/echo'))) {
        setTimeout(reply, SLOW_MS);
        return;
      }
      reply();
    });
    server.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve(server));
  });
}

/** 量一次请求的墙钟耗时（毫秒）。 */
async function timed(pathname, headers) {
  const started = Date.now();
  const response = await rawRequest(pathname, headers);
  return { ...response, elapsed: Date.now() - started };
}

function rawRequest(urlPath, headers) {
  const endpoint = `http://127.0.0.1:${RELAY_PORT}${urlPath}`;
  return new Promise((resolve, reject) => {
    const req = http.request(endpoint, { method: 'GET', headers: { 'x-dsh-instance': INSTANCE, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function waitForRelay(proc) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => {
      const probe = http.get(`http://127.0.0.1:${RELAY_PORT}/healthz`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      probe.on('error', retry);
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('中转没有在 10 秒内起来'));
      setTimeout(poll, 100);
    };
    if (proc.exitCode !== null) return reject(new Error(`中转进程已退出 code=${proc.exitCode}`));
    poll();
  });
}

/** 等到那条隧道真的从中转的实例表里消失（不以客户端的 close 时间为准）。 */
async function waitForTunnelGone() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    // 没有镜像兜底可用的普通路径：隧道在就是 200（转给上游），不在就是 503。
    const probe = await rawRequest('/anything');
    if (probe.status !== 200) return;
    if (Date.now() > deadline) throw new Error(`等隧道断开超时，最后一次 status=${probe.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function spawnRelay(binary, extraEnv) {
  const relay = spawn(binary, [], {
    env: { ...process.env, PORT: String(RELAY_PORT), HOST: '127.0.0.1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (d) => process.stdout.write(`[relay] ${d}`));
  relay.stderr.on('data', (d) => process.stderr.write(`[relay:err] ${d}`));
  return relay;
}

function stopRelay(relay) {
  return new Promise((resolve) => {
    if (!relay || relay.exitCode !== null) return resolve();
    relay.once('exit', () => resolve());
    relay.kill('SIGKILL');
  });
}

async function main() {
  const binary = process.argv[2];
  if (!binary) {
    console.error('用法：node e2e-mirror.cjs <rust-relay-binary>');
    process.exit(2);
  }

  const failures = [];
  const check = (name, ok, detail) => {
    if (ok) {
      console.log(`✔ ${name}`);
    } else {
      console.log(`✖ ${name}${detail ? ` — ${detail}` : ''}`);
      failures.push(name);
    }
  };

  const upstream = await startUpstream();
  let relay = spawnRelay(binary, {});
  let tunnel = null;

  try {
    await waitForRelay(relay);

    tunnel = new RelayTunnel({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      instanceId: INSTANCE,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      onLog: () => {},
    });
    await tunnel.connect();

    // 宿主在线：照旧转发，缓存一个字都不该出现。
    const online = await rawRequest('/api/mobile/v1/sessions', { 'x-dsh-device-credential': CREDENTIAL });
    check('宿主在线时 /sessions 照旧转发', online.status === 200 && online.body.includes('forwarded'), `${online.status} ${online.body}`);
    check('宿主在线时不带缓存标记', online.headers['x-dsh-relay-mirror'] === undefined, String(online.headers['x-dsh-relay-mirror']));

    // 宿主把镜像推上来。
    tunnel.sendJson(T.sync, 0, mirrorPayload());
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 弱网：宿主还连着，但迟迟不回头。默认 2.5 秒就该先把镜像给手机。
    SLOW = true;
    const slowCached = await timed('/api/mobile/v1/sessions', { 'x-dsh-device-credential': CREDENTIAL });
    check(
      '宿主慢但还在：到点先给镜像，不再干等',
      slowCached.status === 200 && slowCached.headers['x-dsh-relay-mirror'] === 'stale' && slowCached.elapsed < 4_000,
      `${slowCached.status} elapsed=${slowCached.elapsed}ms mirror=${slowCached.headers['x-dsh-relay-mirror']}`,
    );
    check(
      '弱网兜底之后宿主那份不再占着连接（取消上游）',
      slowCached.body.includes('"stale":true'),
      slowCached.body.slice(0, 120),
    );

    // 兜底只对「默认视图的列表读」生效：同样的慢宿主，普通路径照样等它。
    const slowPlain = await timed('/echo', {});
    check(
      '别的路径照旧等宿主（兜底不越界）',
      slowPlain.status === 200 && slowPlain.elapsed >= SLOW_MS - 500 && slowPlain.headers['x-dsh-relay-mirror'] === undefined,
      `${slowPlain.status} elapsed=${slowPlain.elapsed}ms`,
    );
    SLOW = false;

    // 然后让宿主掉线，验另一半：隧道不在时直接用镜像。
    tunnel.close();
    tunnel = null;
    await waitForTunnelGone();

    const offline = await rawRequest('/anything');
    check('宿主离线后普通路径回 503', offline.status === 503, `${offline.status} ${offline.body}`);

    const cached = await rawRequest('/api/mobile/v1/sessions', { 'x-dsh-device-credential': CREDENTIAL });
    const cachedBody = (() => { try { return JSON.parse(cached.body); } catch { return {}; } })();
    check('宿主离线时 /sessions 从镜像回 200', cached.status === 200, `${cached.status} ${cached.body.slice(0, 120)}`);
    check('缓存响应如实标成 stale', cachedBody.stale === true, cached.body.slice(0, 120));
    check('缓存带着自己的缓存标记头', cached.headers['x-dsh-relay-mirror'] === 'stale', String(cached.headers['x-dsh-relay-mirror']));
    check('缓存里是宿主最后推的那份清单', Array.isArray(cachedBody.items) && cachedBody.items[0]?.title === '离线还看得见', cached.body.slice(0, 120));
    check('缓存不失真地带上 revision', cachedBody.revision === SESSIONS_REVISION, String(cachedBody.revision));

    const workspaces = await rawRequest('/api/mobile/v1/workspaces', { 'x-dsh-device-credential': CREDENTIAL });
    const workspacesBody = (() => { try { return JSON.parse(workspaces.body); } catch { return {}; } })();
    check('工作区同样能从镜像回', workspaces.status === 200 && workspacesBody.stale === true, `${workspaces.status} ${workspaces.body.slice(0, 120)}`);

    const unchanged = await rawRequest(`/api/mobile/v1/sessions?rev=${SESSIONS_REVISION}`, { 'x-dsh-device-credential': CREDENTIAL });
    const unchangedBody = (() => { try { return JSON.parse(unchanged.body); } catch { return {}; } })();
    check('指纹相同只回一句 unchanged', unchangedBody.unchanged === true && unchanged.body.length < 400, unchanged.body.slice(0, 120));
    check('缓存答 unchanged 时同样标成 stale', unchangedBody.stale === true, unchanged.body.slice(0, 120));

    const stranger = await rawRequest('/api/mobile/v1/sessions', { 'x-dsh-device-credential': 'dshc_not_paired' });
    check('对不上凭据就照旧 503（不新增错误面）', stranger.status === 503, `${stranger.status} ${stranger.body}`);

    const noCredential = await rawRequest('/api/mobile/v1/sessions', {});
    check('没带凭据也照旧 503', noCredential.status === 503, `${noCredential.status} ${noCredential.body}`);

    const archived = await rawRequest('/api/mobile/v1/sessions?archived=1', { 'x-dsh-device-credential': CREDENTIAL });
    check('归档子集不走缓存', archived.status === 503, `${archived.status} ${archived.body}`);

    const fresh = await rawRequest('/api/mobile/v1/sessions?fresh=1', { 'x-dsh-device-credential': CREDENTIAL });
    check('写后刷新（fresh=1）不走缓存', fresh.status === 503, `${fresh.status} ${fresh.body}`);

    // 关掉开关之后必须退回纯转发：同一份缓存一个字节都不给。
    await stopRelay(relay);
    relay = spawnRelay(binary, { MIRROR_CACHE: '0' });
    await waitForRelay(relay);

    const disabled = await rawRequest('/api/mobile/v1/sessions', { 'x-dsh-device-credential': CREDENTIAL });
    check('MIRROR_CACHE=0 时不供缓存', disabled.status === 503, `${disabled.status} ${disabled.body}`);

    // 弱网阈值可单独关掉：只留「隧道不在才兜底」那一半。
    await stopRelay(relay);
    relay = spawnRelay(binary, { MIRROR_FALLBACK_MS: '0' });
    await waitForRelay(relay);
    const fallbackTunnel = new RelayTunnel({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      instanceId: INSTANCE,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      onLog: () => {},
    });
    await fallbackTunnel.connect();
    fallbackTunnel.sendJson(T.sync, 0, mirrorPayload());
    await new Promise((resolve) => setTimeout(resolve, 150));
    SLOW = true;
    const noFallback = await timed('/api/mobile/v1/sessions', { 'x-dsh-device-credential': CREDENTIAL });
    check(
      'MIRROR_FALLBACK_MS=0 时宿主慢也照旧等',
      noFallback.status === 200 && noFallback.elapsed >= SLOW_MS - 500 && noFallback.headers['x-dsh-relay-mirror'] === undefined,
      `${noFallback.status} elapsed=${noFallback.elapsed}ms`,
    );
    SLOW = false;
    fallbackTunnel.close();
  } finally {
    if (tunnel) tunnel.close();
    await stopRelay(relay);
    upstream.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} 项失败：${failures.join('、')}`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
