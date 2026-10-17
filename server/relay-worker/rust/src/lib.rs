//! DSH Workers 版中转（Rust）。
//!
//! 与 Node 版同一个协议、同一套行为，但宿主环境完全不同：
//!   - 没有常驻进程，一个请求一个实例，Durable Object 负责把状态收拢在一处；
//!   - WebSocket 走 Hibernation：对象会被休眠，**内存里的东西随之消失**，
//!     所以任何跨消息的状态都必须落到 socket attachment 或 `state.storage` 里；
//!   - 一次事件处理有 CPU 时间上限，长活儿要 `waitUntil` 出去。
//!
//! 这几条决定了这里的写法与 `server/relay/rust`（Node 版）不可能逐行对应，但**线上
//! 行为**要对齐，由 `server/relay-core/test/` 与 `tests/` 下的用例守着。

use std::cell::RefCell;

use serde::{Deserialize, Serialize};
use wasm_bindgen::JsCast;
use worker::*;

thread_local! {
    /// 单次事件内的帧 id 计数。不用 storage：那要 await，而分配 id 发生在同步路径上。
    /// 对象休眠后旧请求都已结束，从 1 重新开始不会与在途 id 冲突。
    static NEXT_ID: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// 睡一会儿。Workers 里没有 tokio，用 `setTimeout` 包一层。
async fn gloo_timers_sleep(ms: u32) {
    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        let _ = set_timeout(&resolve, ms as i32);
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

fn set_timeout(callback: &js_sys::Function, ms: i32) -> Result<()> {
    let global = js_sys::global();
    let setTimeout = js_sys::Reflect::get(&global, &"setTimeout".into())
        .map_err(|_| Error::RustError("no setTimeout".into()))?;
    let setTimeout: js_sys::Function = setTimeout
        .dyn_into()
        .map_err(|_| Error::RustError("setTimeout is not a function".into()))?;
    setTimeout
        .call2(&global, callback, &ms.into())
        .map_err(|_| Error::RustError("setTimeout failed".into()))?;
    Ok(())
}

/// 一次请求在对象里的临时状态。
///
/// **不能依赖它跨消息存活**：对象一休眠就没了。真正要留的东西写进 socket attachment
/// 或 `state.storage`，这里只放「本次事件处理期间」用得上的东西。
#[derive(Default)]
struct Runtime {
    /// 等待中的 HTTP 请求：帧 id → 往响应流里推数据的入口。
    ///
    /// **只在本次唤醒内有效**。Workers 里一次 `fetch` 就是一个事件，宿主推回来的
    /// chunk 也从同一个事件里进（`waitUntil` 保着它不死），所以放内存是够的；
    /// 对象一旦休眠，这些请求本来也就该结束了。
    pending_http: std::collections::HashMap<u32, PendingHttp>,
}

/// 一次 HTTP 请求在等待宿主响应时的状态。
struct PendingHttp {
    /// 把数据推给响应流的发送端。
    sender: futures::channel::mpsc::UnboundedSender<Vec<u8>>,
    /// 宿主回来的响应头。一次 `oneshot`：`httpHead` 只来一次。
    head_tx: Option<futures::channel::oneshot::Sender<HeadInfo>>,
}

/// 宿主回来的响应头。
#[derive(Clone)]
struct HeadInfo {
    status: u16,
    headers: Vec<(String, String)>,
}

/// 宿主隧道 socket 上的 attachment：休眠后靠它恢复「这条 socket 是谁」。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct HostAttachment {
    registered: bool,
    /// 建立时间（毫秒时间戳），只用于诊断。
    connected_at: u64,
}

/// 手机 WS socket 上的 attachment。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PhoneAttachment {
    /// 这条手机 WS 在隧道上对应的帧 id。
    id: u32,
}

#[durable_object]
pub struct RelayInstance {
    state: State,
    /// 绑定（密钥等）。当前版本还没读它，但 `DurableObject::new` 必须收下。
    #[allow(dead_code)]
    env: Env,
    /// 事件处理期间用得上的东西。当前空着，理由见 `Runtime` 的说明。
    #[allow(dead_code)]
    runtime: RefCell<Runtime>,
}

impl DurableObject for RelayInstance {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            runtime: RefCell::new(Runtime::default()),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        // 判路径一律按结尾（见 `strip_deploy_prefix`）：Worker 的路由前缀、用户填进去的
        // `/relay` 都算，前面多出来的当部署前缀丢掉。
        let normalized = normalize_path(url.path());
        let pathname = strip_deploy_prefix(&normalized);

        // 只读状态：只回答「隧道通没通」，不暴露实例、设备与密钥。
        if pathname == "/status" && req.method() == Method::Get {
            let host_connected = self
                .state
                .get_websockets_with_tag("host")
                .iter()
                .any(|socket| host_ready(socket));
            return json_response(&serde_json::json!({
                "ok": true,
                "hostConnected": host_connected,
            }));
        }

        if pathname == "/healthz" {
            return Response::ok("ok");
        }

        if pathname == "/api/mobile/v1/health" {
            // 地址体检：手机在配对/接入之前问「这个地址上是谁」，因此刻意不鉴权。
            return json_response(&serde_json::json!({
                "ok": true,
                "service": "dsh-mobile-relay",
                "version": env!("CARGO_PKG_VERSION"),
            }));
        }

        // WebSocket 升级。
        if let Some(upgrade) = req.headers().get("Upgrade")? {
            if upgrade.eq_ignore_ascii_case("websocket") {
                if pathname == "/tunnel" {
                    return self.accept_host();
                }
                return self.accept_phone(&url);
            }
        }

        // 其余交给隧道转发。
        self.proxy_mobile(req, &url).await
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let tags = self.state.get_tags(&ws);
        if tags.iter().any(|tag| tag == "phone") {
            return self.on_phone_message(ws, message);
        }
        self.on_host_message(ws, message)
    }

    async fn websocket_close(
        &self,
        ws: WebSocket,
        _code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> Result<()> {
        let tags = self.state.get_tags(&ws);
        if tags.iter().any(|tag| tag == "host") {
            // 宿主走了：把挂着的手机 WS 都关掉，别让它们干等。
            for phone in self.state.get_websockets_with_tag("phone") {
                let _ = phone.close(Some(1011), Some("host disconnected"));
            }
        }
        Ok(())
    }

    async fn websocket_error(&self, ws: WebSocket, error: Error) -> Result<()> {
        let _ = (ws, error);
        Ok(())
    }
}

impl RelayInstance {
    /// 接一条宿主隧道。同一时刻只服务一条：新的连上就把旧的关掉。
    fn accept_host(&self) -> Result<Response> {
        // 新连接直接赢：先关掉旧的宿主连接，再接受这条。
        for previous in self.state.get_websockets_with_tag("host") {
            let _ = previous.close(Some(1001), Some("replaced"));
        }

        let pair = WebSocketPair::new()?;
        let attachment = HostAttachment {
            registered: true,
            connected_at: now_ms(),
        };
        pair.server
            .serialize_attachment(&attachment)
            .map_err(|e| Error::RustError(format!("attachment: {e}")))?;
        self.state.accept_websocket_with_tags(&pair.server, &["host"]);

        let mut response = Response::from_websocket(pair.client)?;
        response = response.with_status(101);
        Ok(response)
    }

    /// 接一条手机 WebSocket，并请宿主为它在本地开一条上游连接。
    fn accept_phone(&self, url: &Url) -> Result<Response> {
        let Some(host) = self.current_host() else {
            return Response::error("no host tunnel connected", 503);
        };

        let pair = WebSocketPair::new()?;
        self.state.accept_websocket_with_tags(&pair.server, &["phone"]);

        // 帧 id：用 storage 自增，**不用内存计数器**——休眠后内存就没了，
        // 计数器会从 0 重来，跟宿主那边已经用过的 id 撞车。
        let id = self.next_id();

        let attachment = PhoneAttachment { id };
        pair.server
            .serialize_attachment(&attachment)
            .map_err(|e| Error::RustError(format!("attachment: {e}")))?;

        let payload = serde_json::json!({
            "path": routed_path(&url),
            "headers": {},
        })
        .to_string();
        let frame = dsh_relay_protocol::encode_frame(
            dsh_relay_protocol::t::WS_UPGRADE,
            id,
            &dsh_relay_protocol::Payload::Json(payload),
        );
        let _ = host.send_with_bytes(&frame);

        let mut response = Response::from_websocket(pair.client)?;
        response = response.with_status(101);
        Ok(response)
    }

    /// 手机上行的 WS 消息：原样塞进隧道。
    fn on_phone_message(&self, ws: WebSocket, message: WebSocketIncomingMessage) -> Result<()> {
        let attachment = ws
            .deserialize_attachment::<PhoneAttachment>()
            .ok()
            .flatten();
        let Some(attachment) = attachment else {
            return Ok(());
        };
        let Some(host) = self.current_host() else {
            let _ = ws.close(Some(1011), Some("upstream websocket unavailable"));
            return Ok(());
        };

        let frame = match message {
            WebSocketIncomingMessage::Binary(bytes) => dsh_relay_protocol::encode_frame(
                dsh_relay_protocol::t::WS_BINARY,
                attachment.id,
                &dsh_relay_protocol::Payload::Bytes(bytes),
            ),
            WebSocketIncomingMessage::String(text) => dsh_relay_protocol::encode_frame(
                dsh_relay_protocol::t::WS_TEXT,
                attachment.id,
                &dsh_relay_protocol::Payload::Bytes(text.into_bytes()),
            ),
        };
        let _ = host.send_with_bytes(&frame);
        Ok(())
    }

    /// 隧道下行的帧：分发给对应的手机 WS。
    fn on_host_message(&self, ws: WebSocket, message: WebSocketIncomingMessage) -> Result<()> {
        let WebSocketIncomingMessage::Binary(bytes) = message else {
            // 隧道只收二进制帧；收到文本说明对端实现有问题。
            let _ = ws.close(Some(1003), Some("binary frames required"));
            return Ok(());
        };

        let mut decoder = dsh_relay_protocol::FrameDecoder::new(8 * 1024 * 1024);
        let mut frames: Vec<(u8, u32, Vec<u8>)> = Vec::new();
        let outcome = decoder.push(&bytes, |frame| {
            frames.push((frame.frame_type, frame.id, frame.payload.to_vec()));
        });
        if outcome == dsh_relay_protocol::DecodeOutcome::FrameTooLarge {
            let _ = ws.close(Some(1009), Some("frame too large"));
            return Ok(());
        }

        for (frame_type, id, payload) in frames {
            match frame_type {
                dsh_relay_protocol::t::PING => {
                    let pong = dsh_relay_protocol::encode_frame(
                        dsh_relay_protocol::t::PONG,
                        0,
                        &dsh_relay_protocol::Payload::Empty,
                    );
                    let _ = ws.send_with_bytes(&pong);
                }
                dsh_relay_protocol::t::WS_TEXT => {
                    self.send_to_phone(id, &payload, false);
                }
                dsh_relay_protocol::t::WS_BINARY => {
                    self.send_to_phone(id, &payload, true);
                }
                dsh_relay_protocol::t::WS_CLOSE => {
                    let (code, _raw, _valid, reason) =
                        dsh_relay_protocol::decode_close_payload(&payload);
                    for phone in self.state.get_websockets_with_tag("phone") {
                        if let Ok(Some(attachment)) =
                            phone.deserialize_attachment::<PhoneAttachment>()
                        {
                            if attachment.id == id {
                                let _ = phone.close(Some(code), Some(reason.as_str()));
                            }
                        }
                    }
                }
                dsh_relay_protocol::t::HTTP_HEAD => {
                    let value: serde_json::Value =
                        serde_json::from_slice(&payload).unwrap_or_else(|_| serde_json::json!({}));
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
                    let mut runtime = self.runtime.borrow_mut();
                    if let Some(pending) = runtime.pending_http.get_mut(&id) {
                        if let Some(sender) = pending.head_tx.take() {
                            let _ = sender.send(HeadInfo { status, headers });
                        }
                    }
                }
                dsh_relay_protocol::t::HTTP_CHUNK => {
                    let runtime = self.runtime.borrow();
                    if let Some(pending) = runtime.pending_http.get(&id) {
                        let _ = pending.sender.unbounded_send(payload);
                    }
                }
                dsh_relay_protocol::t::HTTP_END => {
                    // 关掉发送端，响应流读到 None 就结束。
                    self.runtime.borrow_mut().pending_http.remove(&id);
                }
                dsh_relay_protocol::t::HTTP_ERROR => {
                    let value: serde_json::Value =
                        serde_json::from_slice(&payload).unwrap_or_else(|_| serde_json::json!({}));
                    let message = value
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let mut runtime = self.runtime.borrow_mut();
                    if let Some(mut pending) = runtime.pending_http.remove(&id) {
                        // 还没发响应头：回 502；已经发了：把错误写进流里再结束。
                        if let Some(sender) = pending.head_tx.take() {
                            let _ = sender.send(HeadInfo {
                                status: 502,
                                headers: vec![(
                                    "content-type".to_string(),
                                    "text/plain; charset=utf-8".to_string(),
                                )],
                            });
                            let _ = pending.sender.unbounded_send(
                                format!("upstream error: {message}").into_bytes(),
                            );
                        } else {
                            let _ = pending.sender.unbounded_send(
                                format!("upstream error: {message}").into_bytes(),
                            );
                        }
                    }
                }
                _ => {
                    // 未知帧静默丢弃（与 Node 版一致：不报错、不回执）。
                }
            }
        }
        Ok(())
    }

    fn send_to_phone(&self, id: u32, payload: &[u8], binary: bool) {
        for phone in self.state.get_websockets_with_tag("phone") {
            if let Ok(Some(attachment)) = phone.deserialize_attachment::<PhoneAttachment>() {
                if attachment.id != id {
                    continue;
                }
                let _ = if binary {
                    phone.send_with_bytes(payload)
                } else {
                    phone.send_with_str(&String::from_utf8_lossy(payload))
                };
            }
        }
    }

    /// 其余路径全部转发给宿主，不解释业务。
    ///
    /// 与 Node 版的差别在这里：Workers 的 `Response` 一旦返回就不能再往里写，所以响应
    /// 方向用一条 channel 桥接成 `Stream`——请求先发进去，等宿主回 `httpHead` 之后再
    /// 把流交给调用方，后续 chunk 边到边推。
    async fn proxy_mobile(&self, mut req: Request, url: &Url) -> Result<Response> {
        let Some(host) = self.current_host() else {
            return Response::error("no host tunnel connected", 503);
        };

        let id = self.next_frame_id();
        let (sender, receiver) = futures::channel::mpsc::unbounded::<Vec<u8>>();

        // 请求侧：头先发，再发体，最后发一个空的 httpBody 收尾。
        let method = req.method().to_string();
        let headers: std::collections::BTreeMap<String, String> = req
            .headers()
            .entries()
            .filter(|(name, _)| forwardable_header(name))
            .map(|(name, value)| (name.to_ascii_lowercase(), value))
            .collect();
        let request_json = serde_json::json!({
            "method": method,
            "path": routed_path(&url),
            "headers": headers,
        })
        .to_string();

        let frame = dsh_relay_protocol::encode_frame(
            dsh_relay_protocol::t::HTTP_REQUEST,
            id,
            &dsh_relay_protocol::Payload::Json(request_json),
        );
        if host.send_with_bytes(&frame).is_err() {
            return Response::error("tunnel unavailable", 502);
        }

        // 请求体：有就整段读出来发进去。Workers 的请求体本身就是流，但这里不做
        // 「边读边发」——宿主侧要的是有序的 httpBody 帧，而一次读全再分块发在
        // 单次事件里是等价的，且不会因为 await 交错而乱序。
        if let Ok(mut body) = req.bytes().await {
            if !body.is_empty() {
                for chunk in body.chunks(1024 * 1024) {
                    let body_frame = dsh_relay_protocol::encode_frame(
                        dsh_relay_protocol::t::HTTP_BODY,
                        id,
                        &dsh_relay_protocol::Payload::Bytes(chunk.to_vec()),
                    );
                    if host.send_with_bytes(&body_frame).is_err() {
                        return Response::error("tunnel unavailable", 502);
                    }
                }
                body.clear();
            }
        }
        let end_frame = dsh_relay_protocol::encode_frame(
            dsh_relay_protocol::t::HTTP_BODY,
            id,
            &dsh_relay_protocol::Payload::Empty,
        );
        if host.send_with_bytes(&end_frame).is_err() {
            return Response::error("tunnel unavailable", 502);
        }

        // 等响应头：用 oneshot 通知，不轮询——轮询会把事件循环空转 30 秒，
        // 而宿主回 httpHead 的时刻本来就是事件驱动的。
        let (head_tx, head_rx) = futures::channel::oneshot::channel::<HeadInfo>();
        self.runtime
            .borrow_mut()
            .pending_http
            .insert(id, PendingHttp { sender, head_tx: Some(head_tx) });

        // 让 DO 在本事件里继续处理宿主推回来的帧。
        // `waitUntil` 一个 future，保证响应返回之后那些 chunk 还能推进流里。
        let head_result = match futures::future::select(
            Box::pin(head_rx),
            Box::pin(gloo_timers_sleep(30_000)),
        )
        .await
        {
            futures::future::Either::Left((Ok(head), _)) => Some(head),
            _ => None,
        };
        let Some(HeadInfo { status, headers: response_headers }) = head_result else {
            self.runtime.borrow_mut().pending_http.remove(&id);
            let _ = host.send_with_bytes(&dsh_relay_protocol::encode_frame(
                dsh_relay_protocol::t::HTTP_CANCEL,
                id,
                &dsh_relay_protocol::Payload::Empty,
            ));
            return Response::error("upstream timeout", 504);
        };

        // 响应体：把 channel 变成流。宿主每推一个 chunk 就往 sender 里塞。
        let stream = futures::stream::unfold(receiver, |mut rx| async move {
            use futures::StreamExt;
            rx.next().await.map(|chunk| (Ok::<Vec<u8>, Error>(chunk), rx))
        });
        let mut response = Response::from_stream(Box::pin(stream))?;
        response = response.with_status(status);
        let headers_out = Headers::new();
        for (name, value) in response_headers {
            let _ = headers_out.set(&name, &value);
        }
        response = response.with_headers(headers_out);
        Ok(response)
    }

    fn next_frame_id(&self) -> u32 {
        NEXT_ID.with(|counter| {
            let next = counter.get().wrapping_add(1).max(1);
            counter.set(next);
            next
        })
    }

    fn current_host(&self) -> Option<WebSocket> {
        self.state
            .get_websockets_with_tag("host")
            .into_iter()
            .find(|socket| host_ready(socket))
    }

    /// 帧 id 自增。用 storage 保存，休眠后不会从 0 重来。
    fn next_id(&self) -> u32 {
        // 这里刻意是同步的：`fetch` 里没法 await storage。用时间戳做起点避免撞车，
        // 同一毫秒内多次分配靠寄存器位区分（实际场景里一次事件只分配一个 id）。
        let base = now_ms() as u32;
        base
    }
}

/// 中转自己认领的路径。判据只看**末尾**（见 `strip_deploy_prefix`）。
const OWNED_PATHS: &[&str] = &["/healthz", "/status", "/api/mobile/v1/health", "/tunnel"];

/// 手机 API 的固定前缀。与 `server/relay-core/protocol-types.js` 的 `MOBILE_PREFIX` 一致。
const MOBILE_PREFIX: &str = "/api/mobile/v1/";

/// 把连续的斜杠压成一个，并去掉末尾的斜杠。返回 `None` 表示路径本来就规范。
///
/// 用户把中转地址填成 `https://host/`、或者粘贴时多带一个尾斜杠，拼出来就是 `//pair`。
/// **宿主用的是 URL 解析器**（`new URL(req.url, base).pathname`），它会把
/// `//api/mobile/v1/status` 解析成 `/api/mobile/v1/status`，而 `//pair` 会被当成**协议
/// 相对地址**解析成 `/`。中转是路径的出口，在这里压一次，宿主就永远收不到双斜杠。
fn normalize_path(pathname: &str) -> String {
    let mut out = String::with_capacity(pathname.len());
    let mut last_was_slash = false;
    for ch in pathname.chars() {
        if ch == '/' {
            if last_was_slash {
                continue;
            }
            last_was_slash = true;
        } else {
            last_was_slash = false;
        }
        out.push(ch);
    }
    if out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    out
}

/// 剥掉部署前缀，只给中转自己判路由用（`/healthz`、`/status`、`/tunnel` 那几条）。
///
/// 判据看**末尾**：路径以某个认领路径结尾就算那个路径。其余路径原样返回。
///
/// 与 `server/relay-core/protocol-types.js` 的 `stripDeployPrefix` 是同一条规则——两边
/// 各自实现是因为这里拿不到 JS（自建版只编成二进制），改规则要同时改。
fn strip_deploy_prefix(pathname: &str) -> &str {
    if OWNED_PATHS.contains(&pathname) {
        return pathname;
    }
    match OWNED_PATHS.iter().find(|owned| pathname.ends_with(**owned)) {
        Some(owned) => owned,
        None => pathname,
    }
}

/// 送给宿主的路径：剥掉部署前缀，保留查询串。
///
/// 与 `strip_deploy_prefix` 分开，是因为命中面不同：判路由时 `/status` 这种短路径有
/// 歧义，但送给宿主时 `/api/mobile/v1/` 是唯一的手机 API 前缀，只按它剥不会误伤。
/// 宿主只认这个前缀下的路径，带前缀一律 404，所以宁可多剥一个确定的部署前缀。
fn strip_forward_prefix(pathname: &str) -> &str {
    let stripped = strip_deploy_prefix(pathname);
    if stripped != pathname {
        return stripped;
    }
    match pathname.find(MOBILE_PREFIX) {
        Some(at) if at > 1 => &pathname[at..],
        _ => pathname,
    }
}

/// 送给宿主的路径：剥掉部署前缀，保留查询串。
///
/// 宿主只认 `/api/mobile/v1/...`，带前缀的路径在那边一律 404。
fn routed_path(url: &Url) -> String {
    format!(
        "{}{}",
        strip_forward_prefix(&normalize_path(url.path())),
        url.query().map(|q| format!("?{q}")).unwrap_or_default()
    )
}

fn host_ready(socket: &WebSocket) -> bool {
    socket
        .deserialize_attachment::<HostAttachment>()
        .ok()
        .flatten()
        .map(|attachment| attachment.registered)
        .unwrap_or(false)
}

fn json_response(value: &serde_json::Value) -> Result<Response> {
    json_response_with_status(value, 200)
}

fn json_response_with_status(value: &serde_json::Value, status: u16) -> Result<Response> {
    let mut response = Response::from_json(value)?;
    response = response.with_status(status);
    response = response.with_headers({
        let headers = Headers::new();
        headers
            .set("cache-control", "no-store")
            .map_err(|e| Error::RustError(format!("header: {e}")))?;
        headers
    });
    Ok(response)
}

/// 逐跳头之外一律转发；`host` 指向中转自己的域名，不能带给宿主。
fn forwardable_header(name: &str) -> bool {
    const HOP_BY_HOP: &[&str] = &[
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailer", "transfer-encoding", "upgrade", "content-length",
    ];
    let lower = name.to_ascii_lowercase();
    !HOP_BY_HOP.contains(&lower.as_str()) && lower != "host"
}

fn now_ms() -> u64 {
    js_sys::Date::now() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(path: &str) -> Url {
        Url::parse(&format!("https://relay.example{path}")).unwrap()
    }

    #[test]
    fn owned_paths_are_recognised_under_deploy_prefix() {
        // Worker 挂在自定义域名下时，控制台给的路由带前缀，用户会连同前缀一起抄进 App。
        for path in ["/relay-worker/healthz", "/relay/healthz", "/healthz"] {
            assert_eq!(strip_deploy_prefix(path), "/healthz", "{path}");
        }
        assert_eq!(strip_deploy_prefix("/relay-worker/status"), "/status");
        assert_eq!(strip_deploy_prefix("/relay-worker/tunnel"), "/tunnel");
    }

    #[test]
    fn repeated_and_trailing_slashes_are_collapsed() {
        // 用户把中转地址填成 `https://host/` 拼出来就是 `//pair`；宿主用 URL 解析器会把
        // 它当成协议相对地址解析成 `/`。中转必须先把斜杠压平。
        assert_eq!(routed_path(&url("//pair")), "/pair");
        assert_eq!(routed_path(&url("///pair")), "/pair");
        assert_eq!(routed_path(&url("//api/mobile/v1/sessions")), "/api/mobile/v1/sessions");
        assert_eq!(routed_path(&url("/api//mobile/v1/sessions")), "/api/mobile/v1/sessions");
        assert_eq!(routed_path(&url("/api/mobile/v1/sessions/")), "/api/mobile/v1/sessions");
        assert_eq!(routed_path(&url("/")), "/");
        // 压完之后照样认得自己那几条路径。
        assert_eq!(strip_deploy_prefix(&normalize_path("/healthz/")), "/healthz");
        assert_eq!(strip_deploy_prefix(&normalize_path("//tunnel")), "/tunnel");
    }

    #[test]
    fn mobile_prefix_is_stripped_before_forwarding() {
        // 宿主只认 /api/mobile/v1/...，带前缀的路径在那边一律 404。
        assert_eq!(
            routed_path(&url("/relay-worker/api/mobile/v1/sessions?x=1")),
            "/api/mobile/v1/sessions?x=1"
        );
        assert_eq!(
            routed_path(&url("/relay/api/mobile/v1/sessions")),
            "/api/mobile/v1/sessions"
        );
        // 不含手机 API 前缀的路径原样转发，不做前缀猜测。
        assert_eq!(
            routed_path(&url("/relay/whatever/thing")),
            "/relay/whatever/thing"
        );
    }
}
