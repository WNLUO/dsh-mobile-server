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
//!     手机带来的凭据（`X-Dsh-Device-Credential` 或 `Authorization` 的 Bearer 原文）算
//!     一遍哈希去对，任一处命中即可，不看凭据形状。中转看不到凭据原文，也没有自己的
//!     账号体系；对不上就什么都不给，退回今天那句 503（不新增错误面，老客户端行为一个
//!     字不变）。
//!   - **老插件不供缓存**。没收到摘要（字段缺席 = 那时候还没有这回事）时宁可什么都不给，
//!     也不要把「谁都能读」当默认。
//!   - **不落盘**。进程重启就没了；宿主那边隧道一连上就会全量重推一份，几秒内自己长回来。
//!
//! 存的是宿主给的那份 body 原文，读的时候才注入 `stale`。这样常驻内存只有一份文本，
//! 而「谁在看」这条冷路径上多一次解析换来的开销可以忽略。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// 同时记多少台实例的镜像。
///
/// 16 是按「一台机器一个实例」的老口径定的。公用中转上一百多台宿主同时在线时，16 个
/// 位置每插一台就挤掉最旧那台，于是每台每 5 秒推上来的那帧都被当成「第一次落地」：
/// 日志每帧一行（一台机器一天两百万行），缓存和凭据摘要随时被挤掉——宿主掉线后手机读
/// 不到兜底，推令牌上报也核不过。512 覆盖公用中转的实际规模，内存由下面的总字节预算兜。
///
/// 2026-10-27 美国那台实测：一天之内见过 **512 个不同实例**，正好把 512 个位置占满，
/// 每来一台新的就挤掉最旧的那台。位置不够的原因不是机器多，而是**离线的机器不会自己
/// 让位**（过期只在读缓存时比对，没人来读就一直躺着）。所以两条一起改：闲置清理
/// （`ENTRY_IDLE_MS`）负责让位，上限抬到 4096 负责余量。单份按现在的量级只有 9KB 上下，
/// 4096 份约 40MB，仍在下面的自适应预算之内。
const MAX_INSTANCES: usize = 4096;
/// 整本账总字节预算的上下限。**实际值在第一次用到时按这台机器的可用内存算出来**
/// （见 `total_bytes_budget`）：公网上这些中转从 960MB 的小机器到几 G 的都有，写死一个
/// 数要么把小机器吃光、要么把大机器白限死。超了就从最旧的那份开始淘汰，刚推上来的永远留。
const MIN_TOTAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 256 * 1024 * 1024;
/// 预算取可用内存的这个分数。
const TOTAL_BYTES_SHARE: usize = 16;
/// 单份镜像（会话清单 + 工作区两份 body）的字节上限。
///
/// 4MB 而不是 3MB：宿主把业务正文封进信封之后，base64 让同样的内容大 4/3。上限卡在
/// 3MB，本来装得下的清单会提前退化成「这份镜像存不下」，宿主离线时手机就什么都看不到
/// ——那不是省内存，是把这条兜底功能关掉一半。
const MAX_ENTRY_BYTES: usize = 4 * 1024 * 1024;
/// 一次 sync 帧的字节上限。超过就不收、保留上一份——畸形或超大的帧不该把好镜像顶掉。
///
/// 跟着条目上限一起放宽：一帧里装的是两份封过信封的 body 加上其余字段，12MB 的余量在
/// 条目上限抬到 4MB 之后会先于条目上限触发，等于上限白抬。
const MAX_SYNC_BYTES: usize = 16 * 1024 * 1024;
/// 一份镜像空闲多久就该清掉。
///
/// 宿主在线时每 500ms 推一帧，这个时间戳一直在刷新，所以在线的永远不会被清。反过来，
/// 它也是「电脑关机以后手机还能看到上次那份列表」的时长：超过它，打开 App 只剩「那台
/// 不在线」。六小时是按「够覆盖一次关机/休眠，又不至于让离线的机器把位置占满」定的。
const ENTRY_IDLE_MS: u64 = 6 * 3600 * 1000;
/// 两次清扫之间至少隔这么久。清扫本身只有几百个 key、只比时间戳，但要跟着每次推送跑
/// 就变成每秒几百次全表扫描，节流到一分钟一次足够。
const SWEEP_INTERVAL_MS: u64 = 60_000;
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

/// 这台机器给镜像账本多少预算：可用内存的 1/16，夹在 32MB ~ 256MB 之间。
///
/// 第一次用到时算一次就定住——镜像常驻内存，中途按当前可用内存浮动会让预算忽大忽小，
/// 淘汰就变成随机。取不到（非 Linux）就用下限，宁可保守。
fn total_bytes_budget() -> usize {
    static BUDGET: OnceLock<usize> = OnceLock::new();
    *BUDGET.get_or_init(|| budget_for(available_memory_bytes()))
}

fn budget_for(available: Option<usize>) -> usize {
    available
        .map(|bytes| (bytes / TOTAL_BYTES_SHARE).clamp(MIN_TOTAL_BYTES, MAX_TOTAL_BYTES))
        .unwrap_or(MIN_TOTAL_BYTES)
}

/// `/proc/meminfo` 的 `MemAvailable`（字节）。读不到就 None。
///
/// 用它而不是 `MemFree`：后者不含可回收的 page cache，会把这台实际能腾出来的内存算小
/// 一个量级（美国那台 `free` 里 free 只有 270MB、available 有 577MB）。
fn available_memory_bytes() -> Option<usize> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("MemAvailable:") {
            let kb: usize = rest.split_whitespace().next()?.parse().ok()?;
            return Some(kb.saturating_mul(1024));
        }
    }
    None
}

/// 账本现在的规模，给 `/status` 用。**不暴露实例 id 与设备**，只有数量。
pub struct Stats {
    pub instances: usize,
    pub bytes: usize,
    pub budget: usize,
}

pub fn stats() -> Stats {
    let map = store().lock().unwrap_or_else(|e| e.into_inner());
    Stats {
        instances: map.len(),
        bytes: total_bytes(&map),
        budget: total_bytes_budget(),
    }
}

/// 宿主推上来的镜像帧（隧道帧 `sync`）。收到就整份替换，格式不对就**保留上一份**。
pub fn remember(instance_id: &str, payload: &[u8]) -> bool {
    remember_with(instance_id, payload, crate::config().mirror_cache)
}

/// `keep_bodies = false` 时只留凭据摘要与时间戳，不留两份清单正文。
///
/// 纯转发的部署（`MIRROR_CACHE=0`）本来就不提供离线兜底，正文存进来一次都不会被读到，
/// 却要跟着每次推送解析、序列化、占内存。**摘要不能一起丢**：推送令牌上报（`/push-token`）
/// 的鉴权判据就是这本账里的摘要，丢了它，那台机器上报的令牌全变成 403。
fn remember_with(instance_id: &str, payload: &[u8], keep_bodies: bool) -> bool {
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
    let (sessions_body, workspaces_body) = if keep_bodies {
        let (Ok(sessions_body), Ok(workspaces_body)) =
            (serde_json::to_string(sessions), serde_json::to_string(workspaces))
        else {
            return false;
        };
        if sessions_body.len() + workspaces_body.len() > MAX_ENTRY_BYTES {
            return false;
        }
        (sessions_body, workspaces_body)
    } else {
        (String::new(), String::new())
    };
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
    // 先让离线的让位，再看台数：顺序反过来就是「先挤掉一台在线的，再去删一台早该走的」。
    sweep_idle(&mut map, entry.stored_at_ms);
    let previous_creds = map.get(key).map(|entry| entry.creds.len());
    if !map.contains_key(key) && map.len() >= MAX_INSTANCES {
        evict_oldest(&mut map);
    }
    let (sessions_bytes, workspaces_bytes) = (entry.sessions.len(), entry.workspaces.len());
    let creds_count = entry.creds.len();
    map.insert(key.to_string(), entry);
    // 台数管住之后还要管住总量：大清单 × 多实例会先把内存吃满，再轮到台数上限。
    // 淘汰的永远是最旧的那份，刚插进来的这份 seq 最大、轮不到它。
    prune_to_budget(&mut map, total_bytes_budget());
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

/// 一份镜像占多少字节。粗算即可：口径只需要在几份同量级的镜像之间分得出新旧，
/// 不计字段名与结构体本身的开销。
fn entry_bytes(key: &str, entry: &MirrorEntry) -> usize {
    key.len()
        + entry.sessions.len()
        + entry.workspaces.len()
        + entry.creds.iter().map(|(hash, _)| hash.len()).sum::<usize>()
}

fn total_bytes(map: &HashMap<String, MirrorEntry>) -> usize {
    map.iter()
        .map(|(key, entry)| entry_bytes(key, entry))
        .sum()
}

/// 淘汰最旧的那一份。新旧按「落地时刻 + 落地顺序」排：只按毫秒排的话，同一毫秒里
/// 推上来的几份会变成「随便挑一份」。
fn evict_oldest(map: &mut HashMap<String, MirrorEntry>) {
    let oldest = map
        .iter()
        .min_by_key(|(_, entry)| (entry.stored_at_ms, entry.stored_seq))
        .map(|(instance, _)| instance.clone());
    if let Some(instance) = oldest {
        map.remove(&instance);
    }
}

/// 总量超预算就从头淘汰，直到装得下。留一份是给「单份自己就超预算」兜底：
/// 淘汰到最后只剩刚推上来的这份，至少不会把最新的镜像也扔掉。
fn prune_to_budget(map: &mut HashMap<String, MirrorEntry>, max_bytes: usize) {
    while map.len() > 1 && total_bytes(map) > max_bytes {
        evict_oldest(map);
    }
}

/// 清掉空闲超过 `ENTRY_IDLE_MS` 的条目。返回删了几条。
fn sweep_idle_entries(map: &mut HashMap<String, MirrorEntry>, now: u64) -> usize {
    let before = map.len();
    map.retain(|_, entry| now.saturating_sub(entry.stored_at_ms) <= ENTRY_IDLE_MS);
    before - map.len()
}

/// 带节流的清扫：粘在每次推送的路径上，但最多一分钟做一次真正的全表扫描。
///
/// 不节流的话，156 台宿主每台每 500ms 一帧就是每秒三百次全表扫描，白白吃这一核。
fn sweep_idle(map: &mut HashMap<String, MirrorEntry>, now: u64) {
    static LAST_SWEEP_MS: AtomicU64 = AtomicU64::new(0);
    let last = LAST_SWEEP_MS.load(Ordering::Relaxed);
    if last != 0 && now.saturating_sub(last) < SWEEP_INTERVAL_MS {
        return;
    }
    LAST_SWEEP_MS.store(now, Ordering::Relaxed);
    let removed = sweep_idle_entries(map, now);
    if removed > 0 {
        crate::tunnel::log(format!("mirror swept idle={removed} left={}", map.len()));
    }
}

/// 读缓存：给不出去就 None，调用方照旧走「那台宿主不在线」。
///
/// `rev` 是手机带来的内容指纹：与缓存里那份相同就只回一句 unchanged（几十字节），
/// 省掉一整份清单的传输。
pub fn lookup(
    instance_id: &str,
    kind: ListKind,
    rev: &str,
    credentials: &[String],
) -> Option<String> {
    let now = now_ms();
    // 出锁只带走要用的那几段：不掐着全局锁做 JSON 解析。
    let (body, revision, generated_at, creds) = {
        let map = store().lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.get(instance_id.trim())?;
        if now.saturating_sub(entry.stored_at_ms) > ENTRY_IDLE_MS {
            return None;
        }
        let (body, revision, generated_at) = entry.body_of(kind);
        // 纯转发部署只记摘要不记正文（`remember_with(.., false)`）：没有正文就是没有
        // 这份缓存，别拿一份空壳去拼 `unchanged` 或半份 JSON。
        if body.is_empty() {
            return None;
        }
        (
            body.to_string(),
            revision.to_string(),
            generated_at,
            entry.creds.clone(),
        )
    };
    if !creds_allow(&creds, credentials, now as i64) {
        return None;
    }
    if !rev.is_empty() && rev == revision {
        // `stale` 必须跟着一起回：这句话是**缓存**在说「你手上那份和我这份一样」，
        // 不是宿主在说。漏了它，手机收到的就是一句普通的「没变」，既不显示缓存
        // 标记、也不知道自己正停在一份旧清单上（宿主重启后那几分钟就是这个形状）。
        let unchanged = serde_json::json!({
            "ok": true,
            "unchanged": true,
            "revision": revision,
            "generatedAt": generated_at,
            "stale": true,
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

/// 这台实例当前这份摘要清单能不能放行这次出示的凭据。推送令牌上报（`http.rs` 的
/// `/api/mobile/v1/push-token`）与镜像读用同一个判据，别另写一份校验。
pub(crate) fn credential_ok(instance_id: &str, credentials: &[String]) -> bool {
    let now = now_ms();
    let creds = {
        let map = store().lock().unwrap_or_else(|e| e.into_inner());
        match map.get(instance_id.trim()) {
            Some(entry) if now.saturating_sub(entry.stored_at_ms) <= ENTRY_IDLE_MS => entry.creds.clone(),
            _ => Vec::new(),
        }
    };
    creds_allow(&creds, credentials, now as i64)
}

/// 这些出示的凭据里有没有一个能读缓存。`creds` 为空（老插件还没推摘要）一律不放行。
///
/// 逐个按 `credentials` 的顺序试，第一个命中就放行——调用方把
/// `X-Dsh-Device-Credential` 排在 `Authorization` 的 Bearer 前面，所以是「header 先算、
/// 未命中再算 Bearer」。**只看原文的 sha256，不看前缀、不看形状**：每设备凭据本身就是
/// 一段任意 Bearer（`<instanceId>.<exp>.<random>`），按 `dshc_` 筛会把新配对之后的镜像
/// 读整片挡住；旧 HMAC token 的哈希不在宿主推上来的表里，本来就会被这条判据拒掉。
///
/// 推送令牌上报那条自有路径（`http.rs`）用同一个判据：同一套摘要、同一个「空摘要
/// 不放行」的口径，别为它另写一份校验。
pub(crate) fn creds_allow(creds: &[(String, i64)], credentials: &[String], now_ms: i64) -> bool {
    if creds.is_empty() || credentials.is_empty() {
        return false;
    }
    for raw in credentials {
        let digest = sha256_hex(raw);
        let hit = creds
            .iter()
            .any(|(hash, expires_at)| (*expires_at == 0 || *expires_at > now_ms) && *hash == digest);
        if hit {
            return true;
        }
    }
    false
}

/// 凭据原文的 sha256（小写十六进制）。与宿主推上来的摘要同一个算法、同一种写法。
fn sha256_hex(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
    credentials: Vec<String>,
}

impl Fallback {
    pub fn new(instance: String, kind: ListKind, rev: String, credentials: Vec<String>) -> Self {
        Self { instance, kind, rev, credentials }
    }

    /// 现在能拿得出东西吗。拿不出（凭据对不上、没这份清单）就当没备过。
    pub fn serve(&self) -> Option<String> {
        lookup(&self.instance, self.kind, &self.rev, &self.credentials)
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

    /// 一次请求可能同时带 `X-Dsh-Device-Credential` 与 Bearer 两份凭据，判据拿到的是
    /// 一个有序列表（header 在前），所以断言也按列表写。
    fn presented(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
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
            &payload(serde_json::json!([{ "hash": sha256_hex("cred_live") }]))
        ));
        let body = lookup(instance, ListKind::Sessions, "", &presented(&["cred_live"])).expect("cached body");
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["stale"], serde_json::json!(true));
        assert_eq!(parsed["revision"], serde_json::json!("aaa"));
        assert_eq!(parsed["items"].as_array().unwrap().len(), 1);
    }

    /// 信封的外层（`env`）中转不认识，但必须原样存、原样回。
    ///
    /// 手机端先看外层有没有 `env`，有就解出来再和内层合并。中转在这中间要做一次
    /// `Value` 的反序列化与再序列化，任何外层字段被丢掉，手机就永远解不出正文——宿主
    /// 离线时更只剩这一份。这条用例钉的是「多出来的外层字段保住」，不是业务语义。
    #[test]
    fn keeps_unknown_outer_fields_such_as_the_envelope() {
        let _guard = serial();
        let instance = "mirror-env";
        let frame = serde_json::json!({
            "kind": "sync",
            "sessions": {
                "ok": true,
                "revision": "aaa",
                "generatedAt": 111,
                "env": { "v": 2, "z": 0, "n": "bm9uY2U", "c": "Y2lwaGVy" },
            },
            "workspaces": {
                "ok": true,
                "revision": "bbb",
                "generatedAt": 222,
                "env": { "v": 2, "z": 0, "n": "bm9uY2Uy", "c": "Y2lwaGVyMg" },
            },
            "creds": [{ "hash": sha256_hex("cred_env") }],
        })
        .to_string()
        .into_bytes();
        assert!(remember(instance, &frame));

        let body = lookup(instance, ListKind::Sessions, "", &presented(&["cred_env"]))
            .expect("cached body");
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            parsed["env"],
            serde_json::json!({ "v": 2, "z": 0, "n": "bm9uY2U", "c": "Y2lwaGVy" }),
            "信封外层必须原样回，丢了手机就解不出正文"
        );
        // 镜像自己读的那几个外层键与注入的 `stale` 同时还在。
        assert_eq!(parsed["ok"], serde_json::json!(true));
        assert_eq!(parsed["revision"], serde_json::json!("aaa"));
        assert_eq!(parsed["stale"], serde_json::json!(true));
    }

    #[test]
    fn serves_to_any_credential_whose_digest_is_known() {
        let _guard = serial();
        let instance = "mirror-cred";
        // T1 形状：每设备凭据本身就是一段 Bearer，没有 `dshc_` 那种前缀。
        let t1 = "99d9d3ee.1800000000.bG9jYWwtcmFuZG9t";
        assert!(remember(
            instance,
            &payload(serde_json::json!([{ "hash": sha256_hex(t1) }]))
        ));
        // 哈希在表里就认，不看形状。
        assert!(lookup(instance, ListKind::Sessions, "", &presented(&[t1])).is_some());
        // header 那份对不上、Bearer 那份对上：一样放行（header 先算，未命中再算 Bearer）。
        assert!(
            lookup(instance, ListKind::Sessions, "", &presented(&["stale-header", t1])).is_some()
        );
        // 别台设备的凭据、摘要表外的任意串、没带凭据都不认。
        assert_eq!(lookup(instance, ListKind::Sessions, "", &presented(&["cred_other"])), None);
        assert_eq!(lookup(instance, ListKind::Sessions, "", &presented(&["Bearer x"])), None);
        assert_eq!(lookup(instance, ListKind::Sessions, "", &[]), None);
    }

    /// 摘要表为空 = 老插件还没推摘要。这时候「谁都能读」不能当默认。
    #[test]
    fn an_empty_digest_table_lets_nobody_in() {
        let empty: Vec<(String, i64)> = Vec::new();
        assert!(!creds_allow(&empty, &presented(&["99d9d3ee.1.abc"]), 1));
        let known = vec![(sha256_hex("99d9d3ee.1.abc"), 0)];
        assert!(creds_allow(&known, &presented(&["99d9d3ee.1.abc"]), 1));
    }

    #[test]
    fn old_plugins_without_creds_get_nothing() {
        let _guard = serial();
        let instance = "mirror-nocreds";
        assert!(remember(instance, &payload(serde_json::json!([]))));
        assert_eq!(lookup(instance, ListKind::Sessions, "", &presented(&["cred_live"])), None);
        // 连字段都不带的那一版同样不给。
        assert!(remember(instance, &payload(serde_json::Value::Null)));
        assert_eq!(lookup(instance, ListKind::Sessions, "", &presented(&["cred_live"])), None);
    }

    #[test]
    fn honours_credential_expiry() {
        let _guard = serial();
        let instance = "mirror-expiry";
        assert!(remember(
            instance,
            &payload(serde_json::json!([{ "hash": sha256_hex("cred_old"), "expiresAt": 1 }]))
        ));
        assert_eq!(lookup(instance, ListKind::Sessions, "", &presented(&["cred_old"])), None);
    }

    #[test]
    fn unchanged_answers_with_the_cached_revision() {
        let _guard = serial();
        let instance = "mirror-rev";
        assert!(remember(
            instance,
            &payload(serde_json::json!([{ "hash": sha256_hex("cred_one") }]))
        ));
        let body = lookup(instance, ListKind::Workspaces, "bbb", &presented(&["cred_one"])).expect("unchanged");
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["unchanged"], serde_json::json!(true));
        assert_eq!(parsed["revision"], serde_json::json!("bbb"));
        assert_eq!(parsed["generatedAt"], serde_json::json!(222));
        // 「一样」这句是**缓存**说的，必须跟着标旧：漏了它，手机就不知道自己在看缓存，
        // 宿主重启后那几分钟里侧栏安静地停在旧清单上（真机就是这个形状）。
        assert_eq!(parsed["stale"], serde_json::json!(true), "缓存答 unchanged 时也必须标旧");
        // 指纹对不上就回整份。
        let full = lookup(instance, ListKind::Workspaces, "zzz", &presented(&["cred_one"])).unwrap();
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
        assert_eq!(lookup(instance, ListKind::Sessions, "", &presented(&["cred_any"])), None);
    }

    #[test]
    fn a_bad_push_keeps_the_previous_good_copy() {
        let _guard = serial();
        let instance = "mirror-keep-good";
        assert!(remember(
            instance,
            &payload(serde_json::json!([{ "hash": sha256_hex("cred_live") }]))
        ));
        assert!(!remember(
            instance,
            serde_json::json!({ "kind": "sync", "sessions": { "ok": false } })
                .to_string()
                .as_bytes()
        ));
        let body = lookup(instance, ListKind::Sessions, "", &presented(&["cred_live"])).expect("still there");
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
            &payload(serde_json::json!([{ "hash": sha256_hex("cred_live") }]))
        ));
        let good = Fallback::new(
            instance.to_string(),
            ListKind::Sessions,
            String::new(),
            presented(&["cred_live"]),
        );
        assert!(good.serve().is_some());
        // 凭据对不上、实例没见过：一样是「拿不出」，转发路径据此继续等宿主。
        let stranger = Fallback::new(
            instance.to_string(),
            ListKind::Sessions,
            String::new(),
            presented(&["cred_other"]),
        );
        assert!(stranger.serve().is_none());
        let unknown = Fallback::new(
            "mirror-never-pushed".to_string(),
            ListKind::Sessions,
            String::new(),
            presented(&["cred_live"]),
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
                &payload(serde_json::json!([{ "hash": sha256_hex("cred_live") }]))
            ));
        }
        // 最早那份被淘汰，最新的还在。
        assert_eq!(lookup("mirror-cap-0", ListKind::Sessions, "", &presented(&["cred_live"])), None);
        let newest = format!("mirror-cap-{}", MAX_INSTANCES + 3);
        assert!(lookup(&newest, ListKind::Sessions, "", &presented(&["cred_live"])).is_some());
    }

    /// 公用中转上一百多台宿主同时在线时，每台那份都要留得住。
    ///
    /// 2026-10-27 实测：美国那台 124 台在线，上限 16 的账本每插一台就挤掉最旧那台，
    /// 于是每台每 5 秒推上来的那帧都被当成「第一次落地」——一天两百万行日志，而且
    /// 兜底缓存与推送令牌的凭据核对随时失效。这条按公用规模插一遍、逐台读回来，
    /// 谁把上限调回单机口径就红。
    #[test]
    fn a_busy_public_relay_keeps_every_instance() {
        let _guard = serial();
        assert!(MAX_INSTANCES >= 256, "公用中转的实例规模远超「一台机器一个实例」的口径");
        let count = 200usize;
        for index in 0..count {
            let instance = format!("mirror-public-{index}");
            assert!(remember(
                &instance,
                &payload(serde_json::json!([{ "hash": sha256_hex("cred_live") }]))
            ));
        }
        for index in 0..count {
            let instance = format!("mirror-public-{index}");
            assert!(
                lookup(&instance, ListKind::Sessions, "", &presented(&["cred_live"])).is_some(),
                "{instance} 被别的实例挤掉了"
            );
        }
    }

    /// 只按台数卡不够：512 台 × 单份 4MB 能把小机器吃光，所以总量还要有预算。
    fn fake_entry(bytes: usize, seq: u64) -> MirrorEntry {
        MirrorEntry {
            sessions: "s".repeat(bytes),
            workspaces: String::new(),
            sessions_revision: String::new(),
            workspaces_revision: String::new(),
            sessions_generated_at: 0,
            workspaces_generated_at: 0,
            creds: Vec::new(),
            stored_at_ms: seq,
            stored_seq: seq,
        }
    }

    #[test]
    fn a_byte_budget_prunes_the_oldest() {
        let mut map: HashMap<String, MirrorEntry> = HashMap::new();
        for seq in 0..8u64 {
            map.insert(format!("m{seq}"), fake_entry(1000, seq));
        }
        prune_to_budget(&mut map, 3000);
        assert!(total_bytes(&map) <= 3000, "淘汰之后总量必须落在预算内");
        assert!(map.contains_key("m7"), "刚推上来的那份不能被扔");
        assert!(!map.contains_key("m0"), "淘汰从最旧的开始");
        // 单份自己就超预算时也要留一份，至少别把最新的镜像也扔掉。
        let mut single: HashMap<String, MirrorEntry> = HashMap::new();
        single.insert("big".to_string(), fake_entry(5000, 1));
        prune_to_budget(&mut single, 1000);
        assert_eq!(single.len(), 1);
    }

    /// 闲置清理：超过六小时没新推送的条目必须让位，在线的（时间戳一直被刷新）不受影响。
    #[test]
    fn idle_entries_get_swept_after_six_hours() {
        let now = 100_000_000u64;
        let mut map: HashMap<String, MirrorEntry> = HashMap::new();
        let mut fresh = fake_entry(10, 2);
        fresh.stored_at_ms = now - 1_000;
        let mut stale = fake_entry(10, 1);
        stale.stored_at_ms = now - ENTRY_IDLE_MS - 1;
        map.insert("fresh".to_string(), fresh);
        map.insert("stale".to_string(), stale);
        assert_eq!(sweep_idle_entries(&mut map, now), 1);
        assert!(map.contains_key("fresh"), "在线的不能被清");
        assert!(!map.contains_key("stale"), "闲置超过六小时的必须让位");
        // 边界：正好六小时那份还算「刚用过」，不算闲置。
        let mut edge: HashMap<String, MirrorEntry> = HashMap::new();
        let mut boundary = fake_entry(10, 1);
        boundary.stored_at_ms = now - ENTRY_IDLE_MS;
        edge.insert("edge".to_string(), boundary);
        assert_eq!(sweep_idle_entries(&mut edge, now), 0);
    }

    /// 预算跟着这台机器的内存走，而不是写死一个数：小机器不被吃光，大机器不被白限死。
    #[test]
    fn the_byte_budget_follows_available_memory() {
        // 读不到 MemAvailable（非 Linux）时退回下限，宁可保守。
        assert_eq!(budget_for(None), MIN_TOTAL_BYTES);
        // 1GB / 16 = 64MB，落在区间中间，跟着内存走。
        assert_eq!(budget_for(Some(1024 * 1024 * 1024)), 64 * 1024 * 1024);
        // 960MB 那台（可用 577MB）算下来约 36MB：比旧的写死 64MB 小，比下限大。
        let small = budget_for(Some(577 * 1024 * 1024));
        assert!(small > MIN_TOTAL_BYTES && small < 64 * 1024 * 1024, "{small}");
        // 大机器封顶，不让一份账本吃掉几 G。
        assert_eq!(budget_for(Some(64 * 1024 * 1024 * 1024)), MAX_TOTAL_BYTES);
        assert!(MIN_TOTAL_BYTES >= 32 * 1024 * 1024, "下限不许回退到「几十台就满」的口径");
    }

    /// 纯转发部署（`MIRROR_CACHE=0`）只留摘要：正文一个字节都不存，但摘要还得在。
    #[test]
    fn a_forward_only_relay_keeps_only_the_digests() {
        let _guard = serial();
        let instance = "mirror-creds-only";
        let cred = "cred_only";
        assert!(remember_with(
            instance,
            &payload(serde_json::json!([{ "hash": sha256_hex(cred) }])),
            false
        ));
        assert_eq!(
            lookup(instance, ListKind::Sessions, "", &presented(&[cred])),
            None,
            "纯转发不该留正文，缓存读也一个字节都不给"
        );
        assert!(
            credential_ok(instance, &presented(&[cred])),
            "摘要必须留着：推送令牌上报靠它鉴权"
        );
        // 这台改成开机镜像之后，下一帧就把正文补上（切配置不用重启中转）。
        assert!(remember_with(
            instance,
            &payload(serde_json::json!([{ "hash": sha256_hex(cred) }])),
            true
        ));
        assert!(lookup(instance, ListKind::Sessions, "", &presented(&[cred])).is_some());
    }
}
