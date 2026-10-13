'use strict';

/**
 * 实例注册表 + 配对限流。
 *
 * 持有模块级的实例 Map（单例，server.js 复导出同一引用）与配对码失败锁定。
 * 依赖方向：无依赖（本模块是叶子）。
 */

const PAIR_MAX_FAILS = 5;
const PAIR_LOCK_MS = 60_000;

const instances = new Map();
const pairLocks = new Map();

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// ── 配对码限流 ──────────────────────────────────────────────────────
function lockKey(instanceId, ip) {
  return `${instanceId}|${ip}`;
}
function isLocked(instanceId, ip) {
  const l = pairLocks.get(lockKey(instanceId, ip));
  return !!l && l.lockedUntil > Date.now();
}
/** Bound the lock map: an unbounded `pairLocks` grows one entry per attacker IP. */
function prunePairLocks(now) {
  if (pairLocks.size <= 1024) return;
  let budget = pairLocks.size - 512;
  for (const [key, value] of pairLocks) {
    if (budget <= 0) break;
    // Only drop entries that are neither locked nor recently failed; deleting a
    // live fail counter would let an attacker reset the lockout.
    if (value.lockedUntil <= now && now - (value.lastAt || 0) > PAIR_LOCK_MS) {
      pairLocks.delete(key);
      budget -= 1;
    }
  }
}
function recordFail(instanceId, ip) {
  const k = lockKey(instanceId, ip);
  const now = Date.now();
  const l = pairLocks.get(k) || { fails: 0, lockedUntil: 0 };
  l.fails += 1;
  l.lastAt = now;
  if (l.fails >= PAIR_MAX_FAILS) {
    l.lockedUntil = now + PAIR_LOCK_MS;
    l.fails = 0;
  }
  pairLocks.set(k, l);
  prunePairLocks(now);
}
function clearFails(instanceId, ip) {
  pairLocks.delete(lockKey(instanceId, ip));
}

// Registration metadata is advisory only. Never let it become a proxy target:
// only literal private/link-local HTTP addresses are retained for LAN hints.
function isLanUrl(value) {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const url = new URL(value);
    // LAN pairing may legitimately use https (self-signed / mkcert) and mDNS
    // names, so the old http-only + literal-IPv4 rule dropped real candidates.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password || url.search || url.hash) return false;
    // `URL#hostname` keeps the brackets on IPv6 literals, which made every
    // `::1` / `fc*` / `fd*` branch below unreachable.
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|169\.254\.)/.test(host)) return true;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (host.includes(':')) {
      // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
      return /^(fc|fd|fe8|fe9|fea|feb)/.test(host);
    }
    // mDNS / Bonjour names (`<name>.local`) are only resolvable on the LAN.
    return host.endsWith('.local') && host.length > 6;
  } catch { return false; }
}
function normalizeLanMetadata(msg) {
  const lanUrls = [...new Set((Array.isArray(msg?.lanUrls) ? msg.lanUrls : []).filter(isLanUrl))].slice(0, 32);
  const lanCandidates = (Array.isArray(msg?.lanCandidates) ? msg.lanCandidates : [])
    .filter(candidate => candidate && typeof candidate === 'object' && isLanUrl(candidate.url))
    .slice(0, 32)
    .map(candidate => ({ url: candidate.url, ...(typeof candidate.interface === 'string' ? { interface: candidate.interface.slice(0, 64) } : {}), ...(typeof candidate.family === 'string' ? { family: candidate.family.slice(0, 16) } : {}) }));
  return { lanUrls, lanCandidates };
}

module.exports = {
  instances,
  pairLocks,
  isLocked,
  recordFail,
  clearFails,
  log,
  PAIR_MAX_FAILS,
  PAIR_LOCK_MS,
  isLanUrl,
  normalizeLanMetadata,
};
