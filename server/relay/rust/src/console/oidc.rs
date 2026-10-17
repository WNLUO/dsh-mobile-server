//! 微信登录（OIDC）：接一套标准 OIDC 聚合登录系统（基址由 `PLATFORM_OIDC_ISSUER` 给）。
//!
//! 与 Node 运营版（`lib/platform/oidc.js`）同一个客户端注册、同一套约束，**逐条搬**：
//!   - `/oauth2/token` 只吃 `application/x-www-form-urlencoded`，不是 JSON；
//!   - `code_challenge` 长度必须恰好 43（48 字节随机 → SHA-256 → base64url）；
//!   - `redirect_uri` 必须逐条精确命中登录系统那边的白名单；
//!   - 换 token 放在**自己后端**（confidential 客户端），浏览器永远看不到 client_secret，
//!     也因此完全绕开 CORS。
//!
//! 这几条都是实测出来的硬约束，不是推测，改之前先回 Node 版那段注释对一遍。

use std::time::{Duration, Instant};

use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::config::ConsoleConfig;

/// 授权事务：一次登录从跳转到回调之间的服务端状态。
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// 生成 PKCE。verifier 48 字节 → base64url 恰 64 字符；challenge 是它的 SHA-256 →
/// base64url 恰 43 字符（登录系统卡这个长度，少了直接 401）。
pub fn create_pkce() -> Pkce {
    use rand::RngCore;
    let mut bytes = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = base64_url(&bytes);
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64_url(&digest);
    Pkce { verifier, challenge }
}

/// 随机串（state / nonce / 会话 token 都用它）。
pub fn random_token(bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    base64_url(&buf)
}

fn base64_url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// sha256 十六进制。会话 token 只存它，库被读走也拿不到能用的 token。
pub fn sha256_hex(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Clone, Deserialize)]
struct Discovery {
    authorization_endpoint: String,
    token_endpoint: String,
    userinfo_endpoint: String,
}

/// userinfo 里我们用得到的字段。
///
/// **整个结构体从 `serde_json::Value` 里手工取，不做类型约束。** 这是踩出来的结论，
/// 不是偷懒：登录系统对这些字段并不保证类型——2026-10-17 线上连着撞了两次，
/// 先是 `sub` 根本不返回（声明支持、实际不发），再是 `unionid` 发的是 `null`。
/// 每撞一次改一次符号类型，等于拿生产环境当测试台。
///
/// 所以这里**一次把所有坑封掉**：字段可能是字符串、`null`、数字、对象……统一过
/// `as_str()`，取不到就当空串。将来它多发或互换类型都不会再让登录失败。
///
/// 身份标识按优先级取：`sub`（OIDC 标准）→ `unionid`（微信跨应用稳定）→ `openid`。
/// 取到哪个都加前缀，**不能混用**——同一个人的 sub 与 openid 是两个不同字符串，
/// 混着用会让同一个人被当成两个账号。
#[derive(Debug, Clone, Default)]
pub struct Claims {
    pub sub: String,
    pub name: String,
    pub picture: String,
    pub openid: String,
    pub unionid: String,
}

impl Claims {
    /// 从任意 JSON 里尽量取。**永远成功**：取不到的字段是空串，不报错。
    pub fn from_json(value: &serde_json::Value) -> Self {
        // 只有字符串才算数；`null`、数字、对象一律当没有。刻意不做「数字转字符串」，
        // 那是猜测语义，取不到比取错好。
        let text = |key: &str| -> String {
            value
                .get(key)
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string()
        };
        Self {
            sub: text("sub"),
            name: text("name"),
            picture: text("picture"),
            openid: text("openid"),
            unionid: text("unionid"),
        }
    }

    /// 这个人是谁。返回 `(前缀化后的稳定键, 用的是哪个字段)`。
    pub fn identity_key(&self) -> Option<(String, &'static str)> {
        if !self.sub.is_empty() {
            return Some((format!("sub:{}", self.sub), "sub"));
        }
        if !self.unionid.is_empty() {
            return Some((format!("unionid:{}", self.unionid), "unionid"));
        }
        if !self.openid.is_empty() {
            return Some((format!("openid:{}", self.openid), "openid"));
        }
        None
    }
}

/// OIDC 客户端。发现文档带缓存，避免每次登录都拉一遍。
pub struct OidcClient {
    issuer: String,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    scope: String,
    http: reqwest::Client,
    cached: tokio::sync::Mutex<Option<(Discovery, Instant)>>,
}

impl OidcClient {
    pub fn new(config: &ConsoleConfig) -> Self {
        Self {
            issuer: config.oidc_issuer.clone(),
            client_id: config.oidc_client_id.clone(),
            client_secret: config.oidc_client_secret.clone(),
            redirect_uri: config.oidc_redirect_uri.clone(),
            scope: config.oidc_scope.clone(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_millis(config.oidc_timeout_ms))
                .build()
                .unwrap_or_default(),
            cached: tokio::sync::Mutex::new(None),
        }
    }

    async fn discover(&self) -> Result<Discovery, String> {
        {
            let guard = self.cached.lock().await;
            if let Some((doc, at)) = guard.as_ref() {
                if at.elapsed() < Duration::from_secs(600) {
                    return Ok(doc.clone());
                }
            }
        }
        let url = format!("{}/.well-known/openid-configuration", self.issuer);
        let response = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("拉取 OIDC 发现文档失败：{e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "拉取 OIDC 发现文档失败：HTTP {}",
                response.status().as_u16()
            ));
        }
        let doc: Discovery = response
            .json()
            .await
            .map_err(|e| format!("OIDC 发现文档解析失败：{e}"))?;
        if doc.authorization_endpoint.is_empty() || doc.token_endpoint.is_empty() {
            return Err("OIDC 发现文档缺少 authorization_endpoint / token_endpoint".into());
        }
        let mut guard = self.cached.lock().await;
        *guard = Some((doc.clone(), Instant::now()));
        Ok(doc)
    }

    /// 拼出跳转到登录系统的 URL。回调固定走我们自己这台中转的 `/auth/callback`。
    pub async fn authorize_url(
        &self,
        state: &str,
        nonce: &str,
        code_challenge: &str,
    ) -> Result<String, String> {
        let doc = self.discover().await?;
        let params = [
            ("client_id", self.client_id.as_str()),
            ("redirect_uri", self.redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", self.scope.as_str()),
            ("state", state),
            ("nonce", nonce),
            ("code_challenge", code_challenge),
            ("code_challenge_method", "S256"),
        ];
        let query = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, url_encode(v)))
            .collect::<Vec<_>>()
            .join("&");
        Ok(format!("{}?{query}", doc.authorization_endpoint))
    }

    /// 用 code 换 token。**表单提交**，不是 JSON。
    pub async fn exchange_code(&self, code: &str, code_verifier: &str) -> Result<String, String> {
        let doc = self.discover().await?;
        let mut form = vec![
            ("grant_type", "authorization_code".to_string()),
            ("code", code.to_string()),
            ("redirect_uri", self.redirect_uri.clone()),
            ("code_verifier", code_verifier.to_string()),
            ("client_id", self.client_id.clone()),
        ];
        if !self.client_secret.is_empty() {
            form.push(("client_secret", self.client_secret.clone()));
        }
        let body = form
            .iter()
            .map(|(k, v)| format!("{}={}", k, url_encode(v)))
            .collect::<Vec<_>>()
            .join("&");
        let response = self
            .http
            .post(&doc.token_endpoint)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|e| format!("换 token 请求失败：{e}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let payload: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        let access_token = payload
            .get("access_token")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !status.is_success() || access_token.is_empty() {
            let detail = payload
                .get("error_description")
                .and_then(|v| v.as_str())
                .or_else(|| payload.get("error").and_then(|v| v.as_str()))
                .unwrap_or_else(|| safe_prefix(&text, 200));
            return Err(format!("换 token 失败：HTTP {} {detail}", status.as_u16()));
        }
        Ok(access_token)
    }

    /// 取 userinfo。`sub` 是登录系统的 user_id（subject_type=public），跨登录稳定。
    pub async fn userinfo(&self, access_token: &str) -> Result<Claims, String> {
        let doc = self.discover().await?;
        let response = self
            .http
            .get(&doc.userinfo_endpoint)
            .header("authorization", format!("Bearer {access_token}"))
            .send()
            .await
            .map_err(|e| format!("取 userinfo 请求失败：{e}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        // ⚠️ 解析失败**不能静默吞掉**：`unwrap_or_default()` 会让 claims 全空，
        // 报出去的原因就变成「没有身份标识」，把真正的解析错误盖住了——线上排查时
        // 就卡在这一层，明明返回体里有 openid 却报读不到。
        // 只想拿到「是不是合法 JSON」。字段层面用 `Claims::from_json` 容错，
        // 不在这里因为某个字段是 null 就判登录失败。
        let value: serde_json::Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(error) => {
                return Err(format!(
                    "userinfo 不是合法 JSON：{error}（收到 {} 字节）；返回体前 200 字节：{}",
                    text.len(),
                    safe_prefix(&text, 200)
                ))
            }
        };
        let claims = Claims::from_json(&value);
        if !status.is_success() {
            return Err(format!(
                "取 userinfo 失败：HTTP {} {}",
                status.as_u16(),
                safe_prefix(&text, 200)
            ));
        }
        Ok(claims)
    }
}

/// 百分号编码，够 URL 查询串与表单体用。不引额外依赖。
/// 按**字符**截断，不按字节。中文与 emoji 一个字符占多字节，按字节切会切在码点中间，
/// `&text[..n]` 直接 panic（`byte index is not a char boundary`）。
fn safe_prefix(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn url_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 从查询串里取一个参数（解码 `%XX` 与 `+`）。
///
/// **要吃掉前导 `?`**：中转进程里 `RequestHead.query` 存的就是 `?a=b` 这种带问号的
/// 形式（与转发帧拼路径时直接拼接很方便）。不去掉的话首个键名会是 `?platform`，
/// 永远匹配不上——这条踩过，表现为「参数全都读不到」。
pub fn query_param(query: &str, name: &str) -> Option<String> {
    let query = query.strip_prefix('?').unwrap_or(query);
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key == name {
            return Some(url_decode(value));
        }
    }
    None
}

fn url_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_exactly_43_chars() {
        // 登录系统卡这个长度：少了直接 401，且不给提示。
        for _ in 0..20 {
            let pkce = create_pkce();
            assert_eq!(pkce.challenge.len(), 43, "{}", pkce.challenge);
            // 48 字节 → base64url 无填充 = 64 字符
            assert_eq!(pkce.verifier.len(), 64, "{}", pkce.verifier);
        }
    }

    #[test]
    fn pkce_challenge_matches_rfc7636_example() {
        // RFC 7636 附录 B 的向量：verifier → challenge。
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let digest = Sha256::digest(verifier.as_bytes());
        assert_eq!(
            base64_url(&digest),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn sha256_hex_matches_known_digest() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    fn parse(text: &str) -> Claims {
        Claims::from_json(&serde_json::from_str(text).expect("测试输入应该是合法 JSON"))
    }

    #[test]
    fn identity_falls_back_when_sub_is_missing() {
        // 线上实际返回体：没有 sub，只有 name/picture/provider/openid。
        let claims = parse(r#"{"name":"某人","openid":"oD1go6hrMFTO9hWjfpO00IJkzvWo","picture":"https://x/y.jpg","provider":"wechat_mp"}"#);
        let (key, source) = claims.identity_key().expect("有 openid 就该认得出来");
        assert_eq!(source, "openid");
        assert_eq!(key, "openid:oD1go6hrMFTO9hWjfpO00IJkzvWo");

        assert_eq!(parse(r#"{"sub":"abc","openid":"oX"}"#).identity_key(), Some(("sub:abc".into(), "sub")));
        // unionid 比 openid 稳，排在它前面。
        assert_eq!(parse(r#"{"unionid":"u1","openid":"oX"}"#).identity_key(), Some(("unionid:u1".into(), "unionid")));
        assert_eq!(parse(r#"{"name":"x"}"#).identity_key(), None);
    }

    #[test]
    fn null_and_odd_types_never_break_login() {
        // 线上撞过的第二种：unionid 是 null。放宽成「任何类型都不炸」之后，
        // 这类响应必须照常登进去，而不是报解析失败。
        let claims = parse(r#"{"name":"某人","openid":"oX","unionid":null,"sub":null,"picture":null}"#);
        assert_eq!(claims.identity_key(), Some(("openid:oX".into(), "openid")));
        assert_eq!(claims.name, "某人");
        assert!(claims.picture.is_empty());

        // 数字、对象、数组这些也不该炸——取不到就当没有。
        let odd = parse(r#"{"sub":123,"unionid":{"a":1},"openid":["x"],"name":true}"#);
        assert_eq!(odd.identity_key(), None, "非字符串一律当空，不猜测语义");
        assert!(odd.name.is_empty());

        // 字段互换类型也不影响能认出来的那个。
        assert_eq!(
            parse(r#"{"openid":"oY","name":123,"picture":{}}"#).identity_key(),
            Some(("openid:oY".into(), "openid"))
        );
    }

    #[test]
    fn identity_keys_never_collide_across_sources() {
        let a = parse(r#"{"sub":"same"}"#);
        let b = parse(r#"{"openid":"same"}"#);
        assert_ne!(a.identity_key().unwrap().0, b.identity_key().unwrap().0);
    }

    #[test]
    fn safe_prefix_never_splits_a_character() {
        // 中英混排 + emoji：按字节硬切会 panic，这里必须切在字符边界上。
        let text = "卤醋鸭圆圆椰🍀".repeat(20);
        for limit in [1usize, 2, 3, 5, 7, 199, 200] {
            let cut = safe_prefix(&text, limit);
            assert!(text.starts_with(cut));
            assert!(cut.len() <= limit || limit < 4);
        }
    }

    #[test]
    fn query_params_round_trip() {
        // 带前导 `?` 的形式也要认：这是中转进程内部存查询串的形状。
        assert_eq!(
            query_param("?platform=darwin&channel=stable", "platform"),
            Some("darwin".to_string())
        );
        assert_eq!(
            query_param("?platform=darwin&channel=stable", "channel"),
            Some("stable".to_string())
        );
        let query = "code=abc%2Fdef&state=xyz&empty=";
        assert_eq!(query_param(query, "code"), Some("abc/def".to_string()));
        assert_eq!(query_param(query, "state"), Some("xyz".to_string()));
        assert_eq!(query_param(query, "empty"), Some(String::new()));
        assert_eq!(query_param(query, "missing"), None);
    }

    #[test]
    fn url_encode_escapes_reserved() {
        assert_eq!(url_encode("a b/c"), "a%20b%2Fc");
        assert_eq!(url_encode("abc-_.~"), "abc-_.~");
    }
}
