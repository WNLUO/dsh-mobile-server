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
    /// 同一台设备最多同时占几条 SSE。
    ///
    /// 它和 `max_sse_connections` 是两道不同的闸：那个管「一台宿主电脑总共开多少条」，
    /// 这个管「其中一台手机能占几条」。只有总量那道闸时，一台陷在重连风暴里的设备会把
    /// 所有人的名额吃光，其余手机一起 429。超了不是拒绝，而是把它自己最早那条顶掉。
    pub max_sse_per_device: usize,
    pub max_ws_connections: usize,
    pub max_ws_message_bytes: usize,
    pub max_ws_queue_bytes: usize,

    pub ws_heartbeat_ms: u64,
    pub ws_pong_timeout_ms: u64,
    pub tunnel_heartbeat_ms: u64,
    pub tunnel_pong_timeout_ms: u64,

    pub upstream_header_timeout_ms: u64,
    pub debug_sse: bool,

    /// 宿主离线时用最后一份镜像兜底（`MIRROR_CACHE`，**默认开**）。
    ///
    /// 开着的时候这台中转会**存着**宿主推上来的会话清单与工作区，并在宿主那条隧道不在
    /// 时回给手机（标成 stale）。纯转发那句承诺只对 `MIRROR_CACHE=0` 的部署成立：包了
    /// 公共域名、又不想让中转进程持有会话内容的，关掉它即可，转发本身一个字都不变。
    pub mirror_cache: bool,
    /// 宿主这么久还没回头就先给缓存（毫秒；**0 = 关**，退回「只有隧道不在才兜底」）。
    ///
    /// 弱网下最难受的不是「没有数据」，是「一直在转圈」：宿主还活着、请求也真的发过去了，
    /// 只是两段链路叠起来要好几秒。到点先把中转手上那份给手机（标 stale），再取消上游；
    /// 手机下次轮询照常再问一次。
    pub mirror_fallback_ms: u64,

    // ── 自动更新 ─────────────────────────────────────────────────
    /// **默认关**。开了之后这台中转会自己从发布仓库升到新版本。
    pub self_update: bool,
    /// 查新版本的间隔（秒）。
    pub self_update_interval_seconds: u64,
    /// 更新源基址，按顺序试；每个下面要能取到 `latest.json`。
    ///
    /// `SELF_UPDATE_SOURCE` 支持逗号分隔的多条。它解决的是一个单点问题：一台机器的
    /// 更新源写死成一个域名，那个域名倒了（或被墙了）这台机器就再也收不到更新，
    /// 而它自己不会报错——只是日志里每天一条失败。国内与海外各放一个地址、按本机
    /// 位置调整顺序，是这套东西唯一需要人做的判断。
    pub self_update_sources: Vec<String>,
}

/// 读一个可以为 0 的整数环境变量；越界或非整数直接报错。
///
/// 与 `positive_int` 的区别只有一处：0 是合法值（在这个项目里一律表示「关掉」），
/// 而不是「设错了」。
fn non_negative_int(name: &str, fallback: usize, max: usize) -> Result<usize, String> {
    match env::var(name) {
        Err(_) => Ok(fallback),
        Ok(raw) if raw.is_empty() => Ok(fallback),
        Ok(raw) => {
            let value: i64 = raw
                .trim()
                .parse()
                .map_err(|_| format!("{name} must be an integer between 0 and {max}"))?;
            if value < 0 || (value as u64) > max as u64 {
                return Err(format!("{name} must be an integer between 0 and {max}"));
            }
            Ok(value as usize)
        }
    }
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
            // 总闸要比各路由自己的上限宽一截。信封让同样的内容上线时大 4/3，宿主那边
            // 每条路由的上限都跟着放大了；总闸停在 50MB，最大的那条上传会先撞中转，
            // 宿主放大过的上限就白设了。67 ≈ 50 × 4/3。
            max_body_bytes: positive_int("MAX_BODY_BYTES", 67 * 1024 * 1024, 256 * 1024 * 1024)?,
            max_pending: positive_int("MAX_PENDING", 256, 100_000)?,
            // 64：一台手机正常只开两条（会话流 + 设备级流），这个数是给「一台电脑上多台
            // 设备同时在线」和重连抖动留的余量。它按**隧道**（也就是一台宿主电脑）计，不是
            // 全站共享，所以调大不会让一台机器的风暴波及别人；真正的失控闸在宿主那侧。
            max_sse_connections: positive_int("MAX_SSE_CONNECTIONS", 64, 10_000)?,
            // 3：一台手机正常只开两条（会话流 + 设备级流），第三条是切会话时新旧交替的
            // 余量。给到 3 以上只会让陷在重连里的设备多占一会儿名额。
            max_sse_per_device: positive_int("MAX_SSE_PER_DEVICE", 3, 64)?,
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
            // 缺省开：不设这个变量就是「宿主离线时手机还能看见列表」。显式写 0/false/no
            // 才是纯转发——两种口径都要能被部署方一眼选中，所以不设中间态。
            mirror_cache: !matches!(
                env::var("MIRROR_CACHE").unwrap_or_default().to_ascii_lowercase().as_str(),
                "0" | "false" | "no"
            ),
            // 0 是合法的「关」：谁只想留「隧道不在时兜底」这一半，就把它设成 0。
            mirror_fallback_ms: non_negative_int("MIRROR_FALLBACK_MS", 2_500, 60_000)? as u64,
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
            // 逗号分隔，逐条去空白、去尾部斜杠、丢掉空项。顺序就是尝试顺序。
            self_update_sources: env::var("SELF_UPDATE_SOURCE")
                .unwrap_or_default()
                .split(',')
                .map(|part| part.trim().trim_end_matches('/').to_string())
                .filter(|part| !part.is_empty())
                .collect(),
        })
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: "0.0.0.0".to_string(),
            port: 8700,
            max_frame_bytes: 8 * 1024 * 1024,
            max_body_bytes: 67 * 1024 * 1024,
            max_pending: 256,
            max_sse_connections: 16,
            max_sse_per_device: 3,
            max_ws_connections: 256,
            max_ws_message_bytes: 8 * 1024 * 1024,
            max_ws_queue_bytes: 16 * 1024 * 1024,
            ws_heartbeat_ms: 15_000,
            ws_pong_timeout_ms: 60_000,
            tunnel_heartbeat_ms: 15_000,
            tunnel_pong_timeout_ms: 60_000,
            upstream_header_timeout_ms: 30_000,
            debug_sse: false,
            mirror_cache: true,
            mirror_fallback_ms: 2_500,
            self_update: false,
            self_update_interval_seconds: 86_400,
            self_update_sources: Vec::new(),
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
        assert!(
            config.self_update_sources.is_empty(),
            "更新源默认必须为空，不能指向任何真实域名"
        );
    }

    /// 多个更新源：逗号分隔、按顺序、去空白与尾斜杠、丢空项。
    #[test]
    fn parses_multiple_update_sources_in_order() {
        std::env::set_var(
            "SELF_UPDATE_SOURCE",
            " https://cn.example/relay-updates/ , ,https://us.example/relay-updates ",
        );
        let config = Config::from_env().expect("两条合法地址应该能读出来");
        std::env::remove_var("SELF_UPDATE_SOURCE");
        assert_eq!(
            config.self_update_sources,
            vec![
                "https://cn.example/relay-updates".to_string(),
                "https://us.example/relay-updates".to_string()
            ],
            "顺序必须保留：先国内后海外是部署方的决定"
        );
    }

    #[test]
    fn defaults_match_node_values() {
        let config = Config::from_env().expect("默认配置应该能读出来");
        assert_eq!(config.port, 8700);
        assert_eq!(config.max_frame_bytes, 8 * 1024 * 1024);
        // 按明文上限的 4/3 放大：信封让线上字节变多，总闸不跟着抬，宿主的每路由上限
        // 就会被中转先撞掉。
        assert_eq!(config.max_body_bytes, 67 * 1024 * 1024);
        assert_eq!(config.max_pending, 256);
        // 64 与宿主那条直连闸（`lan-proxy` 的 MAX_UPSTREAM_SSE_CONNECTIONS）同一个数：
        // 两条路通向同一台宿主、同一种资源。16 的时候一台手机的几条被丢弃的连接就能把
        // 走中转的所有设备挡在 429 外面（真机现场见 README 的运维那节）。
        assert_eq!(config.max_sse_connections, 64);
        assert_eq!(config.max_sse_per_device, 3);
        assert_eq!(config.tunnel_heartbeat_ms, 15_000);
        assert_eq!(config.tunnel_pong_timeout_ms, 60_000);
        assert!(config.mirror_cache, "离线镜像兜底默认开");
        assert_eq!(config.mirror_fallback_ms, 2_500, "弱网兜底默认 2.5 秒");
    }
}
