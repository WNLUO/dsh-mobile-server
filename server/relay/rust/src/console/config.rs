//! 控制台的配置：从环境变量读，前缀 `PLATFORM_`。
//!
//! 与 Node 运营版（`server/dsh-mobile-hub/lib/platform/config.js`）的变量名保持一致，
//! 这样线上那份 `/etc/dsh-platform.env` 可以原样继续用，不用重新配一遍。
//!
//! 全部可选：一个都不设时控制台整体关闭，中转退化成纯转发——这是刻意的默认，
//! 老用户升级上来不会突然多出一个登录界面。

use std::env;

/// 控制台配置。缺省即关闭。
#[derive(Debug, Clone)]
pub struct ConsoleConfig {
    /// 控制台总开关。`PLATFORM_ENABLED=1` 才开。
    pub enabled: bool,
    /// 对外可访问的基址，用来拼 redirect_uri 与面板链接。
    pub public_base_url: String,
    /// 面板的挂载前缀，前端静态资源在这里。
    pub web_prefix: String,
    /// 控制台 API 的挂载前缀。
    pub api_prefix: String,
    /// SQLite 文件路径。
    pub db_path: String,
    /// 面板静态产物目录；缺省时只提供 API，不吐前端。
    pub web_root: String,

    pub session_secret: String,
    pub session_cookie: String,
    pub session_ttl_seconds: i64,

    pub oidc_issuer: String,
    pub oidc_client_id: String,
    pub oidc_client_secret: String,
    pub oidc_redirect_uri: String,
    pub oidc_scope: String,
    pub oidc_state_ttl_seconds: i64,
    pub oidc_timeout_ms: u64,

    /// 逗号分隔的 OIDC sub 白名单：命中即管理员。
    pub admin_subs: Vec<String>,
    /// 库里一个管理员都没有时，第一个登录的人自动成为管理员。
    pub bootstrap_first_admin: bool,

    // ── 主控端 / 被控端 ───────────────────────────────────────────
    /// 主控端地址。**非空就说明这台是被控端**：它会定期向这里上报状态。
    pub master_url: String,
    /// 被控端向主控端报到用的认领码。
    pub claim_code: String,
    /// 被控端上报时可选带上的 token（主控端要求时用）。
    pub master_token: Option<String>,
    /// 本机在被控端列表里显示的名字。空则用主机名。
    pub node_name: String,
    /// 这台主控端收不收被控端上报。默认收。
    pub accepts_reports: bool,
    /// 被控端多久报一次（秒）。也是主控端下发模式的生效上限。
    pub report_interval_seconds: u64,

    // ── 限流 ─────────────────────────────────────────────────────
    /// 限流窗口（秒）。下面两个额度都按这个窗口算。
    pub rate_limit_window_seconds: u64,
    /// 一个窗口里，同一个来源最多可以调几次激活码校验/绑定。
    pub license_rate_limit: u32,
    /// 一个窗口里，同一个来源最多可以上报几次。正常被控端远达不到。
    pub report_rate_limit: u32,

    // ── 插件 OTA 临时通道 ─────────────────────────────────────────
    /// 包文件落盘目录。
    pub ota_root: String,
    /// 发布用的控制面 token。空则发布接口关闭（下载不受影响）。
    pub ota_control_token: String,
}

fn str_env(name: &str, fallback: &str) -> String {
    match env::var(name) {
        Ok(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => fallback.to_string(),
    }
}

fn int_env(name: &str, fallback: i64) -> i64 {
    match env::var(name) {
        Ok(value) => value.trim().parse::<i64>().unwrap_or(fallback),
        Err(_) => fallback,
    }
}

fn bool_env(name: &str, fallback: bool) -> bool {
    match env::var(name) {
        Ok(value) => {
            let lower = value.trim().to_ascii_lowercase();
            lower == "1" || lower == "true" || lower == "yes"
        }
        Err(_) => fallback,
    }
}

impl ConsoleConfig {
    pub fn from_env() -> Self {
        let public_base_url = str_env("PLATFORM_PUBLIC_BASE_URL", "http://127.0.0.1:8700");
        let public_base_url = public_base_url.trim_end_matches('/').to_string();
        let oidc_issuer = str_env("PLATFORM_OIDC_ISSUER", "");
        let oidc_issuer = oidc_issuer.trim_end_matches('/').to_string();
        let redirect_default = format!("{public_base_url}/api/platform/v1/auth/callback");
        Self {
            enabled: bool_env("PLATFORM_ENABLED", false),
            oidc_redirect_uri: str_env("PLATFORM_OIDC_REDIRECT_URI", &redirect_default),
            public_base_url,
            web_prefix: str_env("PLATFORM_WEB_PREFIX", "/platform"),
            api_prefix: "/api/platform/v1".to_string(),
            db_path: str_env("PLATFORM_DB_PATH", "data/console.db"),
            web_root: str_env("PLATFORM_WEB_ROOT", ""),
            session_secret: str_env("PLATFORM_SESSION_SECRET", ""),
            session_cookie: str_env("PLATFORM_SESSION_COOKIE", "dsh_platform_session"),
            session_ttl_seconds: int_env("PLATFORM_SESSION_TTL_SECONDS", 30 * 24 * 3600),
            oidc_issuer,
            oidc_client_id: str_env("PLATFORM_OIDC_CLIENT_ID", "dsh-hub-platform"),
            oidc_client_secret: str_env("PLATFORM_OIDC_CLIENT_SECRET", ""),
            oidc_scope: str_env("PLATFORM_OIDC_SCOPE", "openid profile wechat_identity"),
            oidc_state_ttl_seconds: int_env("PLATFORM_OIDC_STATE_TTL_SECONDS", 600),
            oidc_timeout_ms: int_env("PLATFORM_OIDC_TIMEOUT_MS", 10_000) as u64,
            admin_subs: str_env("PLATFORM_ADMIN_SUBS", "")
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            bootstrap_first_admin: bool_env("PLATFORM_BOOTSTRAP_FIRST_ADMIN", true),
            master_url: str_env("PLATFORM_MASTER_URL", "")
                .trim_end_matches('/')
                .to_string(),
            claim_code: str_env("PLATFORM_CLAIM_CODE", ""),
            master_token: {
                let token = str_env("PLATFORM_MASTER_TOKEN", "");
                if token.is_empty() {
                    None
                } else {
                    Some(token)
                }
            },
            node_name: {
                let name = str_env("PLATFORM_NODE_NAME", "");
                if name.is_empty() {
                    hostname()
                } else {
                    name
                }
            },
            accepts_reports: bool_env("PLATFORM_ACCEPTS_REPORTS", true),
            // 下限兜住：填个 0 或 1 秒等于把主控端当心跳服务器打，那是配置事故不是用法。
            // 上限也兜一下，免得算出个负值/离谱值把 tokio 的定时器搞乱。
            report_interval_seconds: int_env("PLATFORM_REPORT_INTERVAL_SECONDS", 300)
                .clamp(30, 86_400) as u64,
            // 默认一分钟 30 次：手抄一个码、填错两三次再改对，正常用远远够；
            // 拿去当查询服务刷，一分钟就只剩 30 次了。
            rate_limit_window_seconds: int_env("PLATFORM_RATE_LIMIT_WINDOW_SECONDS", 60)
                .clamp(1, 3600) as u64,
            license_rate_limit: int_env("PLATFORM_LICENSE_RATE_LIMIT", 30).clamp(1, 100_000)
                as u32,
            // 正常被控端每 5 分钟一条，给到 60 是因为配了短周期（比如 30 秒）时
            // 也不该被误伤。
            report_rate_limit: int_env("PLATFORM_REPORT_RATE_LIMIT", 60).clamp(1, 100_000)
                as u32,
            ota_root: str_env("PLATFORM_OTA_ROOT", "data/plugin-ota"),
            ota_control_token: str_env("PLATFORM_OTA_CONTROL_TOKEN", ""),
        }
    }

    /// 生产环境该补的配置。返回问题列表而不是直接崩：少了登录配置时中转照样该转发，
    /// 只是控制台不可用。
    pub fn problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        if !self.enabled {
            return problems;
        }
        if self.session_secret.len() < 16 {
            problems.push("PLATFORM_SESSION_SECRET 未设置或过短（需 >= 16 字符）".to_string());
        }
        if self.oidc_client_secret.is_empty() {
            problems.push("PLATFORM_OIDC_CLIENT_SECRET 未设置".to_string());
        }
        problems
    }
}

/// 主机名。被控端默认拿它当显示名，省得搭建者再填一次。
fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .or_else(|_| std::fs::read_to_string("/etc/hostname"))
        .map(|name| name.trim().to_string())
        .unwrap_or_else(|_| "unnamed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_off() {
        // 不设 PLATFORM_ENABLED 时控制台关闭，中转保持纯转发。
        let config = ConsoleConfig::from_env();
        assert!(!config.enabled || env::var("PLATFORM_ENABLED").is_ok());
        assert_eq!(config.api_prefix, "/api/platform/v1");
        assert_eq!(config.session_cookie, "dsh_platform_session");
    }

    #[test]
    fn session_ttl_defaults_to_thirty_days() {
        let config = ConsoleConfig::from_env();
        assert!(config.session_ttl_seconds >= 60);
    }
}
