//! 宿主上报的插件版本，以及「最低可接受版本」这道门槛。
//!
//! 为什么中转要管这件事：插件升级得慢的机器会一直按老协议推东西（最贵的一档是每 5 秒
//! 整份镜像，见 A4-18 与 `DEBUG_SYNC_STATS`）。中转本身没法替宿主升级，能做的是两件：
//!
//!  1. **记下来**：每台实例报的是哪一版，`/status` 里给一个「多少台低于门槛」的数——
//!     这是决定门槛定在哪的唯一依据，比拍脑袋强。
//!  2. **拦**：`MIN_PLUGIN_VERSION` 配了值时，低于它的宿主在注册阶段就被挡下（默认空 = 不拦）。
//!
//! 三条口径，改之前先看：
//!  - **没报版本 = 未知 = 最旧**。老插件根本不知道有这个字段；反过来做（未知就放行）
//!    等于任何人只要不报就永远拦不住。
//!  - **只按三段数字比**，`0.4.7-beta.1` 这种尾巴取数字前缀。版本号本来就只允许三段。
//!  - **只在内存里记，且一小时内见过才算「线上」**：这台机器重启就空，宿主重连会重报；
//!    不落盘，不新增任何持有数据的面。
//!
//! 拦截时的日志按实例**一分钟一行**限流：门槛设下去那天所有老宿主会一起撞门，逐条记会把
//! 日志刷爆，而这条日志要看的是「有哪几台、报的是几版」，重复没有信息量。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// 超过这个时间没再上报，就不算「线上这台」（它已经掉线或换了实例 id）。
const KEEP_MS: u64 = 60 * 60 * 1000;
/// 记忆上限。公用中转一天见过五百多个实例，这个数留得下两天的滚动。
const MAX_INSTANCES: usize = 4096;
/// 同一台实例的拒绝日志最多一分钟一行。
const LOG_INTERVAL_MS: u64 = 60_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 插件版本：三段数字。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct PluginVersion {
    major: u64,
    minor: u64,
    patch: u64,
}

impl PluginVersion {
    /// 解析 `0.4.7` / `0.4.7-beta.1`；解析不出就是 `None`（按「未知」处理）。
    pub fn parse(text: &str) -> Option<Self> {
        let mut parts = text.trim().split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let rest = parts.next()?;
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        Some(Self {
            major,
            minor,
            patch: digits.parse().ok()?,
        })
    }

    pub fn as_string(self) -> String {
        self.to_string()
    }
}

impl std::fmt::Display for PluginVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Clone, Copy, Default)]
struct Seen {
    version: Option<PluginVersion>,
    at_ms: u64,
    last_log_ms: u64,
}

fn store() -> &'static Mutex<HashMap<String, Seen>> {
    static MAP: OnceLock<Mutex<HashMap<String, Seen>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 记一台实例上报的版本（`None` = 它没报，按最旧算）。
pub fn note(instance_id: &str, version: Option<PluginVersion>) {
    let key = instance_id.trim();
    if key.is_empty() {
        return;
    }
    let now = now_ms();
    let mut map = store().lock().unwrap_or_else(|e| e.into_inner());
    map.retain(|_, seen| now.saturating_sub(seen.at_ms) <= KEEP_MS);
    if !map.contains_key(key) && map.len() >= MAX_INSTANCES {
        // 满了先丢最旧的那台：这里只服务运维观测，丢一台的代价是统计少一，不是功能丢失。
        if let Some(oldest) = map.iter().min_by_key(|(_, seen)| seen.at_ms).map(|(k, _)| k.clone()) {
            map.remove(&oldest);
        }
    }
    let entry = map.entry(key.to_string()).or_default();
    entry.version = version;
    entry.at_ms = now;
}

/// 这台实例是不是低于门槛。没报版本也算「低于」（未知 = 最旧）。
pub fn outdated(instance_id: &str, min: PluginVersion) -> bool {
    let key = instance_id.trim();
    if key.is_empty() {
        return false;
    }
    let now = now_ms();
    let map = store().lock().unwrap_or_else(|e| e.into_inner());
    let Some(seen) = map.get(key) else { return false };
    if now.saturating_sub(seen.at_ms) > KEEP_MS {
        return false;
    }
    seen.version.map(|v| v < min).unwrap_or(true)
}

/// `/status` 用的汇总：(一小时内见过的实例数, 其中低于门槛的台数)。
pub fn summary(min: Option<PluginVersion>) -> (usize, usize) {
    let now = now_ms();
    let map = store().lock().unwrap_or_else(|e| e.into_inner());
    let mut total = 0;
    let mut old = 0;
    for seen in map.values() {
        if now.saturating_sub(seen.at_ms) > KEEP_MS {
            continue;
        }
        total += 1;
        if let Some(min) = min {
            if seen.version.map(|v| v < min).unwrap_or(true) {
                old += 1;
            }
        }
    }
    (total, old)
}

/// 同一台实例的拒绝日志限流：一分钟一行。
pub fn should_log(instance_id: &str) -> bool {
    let key = instance_id.trim();
    if key.is_empty() {
        return true;
    }
    let now = now_ms();
    let mut map = store().lock().unwrap_or_else(|e| e.into_inner());
    let entry = map.entry(key.to_string()).or_default();
    if now.saturating_sub(entry.last_log_ms) < LOG_INTERVAL_MS {
        return false;
    }
    entry.last_log_ms = now;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> PluginVersion {
        PluginVersion::parse(text).unwrap_or_else(|| panic!("解析不了 {text}"))
    }

    /// 镜像表与这本账都是进程级单例，用例并行会互相看见；串起来跑。
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn parses_three_segments_and_ignores_suffix() {
        assert_eq!(v("0.4.7").to_string(), "0.4.7");
        assert_eq!(v("0.4.7-beta.1").to_string(), "0.4.7");
        assert_eq!(v(" 12.0.3 ").to_string(), "12.0.3");
        assert!(PluginVersion::parse("0.4").is_none());
        assert!(PluginVersion::parse("").is_none());
        assert!(PluginVersion::parse("v0.4.7").is_none());
    }

    #[test]
    fn compares_numerically_not_lexically() {
        // "0.4.10" > "0.4.9"，按字符串比会反过来 —— 版本门槛最容易踩的坑。
        assert!(v("0.4.10") > v("0.4.9"));
        assert!(v("0.5.0") > v("0.4.99"));
        assert_eq!(v("1.0.0"), v("1.0.0"));
        assert!(v("0.4.7") < v("0.5.0"));
    }

    #[test]
    fn unknown_counts_as_oldest_only_when_threshold_is_set() {
        let _guard = serial();
        note("pv-unknown", None);
        note("pv-new", Some(v("0.5.1")));
        note("pv-old", Some(v("0.4.6")));
        assert!(outdated("pv-unknown", v("0.4.7")), "没报版本的要按最旧算，否则不报就永远拦不住");
        assert!(!outdated("pv-new", v("0.4.7")));
        assert!(outdated("pv-old", v("0.4.7")));
        // 门槛空着（None）时 summary 只报总数、不报旧版本数。
        let (total, old) = summary(Some(v("0.4.7")));
        assert!(total >= 3, "一小时内见过的都要算进来，实际 {total}");
        assert!(old >= 2, "未知 + 0.4.6 至少两台，实际 {old}");
        let (_, none_old) = summary(None);
        assert_eq!(none_old, 0, "没配门槛时不该有「太旧」这个概念");
    }

    #[test]
    fn reject_log_is_rate_limited_per_instance() {
        let _guard = serial();
        assert!(should_log("pv-log"), "第一次要记");
        assert!(!should_log("pv-log"), "一分钟内的第二次不记");
        assert!(should_log("pv-log-other"), "别的实例不受影响");
    }
}
