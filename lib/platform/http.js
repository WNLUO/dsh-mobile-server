'use strict';

/**
 * 平台用的 HTTP 小工具。刻意不复用 lib/proxy-http.js：那边的 sendJson/sendText
 * 面向中转代理路径（带隧道语义），这里是普通站点 API。
 */

const MAX_BODY_BYTES = 256 * 1024;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message, code = 'VALIDATION_ERROR') => new HttpError(400, code, message);
const unauthorized = (message = '未登录') => new HttpError(401, 'UNAUTHORIZED', message);
const forbidden = (message = '无权访问') => new HttpError(403, 'FORBIDDEN', message);
const notFound = (message = '资源不存在') => new HttpError(404, 'NOT_FOUND', message);
const conflict = (message) => new HttpError(409, 'CONFLICT', message);

function sendJson(res, status, payload, headers = {}) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

/** 成功信封，对齐聚合登录系统的 `{"success":true,"data":...}`。 */
function sendOk(res, data, headers) {
  sendJson(res, 200, { success: true, data: data === undefined ? null : data }, headers);
}

function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
  const message = status === 500 ? '服务器内部错误' : error.message;
  sendJson(res, status, { success: false, error: { code, message } });
}

function sendRedirect(res, location, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(302, { location, 'cache-control': 'no-store', ...headers });
  res.end();
}

/** 读取请求体；超限直接断开。 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
}

/** 支付通知要按原始字节验签，所以单独给一个返回 {raw, text, json} 的读法。 */
async function readRaw(req, limit) {
  const raw = await readBody(req, limit);
  const text = raw.toString('utf8');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* 允许非 JSON，验签后再判 */ }
  return { raw, text, json };
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  return parts.join('; ');
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

/** 只允许站内相对路径，防止 ?next= 变成开放重定向。 */
function safeNextPath(value, fallback = '/') {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  if (raw.includes('\\')) return fallback;
  return raw;
}

module.exports = {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  sendJson,
  sendOk,
  sendError,
  sendRedirect,
  readBody,
  readJson,
  readRaw,
  parseCookies,
  serializeCookie,
  clientIp,
  safeNextPath,
  MAX_BODY_BYTES,
};
