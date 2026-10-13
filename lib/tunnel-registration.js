'use strict';

// 隧道注册的准入判定。单独成文件是为了能脱离 server.js 直接单测：
// 这段逻辑决定「谁能占用一个 instanceId」，一旦判断错，被顶掉的宿主会一直
// 1008 bad pairing code 醒不来，而日志里只有一行拒绝。
//
// 两种准入方式，互不排斥：
//   1. 共享密钥（registerSecret）—— 对偶本服务的 TUNNEL_REGISTER_SECRET；宿主侧
//      在插件的「注册密钥」设置里填同一个值（桌面 DSH 从图标启动，拿不到 shell
//      环境变量，所以不读 DSH_RELAY_REGISTER_SECRET）。
//   2. 实例白名单（instances）—— 服务器本地 JSON 文件列出的 instanceId 才准注册。
//      桌面端**不需要任何配置**，这是「后端解决」的那条路：白名单由服务器管理员维护，
//      手机/桌面都不感知它。
//
// 都没配时是开放模式：任何人都能抢先注册一个还没被占的 instanceId，把真宿主顶成
// bad pairing code（配对码只在「已注册实例之间」比对，首次注册没有任何认证）。
// 自用场景可接受，共享部署请至少配其中一种。

const fs = require('node:fs');
const path = require('node:path');

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

/** 定长比较，避免按字符早退泄露前缀长度。 */
function safeEqual(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  const length = Math.max(left.length, right.length, 32);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

/**
 * 读实例白名单文件。文件不存在是正常的开放模式，不报错；存在但内容不合法必须报错，
 * 否则一次手滑就能把整台中转的准入静默降级成开放。
 * @param {string} file - 白名单文件路径
 * @returns {Set<string>} 允许注册的 instanceId；空集合 = 不限制
 */
function loadInstanceAllowlist(file) {
  if (!file) return new Set();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw new Error(`instance allowlist ${file} is not readable: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`instance allowlist ${file} is not valid JSON: ${error.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.instances) ? parsed.instances : null;
  if (list === null) throw new Error(`instance allowlist ${file} must be an array or {"instances": [...]}`);
  const ids = new Set();
  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : entry && entry.instanceId;
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
      throw new Error(`instance allowlist ${file} has an invalid instanceId: ${JSON.stringify(entry)}`);
    }
    ids.add(id);
  }
  return ids;
}

/**
 * 判定一次隧道注册是否放行。
 * @param {object} input
 * @param {string} input.instanceId - 注册帧里的 instanceId
 * @param {unknown} input.secret - 注册帧里的 secret 字段（客户端有配才发）
 * @param {string} [input.registerSecret] - 服务器侧共享密钥，空 = 不启用
 * @param {Set<string>|Iterable<string>} [input.instances] - 白名单，空 = 不限制
 * @returns {{ok: true, mode: string} | {ok: false, reason: string, detail: string}}
 */
function tunnelRegistrationDecision({ instanceId, secret, registerSecret = '', instances = new Set() }) {
  if (registerSecret && !safeEqual(secret ?? '', registerSecret)) {
    return { ok: false, reason: 'bad register secret', detail: 'register secret mismatch' };
  }
  const allowed = instances instanceof Set ? instances : new Set(instances || []);
  if (allowed.size > 0 && !allowed.has(instanceId)) {
    return { ok: false, reason: 'unknown instance', detail: 'instanceId is not in the server allowlist' };
  }
  if (registerSecret) return { ok: true, mode: 'secret' };
  if (allowed.size > 0) return { ok: true, mode: 'allowlist' };
  return { ok: true, mode: 'open' };
}

module.exports = {
  safeEqual,
  loadInstanceAllowlist,
  tunnelRegistrationDecision,
  defaultInstanceAllowlistFile: (root) => path.join(root, 'instances.json'),
};