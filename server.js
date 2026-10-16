'use strict';

/**
 * dsh-mobile-server 中转服务器（装配层）
 *
 * 链路：手机 → 中转服务器 → 桌面隧道 → 本地 dsh web
 * 协议细节见 PROTOCOL.md。
 *
 * 职责模块见 lib/：
 *   registry.js        实例注册表 + 配对限流（持有共享 instances Map）
 *   pair.js            配对 cookie（HMAC 签名）
 *   proxy-http.js      HTTP 代理 + 隧道帧发送
 *   bridge-ws.js       WebSocket 桥接
 *   tunnel-handler.js  隧道帧分发
 *
 * 配置（环境变量）：
 *   HOST        监听地址，默认 0.0.0.0
 *   PORT        监听端口，默认 8700
 *   RELAY_SECRET 配对 cookie 签名密钥（部署时务必设置并保持不变）
 *   PAIR_TTL_SEC 配对有效期，默认 30 天
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { WebSocketServer, WebSocket } = require('ws');
const { T, encodeFrame, createFrameDecoder, parseJson, TYPE_NAME } = require('./lib/protocol.js');
const { instances, isLocked, recordFail, clearFails, log, normalizeLanMetadata } = require('./lib/registry.js');
const {
  pairedInstance,
  mobileInstance,
  authenticatedMobileInstance,
  canonicalInstance,
  setPairCookie,
  clearPairCookie,
  safeEqual,
} = require('./lib/pair.js');
const {
  proxyRequest,
  readJson,
  sendText,
  sendJson,
  sendTunnelFrame,
  releaseTunnelIds,
} = require('./lib/proxy-http.js');
const { handlePhoneWs } = require('./lib/bridge-ws.js');
const {
  failAllPending,
  handleTunnelFrame,
  loadMirrorFromDisk,
  PAIR_APPROVAL_TIMEOUT_MS,
} = require('./lib/tunnel-handler.js');
const {
  installMirror,
  mirrorSlotAt,
  applyMirrorRefresh,
  mirrorCanonicalUrl,
  slotForPath,
  isEmptyListBody,
  hasListItems,
} = require('./lib/mirror-state.js');
const { isFreshRequest } = require('./lib/fresh-request.js');
const { REGISTER_TIMEOUT_MS, MAX_FRAME_BYTES, MAX_TUNNELS, MAX_PENDING_PAIRS, TUNNEL_REGISTER_SECRET, TUNNEL_INSTANCES, TUNNEL_INSTANCES_FILE } = require('./lib/config.js');
const PLUGIN_OTA_ROOT = process.env.PLUGIN_OTA_ROOT || path.join(__dirname, 'plugin-ota');
const PLUGIN_PUBLIC_BASE_URL = process.env.PLUGIN_PUBLIC_BASE_URL || '';
const { tunnelRegistrationDecision } = require('./lib/tunnel-registration.js');
const credentials = require('../dsh-mobile-plugin/dsh-mobile-credentials/lib/credentials.js');
const diagnostics = require('./lib/diagnostics.js');
const requestTrace = require('./lib/request-trace.js');
const { createPlatform } = require('./lib/platform/index.js');

// ── 配置 ────────────────────────────────────────────────────────────
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8700);
const PLUGIN_CONTROL_TOKEN = process.env.PLUGIN_CONTROL_TOKEN || '';
/** 版本号只有一个来源（包自己的 package.json）：地址体检接口如实自报。 */
const RELAY_VERSION = require('./package.json').version;
let activeTunnels = 0;

// ── 移动端高频短请求的 TTL 缓存（防御性兜底）────────────────────────
// 会话列表与聊天增量改为轮询后是短请求；当桌面↔中转隧道短暂离线时，
// 用最近一次成功响应兜底（带 stale:true 标记），避免手机硬 502 后重连。
const responseCache = new Map();
const CACHE_TTL_MS = Number(process.env.RELAY_CACHE_TTL_MS || 30000);
const MAX_RESPONSE_CACHE_ENTRIES = 512;
const MAX_RESPONSE_CACHE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MIRROR_REFRESH_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_CACHE_TOTAL_BYTES = 16 * 1024 * 1024;
let responseCacheBytes = 0;

/** 解析 JSON，失败回 null（缓存体检用，不能让一次脏 body 把请求打挂）。 */
function safeParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function deleteCachedResponse(key) {
  const previous = responseCache.get(key);
  if (previous) responseCacheBytes -= previous.bytes;
  responseCache.delete(key);
}

function cacheResponse(key, body) {
  const bytes = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : -1;
  if (bytes < 0 || bytes > MAX_RESPONSE_CACHE_BODY_BYTES) return;
  // 空降级保护：这个 key 已经存着一份非空清单时，别用后到的空篮子把它覆盖掉。
  // serve-stale-while-revalidate 会把这份缓存再供 30s，一次「没取到」因此会被放大成
  // 30s 的权威空清单——App 侧边栏整树消失、零报错，只有下拉刷新能恢复。
  // 例外：`emptyConfirmed: true` 是插件对「这是一份合法且为空的清单」的显式断言
  // （形状异常会走 5xx 通道，见插件 sessions/workspaces 的 build*Body）。用户真的把
  // 侧栏清空时就该让这份空清单落地，否则中转会一直用旧副本顶住，手机永远看不到清空。
  try {
    const previous = responseCache.get(key);
    const next = safeParseJson(body);
    if (previous && hasListItems(safeParseJson(previous.body)) && isEmptyListBody(next) && next.emptyConfirmed !== true) return;
  } catch { /* 解析不了就照常缓存 */ }
  deleteCachedResponse(key);
  responseCache.set(key, { body, at: Date.now(), bytes });
  responseCacheBytes += bytes;
  while (responseCache.size > MAX_RESPONSE_CACHE_ENTRIES || responseCacheBytes > MAX_RESPONSE_CACHE_TOTAL_BYTES) {
    const oldest = responseCache.keys().next().value;
    if (oldest === undefined) break;
    deleteCachedResponse(oldest);
  }
}

// 每个 key 至多一个后台刷新在途，避免并发风暴反复打桌面。
const refreshInFlight = new Set();
// 超过捕获上限的成功响应短暂冷却，避免 stale 命中对同一大响应反复整包回源。
const REFRESH_OVERFLOW_COOLDOWN_MS = 30_000;
const MAX_REFRESH_OVERFLOW_COOLDOWNS = 512;
const refreshOverflowCooldowns = new Map();
function isRefreshOverflowCoolingDown(key, now = Date.now()) {
  const until = refreshOverflowCooldowns.get(key);
  if (until == null) return false;
  if (until > now) return true;
  refreshOverflowCooldowns.delete(key);
  return false;
}
function noteRefreshOverflow(key, now = Date.now()) {
  for (const [candidate, until] of refreshOverflowCooldowns) {
    if (until <= now) refreshOverflowCooldowns.delete(candidate);
  }
  if (!refreshOverflowCooldowns.has(key) && refreshOverflowCooldowns.size >= MAX_REFRESH_OVERFLOW_COOLDOWNS) {
    refreshOverflowCooldowns.delete(refreshOverflowCooldowns.keys().next().value);
  }
  refreshOverflowCooldowns.delete(key);
  refreshOverflowCooldowns.set(key, now + REFRESH_OVERFLOW_COOLDOWN_MS);
}
// 可缓存路由与镜像槽位是同一份名单：统一由 mirror-state 的 slotForPath 判定，
// 避免两处名单漂移导致「某条路由进了缓存却没有对应镜像槽位」。
function cacheablePath(pathname) {
  return slotForPath(pathname) !== null;
}
// 增量水位处理后处理：与桌面端 live handleMessages 一致——应用 afterSeq，
// 只保留 seq > afterSeq 的 items，并把 lastSeq 收敛到最大过滤后的 seq（空则回退 afterSeq）。
// body 非对象 / 非 ok / 无 items 数组 / 无合法 afterSeq 时原样返回。
function applyIncrementalAfterSeq(body, afterSeq) {
  if (!body || typeof body !== 'object' || body.ok !== true) return body;
  if (afterSeq == null || !/^\d+$/.test(String(afterSeq))) return body;
  if (!Array.isArray(body.items)) return body;
  const n = Number(afterSeq);
  const filtered = body.items.filter((it) => Number(it && it.seq) > n);
  const maxSeq = filtered.reduce((m, it) => Math.max(m, Number((it && it.seq) || 0)), 0) || 0;
  // Preserve the source waterline even when this page filters every item.
  const waterline = Math.max(n, Number.isSafeInteger(Number(body.lastSeq)) ? Number(body.lastSeq) : 0, maxSeq);
  return { ...body, items: filtered, lastSeq: waterline };
}
function proxyCached(inst, req, res, options) {
  const key = `${inst.instanceId}::${req.url}`;
  // 桌面镜像缓存：桌面经隧道主动推来的 sessions/workspaces 快照，直接回给手机，
  // 手机不再打桌面。镜像过期则回源（走下面的代理/缓存）。
  const url = new URL(req.url, 'http://relay.local');
  const pathname = url.pathname;
  const started = Date.now();
  const sessionId = url.searchParams.get('sessionId') || undefined;
  const method = req.method;
  // Only requests carrying a live Relay device credential may be served from the
  // mirror/response cache. A LAN-paired session authenticates with the host
  // bearer token, which the Relay cannot verify — it must reach the Desktop so
  // that revocation and authorization are enforced upstream.
  // 凭据挂在请求视图上（见 pair.js requestView），实例本体没有该字段。
  //
  // `?fresh=1` 是移动端从「被冻结/被污染的代读副本」里脱身的唯一手段（写操作后的
  // 读己所写刷新，以及用户下拉刷新），绝不能被镜像或响应缓存顶掉。旧实现把带
  // fresh 的读也交给下面的镜像分支，而镜像分支只看 `inst.mirror`、与查询串无关，
  // 于是空镜像会连下拉刷新一起顶掉：侧边栏空了就是空了，30s 内谁都救不回来。
  const fresh = isFreshRequest(req.url);
  const mayServeCache = Boolean(options && options.credential) && !fresh;
  let firstHead = 0;
  const trace = (servedBy, status, stale, upstreamMs) => requestTrace.record(inst.instanceId, { route: pathname, sessionId, method, servedBy, status, latencyMs: Date.now() - started, upstreamMs: upstreamMs || 0, stale: Boolean(stale) });
  // 磁盘持久化兜底：内存无镜像时尝试从磁盘加载（隧道断开但实例仍存在时生效）
  // loadMirrorFromDisk 是同步读盘 + JSON.parse；没有镜像时会为每个请求重复执行，
  // 用一个短 TTL 的负缓存挡住「确实没有镜像」的常见情况。
  const MIRROR_DISK_MISS_TTL_MS = 10_000;
  if (mayServeCache && !inst.mirror && inst.instanceId) {
    const lastMiss = inst.mirrorDiskMissAt || 0;
    if (!lastMiss || Date.now() - lastMiss > MIRROR_DISK_MISS_TTL_MS) {
      const diskMirror = loadMirrorFromDisk(inst.instanceId);
      if (diskMirror) {
        installMirror(inst, diskMirror.mirror, diskMirror.mirrorAt);
        inst.mirrorDiskMissAt = 0;
      } else {
        inst.mirrorDiskMissAt = Date.now();
      }
    }
  }
  const mirrorSlot = slotForPath(pathname);
  if (mayServeCache && mirrorSlot && inst.mirror && typeof inst.mirror === 'object') {
    // 只要有镜像快照就直接回（不再回源到忙碌桌面）；该槽位过旧时标 stale:true。
    // 注意新鲜度按槽位算：镜像是一份复合快照，只刷新其中一个槽位不能让其余
    // 仍然冻结的槽位一起变「新鲜」。
    const mirrorStale = Date.now() - mirrorSlotAt(inst, mirrorSlot, sessionId) > CACHE_TTL_MS;
    let mirrorBody;
    let mirrorCanServe = true;
    if (pathname === '/api/mobile/v1/sessions') {
      mirrorBody = inst.mirror.sessions;
    } else if (pathname === '/api/mobile/v1/workspaces') {
      mirrorBody = inst.mirror.workspaces;
    } else if (pathname === '/api/mobile/v1/session/messages') {
      const sessionId = url.searchParams.get('sessionId');
      mirrorBody = inst.mirror.messages ? inst.mirror.messages[sessionId] : undefined;
      // Mirrors are snapshots, not a historical paginator. Never answer a
      // backward page or a limit larger than the retained snapshot from it.
      if (url.searchParams.has('beforeSeq')) mirrorCanServe = false;
      const limit = url.searchParams.get('limit');
      if (limit && /^\d+$/.test(limit) && mirrorBody && Array.isArray(mirrorBody.items) && Number(limit) > mirrorBody.items.length) mirrorCanServe = false;
      if (mirrorBody && mirrorCanServe) mirrorBody = applyIncrementalAfterSeq(mirrorBody, url.searchParams.get('afterSeq'));
      else mirrorBody = undefined;
    } else if (pathname === '/api/mobile/v1/session/stats') {
      const sessionId = url.searchParams.get('sessionId');
      mirrorBody = inst.mirror.stats ? inst.mirror.stats[sessionId] : undefined;
    } else if (pathname === '/api/mobile/v1/session/models') {
      const sessionId = url.searchParams.get('sessionId');
      const models = inst.mirror.models;
      // Support per-session maps plus legacy/global model snapshots. Never fall
      // back to another session's catalog: a session with no routing data would
      // then be served the active session's models as if they were its own.
      mirrorBody = models && models.ok === true
        ? models
        : (models ? (models[sessionId] || models.global || models.default) : undefined);
    }
    if (mirrorBody && mirrorBody.ok) {
      trace('mirror', 200, mirrorStale, 0);
      if (mirrorStale) {
        // 后台刷新必须把新鲜 body 写回镜像槽位本身。旧实现只写 responseCache，
        // 而镜像分支在查 responseCache 之前就 return 了——那份「刷新」对这些路径
        // 永远读不到，冻结的镜像于是被无限期回给手机。
        void backgroundRefresh(inst, key, req.url, options, {
          cache: false,
          cacheKey: `${key}::mirror`,
          fetchUrl: mirrorCanonicalUrl(pathname, sessionId),
          onFresh: (fresh) => applyMirrorRefresh(inst, pathname, sessionId, fresh),
        });
      }
      try { return sendJson(res, 200, { ...mirrorBody, stale: mirrorStale, derived: true, servedAt: Date.now(), servedBy: 'mirror' }); } catch { /* fall through */ }
    }
  }
  // serve-stale-while-revalidate：一旦该 key 有过缓存，无论时效立即回给手机；
  // 过期才在后台限流刷新（每个 key 至多一个在途），手机永不等待慢桌面。
  const hit = mayServeCache ? responseCache.get(key) : undefined;
  if (hit) {
    const stale = (Date.now() - hit.at) > CACHE_TTL_MS;
    let served = false;
    // `derived`/`servedAt`/`servedBy` 是给手机端「数据时间」用的：这一份不是刚从桌面
    // 读到的，而是中转手里的一份代读副本，App 据此把它和实时读区分开显示。
    try { sendJson(res, 200, { ...JSON.parse(hit.body), stale, derived: true, servedAt: Date.now(), servedBy: 'cache' }); served = true; } catch { /* sendJson 抛错则回退到 live 代理 */ }
    if (stale) void backgroundRefresh(inst, key, req.url, options);
    if (served) { trace('cache', 200, stale, 0); return; }
  }
  let status = 0;
  const cacheChunks = [];
  let cacheBytes = 0;
  let cacheCaptureOpen = false;
  let cacheCaptureOverflow = false;
  let fallbackBytes = 0;
  let fallbackOverflow = false;
  const toCaptureBuffer = (chunk, encoding) => {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (typeof chunk === 'string') return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return Buffer.from(String(chunk));
  };
  const captureChunk = (chunk, encoding) => {
    if (chunk === null || typeof chunk === 'undefined' || typeof chunk === 'function') return;
    const bytes = toCaptureBuffer(chunk, encoding);
    if (!bytes.length) return;
    if (!fallbackOverflow) {
      const room = 512 - fallbackBytes;
      if (bytes.length >= room) {
        fallbackBytes = 512;
        fallbackOverflow = true;
      } else {
        fallbackBytes += bytes.length;
      }
    }
    if (cacheCaptureOpen && !cacheCaptureOverflow) {
      if (cacheBytes + bytes.length > MAX_RESPONSE_CACHE_BODY_BYTES) {
        cacheChunks.length = 0;
        cacheBytes = 0;
        cacheCaptureOverflow = true;
      } else {
        cacheChunks.push(bytes);
        cacheBytes += bytes.length;
      }
    }
  };
  const wrapped = new Proxy(res, {
    get(t, prop) {
      if (prop === 'writeHead') return (...args) => {
        const [nextStatus] = args;
        if (!firstHead) firstHead = Date.now();
        status = nextStatus || t.statusCode || 200;
        cacheCaptureOpen = status === 200 && !fresh;
        return t.writeHead(...args);
      };
      if (prop === 'write') return (...args) => {
        if (!firstHead) firstHead = Date.now();
        if (status === 0) status = t.statusCode || 200;
        cacheCaptureOpen = status === 200 && !fresh;
        captureChunk(args[0], args[1]);
        return t.write(...args);
      };
      if (prop === 'end') return (...args) => {
        const hasChunk = args[0] !== null && typeof args[0] !== 'undefined' && typeof args[0] !== 'function';
        if (hasChunk) {
          if (!firstHead) firstHead = Date.now();
          if (status === 0) status = t.statusCode || 200;
          cacheCaptureOpen = status === 200 && !fresh;
          captureChunk(args[0], args[1]);
        } else if (status === 0 && (t.statusCode !== 200 || t.headersSent)) {
          status = t.statusCode;
          cacheCaptureOpen = status === 200 && !fresh;
          if (!firstHead && t.headersSent) firstHead = Date.now();
        }
        const cacheBody = cacheCaptureOverflow || !cacheCaptureOpen
          ? null
          : Buffer.concat(cacheChunks, cacheBytes).toString('utf8');
        if (status === 200) {
          // fresh 读不写缓存：否则下一次 fresh 读会被上一次 fresh 的结果顶掉，
          // 「必须读出最新状态」名存实亡。只拼接 <=2MiB 的 JSON，其余仍原样流式转发。
          if (cacheBody !== null) {
            try { const parsed = JSON.parse(cacheBody); if (parsed && parsed.ok === true && !fresh) cacheResponse(key, cacheBody); } catch { /* non-cacheable */ }
          }
          trace('live', 200, false, firstHead ? firstHead - started : 0);
        } else if ((status >= 500 || status === 0) && !fallbackOverflow && fallbackBytes < 512) {
          const hit = responseCache.get(key);
          if (hit) {
            try {
              t.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
              t.end(JSON.stringify({ ...JSON.parse(hit.body), stale: true, derived: true, servedAt: Date.now(), servedBy: 'cache' }));
              trace('live', status, true, firstHead ? firstHead - started : 0);
              return t;
            } catch { /* original failure body wins */ }
          }
          trace('live', status, true, firstHead ? firstHead - started : 0);
        }
        return t.end(...args);
      };
      const v = Reflect.get(t, prop);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return proxyRequest(inst, req, wrapped, options);
}

// 后台刷新（serve-stale-while-revalidate）：stale 命中后，用独立于手机 req/res 的
// 假请求/假响应把缓存重新打到桌面一次。只更新缓存，绝不再碰手机连接。
// refreshInFlight 保证每个 key 至多一个在途，避免并发刷新风暴。
//
// hooks（可选）：
//   cacheKey  在途去重用的 key（默认 key）——镜像刷新与响应缓存刷新即使同 URL 也各算一路。
//   fetchUrl  实际回源的 URL（默认 reqUrl）——镜像刷新要丢掉分页参数，取整份快照。
//   cache     false 时不写 responseCache（镜像刷新由 onFresh 自行落位）。
//   onFresh   回源成功（200 且 ok:true）时收到解析后的 body，用于写回镜像槽位。
function backgroundRefresh(inst, key, reqUrl, options, hooks) {
  const refreshKey = (hooks && hooks.cacheKey) || key;
  const fetchUrl = (hooks && hooks.fetchUrl) || reqUrl;
  const writeCache = !hooks || hooks.cache !== false;
  if (refreshInFlight.has(refreshKey) || isRefreshOverflowCoolingDown(refreshKey)) return;
  refreshInFlight.add(refreshKey);
  let done = false;
  const finish = () => { if (!done) { done = true; refreshInFlight.delete(refreshKey); } };
  try {
    const backendReq = new EventEmitter();
    backendReq.method = 'GET';
    backendReq.headers = (options && options.headers) || {};
    backendReq.url = fetchUrl;
    backendReq.destroy = () => {};
    let status = 0;
    const chunks = [];
    let capturedBytes = 0;
    let captureOverflow = false;
    const captureLimit = hooks && typeof hooks.onFresh === 'function'
      ? MAX_MIRROR_REFRESH_BODY_BYTES
      : MAX_RESPONSE_CACHE_BODY_BYTES;
    const capture = (chunk) => {
      if (status !== 200 || captureOverflow || chunk === null || typeof chunk === 'undefined' || typeof chunk === 'function') return;
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : (ArrayBuffer.isView(chunk)
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : Buffer.from(String(chunk)));
      if (capturedBytes + bytes.length > captureLimit) {
        chunks.length = 0;
        capturedBytes = 0;
        captureOverflow = true;
        noteRefreshOverflow(refreshKey);
        return;
      }
      chunks.push(bytes);
      capturedBytes += bytes.length;
    };
    const sinkRes = new EventEmitter();
    sinkRes.writeHead = (s) => { status = s; return sinkRes; };
    sinkRes.write = (c) => { capture(c); return true; };
    sinkRes.end = (c) => {
      capture(c);
      if (status === 200 && !captureOverflow) {
        const body = Buffer.concat(chunks, capturedBytes).toString('utf8');
        try {
          const parsed = JSON.parse(body);
          if (parsed && parsed.ok === true) {
            refreshOverflowCooldowns.delete(refreshKey);
            if (writeCache) cacheResponse(key, body);
            if (hooks && typeof hooks.onFresh === 'function') hooks.onFresh(parsed);
          }
        } catch { /* non-cacheable */ }
      }
      finish();
    };
    sinkRes.destroy = () => finish();
    queueMicrotask(() => backendReq.emit('end'));
    proxyRequest(inst, backendReq, sinkRes, options);
  } catch (e) {
    try { finish(); } catch { /* ignore */ }
  }
}

function controlAuthorized(req) {
  if (!PLUGIN_CONTROL_TOKEN) return false;
  const value = req.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') && safeEqual(value.slice(7), PLUGIN_CONTROL_TOKEN);
}
// A corrupt/unreadable index.json is a server fault, not a bad client request:
// plugin-ota tags it OTA_INDEX_UNAVAILABLE. Surface it as 5xx so an operator sees
// the outage instead of a plausible-looking empty catalog.
function readRequestJson(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size > limit) reject(new Error('request body too large')); else chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}
/**
 * 中转侧的桌面插件控制面（`/api/desktop-plugins/control/*`）。
 *
 * 插件仍以 npm 为正式分发源；此处仅恢复独立的设备 OTA 包发布、stable 查询与下载。
 * 发布只接受 Bearer 控制 token 和完整 npm tgz，物料与版本索引落在 PLUGIN_OTA_ROOT。
 * 同路径前缀下的设备在线/配对统计、诊断、请求轨迹与镜像快照仍是运维观测接口。
 */
const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const PLUGIN_PLATFORM_PATTERN = /^[a-z0-9_-]{1,32}$/;
const PLUGIN_MAX_TGZ_BYTES = 128 * 1024 * 1024;

function validPluginVersion(value) {
  if (!PLUGIN_VERSION_PATTERN.test(value || '')) return false;
  return value.split('.').every((part) => Number(part) <= 999);
}
function comparePluginVersions(a, b) {
  const parse = (value) => {
    const [core, suffix = ''] = value.split('-', 2);
    return { core: core.split('.').map(Number), suffix };
  };
  const left = parse(a); const right = parse(b);
  for (let i = 0; i < 3; i += 1) if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  if (!left.suffix && right.suffix) return 1;
  if (left.suffix && !right.suffix) return -1;
  return left.suffix.localeCompare(right.suffix);
}
function pluginOtaIndexFile() { return path.join(PLUGIN_OTA_ROOT, 'releases.json'); }
function pluginOtaAssetFile(platform, version) { return path.join(PLUGIN_OTA_ROOT, 'releases', platform, `${version}.tgz`); }
function readPluginOtaIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(pluginOtaIndexFile(), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.releases && typeof parsed.releases === 'object' ? parsed : { releases: {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { releases: {} };
    throw error;
  }
}
function validatePluginTarball(buffer, version) {
  const tar = zlib.gunzipSync(buffer, { maxOutputLength: 256 * 1024 * 1024 });
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString().replace(/\0.*$/, '');
    const entryName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('invalid npm tarball');
    if (entryName === 'package/package.json') {
      const metadata = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString('utf8'));
      if (metadata.name !== 'dsh-mobile-plugin' || metadata.version !== version) throw new Error('tarball package name/version does not match release');
      return;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('npm tarball package.json not found');
}
function readRequestBuffer(req, limit = PLUGIN_MAX_TGZ_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let settled = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { settled = true; reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) resolve(Buffer.concat(chunks)); });
    req.on('error', (error) => { if (!settled) reject(error); });
  });
}
function pluginAssetUrl(req, platform, version) {
  let base = PLUGIN_PUBLIC_BASE_URL;
  if (!base) {
    const host = req.headers.host;
    if (!host || /[\\s/@]/.test(host)) throw new Error('invalid request host');
    base = `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${host}`;
  }
  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('invalid public base URL');
  return `${parsed.origin}/api/desktop-plugins/ota/releases/${encodeURIComponent(version)}/package.tgz?platform=${encodeURIComponent(platform)}`;
}
async function handlePluginOta(req, res, url) {
  if (url.pathname.startsWith('/api/desktop-plugins/ota/releases/')) {
    const match = /^\/api\/desktop-plugins\/ota\/releases\/(\d+\.\d+\.\d+)\/package\.tgz$/.exec(url.pathname);
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (!match || !validPluginVersion(match[1])) return sendJson(res, 404, { error: 'release not found' });
    const version = match[1];
    const platform = url.searchParams.get('platform');
    if (!platform || !PLUGIN_PLATFORM_PATTERN.test(platform)) return sendJson(res, 400, { error: 'platform is required' });
    const index = readPluginOtaIndex();
    const entry = index.releases[platform]?.[version];
    if (!entry) return sendJson(res, 404, { error: 'release not found' });
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': entry.size, 'cache-control': 'public, max-age=31536000, immutable' });
    fs.createReadStream(pluginOtaAssetFile(platform, version)).pipe(res);
    return true;
  }
  if (url.pathname === '/api/desktop-plugins/ota/latest') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    const platform = url.searchParams.get('platform');
    const channel = url.searchParams.get('channel') || 'stable';
    if (!platform || !PLUGIN_PLATFORM_PATTERN.test(platform) || channel !== 'stable') return sendJson(res, 400, { error: 'invalid plugin update query' });
    const index = readPluginOtaIndex();
    const latest = Object.values(index.releases[platform] || {}).filter((release) => release.channel === channel && validPluginVersion(release.version)).sort((a, b) => comparePluginVersions(a.version, b.version)).at(-1);
    if (!latest) return sendJson(res, 404, { ok: false, error: 'release not found' });
    return sendJson(res, 200, { ok: true, data: { version: latest.version, platform, channel, packageUrl: pluginAssetUrl(req, platform, latest.version) } });
  }
  if (url.pathname.startsWith('/api/desktop-plugins/ota/')) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return sendJson(res, 404, { error: 'endpoint not found' });
  }
  if (!url.pathname.startsWith('/api/desktop-plugins/control/')) return false;
  if (!controlAuthorized(req)) return sendJson(res, 401, { error: 'control authorization required' });
  try {
    if (req.method === 'PUT' && url.pathname.startsWith('/api/desktop-plugins/control/ota/releases/')) {
      const match = /^\/api\/desktop-plugins\/control\/ota\/releases\/(\d+\.\d+\.\d+)\/package\.tgz$/.exec(url.pathname);
      const platform = url.searchParams.get('platform');
      if (!match || !validPluginVersion(match[1]) || !platform || !PLUGIN_PLATFORM_PATTERN.test(platform) || url.searchParams.get('channel') !== 'stable') return sendJson(res, 400, { error: 'invalid release path or metadata' });
      if (!/^application\/gzip$/.test(String(req.headers['content-type'] || '').split(';')[0])) return sendJson(res, 415, { error: 'content-type must be application/gzip' });
      const version = match[1];
      const body = await readRequestBuffer(req);
      if (!body.length) return sendJson(res, 400, { error: 'empty release asset' });
      try { validatePluginTarball(body, version); }
      catch (error) { return sendJson(res, 400, { error: error.message }); }
      const asset = pluginOtaAssetFile(platform, version);
      fs.mkdirSync(path.dirname(asset), { recursive: true });
      const temporary = `${asset}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporary, body, { flag: 'wx' });
      fs.renameSync(temporary, asset);
      const index = readPluginOtaIndex();
      index.releases[platform] ||= {};
      index.releases[platform][version] = { platform, version, channel: 'stable', size: body.length, publishedAt: new Date().toISOString() };
      const indexFile = pluginOtaIndexFile();
      const temporaryIndex = `${indexFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporaryIndex, JSON.stringify(index, null, 2));
      fs.renameSync(temporaryIndex, indexFile);
      return sendJson(res, 201, { release: index.releases[platform][version] });
    }
    if (req.method === 'GET' && url.pathname === '/api/desktop-plugins/control/device-stats') {
      const paired = credentials.listActive();
      const byInstance = {};
      for (const device of paired) byInstance[device.instanceId] = (byInstance[device.instanceId] || 0) + 1;
      return sendJson(res, 200, { data: { observedAt: new Date().toISOString(), onlineDesktopInstances: [...instances.values()].map((instance) => ({ instanceId: instance.instanceId, name: instance.name || '' })), onlineDesktopCount: instances.size, pairedMobileCount: paired.length, pairedMobileByInstance: byInstance } });
    }
    if (req.method === 'GET' && url.pathname === '/api/desktop-plugins/control/diagnostics') {
      const instanceId = url.searchParams.get('instance_id');
      const all = diagnostics.list();
      return sendJson(res, 200, { data: instanceId ? { [instanceId]: all[instanceId] } : all });
    }
    if (req.method === 'GET' && url.pathname === '/api/desktop-plugins/control/request-trace') {
      const instanceId = url.searchParams.get('instance_id');
      return sendJson(res, 200, { data: requestTrace.list(instanceId) });
    }
    if (req.method === 'GET' && url.pathname === '/api/desktop-plugins/control/mirror') {
      const instanceId = url.searchParams.get('instance_id');
      const out = {};
      for (const inst of instances.values()) {
        if (instanceId && inst.instanceId !== instanceId) continue;
        const m = inst.mirror;
        out[inst.instanceId] = {
          registeredAt: inst.registeredAt, lastSeen: inst.lastSeen, name: inst.name,
          mirrorAt: inst.mirrorAt || 0, mirrorAgeMs: inst.mirrorAt ? Date.now() - inst.mirrorAt : null,
          hasMirror: !!m, fields: m ? Object.keys(m).filter((k) => k !== 'sessions' && k !== 'messages' && k !== 'stats' && k !== 'workspaces') : [],
          sessions: m?.sessions?.ok === true ? { ok: true, items: Array.isArray(m.sessions.items) ? m.sessions.items.length : 0 } : m?.sessions || null,
          workspaces: m?.workspaces?.ok === true ? { ok: true, items: Array.isArray(m.workspaces.items) ? m.workspaces.items.length : 0 } : m?.workspaces || null,
          messages: m?.messages && typeof m.messages === 'object' ? Object.keys(m.messages) : null,
          stats: m?.stats && typeof m.stats === 'object' ? Object.keys(m.stats) : null,
          activeSessionId: m?.activeSessionId || null,
        };
      }
      return sendJson(res, 200, { data: out });
    }
    return sendJson(res, 404, { error: 'unknown plugin control endpoint' });
  } catch (error) { return sendJson(res, 400, { error: error.message }); }
}

// ── HTTP 服务器 ─────────────────────────────────────────────────────
// Pairing rate limits key on the client IP. Behind a TLS terminator every phone
// shares one socket address, so a single attacker could lock out everyone.
// Set TRUST_PROXY=1 only when a trusted proxy always sets X-Forwarded-For.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// DSH 中转平台（授权/收费）实例。在 start() 里才创建：模块级 require 会
// 让每个 import server.js 的测试都去打开 SQLite 文件。
let platform = null;
function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  return req.socket.remoteAddress || '';
}

// 只凭「设备凭据 + hostToken bearer」鉴权，不要求实例隧道在线。
// 诊断上报与 relay 本地监控必须在桌面离线时也能用——那正是最需要它们的场景，
// 而 authenticatedMobileInstance() 会因为 instances.get(id) 为空直接返回 null。
function credentialAuthenticated(req) {
  const id = req.headers['x-dsh-instance'];
  if (typeof id !== 'string' || !id) return null;
  const bearer = /^Bearer\s+([^\s]+)$/i.exec(String(req.headers.authorization || ''));
  if (!bearer) return null;
  const header = req.headers['x-dsh-device-credential'];
  const credential = typeof header === 'string' ? header : '';
  if (!credential) return null;
  const record = credentials.find(credential, id);
  if (!record || !safeEqual(record.hostToken, bearer[1])) return null;
  return { instanceId: id, record };
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://relay.local');
  const ip = clientIp(req);
  const secure = req.headers['x-forwarded-proto'] === 'https';

  try {
    // 健康检查
    if (url.pathname === '/healthz') return sendText(res, 200, 'ok');

    // 地址体检：手机在**配对之前**问「这个地址上是谁」，因此刻意不鉴权（宿主插件在
    // 同一路径上也未包 guarded）。回答只有服务名与版本，**不含实例信息** —— 实例信息
    // 要凭据（见下面的 connection-info）。App 靠这个字段分辨「填的是宿主还是中转」，
    // 消费方 app/src/services/viewmodels/addressProbe.ts。
    if (url.pathname === '/api/mobile/v1/health') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return sendJson(res, 200, { ok: true, service: 'dsh-mobile-relay', version: RELAY_VERSION });
    }

    // DSH 中转平台（授权/收费）：JSON API 在 /api/platform/v1/*，
    // 前端 SPA 在 /platform/*。挂在中转进程里的原因是 nginx 的
    // `location /` 已经反代到这个端口，这样零 nginx 改动；而且以后
    // 「按授权码放行设备」可以在同进程内直接查库。
    // handle() 是 async（自己负责应答），返回 true 表示已接管这个请求。
    if (platform && platform.handle(req, res, url)) return;

    // 桌面插件的运维观测面（`/api/desktop-plugins/control/*`）。插件 OTA 本身 2026-10 已删，
    // 见 handlePluginOta 的文件头。
    if (url.pathname.startsWith('/api/desktop-plugins/')) {
      // handlePluginOta 是 async：以前写成 `return void handlePluginOta(...)`，
      // 返回的 Promise 被丢弃，未匹配的路径走到 `return false` 后无人应答，
      // 请求会一直挂到客户端超时。
      handlePluginOta(req, res, url)
        .then((handled) => {
          if (handled === false && !res.headersSent) sendJson(res, 404, { error: 'endpoint not found' });
        })
        .catch((error) => {
          log('plugin ota handler error:', error.message);
          if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
          else res.destroy();
        });
      return;
    }

    // Host control endpoints are local-only. Never proxy them through the
    // relay, where a pairing cookie must remain a routing credential.
    if (url.pathname.startsWith('/api/relay/')) {
      return sendJson(res, 403, { ok: false, error: 'host control is local-only' });
    }

    // Pairing is an API only; browser GETs must never enter a web flow.
    if ((url.pathname === '/pair' || /^\/r\/[^/]+\/pair$/.test(url.pathname)) && req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    // 配对提交（配对码校验 + 桌面端弹窗授权双重确认）
    if (req.method === 'POST') {
      const m = url.pathname.match(/^\/r\/([^/]+)\/pair$/);
      if (m || url.pathname === '/pair') {
        const instanceId = m ? m[1] : null;
        return readJson(req, (body) => {
          // 实例 ID 是内部的路由键，**不是让人填的东西**（2026-10-11 用户要求：App 上不显示
          // 它，用户压根不需要知道这个概念）。所以请求可以不带它：
          //   - 带了（扫码那条路，二维码里本来就带着）→ 照旧精确定位那台机器；
          //   - 没带（手输「中转地址 + 配对码」）→ 按配对码在**在线实例**里找。
          const supplied = instanceId || (body && body.instanceId) || '';
          const code = (body && body.code) || '';
          if (!code) return sendJson(res, 400, { error: '缺少配对码' });
          // 没带 id 时这次尝试还归不到某个实例头上，限流先按 IP 记（`*` 桶）。
          const lockId = supplied || '*';
          if (isLocked(lockId, ip)) return sendJson(res, 429, { error: '尝试过于频繁，请稍后再试' });
          let inst = null;
          if (supplied) {
            inst = instances.get(supplied);
            if (!inst) return sendJson(res, 404, { error: '实例离线或不存在' });
            if (!safeEqual(inst.pairingCode, code)) {
              recordFail(lockId, ip);
              return sendJson(res, 401, { error: '配对码错误' });
            }
          } else {
            const matches = [...instances.values()].filter((candidate) => safeEqual(candidate.pairingCode, code));
            if (matches.length === 0) {
              recordFail(lockId, ip);
              return sendJson(res, 404, { error: '没有找到使用这个配对码的设备，核对一下中转地址' });
            }
            // 六位数字撞码：同一台中转上两台机器撞上同一个码。**不许替用户猜**——猜错就是
            // 把别人的机器推到另一个人的桌面上等授权。让他扫二维码（里面带着 id，精确）。
            if (matches.length > 1) return sendJson(res, 409, { error: '有多台设备用着同一个配对码，请改用二维码配对' });
            [inst] = matches;
          }
          clearFails(lockId, ip);
          if (inst.pendingPairs.size >= MAX_PENDING_PAIRS) return sendJson(res, 429, { error: '该实例待处理配对请求过多，请稍后再试' });
          // 配对码正确 → 请求桌面端弹窗授权（TeamViewer 模型）：手机必须等桌面确认
          const requestId = crypto.randomUUID();
          const pending = {
            requestId,
            res,
            secure,
            device: {
              ...(typeof body.device === 'object' && body.device ? body.device : {}),
              ip,
            },
          };
          pending.timer = setTimeout(() => {
            if (inst.pendingPairs.get(requestId) === pending) {
              inst.pendingPairs.delete(requestId);
              try {
                res.writeHead(408, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: '桌面端未响应授权请求，请重试' }));
              } catch { /* 已关闭 */ }
            }
          }, PAIR_APPROVAL_TIMEOUT_MS);
          inst.pendingPairs.set(requestId, pending);
          if (!sendTunnelFrame(inst, T.pairRequest, 0, JSON.stringify({ requestId, device: pending.device }))) {
            clearTimeout(pending.timer);
            inst.pendingPairs.delete(requestId);
            return sendJson(res, 502, { error: '桌面隧道不可用' });
          }
        }, res);
      }
    }

    // The mobile status projection must not be reachable anonymously once
    // X-Dsh-Instance can select a tunnel. The desktop plugin validates tokens
    // for all other mobile routes; status is a metadata projection, so at
    // least require the mobile Authorization contract here as well.
    if (url.pathname === '/api/mobile/v1/status' && !/^Bearer\s+[^\s]+$/i.test(String(req.headers.authorization || ''))) {
      return sendJson(res, 401, { ok: false, error: 'mobile authorization required' });
    }
    // Connection metadata is served by the relay itself and never proxied.
    if (url.pathname === '/api/mobile/v1/connection-info' && req.method === 'GET') {
      const authenticated = authenticatedMobileInstance(req);
      if (!authenticated) return sendJson(res, 401, { ok: false, error: 'mobile authorization required' });
      return sendJson(res, 200, {
        ok: true,
        instanceId: authenticated.instanceId,
        name: authenticated.name,
        lanUrls: authenticated.lanUrls || [],
        lanCandidates: authenticated.lanCandidates || [],
        updatedAt: authenticated.lastSeen,
        mirrorAt: authenticated.mirrorAt || 0,
        lastSeen: authenticated.lastSeen,
        registeredAt: authenticated.registeredAt,
      });
    }
    // Device-level SSE compatibility route. The desktop plugin exposes the
    // same path; keep this relay route so new clients work remotely while old
    // clients continue using /session/stream.
    if (url.pathname === '/api/mobile/v1/events/stream') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const sessionId = url.searchParams.get('sessionId');
      if (sessionId && sessionId.length > 256) return sendJson(res, 400, { ok: false, error: 'sessionId too long' });
      const authenticated = authenticatedMobileInstance(req);
      if (!authenticated) return sendJson(res, 401, { ok: false, error: 'mobile authorization required' });
      const upstream = new URL('/api/mobile/v1/events/stream', 'http://relay.local');
      if (sessionId) upstream.searchParams.set('sessionId', sessionId);
      const hostToken = authenticated.__deviceCredential?.hostToken;
      return proxyRequest(canonicalInstance(authenticated), req, res, {
        path: `${upstream.pathname}${upstream.search}`,
        headers: hostToken ? { authorization: `Bearer ${hostToken}` } : undefined,
      });
    }

    // Mobile API requests carry an explicit instance id because Android may
    // merge/retain a single global dsh_pair cookie across multiple pairings.
    // Prefer that id; the desktop-side Bearer token remains the authorization
    // boundary. Cookie routing remains the fallback for browser/legacy clients.
    // 但「点名了哪台设备」就必须照实回绝它离线：dsh_pair 是设备级全局槽位，
    // 多台配对时它指向最后配对的那台，回落会把离线设备的请求发给另一台在线设备，
    // 手机分不清响应来自谁（名字/图标/项目被顶成那台的），且这个错会被持久化。
    // 解析函数返回的是携带凭据的浅拷贝视图；写实例状态一律走本体，
    // 否则 mirror / mirrorAt / mirrorSlotAt / mirrorDiskMissAt 的赋值会丢在视图上。
    const declaredInstanceId = typeof req.headers['x-dsh-instance'] === 'string' ? req.headers['x-dsh-instance'].trim() : '';
    const view = mobileInstance(req) || (declaredInstanceId ? null : pairedInstance(req));
    const inst = canonicalInstance(view);
    if (url.pathname === '/api/mobile/v1/device-credential/revoke' && req.method === 'POST') {
      const instanceId = req.headers['x-dsh-instance'];
      const credential = req.headers['x-dsh-device-credential'];
      const record = typeof instanceId === 'string' && typeof credential === 'string' ? credentials.find(credential, instanceId) : null;
      // 刻意不要求桌面隧道在线：吊销只读写中转本机的凭据库，而手机删设备时
      // 桌面常常正好离线 —— 恰恰是那时候这条凭据最需要立刻失效。鉴权强度不变：
      // 出示的 dshc_ 仍是 32 字节随机密钥，find() 与 mobileInstance() 走同一套校验。
      if (!record) return sendJson(res, 401, { ok: false, error: 'invalid device credential' });
      // 同一台手机重复配对会在中转累积多条活跃凭据：issue() 刻意不按 deviceId 去重，
      // 而 App 每次配对都带上自己安装期稳定的 deviceId。只吊销手机手上这一条的话，
      // 更早那条仍能一直访问到凭据自身的 365 天过期。「删除设备」的语义是这台设备
      // 不再被信任，因此按 deviceId 整批吊销。
      const revoked = record.deviceId
        ? credentials.revokeDevice(instanceId, record.deviceId)
        : (credentials.revoke(credential, instanceId) ? 1 : 0);
      // 立即失效路由 cookie，否则签名 cookie 会一直有效到 30 天 TTL。
      clearPairCookie(res, secure);
      return sendJson(res, 200, { ok: true, revoked });
    }
    if (url.pathname === '/api/mobile/v1/diagnostics' && req.method === 'POST') {
      // 移动端连接诊断上报：只存元数据 + 最近条目，不转发到桌面。
      // 不要用 authenticatedMobileInstance()：它要求实例隧道在线，而手机
      // 恰恰是在连不上桌面（实例离线）时才会来上报诊断。
      const authenticated = credentialAuthenticated(req);
      if (!authenticated) return sendJson(res, 401, { ok: false, error: 'device credential authorization required' });
      return readJson(req, (body) => {
        diagnostics.push(authenticated.instanceId, body && body.snapshot, body && body.entries);
        return sendJson(res, 200, { ok: true });
      }, res);
    }
    if (url.pathname === '/api/mobile/v1/status' && !inst) {
      return sendJson(res, 401, { ok: false, error: 'mobile instance authorization required' });
    }

    // Relay is API-only: roots, instance pages, logout, and other web paths
    // return JSON instead of rendering or redirecting to HTML.
    if (url.pathname === '/' || /^\/r\/[^/]+\/?$/.test(url.pathname) || url.pathname === '/__logout__' || !url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, error: 'API endpoint not found' });
    }

    // Unknown API paths remain available to an authenticated desktop tunnel.
    if (!inst) return sendJson(res, 401, { ok: false, error: 'mobile instance authorization required' });
    const credential = view && view.__deviceCredential;
    // 设备凭据头必须一起回源：宿主侧（dsh-mobile-plugin/lib/mobile/auth.js:46,66-76）对
    // 「出示了本机签发凭据」的请求以 credentials.isLive(known) 为准、**不再回退 Bearer**。
    // 这份 options 会被 backgroundRefresh 复用（server.js:325 透传），此前只带
    // `Bearer hostToken`，后台刷新于是在宿主眼里退化成「宿主自己」：设备被吊销后中转仍会
    // 替它回源、宿主也拿不到「这个设备已经死了」的信号。能读到缓存/镜像的路径本来就要求
    // 凭据活着（proxyCached 需要 options.credential），这里补的是「刷新请求仍代表该设备」。
    // 只有确实出示了凭据（mobileInstance 已校验其存活）时才带，LAN 配对会话不受影响。
    const presentedCredential = req.headers['x-dsh-device-credential'];
    const forwardCredential = credential && typeof presentedCredential === 'string' && presentedCredential
      ? { 'x-dsh-device-credential': presentedCredential }
      : null;
    const proxyOptions = {
      credential,
      headers: credential?.hostToken
        ? { authorization: `Bearer ${credential.hostToken}`, ...(forwardCredential || {}) }
        : undefined,
    };
    if (req.method === 'GET' && cacheablePath(url.pathname)) return proxyCached(inst, req, res, proxyOptions);
    return proxyRequest(inst, req, res, proxyOptions);
  } catch (err) {
    log('request error:', err.message);
    try {
      sendText(res, 500, 'internal error');
    } catch { /* ignore */ }
  }
});

// ── WebSocket（隧道 + 手机桥接）────────────────────────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES + 9, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://relay.local').pathname;
  if (pathname === '/tunnel') {
    if (activeTunnels >= MAX_TUNNELS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // 名额必须在这里同步预留：handleUpgrade 的握手回调不是同步完成的，
    // 之前把 activeTunnels += 1 放在 wss.on('tunnel') 里，并发 upgrade 能越过上限。
    activeTunnels += 1;
    let handedOver = false;
    wss.handleUpgrade(req, socket, head, (ws) => {
      handedOver = true;
      wss.emit('tunnel', ws, req);
    });
    if (!handedOver) activeTunnels = Math.max(0, activeTunnels - 1);
    return;
  }
  // 手机 WS 必须携带实例、设备凭据和桌面签发的 Bearer token。
  // 配对 cookie 或裸 X-Dsh-Instance 不能升级连接。
  const inst = canonicalInstance(authenticatedMobileInstance(req));
  if (!inst) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('phone', ws, req, inst);
  });
});

const TUNNEL_HEARTBEAT_MS = 15_000;
const TUNNEL_PONG_TIMEOUT_MS = 60_000;

wss.on('tunnel', (ws, tunnelReq) => {
  // 名额已在 server.on('upgrade') 里预留，这里只负责在关闭时归还。
  let counted = true;
  let inst = null;
  let lastPong = Date.now();
  const timer = setTimeout(() => {
    try { ws.close(1008, 'register timeout'); } catch { /* ignore */ }
  }, REGISTER_TIMEOUT_MS);

  const push = createFrameDecoder((frame) => {
    if (frame.type === T.register) {
      const msg = parseJson(frame.payload);
      const { instanceId, pairingCode, name } = msg;
      const lan = normalizeLanMetadata(msg);
      if (!instanceId || typeof instanceId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(instanceId) || !/^\d{6}$/.test(String(pairingCode || '')) || (name != null && (typeof name !== 'string' || name.length > 128))) {
        try { ws.close(1008, 'bad registration'); } catch { /* ignore */ }
        return;
      }
      const prev = instances.get(instanceId);
      // 准入：共享密钥（老配置）与实例白名单（新配置）都可选，都不配才是开放模式。
      // 桌面端不需要为此配任何环境变量 —— 白名单在服务器这边维护。
      const admission = tunnelRegistrationDecision({
        instanceId,
        secret: msg.secret,
        registerSecret: TUNNEL_REGISTER_SECRET,
        instances: TUNNEL_INSTANCES,
      });
      if (!admission.ok) {
        log(`tunnel registration rejected for ${instanceId}: ${admission.reason} (${admission.detail}) remote=${tunnelReq?.socket?.remoteAddress || ''}`);
        try { ws.close(1008, admission.reason === 'unknown instance' ? 'unknown instance' : 'bad registration secret'); } catch { /* ignore */ }
        return;
      }
      if (prev && prev.tunnel !== ws) {
        // 顶替已有实例必须携带与现注册一致的配对码：配对码由桌面端生成并持久化，
        // 只有桌面端知道；不一致即视为劫持/恶意顶替，拒绝并断开。
        if (!safeEqual(String(pairingCode || ''), prev.pairingCode)) {
          try { ws.close(1008, 'bad pairing code'); } catch { /* ignore */ }
          return;
        }
        // 清理旧隧道上的 HTTP/SSE pending 请求，避免实例替换后留下孤儿连接。
        log(`tunnel replacing ${instanceId}: old ws closed (pairing match)`);
        try { failAllPending(prev, 'replaced'); } catch { /* ignore */ }
        try { prev.tunnel.close(1001, 'replaced'); } catch { /* ignore */ }
      }
      inst = {
        tunnel: ws,
        instanceId,
        pairingCode: String(pairingCode || ''),
        name: String(name || ''),
        ...lan,
        lastSeen: Date.now(),
        registeredAt: Date.now(),
        pending: new Map(),
        pendingPairs: new Map(),
      };
      instances.set(instanceId, inst);
      clearTimeout(timer);
      try {
        ws.send(encodeFrame(T.registered, 0, Buffer.alloc(0)));
      } catch { /* ignore */ }
      log(`tunnel registered: ${instanceId} (${inst.name}) remote=${tunnelReq?.socket?.remoteAddress || ''} xff=${String(tunnelReq?.headers?.['x-forwarded-for'] || '')}`);
      return;
    }
    if (!inst || inst.tunnel !== ws) return;
    // 代次守卫：本连接闭包里的 `inst` 在被新隧道顶替后仍指向旧对象，而旧对象的
    // `inst.tunnel` 正是这条旧 ws，所以上面那行拦不住它 —— 旧隧道在途的帧会继续被
    // 处理进一个已经不在 `instances` 里的孤儿实例。close 路径一直有
    // `instances.get(inst.instanceId) === inst`，帧路径此前没有。后果最重的是 T.sync：
    // 它会 `saveMirrorToDisk(inst.instanceId, …)`，而磁盘文件名只按 instanceId 取，
    // 上一代宿主的数据能覆盖新实例稍后要读的磁盘兜底镜像。
    if (instances.get(inst.instanceId) !== inst) {
      log(`tunnel frame from superseded connection dropped: instance=${inst.instanceId} type=${TYPE_NAME[frame.type] || frame.type}`);
      return;
    }
    inst.lastSeen = Date.now();
    if (frame.type === T.pong) {
      lastPong = Date.now();
      return;
    }
    if (frame.type === T.ping) {
      try { ws.send(encodeFrame(T.pong, 0, Buffer.alloc(0))); } catch { /* ignore */ }
      return;
    }
    handleTunnelFrame(inst, frame);
  }, {
    maxFrameBytes: MAX_FRAME_BYTES,
    onError: () => { try { ws.close(1009, 'frame too large'); } catch { /* ignore */ } },
  });

  ws.on('message', (data, isBinary) => push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
  ws.on('close', (code, reason) => {
    if (counted) { activeTunnels = Math.max(0, activeTunnels - 1); counted = false; }
    clearTimeout(timer);
    clearInterval(heartbeat);
    if (inst && instances.get(inst.instanceId) === inst) {
      failAllPending(inst, `tunnel closed ${code} ${reason || ''}`);
      instances.delete(inst.instanceId);
      releaseTunnelIds(inst.instanceId);
      log(`tunnel closed: ${inst.instanceId} code=${code} reason=${String(reason || '').slice(0, 160)}`);
    } else {
      const prev = inst ? inst.instanceId : (instances.get('') ? '' : 'unknown');
      log(`tunnel close (unregistered) code=${code} reason=${String(reason || '').slice(0, 160)}`);
    }
  });
  ws.on('error', (err) => { log(`tunnel ws error: ${err && err.message ? err.message : String(err)}`); });

  // 隧道心跳：定期发应用层 ping；桌面端回 pong（协议 v2），长时间未收到视为死链
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastPong > TUNNEL_PONG_TIMEOUT_MS) {
      log('tunnel heartbeat timeout, terminating');
      try { ws.terminate(); } catch { /* ignore */ }
      return;
    }
    try { ws.send(encodeFrame(T.ping, 0, Buffer.alloc(0))); } catch { /* ignore */ }
  }, TUNNEL_HEARTBEAT_MS);
});

wss.on('phone', (ws, req, inst) => {
  handlePhoneWs(ws, req, inst);
});

function start(options = {}) {
  const host = options.host || HOST;
  const port = options.port == null ? PORT : Number(options.port);

  // 平台是可选组件：默认关（PLATFORM_ENABLED=1 才起），配置不全或开关关掉时不能拖垮中转本体。
  // 这里不预判环境变量，由 createPlatform 自己判——省得开关语义散在两处（见 lib/platform/config.js）。
  if (!platform) {
    try {
      const created = createPlatform({ log });
      if (created.enabled) {
        platform = created;
        log(`[platform] enabled: api=${created.config.apiPrefix} web=${created.config.webPrefix} db=${created.config.dbPath} (${created.describe()})`);
      }
    } catch (error) {
      platform = null;
      log(`[platform] 初始化失败，平台已禁用：${error.message}`);
    }
  }

  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      log(`dsh-mobile-server listening on http://${host}:${address?.port || port}`);
      log(`tunnel registration: ${tunnelRegistrationDecision({ instanceId: '', registerSecret: TUNNEL_REGISTER_SECRET, instances: TUNNEL_INSTANCES }).mode}${TUNNEL_INSTANCES.size > 0 ? ` (${TUNNEL_INSTANCES.size} instance(s) from ${TUNNEL_INSTANCES_FILE})` : ' (no allowlist file: anyone may claim a free instanceId)'}`);
      resolve({ host, port: address?.port || port });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function stop() {
  for (const client of wss.clients) {
    try { client.close(1001, 'server shutting down'); } catch { /* ignore */ }
  }
  for (const inst of instances.values()) {
    try { failAllPending(inst, 'relay shutting down'); } catch { /* ignore */ }
    try { inst.tunnel.close(1001, 'server shutting down'); } catch { /* ignore */ }
    releaseTunnelIds(inst.instanceId);
  }
  instances.clear();
  const closingPlatform = platform;
  platform = null;
  return new Promise((resolve) => {
    const finish = () => {
      // 请求追踪是 1s 防抖落盘（saveTimer 还被 unref 了），退出时不刷盘就会丢掉
      // 最后一秒的条目 —— 而 request-trace.js 文件头写明的意图正是「重启不丢」。
      requestTrace.flush();
      if (closingPlatform) {
        closingPlatform.close().catch((error) => log('[platform] close failed:', error.message)).finally(resolve);
        return;
      }
      resolve();
    };
    if (!server.listening) return finish();
    server.close(finish);
  });
}

if (require.main === module) {
  start().catch((error) => { log('startup failed:', error.message); process.exitCode = 1; });
  const shutdown = () => { stop().finally(() => process.exit(0)); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

module.exports = { server, instances, start, stop };