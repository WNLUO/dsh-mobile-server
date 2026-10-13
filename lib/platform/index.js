'use strict';

/**
 * DSH 中转平台 —— 组装层。
 *
 * 平台是「中转服务的授权与收费闸门」：用户在平台上用微信登录、按设备数
 * 与月数下单支付，拿到授权码；引导界面/移动端插件用授权码绑定设备。
 * 后续中转可以据此决定是否放行某个设备。
 *
 * 它挂在 dsh-mobile-server 的同一个 HTTP 进程里（见 server.js 的挂载点），
 * 因为 nginx 的 `location /` 已经反代到中转端口，这样零 nginx 改动，
 * 而且将来「按授权放行」能在同进程内完成，不必跨服务调用。
 *
 * 对外两个前缀：
 *   /api/platform/v1/*  —— JSON API（router.js）
 *   /platform/*         —— 前端静态资源（static.js，构建产物在 public/platform）
 */

const path = require('node:path');
const { buildConfig, validateConfig } = require('./config.js');
const { openDatabase } = require('./db.js');
const { createStore } = require('./store.js');
const { createOidcClient } = require('./oidc.js');
const { createPayClient } = require('./pay.js');
const { createRouter } = require('./router.js');
const { createStaticServer } = require('./static.js');
const { sendJson } = require('./http.js');

function createPlatform(options = {}) {
  const { root = path.resolve(__dirname, '..', '..'), log = console.log, env = process.env } = options;

  const config = buildConfig({ root, env });
  if (!config.enabled) {
    return {
      enabled: false,
      config,
      handle: () => false,
      close: async () => {},
      describe: () => '平台未启用（PLATFORM_ENABLED 未开启）',
    };
  }

  const warnings = validateConfig(config);
  for (const warning of warnings) log(`[platform] 配置提醒：${warning}`);

  const db = openDatabase(config.dbPath);
  const store = createStore(db);
  const oidc = createOidcClient(config, log);
  const pay = createPayClient(config, log);
  const router = createRouter({ config, store, oidc, pay, log });
  const assets = createStaticServer({ root: config.webRoot, log });

  // 会话清理：每小时一次，避免表无限增长。
  // （login_states 由 store.createLoginState 自己顺手清过期行，不用额外扫。）
  const cleanupTimer = setInterval(() => {
    try {
      store.purgeExpiredSessions();
    } catch (error) {
      log(`[platform] 清理过期会话失败：${error.message}`);
    }
  }, 3600_000);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

  const apiPrefix = config.apiPrefix;
  const webPrefix = config.webPrefix;

  /**
   * 返回 true 表示这个请求属于平台（含已回 404），false 表示该继续走中转逻辑。
   */
  function handle(req, res, url) {
    const pathname = url.pathname;

    if (pathname === apiPrefix || pathname.startsWith(apiPrefix + '/')) {
      const subPath = pathname.slice(apiPrefix.length) || '/';
      router
        .handle(req, res, url, subPath)
        .then((handled) => {
          if (!handled) {
            sendJson(res, 404, {
              success: false,
              error: { code: 'NOT_FOUND', message: `未知的平台接口：${subPath}` },
            });
          }
        })
        .catch((error) => {
          const status = error instanceof Error && Number.isInteger(error.status) ? error.status : 500;
          const code = (error && error.code) || 'INTERNAL_ERROR';
          const message = status >= 500 ? '服务器内部错误' : error.message;
          if (status >= 500) log(`[platform] ${req.method} ${pathname} 失败：${error.stack || error.message}`);
          if (!res.headersSent) {
            sendJson(res, status, { success: false, error: { code, message } });
          } else {
            res.end();
          }
        });
      return true;
    }

    if (pathname === webPrefix || pathname.startsWith(webPrefix + '/')) {
      const subPath = pathname.slice(webPrefix.length) || '/';
      const handled = assets.handle(req, res, url, subPath);
      if (!handled) {
        sendJson(res, 404, {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: assets.exists() ? '资源不存在' : '前端尚未构建，请先执行 pnpm build',
          },
        });
      }
      return true;
    }

    return false;
  }

  function describe() {
    const ready = [];
    if (!config.oidc.clientSecret) ready.push('未配置 PLATFORM_OIDC_CLIENT_SECRET，微信登录不可用');
    if (!config.pay.pid || !config.pay.secret) ready.push('未配置 Pay 商户信息，下单不可用');
    if (!assets.exists()) ready.push(`前端产物不存在（${path.join(config.webRoot, 'index.html')}）`);
    return ready.length ? ready.join('；') : 'ok';
  }

  return {
    enabled: true,
    config,
    store,
    router,
    assets,
    handle,
    describe,
    close: async () => {
      clearInterval(cleanupTimer);
      try {
        db.close();
      } catch (error) {
        log(`[platform] 关闭数据库失败：${error.message}`);
      }
    },
  };
}

module.exports = { createPlatform };
