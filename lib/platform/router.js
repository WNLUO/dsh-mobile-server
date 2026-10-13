'use strict';

/**
 * 平台 API 路由表。
 *
 * 挂载点：`/api/platform/v1/*`（由 lib/platform/index.js 判断前缀后交进来，
 * pathname 已经剥掉前缀，所以这里的正则都从 `/` 开始）。
 *
 * 对外信封统一为聚合登录系统那套：成功 `{"success":true,"data":...}`，
 * 失败 `{"success":false,"error":{"code","message"}}`。这样两个系统的前端
 * 可以共用同一份请求封装。
 *
 * 鉴权分三层：
 *   公开     —— 登录跳转、回调、支付通知、凭授权码绑定/校验设备
 *   登录用户 —— 个人中心、下单、我的订单/授权
 *   管理员   —— /admin/*
 */

const crypto = require('node:crypto');
const {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  sendOk,
  sendJson,
  sendRedirect,
  readJson,
  readRaw,
  parseCookies,
  serializeCookie,
  clientIp,
  safeNextPath,
} = require('./http.js');
const { quote, plans } = require('./pricing.js');
const { claimsToProfile } = require('./oidc.js');

const SESSION_COOKIE_SAFE = /^[A-Za-z0-9_-]{20,200}$/;
const ORDER_STATUS = new Set(['created', 'paying', 'paid', 'closed']);
const LICENSE_STATUS = new Set(['active', 'revoked', 'expired']);

/** 加 N 个自然月（月末溢出时落到当月最后一天）。 */
function addMonths(from, months) {
  const date = new Date(from);
  const day = date.getUTCDate();
  const target = new Date(date);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString();
}

function createRouter(ctx) {
  const { config, store, oidc, pay, log } = ctx;
  const api = config.apiPrefix;

  // ── 序列化（绝不把 token_hash / 内部字段漏出去） ─────────────────
  const publicUser = (user) => ({
    id: user.id,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    isAdmin: !!user.is_admin,
    status: user.status,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  });

  const publicOrder = (order) => ({
    id: order.id,
    outTradeNo: order.out_trade_no,
    deviceCount: order.device_count,
    months: order.months,
    unitCents: order.unit_cents,
    amountCents: order.amount_cents,
    amountYuan: (order.amount_cents / 100).toFixed(2),
    status: order.status,
    payTradeNo: order.pay_trade_no,
    payUrl: order.pay_url,
    transactionId: order.transaction_id,
    licenseId: order.license_id,
    paidAt: order.paid_at,
    createdAt: order.created_at,
  });

  /** 授权码只在「本人 / 管理员」的响应里出现——它就是充值凭证。 */
  const publicLicense = (license, devices = []) => {
    const expired = license.expires_at <= store.nowIso();
    return {
      id: license.id,
      code: license.code,
      deviceLimit: license.device_limit,
      months: license.months,
      startsAt: license.starts_at,
      expiresAt: license.expires_at,
      status: expired && license.status === 'active' ? 'expired' : license.status,
      orderId: license.order_id,
      note: license.note,
      createdAt: license.created_at,
      deviceCount: devices.filter((d) => d.status === 'active').length,
      devices: devices.map(publicDevice),
    };
  };

  const publicDevice = (device) => ({
    id: device.id,
    deviceId: device.device_id,
    deviceName: device.device_name,
    platform: device.platform,
    status: device.status,
    boundAt: device.bound_at,
    lastSeenAt: device.last_seen_at,
  });

  // ── 鉴权 ───────────────────────────────────────────────────────
  function readSessionUser(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[config.sessionCookie];
    if (!token || !SESSION_COOKIE_SAFE.test(token)) return null;
    const session = store.findSessionByHash(store.sha256Hex(token));
    if (!session) return null;
    if (session.expires_at <= store.nowIso()) {
      store.deleteSession(session.token_hash);
      return null;
    }
    const user = store.findUserById(session.user_id);
    if (!user || user.status !== 'active') return null;
    store.touchSession(session.id);
    return { user, session };
  }

  function requireUser(req) {
    const session = readSessionUser(req);
    if (!session) throw unauthorized('请先登录');
    return session;
  }

  function requireAdmin(req) {
    const session = requireUser(req);
    if (!session.user.is_admin) throw forbidden('需要管理员权限');
    return session;
  }

  // ── 授权码 → 设备绑定 ─────────────────────────────────────────
  function loadUsableLicense(codeInput) {
    const code = store.normalizeLicenseCode(codeInput);
    if (!code || code.length < 8) throw badRequest('授权码格式不正确');
    const license = store.findLicenseByCode(code);
    if (!license) throw notFound('授权码不存在');
    if (license.status === 'revoked') throw forbidden('授权码已被吊销');
    if (license.expires_at <= store.nowIso()) throw forbidden('授权码已过期');
    return license;
  }

  function bindDeviceToLicense({ code, deviceId, deviceName, platform, ip }) {
    const id = String(deviceId || '').trim();
    if (!id || id.length > 200) throw badRequest('设备标识不合法');
    const license = loadUsableLicense(code);
    const existing = store.findDevice(license.id, id);
    if (!existing) {
      const used = store.countActiveDevices(license.id);
      if (used >= license.device_limit) {
        throw conflict(`该授权码的设备名额已用完（${used}/${license.device_limit}）`);
      }
    }
    const device = store.bindDevice({
      licenseId: license.id,
      userId: license.user_id,
      deviceId: id,
      deviceName: String(deviceName || '').slice(0, 100),
      platform: String(platform || '').slice(0, 40),
    });
    store.audit({
      actorId: license.user_id,
      action: 'license.bind',
      target: license.code,
      detail: { deviceId: id },
      ip,
    });
    return { license, device };
  }

  // ── 支付成功 → 发授权码 ───────────────────────────────────────
  /**
   * 幂等：orders.status 已是 paid 就直接返回已有授权码。
   * 通知会重试最多 5 次，必须保证「同一次支付只发一次码」。
   */
  function fulfillOrder(order, { transactionId, paidAt }) {
    if (order.status === 'paid' && order.license_id) {
      return store.findLicenseById(order.license_id);
    }
    store.markOrderPaid(order.id, { transactionId, paidAt });
    if (order.license_id) return store.findLicenseById(order.license_id);
    const startsAt = store.nowIso();
    const license = store.createLicense({
      userId: order.user_id,
      orderId: order.id,
      deviceLimit: order.device_count,
      months: order.months,
      startsAt,
      expiresAt: addMonths(startsAt, order.months),
      note: '',
    });
    store.attachOrderLicense(order.id, license.id);
    store.audit({
      actorId: order.user_id,
      action: 'order.paid',
      target: order.out_trade_no,
      detail: { licenseCode: license.code, amountCents: order.amount_cents },
    });
    return license;
  }

  // ── 路由实现 ──────────────────────────────────────────────────
  const handlers = {
    // 健康检查：给 nginx / 监控用，不带任何敏感信息。
    async health() {
      return { ok: true, service: 'dsh-platform', time: store.nowIso() };
    },

    // 前端启动时拉一次：价格表 + 是否可支付 + 平台前缀。
    async configInfo() {
      return {
        publicBaseUrl: config.publicBaseUrl,
        apiPrefix: api,
        webPrefix: config.webPrefix,
        pricing: plans(config),
        payEnabled: Boolean(config.pay.pid && config.pay.secret),
        oidcEnabled: Boolean(config.oidc.clientSecret),
      };
    },

    async plans() {
      return plans(config);
    },

    // 发起微信登录：生成 state/nonce/PKCE，写库后 302 到登录中心。
    async login(req, res, url) {
      const next = safeNextPath(url.searchParams.get('next'), config.postLoginPath);
      const state = oidc.randomToken(32);
      const nonce = oidc.randomToken(16);
      const { verifier, challenge } = oidc.createPkce();
      store.createLoginState({
        state,
        nonce,
        codeVerifier: verifier,
        redirectUri: config.oidc.redirectUri,
        nextPath: next,
        ttlSeconds: config.oidc.stateTtlSeconds,
      });
      const location = await oidc.authorizeUrl({ state, nonce, codeChallenge: challenge });
      sendRedirect(res, location);
    },

    // 登录中心回调：换 token → 取 userinfo → upsert 用户 → 建会话 → 回前端。
    async callback(req, res, url) {
      const error = url.searchParams.get('error');
      if (error) {
        const detail = url.searchParams.get('error_description') || error;
        return sendRedirect(res, `${config.webPrefix}/login?error=${encodeURIComponent(detail)}`);
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      try {
        if (!code || !state) throw badRequest('回调缺少 code / state');
        const pending = store.consumeLoginState(state);
        if (!pending) throw badRequest('登录会话已失效，请重新发起登录');

        const tokens = await oidc.exchangeCode({
          code,
          codeVerifier: pending.code_verifier,
          redirectUriOverride: pending.redirect_uri,
        });
        const claims = await oidc.userinfo(tokens.access_token);
        const profile = claimsToProfile(claims);
        const user = store.upsertWechatUser(profile);
        if (user.status !== 'active') throw forbidden('账号已被停用');

        // 白名单里的 sub 登录即管理员（部署时把主人账号的 sub 写进 PLATFORM_ADMIN_SUBS）。
        if (config.adminSubs.includes(profile.subject) && !user.is_admin) {
          store.setUserAdmin(user.id, 1);
          log(`[platform] ${profile.subject} 命中 PLATFORM_ADMIN_SUBS，已置为管理员`);
        } else if (config.bootstrapFirstAdmin && !user.is_admin && store.countAdmins() === 0) {
          // 冷启动：库里一个管理员都没有，第一次成功登录的人就是主人。
          // 窗口期只到第一个管理员出现为止（见 config.bootstrapFirstAdmin 注释）。
          store.setUserAdmin(user.id, 1);
          log(
            `[platform] 冷启动：首个登录用户 ${user.id}（sub=${profile.subject}）已置为管理员；` +
              '如需固定，把该 sub 写进 PLATFORM_ADMIN_SUBS',
          );
        }

        const token = oidc.randomToken(32);
        store.createSession({
          userId: user.id,
          tokenHash: store.sha256Hex(token),
          expiresAt: new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString(),
          userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
          ip: clientIp(req),
        });
        store.audit({
          actorId: user.id,
          action: 'auth.login',
          target: profile.subject,
          ip: clientIp(req),
        });

        const secure = config.publicBaseUrl.startsWith('https://');
        const cookie = serializeCookie(config.sessionCookie, token, {
          maxAge: config.sessionTtlSeconds,
          secure,
          sameSite: 'Lax',
        });
        sendRedirect(res, `${config.webPrefix}${pending.next_path}`, { 'set-cookie': cookie });
      } catch (cause) {
        // 回调总是走浏览器跳转，出错也回前端页面而不是甩一段 JSON——
        // 否则用户只会看到一个白屏的 JSON 页面，没有任何重试入口。
        log(`[platform] 登录回调失败：${cause && cause.message ? cause.message : cause}`);
        const message = cause && cause.message ? cause.message : '登录失败';
        sendRedirect(res, `${config.webPrefix}/login?error=${encodeURIComponent(message)}`);
      }
    },

    async logout(req, res) {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[config.sessionCookie];
      if (token) store.deleteSession(store.sha256Hex(token));
      const secure = config.publicBaseUrl.startsWith('https://');
      const cookie = serializeCookie(config.sessionCookie, '', {
        maxAge: 0,
        secure,
        sameSite: 'Lax',
      });
      sendJson(res, 200, { success: true, data: { ok: true } }, { 'set-cookie': cookie });
    },

    // 个人中心首屏：用户 + 授权 + 设备 + 订单摘要，一次拉齐。
    async me(req, res) {
      const { user } = requireUser(req);
      const licenses = store.listLicensesByUser(user.id).map((license) =>
        publicLicense(license, store.listDevicesByLicense(license.id)),
      );
      const orders = store.listOrdersByUser(user.id).slice(0, 20).map(publicOrder);
      return {
        user: publicUser(user),
        licenses,
        orders,
        stats: {
          licenseCount: licenses.length,
          activeLicenseCount: licenses.filter((l) => l.status === 'active').length,
          deviceCount: licenses.reduce((sum, l) => sum + l.deviceCount, 0),
          paidCents: orders.filter((o) => o.status === 'paid').reduce((sum, o) => sum + o.amountCents, 0),
        },
      };
    },

    async listOrders(req, res) {
      const { user } = requireUser(req);
      return { orders: store.listOrdersByUser(user.id).map(publicOrder) };
    },

    // 下单：先落本地订单，再去 Pay 拿 pay_url。Pay 失败时订单留在 created，可重试。
    async createOrder(req, res) {
      const { user } = requireUser(req);
      const body = await readJson(req);
      const priced = quote(config, { deviceCount: body.deviceCount, months: body.months });
      const outTradeNo = `DSHP${Date.now()}${crypto.randomBytes(4).toString('hex')}`;
      const order = store.createOrder({
        outTradeNo,
        userId: user.id,
        deviceCount: priced.deviceCount,
        months: priced.months,
        unitCents: priced.unitCents,
        amountCents: priced.amountCents,
      });
      const name = `DSH 中转授权 ${priced.deviceCount} 台 × ${priced.months} 个月`;
      try {
        const paid = await pay.createOrder({
          outTradeNo,
          amountCents: priced.amountCents,
          name,
          param: order.id,
        });
        store.markOrderPaying(order.id, { payTradeNo: paid.trade_no, payUrl: paid.pay_url });
      } catch (error) {
        log(`下单到 Pay 失败（本地订单 ${outTradeNo} 保留为 created）：${error.message}`);
        throw new HttpError(502, 'PAY_UNAVAILABLE', `支付通道暂时不可用：${error.message}`);
      }
      return publicOrder(store.findOrderById(order.id));
    },

    async getOrder(req, res, url, params) {
      const { user } = requireUser(req);
      const order = store.findOrderById(params.id);
      if (!order) throw notFound('订单不存在');
      if (order.user_id !== user.id && !user.is_admin) throw forbidden();
      return publicOrder(order);
    },

    /**
     * 主动向 Pay 查一次并落账。
     * 这是通知丢失时的兜底：Pay 只支持微信 JSAPI，没有 code_url 轮询，
     * 但订单状态可以查。
     */
    async syncOrder(req, res, url, params) {
      const { user } = requireUser(req);
      const order = store.findOrderById(params.id);
      if (!order) throw notFound('订单不存在');
      if (order.user_id !== user.id && !user.is_admin) throw forbidden();
      if (order.status === 'paid') return publicOrder(order);
      if (!order.pay_trade_no) throw badRequest('订单还没有支付单号');

      const remote = await pay.queryOrder({ outTradeNo: order.out_trade_no });
      if (remote.status === 'paid') {
        fulfillOrder(order, {
          transactionId: remote.transaction_id,
          paidAt: remote.paid_at,
        });
      } else if (remote.status === 'closed' && order.status !== 'paid') {
        store.closeOrder(order.id);
      }
      return publicOrder(store.findOrderById(order.id));
    },

    async closeOrder(req, res, url, params) {
      const { user } = requireUser(req);
      const order = store.findOrderById(params.id);
      if (!order) throw notFound('订单不存在');
      if (order.user_id !== user.id && !user.is_admin) throw forbidden();
      if (order.status === 'paid') throw conflict('订单已支付，不能关闭');
      if (order.pay_trade_no) {
        try {
          await pay.closeOrder({ outTradeNo: order.out_trade_no });
        } catch (error) {
          log(`关闭 Pay 订单失败（本地照常关闭）：${error.message}`);
        }
      }
      store.closeOrder(order.id);
      return publicOrder(store.findOrderById(order.id));
    },

    async listLicenses(req, res) {
      const { user } = requireUser(req);
      return {
        licenses: store.listLicensesByUser(user.id).map((license) =>
          publicLicense(license, store.listDevicesByLicense(license.id)),
        ),
      };
    },

    async getLicense(req, res, url, params) {
      const { user } = requireUser(req);
      const license = store.findLicenseById(params.id);
      if (!license) throw notFound('授权不存在');
      if (license.user_id !== user.id && !user.is_admin) throw forbidden();
      return publicLicense(license, store.listDevicesByLicense(license.id));
    },

    async unbindDevice(req, res, url, params) {
      const { user } = requireUser(req);
      const license = store.findLicenseById(params.id);
      if (!license) throw notFound('授权不存在');
      if (license.user_id !== user.id && !user.is_admin) throw forbidden();
      store.unbindDevice(license.id, params.deviceId);
      store.audit({
        actorId: user.id,
        action: 'license.unbind',
        target: license.code,
        detail: { deviceId: params.deviceId },
        ip: clientIp(req),
      });
      return publicLicense(license, store.listDevicesByLicense(license.id));
    },

    /**
     * 引导界面 / 移动端插件用：拿授权码绑定设备。
     * 不需要登录——授权码本身就是凭证（用户是「先买后绑」，购买时才需要登录）。
     */
    async bindLicense(req, res) {
      const body = await readJson(req);
      const { license, device } = bindDeviceToLicense({
        code: body.code,
        deviceId: body.deviceId,
        deviceName: body.deviceName,
        platform: body.platform,
        ip: clientIp(req),
      });
      return {
        license: publicLicense(license, store.listDevicesByLicense(license.id)),
        device: publicDevice(device),
      };
    },

    /** 插件/宿主启动时自检：这个码 + 这台设备还能用吗。 */
    async verifyLicense(req, res) {
      const body = await readJson(req);
      const license = store.findLicenseByCode(store.normalizeLicenseCode(body.code));
      if (!license) return { ok: false, reason: 'not_found' };
      if (license.status === 'revoked') return { ok: false, reason: 'revoked' };
      if (license.expires_at <= store.nowIso()) return { ok: false, reason: 'expired' };
      const deviceId = String(body.deviceId || '').trim();
      if (deviceId) {
        const device = store.findDevice(license.id, deviceId);
        if (!device || device.status !== 'active') return { ok: false, reason: 'device_not_bound' };
        store.touchDevice(license.id, deviceId);
      }
      return {
        ok: true,
        licenseId: license.id,
        expiresAt: license.expires_at,
        deviceLimit: license.device_limit,
        deviceCount: store.countActiveDevices(license.id),
      };
    },

    /**
     * Pay v2 支付通知。
     * 必须回「正文含独立单词 success」的 2xx，否则 Pay 会按 1/5/15/60 分钟重试。
     * 幂等键：event_id（唯一索引）+ orders.status。
     */
    async payNotify(req, res) {
      const { raw, text } = await readRaw(req);
      const verdict = pay.verifyNotify(req.headers, text);
      if (!verdict.ok) {
        log(`支付通知验签失败：${verdict.reason}`);
        sendJson(res, 401, { success: false, error: { code: 'UNAUTHORIZED', message: verdict.reason } });
        return;
      }
      const event = verdict.event || {};
      const outTradeNo = String(event.out_trade_no || '');
      const order = outTradeNo ? store.findOrderByOutTradeNo(outTradeNo) : null;
      const recorded = store.recordPaymentEvent({
        eventId: event.event_id,
        eventType: event.event_type,
        tradeNo: event.trade_no,
        outTradeNo,
        amountCents: pay.moneyToCents(event.money),
        orderId: order?.id,
        payload: raw.toString('utf8'),
      });
      if (!recorded.inserted) {
        // 重复通知：仍然回 success，让 Pay 停止重试。
        sendJson(res, 200, { success: true, data: { duplicate: true } }, { 'content-type': 'application/json' });
        return;
      }
      if (order && event.event_type === 'payment.succeeded') {
        const expected = order.amount_cents;
        const actual = pay.moneyToCents(event.money);
        if (actual !== null && actual !== expected) {
          log(`支付金额不匹配：订单 ${outTradeNo} 期望 ${expected} 分，通知 ${actual} 分`);
          store.audit({ actorId: order.user_id, action: 'order.amount_mismatch', target: outTradeNo, detail: { expected, actual } });
        } else {
          fulfillOrder(order, { transactionId: event.transaction_id, paidAt: event.occurred_at });
        }
      }
      store.markPaymentEventApplied(recorded.row.id);
      sendJson(res, 200, { success: true, data: { ok: true } });
    },

    // ── 管理后台 ─────────────────────────────────────────────────
    async adminOverview(req) {
      requireAdmin(req);
      const licenses = store.listLicenses({ limit: 1000 });
      return {
        userCount: store.countUsers(),
        orderCount: store.countOrders(),
        paidOrderCount: store.countOrders('paid'),
        licenseCount: store.countLicenses(),
        activeLicenseCount: store.countLicenses('active'),
        deviceCount: store.countDevices(),
        revenueCents: store.sumPaidCents(),
        recentOrders: store.listOrders({ limit: 10 }).map(publicOrder),
        recentLicenses: licenses.slice(0, 10).map((license) => publicLicense(license)),
      };
    },

    async adminUsers(req) {
      requireAdmin(req);
      return {
        users: store.listUsers({ limit: 200 }).map((user) => ({
          ...publicUser(user),
          licenseCount: store.listLicensesByUser(user.id).length,
          orderCount: store.listOrdersByUser(user.id).length,
        })),
      };
    },

    async adminSetUserAdmin(req, res, url, params) {
      const { user: actor } = requireAdmin(req);
      const body = await readJson(req);
      const target = store.findUserById(params.id);
      if (!target) throw notFound('用户不存在');
      if (target.id === actor.id && !body.isAdmin) throw conflict('不能取消自己的管理员权限');
      store.setUserAdmin(target.id, Boolean(body.isAdmin));
      store.audit({
        actorId: actor.id,
        action: 'admin.set_user_admin',
        target: target.id,
        detail: { isAdmin: Boolean(body.isAdmin) },
        ip: clientIp(req),
      });
      return publicUser(store.findUserById(target.id));
    },

    async adminOrders(req, res, url) {
      requireAdmin(req);
      const status = url.searchParams.get('status');
      if (status && !ORDER_STATUS.has(status)) throw badRequest('未知的订单状态');
      return { orders: store.listOrders({ limit: 200, status: status || undefined }).map(publicOrder) };
    },

    async adminLicenses(req, res, url) {
      requireAdmin(req);
      const status = url.searchParams.get('status');
      if (status && !LICENSE_STATUS.has(status)) throw badRequest('未知的授权状态');
      const rows = store.listLicenses({ limit: 200, status: status || undefined });
      return {
        licenses: rows.map((license) => ({
          ...publicLicense(license, store.listDevicesByLicense(license.id)),
          userId: license.user_id,
          owner: store.findUserById(license.user_id)?.display_name || '',
        })),
      };
    },

    async adminSetLicenseStatus(req, res, url, params) {
      const { user: actor } = requireAdmin(req);
      const body = await readJson(req);
      const license = store.findLicenseById(params.id);
      if (!license) throw notFound('授权不存在');
      if (!LICENSE_STATUS.has(body.status)) throw badRequest('未知的授权状态');
      store.setLicenseStatus(license.id, body.status);
      store.audit({
        actorId: actor.id,
        action: 'admin.set_license_status',
        target: license.code,
        detail: { status: body.status },
        ip: clientIp(req),
      });
      return publicLicense(store.findLicenseById(license.id), store.listDevicesByLicense(license.id));
    },

    async adminDevices(req) {
      requireAdmin(req);
      return { devices: store.listDevices({ limit: 200 }).map(publicDevice) };
    },

    async adminAudit(req) {
      requireAdmin(req);
      return { logs: store.listAuditLogs({ limit: 100 }) };
    },
  };

  // ── 路由表 ────────────────────────────────────────────────────
  const table = [
    ['GET', /^\/health$/, handlers.health],
    ['GET', /^\/config$/, handlers.configInfo],
    ['GET', /^\/plans$/, handlers.plans],
    ['GET', /^\/auth\/login$/, handlers.login],
    ['GET', /^\/auth\/callback$/, handlers.callback],
    ['POST', /^\/auth\/logout$/, handlers.logout],
    ['GET', /^\/me$/, handlers.me],
    ['GET', /^\/orders$/, handlers.listOrders],
    ['POST', /^\/orders$/, handlers.createOrder],
    ['GET', /^\/orders\/(?<id>[A-Za-z0-9-]{1,64})$/, handlers.getOrder],
    ['POST', /^\/orders\/(?<id>[A-Za-z0-9-]{1,64})\/sync$/, handlers.syncOrder],
    ['POST', /^\/orders\/(?<id>[A-Za-z0-9-]{1,64})\/close$/, handlers.closeOrder],
    ['GET', /^\/licenses$/, handlers.listLicenses],
    ['GET', /^\/licenses\/(?<id>[A-Za-z0-9-]{1,64})$/, handlers.getLicense],
    ['DELETE', /^\/licenses\/(?<id>[A-Za-z0-9-]{1,64})\/devices\/(?<deviceId>[^/]{1,200})$/, handlers.unbindDevice],
    ['POST', /^\/licenses\/bind$/, handlers.bindLicense],
    ['POST', /^\/licenses\/verify$/, handlers.verifyLicense],
    ['POST', /^\/pay\/notify$/, handlers.payNotify],
    ['GET', /^\/admin\/overview$/, handlers.adminOverview],
    ['GET', /^\/admin\/users$/, handlers.adminUsers],
    ['POST', /^\/admin\/users\/(?<id>[A-Za-z0-9-]{1,64})\/admin$/, handlers.adminSetUserAdmin],
    ['GET', /^\/admin\/orders$/, handlers.adminOrders],
    ['GET', /^\/admin\/licenses$/, handlers.adminLicenses],
    ['POST', /^\/admin\/licenses\/(?<id>[A-Za-z0-9-]{1,64})\/status$/, handlers.adminSetLicenseStatus],
    ['GET', /^\/admin\/devices$/, handlers.adminDevices],
    ['GET', /^\/admin\/audit$/, handlers.adminAudit],
  ];

  /**
   * 处理一个已剥掉 apiPrefix 的请求。
   * 返回 true 表示已处理（含已回 404/405），false 表示不是平台路由。
   */
  async function handle(req, res, url, subPath) {
    const pathname = subPath === undefined ? url.pathname : subPath;
    let pathMatched = false;
    for (const [method, pattern, handler] of table) {
      const match = pattern.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (method !== req.method) continue;
      const params = match.groups || {};
      const result = await handler(req, res, url, params);
      if (result !== undefined) sendOk(res, result);
      return true;
    }
    if (pathMatched) {
      sendJson(res, 405, { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: '方法不允许' } });
      return true;
    }
    return false;
  }

  return { handle, table, handlers, addMonths, publicOrder, publicLicense, publicUser };
}

module.exports = { createRouter, addMonths };
