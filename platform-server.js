'use strict';

/**
 * 本地开发入口：只跑「中转 + 平台」的同一个 HTTP 进程，不连生产。
 *
 *   node platform-server.js            # 默认 http://127.0.0.1:8790
 *   PORT=8790 node platform-server.js
 *
 * 会读取同目录下的 `.env.platform`（若存在）来注入 PLATFORM_* 变量，
 * 省得每次手敲一长串。生产不走这个入口——生产是 systemd 起的 server.js。
 *
 * 注意：微信登录在本地跑不通。登录系统的生产环境只放行 https 的
 * redirect_uri（见 lib/platform/oidc.js 头部注释），本地 http 回调会被
 * /oauth2/authorize 直接 401。本地只能预览前端壳子与未登录页面。
 */

const fs = require('node:fs');
const path = require('node:path');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const envFile = process.env.PLATFORM_ENV_FILE || path.join(__dirname, '.env.platform');
loadEnvFile(envFile);

process.env.PLATFORM_ENABLED = process.env.PLATFORM_ENABLED || '1';
process.env.PORT = process.env.PORT || '8790';
// 本地 base url 影响 redirect_uri 与 notify_url；登录系统的白名单里已经
// 登记过 http://127.0.0.1:8790/... 这条（虽然生产环境不会放行 http）。
process.env.PLATFORM_PUBLIC_BASE_URL = process.env.PLATFORM_PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT}`;
process.env.PLATFORM_SESSION_SECRET =
  process.env.PLATFORM_SESSION_SECRET || 'local-dev-session-secret-not-for-production';

const { start, stop } = require('./server.js');

start()
  .then(({ host, port }) => {
    const base = `http://127.0.0.1:${port}`;
    console.log(`\n  中转 + 平台已启动`);
    console.log(`  平台前端   ${base}/platform/`);
    console.log(`  平台 API   ${base}/api/platform/v1/health`);
    console.log(`  中转健康   ${base}/healthz\n`);
  })
  .catch((error) => {
    console.error('启动失败：', error.message);
    process.exitCode = 1;
  });

const shutdown = () => {
  stop().finally(() => process.exit(0));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
