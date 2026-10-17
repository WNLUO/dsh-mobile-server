//! HTTP 转发与隧道帧分发。
//!
//! 两个方向都有背压，落点不同：
//!   - 响应方向（宿主 → 手机）：手机读得慢时发 `httpPause` 请宿主停下，手机可写了再
//!     `httpResume`。这里靠 `write()` 的返回值判断，等价于 Node 版 `res.write()` 的返回值。
//!   - 请求方向（手机 → 宿主）：隧道积压到高水位就停读手机的请求体，回落到低水位再继续。
//!     协议上不需要新帧，宿主只是暂时收不到 `httpBody`。

use std::sync::Arc;
use std::time::Instant;

use dsh_relay_protocol::{t, Payload};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::oneshot;

use crate::config::Config;
use crate::headers::pick_forward_headers;
use crate::http::{respond_json, respond_text, RequestHead};
use crate::tunnel::{
    log, HttpHead, HttpPending, Pending, Tunnel, TunnelSlot, TUNNEL_FEED_HIGH_WATER_BYTES,
};
use crate::ws;

/// SSE 空闲哨兵阈值：宿主侧 keepalive 是每 15s 一行注释，30s 一个字节都没有就说明
/// 上游既不产出也不会终止。
const SSE_IDLE_TIMEOUT_MS: u64 = 30_000;

/// 隧道积压回落到低水位之后恢复读的轮询间隔。
const FEED_RESUME_POLL_MS: u64 = 25;

/// 一次 HTTP 请求的响应用途（从宿主推回来的数据写向手机）。
struct ResponseSink<'a> {
    writer: &'a mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    started: bool,
    paused: bool,
}

/// 处理一次普通 HTTP 转发：把请求送进隧道，等宿主把响应推回来。
pub async fn proxy_request(
    reader: BufReader<TcpStream>,
    head: RequestHead,
    tunnel: Arc<Tunnel>,
    _slot: Arc<TunnelSlot>,
) -> std::io::Result<()> {
    let config = crate::config();
    let is_sse = head
        .header("accept")
        .map(|v| v.to_ascii_lowercase().contains("text/event-stream"))
        .unwrap_or(false);

    let mut reader = reader;
    if !tunnel.has_capacity(&config, is_sse) {
        respond_text(&mut reader, 429, "relay resource limit exceeded").await?;
        return Ok(());
    }

    let id = tunnel.alloc_id();
    let (head_tx, head_rx) = oneshot::channel::<HttpHead>();
    // 响应通道必须**在插入 pending 时就建好**：宿主收到 httpRequest 后会立刻回
    // httpHead、紧接着就推 chunk，而我们此刻还在等 head_rx。等 httpHead 之后再建
    // 通道，这中间到达的数据会被整段丢掉（表现为响应体是空的）。
    let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel::<ResponseChunk>(256);
    {
        let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.insert(
            id,
            Pending::Http(HttpPending {
                sse: is_sse,
                head_tx: Some(head_tx),
                header_deadline: Some(
                    Instant::now() + std::time::Duration::from_millis(config.upstream_header_timeout_ms),
                ),
                idle_deadline: None,
                chunk_tx: Some(chunk_tx.clone()),
            }),
        );
    }

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
        tunnel
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        respond_text(&mut reader, 502, "tunnel unavailable").await?;
        return Ok(());
    }

    // 请求体：按 content-length 或读到结束，分块发进去。
    forward_request_body(&mut reader, &head, &tunnel, id, &config).await;

    // 等宿主回 httpHead（带超时）。
    let head_result = tokio::time::timeout(
        std::time::Duration::from_millis(config.upstream_header_timeout_ms),
        head_rx,
    )
    .await;

    let Ok(Ok(http_head)) = head_result else {
        // 超时或宿主没回：通知宿主取消，给手机 504。
        let still_ours = {
            let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
            pending.remove(&id).is_some()
        };
        if still_ours {
            tunnel.send_empty(t::HTTP_CANCEL, id);
            respond_text(&mut reader, 504, "upstream response timeout").await?;
        }
        return Ok(());
    };

    // 写响应头，然后把后续 chunk 流式写给手机。
    let chunked = write_response_head(&mut reader, &http_head).await?;

    // 从这里开始由响应侧接管：等待 httpChunk / httpEnd，由 `handle_tunnel_frame` 把数据
    // 推进同一个连接。为此需要把连接的所有权交给一个专门的写任务，主流程在这里等它结束。
    let writer_stream = reader.into_inner();
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
                let expired = {
                    let pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                    match pending.get(&id) {
                        Some(Pending::Http(entry)) => entry
                            .idle_deadline
                            .map(|deadline| Instant::now() >= deadline)
                            .unwrap_or(false),
                        _ => return, // 条目已经不在（正常结束或被取消），哨兵退休
                    }
                };
                if expired {
                    log(format!("sse idle timeout: id={id} (>{SSE_IDLE_TIMEOUT_MS}ms)"));
                    let sender = {
                        let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                        match pending.remove(&id) {
                            Some(Pending::Http(entry)) => entry.chunk_tx,
                            _ => None,
                        }
                    };
                    tunnel.send_empty(t::HTTP_CANCEL, id);
                    if let Some(sender) = sender {
                        let _ = sender.try_send(ResponseChunk::End);
                    }
                    return;
                }
            }
        })
    };

    let mut stream = writer_stream;
    while let Some(chunk) = chunk_rx.recv().await {
        match chunk {
            ResponseChunk::Data(bytes) => {
                let wire = if chunked { encode_chunk(&bytes) } else { bytes.clone() };
                if stream.write_all(&wire).await.is_err() {
                    tunnel.send_empty(t::HTTP_CANCEL, id);
                    break;
                }
                if stream.flush().await.is_err() {
                    tunnel.send_empty(t::HTTP_CANCEL, id);
                    break;
                }
            }
            ResponseChunk::End => {
                if chunked {
                    let _ = stream.write_all(b"0\r\n\r\n").await;
                    let _ = stream.flush().await;
                }
                let _ = stream.shutdown().await;
                break;
            }
            ResponseChunk::Error(message) => {
                let body = format!("upstream error: {message}");
                if chunked {
                    let _ = stream.write_all(&encode_chunk(body.as_bytes())).await;
                    let _ = stream.write_all(b"0\r\n\r\n").await;
                } else {
                    let _ = stream.write_all(body.as_bytes()).await;
                }
                let _ = stream.shutdown().await;
                break;
            }
        }
    }

    tunnel
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    Ok(())
}

/// 解析控制帧的 JSON 载荷（失败返回空对象），对齐 JS 侧 `parseJson`。
fn parse_json_value(payload: &[u8]) -> serde_json::Value {
    serde_json::from_slice(payload).unwrap_or_else(|_| serde_json::json!({}))
}

/// 响应方向上推进给手机的一段数据。
pub enum ResponseChunk {
    Data(Vec<u8>),
    End,
    Error(String),
}

/// 把请求体分块送进隧道，带请求方向背压。
async fn forward_request_body(
    reader: &mut BufReader<TcpStream>,
    head: &RequestHead,
    tunnel: &Arc<Tunnel>,
    id: u64,
    config: &Config,
) {
    let mut sent_bytes = 0usize;
    let mut buffer = vec![0u8; 64 * 1024];

    // chunked 请求体：按 chunk 逐个解出来转发。手机 App 发的是普通请求，但任何
    // 中转/代理层都可能改写成 chunked，不解码就是死锁（见下面的说明）。
    if head.is_chunked() {
        forward_chunked_body(reader, tunnel, id, config, &mut buffer).await;
        return;
    }

    if let Some(length) = head.content_length() {
        if length == 0 {
            tunnel.send_frame(t::HTTP_BODY, id, Payload::Empty);
            return;
        }
        let mut remaining = length;
        while remaining > 0 {
            let want = buffer.len().min(remaining);
            let read = match reader.read(&mut buffer[..want]).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => {
                    tunnel.send_empty(t::HTTP_CANCEL, id);
                    return;
                }
            };
            remaining -= read;
            sent_bytes += read;
            if sent_bytes > config.max_body_bytes {
                tunnel.send_empty(t::HTTP_CANCEL, id);
                return;
            }
            if !tunnel.send_frame(t::HTTP_BODY, id, Payload::Bytes(buffer[..read].to_vec())) {
                tunnel.send_empty(t::HTTP_CANCEL, id);
                return;
            }
            // 请求方向背压：积压到高水位就等回落到低水位再继续读。
            while tunnel.backlog() > TUNNEL_FEED_HIGH_WATER_BYTES && !tunnel.is_closed() {
                tokio::time::sleep(std::time::Duration::from_millis(FEED_RESUME_POLL_MS)).await;
            }
        }
        tunnel.send_frame(t::HTTP_BODY, id, Payload::Empty);
        return;
    }

    // 没有 content-length 的头。GET / HEAD / DELETE / OPTIONS 这些方法按规范就没有请求体，
    // 直接发结束帧即可——**不能**落到下面「读到连接关闭」的分支：客户端在等响应、
    // 我们在等它的字节，两边互等就是死锁（同一个连接上也永远等不到 EOF）。
    let bodyless = matches!(head.method.as_str(), "GET" | "HEAD" | "DELETE" | "OPTIONS" | "TRACE");
    if bodyless && !head.is_chunked() {
        tunnel.send_frame(t::HTTP_BODY, id, Payload::Empty);
        return;
    }

    // 没有 content-length 但可能带体的方法：读到连接关闭为止，受 max_body_bytes 约束。
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(n) => {
                sent_bytes += n;
                if sent_bytes > config.max_body_bytes {
                    respond_body_too_large(tunnel, id);
                    return;
                }
                if !tunnel.send_frame(t::HTTP_BODY, id, Payload::Bytes(buffer[..n].to_vec())) {
                    tunnel.send_empty(t::HTTP_CANCEL, id);
                    return;
                }
            }
            Err(_) => {
                tunnel.send_empty(t::HTTP_CANCEL, id);
                return;
            }
        }
    }
    tunnel.send_frame(t::HTTP_BODY, id, Payload::Empty);
}

/// 解码 `Transfer-Encoding: chunked` 的请求体并逐块转发。
///
/// 格式：`<十六进制长度>[;扩展]\r\n<数据>\r\n` … `0\r\n\r\n`。
/// 解出来的数据不带长度前缀，直接作为 httpBody 帧送给宿主。
async fn forward_chunked_body(
    reader: &mut BufReader<TcpStream>,
    tunnel: &Arc<Tunnel>,
    id: u64,
    config: &Config,
    buffer: &mut [u8],
) {
    let mut total = 0usize;
    loop {
        // 读一行 chunk 头。
        let mut line = String::new();
        match tokio::io::AsyncBufReadExt::read_line(reader, &mut line).await {
            Ok(0) => {
                tunnel.send_empty(t::HTTP_CANCEL, id);
                return;
            }
            Ok(_) => {}
            Err(_) => {
                tunnel.send_empty(t::HTTP_CANCEL, id);
                return;
            }
        }
        let size_text = line.trim().split(';').next().unwrap_or("").trim();
        let size = match usize::from_str_radix(size_text, 16) {
            Ok(size) => size,
            Err(_) => {
                tunnel.send_empty(t::HTTP_CANCEL, id);
                return;
            }
        };
        if size == 0 {
            // 末尾可能还有 trailer，读到空行为止。
            loop {
                let mut trailer = String::new();
                match tokio::io::AsyncBufReadExt::read_line(reader, &mut trailer).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if trailer.trim().is_empty() {
                            break;
                        }
                    }
                }
            }
            tunnel.send_frame(t::HTTP_BODY, id, Payload::Empty);
            return;
        }

        let mut remaining = size;
        while remaining > 0 {
            let want = buffer.len().min(remaining);
            let read = match reader.read(&mut buffer[..want]).await {
                Ok(0) => {
                    tunnel.send_empty(t::HTTP_CANCEL, id);
                    return;
                }
                Ok(n) => n,
                Err(_) => {
                    tunnel.send_empty(t::HTTP_CANCEL, id);
                    return;
                }
            };
            remaining -= read;
            total += read;
            if total > config.max_body_bytes {
                tunnel.send_empty(t::HTTP_CANCEL, id);
                return;
            }
            if !tunnel.send_frame(t::HTTP_BODY, id, Payload::Bytes(buffer[..read].to_vec())) {
                tunnel.send_empty(t::HTTP_CANCEL, id);
                return;
            }
            while tunnel.backlog() > TUNNEL_FEED_HIGH_WATER_BYTES && !tunnel.is_closed() {
                tokio::time::sleep(std::time::Duration::from_millis(FEED_RESUME_POLL_MS)).await;
            }
        }
        // 吃掉 chunk 后面的 CRLF。
        let mut crlf = [0u8; 2];
        let _ = reader.read_exact(&mut crlf).await;
    }
}

fn respond_body_too_large(tunnel: &Arc<Tunnel>, id: u64) {
    tunnel.send_empty(t::HTTP_CANCEL, id);
    tunnel
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
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
pub fn handle_tunnel_frame(tunnel: &Arc<Tunnel>, frame_type: u8, id: u64, payload: &[u8]) {
    match frame_type {
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
                    Some(Pending::Http(entry)) => entry.head_tx.take(),
                    _ => None,
                }
            };
            if let Some(sender) = sender {
                let _ = sender.send(HttpHead { status, headers });
            }
        }
        t::HTTP_CHUNK => {
            let sender = {
                let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                match pending.get_mut(&id) {
                    Some(Pending::Http(entry)) => {
                        entry.idle_deadline =
                            Some(Instant::now() + std::time::Duration::from_millis(SSE_IDLE_TIMEOUT_MS));
                        entry.chunk_tx.clone()
                    }
                    _ => None,
                }
            };
            if let Some(sender) = sender {
                if sender.try_send(ResponseChunk::Data(payload.to_vec())).is_err() {
                    log(format!("response chunk dropped id={id}（通道满或已关闭）"));
                }
            }
        }
        t::HTTP_END => {
            let sender = {
                let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                match pending.remove(&id) {
                    Some(Pending::Http(entry)) => entry.chunk_tx,
                    _ => None,
                }
            };
            if let Some(sender) = sender {
                let _ = sender.try_send(ResponseChunk::End);
            }
        }
        t::HTTP_ERROR => {
            let value = parse_json_value(payload);
            let message = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let sender = {
                let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                match pending.remove(&id) {
                    Some(Pending::Http(entry)) => entry.chunk_tx,
                    _ => None,
                }
            };
            if let Some(sender) = sender {
                let _ = sender.try_send(ResponseChunk::Error(message));
            }
        }
        t::WS_OPEN => {
            let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(Pending::Ws(entry)) = pending.get_mut(&id) {
                entry.ready = true;
                // 排空未就绪时暂存的上行帧。
                for message in entry.queued.drain(..) {
                    let _ = entry.phone_tx.try_send(message);
                }
                entry.queued_bytes = 0;
            }
        }
        t::WS_TEXT | t::WS_BINARY => {
            let pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(Pending::Ws(entry)) = pending.get(&id) {
                let message = if frame_type == t::WS_TEXT {
                    tokio_tungstenite::tungstenite::Message::Text(
                        String::from_utf8_lossy(payload).into_owned().into(),
                    )
                } else {
                    tokio_tungstenite::tungstenite::Message::Binary(payload.to_vec().into())
                };
                if let Err(error) = entry.phone_tx.try_send(message) {
                    log(format!("phone ws send failed id={id}: {error}"));
                }
            }
        }
        t::WS_CLOSE => {
            let pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
            let message = ws::close_from_tunnel_payload(payload);
            if let Some(Pending::Ws(entry)) = pending.get(&id) {
                let _ = entry.phone_tx.try_send(message);
            }
        }
        t::WS_ERROR => {
            let pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(Pending::Ws(entry)) = pending.get(&id) {
                let _ = entry.phone_tx.try_send(ws::close_frame(1011, "upstream ws error"));
            }
        }
        _ => {
            // 未知帧按 Node 版的做法静默丢弃（不报错、不回执）。
        }
    }
}

/// 隧道断开或被取代时，把这条隧道上还没结束的请求一次性失败掉。
///
/// 不清理的后果是这些条目永久留在 pending 里：HTTP 响应永不结束、手机 WS 停在 OPEN，
/// 客户端只能等自己的超时。
pub fn fail_all_pending(tunnel: &Arc<Tunnel>, reason: &str) {
    let entries: Vec<(u64, Pending)> = {
        let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.drain().collect()
    };
    for (_, entry) in entries {
        match entry {
            Pending::Http(http) => {
                // 已经发出响应头的，把错误写进响应体收尾。
                if let Some(sender) = http.chunk_tx {
                    let _ = sender.try_send(ResponseChunk::Error(format!("upstream unavailable: {reason}")));
                }
                // 还在等响应头的，用一个「上游不可用」的头叫醒它——它会把这次请求结束成
                // 502。**不能**只 drop 发送端：那会被上层当成「宿主没回」，最后报 504，
                // 而这里不是超时，是隧道没了。
                if let Some(sender) = http.head_tx {
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
                let _ = ws.phone_tx.try_send(ws::close_frame(1011, reason));
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
