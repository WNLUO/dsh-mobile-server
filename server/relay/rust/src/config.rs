//! 环境变量配置（限额的唯一真源）。
//!
//! 对齐 Node 版 `lib/config.js`：所有可调项都走「越界直接报错、不 clamp」。一个手滑的
//! 0 或负值若被静默接受，表现是限额「关掉」而不是「设错」（例如 MAX_PENDING=0 会让全部
//! 手机请求 429），启动即失败才留得下现场。

use std::env;

/// 默认更新源：自己域名下的一组静态文件（`latest.json` + 二进制）。
/// **默认空 = 没有更新源**，和 `SELF_UPDATE` 默认关是同一件事的两半。
///
/// 早先这里写死过一个具体域名，对一个「用户自己部署」的项目是错的：
/// 谁把 `SELF_UPDATE` 打开又没改更新源，他那台中转就会去**别人的机器**拉一个二进制、
/// 校验通过、然后替换掉自己。那不是更新，是让人家替我们托管了一个可以随时替换其程序
/// 的入口。所以更新源必须由部署方显式指定，指向哪台就是哪台。
///
/// 为什么不用 GitHub Release：`github.com` 在国内服务器上连不通，Release 资产下不下来；
/// 详见 `selfupdate` 模块头部。

/// 一次能收多少、等多久。全部是可调项，含义与 Node 版一一对应。
#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,

    pub max_frame_bytes: usize,
    pub max_body_bytes: usize,
    pub max_pending: usize,
    pub max_sse_connections: usize,
    pub max_ws_connections: usize,
    pub max_ws_message_bytes: usize,
    pub max_ws_queue_bytes: usize,

    pub ws_heartbeat_ms: u64,
    pub ws_pong_timeout_ms: u64,
    pub tunnel_heartbeat_ms: u64,
    pub tunnel_pong_timeout_ms: u64,

    pub upstream_header_timeout_ms: u64,
    pub debug_sse: bool,

    // ── 自动更新 ─────────────────────────────────────────────────
    /// **默认关**。开了之后这台中转会自己从发布仓库升到新版本。
    pub self_update: bool,
    /// 查新版本的间隔（秒）。
    pub self_update_interval_seconds: u64,
    /// 更新源基址，下面要能取到 `latest.json`。
    pub self_update_source: String,
}

/// 读一个正整数环境变量；越界或非整数直接报错。
fn positive_int(name: &str, fallback: usize, max: usize) -> Result<usize, String> {
    match env::var(name) {
        Err(_) => Ok(fallback),
        Ok(raw) if raw.is_empty() => Ok(fallback),
        Ok(raw) => {
            let value: i64 = raw
                .trim()
                .parse()
                .map_err(|_| format!("{name} must be an integer between 1 and {max}"))?;
            if value < 1 || (value as u64) > max as u64 {
                return Err(format!("{name} must be an integer between 1 and {max}"));
            }
            Ok(value as usize)
        }
    }
}

impl Config {
    /// 从环境变量读配置。任何一项越界都返回 Err，由 main 直接退出。
    pub fn from_env() -> Result<Self, String> {
        Ok(Config {
            host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            port: env::var("PORT")
                .ok()
                .and_then(|p| p.trim().parse::<u16>().ok())
                .unwrap_or(8700),

            max_frame_bytes: positive_int("MAX_FRAME_BYTES", 8 * 1024 * 1024, 64 * 1024 * 1024)?,
            max_body_bytes: positive_int("MAX_BODY_BYTES", 50 * 1024 * 1024, 256 * 1024 * 1024)?,
            max_pending: positive_int("MAX_PENDING", 256, 100_000)?,
            max_sse_connections: positive_int("MAX_SSE_CONNECTIONS", 16, 10_000)?,
            max_ws_connections: positive_int("MAX_WS_CONNECTIONS", 256, 10_000)?,
            max_ws_message_bytes: positive_int("MAX_WS_MESSAGE_BYTES", 8 * 1024 * 1024, 64 * 1024 * 1024)?,
            max_ws_queue_bytes: positive_int("MAX_WS_QUEUE_BYTES", 16 * 1024 * 1024, 128 * 1024 * 1024)?,

            ws_heartbeat_ms: positive_int("WS_HEARTBEAT_MS", 15_000, 600_000)? as u64,
            ws_pong_timeout_ms: positive_int("WS_PONG_TIMEOUT_MS", 60_000, 600_000)? as u64,
            tunnel_heartbeat_ms: positive_int("TUNNEL_HEARTBEAT_MS", 15_000, 600_000)? as u64,
            // 两侧超时**刻意不对称**（中转 60s < 宿主 90s）：反了会在网络抖动时互相
            // terminate 并反复重连。
            tunnel_pong_timeout_ms: positive_int("TUNNEL_PONG_TIMEOUT_MS", 60_000, 600_000)? as u64,

            upstream_header_timeout_ms: positive_int("UPSTREAM_HEADER_TIMEOUT_MS", 30_000, 600_000)? as u64,
            debug_sse: matches!(
                env::var("DEBUG_SSE").unwrap_or_default().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            ),
            self_update: matches!(
                env::var("SELF_UPDATE").unwrap_or_default().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            ),
            // 下限一天：GitHub 的匿名接口是每 IP 每小时 60 次，几台中转共用出口时
            // 设小了会一起撞额度。
            self_update_interval_seconds: positive_int(
                "SELF_UPDATE_INTERVAL_SECONDS",
                86_400,
                7 * 86_400,
            )?
            .max(86_400) as u64,
            self_update_source: {
                let value = env::var("SELF_UPDATE_SOURCE").unwrap_or_default();
                value.trim().trim_end_matches('/').to_string()
            },
        })
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: "0.0.0.0".to_string(),
            port: 8700,
            max_frame_bytes: 8 * 1024 * 1024,
            max_body_bytes: 50 * 1024 * 1024,
            max_pending: 256,
            max_sse_connections: 16,
            max_ws_connections: 256,
            max_ws_message_bytes: 8 * 1024 * 1024,
            max_ws_queue_bytes: 16 * 1024 * 1024,
            ws_heartbeat_ms: 15_000,
            ws_pong_timeout_ms: 60_000,
            tunnel_heartbeat_ms: 15_000,
            tunnel_pong_timeout_ms: 60_000,
            upstream_header_timeout_ms: 30_000,
            debug_sse: false,
            self_update: false,
            self_update_interval_seconds: 86_400,
            self_update_source: String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 更新源默认必须是空的。
    ///
    /// 写死成我们自己的运营机，就等于让「打开自动更新但没改更新源」的用户来**别人的域名**
    /// 取二进制并替换自己的程序。这一条钉住默认值本身，不再靠人记得改。
    #[test]
    fn update_source_defaults_to_empty() {
        let config = Config::default();
        assert_eq!(
            config.self_update_source, "",
            "更新源默认必须为空，不能指向任何真实域名"
        );
    }

    #[test]
    fn defaults_match_node_values() {
        let config = Config::from_env().expect("默认配置应该能读出来");
        assert_eq!(config.port, 8700);
        assert_eq!(config.max_frame_bytes, 8 * 1024 * 1024);
        assert_eq!(config.max_pending, 256);
        assert_eq!(config.max_sse_connections, 16);
        assert_eq!(config.tunnel_heartbeat_ms, 15_000);
        assert_eq!(config.tunnel_pong_timeout_ms, 60_000);
    }
}
