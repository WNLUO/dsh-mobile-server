//! 实例迁移台账：宿主换中转之前，在旧中转上留一条「我搬到 X 了」。
//!
//! 换中转的现实形状是「电脑换了地址，手机还拿着旧地址」。旧中转上没有这台实例，过去
//! 只会回一句「那台宿主不在线」——手机因此永远学不到新地址，除非人重新扫码。宿主在
//! 断开旧隧道之前推一帧 `migrate`（`{to, at}`），旧中转把它记下来；之后凡是找这个实例
//! 的请求（HTTP 与手机 WS 桥接）一律回 503 + `x-dsh-migrated-to`，手机据此自己切过去。
//!
//! 三条边界：
//!   - **只按实例 id 记账、不落盘**。进程重启就空；这条记录本来只是一次性的指路牌，
//!     宿主在新中转上连回来之后，手机也不会再来问旧地址。
//!   - **`to` 为空串就是撤销**。宿主搬回来、或者发现新地址不可用时会先撤掉，免得手机
//!     被一直往一个死地址上引。
//!   - **TTL 按中转自己的落地时刻算**，不看宿主自报的 `at`：那是信息性字段，一台时钟
//!     不准的机器不该决定这条记录什么时候失效。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// 一条迁移记录保留多久。
///
/// 30 天：手机可能几周没打开，而这条记录只是一句「那台搬走了」。放得再久就成了幽灵，
/// 会拿一个早就换掉的地址继续误导客户端。
const ENTRY_TTL_MS: u64 = 30 * 24 * 3600 * 1000;

struct Record {
    /// 新中转地址，宿主给的原样字符串。
    to: String,
    /// 落到这条中转上的时刻；TTL 按它算。
    ///
    /// 宿主自报的 `at` 只进注册那一刻的日志：那是宿主机器的钟，一台时间不准的机器
    /// 不该决定这条记录什么时候失效。
    stored_at_ms: u64,
}

fn store() -> &'static Mutex<HashMap<String, Record>> {
    static STORE: OnceLock<Mutex<HashMap<String, Record>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 收到宿主推来的 `migrate` 帧。成功（含撤销）返回 true。
///
/// `instance_id` 必须是**这条隧道自己登的那个**：payload 里没有「替谁登记」这个字段，
/// 一条隧道因此结构上替不了别家登记。没自报家门的隧道记不了任何东西。
pub fn remember(instance_id: &str, payload: &[u8]) -> bool {
    let key = instance_id.trim();
    if key.is_empty() {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return false;
    };
    let Some(to) = value.get("to").and_then(|v| v.as_str()) else {
        return false;
    };
    let to = to.trim();
    let at = value.get("at").and_then(|v| v.as_i64()).unwrap_or(0);
    let mut map = store().lock().unwrap_or_else(|e| e.into_inner());
    if to.is_empty() {
        let removed = map.remove(key).is_some();
        crate::tunnel::log(format!("migration cleared instance={key} (had={removed})"));
        return true;
    }
    // 这个地址要原样进响应头（`x-dsh-migrated-to`）。带控制字符的值会把一条 503 写成
    // 两半，这是这条记录唯一真实的坏形状——挡掉，不是给它加信封。
    if to.chars().any(|c| c.is_control()) {
        return false;
    }
    // 同一实例重复登记以最新一条为准：宿主可能改了两次地址。
    map.insert(
        key.to_string(),
        Record {
            to: to.to_string(),
            stored_at_ms: now_ms(),
        },
    );
    crate::tunnel::log(format!(
        "migration registered instance={key} to={to} at={at} ttl_days=30"
    ));
    true
}

/// 这台实例的迁移记录（未过期才有）。`None` 就是「没搬过」。
pub fn lookup(instance_id: &str) -> Option<String> {
    let key = instance_id.trim();
    if key.is_empty() {
        return None;
    }
    let now = now_ms();
    let mut map = store().lock().unwrap_or_else(|e| e.into_inner());
    let record = map.get(key)?;
    if now.saturating_sub(record.stored_at_ms) > ENTRY_TTL_MS {
        // 顺手清掉：过期记录留着没有任何用处，还会让下一次查找继续走这条分支。
        map.remove(key);
        return None;
    }
    Some(record.to.clone())
}

/// 这台实例搬走了：给手机的 503 响应体与响应头值。没记录就 `None`。
///
/// 两个值一起返回，是因为它们必须说同一件事，分开算容易只改一处。body 的字段顺序就是
/// 契约里的那一行，别换成 `serde_json::json!`（那种写法按字母序排，读起来对不上文档）。
pub fn migrated_response(instance_id: &str) -> Option<(String, String)> {
    let to = lookup(instance_id)?;
    let quoted = serde_json::to_string(&to).unwrap_or_else(|_| "\"\"".to_string());
    let body = format!(
        r#"{{"ok":false,"code":"migrated","to":{quoted},"error":"that host moved to another relay"}}"#
    );
    Some((body, to))
}

/// 迁移表是进程级单例：用例并行跑时会互相看见对方的记录，断言就成了测时序。
#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(to: &str, at: i64) -> Vec<u8> {
        serde_json::json!({ "to": to, "at": at }).to_string().into_bytes()
    }

    #[test]
    fn registered_migration_is_returned_as_503_with_header() {
        let _guard = test_lock();
        assert!(remember("mig-inst-1", &frame("https://new.example.com", 1_700_000_000_000)));
        assert_eq!(lookup("mig-inst-1"), Some("https://new.example.com".to_string()));

        let (body, to) = migrated_response("mig-inst-1").expect("有记录就要给 503 指路");
        assert_eq!(to, "https://new.example.com");
        assert_eq!(
            body,
            r#"{"ok":false,"code":"migrated","to":"https://new.example.com","error":"that host moved to another relay"}"#
        );
        // 响应体必须是合法 JSON（手机按 JSON 读 code/to）。
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["code"], serde_json::json!("migrated"));
    }

    #[test]
    fn unknown_instance_has_no_record() {
        let _guard = test_lock();
        assert_eq!(lookup("mig-inst-none"), None);
        assert!(migrated_response("mig-inst-none").is_none());
        // 空实例 id 记不了、也查不到：键就是实例自己。
        assert!(!remember("   ", &frame("https://new.example.com", 1)));
        assert_eq!(lookup(""), None);
    }

    #[test]
    fn empty_to_clears_the_record() {
        let _guard = test_lock();
        assert!(remember("mig-inst-clear", &frame("https://new.example.com", 1)));
        assert!(remember("mig-inst-clear", &frame("", 2)), "撤销也算成功");
        assert_eq!(lookup("mig-inst-clear"), None);
        assert!(migrated_response("mig-inst-clear").is_none());
        // 撤销一条本来就没有的记录不算失败。
        assert!(remember("mig-inst-clear", &frame("", 3)));
    }

    #[test]
    fn newer_registration_wins() {
        let _guard = test_lock();
        assert!(remember("mig-inst-twice", &frame("https://first.example.com", 1)));
        assert!(remember("mig-inst-twice", &frame("https://second.example.com", 2)));
        assert_eq!(lookup("mig-inst-twice"), Some("https://second.example.com".to_string()));
    }

    #[test]
    fn expired_record_is_gone() {
        let _guard = test_lock();
        assert!(remember("mig-inst-old", &frame("https://new.example.com", 1)));
        // 把落地时刻往回拨到 TTL 之外：过期即失效，查找还要顺手把它删掉。
        {
            let mut map = store().lock().unwrap_or_else(|e| e.into_inner());
            let record = map.get_mut("mig-inst-old").expect("刚登记的");
            record.stored_at_ms = now_ms() - ENTRY_TTL_MS - 1;
        }
        assert_eq!(lookup("mig-inst-old"), None);
        assert!(
            !store().lock().unwrap_or_else(|e| e.into_inner()).contains_key("mig-inst-old"),
            "过期记录不该留在表里"
        );
    }

    #[test]
    fn malformed_frames_are_ignored() {
        let _guard = test_lock();
        for payload in [
            b"not json".to_vec(),
            br#"{"at":1}"#.to_vec(),
            br#"{"to":42}"#.to_vec(),
        ] {
            assert!(!remember("mig-inst-bad", &payload));
        }
        assert_eq!(lookup("mig-inst-bad"), None);
        // 会写坏响应头的值同样不收（CR/LF 会把一条 503 切成两半）。
        assert!(!remember("mig-inst-bad", &frame("https://new.example.com\r\nx: y", 1)));
        assert_eq!(lookup("mig-inst-bad"), None);
    }
}
