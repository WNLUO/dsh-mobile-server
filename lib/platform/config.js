'use strict';

/**
 * 平台（DSH 中转授权/收费）配置。
 *
 * 全部从环境变量读，前缀 PLATFORM_。生产用 systemd drop-in 的 EnvironmentFile
 * 注入，避免 `systemctl show` 泄露 secret。
 *
 * 与中转本体（server.js / lib/*）完全解耦：本模块只依赖 node 内置模块，
 * 不 import 任何中转模块，也不读 RELAY_SECRET / TUNNEL_REGISTER_SECRET。
 */

const path = require('node:path');

/** 价格：一台设备一个月多少钱（分）。用户定价 1 元/月/设备。 */
const DEFAULT_UNIT_CENTS = 100;
/** 一次最多买几个月。 */
const DEFAULT_MAX_MONTHS = 3;
/** 一次最多买几台设备。 */
const DEFAULT_MAX_DEVICES = 50;

function intEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function strEnv(env, name, fallback) {
  const raw = env[name];
  return raw === undefined || raw === '' ? fallback : raw.trim();
}

function boolEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function buildConfig(overrides = {}) {
  // env 可注入，测试与本地 dev 不必污染 process.env。
  const env = overrides.env || process.env;
  const root = overrides.root ? path.resolve(overrides.root) : path.resolve(__dirname, '..', '..');
  const publicBaseUrl = (
    overrides.publicBaseUrl ||
    strEnv(env, 'PLATFORM_PUBLIC_BASE_URL', 'https://dsh-hub.wnluo.com')
  ).replace(/\/+$/, '');

  const oidcIssuer = (
    overrides.oidcIssuer ||
    strEnv(env, 'PLATFORM_OIDC_ISSUER', 'https://login.wnluo.com')
  ).replace(/\/+$/, '');

  return {
    // 默认**关**，必须显式 PLATFORM_ENABLED=1 才起平台。原因：server.js 的 start()
    // 被一堆中转测试直接调用，默认开会给每次测试都建一个 data/platform.db（真副作用）。
    // 生产与本地 dev 都显式开着（/etc/dsh-platform.env、platform-server.js）。
    enabled: overrides.enabled !== undefined ? overrides.enabled : boolEnv(env, 'PLATFORM_ENABLED', false),
    root,
    publicBaseUrl,
    /** 平台自身在公网的挂载前缀：前端 SPA 在 {publicBaseUrl}/platform/。 */
    webPrefix: strEnv(env, 'PLATFORM_WEB_PREFIX', '/platform'),
    apiPrefix: '/api/platform/v1',
    /** 静态产物目录：React 构建输出。 */
    webRoot: overrides.webRoot || strEnv(env, 'PLATFORM_WEB_ROOT', path.join(root, 'public', 'platform')),

    dbPath: overrides.dbPath || strEnv(env, 'PLATFORM_DB_PATH', path.join(root, 'data', 'platform.db')),

    /** 会话 cookie 的 HMAC 密钥；生产必须显式设置且足够长。 */
    sessionSecret: overrides.sessionSecret || strEnv(env, 'PLATFORM_SESSION_SECRET', ''),
    sessionCookie: strEnv(env, 'PLATFORM_SESSION_COOKIE', 'dsh_platform_session'),
    sessionTtlSeconds: intEnv(env, 'PLATFORM_SESSION_TTL_SECONDS', 30 * 24 * 3600),
    /** 浏览器回调后落地的 SPA 路径。 */
    postLoginPath: strEnv(env, 'PLATFORM_POST_LOGIN_PATH', '/'),

    oidc: {
      issuer: oidcIssuer,
      clientId: overrides.oidcClientId || strEnv(env, 'PLATFORM_OIDC_CLIENT_ID', 'dsh-hub-platform'),
      clientSecret: overrides.oidcClientSecret || strEnv(env, 'PLATFORM_OIDC_CLIENT_SECRET', ''),
      redirectUri:
        overrides.oidcRedirectUri ||
        strEnv(env, 'PLATFORM_OIDC_REDIRECT_URI', `${publicBaseUrl}/api/platform/v1/auth/callback`),
      scope: strEnv(env, 'PLATFORM_OIDC_SCOPE', 'openid profile wechat_identity'),
      /** 授权事务有效期：登录系统那边 transaction TTL 是 600s，这里留一点余量。 */
      stateTtlSeconds: intEnv(env, 'PLATFORM_OIDC_STATE_TTL_SECONDS', 600),
      /** 发现文档缓存时长。 */
      discoveryTtlMs: intEnv(env, 'PLATFORM_OIDC_DISCOVERY_TTL_MS', 10 * 60 * 1000),
      timeoutMs: intEnv(env, 'PLATFORM_OIDC_TIMEOUT_MS', 10_000),
    },

    pay: {
      baseUrl: (overrides.payBaseUrl || strEnv(env, 'PLATFORM_PAY_BASE_URL', 'https://pay.wnluo.com')).replace(/\/+$/, ''),
      pid: overrides.payPid || strEnv(env, 'PLATFORM_PAY_PID', ''),
      secret: overrides.paySecret || strEnv(env, 'PLATFORM_PAY_SECRET', ''),
      payType: strEnv(env, 'PLATFORM_PAY_TYPE', 'wxpay'),
      timeoutMs: intEnv(env, 'PLATFORM_PAY_TIMEOUT_MS', 10_000),
      /** 通知回调地址：Pay 必须能从公网 POST 回来。 */
      notifyPath: '/api/platform/v1/pay/notify',
    },

    pricing: {
      unitCents: intEnv(env, 'PLATFORM_PRICE_CENTS_PER_MONTH', DEFAULT_UNIT_CENTS),
      maxMonths: intEnv(env, 'PLATFORM_MAX_MONTHS', DEFAULT_MAX_MONTHS),
      maxDevices: intEnv(env, 'PLATFORM_MAX_DEVICES', DEFAULT_MAX_DEVICES),
      currency: strEnv(env, 'PLATFORM_CURRENCY', 'CNY'),
    },

    /** 逗号分隔的 OIDC sub 白名单：登录即管理员。 */
    adminSubs: (overrides.adminSubs || strEnv(env, 'PLATFORM_ADMIN_SUBS', ''))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    /**
     * 首个登录者自动成为管理员。
     *
     * 部署时没人知道主人的 OIDC sub，写不进 PLATFORM_ADMIN_SUBS；而「先登录再
     * 手动改库」需要一次人工往返。这个开关只在**库里一个管理员都没有**时生效，
     * 所以窗口期就是「平台刚上线、链接还没外传」的那段时间。
     * 一旦有了管理员（不管是这里提的还是 PLATFORM_ADMIN_SUBS 提的）就永久失效。
     */
    bootstrapFirstAdmin: boolEnv(env, 'PLATFORM_BOOTSTRAP_FIRST_ADMIN', true),

    log: typeof overrides.log === 'function' ? overrides.log : (msg) => console.log(`[platform] ${msg}`),
  };
}

/**
 * 生产环境校验。缺 secret 时不抛异常，只返回问题列表——由调用方决定是
 * 「整个平台不可用」还是「只禁用支付」。
 */
function validateConfig(config) {
  const problems = [];
  if (!config.sessionSecret || config.sessionSecret.length < 16) {
    problems.push('PLATFORM_SESSION_SECRET 未设置或过短（需 >= 16 字符）');
  }
  if (!config.oidc.clientSecret) problems.push('PLATFORM_OIDC_CLIENT_SECRET 未设置');
  if (!config.pay.pid) problems.push('PLATFORM_PAY_PID 未设置');
  if (!config.pay.secret) problems.push('PLATFORM_PAY_SECRET 未设置');
  return problems;
}

module.exports = { buildConfig, validateConfig, DEFAULT_UNIT_CENTS, DEFAULT_MAX_MONTHS, DEFAULT_MAX_DEVICES };
