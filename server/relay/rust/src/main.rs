//! 自建版中转的入口：读配置、起 HTTP 服务、等隧道连上来。
//!
//! 控制台（`PLATFORM_ENABLED=1`）是可选的：打开时它接管 `/api/platform/v1/**` 与
//! `/platform/**`，并提供隧道准入；关着的时候就是纯转发。
//!
//! 自动更新（`SELF_UPDATE=1`）也是可选的，而且**默认关**。

use std::sync::Arc;
use std::time::Duration;

use dsh_relay::config::Config;
use dsh_relay::console::config::ConsoleConfig;
use dsh_relay::tunnel::{log, TunnelSlot};

#[tokio::main]
async fn main() {
    let config = match Config::from_env() {
        Ok(config) => Arc::new(config),
        Err(message) => {
            eprintln!("配置错误：{message}");
            std::process::exit(1);
        }
    };

    dsh_relay::install_config(config.clone());
    let slot = Arc::new(TunnelSlot::new());
    dsh_relay::install_slot(slot.clone());
    log(format!(
        "dsh-relay 启动 host={} port={} version={}",
        config.host,
        config.port,
        env!("CARGO_PKG_VERSION")
    ));

    // 控制台：默认关闭。配置不全时只打警告、不挡转发——中转的首要职责是转发，
    // 登录配置缺了不该让整台服务起不来。
    let console_config = ConsoleConfig::from_env();
    let mut update_store = None;
    let data_dir = std::path::PathBuf::from(&console_config.db_path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("data"));
    if console_config.enabled {
        for problem in console_config.problems() {
            log(format!("控制台配置问题：{problem}"));
        }
        match dsh_relay::Console::new(console_config.clone()) {
            Ok(console) => {
                // 被控端：起一个上报任务，定期把本机状态报给主控端。
                // 主控端不可达只记日志，不影响这台中转自己的转发。
                if dsh_relay::console::node::is_slave(&console_config) {
                    log(format!("被控端模式：向 {} 上报", console_config.master_url));
                    dsh_relay::console::node::spawn_reporter(
                        console_config.clone(),
                        console.store.clone(),
                    );
                }
                // 每天清一次过期会话与过期登录事务，别让它无限长。
                dsh_relay::console::node::spawn_housekeeping(console.store.clone());
                update_store = Some(console.store.clone());
                dsh_relay::install_console(console);
                log(format!(
                    "控制台已开启 api={} web={}",
                    console_config.api_prefix, console_config.web_prefix
                ));
            }
            Err(error) => log(format!("控制台启动失败，退化为纯转发：{error}")),
        }
    }

    // 上一次升级到底成没成：进程活了就算成了一半，另一半要看端口能不能答。
    // 判定放在监听成功之后做，见下面。
    let pending_after_bind = update_store
        .as_ref()
        .map(|store| dsh_relay::selfupdate::finish_pending_update(store, env!("CARGO_PKG_VERSION")))
        .unwrap_or(None);

    let listener = match tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("监听失败：{error}");
            std::process::exit(1);
        }
    };

    // 绑上端口 = 这台服务真的能用了。到这一步才敢说上次那次升级是成功的。
    if let Some(previous) = pending_after_bind {
        // 能走到这里说明**没**被判定为失败，只是留个记录方便排查。
        log(format!("上次自动更新（{previous}）已经正常接管"));
    }

    if config.self_update {
        // 开了自动更新却没给更新源：**拒绝启动**，不静默跳过。
        // 静默跳过会让人以为「开着」，真出事时才发现从没生效过；更早的版本还会默认去
        // 别人的域名拉包（见 config.rs 里 DEFAULT_SELF_UPDATE_SOURCE 的注释）。这两种都
        // 比一句启动报错糟得多。
        if config.self_update_source.trim().is_empty() {
            eprintln!(
                "错误：SELF_UPDATE=1 但没设 SELF_UPDATE_SOURCE。自动更新要从一个你控制的\
                 静态目录取 latest.json，不设就不知道去哪取。\
                 \n  例：SELF_UPDATE_SOURCE=https://your-domain.example/relay-updates\
                 \n  不想用自动更新就别设 SELF_UPDATE。"
            );
            std::process::exit(1);
        }
        match update_store.clone() {
            Some(store) => {
                log(format!(
                    "自动更新已开启：每 {} 小时检查一次",
                    config.self_update_interval_seconds / 3600
                ));
                dsh_relay::selfupdate::spawn_self_update(dsh_relay::selfupdate::UpdateContext {
                    enabled: true,
                    interval: Duration::from_secs(config.self_update_interval_seconds),
                    source: config.self_update_source.clone(),
                    store,
                    data_dir,
                });
            }
            // 没有退出标记的存储。宁可不动，也不要在不确定的状态下替换生产文件。
            None => log("自动更新已开启但没有可用的数据目录，已跳过".to_string()),
        }
    }

    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(error) => {
                log(format!("accept 失败：{error}"));
                continue;
            }
        };
        let slot = slot.clone();
        tokio::spawn(async move {
            let _ = dsh_relay::serve_connection(stream, slot).await;
        });
    }
}
