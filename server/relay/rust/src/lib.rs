//! DSH 自建版中转（Rust）。
//!
//! 宿主主动建立一条出站 WSS 隧道；手机上来的 HTTP / SSE / WebSocket 原样送进那条
//! 隧道，宿主的响应原样送回手机。所以本进程无需入站可达用户电脑的网络。
//!
//! 两条原本就有的边界照旧：
//!   - **一条隧道**。同一时刻只服务一条宿主连接，新连接直接取代旧的（见 `tunnel`）。
//!   - **不解释业务**。转发路径不认路径语义、不改请求与响应。
//!
//! 唯一的例外是 `mirror`：宿主推上来的那份会话清单会被记在进程里，**只在它那条隧道
//! 不在时**回给手机（标成 stale，只对默认视图、只对配对过的设备凭据）。它是离线兜底，
//! 不是缓存层——隧道活着的时候一个字节都不从它出。`MIRROR_CACHE=0` 可以退回纯转发。
//!
//! 另外还挂着**中转控制台**（见 `console`）：面板、微信登录、激活码与准入。
//! 它是可选的——`PLATFORM_ENABLED` 没设时整套不生效，中转就是纯转发。
//! 控制台与转发只有一处交界：隧道接入前的准入校验，转发路径本身不碰数据库。
//!
//! 自己认领的路径：`/healthz`、`/api/mobile/v1/health`（地址体检）、`/status`，
//! 以及控制台打开时的 `/api/platform/v1/**` 与 `/platform/**`；其余全部转发。
//!
//! 隧道帧格式见 `../../relay-core/PROTOCOL.md`；编解码与类型表在
//! `../../relay-core/rust`，与 JS 实现由逐字节对撞测试钉住。

pub mod apns;
pub mod config;
pub mod console;
pub mod headers;
pub mod http;
pub mod mirror;
pub mod proxy;
pub mod selfupdate;
pub mod store;
pub mod tunnel;
pub mod ws;

use std::sync::{Arc, OnceLock};

pub use config::Config;
pub use console::Console;
pub use http::serve_connection;
pub use tunnel::{Tunnel, TunnelSlot};

/// 进程级配置。启动时填一次，之后只读。
static CONFIG: OnceLock<Arc<Config>> = OnceLock::new();

/// 控制台实例。关闭时为空。
static CONSOLE: OnceLock<Arc<Console>> = OnceLock::new();

/// 隧道槽位。HTTP 入口要靠它回答 `/status` 与控制台的在线状态。
static SLOT: OnceLock<Arc<TunnelSlot>> = OnceLock::new();

/// 安装配置。重复调用会被忽略（第一次赢）。
pub fn install_config(config: Arc<Config>) {
    let _ = CONFIG.set(config);
}

/// 读进程级配置。没装过时退回默认值（单测里常见）。
pub fn config() -> Arc<Config> {
    CONFIG
        .get_or_init(|| Arc::new(Config::default()))
        .clone()
}

/// 安装隧道槽位。
pub fn install_slot(slot: Arc<TunnelSlot>) {
    let _ = SLOT.set(slot);
}

/// 取隧道槽位。没装过就建一个（单测里常见）。
pub fn slot() -> Arc<TunnelSlot> {
    SLOT.get_or_init(|| Arc::new(TunnelSlot::new())).clone()
}

/// 安装控制台。只在 `PLATFORM_ENABLED` 打开时调用。
pub fn install_console(console: Arc<Console>) {
    let _ = CONSOLE.set(console);
}

/// 取控制台；没开启时返回 None。
pub fn console() -> Option<Arc<Console>> {
    CONSOLE.get().cloned()
}

/// 隧道现在通没通。控制台首页与 `/status` 共用这一处判定。
pub fn tunnel_connected() -> bool {
    slot()
        .get()
        .map(|tunnel| !tunnel.is_closed())
        .unwrap_or(false)
}
