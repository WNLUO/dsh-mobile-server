//! 主控端 / 被控端。
//!
//! 一套代码两种角色，按配置决定：
//!   - 配了 `PLATFORM_MASTER_URL` → 这台是**被控端**，定期向主控端报到；
//!   - 没配 → 这台**自成一体的中转**，同时也是自己那组的「主控端」，认领码在这里发。
//!
//! 边界写死在这里：**主控端只收状态、发指令，从不碰被控端的隧道流量**。
//! 主控端挂了，所有被控端的转发照常，只是看不到报表。
//!
//! 认领方式与宿主连中转是同一套思路——**被控端主动打出去**，主控端不主动连被控端。
//! 这样被控端不需要公网可达，也就不用为它开任何入站口。

use std::time::Duration;

use serde_json::json;

use crate::console::config::ConsoleConfig;
use crate::store::{normalize_claim_code, NodeReport, Store};

/// 被控端向主控端报到的周期默认值。报告很小，5 分钟一次够用；
/// 真需要快一点（付出的代价是主控端每台每分钟被敲一次）就改环境变量。
const DEFAULT_REPORT_INTERVAL: Duration = Duration::from_secs(300);

/// 这台机器是不是被控端。
pub fn is_slave(config: &ConsoleConfig) -> bool {
    !config.master_url.is_empty()
}

/// 被控端的上报任务。由 `main` 在控制台启动后 spawn。
///
/// 只做一件事：每隔一段时间把本机状态报给主控端。失败只记日志、下次再来——
/// 主控端不可用不该影响这台中转自己的转发。
pub fn spawn_reporter(config: ConsoleConfig, store: Store) {
    if !is_slave(&config) {
        return;
    }
    let interval = if config.report_interval_seconds > 0 {
        Duration::from_secs(config.report_interval_seconds)
    } else {
        DEFAULT_REPORT_INTERVAL
    };
    tokio::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                crate::tunnel::log(format!("主控端上报初始化失败：{error}"));
                return;
            }
        };
        loop {
            let report = collect_report(&config, &store);
            let url = format!("{}/api/platform/v1/nodes/report", config.master_url.trim_end_matches('/'));
            let mut request = client
                .post(&url)
                .header("x-dsh-claim", normalize_claim_code(&config.claim_code))
                .json(&report);
            if let Some(token) = config.master_token.as_deref() {
                request = request.header("authorization", format!("Bearer {token}"));
            }
            match request.send().await {
                Ok(response) if response.status().is_success() => {
                    // 主控端可能希望换一个准入模式。这是**唯一**一条从主控端往被控端
                    // 走的东西，而且它搭在「被控端本来就每 5 分钟打一次」的那条路上——
                    // 不新增端点、不新增心跳，被控端也不用开任何入站口。
                    let body = response.text().await.unwrap_or_default();
                    apply_desired_mode(&store, &body);
                    store.set_setting("master_last_report_at", &crate::store::iso_now());
                    store.set_setting("master_last_error", "");
                }
                Ok(response) => {
                    // 状态码本身就是给运维看的结论，照原文抄进日志，别自己再解释一遍：
                    // 403 ＝ 被主控端移除了（去要一个新认领码），
                    // 404 ＝ 这个码主控端不认识（先核对 PLATFORM_MASTER_URL 与 CLAIM_CODE），
                    // 401 ＝ token 不对。
                    let status = response.status().as_u16();
                    let detail = response.text().await.unwrap_or_default();
                    crate::tunnel::log(format!(
                        "主控端拒绝上报：HTTP {status} {}",
                        detail.trim()
                    ));
                    // 面板上要看得见「一直报不上去」。只写日志的话，开面板的人不知道
                    // 自己这台已经在主控端那边掉线了。
                    store.set_setting(
                        "master_last_error",
                        &format!("HTTP {status} {}", detail.trim()),
                    );
                }
                Err(error) => {
                    crate::tunnel::log(format!("主控端不可达：{error}"));
                    store.set_setting("master_last_error", &format!("不可达：{error}"));
                }
            }
            tokio::time::sleep(interval).await;
        }
    });
}

/// 每天清一次过期会话与过期登录事务，由 `main` 在控制台启动后 spawn。
///
/// 跟上报任务一样：失败只记日志，跟转发没有任何关系。
pub fn spawn_housekeeping(store: Store) {
    tokio::spawn(async move {
        loop {
            let (sessions, states) = store.purge_expired();
            if sessions > 0 || states > 0 {
                crate::tunnel::log(format!(
                    "清理过期数据：会话 {sessions} 条、登录事务 {states} 条"
                ));
            }
            tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
        }
    });
}

/// 把主控端回包里的 `admissionMode` 落到本地设置上。
///
/// 没有这个字段、或者值不认识，一律**什么都不做**——主控端没表态就等于不管这台，
/// 本地自己设的模式继续作数。这样「主控端挂了 / 从没配过」的机器行为完全不变。
///
/// 返回是否真的改了，方便调用方记日志。
pub fn apply_desired_mode(store: &Store, body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let wanted = value.get("admissionMode")?.as_str()?.trim();
    if wanted != "open" && wanted != "restricted" {
        return None;
    }
    // 收到过一个有效值就等于「这台由主控端管准入」——哪怕它跟本地现有值一样。
    // 这样面板在「主控端要求的就是它现在的模式」时也能如实显示「由主控端管理」，
    // 而不是显示成「没人管、你可以随便改」，让人改完又被掰回去。
    store.set_setting("master_manages_mode", "1");
    let current = store
        .get_setting("admission_mode")
        .unwrap_or_else(|| "open".to_string());
    if current == wanted {
        return None;
    }
    store.set_setting("admission_mode", wanted);
    store.audit(None, "settings.admission_mode", wanted, "由主控端下发");
    crate::tunnel::log(format!("主控端下发准入模式：{current} → {wanted}"));
    Some(wanted.to_string())
}

/// 收集本机状态。只收聚合值，不收设备明细——被控端不把它的用户清单交出去。
fn collect_report(config: &ConsoleConfig, store: &Store) -> NodeReport {
    let licenses = store.list_licenses(1000);
    let mut devices = 0;
    for license in &licenses {
        devices += store.count_active_devices(&license.id);
    }
    let admission_mode = store
        .get_setting("admission_mode")
        .unwrap_or_else(|| "open".to_string());
    NodeReport {
        name: config.node_name.clone(),
        public_url: config.public_base_url.clone(),
        admission_mode: admission_mode.clone(),
        license_count: licenses.len() as i64,
        device_count: devices,
        tunnel_online: crate::tunnel_connected(),
        status_json: json!({
            "version": env!("CARGO_PKG_VERSION"),
            "admissionMode": admission_mode,
            "licenseCount": licenses.len(),
            "deviceCount": devices,
            "tunnelConnected": crate::tunnel_connected(),
        })
        .to_string(),
    }
}

/// 主控端收一次上报。`claim` 是请求头里那个认领码，`token` 是 Bearer（没配就为空）。
///
/// 返回 `Err(status, message)`：`401` 缺认领码或 token 不对，`404` 认领码不存在
/// （或已被吊销），`403` 是主控端关闭了接收。
///
/// **认领码本身不算秘密**——它要在面板上写给被控端填，会被抄进配置文件、贴进聊天记录。
/// 所以主控端一旦配了 `PLATFORM_MASTER_TOKEN`，就要求上报同时带同一个 Bearer：认领码
/// 决定「这是哪台」，token 决定「允许不允许上报」。没配时只看认领码，这样自建单机
/// 不必多配一样东西，而被控端最常见的故障——**主控地址填成别人的中转**——不会把
/// 本机的状态送进陌生人的面板。
pub fn apply_report(
    store: &Store,
    master: &ConsoleConfig,
    claim: &str,
    token: &str,
    report: &NodeReport,
) -> Result<Option<String>, (u16, String)> {
    if !master.accepts_reports {
        return Err((403, "this relay does not accept node reports".into()));
    }
    if let Some(expected) = master.master_token.as_deref() {
        if token != expected {
            return Err((401, "bad master token".into()));
        }
    }
    if claim.trim().is_empty() {
        return Err((401, "missing claim code".into()));
    }
    let Some(node) = store.find_node_by_claim(claim) else {
        // 已移除的和根本不认识的分开回：被控端日志要能让人看出该「重新生成认领码」
        // 还是「去核对主控地址」，混成一个 404 等于什么都没说。
        if store.find_revoked_node_by_claim(claim).is_some() {
            return Err((403, "this node was removed by the master".into()));
        }
        return Err((404, "unknown claim code".into()));
    };
    if node.revoked_at.is_some() {
        return Err((403, "this node was removed by the master".into()));
    }
    store.touch_node(&node.id, report);
    // 回包带上主控端希望它用的模式。没配过就是空串——被控端看到空串什么都不做。
    let desired = store.desired_mode_of(&node.id);
    Ok(if desired == "open" || desired == "restricted" {
        Some(desired)
    } else {
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{normalize_claim_code, Store};

    fn master_config() -> ConsoleConfig {
        let mut config = ConsoleConfig::from_env();
        config.master_url = String::new();
        config.accepts_reports = true;
        config
    }

    #[test]
    fn claim_code_shape_is_readable() {
        for _ in 0..20 {
            let code = crate::store::generate_claim_code();
            // NODE-XXXX-XXXX
            assert_eq!(code.len(), 14, "{code}");
            assert!(code.starts_with("NODE-"), "{code}");
        }
    }

    #[test]
    fn claim_code_normalizes_like_license_codes() {
        // 统一成可读形 NODE-XXXX-XXXX：库里存它，查询也归一到它。
        assert_eq!(normalize_claim_code("  node-abcd-efgh  "), "NODE-ABCD-EFGH");
        assert_eq!(normalize_claim_code("ABCD-EFGH"), "NODE-ABCD-EFGH");
        assert_eq!(normalize_claim_code("NODE—ABCD—EFGH"), "NODE-ABCD-EFGH");
        assert_eq!(normalize_claim_code("nodeabcde fgh"), "NODE-ABCD-EFGH");
    }

    #[test]
    fn report_updates_master_view_of_node() {
        let store = Store::in_memory().unwrap();
        let master = master_config();
        let node = store.create_node("我家那台");
        let report = NodeReport {
            name: "搭建者改过的名字".into(),
            public_url: "https://relay.example.com".into(),
            admission_mode: "restricted".into(),
            license_count: 3,
            device_count: 2,
            tunnel_online: true,
            status_json: "{}".into(),
        };
        apply_report(&store, &master, &node.claim_code, "", &report).expect("上报应该被接受");

        let refreshed = store.find_node_by_id(&node.id).expect("节点还在");
        assert_eq!(refreshed.name, "搭建者改过的名字");
        assert_eq!(refreshed.admission_mode, "restricted");
        assert_eq!(refreshed.license_count, 3);
        assert_eq!(refreshed.device_count, 2);
        assert!(refreshed.tunnel_online);
        assert!(refreshed.last_seen_at.is_some());
    }

    #[test]
    fn unknown_or_revoked_claim_is_rejected() {
        let store = Store::in_memory().unwrap();
        let master = master_config();
        let report = NodeReport::default();
        assert_eq!(apply_report(&store, &master, "NODE-NOPENOPE", "", &report).unwrap_err().0, 404);

        let node = store.create_node("临时");
        store.revoke_node(&node.id);
        // **403 而不是 404**：被控端日志要能分清「我被移除了，去要个新认领码」
        // 和「这个码压根不认识，先核对主控地址」。混成一个 404 等于什么都没说。
        let (status, message) = apply_report(&store, &master, &node.claim_code, "", &report).unwrap_err();
        assert_eq!(status, 403, "移除之后同一个码必须失效");
        assert!(message.contains("removed"), "{message}");

        // 移除不删行：记录还在，只是 `revoked_at` 有值。
        assert!(
            store.find_node_by_id(&node.id).is_some(),
            "移除必须留记录，否则主控端自己也看不出这里曾经有台机器"
        );
        assert!(store.find_node_by_id(&node.id).unwrap().revoked_at.is_some());
        // 彻底删除才真的没了。
        store.forget_node(&node.id);
        assert!(store.find_node_by_id(&node.id).is_none());
    }

    /// 移除之后认得出来（走 `find_revoked_node_by_claim`），陌生码认不出来。
    #[test]
    fn revoked_and_unknown_are_distinguishable() {
        let store = Store::in_memory().unwrap();
        let node = store.create_node("临时");
        assert!(store.find_revoked_node_by_claim(&node.claim_code).is_none(), "还没移除");
        store.revoke_node(&node.id);
        assert!(store.find_revoked_node_by_claim(&node.claim_code).is_some());
        assert!(store.find_revoked_node_by_claim("NODE-NOPENOPE").is_none());
    }

    /// 生成认领码时要连**已移除**的行一起查重，否则撞上会违反唯一约束、
    /// INSERT 静默失败，表现是「生成了但列表里没有」。
    #[test]
    fn create_node_still_works_with_revoked_rows() {
        let store = Store::in_memory().unwrap();
        let first = store.create_node("甲");
        store.revoke_node(&first.id);
        let second = store.create_node("乙");
        assert_ne!(second.id, first.id);
        assert_ne!(second.claim_code, first.claim_code);
        assert!(store.find_node_by_id(&second.id).is_some(), "新生成的那台必须真的在");
        assert!(store.find_node_by_id(&first.id).is_some(), "已移除的那条不能因此消失");
    }

    /// 被控端本地面板在「已被主控端接管」时拒绝改模式，
    /// 免得改了又被下一轮上报掰回去。
    #[test]
    fn local_mode_is_locked_once_master_takes_over() {
        let mut config = ConsoleConfig::from_env();
        config.enabled = true;
        config.db_path = ":memory:".to_string();
        config.master_url = "https://master.example.com".into();
        let console = crate::console::Console::new(config).unwrap();
        let admin = console.store.upsert_user("sub:admin", "管理员", "", None, None);
        assert!(admin.is_admin);
        assert!(!console.is_mode_controlled(), "一开始没人管");

        assert_eq!(console.set_admission_mode(&admin, "restricted").status, 200);

        // 主控端下发了一次，哪怕结果和本地一样，也算「接管了」。
        apply_desired_mode(&console.store, r#"{"ok":true,"admissionMode":"restricted"}"#);
        assert!(console.is_mode_controlled());
        assert_eq!(
            console.set_admission_mode(&admin, "open").status,
            409,
            "被接管之后本地不许改"
        );
        assert_eq!(console.admission_mode(), "restricted", "本地设置不能被改动");
    }

    #[test]
    fn master_can_refuse_reports() {
        let store = Store::in_memory().unwrap();
        let mut master = master_config();
        master.accepts_reports = false;
        let node = store.create_node("x");
        assert_eq!(
            apply_report(&store, &master, &node.claim_code, "", &NodeReport::default())
                .unwrap_err()
                .0,
            403
        );
    }

    /// 认领码是给人抄的、不是秘密；主控端配了 token 之后它一个人就不够用了。
    #[test]
    fn master_token_is_required_when_configured() {
        let store = Store::in_memory().unwrap();
        let mut master = master_config();
        master.master_token = Some("s3cret".into());
        let node = store.create_node("x");
        let report = NodeReport::default();

        assert_eq!(
            apply_report(&store, &master, &node.claim_code, "", &report).unwrap_err().0,
            401,
            "配了 token 之后光有认领码不能上报"
        );
        assert_eq!(
            apply_report(&store, &master, &node.claim_code, "wrong", &report).unwrap_err().0,
            401,
            "token 不对必须拒"
        );
        apply_report(&store, &master, &node.claim_code, "s3cret", &report).expect("带对 token 应该通过");

        // 没配 token 时退回只看认领码，行为与加这一道之前一致。
        master.master_token = None;
        apply_report(&store, &master, &node.claim_code, "", &report).expect("没配 token 时不要求");
    }

    /// 主控端没表态时，回包里不能有 `admissionMode`——被控端看到缺字段就不动本地设置。
    #[test]
    fn report_reply_carries_no_mode_until_master_sets_one() {
        let store = Store::in_memory().unwrap();
        let master = master_config();
        let node = store.create_node("x");
        let reply = apply_report(&store, &master, &node.claim_code, "", &NodeReport::default()).unwrap();
        assert_eq!(reply, None, "没设过期望模式时什么都不许带");
    }

    /// 主控端设了之后，每次上报都能把它取回去。
    #[test]
    fn report_reply_carries_the_mode_master_set() {
        let store = Store::in_memory().unwrap();
        let master = master_config();
        let node = store.create_node("x");
        let report = NodeReport::default();

        assert!(store.set_desired_mode(&node.id, Some("restricted")));
        let reply = apply_report(&store, &master, &node.claim_code, "", &report).unwrap();
        assert_eq!(reply.as_deref(), Some("restricted"));

        // 交回给被控端自己决定之后，回包又不带字段了。
        assert!(store.set_desired_mode(&node.id, None));
        let reply = apply_report(&store, &master, &node.claim_code, "", &report).unwrap();
        assert_eq!(reply, None);
    }

    #[test]
    fn setting_mode_on_unknown_node_reports_false() {
        let store = Store::in_memory().unwrap();
        assert!(!store.set_desired_mode("no-such-node", Some("open")));
    }

    /// 被控端这边：拿到 `admissionMode` 就落地，缺字段或怪值一律不动。
    #[test]
    fn slave_applies_mode_from_master_reply() {
        let store = Store::in_memory().unwrap();
        assert_eq!(store.get_setting("admission_mode"), None, "一开始没有这个设置");

        assert_eq!(apply_desired_mode(&store, r#"{"ok":true,"admissionMode":"restricted"}"#).as_deref(), Some("restricted"));
        assert_eq!(store.get_setting("admission_mode").as_deref(), Some("restricted"));

        // 已经是这个值就不要再记一次审计、也不要报「改过了」。
        assert_eq!(apply_desired_mode(&store, r#"{"ok":true,"admissionMode":"restricted"}"#), None);

        assert_eq!(apply_desired_mode(&store, r#"{"ok":true,"admissionMode":"open"}"#).as_deref(), Some("open"));

        // 主控端没表态 / 值不认识 / 不是 JSON：本地设置继续作数。
        for body in [r#"{"ok":true}"#, r#"{"ok":true,"admissionMode":"bogus"}"#, "not json"] {
            assert_eq!(apply_desired_mode(&store, body), None, "{body}");
        }
        assert_eq!(store.get_setting("admission_mode").as_deref(), Some("open"));
    }
}
