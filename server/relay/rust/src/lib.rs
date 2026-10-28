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
//! 还有一本 `migrate`：宿主换中转之前在旧中转上留一条「我搬到 X 了」，本进程按实例
//! 记 30 天。实例不在线时优先回 503 + `x-dsh-migrated-to`（排在镜像兜底之前——让镜像
//! 先答 200 的话，手机拿到旧清单就满足了，永远学不到新地址）。
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
pub mod migrate;
pub mod mirror;
pub mod plugin_versions;
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    /// 帧表与 `relay-core/PROTOCOL.md` 必须逐行对齐。
    ///
    /// 两处都在同一个仓里，却各写各的：编号只改一处的话，后人照文档实现必错（A4-01
    /// 那条坑）。这条用例把「文档」变成可验证的产物——两边任何一边多一帧、少一帧、
    /// 或者名字写错，都会当场红。
    #[test]
    fn protocol_doc_matches_the_frame_table() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../relay-core/PROTOCOL.md");
        let doc = std::fs::read_to_string(path).expect("PROTOCOL.md 必须可读");
        let mut documented: BTreeMap<u8, String> = BTreeMap::new();
        for line in doc.lines() {
            let cells: Vec<&str> = line.split('|').map(str::trim).collect();
            let Some(hex) = cells.get(1).and_then(|cell| cell.strip_prefix("0x")) else {
                continue;
            };
            let Ok(code) = u8::from_str_radix(hex, 16) else {
                continue;
            };
            let Some(name) = cells.get(2).filter(|name| !name.is_empty()) else {
                continue;
            };
            assert!(
                documented.insert(code, name.to_string()).is_none(),
                "PROTOCOL.md 里 {code:#04x} 出现了两次"
            );
        }

        // 文档里的每一行都要在 Rust 表里有同编号同名的常量。
        for (&code, name) in &documented {
            assert_eq!(
                dsh_relay_protocol::t::name(code),
                Some(name.as_str()),
                "PROTOCOL.md 的 {code:#04x} 行写的是 {name}，Rust 侧对不上"
            );
        }
        // 反过来：Rust 表里的每一帧都必须在文档里有行。
        for code in 0x01..=0x1Cu8 {
            let name = dsh_relay_protocol::t::name(code).expect("每一帧都要有名字");
            assert!(
                documented.contains_key(&code),
                "PROTOCOL.md 缺 {name}（{code:#04x}）这一行"
            );
        }
    }
}

