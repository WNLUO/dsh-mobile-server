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

/// 一条载荷要守的字节预算。APNs 硬上限 4096，留出余量：超过就先降级再发。
const PAYLOAD_BUDGET: usize = 3800;

/// 这台设备对这条推送的态度。`Off` 只影响这一条、这一台设备。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Level {
    /// 照发，带声音（没有偏好、偏好坏了、认不出的种类都走这里）。
    Normal,
    /// 照发，但不响：去掉 sound，标成 passive。
    Silent,
    /// 不发。
    Off,
}

/// 给一台设备的令牌发一条完成提醒。未配置时直接返回，不当错误。
///
/// `device_id` 为空 = 这台实例登记过的全部令牌（宿主侧 push-notify 就是这么发
/// 「推给我所有设备」的）；非空时只发对应那一条。`category` 非空才写进 aps，
/// 老推送不传时载荷与以前等价。`interaction` 原样透传成顶层 `dshInteraction`，
/// 供审批 / 提问类通知带交互数据。
///
/// `kind` 是宿主发的事件种类（`completed` / `failed` / `approval` / `question` /
/// `plan-review`），`prefs` 是该实例各设备的提醒偏好 `(device_id, 原始 JSON)`。
/// 两者都缺省时（老宿主）行为与以前逐字一致：照发、带声音。
pub async fn send_completion(instance_id: &str, device_id: &str, tokens: &[(String, String)], title: &str, body: &str, session_id: &str, category: &str, interaction: Option<&serde_json::Value>, kind: &str, prefs: &[(String, String)]) {
    let Some(client) = CLIENT.get().and_then(|c| c.as_ref()) else {
        return;
    };
    for (token_device, token) in tokens {
        if !should_send(token_device, device_id) {
            continue;
        }
        // 偏好按设备分开算：同一轮推送里可能一台要、一台不要、一台偷偷要。
        let level = device_level(prefs_for(prefs, token_device), kind, session_id);
        if level == Level::Off {
            continue;
        }
        let mut payload = build_payload_with_sound(
            instance_id,
            title,
            body,
            session_id,
            category,
            interaction,
            level == Level::Normal,
        );
        fit_payload(&mut payload);
        if let Err(reason) = client.send(token, &payload).await {
            crate::tunnel::log(format!("apns send failed instance={instance_id} device={device_id}: {reason}"));
        }
    }
}

/// 目标令牌是否该发：空 `device_id` 命中该实例全部令牌，非空时只命中同名设备。
fn should_send(token_device: &str, device_id: &str) -> bool {
    device_id.is_empty() || token_device == device_id
}

/// 取一台设备的偏好原文（没上报过就是 None）。
fn prefs_for<'a>(prefs: &'a [(String, String)], device_id: &str) -> Option<&'a str> {
    prefs
        .iter()
        .find(|(device, _)| device == device_id)
        .map(|(_, json)| json.as_str())
}

/// 宿主的事件种类 → 偏好里的分级键。认不出的种类返回 None（按正常推）。
fn prefs_key(kind: &str) -> Option<&'static str> {
    match kind {
        "completed" => Some("done"),
        "failed" => Some("failed"),
        "approval" => Some("approval"),
        "question" => Some("question"),
        "plan-review" => Some("planReview"),
        _ => None,
    }
}

/// 这台设备的偏好对这条推送下的结论。
///
/// 解析失败 / 结构不对一律当「没有偏好」：多提醒一次好过悄悄吞掉一条。
fn device_level(prefs_json: Option<&str>, kind: &str, session_id: &str) -> Level {
    let Some(prefs_json) = prefs_json else {
        return Level::Normal;
    };
    let Ok(prefs) = serde_json::from_str::<serde_json::Value>(prefs_json) else {
        return Level::Normal;
    };
    // 静音会话优先于分级：`muted` 是 `["scope:sessionId", ...]`，任一项以
    // `:<sessionId>` 结尾就算这个会话被静音。
    if !session_id.is_empty() {
        let suffix = format!(":{session_id}");
        let muted = prefs.get("muted").and_then(|v| v.as_array());
        if let Some(list) = muted {
            let hit = list
                .iter()
                .filter_map(|item| item.as_str())
                .any(|item| item.ends_with(&suffix));
            if hit {
                return Level::Off;
            }
        }
    }
    let Some(key) = prefs_key(kind) else {
        return Level::Normal;
    };
    match prefs.get("levels").and_then(|v| v.get(key)).and_then(|v| v.as_str()) {
        Some("off") => Level::Off,
        Some("silent") => Level::Silent,
        _ => Level::Normal,
    }
}

/// 组装推送载荷。`category` 为空不写 aps.category，`interaction` 为 None 不写
/// 顶层 dshInteraction——老推送的载荷因此与原样逐字等价。
#[cfg(test)]
fn build_payload(instance_id: &str, title: &str, body: &str, session_id: &str, category: &str, interaction: Option<&serde_json::Value>) -> serde_json::Value {
    build_payload_with_sound(instance_id, title, body, session_id, category, interaction, true)
}

/// 同上，外加「要不要响」：`silent` 时去掉 sound、标成 passive，通知不亮屏也不响。
fn build_payload_with_sound(instance_id: &str, title: &str, body: &str, session_id: &str, category: &str, interaction: Option<&serde_json::Value>, sound: bool) -> serde_json::Value {
    let mut aps = json!({
        "alert": { "title": title, "body": body },
    });
    if sound {
        aps["sound"] = json!("default");
    } else {
        aps["interruption-level"] = json!("passive");
    }
    if !category.is_empty() {
        aps["category"] = json!(category);
    }
    let mut payload = json!({
        "aps": aps,
        // 自定义键：App 点通知跳会话用。
        "sessionId": session_id,
        "instanceId": instance_id,
    });
    if let Some(interaction) = interaction {
        payload["dshInteraction"] = interaction.clone();
    }
    payload
}

/// 载荷字节数（APNs 按这份 JSON 计）。
fn payload_size(payload: &serde_json::Value) -> usize {
    serde_json::to_vec(payload).map(|bytes| bytes.len()).unwrap_or(0)
}

/// 载荷瘦身：超预算先丢交互数据，再丢类别，最后截正文——只有这一条受影响。
///
/// 降级顺序是有讲究的：交互数据最贵（审批选项整份塞在里面），类别丢了顶多少
/// 几个通知按钮，正文丢了就只是一条普通提醒。都不改全局，下一条照常完整发。
fn fit_payload(payload: &mut serde_json::Value) {
    if payload_size(payload) <= PAYLOAD_BUDGET {
        return;
    }
    if let Some(map) = payload.as_object_mut() {
        map.remove("dshInteraction");
    }
    if payload_size(payload) <= PAYLOAD_BUDGET {
        return;
    }
    if let Some(aps) = payload.get_mut("aps").and_then(|v| v.as_object_mut()) {
        aps.remove("category");
    }
    if payload_size(payload) <= PAYLOAD_BUDGET {
        return;
    }
    // 还超就只能是标题 / 正文太长（工具输出整段贴进通知文本）。转义会放大字节数，
    // 所以退着砍而不是按比例一次砍到位。
    if truncate_field(payload, "body") || payload_size(payload) > PAYLOAD_BUDGET {
        truncate_field(payload, "title");
    }
}

/// 把 `aps.alert.<field>` 反复砍到四分之三，直到载荷进预算。已经砍空返回 true。
fn truncate_field(payload: &mut serde_json::Value, field: &str) -> bool {
    loop {
        let mut text = payload["aps"]["alert"][field].as_str().unwrap_or("").to_string();
        if text.is_empty() || payload_size(payload) <= PAYLOAD_BUDGET {
            return text.is_empty();
        }
        let mut keep = text.len() * 3 / 4;
        while keep > 0 && !text.is_char_boundary(keep) {
            keep -= 1;
        }
        text.truncate(keep);
        payload["aps"]["alert"][field] = serde_json::Value::String(text);
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

    /// 空 deviceId 是「推给该实例全部令牌」，不能被当成无效目标丢掉；
    /// 非空时只命中同名设备。
    #[test]
    fn empty_device_id_targets_all_tokens() {
        assert!(should_send("dev-a", ""));
        assert!(should_send("dev-b", ""));
        assert!(should_send("dev-a", "dev-a"));
        assert!(!should_send("dev-a", "dev-b"));
    }

    /// 富推送：category 进 aps，interaction 原样进顶层 dshInteraction，
    /// 基础字段一个不少。
    #[test]
    fn payload_carries_category_and_interaction() {
        let interaction = json!({ "kind": "approval", "id": "req-1", "options": ["yes", "no"] });
        let payload = build_payload("inst-1", "请审批", "工具调用", "sess-9", "DSH_APPROVAL", Some(&interaction));
        assert_eq!(payload["aps"]["category"], "DSH_APPROVAL");
        assert_eq!(payload["aps"]["sound"], "default");
        assert_eq!(payload["aps"]["alert"]["title"], "请审批");
        assert_eq!(payload["aps"]["alert"]["body"], "工具调用");
        assert_eq!(payload["dshInteraction"], interaction);
        assert_eq!(payload["sessionId"], "sess-9");
        assert_eq!(payload["instanceId"], "inst-1");
    }

    /// 老推送不传 category / interaction 时，载荷与原来逐字等价：不冒出空
    /// category 键，也没有 dshInteraction。
    #[test]
    fn payload_omits_empty_category_and_interaction() {
        let payload = build_payload("inst-1", "完成", "done", "sess-9", "", None);
        assert!(payload["aps"].get("category").is_none(), "空 category 不许写出");
        assert!(payload.get("dshInteraction").is_none());
        assert_eq!(payload["aps"]["alert"]["title"], "完成");
        assert_eq!(payload["sessionId"], "sess-9");
        assert_eq!(payload["instanceId"], "inst-1");
    }

    #[test]
    fn disabled_by_default() {
        // 没配任何 APNS_* 时 enabled 必须是 false——纯转发部署一个字不用改。
        // OnceLock 只能设一次，所以这条只测「没 init 之前」的读法。
        assert!(!enabled());
    }

    /// 分级映射与「缺失 / 坏了 / 认不出都照发」：只有明确 off / silent 才改变行为。
    #[test]
    fn levels_map_by_kind_and_fail_open() {
        let prefs = r#"{"levels":{"done":"off","failed":"silent","planReview":"silent"}}"#;
        assert_eq!(device_level(Some(prefs), "completed", "s1"), Level::Off);
        assert_eq!(device_level(Some(prefs), "failed", "s1"), Level::Silent);
        assert_eq!(device_level(Some(prefs), "plan-review", "s1"), Level::Silent);
        // 没配的分级、认不出的种类、坏 JSON、没有偏好：一律照常带声音。
        assert_eq!(device_level(Some(prefs), "question", "s1"), Level::Normal);
        assert_eq!(device_level(Some(prefs), "whatever", "s1"), Level::Normal);
        assert_eq!(device_level(Some("{坏"), "completed", "s1"), Level::Normal);
        assert_eq!(device_level(None, "completed", "s1"), Level::Normal);
    }

    /// 静音的会话按 `<scope>:<sessionId>` 后缀匹配：换会话照推，空 sessionId 不误伤。
    #[test]
    fn muted_sessions_suppress_by_session_suffix() {
        let prefs = r#"{"muted":["session:sess-9","worktree:wt-1"]}"#;
        assert_eq!(device_level(Some(prefs), "completed", "sess-9"), Level::Off);
        assert_eq!(device_level(Some(prefs), "completed", "sess-90"), Level::Normal);
        assert_eq!(device_level(Some(prefs), "completed", ""), Level::Normal);
    }

    /// silent 去掉 sound 并标 passive；正常仍是 default。
    #[test]
    fn silent_payload_drops_sound() {
        let loud = build_payload_with_sound("i", "t", "b", "s", "", None, true);
        assert_eq!(loud["aps"]["sound"], "default");
        assert!(loud["aps"].get("interruption-level").is_none());
        let quiet = build_payload_with_sound("i", "t", "b", "s", "", None, false);
        assert!(quiet["aps"].get("sound").is_none());
        assert_eq!(quiet["aps"]["interruption-level"], "passive");
    }

    /// 载荷超预算时依次丢 dshInteraction、aps.category，最终仍在 APNs 上限内。
    #[test]
    fn oversized_payload_degrades_until_it_fits() {
        let interaction = json!({ "kind": "approval", "blob": "x".repeat(5000) });
        let mut payload = build_payload("i", "审批", "工具调用", "s", "DSH_APPROVAL", Some(&interaction));
        assert!(payload_size(&payload) > 4096);
        fit_payload(&mut payload);
        assert!(payload_size(&payload) < 4096);
        assert!(payload.get("dshInteraction").is_none(), "先丢交互数据");
        assert_eq!(payload["aps"]["category"], "DSH_APPROVAL", "丢完就够，不必再丢类别");
    }

    /// 类别也丢了还不够就砍正文，且不砍坏多字节字符。
    #[test]
    fn oversized_body_is_truncated_on_char_boundary() {
        let mut payload = build_payload("i", "完成", &"工".repeat(3000), "s", "DSH_DONE", None);
        assert!(payload_size(&payload) > 4096);
        fit_payload(&mut payload);
        assert!(payload_size(&payload) < 4096);
        assert!(payload["aps"].get("category").is_none());
        let body = payload["aps"]["alert"]["body"].as_str().unwrap();
        assert!(body.chars().all(|c| c == '工'), "截断不能切出半个字符");
    }

    /// 够小的载荷一个字节都不动。
    #[test]
    fn small_payload_is_untouched() {
        let mut payload = build_payload("i", "完成", "done", "s", "DSH_DONE", Some(&json!({"kind":"approval"})));
        let before = serde_json::to_string(&payload).unwrap();
        fit_payload(&mut payload);
        assert_eq!(serde_json::to_string(&payload).unwrap(), before);
    }
}
