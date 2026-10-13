'use strict';

/**
 * OIDC 客户端：接 https://login.wnluo.com（聚合登录系统）。
 *
 * 为什么走「后端换 token」而不是浏览器直连：
 *   1. 登录系统生产环境只接受 https 的 redirect_uri，且 CORS 只认
 *      CORS_ALLOWED_ORIGINS 里的精确 origin——把换 token 放在我们自己后端
 *      就完全绕开 CORS，也不用去动登录系统的生产配置；
 *   2. client_secret 只出现在服务端，浏览器永远看不到。
 *   所以本项目注册的是 confidential 客户端 + PKCE S256（两者同时用）。
 *
 * 登录系统那边的硬约束（实测，不是推测）：
 *   - /oauth2/token 只吃 application/x-www-form-urlencoded；
 *   - code_challenge 长度必须恰好 43（48 字节随机 → SHA-256 → base64url）；
 *   - redirect_uri 必须逐条精确命中白名单；
 *   - client_secret 校验是「明文做 SHA-256 十六进制后与 client_secret_hash 比较」。
 */

const crypto = require('node:crypto');

const base64url = (buffer) => buffer.toString('base64url');

function createPkce() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

const randomToken = (bytes = 32) => base64url(crypto.randomBytes(bytes));

function createOidcClient(config) {
  const { issuer, clientId, clientSecret, redirectUri, scope, discoveryTtlMs, timeoutMs } = config.oidc;
  let discovery = null;
  let discoveryAt = 0;

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function discover() {
    const fresh = discovery && Date.now() - discoveryAt < discoveryTtlMs;
    if (fresh) return discovery;
    const response = await fetchWithTimeout(`${issuer}/.well-known/openid-configuration`);
    if (!response.ok) {
      throw new Error(`拉取 OIDC 发现文档失败：HTTP ${response.status}`);
    }
    const doc = await response.json();
    if (!doc.authorization_endpoint || !doc.token_endpoint) {
      throw new Error('OIDC 发现文档缺少 authorization_endpoint / token_endpoint');
    }
    discovery = doc;
    discoveryAt = Date.now();
    return doc;
  }

  return {
    createPkce,
    randomToken,

    async authorizeUrl({ state, nonce, codeChallenge, redirectUriOverride }) {
      const doc = await discover();
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUriOverride || redirectUri,
        response_type: 'code',
        scope,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return `${doc.authorization_endpoint}?${params.toString()}`;
    },

    async exchangeCode({ code, codeVerifier, redirectUriOverride }) {
      const doc = await discover();
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUriOverride || redirectUri,
        code_verifier: codeVerifier,
        client_id: clientId,
      });
      if (clientSecret) body.set('client_secret', clientSecret);
      const response = await fetchWithTimeout(doc.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch { /* 下面按非 JSON 报错 */ }
      if (!response.ok || !payload?.access_token) {
        const detail = payload?.error_description || payload?.error || text.slice(0, 200);
        throw new Error(`换 token 失败：HTTP ${response.status} ${detail}`);
      }
      return payload;
    },

    async userinfo(accessToken) {
      const doc = await discover();
      const response = await fetchWithTimeout(doc.userinfo_endpoint, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch { /* 下面按非 JSON 报错 */ }
      if (!response.ok || !payload?.sub) {
        throw new Error(`取 userinfo 失败：HTTP ${response.status} ${text.slice(0, 200)}`);
      }
      return payload;
    },

    async endSessionUrl(idToken, postLogoutRedirect) {
      const doc = await discover();
      if (!doc.end_session_endpoint) return null;
      const params = new URLSearchParams();
      if (idToken) params.set('id_token_hint', idToken);
      if (postLogoutRedirect) params.set('post_logout_redirect_uri', postLogoutRedirect);
      const query = params.toString();
      return query ? `${doc.end_session_endpoint}?${query}` : doc.end_session_endpoint;
    },
  };
}

/** 把 userinfo 归一化成平台用户字段。 */
function claimsToProfile(claims) {
  return {
    subject: String(claims.sub),
    displayName: typeof claims.name === 'string' ? claims.name : '',
    avatarUrl: typeof claims.picture === 'string' ? claims.picture : '',
    openid: typeof claims.openid === 'string' ? claims.openid : '',
    unionId: typeof claims.unionid === 'string' ? claims.unionid : '',
    wechatAppid: typeof claims.wechat_appid === 'string' ? claims.wechat_appid : '',
    provider: typeof claims.provider === 'string' ? claims.provider : '',
  };
}

module.exports = { createOidcClient, claimsToProfile, createPkce, randomToken };
