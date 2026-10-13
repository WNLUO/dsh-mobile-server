'use strict';

/**
 * Pay（pay.wnluo.com）商户 API v2 客户端。
 *
 * 契约（从 /www/wwwroot/newpay.wnluo.com 的 rust 源码 + MERCHANT_API_V2.md 读出）：
 *   - 所有请求带三个头：
 *       X-Pay-Timestamp  Unix 秒，允许前后 300s
 *       X-Pay-Nonce      唯一，服务端 Redis SET NX 10 分钟防重放
 *       X-Pay-Signature  HMAC-SHA256(secret, `${timestamp}\n${nonce}\n${rawBody}`) 小写十六进制
 *   - 创建订单 POST /api/merchant/orders（**无 base path 前缀**），成功恒为
 *     {"code":0,"msg":"success","data":{"trade_no":...,"pay_url":"https://pay.wnluo.com/pay/<trade_no>"}}
 *   - 支付通知 v2：POST application/json 打我们的 notify_url，带同样三个头对
 *     **原始 body** 签名；商户回 2xx 且正文含独立单词 success（或 {"success":true}）即算成功。
 *
 * 重要限制：Pay 只支持微信 JSAPI（公众号支付），没有 Native/扫码接口，也没有
 * code_url 可轮询。所以平台支付页只能「把 pay_url 摆出来（PC 上把它变成二维码，
 * 用户手机微信扫码打开收银台）+ 轮询我们自己的订单状态」。
 */

const crypto = require('node:crypto');

const SIGNATURE_TOLERANCE_SECONDS = 300;
const NONCE_TTL_SECONDS = 600;

const hmacHex = (secret, message) =>
  crypto.createHmac('sha256', secret).update(message).digest('hex');

/** 恒定时间比较，长度不同直接返回 false（不泄露长度）。 */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function formatMoney(amountCents) {
  return (Math.round(amountCents) / 100).toFixed(2);
}

function createPayClient(config, log = () => {}) {
  const { baseUrl, pid, secret, payType, timeoutMs, notifyPath } = config.pay;
  const notifyUrl = `${config.publicBaseUrl}${notifyPath}`;

  function signHeaders(rawBody) {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const signature = hmacHex(secret, `${timestamp}\n${nonce}\n${rawBody}`);
    return {
      'x-pay-timestamp': String(timestamp),
      'x-pay-nonce': nonce,
      'x-pay-signature': signature,
      'content-type': 'application/json',
    };
  }

  async function post(path, payload) {
    if (!pid || !secret) {
      throw new Error('支付通道未配置（缺少 PLATFORM_PAY_PID / PLATFORM_PAY_SECRET）');
    }
    const rawBody = JSON.stringify({ pid, ...payload });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: signHeaders(rawBody),
        body: rawBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch { /* 下面按非 JSON 报错 */ }
    if (!response.ok) {
      throw new Error(`Pay ${path} HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    if (!body || body.code !== 0) {
      throw new Error(`Pay ${path} 业务失败：${body?.msg || text.slice(0, 200)}`);
    }
    return body.data;
  }

  return {
    notifyUrl,

    /**
     * 下单。amountCents 是分；Pay 那边 money 是字符串元、最多两位小数。
     * 同一个 out_trade_no 重复下单时，Pay 要求 name/money/notify_url 与首次完全
     * 一致，否则 400「支付参数有变化，请更换订单号重新发起支付」——所以每次
     * 重试都必须复用同一个订单号和同一份参数。
     */
    async createOrder({ outTradeNo, amountCents, name, returnUrl, param }) {
      return post('/api/merchant/orders', {
        type: payType,
        out_trade_no: outTradeNo,
        notify_url: notifyUrl,
        return_url: returnUrl || `${config.publicBaseUrl}${config.webPrefix}/pay/${outTradeNo}`,
        param: param || '',
        name,
        money: formatMoney(amountCents),
        notify_version: 'v2',
      });
    },

    async queryOrder({ outTradeNo, tradeNo }) {
      return post('/api/merchant/orders/query', {
        ...(tradeNo ? { trade_no: tradeNo } : {}),
        ...(outTradeNo ? { out_trade_no: outTradeNo } : {}),
      });
    },

    async closeOrder({ outTradeNo, tradeNo }) {
      return post('/api/merchant/orders/close', {
        ...(tradeNo ? { trade_no: tradeNo } : {}),
        ...(outTradeNo ? { out_trade_no: outTradeNo } : {}),
      });
    },

    /**
     * 校验通知签名。返回 { ok, reason, event }。
     * event 是解析后的 body；签名没过就不返回 event。
     */
    verifyNotify(headers, rawBody) {
      const timestamp = headers['x-pay-timestamp'];
      const nonce = headers['x-pay-nonce'];
      const signature = headers['x-pay-signature'];
      if (!timestamp || !nonce || !signature) {
        return { ok: false, reason: 'missing signature headers' };
      }
      const seconds = Number.parseInt(timestamp, 10);
      if (!Number.isFinite(seconds)) return { ok: false, reason: 'bad timestamp' };
      const drift = Math.abs(Math.floor(Date.now() / 1000) - seconds);
      if (drift > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: 'timestamp expired' };

      const expected = hmacHex(secret, `${timestamp}\n${nonce}\n${rawBody}`);
      if (!safeEqualHex(expected, signature)) return { ok: false, reason: 'bad signature' };

      let event = null;
      try {
        event = JSON.parse(rawBody);
      } catch {
        return { ok: false, reason: 'bad json' };
      }
      return { ok: true, event };
    },

    /** 金额字符串「元」→ 分。 */
    moneyToCents(money) {
      const value = Number.parseFloat(String(money));
      if (!Number.isFinite(value)) return null;
      return Math.round(value * 100);
    },
  };
}

module.exports = { createPayClient, formatMoney, hmacHex, SIGNATURE_TOLERANCE_SECONDS, NONCE_TTL_SECONDS };
