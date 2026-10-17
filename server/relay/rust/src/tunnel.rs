//! 隧道状态与帧发送（单条隧道）。
//!
//! 自建版没有实例注册、没有多租户：同一时刻只服务**一条**宿主隧道。新连接直接取代旧的
//! ——旧连接上还挂着的请求会被一次性失败掉，否则那些帧会继续被处理进一个已经没人要的
//! 隧道对象（旧连接可能还停在 OPEN，收不到 close 帧）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dsh_relay_protocol::{encode_frame, t, Payload};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use crate::config::Config;

/// 一条隧道发往宿主方向的帧。发送经过一个专用的写任务串行化，
/// 这样「选帧 → 写 socket」不会和别的写操作交错。
pub type OutFrame = Message;

/// 隧道上等待中的条目：一次 HTTP 往返，或一条手机 WS 的桥接。
#[derive(Debug)]
pub enum Pending {
    /// 一次 HTTP 请求的响应通道。宿主回 httpHead 时把响应头发过来，之后用 chunk 流式推进。
    Http(HttpPending),
    /// 一条手机 WebSocket 的桥接。
    Ws(WsPending),
    /// 已经结束、只剩回收（避免在遍历时移除）。
    Done,
}

#[derive(Debug)]
pub struct HttpPending {
    pub sse: bool,
    /// 宿主已经发过 httpHead 之后，响应数据从这里流回手机。
    pub head_tx: Option<oneshot::Sender<HttpHead>>,
    /// 头超时的截止时间（没有收到 httpHead 之前有效）。
    pub header_deadline: Option<Instant>,
    /// SSE 空闲哨兵的截止时间（收到 httpHead 之后有效）。
    pub idle_deadline: Option<Instant>,
    /// 收到 httpHead 之后，响应数据从这里推给写回手机的任务。
    pub chunk_tx: Option<mpsc::Sender<crate::proxy::ResponseChunk>>,
}

#[derive(Debug, Clone)]
pub struct HttpHead {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

#[derive(Debug)]
pub struct WsPending {
    /// 发往手机 WS 的通道。手机那条连接由它自己的任务读。
    pub phone_tx: mpsc::Sender<Message>,
    /// 宿主已经确认 wsOpen。
    pub ready: bool,
    /// 未就绪时暂存的上行帧与字节数。
    pub queued: Vec<Message>,
    pub queued_bytes: usize,
    /// 手机 WS 的最近活跃时间（半开判定用）。
    pub last_active: Instant,
}

/// 一条隧道的运行时状态。
pub struct Tunnel {
    /// 发往宿主的帧队列。
    pub out_tx: mpsc::Sender<OutFrame>,
    pub pending: std::sync::Mutex<HashMap<u64, Pending>>,
    pub next_id: AtomicU64,
    /// 隧道发往宿主方向的积压字节数。
    ///
    /// tokio-tungstenite 没有 `ws.bufferedAmount`，所以这里自己记账：每发一帧加，
    /// 写任务真正把字节写出去之后减。判定水位读这个值。
    pub backlog: std::sync::Arc<AtomicI64>,
    pub connected_at: Instant,
    pub last_seen: std::sync::Mutex<Instant>,
    /// 隧道被取代或断开时置位，后续帧一律丢弃。
    pub closed: std::sync::atomic::AtomicBool,
    /// 与 `backlog` 同一个计数的另一个句柄。
    backlog_arc: std::sync::Arc<AtomicI64>,
}

/// 隧道发往宿主方向的积压上限（与 Node 版同名常量）。
pub const MAX_TUNNEL_BUFFERED_BYTES: i64 = 16 * 1024 * 1024;
/// 停读手机上行的高水位。
pub const TUNNEL_FEED_HIGH_WATER_BYTES: i64 = MAX_TUNNEL_BUFFERED_BYTES / 2;
/// 回落到这个水位就恢复读。
pub const TUNNEL_FEED_LOW_WATER_BYTES: i64 = MAX_TUNNEL_BUFFERED_BYTES / 4;

/// 不受积压门槛管的小控制帧：取消 / 暂停 / 恢复 / 关闭。
///
/// 积压恰恰是最需要它们的时候。一帧取消送不出去，宿主会继续往一条已经堵死的管道里灌；
/// 一帧关闭送不出去，宿主本机那条上游连接永远等不到收尾。它们一共九字节，放行不会
/// 让积压变坏。带数据的帧照旧被挡——那正是背压本身。
fn is_control_frame(frame_type: u8) -> bool {
    matches!(frame_type, t::HTTP_CANCEL | t::HTTP_PAUSE | t::HTTP_RESUME | t::WS_CLOSE)
}

impl Tunnel {
    pub fn new(out_tx: mpsc::Sender<OutFrame>) -> Arc<Self> {
        let backlog_arc = std::sync::Arc::new(AtomicI64::new(0));
        Arc::new(Self {
            out_tx,
            pending: std::sync::Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            backlog: backlog_arc.clone(),
            backlog_arc,
            connected_at: Instant::now(),
            last_seen: std::sync::Mutex::new(Instant::now()),
            closed: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// 这条隧道上的下一个帧 id。
    pub fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn backlog(&self) -> i64 {
        self.backlog.load(Ordering::SeqCst)
    }

    /// 积压计数器的句柄，给写任务用（写完减回去）。
    pub fn backlog_handle(&self) -> std::sync::Arc<AtomicI64> {
        self.backlog_arc.clone()
    }

    pub fn touch(&self) {
        if let Ok(mut last) = self.last_seen.lock() {
            *last = Instant::now();
        }
    }

    pub fn last_seen(&self) -> Instant {
        *self.last_seen.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn mark_closed(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    /// 有没有名额再挂一条请求。SSE 单独计数：一次对话占一条，多余的重连应当快速失败。
    pub fn has_capacity(&self, config: &Config, sse: bool) -> bool {
        let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if pending.len() >= config.max_pending {
            return false;
        }
        if !sse {
            return true;
        }
        let sse_count = pending
            .values()
            .filter(|entry| matches!(entry, Pending::Http(http) if http.sse))
            .count();
        sse_count < config.max_sse_connections
    }

    /// 当前挂着的手机 WS 条数。
    pub fn ws_count(&self) -> usize {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|entry| matches!(entry, Pending::Ws(_)))
            .count()
    }

    /// 编码并发送一帧给宿主。
    ///
    /// 返回 false 表示**这一帧**没发出去（积压超限或隧道已断），只让本次请求失败，
    /// 不断开整条隧道：一个慢手机不该打断同一条隧道上其它设备与请求。
    pub fn send_frame(&self, frame_type: u8, id: u64, payload: Payload) -> bool {
        if self.is_closed() {
            return false;
        }
        let control = is_control_frame(frame_type);
        if !control && self.backlog() > MAX_TUNNEL_BUFFERED_BYTES {
            return false;
        }
        let frame = encode_frame(frame_type, id as u32, &payload);
        let len = frame.len() as i64;
        if !control && self.backlog() + len > MAX_TUNNEL_BUFFERED_BYTES {
            return false;
        }
        // 记账在真正入队之前：入队之后写任务随时可能发出并减回去。
        self.backlog.fetch_add(len, Ordering::SeqCst);
        match self.out_tx.try_send(Message::Binary(frame.into())) {
            Ok(()) => true,
            Err(_) => {
                self.backlog.fetch_sub(len, Ordering::SeqCst);
                false
            }
        }
    }

    /// 发一帧 JSON 控制帧。注意 `id as u32` 的截断：与 Node 版 `id >>> 0` 同语义。
    pub fn send_json(&self, frame_type: u8, id: u64, json: &str) -> bool {
        self.send_frame(frame_type, id, Payload::Json(json.to_string()))
    }

    /// 发一帧空载荷。
    pub fn send_empty(&self, frame_type: u8, id: u64) -> bool {
        self.send_frame(frame_type, id, Payload::Empty)
    }
}

/// 隧道注册表：**按实例 id 存多条隧道**。
///
/// 公用中转要同时服务很多台宿主，所以这里不是「一个槽位、后来者顶掉前者」，而是一张
/// `instanceId → 隧道` 的表。同一实例再次连上仍然顶掉它自己那条（那是重连，不是抢别人）。
///
/// 实例 id 还没确定时（宿主刚连上、`register` 帧还没到）先挂在空白键下：那段时间
/// 它不接收任何按实例分发的请求，只等注册。
#[derive(Default)]
pub struct TunnelSlot {
    inner: std::sync::Mutex<HashMap<String, Arc<Tunnel>>>,
}

impl TunnelSlot {
    pub fn new() -> Self {
        Self::default()
    }

    /// 第一条隧道（给 `/status` 这种「这台中转活着吗」的状态查询用）。
    ///
    /// 公用场景下「有没有隧道」是个已经过时的问法；保留它是为了不破坏既有语义，
    /// 真实的按实例查询走 `get_for`。
    pub fn get(&self) -> Option<Arc<Tunnel>> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .next()
            .cloned()
    }

    /// 按实例 id 找隧道。找不到就是 `None`——调用方要回 503，不能退回到「随便挑一条」。
    pub fn get_for(&self, instance_id: &str) -> Option<Arc<Tunnel>> {
        let key = instance_id.trim();
        if key.is_empty() {
            return None;
        }
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .cloned()
    }

    /// 没带实例 id 时的唯一允许退路：**当前只连了一台**才交出去。
    ///
    /// 手动输配对码不是扫码，手机手上没有实例 id 可带。这种请求只有在中转上确实
    /// 只有一台宿主时才无歧义；多台时随便挑一台就是把 A 家的请求送进 B 家的电脑。
    /// 判定和取隧道必须在同一把锁里做，否则「查的时候一台、取的时候变两台」仍会串台。
    pub fn sole(&self) -> Option<Arc<Tunnel>> {
        let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut live = map.values().filter(|t| !t.is_closed());
        let first = live.next()?;
        if live.next().is_some() {
            return None;
        }
        Some(first.clone())
    }

    /// 当前在线多少台。面板与日志用它。
    pub fn online_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|t| !t.is_closed())
            .count()
    }

    /// 把一条隧道挂到某个实例上（`register` 帧到达时调用）。
    ///
    /// 同一实例原来那条会被顶掉——那是同一台机器的重连。返回被顶掉的那条，
    /// 调用方负责把它标记关闭并让在途请求快速失败。
    pub fn register(&self, instance_id: &str, tunnel: Arc<Tunnel>) -> Option<Arc<Tunnel>> {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let previous = map.insert(instance_id.trim().to_string(), tunnel.clone());
        // 返回值只表示「原来那条」，**跟自己指针相同就当作没有**：宿主断了会重新发
        // register，那是同一条连接重报家门，不该把自己标记关闭。
        match previous {
            Some(old) if Arc::ptr_eq(&old, &tunnel) => None,
            other => other,
        }
    }

    /// 只有当 `tunnel` 仍是这个实例绑着的那条时才移除。
    ///
    /// 被顶掉的旧连接晚一步走到清理分支时，不能把新连上的那条从表里删掉。
    pub fn clear_if_current(&self, tunnel: &Arc<Tunnel>) -> bool {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        // 找出**绑着这条隧道**的那个键再删。不要用「遍历全表删所有指向它的」那种写法：
        // 一个实例重连之后，旧连接和新连接的清理会各自跑一次，按指针全表匹配容易把
        // 别人的键一起带走。
        let key = map
            .iter()
            .find(|(_, current)| Arc::ptr_eq(current, tunnel))
            .map(|(k, _)| k.clone());
        match key {
            Some(key) => map.remove(&key).is_some(),
            None => false,
        }
    }

    /// 代次守卫：**只有确认被取代过**才返回 false。
    ///
    /// 没在表里不等于被取代——刚连上、`register` 帧还没到的隧道也不在表里，
    /// 它必须能继续读下去，否则会在自报家门之前就被自己踢掉（实打实踩过：
    /// 表现是连接一建立立刻 `superseded tunnel closed`，宿主的注册帧永远发不进去）。
    pub fn is_current(&self, tunnel: &Arc<Tunnel>) -> bool {
        !tunnel.is_closed()
    }
}

/// 打一条带时间戳的日志。
pub fn log(message: impl AsRef<str>) {
    let now = chrono_like_now();
    println!("[{now}] {}", message.as_ref());
}

/// 不引 chrono，只要一个 `YYYY-MM-DDTHH:MM:SS.mmmZ` 形状的本地时间戳。
fn chrono_like_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // 从 1970-01-01 起算的日期。
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant 的 days→civil 算法。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 等待积压回落到低水位（供请求方向背压使用）。
pub async fn wait_for_low_water(tunnel: &Arc<Tunnel>, poll: Duration) {
    while tunnel.backlog() > TUNNEL_FEED_LOW_WATER_BYTES && !tunnel.is_closed() {
        tokio::time::sleep(poll).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tunnel() -> Arc<Tunnel> {
        let (tx, _rx) = mpsc::channel::<OutFrame>(16);
        Tunnel::new(tx)
    }

    /// 公用中转的核心：多台宿主同时在线，各占一个实例，谁都不顶掉谁。
    #[test]
    fn many_instances_coexist() {
        let slot = TunnelSlot::new();
        let a = tunnel();
        let b = tunnel();
        let c = tunnel();
        assert!(slot.register("inst-a", a.clone()).is_none());
        assert!(slot.register("inst-b", b.clone()).is_none());
        assert!(slot.register("inst-c", c.clone()).is_none());

        assert_eq!(slot.online_count(), 3);
        assert!(Arc::ptr_eq(&slot.get_for("inst-a").unwrap(), &a));
        assert!(Arc::ptr_eq(&slot.get_for("inst-b").unwrap(), &b));
        assert!(Arc::ptr_eq(&slot.get_for("inst-c").unwrap(), &c));
        assert!(slot.get_for("inst-nope").is_none(), "没连上的实例必须是 None，不能随便挑一条");
    }

    /// 同一实例重连：新连接顶掉自己那条，别人不受影响。
    #[test]
    fn same_instance_reconnect_replaces_only_itself() {
        let slot = TunnelSlot::new();
        let a1 = tunnel();
        let b = tunnel();
        slot.register("inst-a", a1.clone());
        slot.register("inst-b", b.clone());

        let a2 = tunnel();
        let replaced = slot.register("inst-a", a2.clone()).expect("同一个实例重连要顶掉旧的");
        assert!(Arc::ptr_eq(&replaced, &a1));
        assert_eq!(slot.online_count(), 2, "顶掉的是自己那条，总数不变");
        assert!(Arc::ptr_eq(&slot.get_for("inst-a").unwrap(), &a2));
        assert!(Arc::ptr_eq(&slot.get_for("inst-b").unwrap(), &b), "另一个实例完全不受影响");
    }

    /// 被顶掉的旧连接晚一步走到清理分支时，**不能**把新连上的那条删掉。
    #[test]
    fn stale_tunnel_cleanup_does_not_remove_the_new_one() {
        let slot = TunnelSlot::new();
        let old = tunnel();
        slot.register("inst-a", old.clone());
        let new_tunnel = tunnel();
        slot.register("inst-a", new_tunnel.clone());

        // 旧连接这时才走到收尾。
        assert!(!slot.clear_if_current(&old), "它已经不是当前那条了");
        assert!(slot.get_for("inst-a").is_some(), "新连接必须还在");
    }

    /// 没带实例 id 的请求（手动输配对码）：零台没有可交的。
    #[test]
    fn sole_is_none_when_no_tunnel() {
        assert!(TunnelSlot::new().sole().is_none());
    }

    /// 只有一台时可以交出去——这是手动输配对码唯一能工作的情形。
    #[test]
    fn sole_hands_out_the_only_tunnel() {
        let slot = TunnelSlot::new();
        let a = tunnel();
        slot.register("inst-a", a.clone());

        let picked = slot.sole().expect("只连了一台，应当交出去");
        assert!(Arc::ptr_eq(&picked, &a));
    }

    /// **两台在线时必须拒绝**。随便挑一台就是把 A 家的请求送进 B 家的电脑。
    #[test]
    fn sole_refuses_when_more_than_one_tunnel() {
        let slot = TunnelSlot::new();
        slot.register("inst-a", tunnel());
        slot.register("inst-b", tunnel());

        assert!(slot.sole().is_none(), "多台在线不能挑一条给出去");
    }

    /// 已断开的隧道不占名额：另一台正常断开后，剩下那台应重新变成「唯一」。
    #[test]
    fn sole_ignores_closed_tunnels() {
        let slot = TunnelSlot::new();
        let a = tunnel();
        let b = tunnel();
        slot.register("inst-a", a.clone());
        slot.register("inst-b", b.clone());
        b.mark_closed();

        let picked = slot.sole().expect("断开的那台不算，应当只剩 a");
        assert!(Arc::ptr_eq(&picked, &a));
    }

    /// 正常断开只移除自己，别人的隧道一条都不许动。
    #[test]
    fn closing_one_tunnel_leaves_others_alone() {        let slot = TunnelSlot::new();
        let a = tunnel();
        let b = tunnel();
        slot.register("inst-a", a.clone());
        slot.register("inst-b", b.clone());

        assert!(slot.clear_if_current(&a));
        assert!(slot.get_for("inst-a").is_none());
        assert!(Arc::ptr_eq(&slot.get_for("inst-b").unwrap(), &b));
        assert_eq!(slot.online_count(), 1);
    }

    #[test]
    fn control_frames_bypass_backlog_limit() {
        for frame_type in [t::HTTP_CANCEL, t::HTTP_PAUSE, t::HTTP_RESUME, t::WS_CLOSE] {
            assert!(is_control_frame(frame_type), "{frame_type:#04x} 应当被放行");
        }
        for frame_type in [t::HTTP_CHUNK, t::HTTP_BODY, t::WS_TEXT] {
            assert!(!is_control_frame(frame_type), "{frame_type:#04x} 不该被放行");
        }
    }

    #[test]
    fn tunnel_ids_are_monotonic_within_a_tunnel() {
        let (tx, _rx) = mpsc::channel(8);
        let tunnel = Tunnel::new(tx);
        assert_eq!(tunnel.alloc_id(), 1);
        assert_eq!(tunnel.alloc_id(), 2);
    }

    #[test]
    fn closed_tunnel_refuses_frames() {
        let (tx, _rx) = mpsc::channel(8);
        let tunnel = Tunnel::new(tx);
        tunnel.mark_closed();
        assert!(!tunnel.send_empty(t::PING, 0));
    }

    #[test]
    fn send_refused_when_backlog_exceeds_limit() {
        let (tx, _rx) = mpsc::channel(8);
        let tunnel = Tunnel::new(tx);
        tunnel.backlog.store(MAX_TUNNEL_BUFFERED_BYTES + 1, Ordering::SeqCst);
        assert!(!tunnel.send_empty(t::HTTP_END, 1), "数据帧该被背压挡住");
        assert!(tunnel.send_empty(t::HTTP_CANCEL, 1), "控制帧必须放行");
    }

    #[test]
    fn register_returns_previous_tunnel_for_same_instance() {
        let slot = TunnelSlot::new();
        let first = tunnel();
        let second = tunnel();
        assert!(slot.register("inst-x", first.clone()).is_none());
        let previous = slot.register("inst-x", second.clone()).expect("应当返回被取代的那条");
        assert!(Arc::ptr_eq(&previous, &first));
        // 代次守卫看的是「这条有没有被标记关闭」，不是「它在不在表里」——
        // 刚连上、注册帧还没到的隧道也不在表里，它必须能继续读。
        assert!(slot.is_current(&second), "新连接的帧要能进来");
    }

    /// 宿主断线重连时会再发一次 `register`。那条连接仍然是当前那条，不能被
    /// 当成「被自己取代」而关掉。
    /// 重连之后旧连接收尾，**不能把新连接从表里删掉**。
    #[test]
    fn old_tunnel_teardown_after_reconnect_keeps_new_one() {
        let slot = TunnelSlot::new();
        let old = tunnel();
        slot.register("inst-x", old.clone());
        let new_tunnel = tunnel();
        slot.register("inst-x", new_tunnel.clone());

        // 旧连接这时才走到收尾（被顶掉之后）。
        assert!(!slot.clear_if_current(&old), "旧指针不该匹配到新连接");
        assert!(
            slot.get_for("inst-x").map(|t| Arc::ptr_eq(&t, &new_tunnel)).unwrap_or(false),
            "新连接必须还在表里"
        );
    }

    #[test]
    fn re_registering_the_same_tunnel_is_not_a_replacement() {
        let slot = TunnelSlot::new();
        let a = tunnel();
        assert!(slot.register("inst-x", a.clone()).is_none());
        assert!(
            slot.register("inst-x", a.clone()).is_none(),
            "同一条连接重报家门不该返回「被取代」"
        );
        assert!(slot.get_for("inst-x").is_some());
    }

    #[test]
    fn clear_ignores_superseded_tunnel() {
        let slot = TunnelSlot::new();
        let first = tunnel();
        let second = tunnel();
        slot.register("inst-x", first.clone());
        slot.register("inst-x", second.clone());
        assert!(!slot.clear_if_current(&first), "旧隧道不该清掉新隧道");
        assert!(slot.get().is_some());
        assert!(slot.clear_if_current(&second));
        assert!(slot.get().is_none());
    }
}
