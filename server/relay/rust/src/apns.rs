//! APNs 推送转发：任务完成时把通知递到苹果，由苹果送到离线 / 后台的 iPhone。
//!
//! 鉴权用 **token-based**（`.p8` 密钥 + provider JWT），不用证书：密钥不过期
//! （证书一年一换），一台密钥能推该团队全部 App。部署方提供三样配置：
//! `APNS_KEY`（.p8 内容或路径）、`APNS_KEY_ID`、`APNS_TEAM_ID`。**任何一个不配，
//! 推送就是关的**——纯转发部署什么也不用改。
//!
//! 刻意不做的事：不重试（苹果没收到就等下次完成事件的提示音 / 常驻通知兜底，
//! 推送是增强不是唯一通道）；不缓存设备令牌的删除回调（令牌失效由 App 下次
//! 启动重新上报覆盖）；连接不复用 HTTP/2（reqwest 内部有连接池，够用）。

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::pkcs8;
use serde_json::json;

/// APNs 生产环境入口。开发环境（沙盒）令牌也能打到生产入口（苹果接受），不必分档。
const APNS_URL: &str = "https://api.push.apple.com/3/device";

/// 一份可用的推送配置。三者齐全才算配置过。
#[derive(Clone)]
pub struct ApnsConfig {
    pub team_id: String,
    pub key_id: String,
    private_key: Arc<SigningKey>,
}

impl ApnsConfig {
    /// 从部署配置装配。`key` 接受 PEM 内容或文件路径（含 `~` 展开）。
    /// 任一要素缺失 / 密钥解析失败都返回 `Err`，调用方据此判定推送关闭。
    pub fn from_env() -> Result<Self, String> {
        let team_id = non_empty("APNS_TEAM_ID")?;
        let key_id = non_empty("APNS_KEY_ID")?;
        let key = non_empty("APNS_KEY")?;
        Self::from_parts(&team_id, &key_id, &key)
    }

    /// 三要素显式装配（测试用它避开环境变量的全局性）。
    fn from_parts(team_id: &str, key_id: &str, key: &str) -> Result<Self, String> {
        let pem = load_pem(key)?;
        // PKCS#8 解码走 `TryFrom<PrivateKeyInfo>`（`pkcs8` feature 就有），PEM 的
        // base64 剥壳自己做——不为此引入 `pem` feature（它只是 FromStr 的糖）。
        let der = pem_to_der(&pem)?;
        let signing = SigningKey::try_from(
            pkcs8::PrivateKeyInfo::try_from(der.as_slice())
                .map_err(|error| format!("APNS_KEY 不是可解析的 ES256 私钥：{error}"))?,
        )
        .map_err(|error| format!("APNS_KEY 不是可解析的 ES256 私钥：{error}"))?;
        Ok(Self {
            team_id: team_id.to_string(),
            key_id: key_id.to_string(),
            private_key: Arc::new(signing),
        })
    }

    /// 签一份 provider JWT。每次发送都现签（不缓存过期时间，30 分钟内苹果都认，
    /// 签一次是微秒级，不值得缓存逻辑引入的时钟账）。
    fn provider_jwt(&self) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let header = json!({ "alg": "ES256", "kid": self.key_id });
        let claims = json!({ "iss": self.team_id, "iat": now });
        let encode = |value: &serde_json::Value| {
            base64_url(serde_json::to_string(value).unwrap_or_default().as_bytes())
        };
        let signing_input = format!("{}.{}", encode(&header), encode(&claims));
        let signature: Signature = self.private_key.sign(signing_input.as_bytes());
        format!("{signing_input}.{}", base64_url(&signature.to_bytes()))
    }
}

/// 中转的推送出口。`None` = 推送未配置（功能关闭）。
pub struct ApnsClient {
    config: ApnsConfig,
    http: reqwest::Client,
}

impl ApnsClient {
    pub fn new(config: ApnsConfig) -> Self {
        Self {
            config,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("reqwest client with timeout"),
        }
    }

    /// 发一条推送。失败只记日志：推送是增强通道，失败不该影响转发路径。
    pub async fn send(&self, token: &str, payload: &serde_json::Value) -> Result<(), String> {
        let jwt = self.config.provider_jwt();
        let response = self
            .http
            .post(format!("{APNS_URL}/{token}"))
            .header("authorization", format!("bearer {}", jwt))
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .json(payload)
            .send()
            .await
            .map_err(|error| format!("apns request failed: {error}"))?;
        let status = response.status();
        if status.is_success() {
            Ok(())
        } else {
            // 苹果的错误响应体带 reason（如 BadDeviceToken / ExpiredProviderToken），
            // 原样带出来，部署方日志里能直接对照苹果的码表。
            let body = response.text().await.unwrap_or_default();
            Err(format!("apns rejected ({status}): {body}"))
        }
    }
}

/// 全局出口。启动时配置过才有；其余全部路径先问它。
static CLIENT: std::sync::OnceLock<Option<ApnsClient>> = std::sync::OnceLock::new();

/// 装配全局推送出口。配置缺失 / 密钥解析失败都只是打一条日志，**不崩**：
/// 推送关闭的中转照常转发。
pub fn init_from_env() {
    let client = match ApnsConfig::from_env() {
        Ok(config) => Some(ApnsClient::new(config)),
        Err(reason) => {
            crate::tunnel::log(format!("apns disabled: {reason}"));
            None
        }
    };
    let _ = CLIENT.set(client);
}

/// 推送开关是否打开（诊断与 /config 露出用）。
pub fn enabled() -> bool {
    CLIENT.get().map(|c| c.is_some()).unwrap_or(false)
}

/// 给一台设备的令牌发一条完成提醒。未配置时直接返回，不当错误。
pub async fn send_completion(instance_id: &str, device_id: &str, tokens: &[(String, String)], title: &str, body: &str, session_id: &str) {
    let Some(client) = CLIENT.get().and_then(|c| c.as_ref()) else {
        return;
    };
    let payload = json!({
        "aps": {
            "alert": { "title": title, "body": body },
            "sound": "default",
        },
        // 自定义键：App 点通知跳会话用。
        "sessionId": session_id,
        "instanceId": instance_id,
    });
    for (token_device, token) in tokens {
        // 只发给目标设备；找不到（理论上不会，令牌表按设备存）就跳过。
        if token_device != device_id {
            continue;
        }
        if let Err(reason) = client.send(token, &payload).await {
            crate::tunnel::log(format!("apns send failed instance={instance_id} device={device_id}: {reason}"));
        }
    }
}

fn non_empty(name: &str) -> Result<String, String> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Ok(value.trim().to_string()),
        _ => Err(format!("{name} not set")),
    }
}

/// `.p8` 来源：内容（以 `-----BEGIN` 开头）或文件路径（支持 `~/` 展开）。
fn load_pem(key: &str) -> Result<String, String> {
    if key.starts_with("-----BEGIN") {
        return Ok(key.to_string());
    }
    let path = if let Some(rest) = key.strip_prefix("~/") {
        let home = std::env::var("HOME").map_err(|_| "APNS_KEY 带了 ~ 但拿不到 HOME".to_string())?;
        std::path::PathBuf::from(home).join(rest)
    } else {
        std::path::PathBuf::from(key)
    };
    std::fs::read_to_string(&path).map_err(|error| format!("APNS_KEY 文件读不到（{}）：{error}", path.display()))
}

fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 剥 PEM 壳：取 `-----BEGIN … KEY-----` 与 `-----END … KEY-----` 之间的 base64，
/// 拼起来解成 DER。只认标准 p8 的 PKCS#8 形状。
fn pem_to_der(pem: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    let body = pem
        .lines()
        .filter(|line| !line.starts_with("-----") && !line.trim().is_empty())
        .collect::<String>();
    base64::engine::general_purpose::STANDARD
        .decode(body.as_bytes())
        .map_err(|error| format!("APNS_KEY 的 base64 段解不开：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一把真实的 ES256 测试私钥（生成后写死在这里；它从未在苹果侧注册过，
    /// 推不出任何真实通知）。
    const TEST_KEY: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnqsiMNGt7P+R25vT
QnJWqSruOaP2dlbximQ4um4KBtWhRANCAAThnyzbyWh4vpzzJPfoF1r9CJANhtdZ
V1n0uBVNK/D9VvFM1bkevUBnaglIzsphCotUxHuowB+PU2hnSYfp1bZ8
-----END PRIVATE KEY-----";

    #[test]
    fn parses_inline_pem_and_signs() {
        let config = ApnsConfig::from_parts("TEAM", "KEYID", TEST_KEY).expect("测试密钥应可解析");
        let jwt = config.provider_jwt();
        // JWT 形状：header.payload.signature 三段 base64url。
        assert_eq!(jwt.matches('.').count(), 2, "{jwt}");
    }

    #[test]
    fn config_requires_all_three_parts() {
        std::env::remove_var("APNS_TEAM_ID");
        std::env::remove_var("APNS_KEY_ID");
        std::env::remove_var("APNS_KEY");
        assert!(ApnsConfig::from_env().is_err(), "缺配置必须判推送关闭");
    }

    #[test]
    fn inline_pem_is_accepted_as_content() {
        // load_pem 对 `-----BEGIN` 开头的内容原样返回，不落盘、不读文件。
        let pem = load_pem(TEST_KEY).unwrap();
        assert!(pem.starts_with("-----BEGIN"));
    }

    #[test]
    fn disabled_by_default() {
        // 没配任何 APNS_* 时 enabled 必须是 false——纯转发部署一个字不用改。
        // OnceLock 只能设一次，所以这条只测「没 init 之前」的读法。
        assert!(!enabled());
    }
}
