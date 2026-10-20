//! 宿主离线时的最后一份镜像。
//!
//! 中转原本是纯转发：宿主那条隧道不在，手机上来的读就只有一句 503，侧栏空着、什么都
//! 点不开。弱网与宿主刚断线的时候，人看到的正是这个。这里把宿主**自己推上来**的那份
//! 会话清单与工作区留在进程里，只在找不到能用的隧道时回给手机，并且如实标成 stale——
//! 它只保证「还看得见」，不假装数据是新的（手机侧对 stale 会显示「已保留上次的列表」，
//! 也不会拿它当权威去确认删除/归档）。
//!
//! 四条边界，改之前先看：
//!   - **只服务读，且只服务默认视图**。归档子集（`archived=1`）、翻页（`offset`/`limit`/
//!     `beforeSeq`）、写后刷新（`fresh=1`）一律不走缓存：拿默认列表答归档请求会把已归档
//!     的会话漏掉，拿旧副本答「我刚写完要看结果」会让刚删掉的东西复活。
//!   - **只认配对过的手机**。宿主在镜像帧里带上本实例已签发设备凭据的 sha256，中转拿
//!     手机带来的凭据算一遍哈希去对。中转看不到凭据原文，也没有自己的账号体系；对不上
//!     就什么都不给，退回今天那句 503（不新增错误面，老客户端行为一个字不变）。
//!   - **老插件不供缓存**。没收到摘要（字段缺席 = 那时候还没有这回事）时宁可什么都不给，
//!     也不要把「谁都能读」当默认。
//!   - **不落盘**。进程重启就没了；宿主那边隧道一连上就会全量重推一份，几秒内自己长回来。
//!
//! 存的是宿主给的那份 body 原文，读的时候才注入 `stale`。这样常驻内存只有一份文本，
//! 而「谁在看」这条冷路径上多一次解析换来的开销可以忽略。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// 同时记多少台实例的镜像。中转本来是给「一台机器一个实例」用的，公用中转上实例数
/// 也就这么多；超了淘汰最旧的那份，别让一张表长到吃光内存。
const MAX_INSTANCES: usize = 16;
/// 单份镜像（会话清单 + 工作区两份 body）的字节上限。
const MAX_ENTRY_BYTES: usize = 3 * 1024 * 1024;
/// 一次 sync 帧的字节上限。超过就不收、保留上一份——畸形或超大的帧不该把好镜像顶掉。
const MAX_SYNC_BYTES: usize = 12 * 1024 * 1024;
/// 一份镜像最多留多久。宿主七天没正常连上来，这份缓存就该当它不存在了。
const ENTRY_TTL_MS: u64 = 7 * 24 * 3600 * 1000;
/// 一份镜像最多认多少条设备凭据摘要。
const MAX_CREDS: usize = 200;

/// 手机这次想读哪一份清单。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ListKind {
    Sessions,
    Workspaces,
}

struct MirrorEntry {
    sessions: String,
    workspaces: String,
    sessions_revision: String,
    workspaces_revision: String,
    sessions_generated_at: i64,
    workspaces_generated_at: i64,
    /// (凭据 sha256 hex, 过期时刻毫秒；0 = 无过期)
    creds: Vec<(String, i64)>,
    stored_at_ms: u64,
    /// 落地顺序。同一毫秒里推上来的两份镜像靠它分先后：只按毫秒时间戳淘汰会变成
    /// 「随便挑一份」，而淘汰本来要淘汰的是最旧的那次推送。
    stored_seq: u64,
}

impl MirrorEntry {
    /// 这一份清单的（body, 内容指纹, 宿主构建时刻）。
    fn body_of(&self, kind: ListKind) -> (&str, &str, i64) {
        match kind {
            ListKind::Sessions => (
                &self.sessions,
                &self.sessions_revision,
                self.sessions_generated_at,
            ),
            ListKind::Workspaces => (
                &self.workspaces,
                &self.workspaces_revision,
                self.workspaces_generated_at,
            ),
        }
    }
}

fn store() -> &'static Mutex<HashMap<String, MirrorEntry>> {
    static STORE: OnceLock<Mutex<HashMap<String, MirrorEntry>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 落地顺序的唯一来源。
fn next_seq() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 宿主推上来的镜像帧（隧道帧 `sync`）。收到就整份替换，格式不对就**保留上一份**。
pub fn remember(instance_id: &str, payload: &[u8]) -> bool {
    let key = instance_id.trim();
    if key.is_empty() || payload.len() > MAX_SYNC_BYTES {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return false;
    };
    if value.get("kind").and_then(|v| v.as_str()) != Some("sync") {
        return false;
    }
    // 两份清单都必须自报成功。宿主那边的空清单守卫已经拦过一轮，这里再判一次是因为
    // 「畸形/半份」一旦落进来，手机看到的就是一份权威的空侧栏，而且比 503 更难查。
    let (Some(sessions), Some(workspaces)) = (
        value.get("sessions").filter(|v| is_ok(v)),
        value.get("workspaces").filter(|v| is_ok(v)),
    ) else {
        return false;
    };
    let (Ok(sessions_body), Ok(workspaces_body)) =
        (serde_json::to_string(sessions), serde_json::to_string(workspaces))
    else {
        return false;
    };
    if sessions_body.len() + workspaces_body.len() > MAX_ENTRY_BYTES {
        return false;
    }
    let entry = MirrorEntry {
        sessions_revision: string_of(sessions, "revision"),
        workspaces_revision: string_of(workspaces, "revision"),
        sessions_generated_at: number_of(sessions, "generatedAt"),
        workspaces_generated_at: number_of(workspaces, "generatedAt"),
        creds: creds_of(&value),
        sessions: sessions_body,
        workspaces: workspaces_body,
        stored_at_ms: now_ms(),
        stored_seq: next_seq(),
    };
    let mut map = store().lock().unwrap_or_else(|e| e.into_inner());
    let previous_creds = map.get(key).map(|entry| entry.creds.len());
    if !map.contains_key(key) && map.len() >= MAX_INSTANCES {
        let oldest = map
            .iter()
            .min_by_key(|(_, entry)| (entry.stored_at_ms, entry.stored_seq))
            .map(|(instance, _)| instance.clone());
        if let Some(instance) = oldest {
            map.remove(&instance);
        }
    }
    let (sessions_bytes, workspaces_bytes) = (entry.sessions.len(), entry.workspaces.len());
    let creds_count = entry.creds.len();
    map.insert(key.to_string(), entry);
    drop(map);
    // 只在这两件事上留一行：镜像第一次落地、摘要条数变了。镜像本身每 500ms 就重推一次，
    // 每推一次打一行会把日志刷满；而这两条恰恰是运维要看的（「中转到底收没收到镜像」
    // 「撤销一台设备有没有传导过去」）。缓存命中不打：宿主离线时它会按轮询节奏反复出现。
    match previous_creds {
        None => crate::tunnel::log(format!(
            "mirror stored instance={key} sessions={sessions_bytes}B workspaces={workspaces_bytes}B creds={creds_count}"
        )),
        Some(before) if before != creds_count => crate::tunnel::log(format!(
            "mirror creds changed instance={key} {before} -> {creds_count}"
        )),
        Some(_) => {}
    }
    true
}

/// 读缓存：给不出去就 None，调用方照旧走「那台宿主不在线」。
///
/// `rev` 是手机带来的内容指纹：与缓存里那份相同就只回一句 unchanged（几十字节），
/// 省掉一整份清单的传输。
pub fn lookup(
    instance_id: &str,
    kind: ListKind,
    rev: &str,
    credential: Option<&str>,
) -> Option<String> {
    let now = now_ms();
    // 出锁只带走要用的那几段：不掐着全局锁做 JSON 解析。
    let (body, revision, generated_at, creds) = {
        let map = store().lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.get(instance_id.trim())?;
        if now.saturating_sub(entry.stored_at_ms) > ENTRY_TTL_MS {
            return None;
        }
        let (body, revision, generated_at) = entry.body_of(kind);
        (
            body.to_string(),
            revision.to_string(),
            generated_at,
            entry.creds.clone(),
        )
    };
    if !creds_allow(&creds, credential, now as i64) {
        return None;
    }
    if !rev.is_empty() && rev == revision {
        let unchanged = serde_json::json!({
            "ok": true,
            "unchanged": true,
            "revision": revision,
            "generatedAt": generated_at,
        });
        return Some(unchanged.to_string());
    }
    let mut value: serde_json::Value = serde_json::from_str(&body).ok()?;
    // 如实标旧：手机据此显示「已保留上次的列表」，也不会拿它当权威去确认删除/归档。
    if let Some(object) = value.as_object_mut() {
        object.insert("stale".to_string(), serde_json::Value::Bool(true));
    }
    serde_json::to_string(&value).ok()
}

/// 这份凭据能不能读缓存。`creds` 为空（老插件还没推摘要）一律不放行。
fn creds_allow(creds: &[(String, i64)], credential: Option<&str>, now_ms: i64) -> bool {
    let Some(raw) = credential else { return false };
    if !raw.starts_with("dshc_") || creds.is_empty() {
        return false;
    }
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    let digest: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    creds
        .iter()
        .any(|(hash, expires_at)| (*expires_at == 0 || *expires_at > now_ms) && *hash == digest)
}

/// 一次「已经问出去了、但可能来不及」的缓存读。
///
/// 转发路径在等宿主回 `httpHead` 的时候把它备着：到点还没回，就先拿它答手机，再取消
/// 上游。与直接命中缓存的区别只有一个——这时候隧道是**活着**的，所以只在阈值到点后
/// 才用它（见 `proxy_request`）。
#[derive(Clone)]
pub struct Fallback {
    instance: String,
    kind: ListKind,
    rev: String,
    credential: Option<String>,
}

impl Fallback {
    pub fn new(instance: String, kind: ListKind, rev: String, credential: Option<String>) -> Self {
        Self { instance, kind, rev, credential }
    }

    /// 现在能拿得出东西吗。拿不出（凭据对不上、没这份清单）就当没备过。
    pub fn serve(&self) -> Option<String> {
        lookup(&self.instance, self.kind, &self.rev, self.credential.as_deref())
    }
}

/// 这次请求能不能走缓存读。返回「哪一份清单 + 手机带来的内容指纹」。
///
/// 判据刻意窄：多认一种查询参数，就多一种「把默认视图的缓存答成另一个子集」的可能。
pub fn parse_read(method: &str, pathname: &str, query: &str) -> Option<(ListKind, String)> {
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }
    let kind = match pathname {
        "/api/mobile/v1/sessions" => ListKind::Sessions,
        "/api/mobile/v1/workspaces" => ListKind::Workspaces,
        _ => return None,
    };
    let mut rev = String::new();
    for pair in query.trim_start_matches('?').split('&') {
        if pair.is_empty() {
            continue;
        }
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        match name {
            "rev" => rev = value.to_string(),
            // 下面这些一出现就说明这次不是「默认视图的普通读」，一律不碰缓存。
            "fresh" | "archived" | "offset" | "limit" | "beforeSeq" | "afterSeq" | "ids"
            | "sessionId" | "q" => return None,
            _ => {}
        }
    }
    Some((kind, rev))
}

fn is_ok(value: &serde_json::Value) -> bool {
    value.get("ok").and_then(|v| v.as_bool()) == Some(true)
}

fn string_of(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

fn number_of(value: &serde_json::Value, key: &str) -> i64 {
    value.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

fn creds_of(payload: &serde_json::Value) -> Vec<(String, i64)> {
    let Some(list) = payload.get("creds").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|item| {
            let hash = item.get("hash")?.as_str()?.trim().to_ascii_lowercase();
            // 摘要只认 sha256 hex：别的形状说明这一帧不是我们约定的那份，宁可整条丢掉。
            if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            let expires_at = item.get("expiresAt").and_then(|v| v.as_i64()).unwrap_or(0);
            Some((hash, expires_at.max(0)))
        })
        .take(MAX_CREDS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 镜像表是进程级单例。用例并行跑时会互相淘汰对方的条目，断言就成了测时序——
    /// 每个用例先拿这把锁，串起来跑。
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn digest_of(credential: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(credential.as_bytes());
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn payload(creds: serde_json::Value) -> Vec<u8> {
        serde_json::json!({
            "kind": "sync",
            "at": 1,
            "activeSessionId": "s1",
            "sessions": { "ok": true, "items": [{ "sessionId": "s1" }], "revision": "aaa", "generatedAt": 111, "emptyConfirmed": false },
            "workspaces": { "ok": true, "items": [{ "workspaceId": "w1" }], "revision": "bbb", "generatedAt": 222 },
            "messages": {},
            "stats": {},
            "models": {},
            "creds": creds,
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn keeps_the_last_pushed_bodies_and_marks_them_stale() {
        let _guard = serial();
        let instance = "mirror-keep";
        assert!(remember(
            instance,
            &payload(serde_json::json!([{ "hash": digest_of("dshc_live") }]))
        ));
        let body = lookup(instance, ListKind::Sessions, "", Some("dshc_live")).expect("cached body");
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["stale"], serde_json::json!(true));
        assert_eq!(parsed["revision"], serde_json::json!("aaa"));
        assert_eq!(parsed["items"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn serves_only_to_a_known_device_credential() {
        let _guard = serial();
        let instance = "mirror-cred";
        assert!(remember(
            instance,
            &payload(serde_json::json!([{ "hash": digest_of("dshc_live") }]))
        ));
        assert!(lookup(instance, ListKind::Sessions, "", Some("dshc_live")).is_some());
        // 别台设备的凭据、非 dshc_ 的东西、没带凭据都不认。
        assert_eq!(lookup(instance, ListKind::Sessions, "", Some("dshc_other")), None);
        assert_eq!(lookup(instance, ListKind::Sessions, "", Some("Bearer x")), None);
        assert_eq!(lookup(instance, ListKind::Sessions, "", None), None);
    }

    #[test]
    fn old_plugins_without_creds_get_nothing() {
        let _guard = serial();
        let instance = "mirror-nocreds";
        assert!(remember(instance, &payload(serde_json::json!([]))));
        assert_eq!(lookup(instance, ListKind::Sessions, "", Some("dshc_live")), None);
        // 连字段都不带的那一版同样不给。
        assert!(remember(instance, &payload(serde_json::Value::Null)));
        assert_eq!(lookup(instance, ListKind::Sessions, "", Some("dshc_live")), None);
    }

    #[test]
    fn honours_credential_expiry() {
        let _guard = serial();
        let instance = "mirror-expiry";
        assert!(remember(
            instance,
            &payload(serde_json::json!([{ "hash": digest_of("dshc_old"), "expiresAt": 1 }]))
        ));
        assert_eq!(lookup(instance, ListKind::Sessions, "", Some("dshc_old")), None);
    }

    #[test]
    fn unchanged_answers_with_the_cached_revision() {
        let _guard = serial();
        let instance = "mirror-rev";
        assert!(remember(
            instance,
            &payload(serde_json::json!([{ "hash": digest_of("dshc_one") }]))
        ));
        let body = lookup(instance, ListKind::Workspaces, "bbb", Some("dshc_one")).expect("unchanged");
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["unchanged"], serde_json::json!(true));
        assert_eq!(parsed["revision"], serde_json::json!("bbb"));
        assert_eq!(parsed["generatedAt"], serde_json::json!(222));
        // 指纹对不上就回整份。
        let full = lookup(instance, ListKind::Workspaces, "zzz", Some("dshc_one")).unwrap();
        assert!(full.contains("\"items\""));
    }

    #[test]
    fn refuses_degraded_or_foreign_payloads() {
        let _guard = serial();
        let instance = "mirror-bad";
        // 不是 sync 帧
        assert!(!remember(instance, br#"{"kind":"raw","data":{}}"#));
        // 畸形 JSON
        assert!(!remember(instance, b"{not json"));
        // 清单自报失败：宁可没有缓存，也不要一份权威的空侧栏
        assert!(!remember(
            instance,
            serde_json::json!({
                "kind": "sync",
                "sessions": { "ok": false },
                "workspaces": { "ok": true, "items": [], "revision": "x" },
                "creds": [],
            })
            .to_string()
            .as_bytes()
        ));
        assert_eq!(lookup(instance, ListKind::Sessions, "", Some("dshc_any")), None);
    }

    #[test]
    fn a_bad_push_keeps_the_previous_good_copy() {
        let _guard = serial();
        let instance = "mirror-keep-good";
        assert!(remember(
            instance,
            &payload(serde_json::json!([{ "hash": digest_of("dshc_live") }]))
        ));
        assert!(!remember(
            instance,
            serde_json::json!({ "kind": "sync", "sessions": { "ok": false } })
                .to_string()
                .as_bytes()
        ));
        let body = lookup(instance, ListKind::Sessions, "", Some("dshc_live")).expect("still there");
        assert!(body.contains("\"revision\":\"aaa\""));
    }

    #[test]
    fn only_plain_default_reads_are_cacheable() {
        let _guard = serial();
        for path in ["/api/mobile/v1/sessions", "/api/mobile/v1/workspaces"] {
            assert!(parse_read("GET", path, "").is_some(), "{path}");
            assert!(parse_read("GET", path, "?rev=abc").is_some(), "{path}");
            // 归档子集 / 翻页 / 写后刷新 / 会话内正文都不是同一份内容
            for query in [
                "?archived=1",
                "?fresh=1",
                "?offset=50&limit=50",
                "?beforeSeq=10",
                "?sessionId=s1",
            ] {
                assert!(parse_read("GET", path, query).is_none(), "{path}{query}");
            }
        }
        assert!(parse_read("POST", "/api/mobile/v1/sessions", "").is_none());
        assert!(parse_read("GET", "/api/mobile/v1/session", "").is_none());
        assert!(parse_read("GET", "/api/mobile/v1/messages", "?sessionId=s1").is_none());
    }

    #[test]
    fn fallback_only_answers_when_it_could() {
        let _guard = serial();
        let instance = "mirror-fallback";
        assert!(remember(
            instance,
            &payload(serde_json::json!([{ "hash": digest_of("dshc_live") }]))
        ));
        let good = Fallback::new(
            instance.to_string(),
            ListKind::Sessions,
            String::new(),
            Some("dshc_live".to_string()),
        );
        assert!(good.serve().is_some());
        // 凭据对不上、实例没见过：一样是「拿不出」，转发路径据此继续等宿主。
        let stranger = Fallback::new(
            instance.to_string(),
            ListKind::Sessions,
            String::new(),
            Some("dshc_other".to_string()),
        );
        assert!(stranger.serve().is_none());
        let unknown = Fallback::new(
            "mirror-never-pushed".to_string(),
            ListKind::Sessions,
            String::new(),
            Some("dshc_live".to_string()),
        );
        assert!(unknown.serve().is_none());
    }

    #[test]
    fn caps_instances_and_keeps_newest() {
        let _guard = serial();
        for index in 0..(MAX_INSTANCES + 4) {
            let instance = format!("mirror-cap-{index}");
            assert!(remember(
                &instance,
                &payload(serde_json::json!([{ "hash": digest_of("dshc_live") }]))
            ));
        }
        // 最早那份被淘汰，最新的还在。
        assert_eq!(lookup("mirror-cap-0", ListKind::Sessions, "", Some("dshc_live")), None);
        let newest = format!("mirror-cap-{}", MAX_INSTANCES + 3);
        assert!(lookup(&newest, ListKind::Sessions, "", Some("dshc_live")).is_some());
    }
}
