//! 隧道接入与手机 WebSocket 桥接。
//!
//! 两条 WS 路径：
//!   - `/tunnel` —— 宿主的出站隧道。同一时刻只服务一条，新连接取代旧的。
//!   - 其余 —— 手机侧的 WS 桥接，把帧转发进隧道，由宿主连上游。
//!
//! 心跳与半开判定对齐 Node 版：隧道 15s ping、60s 没 pong 就认定死链；手机 WS 同形，
//! 但只 terminate **这一条**，不碰隧道。

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dsh_relay_protocol::{encode_close_payload, t, DecodeOutcome, FrameDecoder, Payload};
use futures_util::{SinkExt, StreamExt};
use tokio::io::BufReader;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::http::RequestHead;
use crate::tunnel::{log, Pending, Tunnel, TunnelSlot, WsPending};

type WsReader = BufReader<TcpStream>;

/// 把已经读过请求头的连接接管成 WebSocket。
async fn upgrade(reader: WsReader, head: &RequestHead) -> Option<WebSocketStream<PrefixedStream>> {
    // tokio-tungstenite 的 `from_raw_socket` 需要不含请求头的裸流；已经读掉的头不再参与
    // 握手，所以这里手工构造 101 响应，再把流交给它按服务端角色管理帧。
    let mut reader = reader;
    {
        let stream = reader.get_mut();
        let key = head.header("sec-websocket-key").unwrap_or("");
        let accept = accept_key(key);
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: {accept}\r\n\r\n"
        );
        if tokio::io::AsyncWriteExt::write_all(stream, response.as_bytes())
            .await
            .is_err()
        {
            return None;
        }
        let _ = tokio::io::AsyncWriteExt::flush(stream).await;
    }
    // 必须把 BufReader 里可能已经缓冲的残留字节一起交给它：客户端收到 101 之后立刻
    // 就会发帧，那些字节可能已经被预读进缓冲里，直接丢进裸流会看不见它们。
    let pending = reader.buffer().to_vec();
    let stream = reader.into_inner();
    let prefixed = PrefixedStream::new(pending, stream);
    Some(WebSocketStream::from_raw_socket(prefixed, Role::Server, None).await)
}

/// RFC 6455 的 `Sec-WebSocket-Accept`：base64(sha1(key + GUID))。
fn accept_key(key: &str) -> String {
    // 不引 sha1/base64 依赖就要自己实现；这里用最小的实现，避免为握手续两个 crate。
    const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    let mut input = key.as_bytes().to_vec();
    input.extend_from_slice(GUID.as_bytes());
    base64_encode(&sha1(&input))
}

/// 最小 SHA-1。
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut message = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in message.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, item) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*item);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }

    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

/// 最小 base64 编码（标准字母表，带 padding）。
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// 接管一条宿主隧道。
pub async fn accept_tunnel(
    reader: WsReader,
    head: RequestHead,
    slot: Arc<TunnelSlot>,
    peer: Option<std::net::SocketAddr>,
) -> std::io::Result<()> {
    // 准入：**在握手之前**判，判不过就直接回 401，连 ws 都不建立。
    //
    // 为什么不放在 `register` 帧里：那条路只有真实插件会走。任何人拿一个最简 ws
    // 客户端直接连 `/tunnel`（不注册）就能建起隧道，绕开限制。中转是路径的关口，
    // 判据必须落在门口的协议层，而不是落在某一种客户端的行为里。
    //
    // 激活码从**请求头**带（`x-dsh-license`），不走查询串：查询串会进 nginx 的
    // access log，等于把码写进日志。
    if let Some(console) = crate::console() {
        let license = head.header("x-dsh-license").unwrap_or_default();
        if let Err(reason) = console.check_admission(license) {
            log(format!("tunnel rejected at handshake: {reason}"));
            let mut reader = reader;
            let body = format!(r#"{{"ok":false,"error":"{reason}"}}"#);
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = tokio::io::AsyncWriteExt::write_all(reader.get_mut(), response.as_bytes()).await;
            return Ok(());
        }
    }

    let Some(ws) = upgrade(reader, &head).await else {
        return Ok(());
    };

    let (out_tx, mut out_rx) = mpsc::channel::<Message>(1024);
    let tunnel = Tunnel::new(out_tx);

    // 这里**先不登记**。这台是哪个实例要等 `register` 帧到了才知道，而公用中转上
    // 「谁」决定了后续请求发给谁——先挂上去再改名，中间那段窗口里的请求会发给一台
    // 还没自报家门的机器。
    log(format!(
        "tunnel connected remote={}",
        peer.map(|p| p.to_string()).unwrap_or_default()
    ));

    let (mut sink, mut source) = ws.split();
    let last_pong = Arc::new(AtomicI64::new(now_ms()));

    // 写任务：把 out_rx 里的帧串行写出去，写完再减积压。
    let backlog = tunnel.backlog_handle();
    let tunnel_for_write = tunnel.clone();
    let writer = tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            let len = match &message {
                Message::Binary(bytes) => bytes.len() as i64,
                _ => 0,
            };
            if let Err(error) = sink.send(message).await {
                log(format!("tunnel write failed: {error}"));
                break;
            }
            if len > 0 {
                backlog.fetch_sub(len, Ordering::SeqCst);
            }
            if tunnel_for_write.is_closed() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // 心跳：阈值到了真正掐断读循环。
    //
    // 只把 `closed` 置位是不够的——读循环此时阻塞在 `source.next()` 上，标志位没有任何
    // 东西去看它，表现为「日志说终止了，连接还挂着」。所以用一条 oneshot 通知它退出。
    let (kill_tx, kill_rx) = tokio::sync::oneshot::channel::<()>();
    let heartbeat = {
        let tunnel = tunnel.clone();
        let last_pong = last_pong.clone();
        let config = crate::config();
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(Duration::from_millis(config.tunnel_heartbeat_ms));
            loop {
                interval.tick().await;
                if tunnel.is_closed() {
                    break;
                }
                if now_ms() - last_pong.load(Ordering::SeqCst) > config.tunnel_pong_timeout_ms as i64 {
                    log("tunnel heartbeat timeout, terminating");
                    tunnel.mark_closed();
                    let _ = kill_tx.send(());
                    break;
                }
                tunnel.send_empty(t::PING, 0);
            }
        })
    };

    // 读循环：解帧 → 代次守卫 → 分发。心跳超时会通过 kill_rx 打断它。
    let mut decoder = FrameDecoder::new(crate::config().max_frame_bytes);
    let mut kill_rx = kill_rx;
    loop {
        let message = tokio::select! {
            next = source.next() => match next {
                Some(Ok(message)) => message,
                _ => break,
            },
            _ = &mut kill_rx => {
                log("tunnel killed by heartbeat timeout");
                break;
            }
        };
        let bytes = match message {
            Message::Binary(bytes) => bytes,
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Text(_text) => continue,
            Message::Close(_) => break,
            Message::Frame(_) => continue,
        };
        tunnel.touch();

        // 代次守卫：被取代的旧连接仍可能推帧，不能落进新隧道的 pending。
        if !slot.is_current(&tunnel) {
            break;
        }

        let mut frames: Vec<(u8, u32, Vec<u8>)> = Vec::new();
        let outcome = decoder.push(&bytes, |frame| {
            frames.push((frame.frame_type, frame.id, frame.payload.to_vec()));
        });
        if outcome == DecodeOutcome::FrameTooLarge {
            log("tunnel frame too large, closing");
            break;
        }
        for (frame_type, id, payload) in frames {
            tunnel.touch();
            if frame_type == t::PONG {
                last_pong.store(now_ms(), Ordering::SeqCst);
                continue;
            }
            if frame_type == t::PING {
                tunnel.send_empty(t::PONG, 0);
                continue;
            }
            // 注册回执：宿主连上后先发 `register`，**等中转回 `registered`** 才算连上，
            // 8 秒收不到就自己断开重连。少了这一步，宿主的隧道一直在「连上→超时→重连」
            // 里打转，而 `/status` 还显示已连接——看着通、实际用不了。
            //
            // 中转按「一条隧道、不解释业务」的边界**不保存也不校验**注册帧里的
            // instanceId / 配对码，只做回执；准入只管激活码（见下面）。
            if frame_type == t::REGISTER {
                let request: serde_json::Value =
                    serde_json::from_slice(&payload).unwrap_or(serde_json::Value::Null);
                let license = request
                    .get("license")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if let Some(console) = crate::console() {
                    // 握手阶段已经判过一轮（那条对所有客户端生效）；这里再判一次是为了
                    // 「租期中途被吊销」：连上之后把码吊销掉，宿主的重连会被握手挡住，
                    // 而已经在跑的这条也会在下次注册时被踢掉。
                    if let Err(reason) = console.check_admission(license) {
                        // 拒绝时**不能回 `registered`**：宿主那半边只看帧类型、不看内容，
                        // 回了它就会当成「连上了」。所以发一条 wsError 说明原因，然后直接断开。
                        log(format!("tunnel rejected: {reason}"));
                        tunnel.send_json(
                            t::WS_ERROR,
                            0,
                            &format!(r#"{{"message":"{reason}"}}"#),
                        );
                        break;
                    }
                }
                // **实例 id 在注册帧里，这是公用中转分发的唯一依据。**
                // 没带 id 的连接仍然接受（比如老版本宿主），但它收不到任何按实例
                // 分发的请求——宁可让它当哑巴，也不要把别人的请求发给它。
                let instance_id = request
                    .get("instanceId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                if instance_id.is_empty() {
                    log("tunnel registered without instanceId; it will receive no requests");
                } else if let Some(previous) = slot.register(&instance_id, tunnel.clone()) {
                    // 同一台机器的重连：新连接直接赢，把旧的收掉。
                    //
                    // **顺序要紧**：表里已经换成新连接了，这里只处理旧连接自己的收尾
                    // （标记关闭 + 让它的在途请求快速失败），绝不再动表——旧连接那边的
                    // 清理分支晚一步跑起来时会用 `clear_if_current` 自查，指针不是它就不动。
                    log(format!("replacing existing tunnel for instance={instance_id}"));
                    previous.mark_closed();
                    crate::proxy::fail_all_pending(&previous, "replaced");
                }
                tunnel.send_json(t::REGISTERED, 0, r#"{"ok":true}"#);
                continue;
            }
            crate::proxy::handle_tunnel_frame(&tunnel, frame_type, id as u64, &payload);
        }
    }

    heartbeat.abort();
    writer.abort();
    tunnel.mark_closed();
    // 把这条从表里摘掉。**只有它还挂在表里时才摘**——被重连顶掉的旧连接晚一步
    // 走到这里，表里已经是新连接了，摘不得。
    let removed = slot.clear_if_current(&tunnel);
    crate::proxy::fail_all_pending(&tunnel, "tunnel closed");
    log(format!(
        "tunnel closed (removed={removed}, online={})",
        slot.online_count()
    ));
    Ok(())
}

/// 接管一条手机 WebSocket 连接。
pub async fn accept_phone_ws(
    reader: WsReader,
    head: RequestHead,
    slot: Arc<TunnelSlot>,
) -> std::io::Result<()> {
    // 与 HTTP 走同一套分发：手机 WS 也带着 `X-Dsh-Instance`，找不到就不接。
    let instance = head.header("x-dsh-instance").unwrap_or_default();
    let Some(tunnel) = slot.get_for(instance) else {
        let mut reader = reader;
        let stream = reader.get_mut();
        let response = "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n";
        let _ = tokio::io::AsyncWriteExt::write_all(stream, response.as_bytes()).await;
        return Ok(());
    };

    if tunnel.ws_count() >= crate::config().max_ws_connections || !tunnel.has_capacity(&crate::config(), false) {
        let mut reader = reader;
        let stream = reader.get_mut();
        let response =
            "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n";
        let _ = tokio::io::AsyncWriteExt::write_all(stream, response.as_bytes()).await;
        return Ok(());
    }

    let Some(ws) = upgrade(reader, &head).await else {
        return Ok(());
    };

    let id = tunnel.alloc_id();
    let (phone_tx, mut phone_rx) = mpsc::channel::<Message>(256);
    {
        let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.insert(
            id,
            Pending::Ws(WsPending {
                phone_tx: phone_tx.clone(),
                ready: false,
                queued: Vec::new(),
                queued_bytes: 0,
                last_active: Instant::now(),
            }),
        );
    }

    // 告诉宿主：为这个 id 开一条上游 WS。
    let headers: Vec<(String, String)> = crate::headers::pick_forward_headers(
        head.headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str())),
    );
    let payload = serde_json::json!({
        "path": head.routed_path(),
        "headers": headers.iter().cloned().collect::<std::collections::BTreeMap<_, _>>(),
    })
    .to_string();
    tunnel.send_json(t::WS_UPGRADE, id, &payload);

    let (mut sink, mut source) = ws.split();
    let phone_writer = tokio::spawn(async move {
        while let Some(message) = phone_rx.recv().await {
            if let Err(error) = sink.send(message).await {
                log(format!("tunnel write failed: {error}"));
                break;
            }
        }
        let _ = sink.close().await;
    });

    // 半开判定：15s ping，60s 既没 pong 也没上行帧就 terminate 这一条。
    let heartbeat = {
        let tunnel = tunnel.clone();
        let config = crate::config();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(config.ws_heartbeat_ms));
            loop {
                interval.tick().await;
                let idle = {
                    let pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                    match pending.get(&id) {
                        Some(Pending::Ws(ws)) => ws.last_active.elapsed(),
                        _ => return,
                    }
                };
                if idle > Duration::from_millis(config.ws_pong_timeout_ms) {
                    // 半开：既没 pong 也没上行帧。只关这一条手机 WS，不碰隧道。
                    let sender = {
                        let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                        match pending.remove(&id) {
                            Some(Pending::Ws(entry)) => Some(entry.phone_tx),
                            _ => None,
                        }
                    };
                    tunnel.send_frame(t::WS_CLOSE, id, Payload::Bytes(dsh_relay_protocol::encode_close_payload(1001, "ws heartbeat timeout")));
                    if let Some(sender) = sender {
                        let _ = sender.try_send(close_frame(1001, "ws heartbeat timeout"));
                    }
                    return;
                }
                // 发 WS 协议层的 ping（客户端栈会自动回 pong），不是隧道的应用层 ping：
                // 应用层 ping 是给宿主的那条连接用的，发错地方手机根本不认识。
                let sender = {
                    let pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                    match pending.get(&id) {
                        Some(Pending::Ws(entry)) => Some(entry.phone_tx.clone()),
                        _ => None,
                    }
                };
                if let Some(sender) = sender {
                    let _ = sender.try_send(Message::Ping(Vec::new().into()));
                }
            }
        })
    };

    while let Some(message) = source.next().await {
        let message = match message {
            Ok(message) => message,
            Err(_) => break,
        };
        {
            let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
            match pending.get_mut(&id) {
                Some(Pending::Ws(ws)) => ws.last_active = Instant::now(),
                _ => break,
            }
        }
        match message {
            Message::Text(text) => {
                let bytes = text.as_bytes();
                if bytes.len() > crate::config().max_ws_message_bytes {
                    tunnel.send_frame(t::WS_CLOSE, id, Payload::Empty);
                    break;
                }
                if !tunnel.send_frame(t::WS_TEXT, id, Payload::Bytes(bytes.to_vec())) {
                    break;
                }
            }
            Message::Binary(bytes) => {
                if bytes.len() > crate::config().max_ws_message_bytes {
                    tunnel.send_frame(t::WS_CLOSE, id, Payload::Empty);
                    break;
                }
                if !tunnel.send_frame(t::WS_BINARY, id, Payload::Bytes(bytes.to_vec())) {
                    break;
                }
            }
            Message::Pong(_) => {
                // pong 也算活着：只认上行帧的话，一个只收不发的连接会被误杀。
                let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(Pending::Ws(entry)) = pending.get_mut(&id) {
                    entry.last_active = Instant::now();
                }
            }
            Message::Ping(payload) => {
                let mut pending = tunnel.pending.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(Pending::Ws(entry)) = pending.get_mut(&id) {
                    entry.last_active = Instant::now();
                    let _ = entry.phone_tx.try_send(Message::Pong(payload));
                }
            }
            Message::Close(frame) => {
                let code = frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(1000);
                let reason = frame
                    .as_ref()
                    .map(|f| f.reason.to_string())
                    .unwrap_or_default();
                let payload = encode_close_payload(code, &reason);
                tunnel.send_frame(t::WS_CLOSE, id, Payload::Bytes(payload));
                break;
            }
            Message::Frame(_) => {}
        }
    }

    heartbeat.abort();
    phone_writer.abort();
    tunnel
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把宿主推回来的 wsClose 载荷变成一个关闭帧。
pub fn close_from_tunnel_payload(payload: &[u8]) -> Message {
    let (code, _raw, _valid, reason) = dsh_relay_protocol::decode_close_payload(payload);
    close_frame(code, &reason)
}

/// 构造一个关闭帧（宿主侧要求关闭时用）。
pub fn close_frame(code: u16, reason: &str) -> Message {
    let payload = encode_close_payload(code, reason);
    let actual_code = u16::from_be_bytes([payload[0], payload[1]]);
    let text = String::from_utf8_lossy(&payload[2..]).into_owned();
    Message::Close(Some(CloseFrame {
        code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::from(actual_code),
        reason: text.into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accept_key_matches_rfc_example() {
        // RFC 6455 §1.3 的示例。
        assert_eq!(
            accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn sha1_matches_known_digest() {
        // "abc" 的 SHA-1。
        let digest = sha1(b"abc");
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "a9993e364706816aba3e25717850c26c9cd0d89d");
    }
}

/// 把一个已经读出来的字节前缀重新接到流前面。
///
/// 存在理由：请求头是用 `BufReader` 读的，它会把后续字节一起预读进缓冲。WebSocket
/// 客户端在收到 101 之后立刻发帧，那些字节就躺在缓冲里——直接 `into_inner()` 会把它们
/// 丢掉，表现为「连上了但一个帧都收不到」。这个包装让读方向先吐前缀，再吐真实流。
pub struct PrefixedStream {
    prefix: std::io::Cursor<Vec<u8>>,
    inner: TcpStream,
}

impl PrefixedStream {
    pub fn new(prefix: Vec<u8>, inner: TcpStream) -> Self {
        Self {
            prefix: std::io::Cursor::new(prefix),
            inner,
        }
    }
}

impl tokio::io::AsyncRead for PrefixedStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let remaining = this.prefix.get_ref().len() as u64 - this.prefix.position();
        if remaining > 0 {
            let before = buf.filled().len();
            match std::pin::Pin::new(&mut this.prefix).poll_read(cx, buf) {
                std::task::Poll::Ready(Ok(())) => {
                    // Cursor 读完会返回 Ok 但不填字节；那时继续读真实流。
                    if buf.filled().len() > before {
                        return std::task::Poll::Ready(Ok(()));
                    }
                }
                other => return other,
            }
        }
        std::pin::Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl tokio::io::AsyncWrite for PrefixedStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}
