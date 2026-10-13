'use strict';

/**
 * 中转服务器的环境变量配置与转发头白名单（限额的唯一真源）。
 *
 * 为什么所有可调项都走 `positiveInt`：越界直接抛错、**不是** clamp。一个手滑的 0 或负值
 * 若被静默接受，表现是限额「关掉」而不是「设错」（例如 MAX_PENDING_PER_INSTANCE=0 会让
 * 全部手机请求 429），启动即失败才留得下现场。同理 production 下 RELAY_SECRET 短于 32
 * 字符也拒绝启动，避免带着 dev 默认密钥上线。
 *
 * `REQUEST_HEADERS` 是「手机 → 宿主」的头白名单：漏一个头就是**静默丢**（宿主看到的行为
 * 与「App 没发这个头」完全一样），新增自定义头必须同时进这里 —— 设备凭据那一条见下方注释。
 */

const { loadInstanceAllowlist, defaultInstanceAllowlistFile } = require('./tunnel-registration.js');

function positiveInt(name, fallback, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

const production = process.env.NODE_ENV === 'production';
const secret = process.env.RELAY_SECRET || '';
if (production && secret.length < 32) {
  throw new Error('RELAY_SECRET must be set to at least 32 characters in production');
}
const RELAY_SECRET = secret || (production ? '' : 'dev-only-relay-secret-not-for-production');

const REQUEST_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language', 'authorization', 'cache-control',
  'content-type', 'if-none-match', 'if-modified-since', 'origin', 'user-agent',
  'x-request-id',
  // 设备凭据必须过中转。桌面端拿 `X-Dsh-Device-Credential` 判「这台设备还活着吗」：
  // 一经吊销/过期就立刻拒，且**不**回落到一年有效的 HMAC token。中转若把它吃掉，
  // 吊销就只在局域网直连那条路上生效，公网配对——也就是主要用法——要等 token 自然
  // 到期才失效。只加这一条：`cookie` 之类的浏览器状态没有理由过中转。
  'x-dsh-device-credential',
]);
const RESPONSE_HEADERS = new Set([
  'cache-control', 'content-encoding', 'content-language', 'content-length',
  'content-type', 'etag', 'expires', 'last-modified', 'location', 'retry-after',
  'x-accel-buffering',
]);

module.exports = {
  production,
  RELAY_SECRET,
  REGISTER_TIMEOUT_MS: positiveInt('REGISTER_TIMEOUT_MS', 10_000, 120_000),
  MAX_FRAME_BYTES: positiveInt('MAX_FRAME_BYTES', 8 * 1024 * 1024, 64 * 1024 * 1024),
  MAX_BODY_BYTES: positiveInt('MAX_BODY_BYTES', 50 * 1024 * 1024, 256 * 1024 * 1024),
  MAX_PENDING_PER_INSTANCE: positiveInt('MAX_PENDING_PER_INSTANCE', 128, 10_000),
  MAX_PENDING_PAIRS: positiveInt('MAX_PENDING_PAIRS', 32, 10_000),
  MAX_PENDING_GLOBAL: positiveInt('MAX_PENDING_GLOBAL', 2048, 100_000),
  MAX_WS_CONNECTIONS: positiveInt('MAX_WS_CONNECTIONS', 256, 10_000),
  MAX_WS_MESSAGE_BYTES: positiveInt('MAX_WS_MESSAGE_BYTES', 8 * 1024 * 1024, 64 * 1024 * 1024),
  MAX_WS_QUEUE_BYTES: positiveInt('MAX_WS_QUEUE_BYTES', 16 * 1024 * 1024, 128 * 1024 * 1024),
  // 手机侧 WS 保活：ping 周期 + 「多久没 pong 也没上行帧」就认定半开（与隧道心跳同形，
  // 见 server.js 的 TUNNEL_HEARTBEAT_MS/TUNNEL_PONG_TIMEOUT_MS）。半开的手机 WS 会一直
  // 停在 OPEN，永久占着 pending 名额与 MAX_WS_CONNECTIONS，手机重连还会继续被拒。
  WS_HEARTBEAT_MS: positiveInt('WS_HEARTBEAT_MS', 15_000, 600_000),
  WS_PONG_TIMEOUT_MS: positiveInt('WS_PONG_TIMEOUT_MS', 60_000, 600_000),
  // Keep long-lived streams from exhausting the per-instance HTTP request budget.
  // One active chat needs one stream; excess reconnects should fail fast so
  // short model/status requests retain capacity.
  MAX_SSE_CONNECTIONS: positiveInt('MAX_SSE_CONNECTIONS', 16, 10_000),
  // Bound requests waiting for a host response header. Applies to SSE too: the desktop
  // must answer httpRequest with httpHead either way (the plugin writes the SSE head
  // before producing anything), and a host that never answers would otherwise pin the
  // entry forever — the post-head SSE idle sentinel arms only after httpHead, so it
  // cannot cover that gap.
  UPSTREAM_HEADER_TIMEOUT_MS: positiveInt('UPSTREAM_HEADER_TIMEOUT_MS', 30_000, 300_000),
  DEBUG_SSE: /^(1|true|yes)$/i.test(process.env.DEBUG_SSE || ''),
  MAX_TUNNELS: positiveInt('MAX_TUNNELS', 256, 10_000),
  MIRROR_DATA_DIR: process.env.MIRROR_DATA_DIR || '',
  // 可选的隧道注册共享密钥。配对码只在「已注册实例之间」比对，对某个
  // instanceId 的首次注册没有任何认证；不设密钥时任何人都能抢先注册一个
  // instanceId，把真宿主顶成 1008 bad pairing code。生产环境建议配合桌面端
  // 的 DSH_RELAY_REGISTER_SECRET 一起设置。
  TUNNEL_REGISTER_SECRET: process.env.TUNNEL_REGISTER_SECRET || '',
  // 白名单准入：桌面端**零配置**，秘书由服务器管理员维护。文件不存在 = 不限制
  // （与「没设共享密钥」同级的开放模式），存在但内容不合法直接启动失败，
  // 免得一次手滑把准入静默降级。
  TUNNEL_INSTANCES_FILE: process.env.TUNNEL_INSTANCES_FILE || defaultInstanceAllowlistFile(__dirname + '/..'),
  TUNNEL_INSTANCES: loadInstanceAllowlist(process.env.TUNNEL_INSTANCES_FILE || defaultInstanceAllowlistFile(__dirname + '/..')),
  REQUEST_HEADERS,
  RESPONSE_HEADERS,
};
