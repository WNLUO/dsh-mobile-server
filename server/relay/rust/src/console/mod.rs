//! 中转控制台：管理面、准入、账号与激活码。
//!
//! 从 Node 运营版（`server/dsh-mobile-hub/`）译过来。与转发路径的关系只有一处：
//! 隧道接入前的**准入校验**。转发本身仍然不碰数据库。
//!
//! 关闭时（`PLATFORM_ENABLED` 没设）整套模块不生效，中转退化成纯转发。
//!
//! 数据层在 crate 根的 `store`（转发侧不碰它，但准入要查激活码，所以放在同一层）。

pub mod config;
pub mod node;
pub mod ota;
pub mod oidc;
pub mod ratelimit;

use std::net::SocketAddr;
use std::time::Duration;

use ratelimit::Limiter;

use std::sync::Arc;

use serde_json::{json, Value};

use crate::store::{normalize_license_code, Store};
use config::ConsoleConfig;
use oidc::OidcClient;

/// 构建指纹。每次发布改这一行，`/config` 会把它带出来——用来确认线上跑的是哪一份。
pub const BUILD_ID: &str = "2026-10-17-mobile-status";

/// 一次控制台请求的应答。
pub struct ConsoleResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    /// 需要带上的 `set-cookie`（登录落 cookie、登出删 cookie）。
    pub set_cookie: Option<String>,
    /// 需要 302 跳走时填这里。
    pub redirect: Option<String>,
}

impl ConsoleResponse {
    pub fn json(status: u16, value: Value) -> Self {
        Self {
            status,
            content_type: "application/json; charset=utf-8",
            body: serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec()),
            set_cookie: None,
            redirect: None,
        }
    }

    pub fn text(status: u16, body: &str) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8",
            body: body.as_bytes().to_vec(),
            set_cookie: None,
            redirect: None,
        }
    }

    pub fn redirect_to(location: &str) -> Self {
        Self {
            status: 302,
            content_type: "text/plain; charset=utf-8",
            body: Vec::new(),
            set_cookie: None,
            redirect: Some(location.to_string()),
        }
    }
}

/// 控制台运行时：配置 + 数据层 + OIDC 客户端。
pub struct Console {
    pub config: ConsoleConfig,
    pub store: Store,
    pub oidc: OidcClient,
    /// 激活码校验/绑定的限流。这两个是宿主与手机匿名可调的入口。
    license_limiter: Limiter,
    /// 被控端上报的限流。正常是每 5 分钟一条，非常松。
    report_limiter: Limiter,
}

impl Console {
    pub fn new(config: ConsoleConfig) -> Result<Arc<Self>, String> {
        let store = Store::open(std::path::Path::new(&config.db_path))?;
        let oidc = OidcClient::new(&config);
        Ok(Arc::new(Self {
            license_limiter: Limiter::new(
                config.license_rate_limit,
                Duration::from_secs(config.rate_limit_window_seconds),
            ),
            report_limiter: Limiter::new(
                config.report_rate_limit,
                Duration::from_secs(config.rate_limit_window_seconds),
            ),
            config,
            store,
            oidc,
        }))
    }

    /// 这个路径是不是控制台的 API。
    pub fn matches_api(&self, pathname: &str) -> bool {
        pathname.starts_with(&self.config.api_prefix)
    }

    /// 这个路径是不是控制台的页面。
    pub fn matches_web(&self, pathname: &str) -> bool {
        pathname == self.config.web_prefix
            || pathname.starts_with(&format!("{}/", self.config.web_prefix))
    }

    fn cookie_value(&self, headers: &[(String, String)]) -> Option<String> {
        let raw = headers
            .iter()
            .find(|(k, _)| k == "cookie")
            .map(|(_, v)| v.as_str())?;
        for pair in raw.split(';') {
            if let Some((key, value)) = pair.trim().split_once('=') {
                if key == self.config.session_cookie {
                    return Some(value.to_string());
                }
            }
        }
        None
    }

    /// 当前登录用户；没登录返回 None。
    pub fn current_user(&self, headers: &[(String, String)]) -> Option<crate::store::User> {
        let token = self.cookie_value(headers)?;
        self.store.session_user(&oidc::sha256_hex(&token))
    }

    /// 处理一条控制台 API 请求。`pathname` 是剥过部署前缀的完整路径。
    pub async fn handle_api(
        &self,
        method: &str,
        pathname: &str,
        query: &str,
        headers: &[(String, String)],
        body: &[u8],
        peer: Option<SocketAddr>,
    ) -> ConsoleResponse {
        let sub = pathname
            .strip_prefix(&self.config.api_prefix)
            .unwrap_or(pathname)
            .to_string();

        // 限流只落在两个**匿名可调**的入口上，而且必须在查库之前判——
        // 限流的意义就是别让人无限次扫库。
        if method == "POST" {
            let key = ratelimit::client_key(headers, peer);
            let limited = match sub.as_str() {
                "/licenses/verify" | "/licenses/bind" => Some(&self.license_limiter),
                "/nodes/report" => Some(&self.report_limiter),
                _ => None,
            };
            if let Some(limiter) = limited {
                if !limiter.allow(&key) {
                    crate::tunnel::log(format!("限流：{sub} 来自 {key}"));
                    return ConsoleResponse::json(
                        429,
                        json!({ "ok": false, "error": "too many requests, slow down" }),
                    );
                }
            }
        }

        match (method, sub.as_str()) {
            ("GET", "/health") => ConsoleResponse::json(
                200,
                json!({ "ok": true, "service": "dsh-relay", "time": crate::store::iso_now() }),
            ),
            ("GET", "/config") => ConsoleResponse::json(
                200,
                json!({
                    "publicBaseUrl": self.config.public_base_url,
                    "apiPrefix": self.config.api_prefix,
                    "webPrefix": self.config.web_prefix,
                    "oidcEnabled": !self.config.oidc_client_secret.is_empty(),
                    // 构建指纹：部署后 `curl /config` 一眼确认跑的是哪份代码，
                    // 不用再去 strings 猜（踩过「编译成功了但跑的是旧的」）。
                    "buildId": BUILD_ID,
                }),
            ),
            ("GET", "/auth/login") => self.login(query).await,
            ("GET", "/auth/callback") => self.callback(query).await,
            ("POST", "/auth/logout") => self.logout(headers),
            ("GET", "/me") => match self.current_user(headers) {
                Some(user) => ConsoleResponse::json(200, json!({ "ok": true, "user": user })),
                None => ConsoleResponse::json(401, json!({ "ok": false, "error": "not signed in" })),
            },
            // 激活码校验与设备绑定：**不走登录**。调用方是宿主与手机，它们没有
            // 控制台账号，只认激活码本身。这两条是「一码一设备」真正生效的地方。
            ("POST", "/licenses/verify") => self.handle_verify(body),
            ("POST", "/licenses/bind") => self.handle_bind(body),
            // 被控端上报：**不走登录**。被控端没有微信账号，它只认认领码。
            // 这一条是主控端唯一对外的写入口，所以只需校验认领码。
            ("POST", "/nodes/report") => self.handle_report(headers, body).await,
            _ => self.handle_rest(method, &sub, query, headers),
        }
    }

    /// 需要登录的那些接口。
    fn handle_rest(
        &self,
        method: &str,
        sub: &str,
        query: &str,
        headers: &[(String, String)],
    ) -> ConsoleResponse {
        let Some(user) = self.current_user(headers) else {
            return ConsoleResponse::json(401, json!({ "ok": false, "error": "not signed in" }));
        };

        if method == "GET" && sub == "/overview" {
            let licenses = self.store.list_licenses(500);
            let active = licenses.iter().filter(|l| l.status == "active").count();
            let mut devices = 0;
            for license in &licenses {
                devices += self.store.count_active_devices(&license.id);
            }
            return ConsoleResponse::json(
                200,
                json!({
                    "ok": true,
                    // 这台是被控端还是自成一体的中转。面板据此显示不同区块。
                    "role": if node::is_slave(&self.config) { "slave" } else { "master" },
                    "masterUrl": self.config.master_url,
                    // 被控端专用：上次报成功的时间、上次失败的原因、多久报一次。
                    // 主控端从没人来问过它，这里一并给出去，面板按角色取用。
                    "masterLastReportAt": self.store.get_setting("master_last_report_at"),
                    "masterLastError": self.store.get_setting("master_last_error"),
                    "reportIntervalSeconds": self.config.report_interval_seconds,
                    "admissionMode": self.admission_mode(),
                    // 这台被控端是否已经被主控端接管（收过模式下发）。为真时本地面板
                    // 不该再让人改——改了下一轮也会被掰回去，那比灰着更让人困惑。
                    "modeControlled": self.is_mode_controlled(),
                    "licenseCount": licenses.len(),
                    "activeLicenseCount": active,
                    "deviceCount": devices,
                    "tunnelConnected": crate::tunnel_connected(),
                }),
            );
        }

        // 只有管理员能碰的：发码、吊销、解绑、改模式。
        if sub.starts_with("/licenses") || sub.starts_with("/settings") {
            if !user.is_admin {
                return ConsoleResponse::json(403, json!({ "ok": false, "error": "admin only" }));
            }
        }

        // ── 被控端管理（主控端视角）──────────────────────────────
        if method == "GET" && sub == "/nodes" {
            let nodes = self.store.list_nodes(200);
            return ConsoleResponse::json(200, json!({ "ok": true, "nodes": nodes }));
        }
        if method == "POST" && sub == "/nodes" {
            if !user.is_admin {
                return ConsoleResponse::json(403, json!({ "ok": false, "error": "admin only" }));
            }
            let node = self.store.create_node("");
            self.store
                .audit(Some(&user.id), "node.create", &node.claim_code, "");
            return ConsoleResponse::json(201, json!({ "ok": true, "node": node }));
        }
        if method == "DELETE" && sub.starts_with("/nodes/") {
            if !user.is_admin {
                return ConsoleResponse::json(403, json!({ "ok": false, "error": "admin only" }));
            }
            let id = sub.trim_start_matches("/nodes/");
            self.store.revoke_node(id);
            self.store.audit(Some(&user.id), "node.revoke", id, "");
            // 记录留着（`revokedAt` 有值），面板上显示成「已移除」。
            // 被控端那边之后上报会拿到 403，日志里写「被主控端移除」——
            // 光是 404 的话，它分不清是自己码错了还是真被移掉了。
            return ConsoleResponse::json(200, json!({ "ok": true }));
        }

        // 把一条已移除的记录彻底删掉：DELETE /nodes/{id}/forget
        //
        // 「移除」默认只打时间戳（记录留着，看得出这里曾经有台机器）。这条是收拾残局用：
        // 确认那台再也不会回来了，才把它从列表里清掉。
        if method == "DELETE" && sub.starts_with("/nodes/") && sub.ends_with("/forget") {
            if !user.is_admin {
                return ConsoleResponse::json(403, json!({ "ok": false, "error": "admin only" }));
            }
            let id = sub
                .trim_start_matches("/nodes/")
                .trim_end_matches("/forget")
                .trim_end_matches('/');
            self.store.forget_node(id);
            self.store.audit(Some(&user.id), "node.forget", id, "");
            return ConsoleResponse::json(200, json!({ "ok": true }));
        }

        // 让某台被控端换准入模式：POST /nodes/{id}/mode?mode=open|restricted|auto
        //
        // `auto` 是把决定权交回它自己（清掉期望值），之后它本地设什么就是什么。
        // 这里只写主控端这边的期望值，**真正生效要等被控端下一次上报**（最长 5 分钟）——
        // 主控端从不主动连被控端，所以做不到即时。
        if method == "POST" && sub.starts_with("/nodes/") && sub.ends_with("/mode") {
            if !user.is_admin {
                return ConsoleResponse::json(403, json!({ "ok": false, "error": "admin only" }));
            }
            let id = sub
                .trim_start_matches("/nodes/")
                .trim_end_matches("/mode")
                .trim_end_matches('/');
            let mode = oidc::query_param(query, "mode").unwrap_or_default();
            let desired = match mode.as_str() {
                "open" => Some("open"),
                "restricted" => Some("restricted"),
                "auto" => None,
                _ => {
                    return ConsoleResponse::json(
                        400,
                        json!({ "ok": false, "error": "mode must be open, restricted or auto" }),
                    )
                }
            };
            match self.store.find_node_by_id(id) {
                None => {
                    return ConsoleResponse::json(404, json!({ "ok": false, "error": "not found" }))
                }
                // 已移除的机器设了也送不到（它上报会先被 403 挡掉），别假装成功。
                Some(node) if node.revoked_at.is_some() => {
                    return ConsoleResponse::json(
                        409,
                        json!({ "ok": false, "error": "这台已经被移除了，先重新生成认领码" }),
                    )
                }
                Some(_) => {}
            }
            if !self.store.set_desired_mode(id, desired) {
                return ConsoleResponse::json(404, json!({ "ok": false, "error": "not found" }));
            }
            self.store.audit(
                Some(&user.id),
                "node.mode",
                id,
                desired.unwrap_or("auto"),
            );
            return ConsoleResponse::json(200, json!({ "ok": true, "desiredMode": desired.unwrap_or("") }));
        }

        if method == "GET" && sub == "/licenses" {
            let licenses = self.store.list_licenses(200);
            return ConsoleResponse::json(200, json!({ "ok": true, "licenses": licenses }));
        }

        if method == "POST" && sub == "/licenses" {
            let license = self.store.create_license(Some(&user.id), "");
            self.store
                .audit(Some(&user.id), "license.create", &license.code, "");
            return ConsoleResponse::json(201, json!({ "ok": true, "license": license }));
        }

        // 改准入模式：POST /settings/mode?mode=open|restricted
        if method == "POST" && sub == "/settings/mode" {
            let mode = oidc::query_param(query, "mode").unwrap_or_default();
            return self.set_admission_mode(&user, &mode);
        }

        if method == "GET" && sub == "/settings" {
            return ConsoleResponse::json(
                200,
                json!({ "ok": true, "admissionMode": self.admission_mode() }),
            );
        }

        // 吊销 / 恢复：POST /licenses/{id}/status
        if method == "POST" && sub.starts_with("/licenses/") && sub.ends_with("/status") {
            let id = sub
                .trim_start_matches("/licenses/")
                .trim_end_matches("/status")
                .trim_end_matches('/');
            let Some(license) = self.store.find_license_by_id(id) else {
                return ConsoleResponse::json(404, json!({ "ok": false, "error": "not found" }));
            };
            let next = if license.status == "active" {
                "revoked"
            } else {
                "active"
            };
            self.store.set_license_status(id, next);
            self.store
                .audit(Some(&user.id), "license.status", &license.code, next);
            return ConsoleResponse::json(200, json!({ "ok": true, "status": next }));
        }

        // 设备列表：GET /licenses/{id}/devices
        if method == "GET" && sub.starts_with("/licenses/") && sub.ends_with("/devices") {
            let id = sub
                .trim_start_matches("/licenses/")
                .trim_end_matches("/devices")
                .trim_end_matches('/');
            let devices = self.store.list_devices(id);
            return ConsoleResponse::json(200, json!({ "ok": true, "devices": devices }));
        }

        // 解绑一台设备：DELETE /licenses/{id}/devices/{deviceId}
        if method == "DELETE" && sub.contains("/devices/") {
            let rest = sub.trim_start_matches("/licenses/");
            if let Some((id, device_id)) = rest.split_once("/devices/") {
                let removed = self.store.unbind_device(id, device_id);
                if removed {
                    self.store
                        .audit(Some(&user.id), "device.unbind", device_id, id);
                }
                return ConsoleResponse::json(200, json!({ "ok": true, "removed": removed }));
            }
        }

        ConsoleResponse::json(404, json!({ "ok": false, "error": "not found" }))
    }

    /// 校验一个码 + 一台设备还能不能用。宿主与手机启动时自检走这条。
    ///
    /// 与 Node 版 `handlers.verifyLicense` 逐条对应：码不存在 / 已吊销 / 设备没绑过
    /// 都回 `ok:false` 加一个能被程序识别的 `reason`，不抛错——调用方要按原因做分支。
    fn handle_verify(&self, body: &[u8]) -> ConsoleResponse {
        let request: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
        let code = request.get("code").and_then(|v| v.as_str()).unwrap_or_default();
        let device_id = request
            .get("deviceId")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();

        // **「不存在」和「已吊销」回同一个结果。**
        //
        // 分开回等于告诉对方「你这个码是真的，只是被吊销了」——那就成了一个免费的
        // 存在性查询服务，可以拿来筛出真实发放过的码。调用方（宿主）对这两种情况的
        // 处置也一样：都是「这个码不能用，找发码的人」。真正吊销的那条留在
        // 审计日志里，主控端面板上也看得到，不靠这里告诉外人。
        let Some(license) = self.store.find_license_by_code(&normalize_license_code(code)) else {
            return ConsoleResponse::json(200, json!({ "ok": false, "reason": "invalid" }));
        };
        if license.status != "active" {
            return ConsoleResponse::json(200, json!({ "ok": false, "reason": "invalid" }));
        }
        if !device_id.is_empty() {
            match self.store.find_device(&license.id, &device_id) {
                Some(device) if device.status == "active" => {
                    self.store.touch_device(&license.id, &device_id);
                }
                _ => {
                    return ConsoleResponse::json(
                        200,
                        json!({ "ok": false, "reason": "device_not_bound" }),
                    )
                }
            }
        }
        ConsoleResponse::json(
            200,
            json!({
                "ok": true,
                "licenseId": license.id,
                "deviceLimit": license.device_limit,
                "deviceCount": self.store.count_active_devices(&license.id),
            }),
        )
    }

    /// 把一个码绑到一台设备上。名额满了就拒绝——这就是「一个码一台设备」。
    fn handle_bind(&self, body: &[u8]) -> ConsoleResponse {
        let request: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
        let code = request.get("code").and_then(|v| v.as_str()).unwrap_or_default();
        let device_id = request
            .get("deviceId")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        let device_name = request
            .get("deviceName")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let platform = request
            .get("platform")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        if device_id.is_empty() {
            return ConsoleResponse::json(
                400,
                json!({ "ok": false, "error": "deviceId is required" }),
            );
        }
        // 同上：不存在与已吊销对外不区分。
        let Some(license) = self.store.find_license_by_code(&normalize_license_code(code)) else {
            return ConsoleResponse::json(404, json!({ "ok": false, "reason": "invalid" }));
        };
        if license.status != "active" {
            return ConsoleResponse::json(403, json!({ "ok": false, "reason": "invalid" }));
        }
        match self
            .store
            .bind_device(&license.id, &device_id, device_name, platform)
        {
            Ok(device) => ConsoleResponse::json(200, json!({ "ok": true, "device": device })),
            Err(_) => ConsoleResponse::json(
                409,
                json!({ "ok": false, "reason": "device_limit_reached" }),
            ),
        }
    }

    /// 被控端上报。认领码走请求头 `x-dsh-claim`，控制面 token 走 `authorization`。
    async fn handle_report(&self, headers: &[(String, String)], body: &[u8]) -> ConsoleResponse {
        let claim = headers
            .iter()
            .find(|(k, _)| k == "x-dsh-claim")
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        let token = headers
            .iter()
            .find(|(k, _)| k == "authorization")
            .map(|(_, v)| v.trim().trim_start_matches("Bearer ").trim().to_string())
            .unwrap_or_default();
        let report: crate::store::NodeReport = match serde_json::from_slice(body) {
            Ok(report) => report,
            Err(error) => {
                return ConsoleResponse::json(
                    400,
                    json!({ "ok": false, "error": format!("上报内容不是合法 JSON：{error}") }),
                )
            }
        };
        match node::apply_report(&self.store, &self.config, &claim, &token, &report) {
            // `admissionMode` 是我们希望被控端用的模式，被控端下一次上报时取走。
            // 没有就不带这个字段——被控端看到缺字段会保持自己本地的设置不动。
            Ok(desired) => {
                let mut payload = json!({ "ok": true });
                if let Some(mode) = desired {
                    payload["admissionMode"] = json!(mode);
                }
                ConsoleResponse::json(200, payload)
            }
            Err((status, message)) => {
                ConsoleResponse::json(status, json!({ "ok": false, "error": message }))
            }
        }
    }

    /// 这台被控端是不是「已被主控端接管准入模式」。
    ///
    /// 判据是「收到过一次有效的模式下发」——由 `apply_desired_mode` 落进设置。
    /// 主控端只在自己面板上设过期望值的机器才会走到这里；从没设过的机器一律不受影响。
    pub fn is_mode_controlled(&self) -> bool {
        node::is_slave(&self.config)
            && self
                .store
                .get_setting("master_manages_mode")
                .map(|v| v == "1")
                .unwrap_or(false)
    }

    pub fn admission_mode(&self) -> String {
        self.store
            .get_setting("admission_mode")
            .unwrap_or_else(|| "open".to_string())
    }

    /// 改准入模式。
    pub fn set_admission_mode(&self, actor: &crate::store::User, mode: &str) -> ConsoleResponse {
        if !actor.is_admin {
            return ConsoleResponse::json(403, json!({ "ok": false, "error": "admin only" }));
        }
        let normalized = match mode {
            "restricted" => "restricted",
            "open" => "open",
            _ => {
                return ConsoleResponse::json(
                    400,
                    json!({ "ok": false, "error": "mode must be open or restricted" }),
                )
            }
        };
        if self.is_mode_controlled() {
            // 别让人改了又被掰回去：那是「看起来能用」最差的一种状态。
            return ConsoleResponse::json(
                409,
                json!({
                    "ok": false,
                    "error": "准入模式由主控端管理，本地不能改",
                    "modeControlled": true,
                }),
            );
        }
        self.store.set_setting("admission_mode", normalized);
        self.store
            .audit(Some(&actor.id), "settings.admission_mode", normalized, "");
        ConsoleResponse::json(200, json!({ "ok": true, "admissionMode": normalized }))
    }

    /// 发起登录：写一次授权事务，然后 302 到登录系统。
    async fn login(&self, query: &str) -> ConsoleResponse {
        let pkce = oidc::create_pkce();
        let state = oidc::random_token(32);
        let nonce = oidc::random_token(16);
        let next = oidc::query_param(query, "next").unwrap_or_else(|| "/".to_string());
        self.store.save_login_state(&state, &nonce, &pkce.verifier, &next);
        match self
            .oidc
            .authorize_url(&state, &nonce, &pkce.challenge)
            .await
        {
            Ok(url) => ConsoleResponse::redirect_to(&url),
            Err(error) => ConsoleResponse::json(
                502,
                json!({ "ok": false, "error": format!("登录系统不可用：{error}") }),
            ),
        }
    }

    /// 登录回调：换 token → 取 userinfo → 落用户与会话 → 种 cookie → 跳回面板。
    async fn callback(&self, query: &str) -> ConsoleResponse {
        let Some(state) = oidc::query_param(query, "state") else {
            return ConsoleResponse::json(400, json!({ "ok": false, "error": "missing state" }));
        };
        let Some(code) = oidc::query_param(query, "code") else {
            return ConsoleResponse::json(400, json!({ "ok": false, "error": "missing code" }));
        };
        if let Some(error) = oidc::query_param(query, "error") {
            return ConsoleResponse::json(
                400,
                json!({ "ok": false, "error": format!("登录被拒绝：{error}") }),
            );
        }
        // 取事务，**先不删**：换 token 失败时（上游重发、登录系统抖动）这条还要留着给
        // 重试。只在成功落地会话之后才 `finish_login_state`。原来这里是查到即删，
        // 第一次回调 502 之后重试就永远报「无效」——线上真踩过。
        let Some((verifier, next_path)) = self.store.take_login_state(&state) else {
            return ConsoleResponse::json(
                400,
                json!({ "ok": false, "error": "登录状态无效或已过期" }),
            );
        };
        // ⚠️ 回调**绝不回 5xx**。
        //
        // 这条路径前面挂着一层 CDN（Tengine/ESA），它看到上游 5xx 会**自动重发**同一条
        // 请求。而 OAuth 的 code 只能用一次：第一次请求把 code 用掉了（无论成败），
        // 重发那一次必然换 token 失败。线上就是这样：用户点一次登录，浏览器收到的是
        // 第二次（重发）的失败结果，看着像「登录系统不认我们」。
        //
        // 所以这里一律回 200 + 一个错误对象，让 CDN 别重试；真正的失败原因照实带出去，
        // 前端自己判 `ok`。
        let access_token = match self.oidc.exchange_code(&code, &verifier).await {
            Ok(token) => token,
            Err(error) => return Self::callback_error(&error),
        };
        let claims = match self.oidc.userinfo(&access_token).await {
            Ok(claims) => claims,
            Err(error) => return Self::callback_error(&error),
        };

        let Some((identity, _source)) = claims.identity_key() else {
            return Self::callback_error("登录系统没有返回可用的身份标识");
        };
        let openid = if claims.openid.is_empty() { None } else { Some(claims.openid.as_str()) };
        let unionid = if claims.unionid.is_empty() { None } else { Some(claims.unionid.as_str()) };
        let user = self.store.upsert_user(&identity, &claims.name, &claims.picture, openid, unionid);
        // 白名单命中的直接提管理员。白名单比的是原始 sub（部署时填的就是它），
        // 所以这里用 `sub:` 前缀化的形式去对，写配置时按 `sub:<值>` 填。
        if self.config.admin_subs.iter().any(|s| s == &identity) && !user.is_admin {
            self.store.promote_admin(&user.id);
        }

        let token = oidc::random_token(32);
        let expires_at = crate::store::iso_after_seconds(self.config.session_ttl_seconds);
        self.store
            .create_session(&user.id, &oidc::sha256_hex(&token), &expires_at);

        // 到这里才算真的用完了：会话已落地，把这条事务删掉，迟到的重试会拿到 400。
        self.store.finish_login_state(&state);

        let cookie = format!(
            "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
            self.config.session_cookie, token, self.config.session_ttl_seconds
        );
        let target = if next_path.starts_with('/') { next_path } else { "/".to_string() };
        let mut response = ConsoleResponse::redirect_to(&format!(
            "{}{}{}",
            self.config.public_base_url, self.config.web_prefix, target
        ));
        response.set_cookie = Some(cookie);
        response
    }

    /// 回调失败：**回 200**，让 CDN 不重试（见 `callback` 里的长注释）。
    fn callback_error(message: &str) -> ConsoleResponse {
        ConsoleResponse::json(200, json!({ "ok": false, "error": message }))
    }

    fn logout(&self, headers: &[(String, String)]) -> ConsoleResponse {
        if let Some(token) = self.cookie_value(headers) {
            self.store.delete_session(&oidc::sha256_hex(&token));
        }
        let mut response = ConsoleResponse {
            status: 204,
            content_type: "text/plain; charset=utf-8",
            body: Vec::new(),
            set_cookie: Some(format!(
                "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
                self.config.session_cookie
            )),
            redirect: None,
        };
        response.body.clear();
        response
    }

    /// 准入校验：隧道接入前问一句「这台宿主能不能连」。
    ///
    /// 开放模式一律放行；限制模式要求带上有效授权码。**只看码本身**，
    /// 不碰配对码与设备凭证——那些是宿主管的。
    pub fn check_admission(&self, license_code: &str) -> Result<(), String> {
        if self.admission_mode() != "restricted" {
            return Ok(());
        }
        if license_code.trim().is_empty() {
            return Err("this relay requires a license code".into());
        }
        let code = normalize_license_code(license_code);
        match self.store.find_license_by_code(&code) {
            Some(license) if license.status == "active" => Ok(()),
            Some(_) => Err("license revoked".into()),
            None => Err("invalid license code".into()),
        }
    }
}

/// 控制台页面的静态文件应答。
///
/// 面板是构建好的单页应用，产物放在 `PLATFORM_WEB_ROOT`（默认 `<二进制旁边>/dist-console`）：
///   - `/platform/assets/*` 原样吐文件（js / css）；
///   - 其余路径一律回 `index.html`，路由交给前端。
///
/// 找不到产物时回一句人话，而不是 404——照着文档部署时最常见的就是漏了这一步。
pub fn serve_web(console: &Console, pathname: &str) -> ConsoleResponse {
    let root = if console.config.web_root.is_empty() {
        "dist-console".to_string()
    } else {
        console.config.web_root.clone()
    };
    let root = std::path::Path::new(&root);

    // 资源文件：只认 `/platform/assets/<文件名>`，且拒绝任何路径穿越。
    //
    // 注意 `/platform/` 本身**不算资源**：它去掉了结尾斜杠之后结尾仍是 `assets`
    // 这种前缀匹配，会落进这个分支然后拼出一个不存在的路径。这里要求名字非空且
    // 不含斜杠，`/platform/assets/` 这种空名也照常落到 index.html。
    // 先去掉结尾斜杠再判：`/platform/` 与 `/platform` 是同一条，不剥掉的话
    // `/platform/` 会以 `assets/` 结尾被误认成资源请求。
    let trimmed = pathname.trim_end_matches('/');
    let prefix = format!("{}/assets/", console.config.web_prefix);
    if let Some(name) = trimmed.strip_prefix(&prefix) {
        if !name.is_empty() && !name.contains('/') && !name.contains("..") {
            let file = root.join("assets").join(name);
            if let Ok(bytes) = std::fs::read(&file) {
                let content_type = if name.ends_with(".css") {
                    "text/css; charset=utf-8"
                } else if name.ends_with(".js") {
                    "application/javascript; charset=utf-8"
                } else {
                    "application/octet-stream"
                };
                return ConsoleResponse {
                    status: 200,
                    content_type,
                    body: bytes,
                    set_cookie: None,
                    redirect: None,
                };
            }
            // 资源确实不存在：404 而不是回 index.html——回页面会让浏览器拿 HTML
            // 当 js 解析，报一堆看不懂的语法错误。只有 `assets/` 下才这么处理。
            return ConsoleResponse::text(404, "找不到这个静态资源。\n");
        }
        // `assets/` 下面出现 `..` 或者再套一层目录：**一律 404**，不要落到
        // index.html。落到页面等于告诉调用方「这个路径存在」，而它明明不是资源。
        return ConsoleResponse::text(404, "找不到这个静态资源。\n");
    }

    match std::fs::read(root.join("index.html")) {
        Ok(bytes) => ConsoleResponse {
            status: 200,
            content_type: "text/html; charset=utf-8",
            body: bytes,
            set_cookie: None,
            redirect: None,
        },
        Err(_) => ConsoleResponse::text(
            503,
            "控制台前端还没部署：把构建产物放到 PLATFORM_WEB_ROOT 指向的目录（默认 ./dist-console）。\n",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn console() -> Arc<Console> {
        let mut config = ConsoleConfig::from_env();
        config.enabled = true;
        config.api_prefix = "/api/platform/v1".to_string();
        config.web_prefix = "/platform".to_string();
        config.db_path = ":memory:".to_string();
        let store = Store::in_memory().unwrap();
        Arc::new(Console {
            license_limiter: Limiter::new(config.license_rate_limit, Duration::from_secs(60)),
            report_limiter: Limiter::new(config.report_rate_limit, Duration::from_secs(60)),
            oidc: OidcClient::new(&config),
            config,
            store,
        })
    }

    fn admin(console: &Console) -> crate::store::User {
        console.store.upsert_user("sub-admin", "管理员", "", None, None)
    }

    fn cookie_for(console: &Console, user: &crate::store::User) -> Vec<(String, String)> {
        console
            .store
            .create_session(&user.id, &oidc::sha256_hex("token-1"), "2999-01-01T00:00:00.000Z");
        vec![("cookie".to_string(), format!("dsh_platform_session=token-1"))]
    }

    #[test]
    fn first_login_user_is_admin() {
        let console = console();
        let user = admin(&console);
        assert!(user.is_admin);
    }

    #[test]
    fn unauthenticated_calls_are_rejected() {
        let console = console();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let response = runtime.block_on(console.handle_api(
            "GET",
            "/api/platform/v1/overview",
            "",
            &[],
            &[],
            None,
        ));
        assert_eq!(response.status, 401);
    }

    #[test]
    fn admission_is_open_by_default() {
        let console = console();
        assert_eq!(console.admission_mode(), "open");
        // 开放模式下没码也放行——这是升级平滑的关键。
        assert!(console.check_admission("").is_ok());
    }

    #[test]
    fn restricted_mode_requires_a_valid_code() {
        let console = console();
        let user = admin(&console);
        let license = console.store.create_license(Some(&user.id), "");
        console
            .store
            .set_setting("admission_mode", "restricted");

        // 没码：拒绝
        assert!(console.check_admission("").is_err());
        // 错码：拒绝
        assert!(console.check_admission("DSH-AAAA-BBBB-CCCC-DDDD").is_err());
        // 正确码：放行，大小写与空白都要能吃
        let lower = license.code.to_lowercase();
        assert!(console.check_admission(&format!("  {lower}  ")).is_ok());

        // 吊销之后立刻失效
        console.store.set_license_status(&license.id, "revoked");
        assert!(console.check_admission(&license.code).is_err());
    }

    #[test]
    fn non_admin_cannot_issue_licenses() {
        let console = console();
        let _first = admin(&console);
        let second = console.store.upsert_user("sub-2", "普通用户", "", None, None);
        assert!(!second.is_admin);
        let headers = cookie_for(&console, &second);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let response = runtime.block_on(console.handle_api(
            "POST",
            "/api/platform/v1/licenses",
            "",
            &headers,
            &[],
            None,
        ));
        assert_eq!(response.status, 403);
    }

    #[test]
    fn admin_can_issue_and_list_licenses() {
        let console = console();
        let user = admin(&console);
        let headers = cookie_for(&console, &user);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let created = runtime.block_on(console.handle_api(
            "POST",
            "/api/platform/v1/licenses",
            "",
            &headers,
            &[],
            None,
        ));
        assert_eq!(created.status, 201);
        let body: Value = serde_json::from_slice(&created.body).unwrap();
        assert!(body["license"]["code"].as_str().unwrap().starts_with("DSH-"));

        let listed = runtime.block_on(console.handle_api(
            "GET",
            "/api/platform/v1/licenses",
            "",
            &headers,
            &[],
            None,
        ));
        assert_eq!(listed.status, 200);
        let body: Value = serde_json::from_slice(&listed.body).unwrap();
        assert_eq!(body["licenses"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn bind_enforces_one_device_per_code() {
        let console = console();
        let user = admin(&console);
        let license = console.store.create_license(Some(&user.id), "");
        let parse = |r: &ConsoleResponse| -> Value { serde_json::from_slice(&r.body).unwrap() };

        let first = console.handle_bind(
            format!(r#"{{"code":"{}","deviceId":"dev-a","deviceName":"手机"}}"#, license.code).as_bytes(),
        );
        assert_eq!(first.status, 200, "第一个设备应该绑得上");

        // 同一个设备再来：更新，不算第二个名额
        let again = console.handle_bind(
            format!(r#"{{"code":"{}","deviceId":"dev-a"}}"#, license.code).as_bytes(),
        );
        assert_eq!(again.status, 200);

        // 换一台设备：名额已满
        let second = console.handle_bind(
            format!(r#"{{"code":"{}","deviceId":"dev-b"}}"#, license.code).as_bytes(),
        );
        assert_eq!(second.status, 409, "一个码一台设备，第二台必须被拒");
        assert_eq!(parse(&second)["reason"], "device_limit_reached");

        // 解绑之后能改绑
        console.store.unbind_device(&license.id, "dev-a");
        let rebound = console.handle_bind(
            format!(r#"{{"code":"{}","deviceId":"dev-b"}}"#, license.code).as_bytes(),
        );
        assert_eq!(rebound.status, 200, "解绑后同一个码应该能绑到新设备");
    }

    #[test]
    fn verify_reports_why_a_code_is_unusable() {
        let console = console();
        let user = admin(&console);
        let license = console.store.create_license(Some(&user.id), "");
        let parse = |r: &ConsoleResponse| -> Value { serde_json::from_slice(&r.body).unwrap() };

        // 码不存在
        let missing = console.handle_verify(br#"{"code":"DSH-NOPE-NOPE-NOPE-NOPE"}"#);
        assert_eq!(parse(&missing)["reason"], "invalid");

        // 码存在、设备没绑过
        let unbound = console.handle_verify(
            format!(r#"{{"code":"{}","deviceId":"dev-a"}}"#, license.code).as_bytes(),
        );
        assert_eq!(parse(&unbound)["reason"], "device_not_bound");

        // 绑上之后通过
        console
            .store
            .bind_device(&license.id, "dev-a", "手机", "ios")
            .unwrap();
        let ok = console.handle_verify(
            format!(r#"{{"code":"{}","deviceId":"dev-a"}}"#, license.code).as_bytes(),
        );
        assert_eq!(parse(&ok)["ok"], true);

        // 吊销之后立刻失效
        console.store.set_license_status(&license.id, "revoked");
        let revoked = console.handle_verify(
            format!(r#"{{"code":"{}","deviceId":"dev-a"}}"#, license.code).as_bytes(),
        );
        // **吊销与不存在对外是同一个回答**，否则等于告诉对方「你这个码是真的」，
        // 成了一个免费的存在性查询。调用方对这两种情况的处置也一样。
        assert_eq!(parse(&revoked)["reason"], "invalid");
        assert_eq!(
            parse(&revoked)["reason"], parse(&missing)["reason"],
            "吊销和找不到必须长得一模一样"
        );
    }

    /// 激活码校验不限次数的话，等于给了一个免费的查询服务。
    #[test]
    fn verify_is_rate_limited_per_client() {
        let mut config = ConsoleConfig::from_env();
        config.enabled = true;
        config.api_prefix = "/api/platform/v1".into();
        config.db_path = ":memory:".into();
        config.license_rate_limit = 3;
        let console = Arc::new(Console {
            license_limiter: Limiter::new(3, Duration::from_secs(60)),
            report_limiter: Limiter::new(60, Duration::from_secs(60)),
            oidc: OidcClient::new(&config),
            config,
            store: Store::in_memory().unwrap(),
        });
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let headers = vec![("x-real-ip".to_string(), "1.2.3.4".to_string())];
        let call = || {
            runtime.block_on(console.handle_api(
                "POST",
                "/api/platform/v1/licenses/verify",
                "",
                &headers,
                br#"{"code":"DSH-NOPE-NOPE-NOPE-NOPE"}"#,
                None,
            ))
        };
        for i in 0..3 {
            assert_eq!(call().status, 200, "第 {} 次应该放过", i + 1);
        }
        assert_eq!(call().status, 429, "超过额度必须挡");

        // 换一个来源不受影响。
        let other = vec![("x-real-ip".to_string(), "5.6.7.8".to_string())];
        let ok = runtime.block_on(console.handle_api(
            "POST",
            "/api/platform/v1/licenses/verify",
            "",
            &other,
            br#"{"code":"DSH-NOPE-NOPE-NOPE-NOPE"}"#,
            None,
        ));
        assert_eq!(ok.status, 200, "别的来源不该被连坐");
    }

    #[test]
    fn admission_mode_toggles() {
        let console = console();
        let user = admin(&console);
        let response = console.set_admission_mode(&user, "restricted");
        assert_eq!(response.status, 200);
        assert_eq!(console.admission_mode(), "restricted");
        let bad = console.set_admission_mode(&user, "nonsense");
        assert_eq!(bad.status, 400);
    }

    /// `assets/` 下面带 `..` 或者再套目录：404，不许回退成 index.html。
    ///
    /// 回页面等于对一个不存在的资源答「200 + HTML」，前端拿它当 js 解析会报一堆
    /// 看不懂的语法错；调用方也会以为这个路径真的存在。
    #[test]
    fn asset_paths_with_dotdot_are_404_not_the_page() {
        let console = console();
        for path in [
            "/platform/assets/../../etc/passwd",
            "/platform/assets/sub/app.js",
        ] {
            let response = serve_web(&console, path);
            assert_eq!(response.status, 404, "{path} 应当 404");
            assert!(
                !response.body.starts_with(b"<!doctype"),
                "{path} 不该回页面"
            );
        }
    }
}

#[cfg(test)]
mod admission_flow {
    use super::*;
    use crate::store::Store;

    /// 直接验证准入判定链：限制模式下，库里写的是 restricted 时，无码必须被拒。
    #[test]
    fn restricted_setting_is_read_back() {
        let mut config = ConsoleConfig::from_env();
        config.enabled = true;
        config.db_path = ":memory:".into();
        let console = Console {
            license_limiter: Limiter::new(config.license_rate_limit, Duration::from_secs(60)),
            report_limiter: Limiter::new(config.report_rate_limit, Duration::from_secs(60)),
            oidc: OidcClient::new(&config),
            config,
            store: Store::in_memory().unwrap(),
        };
        console.store.set_setting("admission_mode", "restricted");
        assert_eq!(console.admission_mode(), "restricted", "写入后必须读得回 restricted");
        assert!(console.check_admission("").is_err(), "限制模式下空码必须被拒");
    }
}
