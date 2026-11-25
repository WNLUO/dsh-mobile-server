// 默认列表的上游 5xx 使用已授权镜像兜底，取消原响应并在应答结束后释放名额。
// blob 写入由每隧道有界 worker 处理，主分发保持流量畅通。
//! 按字节预算转发 HTTP / WS 帧，并管理上传错误与响应暂停恢复。
//!
//! 响应方向达到高水位先暂停宿主，回落后恢复；字节硬上限与暂停期限负责收尾。
//! 请求方向在隧道积压时停读手机，请求体读空闲超时后取消上游并明确回包。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use dsh_relay_protocol::{t, Payload};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};

use crate::config::Config;
use crate::headers::pick_forward_headers;
use crate::http::{read_body_bytes, read_limited_line, respond_json, respond_text, respond_with, RequestHead, MAX_HEADER_LINE_BYTES};
use crate::tunnel::{
    log, HttpHead, HttpPending, Pending, Tunnel, TunnelSlot, TUNNEL_FEED_HIGH_WATER_BYTES,
};
use crate::ws;

/// SSE 空闲哨兵阈值：宿主侧 keepalive 是每 15s 一行注释，30s 一个字节都没有就说明
/// 上游既不产出也不会终止。
const SSE_IDLE_TIMEOUT_MS: u64 = 30_000;

/// 往回写手机时，一次写操作最多等多久。
///
/// 空闲哨兵管的是「上游不说话」，管不了「下游塞不进去」：手机把 socket 攥着却不再读
/// （被判死却没关的那一代连接就是这样），内核发送缓冲一满，写就挂在那里不动，而上游
/// 心跳还在源源不断地来，这条流于是既不算空闲也不会结束。给它一个上限，写不动就断，
/// 让客户端自己重连。
const SSE_WRITE_STALL_MS: u64 = 60_000;

/// 名额满时叫客户端多久再来。
///
/// 5 秒太短：真机上旧客户端根本不看这个头，0～1 秒就重拨；看得见的客户端也值得等过
/// 一轮用户操作，而不是在一个必然失败的窗口里空转。
const CAPACITY_RETRY_AFTER_SECONDS: &str = "25";

/// 容量拒绝的日志间隔：这段时间内的同类拒绝只累加计数，不再逐条写盘。
///
/// 真机一天七万条「名额满了」，每一条都是一次写盘，而它们说的是同一件事。
const CAPACITY_LOG_INTERVAL_MS: u128 = 60_000;

static CAPACITY_LOG: std::sync::Mutex<Option<(Instant, u64)>> = std::sync::Mutex::new(None);

/// 按分钟聚合地记一次容量拒绝。
fn log_capacity_rejected(line: String) {
    let now = Instant::now();
    let mut slot = CAPACITY_LOG.lock().unwrap_or_else(|e| e.into_inner());
    match slot.as_mut() {
        Some((at, suppressed)) if now.duration_since(*at).as_millis() < CAPACITY_LOG_INTERVAL_MS => {
            *suppressed += 1;
        }
        _ => {
            let carried = slot.as_ref().map(|(_, count)| *count).unwrap_or(0);
            if carried > 0 {
                log(format!("{line}（此前一分钟内另有 {carried} 次同类拒绝未逐条记录）"));
            } else {
                log(line);
            }
            *slot = Some((now, 0));
        }
    }
}

/// 日志里只留设备标识的头几位：它可能是一段凭据，不该整段落到日志文件里。
fn short_device(device: &str) -> String {
    device.chars().take(8).collect()
}

/// 顶流同样按分钟聚合。
///
/// 2026-10-27 实测一天 21,475 行「sse superseded」，占中转日志四成，而九成是同一台设备
/// 在自己的重连风暴里反复顶自己、说的都是同一件事。逐条写盘不提供任何额外信息，压成
/// 一分钟一行汇总：这一分钟顶了多少条、最后被顶的是谁、上限几。
static SSE_SUPERSEDED_LOG: std::sync::Mutex<Option<(Instant, u64)>> = std::sync::Mutex::new(None);

fn log_sse_superseded(device: &str, victim: u64, limit: usize) {
    let now = Instant::now();
    let mut slot = SSE_SUPERSEDED_LOG.lock().unwrap_or_else(|e| e.into_inner());
    let line = format!(
        "sse superseded: device={} victim={victim} limit={limit}",
        short_device(device)
    );
    match slot.as_mut() {
        Some((at, suppressed)) if now.duration_since(*at).as_millis() < CAPACITY_LOG_INTERVAL_MS => {
            *suppressed += 1;
        }
        _ => {
            let carried = slot.as_ref().map(|(_, count)| *count).unwrap_or(0);
            if carried > 0 {
                log(format!("{line}（此前一分钟内另有 {carried} 次顶流未逐条记录）"));
            } else {
                log(line);
            }
            *slot = Some((now, 0));
        }
    }
}

/// 隧道积压回落到低水位之后恢复读的轮询间隔。
const FEED_RESUME_POLL_MS: u64 = 25;

/// 每条响应的硬预算与高低水位；高水位后为已经在途的帧保留余量。
const MAX_RESPONSE_QUEUE_BYTES: usize = 16 * 1024 * 1024;
const RESPONSE_PAUSE_HIGH_BYTES: usize = MAX_RESPONSE_QUEUE_BYTES / 4;
const RESPONSE_RESUME_LOW_BYTES: usize = MAX_RESPONSE_QUEUE_BYTES / 8;
const RESPONSE_PAUSE_TIMEOUT_MS: u64 = 25_000;

fn response_expired(entry: &HttpPending) -> bool {
    if entry.chunk_tx.is_none() { return false; }
    match entry.paused_at {
        Some(at) => at.elapsed() >= std::time::Duration::from_millis(RESPONSE_PAUSE_TIMEOUT_MS),
        None => entry.idle_deadline.map(|deadline| Instant::now() >= deadline).unwrap_or(false),
    }
}

/// 取走唯一响应出口表示上游已终局；容量由持有 socket 的写任务最后释放。
fn take_response_sender(tunnel: &Arc<Tunnel>, id: u64) -> Option<mpsc::Sender<ResponseChunk>> {
    let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
    let Some(Pending::Http(entry)) = pending.get_mut(&id) else { return None };
    entry.paused_at = None;
    entry.idle_deadline = None;
    drop(entry.head_tx.take());
    entry.chunk_tx.take()
}

fn resume_response_if_drained(tunnel: &Arc<Tunnel>, id: u64) {
    let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(Pending::Http(entry)) = pending.get_mut(&id) {
        if entry.paused_at.is_some()
            && entry.queued_bytes.load(Ordering::SeqCst) <= RESPONSE_RESUME_LOW_BYTES
            && entry.chunk_tx.as_ref().map(|sender| sender.capacity() >= 192).unwrap_or(false)
        {
            if tunnel.send_empty(t::HTTP_RESUME, id) {
                entry.paused_at = None;
                entry.idle_deadline = Some(Instant::now() + std::time::Duration::from_millis(SSE_IDLE_TIMEOUT_MS));
            }
        }
    }
}


/// 终局帧（End/Error）的投递：通道满时等一个槽位再送，绝不能像普通数据那样丢掉。
/// 否则写任务永远等不到 End，SSE 会挂到空闲哨兵超时（甚至因为 pending 已摘除而永久挂住）。
fn send_terminal(sender: mpsc::Sender<ResponseChunk>, chunk: ResponseChunk) {
    match sender.try_send(chunk) {
        Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => {}
        Err(mpsc::error::TrySendError::Full(chunk)) => {
            tokio::spawn(async move {
                let _ = sender.send(chunk).await;
            });
        }
    }
}

/// 等宿主回响应头的三种结局。
enum HeadOutcome {
    Head(HttpHead),
    /// 连 `UPSTREAM_HEADER_TIMEOUT_MS` 都过了：宿主不在了。
    Timeout,
    /// 弱网阈值到点：先把缓存给了，宿主那份不再等。
    Mirror,
}

/// 处理一次普通 HTTP 转发：把请求送进隧道，等宿主把响应推回来。
pub async fn proxy_request(
    reader: BufReader<TcpStream>,
    head: RequestHead,
    tunnel: Arc<Tunnel>,
    _slot: Arc<TunnelSlot>,
    // 已经备好的一次缓存读（只有「默认视图的列表读」才会带进来）：
    // 宿主在阈值内没回头，或明确回了 5xx 时，拿它答手机并取消上游。
    fallback: Option<crate::mirror::Fallback>,
) -> std::io::Result<()> {
    proxy_request_with_config(reader, head, tunnel, fallback, crate::config()).await
}

async fn proxy_request_with_config(
    reader: BufReader<TcpStream>, head: RequestHead, tunnel: Arc<Tunnel>,
    fallback: Option<crate::mirror::Fallback>, config: Arc<Config>,
) -> std::io::Result<()> {
    let is_sse = head
        .header("accept")
        .map(|v| v.to_ascii_lowercase().contains("text/event-stream"))
        .unwrap_or(false);

    let mut reader = reader;
    // 声明长度已超限时不占名额、不发上游请求，也不继续读取上传。
    if head.content_length().map(|length| length > config.max_body_bytes).unwrap_or(false) {
        respond_text(&mut reader, 413, "body too large").await?;
        return Ok(());
    }
    // 这台流是哪台设备开的：`X-Dsh-Device` 是 App 一直就带的路由标识（非秘密），
    // 它缺了就退回设备凭据原文当键。两者都没有的老客户端统一落进同一个「未知设备」,
    // 于是它们之间也会互相顶——宁可让未知那堆彼此顶，也不让一台失控设备吃光全场名额。
    let device_key = if is_sse {
        head.header("x-dsh-device")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .or_else(|| {
                head.header("x-dsh-device-credential")
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
            })
            .or_else(|| Some(String::from("<unknown>")))
    } else {
        None
    };

    // 先按设备顶掉它自己的旧流，再看总量闸：顺序反过来会出现「风暴里的设备把名额吃满，
    // 新流先被 429 拒掉、旧流还占着」——正是真机上那种越滚越大的形态。
    if let Some(device) = device_key.as_deref() {
        let limit = config.max_sse_per_device;
        if tunnel.sse_count_of_device(device) >= limit {
            if let Some((victim, chunk, head)) = tunnel.take_oldest_sse_of_device(device) {
                tunnel.send_empty(t::HTTP_CANCEL, victim);
                if let Some(sender) = chunk {
                    send_terminal(sender, ResponseChunk::End);
                }
                drop(head);
                log_sse_superseded(device, victim, limit);
            }
        }
    }

    let id = tunnel.alloc_id();
    let (head_tx, head_rx) = oneshot::channel::<HttpHead>();
    let (chunk_tx, chunk_rx) = mpsc::channel::<ResponseChunk>(256);
    let response_bytes = Arc::new(AtomicUsize::new(0));
    if !tunnel.reserve_http(&config, id, HttpPending {
        sse: is_sse,
        device: device_key.clone(),
        head_tx: Some(head_tx),
        header_deadline: Some(Instant::now() + std::time::Duration::from_millis(config.upstream_header_timeout_ms)),
        idle_deadline: None,
        chunk_tx: Some(chunk_tx),
        queued_bytes: response_bytes.clone(),
        paused_at: None,
    }) {
        // 拒绝要留痕：这条 429 过去一个字都不写，事后只能靠「响应长度 29」猜它是不是我们回的。
        // 两个数一起打，才能分辨是「长连接名额被占满」还是「在途请求堆住了」。
        let (pending, sse) = tunnel.capacity_snapshot();
        log_capacity_rejected(format!(
            "capacity rejected: sse={sse}/{} pending={pending}/{} accept-sse={is_sse}",
            config.max_sse_connections, config.max_pending
        ));
        respond_with(
            &mut reader,
            429,
            "text/plain; charset=utf-8",
            b"relay resource limit exceeded",
            &[(
                "retry-after".to_string(),
                CAPACITY_RETRY_AFTER_SECONDS.to_string(),
            )],
        )
        .await?;
        return Ok(());
    }

    // 整个连接、队列与在写数据都释放后才归还容量。
    let result = proxy_reserved_request(reader, head, tunnel.clone(), id, head_rx, chunk_rx, response_bytes, fallback, config).await;
    tunnel.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    result
}

async fn proxy_reserved_request(
    mut reader: BufReader<TcpStream>, head: RequestHead, tunnel: Arc<Tunnel>, id: u64,
    head_rx: oneshot::Receiver<HttpHead>, chunk_rx: mpsc::Receiver<ResponseChunk>, response_bytes: Arc<AtomicUsize>,
    fallback: Option<crate::mirror::Fallback>, config: Arc<Config>,
) -> std::io::Result<()> {
    // 立即发请求头（不等 body 攒完）；body 随后以 httpBody 帧流式转发。
    // 路径按 `routed_path()` 取：中转前面有部署前缀时要先剥掉，否则宿主收到
    // `/relay/api/mobile/v1/...` 这种它不认识的路径，一律 404。
    let path = head.routed_path();
    let headers = pick_forward_headers(
        head.headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str())),
    );
    let request_json = serde_json::json!({
        "method": head.method,
        "path": path,
        "headers": headers.iter().cloned().collect::<std::collections::BTreeMap<_, _>>(),
    })
    .to_string();
    if !tunnel.send_json(t::HTTP_REQUEST, id, &request_json) {
        take_response_sender(&tunnel, id);
        respond_text(&mut reader, 502, "tunnel unavailable").await?;
        return Ok(());
    }

    // body 错误由这条连接直接答复，不再等待已经取消的宿主回 httpHead。
    if !forward_body_or_respond(&mut reader, &head, &tunnel, id, &config).await? {
        return Ok(());
    }

    // 等宿主回 httpHead（带超时）。备了缓存的多等一个「弱网阈值」：到点还没回就先把手
    // 上那份给手机，再把上游取消——手机下次轮询照常再问一次，宿主那边回来也没人等了。
    let header_wait = std::time::Duration::from_millis(config.upstream_header_timeout_ms);
    let mirror_wait = match (&fallback, config.mirror_fallback_ms) {
        (Some(_), ms) if ms > 0 => Some(std::time::Duration::from_millis(ms)),
        _ => None,
    };
    let head_outcome = match mirror_wait {
        Some(ms) => tokio::select! {
            result = tokio::time::timeout(header_wait, head_rx) => match result {
                Ok(Ok(head)) => HeadOutcome::Head(head),
                _ => HeadOutcome::Timeout,
            },
            () = tokio::time::sleep(ms) => HeadOutcome::Mirror,
        },
        None => match tokio::time::timeout(header_wait, head_rx).await {
            Ok(Ok(head)) => HeadOutcome::Head(head),
            _ => HeadOutcome::Timeout,
        },
    };

    let http_head = match head_outcome {
        HeadOutcome::Head(head) => head,
        HeadOutcome::Timeout => {
            // 超时或宿主没回：通知宿主取消，给手机 504。
            let still_ours = take_response_sender(&tunnel, id).is_some();
            if still_ours {
                tunnel.send_empty(t::HTTP_CANCEL, id);
            }
            respond_text(&mut reader, 504, "upstream response timeout").await?;
            return Ok(());
        }
        HeadOutcome::Mirror => {
            // 停止上游入队；手机应答完成前仍保留容量占位。
            let still_ours = take_response_sender(&tunnel, id).is_some();
            if still_ours {
                tunnel.send_empty(t::HTTP_CANCEL, id);
            }
            match fallback.as_ref().and_then(|entry| entry.serve()) {
                Some(body) => {
                    log(format!("mirror fallback answered id={id}"));
                    respond_with(
                        &mut reader,
                        200,
                        "application/json; charset=utf-8",
                        body.as_bytes(),
                        &[("x-dsh-relay-mirror".to_string(), "stale".to_string())],
                    )
                    .await?;
                }
                // 备着的这份此刻拿不出来（凭据对不上 / 已被淘汰）：老实报超时，别假装有数据。
                None => respond_text(&mut reader, 504, "upstream response timeout").await?,
            }
            return Ok(());
        }
    };

    // 请求入口已按路径、读操作与 fresh 筛过；这里再次按当前凭据与镜像存量决定能否接管。
    // 拿不到镜像时不动上游响应，保留它的状态、头与流式正文。
    if (500..600).contains(&http_head.status) {
        if let Some(body) = fallback.as_ref().and_then(|entry| entry.serve()) {
            if take_response_sender(&tunnel, id).is_some() {
                tunnel.send_empty(t::HTTP_CANCEL, id);
            }
            drop(chunk_rx);
            log(format!("mirror fallback answered id={id} upstream={}", http_head.status));
            respond_with(
                &mut reader,
                200,
                "application/json; charset=utf-8",
                body.as_bytes(),
                &[("x-dsh-relay-mirror".to_string(), "stale".to_string())],
            ).await?;
            return Ok(());
        }
    }

    // 写响应头，然后把后续 chunk 流式写给手机。
    let chunked = match write_response_head(&mut reader, &http_head).await {
        Ok(chunked) => chunked,
        Err(error) => {
            if take_response_sender(&tunnel, id).is_some() { tunnel.send_empty(t::HTTP_CANCEL, id); }
            return Err(error);
        }
    };

    write_response_body(reader.into_inner(), &tunnel, id, chunk_rx, response_bytes, chunked).await;
    Ok(())
}

async fn write_response_body<W: tokio::io::AsyncWrite + Unpin>(
    stream: W, tunnel: &Arc<Tunnel>, id: u64, chunk_rx: mpsc::Receiver<ResponseChunk>,
    response_bytes: Arc<AtomicUsize>, chunked: bool,
) {
    write_response_chunks(stream, tunnel, id, chunk_rx, response_bytes, chunked).await;
    tunnel.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
}

async fn write_response_chunks<W: tokio::io::AsyncWrite + Unpin>(
    mut stream: W, tunnel: &Arc<Tunnel>, id: u64, mut chunk_rx: mpsc::Receiver<ResponseChunk>,
    response_bytes: Arc<AtomicUsize>, chunked: bool,
) {
    {
        let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(Pending::Http(entry)) = pending.get_mut(&id) {
            entry.idle_deadline = Some(
                Instant::now() + std::time::Duration::from_millis(SSE_IDLE_TIMEOUT_MS),
            );
        }
    }

    // SSE 空闲哨兵：上游不发终止帧时条目会一直挂在 pending 里、响应永不结束，客户端要等
    // 自己的超时才断。这里每 5 秒扫一次，超过阈值一个字节都没有就主动收尾并通知上游取消，
    // 客户端随即重连重放，把「无限期静默挂死」降级成一次可自愈的重连。
    let _sentinel = {
        let tunnel = tunnel.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                resume_response_if_drained(&tunnel, id);
                let expired = {
                    let pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                    match pending.get(&id) {
                        Some(Pending::Http(entry)) if entry.chunk_tx.is_some() => response_expired(entry),
                        Some(Pending::Http(_)) => return,
                        _ => return, // 条目已经不在（正常结束或被取消），哨兵退休
                    }
                };
                if expired {
                    log(format!("response idle/pause timeout: id={id}"));
                    if let Some(sender) = take_response_sender(&tunnel, id) {
                        tunnel.send_empty(t::HTTP_CANCEL, id);
                        send_terminal(sender, ResponseChunk::End);
                    }
                    return;
                }
            }
        })
    };

    while let Some(chunk) = chunk_rx.recv().await {
        match chunk {
            ResponseChunk::Data(bytes) => {
                let wire = if chunked { Some(encode_chunk(&bytes)) } else { None };
                let wire = wire.as_deref().unwrap_or(&bytes);
                // 一次写最多等 `SSE_WRITE_STALL_MS`：手机手里攥着 socket 却不再读的时候，
                // 内核发送缓冲一满，`write_all` 就不动了；上游心跳照样在来，空闲哨兵永远
                // 不会判它死。超时即视为这条流已经没人要了，取消上游、放手。
                let stalled = tokio::time::timeout(
                    std::time::Duration::from_millis(SSE_WRITE_STALL_MS),
                    async {
                        stream.write_all(wire).await?;
                        stream.flush().await
                    },
                )
                .await;
                let failed = match stalled {
                    Ok(result) => result.is_err(),
                    Err(_) => {
                        log(format!(
                            "write stall: id={id} (>{SSE_WRITE_STALL_MS}ms)，下游不再读，主动收尾"
                        ));
                        true
                    }
                };
                response_bytes.fetch_sub(bytes.len(), Ordering::SeqCst);
                if failed {
                    if take_response_sender(tunnel, id).is_some() { tunnel.send_empty(t::HTTP_CANCEL, id); }
                    break;
                }
                resume_response_if_drained(&tunnel, id);
            }
            ResponseChunk::End | ResponseChunk::Error(_) => {
                let _ = tokio::time::timeout(std::time::Duration::from_millis(SSE_WRITE_STALL_MS), async {
                    if let ResponseChunk::Error(message) = chunk {
                        let body = format!("upstream error: {message}");
                        if chunked { stream.write_all(&encode_chunk(body.as_bytes())).await?; }
                        else { stream.write_all(body.as_bytes()).await?; }
                    }
                    if chunked { stream.write_all(b"0\r\n\r\n").await?; }
                    stream.flush().await?;
                    stream.shutdown().await
                }).await;
                break;
            }
        }
    }

    _sentinel.abort();
}

/// 解析控制帧的 JSON 载荷（失败返回空对象），对齐 JS 侧 `parseJson`。
fn parse_json_value(payload: &[u8]) -> serde_json::Value {
    serde_json::from_slice(payload).unwrap_or_else(|_| serde_json::json!({}))
}

/// `creds` 数组：每项 `{hash, expiresAt}`（与镜像同一形状），也认老的裸 hex 串。
/// 形状不对的整条丢掉。
pub(crate) fn parse_creds(value: Option<&serde_json::Value>) -> Vec<crate::blobstore::Cred> {
    use crate::blobstore::Cred;
    let mut out = Vec::new();
    if let Some(list) = value.and_then(|v| v.as_array()) {
        for item in list {
            if let Some(raw) = item.as_str() {
                // 老写法：直接是 sha256 hex，没有过期时刻。
                if let Some(hash) = crate::blobstore::decode_hex32(raw) {
                    out.push(Cred {
                        hash,
                        expires_at: 0,
                    });
                }
                continue;
            }
            let Some(hash) = item
                .get("hash")
                .and_then(|v| v.as_str())
                .and_then(crate::blobstore::decode_hex32)
            else {
                continue;
            };
            // 缺 `expiresAt` 按 0（不过期）读，与 `mirror` 同一口径。
            let expires_at = item
                .get("expiresAt")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                .max(0);
            out.push(Cred { hash, expires_at });
        }
    }
    out
}

/// 响应方向上推进给手机的一段数据。
pub enum ResponseChunk {
    Data(Vec<u8>),
    End,
    Error(String),
}

/// 等隧道在请求方向的积压回落到高水位。
///
/// 这个等待必须自带期限。宿主读帧要是卡住（事件循环被堵、GC 停顿、正在拼一条超大 SSE），
/// 积压就一直停在高水位上，手机的上传永远停在半路 —— 而中转那条 pending 一直挂着占名额，
/// 日志里一个字都没有。期限按「还在动」续：积压哪怕只减了一个字节也是宿主在收，缓而不断的
/// 上传不该被杀掉，一动不动的那种才该收尾。
///
/// 返回 false 表示积压一动不动、或者隧道已经没了，调用方要就地收尾。
async fn wait_for_feed_room(tunnel: &Arc<Tunnel>, timeout_ms: u64) -> bool {
    let mut last = tunnel.backlog();
    if last <= TUNNEL_FEED_HIGH_WATER_BYTES {
        return true;
    }
    let grace = std::time::Duration::from_millis(timeout_ms);
    let mut deadline = Instant::now() + grace;
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(FEED_RESUME_POLL_MS)).await;
        if tunnel.is_closed() {
            return false;
        }
        let backlog = tunnel.backlog();
        if backlog <= TUNNEL_FEED_HIGH_WATER_BYTES {
            return true;
        }
        if backlog < last {
            deadline = Instant::now() + grace;
        }
        last = backlog;
        if Instant::now() >= deadline {
            log(format!(
                "request body stall: backlog={backlog} 字节在 {timeout_ms}ms 里没有回落，放弃这次上传"
            ));
            return false;
        }
    }
}

#[derive(Debug, PartialEq)]
enum ForwardBodyError {
    TooLarge,
    Timeout,
    Malformed,
    Upstream,
}

impl ForwardBodyError {
    fn response(&self, tunnel_closed: bool) -> (u16, &'static str) {
        match self {
            Self::TooLarge => (413, "body too large"),
            Self::Timeout => (408, "request body timeout"),
            Self::Malformed => (400, "incomplete or malformed request body"),
            Self::Upstream if tunnel_closed => (502, "tunnel unavailable"),
            Self::Upstream => (504, "upstream request stall"),
        }
    }
}

async fn forward_body_or_respond(
    reader: &mut BufReader<TcpStream>, head: &RequestHead, tunnel: &Arc<Tunnel>, id: u64, config: &Config,
) -> std::io::Result<bool> {
    match forward_request_body(reader, head, tunnel, id, config).await {
        Ok(()) => Ok(true),
        Err(error) => {
            if take_response_sender(tunnel, id).is_some() { tunnel.send_empty(t::HTTP_CANCEL, id); }
            let (status, message) = error.response(tunnel.is_closed());
            respond_text(reader, status, message).await?;
            Ok(false)
        }
    }
}

fn body_io_error(error: std::io::Error) -> ForwardBodyError {
    if error.kind() == std::io::ErrorKind::TimedOut { ForwardBodyError::Timeout } else { ForwardBodyError::Malformed }
}

async fn send_body_part(tunnel: &Arc<Tunnel>, id: u64, bytes: &[u8], config: &Config) -> Result<(), ForwardBodyError> {
    if !tunnel.send_frame(t::HTTP_BODY, id, Payload::Bytes(bytes.to_vec())) {
        return Err(ForwardBodyError::Upstream);
    }
    if !wait_for_feed_room(tunnel, config.upstream_header_timeout_ms).await {
        return Err(ForwardBodyError::Upstream);
    }
    Ok(())
}

/// 按声明长度、chunked 或 EOF 读体；读超时、超限和半截断开各有明确结果。
async fn forward_request_body(
    reader: &mut BufReader<TcpStream>,
    head: &RequestHead,
    tunnel: &Arc<Tunnel>,
    id: u64,
    config: &Config,
) -> Result<(), ForwardBodyError> {
    let mut buffer = vec![0u8; 64 * 1024];
    if head.is_chunked() {
        return forward_chunked_body(reader, tunnel, id, config, &mut buffer).await;
    }
    if let Some(length) = head.content_length() {
        if length > config.max_body_bytes {
            return Err(ForwardBodyError::TooLarge);
        }
        let mut remaining = length;
        while remaining > 0 {
            let want = buffer.len().min(remaining);
            let read = read_body_bytes(reader, &mut buffer[..want], config.upstream_header_timeout_ms).await.map_err(body_io_error)?;
            if read == 0 {
                return Err(ForwardBodyError::Malformed);
            }
            remaining -= read;
            send_body_part(tunnel, id, &buffer[..read], config).await?;
        }
    } else if !matches!(head.method.as_str(), "GET" | "HEAD" | "DELETE" | "OPTIONS" | "TRACE") {
        let mut total = 0usize;
        loop {
            let read = read_body_bytes(reader, &mut buffer, config.upstream_header_timeout_ms).await.map_err(body_io_error)?;
            if read == 0 { break; }
            if read > config.max_body_bytes.saturating_sub(total) {
                return Err(ForwardBodyError::TooLarge);
            }
            total += read;
            send_body_part(tunnel, id, &buffer[..read], config).await?;
        }
    }
    if !tunnel.send_empty(t::HTTP_BODY, id) { return Err(ForwardBodyError::Upstream); }
    Ok(())
}

async fn read_chunk_line(reader: &mut BufReader<TcpStream>, config: &Config) -> Result<String, ForwardBodyError> {
    let line = tokio::time::timeout(
        std::time::Duration::from_millis(config.upstream_header_timeout_ms),
        read_limited_line(reader, MAX_HEADER_LINE_BYTES),
    ).await.map_err(|_| ForwardBodyError::Timeout)?.map_err(body_io_error)?;
    if line.is_empty() { return Err(ForwardBodyError::Malformed); }
    Ok(line)
}

/// 解码代理可能生成的 chunked 上传；chunk 扩展与 trailer 也受字节/时间上限约束。
async fn forward_chunked_body(
    reader: &mut BufReader<TcpStream>,
    tunnel: &Arc<Tunnel>,
    id: u64,
    config: &Config,
    buffer: &mut [u8],
) -> Result<(), ForwardBodyError> {
    let mut total = 0usize;
    loop {
        let line = read_chunk_line(reader, config).await?;
        let size_text = line.trim().split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| ForwardBodyError::Malformed)?;
        if size > config.max_body_bytes.saturating_sub(total) {
            return Err(ForwardBodyError::TooLarge);
        }
        if size == 0 {
            let mut trailer_bytes = 0usize;
            loop {
                let trailer = read_chunk_line(reader, config).await?;
                trailer_bytes += trailer.len();
                if trailer_bytes > 256 * 1024 { return Err(ForwardBodyError::Malformed); }
                if trailer.trim().is_empty() { break; }
            }
            if !tunnel.send_empty(t::HTTP_BODY, id) { return Err(ForwardBodyError::Upstream); }
            return Ok(());
        }
        let mut remaining = size;
        while remaining > 0 {
            let want = buffer.len().min(remaining);
            let read = read_body_bytes(reader, &mut buffer[..want], config.upstream_header_timeout_ms).await.map_err(body_io_error)?;
            if read == 0 { return Err(ForwardBodyError::Malformed); }
            remaining -= read;
            total += read;
            send_body_part(tunnel, id, &buffer[..read], config).await?;
        }
        let mut crlf = [0u8; 2];
        let mut read = 0;
        while read < crlf.len() {
            let count = read_body_bytes(reader, &mut crlf[read..], config.upstream_header_timeout_ms).await.map_err(body_io_error)?;
            if count == 0 { return Err(ForwardBodyError::Malformed); }
            read += count;
        }
        if crlf != *b"\r\n" { return Err(ForwardBodyError::Malformed); }
    }
}

/// 写响应头。宿主给的状态与头原样带过去（逐跳头过滤后）。
async fn write_response_head(
    reader: &mut BufReader<TcpStream>,
    head: &HttpHead,
) -> std::io::Result<bool> {
    let cleaned = crate::headers::sanitize_resp_headers(head.headers.clone());
    let mut out = format!("HTTP/1.1 {} X\r\n", head.status);
    let mut has_length = false;
    for (name, value) in &cleaned {
        if name == "content-length" {
            has_length = true;
        }
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    // 没有 content-length 时用 chunked 编码：SSE 与流式响应都得边推边到，不能等全部收完。
    // 带了 chunked 头就必须按 chunked 格式写数据（见 write_chunk），否则客户端解析失败。
    let chunked = !has_length;
    if chunked {
        out.push_str("transfer-encoding: chunked\r\n");
    }
    out.push_str("connection: close\r\n\r\n");
    let stream = reader.get_mut();
    stream.write_all(out.as_bytes()).await?;
    stream.flush().await?;
    Ok(chunked)
}

/// 按 HTTP/1.1 chunked 格式写一段数据：长度(十六进制) CRLF 数据 CRLF。
fn encode_chunk(data: &[u8]) -> Vec<u8> {
    let mut out = format!("{:x}\r\n", data.len()).into_bytes();
    out.extend_from_slice(data);
    out.extend_from_slice(b"\r\n");
    out
}

/// 分发宿主推回来的一帧。
pub fn handle_tunnel_frame(tunnel: &Arc<Tunnel>, instance_id: &str, frame_type: u8, id: u64, payload: &[u8]) {
    match frame_type {
        t::SYNC => {
            // 宿主推上来的整份镜像（会话清单 + 工作区 + 已签发设备凭据的摘要）。
            // 转发路径本身用不到它——只有这条隧道不在之后手机才来读（见 `mirror`）。
            // 存不下、格式不对都只是这一次不更新，绝不回执也不会断开隧道。
            crate::mirror::note_sync_frame(instance_id, payload.len());
            crate::mirror::remember(instance_id, payload);
        }
        // blobPut/blobDelete 已由 ws 的每连接有界文件 worker 接管。
        t::BLOB_PUT | t::BLOB_DELETE => {}
        t::HTTP_HEAD => {
            let value = parse_json_value(payload);
            let status = value
                .get("status")
                .and_then(|v| v.as_u64())
                .unwrap_or(502) as u16;
            let headers: Vec<(String, String)> = value
                .get("headers")
                .and_then(|v| v.as_object())
                .map(|map| {
                    map.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let sender = {
                let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                match pending.get_mut(&id) {
                    Some(Pending::Http(entry)) if entry.chunk_tx.is_some() => entry.head_tx.take(),
                    _ => None,
                }
            };
            if let Some(sender) = sender {
                let _ = sender.send(HttpHead { status, headers });
            }
        }
        t::HTTP_CHUNK => {
            let failed = {
                let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                let Some(Pending::Http(entry)) = pending.get_mut(&id) else { return };
                let Some(sender) = entry.chunk_tx.as_ref() else { return };
                let queued = entry.queued_bytes.load(Ordering::SeqCst);
                if payload.len() > MAX_RESPONSE_QUEUE_BYTES.saturating_sub(queued) {
                    true
                } else {
                    entry.queued_bytes.fetch_add(payload.len(), Ordering::SeqCst);
                    match sender.try_send(ResponseChunk::Data(payload.to_vec())) {
                        Ok(()) => {
                            entry.idle_deadline = Some(Instant::now() + std::time::Duration::from_millis(SSE_IDLE_TIMEOUT_MS));
                            // 条数水位只照顾大量小帧，内存上限始终按字节判。
                            if entry.paused_at.is_none() && (queued + payload.len() >= RESPONSE_PAUSE_HIGH_BYTES || sender.capacity() <= 64) {
                                if tunnel.send_empty(t::HTTP_PAUSE, id) {
                                    entry.paused_at = Some(Instant::now());
                                }
                            }
                            false
                        }
                        Err(_) => {
                            entry.queued_bytes.fetch_sub(payload.len(), Ordering::SeqCst);
                            true
                        }
                    }
                }
            };
            if failed {
                log(format!("response byte/slot limit id={id}: closing response"));
                if let Some(sender) = take_response_sender(tunnel, id) {
                    tunnel.send_empty(t::HTTP_CANCEL, id);
                    send_terminal(sender, ResponseChunk::End);
                }
            }
        }
        t::HTTP_END => {
            let sender = take_response_sender(tunnel, id);
            if let Some(sender) = sender {
                send_terminal(sender, ResponseChunk::End);
            }
        }
        t::HTTP_ERROR => {
            let value = parse_json_value(payload);
            let message = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let sender = take_response_sender(tunnel, id);
            if let Some(sender) = sender {
                send_terminal(sender, ResponseChunk::Error(message));
            }
        }
        t::WS_OPEN => {
            let failed = {
                let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                let Some(Pending::Ws(entry)) = pending.get_mut(&id) else { return };
                if entry.phone_tx.is_none() { return; }
                // 同一把锁中按原顺序送回宿主，不能把上行数据投给 phone_tx。
                let queued = std::mem::take(&mut entry.queued);
                entry.queued_bytes = 0;
                let sent = queued.into_iter().all(|message| ws::send_phone_frame(tunnel, id, message));
                entry.ready = sent;
                !sent
            };
            if failed { close_phone_ws(tunnel, id, 1013, "phone ws backpressure"); }
        }
        t::WS_TEXT | t::WS_BINARY => {
            let failed = {
                let pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                let Some(Pending::Ws(entry)) = pending.get(&id) else { return };
                if entry.phone_tx.is_none() { return; }
                let limit = crate::config().max_ws_queue_bytes;
                if payload.len() > limit.saturating_sub(entry.phone_bytes.load(Ordering::SeqCst)) {
                    true
                } else {
                    let message = if frame_type == t::WS_TEXT {
                        tokio_tungstenite::tungstenite::Message::Text(String::from_utf8_lossy(payload).into_owned().into())
                    } else {
                        tokio_tungstenite::tungstenite::Message::Binary(payload.to_vec().into())
                    };
                    !entry.send_phone(message, limit)
                }
            };
            if failed { close_phone_ws(tunnel, id, 1013, "phone ws backpressure"); }
        }
        t::WS_CLOSE => {
            if let Some(sender) = take_phone_sender(tunnel, id) {
                send_ws_terminal(sender, ws::close_from_tunnel_payload(payload));
            }
        }
        t::WS_ERROR => close_phone_ws(tunnel, id, 1011, "upstream ws error"),
        _ => {
            // 未知帧按 Node 版的做法静默丢弃（不报错、不回执）。
        }
    }
}

fn send_ws_terminal(sender: mpsc::Sender<tokio_tungstenite::tungstenite::Message>, message: tokio_tungstenite::tungstenite::Message) {
    match sender.try_send(message) {
        Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => {}
        Err(mpsc::error::TrySendError::Full(message)) => {
            tokio::spawn(async move { let _ = sender.send(message).await; });
        }
    }
}

fn take_phone_sender(tunnel: &Arc<Tunnel>, id: u64) -> Option<mpsc::Sender<tokio_tungstenite::tungstenite::Message>> {
    let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
    let Some(Pending::Ws(entry)) = pending.get_mut(&id) else { return None };
    entry.queued.clear();
    entry.queued_bytes = 0;
    entry.phone_tx.take()
}

pub(crate) fn close_phone_ws(tunnel: &Arc<Tunnel>, id: u64, code: u16, reason: &str) {
    if let Some(sender) = take_phone_sender(tunnel, id) {
        tunnel.send_frame(t::WS_CLOSE, id, Payload::Bytes(dsh_relay_protocol::encode_close_payload(code, reason)));
        send_ws_terminal(sender, ws::close_frame(code, reason));
    }
}

/// 隧道断开或被取代时，把这条隧道上还没结束的请求一次性失败掉。
///
/// 不清理的后果是这些条目永久留在 pending 里：HTTP 响应永不结束、手机 WS 停在 OPEN，
/// 客户端只能等自己的超时。
pub fn fail_all_pending(tunnel: &Arc<Tunnel>, reason: &str) {
    let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
    for entry in pending.values_mut() {
        match entry {
            Pending::Http(http) => {
                // 已经发出响应头的，把错误写进响应体收尾。
                if let Some(sender) = http.chunk_tx.take() {
                    send_terminal(sender, ResponseChunk::Error(format!("upstream unavailable: {reason}")));
                }
                // 还在等响应头的，用一个「上游不可用」的头叫醒它——它会把这次请求结束成
                // 502。**不能**只 drop 发送端：那会被上层当成「宿主没回」，最后报 504，
                // 而这里不是超时，是隧道没了。
                if let Some(sender) = http.head_tx.take() {
                    let _ = sender.send(HttpHead {
                        status: 502,
                        headers: vec![(
                            "content-type".to_string(),
                            "text/plain; charset=utf-8".to_string(),
                        )],
                    });
                }
            }
            Pending::Ws(ws) => {
                if let Some(sender) = ws.phone_tx.take() { send_ws_terminal(sender, ws::close_frame(1011, reason)); }
                ws.queued.clear();
                ws.queued_bytes = 0;
            }
            Pending::Done => {}
        }
    }
}

/// 给 `respond_json` 的一个便利包装：中转没有隧道时用它回 503。
pub async fn respond_no_tunnel(reader: &mut BufReader<TcpStream>) -> std::io::Result<()> {
    respond_json(
        reader,
        503,
        r#"{"ok":false,"error":"no host tunnel connected"}"#,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    fn tunnel() -> Arc<Tunnel> {
        let (tx, _rx) = mpsc::channel(8);
        Tunnel::new(tx)
    }

    fn response_entry(tunnel: &Arc<Tunnel>, id: u64) -> (mpsc::Receiver<ResponseChunk>, Arc<AtomicUsize>) {
        let (chunk_tx, chunk_rx) = mpsc::channel(256);
        let bytes = Arc::new(AtomicUsize::new(0));
        tunnel.pending.lock().unwrap().insert(id, Pending::Http(HttpPending {
            sse: true, device: None, head_tx: None, header_deadline: None, idle_deadline: None,
            chunk_tx: Some(chunk_tx), queued_bytes: bytes.clone(), paused_at: None,
        }));
        (chunk_rx, bytes)
    }

    fn remember_proxy_mirror(instance: &str) {
        use sha2::{Digest, Sha256};
        let hash = format!("{:x}", Sha256::digest(b"mirror-reader"));
        let payload = serde_json::json!({
            "kind": "sync",
            "sessions": { "ok": true, "items": [{ "sessionId": "cached-session" }], "revision": "sessions-rev", "generatedAt": 111 },
            "workspaces": { "ok": true, "items": [{ "workspaceId": "cached-workspace" }], "revision": "workspaces-rev", "generatedAt": 222 },
            "creds": [{ "hash": hash }],
        });
        assert!(crate::mirror::remember(instance, payload.to_string().as_bytes()));
    }

    /// 走真实 HTTP 入口和隧道分发；不复制路径筛选或 fallback 判定。
    async fn mirrored_upstream_response(
        instance: &str, method: &str, target: &str, credential: &str, status: u16, finish: bool,
    ) -> (String, usize) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (out, mut frames) = mpsc::channel(16);
        let tunnel = Tunnel::new(out);
        tunnel.bind_instance(instance);
        let slot = Arc::new(TunnelSlot::new());
        slot.register(instance, tunnel.clone());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            crate::http::serve_connection(stream, slot).await.unwrap();
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        let raw = format!("{method} {target} HTTP/1.1\r\nhost: relay\r\nx-dsh-instance: {instance}\r\nx-dsh-device-credential: {credential}\r\ncontent-length: 0\r\n\r\n");
        client.write_all(raw.as_bytes()).await.unwrap();
        let message = tokio::time::timeout(std::time::Duration::from_secs(2), frames.recv()).await.unwrap().unwrap();
        let mut request_id = None;
        dsh_relay_protocol::FrameDecoder::new(4096).push(&message.into_data(), |frame| {
            assert_eq!(frame.frame_type, t::HTTP_REQUEST);
            request_id = Some(u64::from(frame.id));
        });
        let id = request_id.expect("request frame");
        let body = br#"{"ok":false,"error":{"code":"internal","message":"upstream failed"}}"#;
        let head = serde_json::json!({ "status": status, "headers": {
            "content-type": "application/json", "content-length": body.len().to_string(), "x-upstream": "kept"
        }});
        handle_tunnel_frame(&tunnel, instance, t::HTTP_HEAD, id, head.to_string().as_bytes());
        // 头与部分正文可在同一批到达；兜底必须丢掉这份已入队错误正文。
        handle_tunnel_frame(&tunnel, instance, t::HTTP_CHUNK, id, body);
        if finish { handle_tunnel_frame(&tunnel, instance, t::HTTP_END, id, &[]); }
        let mut cancels = 0;
        if !finish {
            loop {
                let message = tokio::time::timeout(std::time::Duration::from_secs(2), frames.recv())
                    .await.expect("镜像接管必须取消仍在发送的上游").unwrap();
                dsh_relay_protocol::FrameDecoder::new(4096).push(&message.into_data(), |frame| {
                    if frame.frame_type == t::HTTP_CANCEL {
                        assert_eq!(u64::from(frame.id), id);
                        cancels += 1;
                    }
                });
                if cancels > 0 { break; }
            }
            let before = tunnel.pending.lock().unwrap().get(&id).and_then(|entry| match entry {
                Pending::Http(entry) => {
                    assert!(entry.chunk_tx.is_none(), "取消前必须先停止响应入队");
                    Some(entry.queued_bytes.load(Ordering::SeqCst))
                }
                _ => None,
            });
            handle_tunnel_frame(&tunnel, instance, t::HTTP_CHUNK, id, b"late-upstream-data");
            if let Some(before) = before {
                if let Some(Pending::Http(entry)) = tunnel.pending.lock().unwrap().get(&id) {
                    assert_eq!(entry.queued_bytes.load(Ordering::SeqCst), before, "迟到帧不能重新入队");
                }
            }
        }
        let mut response = String::new();
        tokio::time::timeout(std::time::Duration::from_secs(2), client.read_to_string(&mut response)).await.unwrap().unwrap();
        server.await.unwrap();
        while let Ok(message) = frames.try_recv() {
            dsh_relay_protocol::FrameDecoder::new(4096).push(&message.into_data(), |frame| {
                if frame.frame_type == t::HTTP_CANCEL { cancels += 1; }
            });
        }
        assert_eq!(tunnel.capacity_snapshot().0, 0, "应答完成必须归还 pending 名额");
        (response, cancels)
    }

    #[tokio::test]
    async fn upstream_5xx_lists_use_authorized_mirror_and_cancel_response() {
        let _guard = crate::mirror::test_lock();
        let instance = "proxy-5xx-mirror";
        remember_proxy_mirror(instance);
        for (target, status, item) in [
            ("/api/mobile/v1/sessions", 500, "cached-session"),
            ("/relay/api/mobile/v1/workspaces", 503, "cached-workspace"),
            ("/api/mobile/v1/sessions", 599, "cached-session"),
        ] {
            let (response, cancels) = mirrored_upstream_response(instance, "GET", target, "mirror-reader", status, false).await;
            assert!(response.starts_with("HTTP/1.1 200 "), "{target}: {response}");
            assert!(response.contains("x-dsh-relay-mirror: stale\r\n"), "{response}");
            let body: serde_json::Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(body["stale"], true);
            assert!(body["items"].to_string().contains(item), "{body}");
            assert!(!response.contains("upstream failed") && !response.contains("x-upstream"));
            assert_eq!(cancels, 1, "只取消一次原响应");
        }
        let (response, _) = mirrored_upstream_response(instance, "GET", "/api/mobile/v1/sessions?rev=sessions-rev", "mirror-reader", 502, false).await;
        let body: serde_json::Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["unchanged"], true);
        assert_eq!(body["stale"], true);
        assert!(body.get("items").is_none());
        let (response, cancels) = mirrored_upstream_response(instance, "GET", "/api/mobile/v1/sessions", "mirror-reader", 500, true).await;
        assert!(response.starts_with("HTTP/1.1 200 ") && response.contains("cached-session"), "{response}");
        assert_eq!(cancels, 0, "上游已结束时无需再取消");
    }

    #[tokio::test]
    async fn upstream_5xx_without_eligible_mirror_preserves_original_response() {
        let _guard = crate::mirror::test_lock();
        let instance = "proxy-5xx-original";
        remember_proxy_mirror(instance);
        for (method, target, credential, active_instance, status) in [
            ("GET", "/api/mobile/v1/sessions", "wrong-reader", instance, 500),
            ("GET", "/api/mobile/v1/sessions", "mirror-reader", "proxy-no-mirror", 500),
            ("GET", "/api/mobile/v1/sessions?fresh=1", "mirror-reader", instance, 500),
            ("GET", "/api/mobile/v1/sessions?archived=1", "mirror-reader", instance, 500),
            ("GET", "/api/mobile/v1/workspaces?offset=10", "mirror-reader", instance, 500),
            ("POST", "/api/mobile/v1/sessions", "mirror-reader", instance, 500),
            ("GET", "/api/mobile/v1/status", "mirror-reader", instance, 500),
            ("GET", "/api/mobile/v1/sessions", "mirror-reader", instance, 499),
            ("GET", "/api/mobile/v1/sessions", "mirror-reader", instance, 600),
            ("GET", "/api/mobile/v1/sessions", "mirror-reader", instance, 200),
        ] {
            let (response, cancels) = mirrored_upstream_response(active_instance, method, target, credential, status, true).await;
            assert!(response.starts_with(&format!("HTTP/1.1 {status} ")), "{method} {target}: {response}");
            assert!(response.contains("x-upstream: kept\r\n"), "{response}");
            assert!(response.ends_with(r#"{"ok":false,"error":{"code":"internal","message":"upstream failed"}}"#), "{response}");
            assert!(!response.contains("x-dsh-relay-mirror"), "{response}");
            assert_eq!(cancels, 0, "原响应无需取消");
        }
    }

    #[test]
    fn response_pauses_at_high_water_and_resumes_only_after_drain() {
        let (out, mut frames) = mpsc::channel(8);
        let tunnel = Tunnel::new(out);
        let (mut chunks, bytes) = response_entry(&tunnel, 1);
        let data = vec![7; RESPONSE_PAUSE_HIGH_BYTES];
        handle_tunnel_frame(&tunnel, "", t::HTTP_CHUNK, 1, &data);
        let message = frames.try_recv().expect("high water pause");
        assert_eq!(message.into_data().to_vec(), dsh_relay_protocol::encode_frame(t::HTTP_PAUSE, 1, &Payload::Empty).as_slice());
        assert_eq!(bytes.load(Ordering::SeqCst), data.len());
        resume_response_if_drained(&tunnel, 1);
        assert!(frames.try_recv().is_err(), "数据尚未写完不能resume");
        let ResponseChunk::Data(chunk) = chunks.try_recv().unwrap() else { panic!("data expected") };
        bytes.fetch_sub(chunk.len(), Ordering::SeqCst);
        resume_response_if_drained(&tunnel, 1);
        assert_eq!(frames.try_recv().unwrap().into_data().to_vec(), dsh_relay_protocol::encode_frame(t::HTTP_RESUME, 1, &Payload::Empty).as_slice());
        handle_tunnel_frame(&tunnel, "", t::HTTP_CHUNK, 1, b"tail");
        handle_tunnel_frame(&tunnel, "", t::HTTP_END, 1, &[]);
        assert!(matches!(chunks.try_recv(), Ok(ResponseChunk::Data(chunk)) if chunk == b"tail"));
        assert!(matches!(chunks.try_recv(), Ok(ResponseChunk::End)));
    }

    #[test]
    fn paused_response_ignores_upstream_idle_until_pause_deadline() {
        let tunnel = tunnel();
        let (_chunks, _bytes) = response_entry(&tunnel, 1);
        let mut pending = tunnel.pending.lock().unwrap();
        let Some(Pending::Http(entry)) = pending.get_mut(&1) else { panic!("HTTP missing") };
        entry.idle_deadline = Some(Instant::now() - std::time::Duration::from_secs(1));
        entry.paused_at = Some(Instant::now());
        assert!(!response_expired(entry), "已暂停的宿主不会继续发keepalive，不能判上游空闲");
        entry.paused_at = Some(Instant::now() - std::time::Duration::from_millis(RESPONSE_PAUSE_TIMEOUT_MS + 1));
        assert!(response_expired(entry), "暂停不能无期限占名额");
    }

    #[test]
    fn response_byte_limit_rejects_before_slot_limit() {
        let (out, mut frames) = mpsc::channel(8);
        let tunnel = Tunnel::new(out);
        let (mut chunks, bytes) = response_entry(&tunnel, 1);
        bytes.store(MAX_RESPONSE_QUEUE_BYTES, Ordering::SeqCst);
        handle_tunnel_frame(&tunnel, "", t::HTTP_CHUNK, 1, b"x");
        let pending = tunnel.pending.lock().unwrap();
        assert!(matches!(pending.get(&1), Some(Pending::Http(entry)) if entry.chunk_tx.is_none()), "写端未结束仍占名额");
        drop(pending);
        assert_eq!(bytes.load(Ordering::SeqCst), MAX_RESPONSE_QUEUE_BYTES, "拒绝帧不记账");
        assert!(matches!(chunks.try_recv(), Ok(ResponseChunk::End)), "超限不能投递截断的数据");
        assert_eq!(frames.try_recv().unwrap().into_data().to_vec(), dsh_relay_protocol::encode_frame(t::HTTP_CANCEL, 1, &Payload::Empty).as_slice());
    }

    async fn request_during_response_drain(tunnel: Arc<Tunnel>, config: Arc<Config>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let head = RequestHead { method: "GET".into(), path: "/api/mobile/v1/status".into(), query: String::new(), version: "HTTP/1.1".into(), headers: Vec::new() };
            proxy_request_with_config(BufReader::new(stream), head, tunnel, None, config).await.unwrap();
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        let mut response = String::new();
        tokio::time::timeout(std::time::Duration::from_secs(2), client.read_to_string(&mut response)).await.unwrap().unwrap();
        server.await.unwrap();
        response
    }

    #[tokio::test]
    async fn response_terminal_holds_capacity_until_actual_writer_drains() {
        for terminal in [t::HTTP_END, t::HTTP_ERROR] {
            let (out, _frames) = mpsc::channel(16);
            let tunnel = Tunnel::new(out);
            let (chunks, bytes) = response_entry(&tunnel, 1);
            let mut limits = Config::default();
            limits.max_pending = 1;
            let config = Arc::new(limits);
            let body = vec![9; 512 * 1024];
            handle_tunnel_frame(&tunnel, "", t::HTTP_CHUNK, 1, &body);
            handle_tunnel_frame(&tunnel, "", terminal, 1, br#"{"message":"done"}"#);
            handle_tunnel_frame(&tunnel, "", t::HTTP_CHUNK, 1, b"late");
            handle_tunnel_frame(&tunnel, "", t::HTTP_END, 1, &[]);
            let (mut phone, relay) = tokio::io::duplex(128);
            let writer_tunnel = tunnel.clone();
            let writer = tokio::spawn(async move { write_response_body(relay, &writer_tunnel, 1, chunks, bytes, false).await; });
            tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
            assert!(!writer.is_finished());
            assert_eq!(tunnel.capacity_snapshot().0, 1);
            let response = request_during_response_drain(tunnel.clone(), config.clone()).await;
            assert!(response.starts_with("HTTP/1.1 429 "), "{response}");
            let mut written = Vec::new();
            tokio::time::timeout(std::time::Duration::from_secs(5), phone.read_to_end(&mut written)).await.unwrap().unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(2), writer).await.unwrap().unwrap();
            let mut expected = body;
            if terminal == t::HTTP_ERROR { expected.extend_from_slice(b"upstream error: done"); }
            assert_eq!(written, expected, "终局不能截断已接收数据或再接受迟到帧");
            assert_eq!(tunnel.capacity_snapshot().0, 0);
            assert!(tunnel.has_capacity(&config, false), "实际写完后恢复名额");
        }
    }

    #[tokio::test]
    async fn failed_response_writer_releases_capacity_after_dropping_buffer() {
        let (out, _frames) = mpsc::channel(16);
        let tunnel = Tunnel::new(out);
        let (chunks, bytes) = response_entry(&tunnel, 1);
        handle_tunnel_frame(&tunnel, "", t::HTTP_CHUNK, 1, &vec![6; 512 * 1024]);
        let (phone, relay) = tokio::io::duplex(128);
        let writer_tunnel = tunnel.clone();
        let writer = tokio::spawn(async move { write_response_body(relay, &writer_tunnel, 1, chunks, bytes, false).await; });
        drop(phone);
        tokio::time::timeout(std::time::Duration::from_secs(2), writer).await.unwrap().unwrap();
        assert_eq!(tunnel.capacity_snapshot().0, 0);
    }

    #[tokio::test]
    async fn full_response_queue_delivers_terminal_after_all_data() {
        let (sender, mut receiver) = mpsc::channel(1);
        sender.try_send(ResponseChunk::Data(b"before".to_vec())).unwrap_or_else(|_| panic!("queue"));
        send_terminal(sender, ResponseChunk::End);
        assert!(matches!(receiver.recv().await, Some(ResponseChunk::Data(bytes)) if bytes == b"before"));
        assert!(matches!(receiver.recv().await, Some(ResponseChunk::End)));
    }

    async fn body_response(raw: &[u8], headers: Vec<(String, String)>, config: Config, half_close: bool) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (out, _frames) = mpsc::channel(32);
        let tunnel = Tunnel::new(out);
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(stream);
            let head = RequestHead { method: "POST".into(), path: "/api/mobile/v1/upload".into(), query: String::new(), version: "HTTP/1.1".into(), headers };
            assert!(!forward_body_or_respond(&mut reader, &head, &tunnel, 1, &config).await.unwrap());
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(raw).await.unwrap();
        if half_close { client.shutdown().await.unwrap(); }
        let mut response = String::new();
        tokio::time::timeout(std::time::Duration::from_secs(2), client.read_to_string(&mut response)).await.unwrap().unwrap();
        server.await.unwrap();
        response
    }

    #[tokio::test]
    async fn oversize_bodies_answer_413_for_each_framing() {
        let mut config = Config::default();
        config.max_body_bytes = 4;
        for (body, headers) in [
            (&b""[..], vec![("content-length".into(), "5".into())]),
            (&b"abcde"[..], Vec::new()),
            (&b"5\r\nabcde\r\n0\r\n\r\n"[..], vec![("transfer-encoding".into(), "chunked".into())]),
        ] {
            let response = body_response(body, headers, config.clone(), true).await;
            assert!(response.starts_with("HTTP/1.1 413 Payload Too Large\r\n"), "{response}");
        }
    }

    #[tokio::test]
    async fn body_idle_timeout_and_short_body_answer_without_waiting_for_host() {
        let mut config = Config::default();
        config.upstream_header_timeout_ms = 20;
        for (headers, raw, half_close, status) in [
            (vec![("content-length".into(), "2".into())], &b"x"[..], false, 408),
            (vec![("content-length".into(), "2".into())], &b"x"[..], true, 400),
            (vec![("transfer-encoding".into(), "chunked".into())], &b"1\r\nx"[..], false, 408),
        ] {
            let response = body_response(raw, headers, config.clone(), half_close).await;
            assert!(response.starts_with(&format!("HTTP/1.1 {status} ")), "{response}");
        }
    }

    /// 积压一动不动时必须有期限。
    ///
    /// 宿主读帧卡住（事件循环被堵、GC）时积压会一直停在高水位上，没有这个期限，手机的
    /// 上传就永远停在半路、中转那条 pending 一直挂着占名额。
    #[tokio::test]
    async fn feed_room_gives_up_when_backlog_never_drops() {
        let tunnel = tunnel();
        tunnel
            .backlog
            .store(TUNNEL_FEED_HIGH_WATER_BYTES + 1, Ordering::SeqCst);
        let started = Instant::now();
        assert!(!wait_for_feed_room(&tunnel, 50).await);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    /// 积压没到高水位就直接放行，不为「正常但慢」的上传白等。
    #[tokio::test]
    async fn feed_room_passes_below_high_water() {
        let tunnel = tunnel();
        tunnel
            .backlog
            .store(TUNNEL_FEED_HIGH_WATER_BYTES - 1, Ordering::SeqCst);
        assert!(wait_for_feed_room(&tunnel, 50).await);
    }
}
