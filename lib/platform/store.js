'use strict';

/**
 * 平台数据访问层。所有 SQL 只出现在这里（+ db.js 的 DDL），
 * 这样「以后换 MySQL」的改动面是可控的。
 *
 * 约定：
 *   - 时间一律 UTC ISO-8601 字符串（`nowIso()`），字符串比较即时间比较；
 *   - 金额一律「分」的整数；
 *   - 对外暴露的 id 都是 uuid v4 字符串。
 */

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

// ── 授权码 ────────────────────────────────────────────────────────
// 去掉了 0/O/1/I/L 这些手抄会错的字符，分组 4-4-4-4。
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function generateLicenseCode() {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `DSH-${out}`;
}

/** 用户抄写时可能带空格/小写/中文破折号，统一归一化后再查。 */
function normalizeLicenseCode(input) {
  return String(input || '')
    .trim()
    .toUpperCase()
    .replace(/[\s\u2010-\u2015\uFF0D_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^DSH-?/, 'DSH-');
}

function createStore(db) {
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);

  return {
    db,
    nowIso,
    uuid,
    sha256Hex,

    // ── users ────────────────────────────────────────────────────
    findUserBySubject: (subject) => get('SELECT * FROM users WHERE subject = ?', subject),
    findUserById: (id) => get('SELECT * FROM users WHERE id = ?', id),

    /**
     * 微信登录落地。subject 是 OIDC 的 sub（本项目客户端 subject_type=public，
     * 即登录系统的 user_id，跨登录稳定）。同一 union_id 命中已有用户时复用，
     * 避免同一个微信在两个 provider 下裂成两个账号。
     */
    upsertWechatUser({ subject, displayName, avatarUrl, openid, unionId, wechatAppid }) {
      const existing = get('SELECT * FROM users WHERE subject = ?', subject);
      if (existing) {
        run(
          `UPDATE users SET display_name = ?, avatar_url = ?, openid = COALESCE(?, openid),
             union_id = COALESCE(?, union_id), wechat_appid = COALESCE(?, wechat_appid),
             updated_at = ?, last_login_at = ? WHERE id = ?`,
          displayName || existing.display_name,
          avatarUrl || existing.avatar_url,
          openid || null,
          unionId || null,
          wechatAppid || null,
          nowIso(),
          nowIso(),
          existing.id,
        );
        return get('SELECT * FROM users WHERE id = ?', existing.id);
      }
      if (unionId) {
        const byUnion = get('SELECT * FROM users WHERE union_id = ?', unionId);
        if (byUnion) {
          run(
            `UPDATE users SET subject = ?, display_name = ?, avatar_url = ?, openid = COALESCE(?, openid),
               updated_at = ?, last_login_at = ? WHERE id = ?`,
            subject,
            displayName || byUnion.display_name,
            avatarUrl || byUnion.avatar_url,
            openid || null,
            nowIso(),
            nowIso(),
            byUnion.id,
          );
          return get('SELECT * FROM users WHERE id = ?', byUnion.id);
        }
      }
      const id = uuid();
      run(
        `INSERT INTO users (id, subject, display_name, avatar_url, openid, union_id, wechat_appid,
           is_admin, status, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)`,
        id,
        subject,
        displayName || '',
        avatarUrl || '',
        openid || null,
        unionId || null,
        wechatAppid || null,
        nowIso(),
        nowIso(),
        nowIso(),
      );
      return get('SELECT * FROM users WHERE id = ?', id);
    },

    countUsers: () => get('SELECT COUNT(*) AS n FROM users').n,
    countAdmins: () => get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').n,
    listUsers: ({ limit = 100, offset = 0 } = {}) =>
      all('SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?', limit, offset),
    setUserAdmin: (id, isAdmin) =>
      run('UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?', isAdmin ? 1 : 0, nowIso(), id),
    setUserStatus: (id, status) =>
      run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id),

    // ── sessions ─────────────────────────────────────────────────
    createSession({ userId, tokenHash, expiresAt, userAgent, ip }) {
      const id = uuid();
      const ts = nowIso();
      run(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at, user_agent, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        userId,
        tokenHash,
        expiresAt,
        ts,
        ts,
        userAgent || null,
        ip || null,
      );
      return id;
    },
    findSessionByHash: (tokenHash) => get('SELECT * FROM sessions WHERE token_hash = ?', tokenHash),
    touchSession: (id) => run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', nowIso(), id),
    deleteSession: (tokenHash) => run('DELETE FROM sessions WHERE token_hash = ?', tokenHash),
    deleteUserSessions: (userId) => run('DELETE FROM sessions WHERE user_id = ?', userId),
    purgeExpiredSessions: () => run('DELETE FROM sessions WHERE expires_at < ?', nowIso()),

    // ── login_states（OIDC 事务） ─────────────────────────────────
    createLoginState({ state, nonce, codeVerifier, redirectUri, nextPath, ttlSeconds }) {
      run('DELETE FROM login_states WHERE expires_at < ?', nowIso());
      run(
        `INSERT INTO login_states (state, nonce, code_verifier, redirect_uri, next_path, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        state,
        nonce,
        codeVerifier,
        redirectUri,
        nextPath || '/',
        nowIso(),
        new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      );
    },
    /** 一次性消费：查到即删，避免 state 重放。 */
    consumeLoginState(state) {
      const row = get('SELECT * FROM login_states WHERE state = ?', state);
      if (row) run('DELETE FROM login_states WHERE state = ?', state);
      if (!row) return null;
      if (row.expires_at < nowIso()) return null;
      return row;
    },

    // ── orders ───────────────────────────────────────────────────
    createOrder(order) {
      const id = uuid();
      const ts = nowIso();
      run(
        `INSERT INTO orders (id, out_trade_no, user_id, device_count, months, unit_cents, amount_cents,
           status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)`,
        id,
        order.outTradeNo,
        order.userId,
        order.deviceCount,
        order.months,
        order.unitCents,
        order.amountCents,
        ts,
        ts,
      );
      return get('SELECT * FROM orders WHERE id = ?', id);
    },
    findOrderById: (id) => get('SELECT * FROM orders WHERE id = ?', id),
    findOrderByOutTradeNo: (outTradeNo) => get('SELECT * FROM orders WHERE out_trade_no = ?', outTradeNo),
    findOrderByPayTradeNo: (payTradeNo) => get('SELECT * FROM orders WHERE pay_trade_no = ?', payTradeNo),
    listOrdersByUser: (userId) =>
      all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', userId),
    listOrders: ({ limit = 100, offset = 0, status } = {}) =>
      status
        ? all('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', status, limit, offset)
        : all('SELECT * FROM orders ORDER BY created_at DESC LIMIT ? OFFSET ?', limit, offset),
    markOrderPaying: (id, { payTradeNo, payUrl }) =>
      run(
        "UPDATE orders SET status = 'paying', pay_trade_no = ?, pay_url = ?, updated_at = ? WHERE id = ?",
        payTradeNo,
        payUrl,
        nowIso(),
        id,
      ),
    markOrderPaid: (id, { transactionId, paidAt }) =>
      run(
        "UPDATE orders SET status = 'paid', transaction_id = COALESCE(?, transaction_id), paid_at = COALESCE(?, ?), updated_at = ? WHERE id = ?",
        transactionId || null,
        paidAt || null,
        nowIso(),
        nowIso(),
        id,
      ),
    closeOrder: (id) =>
      run("UPDATE orders SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), id),
    attachOrderLicense: (id, licenseId) =>
      run('UPDATE orders SET license_id = ?, updated_at = ? WHERE id = ?', licenseId, nowIso(), id),
    sumPaidCents: () => get("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM orders WHERE status = 'paid'").n,
    countOrders: (status) =>
      status
        ? get('SELECT COUNT(*) AS n FROM orders WHERE status = ?', status).n
        : get('SELECT COUNT(*) AS n FROM orders').n,

    // ── licenses ─────────────────────────────────────────────────
    createLicense(license) {
      const id = uuid();
      const ts = nowIso();
      let code = generateLicenseCode();
      for (let i = 0; i < 5 && get('SELECT id FROM licenses WHERE code = ?', code); i += 1) {
        code = generateLicenseCode();
      }
      run(
        `INSERT INTO licenses (id, user_id, order_id, code, device_limit, months, starts_at, expires_at,
           status, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        id,
        license.userId,
        license.orderId || null,
        code,
        license.deviceLimit,
        license.months,
        license.startsAt,
        license.expiresAt,
        license.note || '',
        ts,
        ts,
      );
      return get('SELECT * FROM licenses WHERE id = ?', id);
    },
    findLicenseById: (id) => get('SELECT * FROM licenses WHERE id = ?', id),
    findLicenseByCode: (code) => get('SELECT * FROM licenses WHERE code = ?', code),
    listLicensesByUser: (userId) =>
      all('SELECT * FROM licenses WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', userId),
    listLicenses: ({ limit = 100, offset = 0, status } = {}) =>
      status
        ? all('SELECT * FROM licenses WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', status, limit, offset)
        : all('SELECT * FROM licenses ORDER BY created_at DESC LIMIT ? OFFSET ?', limit, offset),
    setLicenseStatus: (id, status) =>
      run('UPDATE licenses SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id),
    /** 续期/加设备名额（管理员或续费时用）。 */
    extendLicense: (id, { expiresAt, deviceLimit }) =>
      run(
        'UPDATE licenses SET expires_at = COALESCE(?, expires_at), device_limit = COALESCE(?, device_limit), updated_at = ? WHERE id = ?',
        expiresAt || null,
        deviceLimit || null,
        nowIso(),
        id,
      ),
    countLicenses: (status) =>
      status
        ? get('SELECT COUNT(*) AS n FROM licenses WHERE status = ?', status).n
        : get('SELECT COUNT(*) AS n FROM licenses').n,

    // ── devices ──────────────────────────────────────────────────
    findDevice: (licenseId, deviceId) =>
      get('SELECT * FROM devices WHERE license_id = ? AND device_id = ?', licenseId, deviceId),
    countActiveDevices: (licenseId) =>
      get("SELECT COUNT(*) AS n FROM devices WHERE license_id = ? AND status = 'active'", licenseId).n,
    bindDevice({ licenseId, userId, deviceId, deviceName, platform }) {
      const ts = nowIso();
      const existing = get('SELECT * FROM devices WHERE license_id = ? AND device_id = ?', licenseId, deviceId);
      if (existing) {
        run(
          "UPDATE devices SET device_name = ?, platform = ?, status = 'active', last_seen_at = ? WHERE id = ?",
          deviceName || existing.device_name,
          platform || existing.platform,
          ts,
          existing.id,
        );
        return get('SELECT * FROM devices WHERE id = ?', existing.id);
      }
      const id = uuid();
      run(
        `INSERT INTO devices (id, license_id, user_id, device_id, device_name, platform, status, bound_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        id,
        licenseId,
        userId,
        deviceId,
        deviceName || '',
        platform || '',
        ts,
        ts,
      );
      return get('SELECT * FROM devices WHERE id = ?', id);
    },
    touchDevice: (licenseId, deviceId) =>
      run('UPDATE devices SET last_seen_at = ? WHERE license_id = ? AND device_id = ?', nowIso(), licenseId, deviceId),
    unbindDevice: (licenseId, deviceId) =>
      run('DELETE FROM devices WHERE license_id = ? AND device_id = ?', licenseId, deviceId),
    listDevicesByLicense: (licenseId) =>
      all('SELECT * FROM devices WHERE license_id = ? ORDER BY bound_at DESC', licenseId),
    listDevices: ({ limit = 100, offset = 0 } = {}) =>
      all('SELECT * FROM devices ORDER BY bound_at DESC LIMIT ? OFFSET ?', limit, offset),
    countDevices: () => get('SELECT COUNT(*) AS n FROM devices').n,

    // ── payment_events ───────────────────────────────────────────
    /** 返回 { inserted }：event_id 已存在即幂等命中。 */
    recordPaymentEvent(event) {
      const existing = event.eventId
        ? get('SELECT * FROM payment_events WHERE event_id = ?', event.eventId)
        : null;
      if (existing) return { inserted: false, row: existing };
      const id = uuid();
      run(
        `INSERT INTO payment_events (id, event_id, event_type, trade_no, out_trade_no, amount_cents,
           order_id, applied, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        id,
        event.eventId || null,
        event.eventType || null,
        event.tradeNo || null,
        event.outTradeNo || null,
        event.amountCents ?? null,
        event.orderId || null,
        event.payload,
        nowIso(),
      );
      return { inserted: true, row: get('SELECT * FROM payment_events WHERE id = ?', id) };
    },
    markPaymentEventApplied: (id) => run('UPDATE payment_events SET applied = 1 WHERE id = ?', id),
    listPaymentEvents: ({ limit = 100 } = {}) =>
      all('SELECT * FROM payment_events ORDER BY received_at DESC LIMIT ?', limit),

    // ── audit / settings ─────────────────────────────────────────
    audit({ actorId, action, target, detail, ip }) {
      run(
        'INSERT INTO audit_logs (id, actor_id, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        uuid(),
        actorId || null,
        action,
        target || null,
        detail ? JSON.stringify(detail) : null,
        ip || null,
        nowIso(),
      );
    },
    listAuditLogs: ({ limit = 100 } = {}) =>
      all('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?', limit),

    getSetting: (key) => get('SELECT * FROM settings WHERE key = ?', key)?.value ?? null,
    setSetting: (key, value) =>
      run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        String(value),
        nowIso(),
      ),

    generateLicenseCode,
    normalizeLicenseCode,
  };
}

module.exports = { createStore, generateLicenseCode, normalizeLicenseCode, CODE_ALPHABET };
