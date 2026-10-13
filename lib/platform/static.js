'use strict';

/**
 * 平台前端的静态文件服务（SPA）。
 *
 * 前端构建产物放在 `public/platform/`（PLATFORM_WEB_ROOT），是标准的
 * Vite 输出：`index.html` + `assets/*`。因为前端用 history 路由，
 * 所有「非 /api 且没有扩展名」的路径都回落 `index.html`。
 *
 * 只读，且做路径穿越防护——这个目录是通过公网 nginx 暴露的。
 */

const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// 带指纹的产物可以长缓存；index.html 绝不缓存，否则发版后用户拿到旧壳。
const IMMUTABLE_RE = /-[A-Za-z0-9_]{8,}\.(?:js|css|woff2?|png|jpe?g|svg|webp)$/;

function createStaticServer({ root, log }) {
  const rootDir = path.resolve(root);

  function resolveFile(urlPath) {
    // decodeURIComponent 可能抛（畸形 %），交给调用方当 404 处理。
    const decoded = decodeURIComponent(urlPath);
    const normalized = path.posix.normalize(decoded).replace(/^\/+/, '');
    if (normalized.includes('..')) return null;
    const target = path.join(rootDir, normalized);
    if (target !== rootDir && !target.startsWith(rootDir + path.sep)) return null;
    return target;
  }

  function statFile(file) {
    try {
      const stat = fs.statSync(file);
      return stat.isFile() ? stat : null;
    } catch {
      return null;
    }
  }

  function sendFile(res, file, stat, status = 200) {
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': String(stat.size),
      'cache-control': IMMUTABLE_RE.test(file)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    };
    res.writeHead(status, headers);
    if (res.req && res.req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file);
    stream.on('error', (error) => {
      log(`静态文件读取失败 ${file}：${error.message}`);
      res.destroy();
    });
    stream.pipe(res);
  }

  /** 返回 true 表示已处理（含 404），false 表示这个路径不该由静态服务管。 */
  function handle(req, res, url, subPath) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const rel = subPath === undefined ? url.pathname : subPath;
    if (rel.startsWith('/api/')) return false;

    const indexFile = path.join(rootDir, 'index.html');
    const indexStat = statFile(indexFile);

    // 目录请求（/platform/ 或 /platform）直接给 index.html
    const trimmed = rel.replace(/\/+$/, '');
    if (trimmed === '' || trimmed === '/') {
      if (!indexStat) return false;
      sendFile(res, indexFile, indexStat);
      return true;
    }

    const file = resolveFile(rel);
    if (file) {
      const stat = statFile(file);
      if (stat) {
        sendFile(res, file, stat);
        return true;
      }
    }

    // history 路由回落：只有「不像文件」的路径才回落，避免把 404 的 .js 变成 HTML。
    if (!path.extname(rel) && indexStat) {
      sendFile(res, indexFile, indexStat);
      return true;
    }
    return false;
  }

  return { handle, root: rootDir, exists: () => Boolean(statFile(path.join(rootDir, 'index.html'))) };
}

module.exports = { createStaticServer };
