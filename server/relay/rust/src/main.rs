//! 自建版中转的入口：读配置、起 HTTP 服务、等隧道连上来。
//!
//! 控制台（`PLATFORM_ENABLED=1`）是可选的：打开时它接管 `/api/platform/v1/**` 与
//! `/platform/**`，并提供隧道准入；关着的时候就是纯转发。
//!
//! 自动更新（`SELF_UPDATE=1`）也是可选的，而且**默认关**。它跟控制台无关：纯转发的
//! 机器一样能自己升级——状态记在数据目录的一个纯文本文件里，不碰数据库。
//!
//! 启动顺序里有一件事是「先绑端口、再自检」：如果上一次升级换上去的新版本需要被验证，
//! 得先把服务跑起来、自己问自己一句 `/healthz`，才谈得上「它到底行不行」。绑不上端口
//! 的版本会自己死掉，那由下一轮启动的记账兜住（见 `selfupdate`）。

use std::sync::Arc;
use std::time::Duration;

use dsh_relay::config::Config;
use dsh_relay::console::config::ConsoleConfig;
use dsh_relay::selfupdate::{self, Paths, Startup};
use dsh_relay::tunnel::{log, TunnelSlot};

#[tokio::main]
async fn main() {
    // `--version` 只打印版本就退出：**不读配置、不绑端口、不连隧道**。
    //
    // 自动更新要在替换文件之前「试跑一遍候选二进制」，靠的就是这条：一个起不来的
    // 包（动态链接的、架构不对的）会在这里就暴露，而不是等真换上去之后无限重启。
    // 早先这里什么参数都不认，`dsh-relay --version` 会老老实实把服务起起来——
    // 探测一下版本就多出一个监听进程，那次是人工排查时才发现的。
    if std::env::args().skip(1).any(|arg| arg == "--version" || arg == "-V") {
        println!("dsh-relay {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let config = match Config::from_env() {
        Ok(config) => Arc::new(config),
        Err(message) => {
            eprintln!("配置错误：{message}");
            std::process::exit(1);
        }
    };

    dsh_relay::install_config(config.clone());
    // APNs 推送出口：默认关闭（APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID 任一不配就是关）。
    // 关闭时只打一条日志，转发路径一个字不变。
    dsh_relay::apns::init_from_env();
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
    // 升级状态与下载的临时文件放数据目录。跟着控制台的库路径走，这样老部署
    // （`PLATFORM_DB_PATH` 指到 /opt/.../data）不用改一行配置。
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
                dsh_relay::install_console(console);
                log(format!(
                    "控制台已开启 api={} web={}",
                    console_config.api_prefix, console_config.web_prefix
                ));
            }
            Err(error) => log(format!("控制台启动失败，退化为纯转发：{error}")),
        }
    }

    // 升级状态：是不是有一个换了上去、还没验证过的新版本在等这次启动。
    // 记账必须在绑定端口**之前**落盘：一个绑不上端口就死的版本，要靠这一次记账
    // 才能在下一次启动时被认出来。
    let paths = Paths {
        exe: std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("dsh-relay")),
        data_dir: data_dir.clone(),
    };
    let startup = selfupdate::note_start(&paths, env!("CARGO_PKG_VERSION"));

    let listener = match tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("监听失败：{error}");
            std::process::exit(1);
        }
    };

    // 接受连接的循环先跑起来，后面的健康自检要真的打一个请求进来。
    {
        let slot = slot.clone();
        tokio::spawn(async move {
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
        });
    }

    match startup {
        Startup::Verify => {
            // 换上去的新版本第一次起来。**能不能答**才叫起来了，绑上端口不算。
            let ok = selfupdate::probe_health(&config.host, config.port).await;
            if ok {
                selfupdate::confirm(&paths, env!("CARGO_PKG_VERSION"));
                log(format!(
                    "自动更新到 {} 成功（/healthz 已能应答）",
                    env!("CARGO_PKG_VERSION")
                ));
            } else {
                let pending = env!("CARGO_PKG_VERSION").to_string();
                selfupdate::revert(&paths, &pending, "启动后 /healthz 拿不到 200");
                std::process::exit(selfupdate::EXIT_RESTART);
            }
        }
        Startup::Confirmed => {}
        Startup::Stranded { pending } => {
            log(format!(
                "盘上记着待验证的升级 {pending}，但这次起来的是 {}；已停止后续自动更新",
                env!("CARGO_PKG_VERSION")
            ));
        }
        Startup::Revert { pending } => {
            selfupdate::revert(&paths, &pending, "同一版本连续两次启动都没验明");
            std::process::exit(selfupdate::EXIT_RESTART);
        }
        Startup::Stopped { reason } => {
            log(format!("上一次自动更新失败过（{reason}），本轮不再自动升级"));
        }
        Startup::Idle => {}
    }

    if config.self_update {
        // 开了自动更新却没有更新源：**拒绝启动**，不静默跳过。
        // 静默跳过会让人以为「开着」，真出事时才发现从没生效过。
        //
        // 走不到这里的情形是「官方预编译包」：那个包在编译期烤进了一组默认源
        // （见 config.rs 的 BUILT_IN_SOURCES），所以从我们发布的包装的人只要
        // SELF_UPDATE=1 就够了。自己 `cargo build` 出来的没有默认源，必须自己指定
        // ——这是刻意的：源码编的机器不该被官方二进制悄悄换掉。
        if config.self_update_sources.is_empty() {
            eprintln!(
                "错误：SELF_UPDATE=1 但没有任何更新源，也没有烤进默认源。\
                 \n  源码编译出来的版本不带默认源（避免自己编的被官方二进制替换）。要么给一个：\
                 \n    SELF_UPDATE_SOURCE=https://your-domain.example/relay-updates\
                 \n  要么改用官方预编译包（它内置了默认源）。多个源用逗号分隔，按顺序试。\
                 \n  不想用自动更新就别设 SELF_UPDATE。"
            );
            std::process::exit(1);
        }
        log(format!(
            "自动更新已开启：每 {} 小时检查一次，源 {}",
            config.self_update_interval_seconds / 3600,
            config.self_update_sources.join(" → ")
        ));
        selfupdate::spawn_self_update(selfupdate::UpdateContext {
            enabled: true,
            interval: Duration::from_secs(config.self_update_interval_seconds),
            sources: config.self_update_sources.clone(),
            paths,
        });
    }

    // 诊断：按实例统计收到的 sync 帧体积（`DEBUG_SYNC_STATS=1` 才真正开）。
    dsh_relay::mirror::spawn_sync_stats();

    // HTTP 服务已经在上面那个任务里跑了。这里只等着被信号结束。
    tokio::signal::ctrl_c().await.ok();
    log("收到退出信号".to_string());
}
