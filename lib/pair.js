'use strict';

/**
 * 配对 cookie（HMAC 签名）+ 配对实例解析。
 *
 * 依赖方向：registry（本模块的实例 Map）。
 */

const crypto = require('node:crypto');
const { instances } = require('./registry.js');
const credentials = require('../../dsh-mobile-plugin/dsh-mobile-credentials/lib/credentials.js');

const { RELAY_SECRET } = require('./config.js');
const PAIR_TTL_SEC = Number(process.env.PAIR_TTL_SEC || 30 * 24 * 3600);
if (!Number.isSafeInteger(PAIR_TTL_SEC) || PAIR_TTL_SEC < 60) throw new Error('PAIR_TTL_SEC must be at least 60 seconds');

// ── 配对 cookie（HMAC 签名）─────────────────────────────────────────
// The cookie is a routing credential, but it must still be revocable: it carries
// the deviceId so `pairedInstance` can check the credential store, instead of
// trusting a signature that stays valid for the full 30-day TTL after a revoke.
function signPair(instanceId, deviceId) {
  const exp = Math.floor(Date.now() / 1000) + PAIR_TTL_SEC;
  const device = Buffer.from(String(deviceId || ''), 'utf8').toString('base64url');
  const payload = `${instanceId}.${device}.${exp}`;
  const sig = crypto.createHmac('sha256', RELAY_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
/**
 * 每个请求拿到一份浅拷贝「视图」，唯一目的是挂上本次请求的 __deviceCredential。
 *
 * 浅拷贝按值复制 nextId / mirror / mirrorAt / mirrorSlotAt / mirrorDiskMissAt 这类
 * 标量或引用，于是**视图上的赋值会落在临时对象上被静默丢弃**。已经踩过两次：
 *   1. 隧道帧 id 恒为 1（nextId 按值复制）→ 并发请求在 inst.pending 里互相顶掉条目，
 *      流式响应的条目被后来的请求删掉，客户端只收到 preamble；
 *   2. 磁盘兜底镜像永远装不进内存（installMirror 重赋值 mirror 丢了）、
 *      mirrorDiskMissAt 负缓存永远不生效（每个请求都同步读盘 + JSON.parse）。
 * 因此视图带一个不可枚举的 __canonical 回指，凡是**写实例状态**的地方一律先用
 * canonicalInstance() 取回本体；只读的请求级字段（__deviceCredential）留在视图上。
 */
function requestView(inst, record) {
  const view = { ...inst, __deviceCredential: record };
  Object.defineProperty(view, '__canonical', { value: inst, enumerable: false });
  return view;
}
/** 把请求视图还原成实例本体；不是视图（或为 null）时原样返回。 */
function canonicalInstance(inst) {
  return (inst && inst.__canonical) || inst;
}
/** 从请求解析出已配对实例；未配对 / 签名失效 / 凭据已吊销返回 null */
function pairedInstance(req) {
  const value = parseCookies(req.headers.cookie).dsh_pair;
  if (!value) return null;
  const [instanceId, device, expStr, sig] = value.split('.');
  if (!instanceId || !device || !expStr || !sig) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const payload = `${instanceId}.${device}.${expStr}`;
  const expect = crypto.createHmac('sha256', RELAY_SECRET).update(payload).digest('base64url');
  if (!safeEqual(expect, sig)) return null;
  const deviceId = Buffer.from(device, 'base64url').toString('utf8');
  // Revocation and expiry live in the credential store. A signed cookie alone
  // must not outlive the credential it represents.
  const record = credentials.isActiveDevice(instanceId, deviceId);
  if (!record) return null;
  const inst = instances.get(instanceId) || null;
  if (!inst) return null;
  return requestView(inst, record);
}
/**
 * 移动 API 路径的路由兜底：RN 的 fetch 在部分平台（如 Android）可能丢弃
 * 手动设置的 Cookie 头，App 会额外携带 X-Dsh-Instance。仅对 /api/mobile/*
 * 生效；安全边界仍是桌面端对 Bearer token 的校验，这里只负责找到隧道。
 */
function mobileInstance(req) {
  const url = new URL(req.url, 'http://relay.local');
  if (!url.pathname.startsWith('/api/mobile/')) return null;
  const id = req.headers['x-dsh-instance'];
  if (!id || typeof id !== 'string') return null;
  const inst = instances.get(id) || null;
  if (!inst) return null;
  const header = req.headers['x-dsh-device-credential'];
  const auth = String(req.headers.authorization || '');
  const presented = typeof header === 'string' && header ? header : '';
  if (presented) {
    // A Relay-issued credential was presented, so it must still be live.
    // Falling back to the bearer route here would let a revoked (or expired)
    // device keep reading the Relay's cached mirror.
    const record = credentials.find(presented, id);
    return record ? requestView(inst, record) : null;
  }
  // A LAN-paired session has no Relay credential; route it and let the Desktop
  // validate the host-issued bearer token upstream.
  if (/^Bearer\s+[^\s]+$/i.test(auth)) return inst;
  // No credential of any kind: never expose instance metadata or cached mirrors.
  return null;
}
/** Mobile authentication for metadata and WebSocket entry points.
 * New clients may be checked against a Relay-side device credential; legacy/LAN
 * sessions are routed by instance and validated by the Desktop bearer upstream. */
function authenticatedMobileInstance(req) {
  const id = req.headers['x-dsh-instance'];
  const deviceCredential = req.headers['x-dsh-device-credential'];
  const auth = /^Bearer\s+([^\s]+)$/i.exec(String(req.headers.authorization || ''));
  if (typeof id !== 'string' || !auth) return null;
  const inst = instances.get(id);
  if (!inst) return null;
  if (typeof deviceCredential === 'string' && deviceCredential) {
    const record = credentials.find(deviceCredential, id);
    // The phone presented a Relay credential that is revoked, expired, or
    // unknown: reject instead of falling through to the bearer route.
    if (!record) return null;
    if (!safeEqual(record.hostToken, auth[1]) && !safeEqual(deviceCredential, auth[1])) return null;
    return requestView(inst, record);
  }
  // LAN-paired sessions do not exist in the Relay credential store, so route
  // them and let Desktop validate the host-issued bearer token upstream.
  return mobileInstance(req);
}
function setPairCookie(res, instanceId, deviceId, secure) {
  const value = signPair(instanceId, deviceId);
  res.setHeader(
    'set-cookie',
    `dsh_pair=${value}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${PAIR_TTL_SEC}`,
  );
}
function clearPairCookie(res, secure) {
  res.setHeader('set-cookie', `dsh_pair=; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=0`);
}

module.exports = {
  signPair,
  parseCookies,
  safeEqual,
  pairedInstance,
  mobileInstance,
  authenticatedMobileInstance,
  setPairCookie,
  clearPairCookie,
  requestView,
  canonicalInstance,
  RELAY_SECRET,
  PAIR_TTL_SEC,
};
