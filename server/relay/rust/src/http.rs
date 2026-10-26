//! 一个 TCP 连接上的 HTTP/1.1 处理：读请求头、判路径、分流到转发或本地应答。
//!
//! 不引 http 框架：中转只处理固定的几种形态（体检、状态、`/tunnel` 升级、其余转发），
//! 手写解析比拉一个完整栈更可控，也更容易和 Node 版逐条对齐行为。
//!
//! 连接用**单流** `BufReader<TcpStream>` 处理：WebSocket 升级时把整个 reader 交给
//! `tokio_tungstenite`，普通请求时用 `get_mut()` 写响应。拆成读写两半会让「发现是升级
//! 之后再把两半合回去」变得很别扭，而这里根本不需要半双工。

use std::borrow::Cow;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use crate::tunnel::{log, TunnelSlot};

/// 请求行 + 头解析出来的请求。
#[derive(Debug, Clone)]
pub struct RequestHead {
    pub method: String,
    pub path: String,
    pub query: String,
    pub version: String,
    pub headers: Vec<(String, String)>,
}

impl RequestHead {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// 只保留路径部分（去掉查询串）。
    pub fn pathname(&self) -> &str {
        match self.path.split_once('?') {
            Some((path, _)) => path,
            None => &self.path,
        }
    }

    /// 压掉重复斜杠、去掉尾斜杠之后的路径部分。
    ///
    /// 判路由与送给宿主的路径都从它出发：用户填 `https://host/` 时拼出来是 `//pair`，
    /// 而宿主按 URL 解析会把 `//pair` 当成协议相对地址解析成 `/`（见 `normalize_path`）。
    pub fn normalized_pathname(&self) -> Cow<'_, str> {
        match normalize_path(self.pathname()) {
            Some(path) => Cow::Owned(path),
            None => Cow::Borrowed(self.pathname()),
        }
    }

    /// 剥掉部署前缀之后真正要用的路径（含查询串）。
    ///
    /// 中转挂在反代后面、或者用户把中转地址填成 `https://host/prefix` 时，请求路径
    /// 会多出一截。中转只认自己那几条路径与 `/tunnel`，所以按末尾判定（见
    /// `strip_deploy_prefix`）；多出来的前缀必须丢掉，不能原样带给宿主——宿主只认
    /// `/api/mobile/v1/...`，带前缀的路径在那边一律 404。
    pub fn routed_path(&self) -> String {
        let pathname = self.normalized_pathname();
        let stripped = strip_forward_prefix(&pathname);
        format!("{stripped}{}", self.query)
    }

    /// 是不是 WebSocket 升级请求。
    pub fn is_websocket_upgrade(&self) -> bool {
        self.header("upgrade")
            .map(|value| value.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
    }

    /// 请求体长度（没有 `content-length` 时为 None，表示「读到连接结束」）。
    pub fn content_length(&self) -> Option<usize> {
        self.header("content-length")
            .and_then(|value| value.trim().parse::<usize>().ok())
    }

    /// 请求是不是 `Transfer-Encoding: chunked`。
    pub fn is_chunked(&self) -> bool {
        self.header("transfer-encoding")
            .map(|value| value.to_ascii_lowercase().contains("chunked"))
            .unwrap_or(false)
    }
}

/// 中转自己认领的路径。判据只看**末尾**（见 `strip_deploy_prefix`）。
const OWNED_PATHS: &[&str] = &[
    "/healthz",
    "/status",
    "/api/mobile/v1/health",
    "/api/mobile/v1/push-token",
    "/tunnel",
];

/// 手机 API 的固定前缀。与 `server/relay-core/protocol-types.js` 的 `MOBILE_PREFIX` 一致。
const MOBILE_PREFIX: &str = "/api/mobile/v1/";

/// 宿主控制面的前缀。这个前缀下全是「管这台宿主」的接口：配对二维码、中转地址、
/// 注册密钥、设备列表与吊销、插件更新。手机一条都不用（它只走 `/api/mobile/v1/**`）。
const CONTROL_PLANE_PREFIX: &str = "/api/relay";

/// 这条路径是不是宿主控制面（`/api/relay` 与 `/api/relay/**`）。
///
/// 判据要能穿透部署前缀：中转挂成 `https://host/relay` 时，请求路径长成
/// `/relay/api/relay/config`。`strip_deploy_prefix` 剥不掉它——那条规则只认「以某个
/// 中转认领路径结尾」，控制面路径不在认领表里，剥不了。所以这里按整段出现判：路径里
/// 有独立的 `/api/relay` 段就是控制面，前面有几段部署前缀都不影响。段尾卡边界，
/// `/api/relayx` 这种不误伤。
fn is_control_plane_path(pathname: &str) -> bool {
    pathname
        .match_indices(CONTROL_PLANE_PREFIX)
        .any(|(at, _)| match pathname[at + CONTROL_PLANE_PREFIX.len()..].chars().next() {
            None => true,
            Some(next) => next == '/',
        })
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
    // **手机 API 前缀下的路径一律归宿主**，不能被末尾匹配抢走。
    //
    // `/api/mobile/v1/status` 以 `/status` 结尾，按末尾判定会被中转自己抢答，回一句
    // `{"hostConnected":…}`。那是中转的上线状态，不是宿主的：App 拿它当宿主的 status，
    // 于是读不到宿主名与平台，设备行退化成实例 id + 通用图标（真机上撞到的就是那台
    // Linux 显示成 `99d9d3ee`）。`/api/mobile/v1/health` 是唯一真正由中转自答的路径，
    // 它在 OWNED_PATHS 里、上面已经精确匹配先返回了。
    //
    // 部署前缀照旧剥掉：`/relay/api/mobile/v1/health` 要能被认成手机 API 路径。
    if let Some(at) = pathname.find(MOBILE_PREFIX) {
        return if at > 0 { &pathname[at..] } else { pathname };
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

/// 把连续的斜杠压成一个，并去掉末尾的斜杠。返回 `None` 表示路径本来就规范。
///
/// 用户把中转地址填成 `https://host/`、或者粘贴时多带了一个尾斜杠，拼出来就是 `//pair`。
/// **宿主用的是 URL 解析器**（`new URL(req.url, base).pathname`），它会把 `//api/mobile/v1/status`
/// 解析成 `/api/mobile/v1/status`，而 `//pair` 会被当成**协议相对地址**、解析成 `/`——
/// 于是手机上每个接口都 404 或落回首页。中转是路径的出口，在这里压一次，宿主就永远收不到
/// 双斜杠。
fn normalize_path(pathname: &str) -> Option<String> {
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
    (out != pathname).then_some(out)
}

/// 解析失败的情形。
#[derive(Debug)]
pub enum ParseError {

    /// 连接已断或客户端主动关闭。
    Closed,
    /// 请求格式不认识。
    Malformed(String),
}

/// 读一个请求的头。body 起点留在 reader 里，不丢。
pub async fn read_request_head(
    reader: &mut BufReader<TcpStream>,
) -> Result<RequestHead, ParseError> {
    let mut request_line = String::new();
    let read = reader
        .read_line(&mut request_line)
        .await
        .map_err(|_| ParseError::Closed)?;
    if read == 0 {
        return Err(ParseError::Closed);
    }
    let request_line = request_line.trim_end_matches(['\r', '\n']);
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or_else(|| ParseError::Malformed("缺方法".into()))?;
    let target = parts.next().ok_or_else(|| ParseError::Malformed("缺路径".into()))?;
    let version = parts.next().unwrap_or("HTTP/1.1");

    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), format!("?{query}")),
        None => (target.to_string(), String::new()),
    };

    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).await.map_err(|_| ParseError::Closed)?;
        if read == 0 {
            return Err(ParseError::Closed);
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim().to_string();
            // 同名头按规范可以出现多次（如 set-cookie 之外的），这里按名合并成一个，
            // 与 Node 版 `Object.entries(headers)` 的形态对齐：同名后者覆盖前者。
            if let Some(existing) = headers.iter_mut().find(|(k, _)| *k == name) {
                existing.1 = format!("{}, {}", existing.1, value);
            } else {
                headers.push((name, value));
            }
        }
        if headers.len() > 200 {
            return Err(ParseError::Malformed("头太多".into()));
        }
    }

    Ok(RequestHead {
        method: method.to_string(),
        path: path.clone(),
        query,
        version: version.to_string(),
        headers,
    })
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Unknown",
    }
}

/// 往连接里写一个简单的完整响应（带 content-length，写完即关）。
pub async fn respond_with(
    reader: &mut BufReader<TcpStream>,
    status: u16,
    content_type: &str,
    body: &[u8],
    extra_headers: &[(String, String)],
) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n",
        status_reason(status),
        body.len()
    );
    for (name, value) in extra_headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let stream = reader.get_mut();
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

pub async fn respond_text(
    reader: &mut BufReader<TcpStream>,
    status: u16,
    body: &str,
) -> std::io::Result<()> {
    respond_with(reader, status, "text/plain; charset=utf-8", body.as_bytes(), &[]).await
}

pub async fn respond_json(
    reader: &mut BufReader<TcpStream>,
    status: u16,
    body: &str,
) -> std::io::Result<()> {
    respond_with(
        reader,
        status,
        "application/json; charset=utf-8",
        body.as_bytes(),
        &[],
    )
    .await
}

/// 手机这次出示的设备凭据原文，按「先算谁」排好：`X-Dsh-Device-Credential` 在前，
/// `Authorization` 的 Bearer 原文在后。
///
/// App 把设备凭据单独放在 `X-Dsh-Device-Credential` 头里，`Authorization` 那份通常留给
/// 宿主 token；两处都带和只带一处都收，调用方依次试，任一命中即可（见
/// `mirror::creds_allow`）。
///
/// **不看前缀、不看形状**：每设备凭据本身就是一段任意 Bearer
/// （`<instanceId>.<exp>.<random>`），按 `dshc_` 筛会把新配对之后的镜像读整片挡住。
/// 中转只把原文算 sha256 去对宿主推上来的摘要，既看不到凭据原文，也不持有任何签名密钥。
fn presented_credentials(head: &RequestHead) -> Vec<String> {
    let mut presented: Vec<String> = Vec::new();
    if let Some(raw) = head.header("x-dsh-device-credential") {
        let value = raw.trim();
        if !value.is_empty() {
            presented.push(value.to_string());
        }
    }
    if let Some(raw) = head.header("authorization") {
        let authorization = raw.trim();
        let token = authorization
            .strip_prefix("Bearer ")
            .or_else(|| authorization.strip_prefix("bearer "))
            .unwrap_or_default()
            .trim();
        if !token.is_empty() {
            presented.push(token.to_string());
        }
    }
    presented
}

/// 控制台自己的请求体上限。控制台只有被控端上报那条带体，内容是个小 JSON。
const MAX_CONSOLE_BODY: usize = 64 * 1024;
/// 插件 OTA 发布的请求体上限。发布的是**整包**（npm tgz，几百 KB 到几 MB），
/// 不能套用控制台那个 64KB。
const MAX_OTA_PUBLISH_BODY: usize = 32 * 1024 * 1024;

/// 读请求体。上限由调用点给：控制台 64KB，OTA 发布 32MB。
///
/// **超限回 `Err(())` 让调用方回 413，绝不截断**：截断过去的表现是 publish 回
/// `ok:true`、盘上只有前 64KB，客户端装到一半才报「OTA 包结构不完整」（2026-10-17
/// 真机踩到，而接口自始至终都说成功）。
async fn read_console_body(
    reader: &mut BufReader<TcpStream>,
    head: &RequestHead,
    limit: usize,
) -> Result<Vec<u8>, ()> {
    let Some(length) = head.content_length() else {
        return Ok(Vec::new());
    };
    if length > limit {
        return Err(());
    }
    let mut body = vec![0u8; length];
    // ⚠️ 必须从 **BufReader** 读，不能从 `reader.get_mut()` 读：读请求头时 BufReader
    // 很可能已经把 body 一起预读进自己的缓冲区了，这时裸流上已经没有字节，
    // `read_exact` 会一直等（请求挂死、服务端什么都不记）。同 A4-11 那个
    // `into_inner()` 丢缓冲区的坑，方向相反但同一个根因。
    match tokio::io::AsyncReadExt::read_exact(&mut *reader, &mut body).await {
        Ok(_) => Ok(body),
        Err(_) => Ok(Vec::new()),
    }
}

/// 把一个控制台应答写到连接里。
///
/// 控制台比转发多两样东西：`set-cookie`（登录落地）与 302 跳转（去登录系统）。
/// 这两样都只在控制台这条分支上出现，转发路径仍然走 `respond_with`。
pub async fn respond_console(
    reader: &mut BufReader<TcpStream>,
    response: &crate::console::ConsoleResponse,
) -> std::io::Result<()> {
    let mut extra: Vec<(String, String)> = Vec::new();
    if let Some(cookie) = response.set_cookie.as_ref() {
        extra.push(("set-cookie".to_string(), cookie.clone()));
    }
    if let Some(location) = response.redirect.as_ref() {
        extra.push(("location".to_string(), location.clone()));
    }
    respond_with(
        reader,
        response.status,
        response.content_type,
        &response.body,
        &extra,
    )
    .await
}

/// 中转自己认领的路径。返回 `true` 表示已经应答、别再转发。
pub async fn handle_owned_path(
    reader: &mut BufReader<TcpStream>,
    head: &RequestHead,
    slot: &Arc<TunnelSlot>,
    peer: Option<std::net::SocketAddr>,
) -> std::io::Result<bool> {
    let pathname = head.normalized_pathname();
    match strip_deploy_prefix(&pathname) {
        "/healthz" => {
            respond_text(reader, 200, "ok").await?;
            Ok(true)
        }
        "/api/mobile/v1/health" => {
            if head.method != "GET" {
                respond_json(
                    reader,
                    405,
                    r#"{"ok":false,"error":"method not allowed"}"#,
                )
                .await?;
                return Ok(true);
            }
            // 地址体检：手机在配对/接入**之前**问「这个地址上是谁」，因此刻意不鉴权。
            // 回答只有服务名与版本。
            let body = format!(
                r#"{{"ok":true,"service":"dsh-mobile-relay","version":"{}"}}"#,
                env!("CARGO_PKG_VERSION")
            );
            respond_json(reader, 200, &body).await?;
            Ok(true)
        }
        "/status" => {
            // 在线状态只回答「隧道通没通」，不泄露实例与设备。
            let host_connected = slot.get().map(|t| !t.is_closed()).unwrap_or(false);
            let body = format!(r#"{{"ok":true,"hostConnected":{host_connected}}}"#);
            respond_json(reader, 200, &body).await?;
            Ok(true)
        }
        "/api/mobile/v1/push-token" => {
            // iOS 推送令牌上报。**必须带设备凭据**：判据与镜像读同一个（mirror::credential_ok），
            // 没配对过的手机报上来的令牌一律不收。控制台没开时也收——推送依赖的是 APNs
            // 配置（APNS_*），不是控制台开关。
            if head.method != "POST" {
                respond_json(reader, 405, r#"{"ok":false,"error":"method not allowed"}"#).await?;
                return Ok(true);
            }
            let instance_id = head
                .header("x-dsh-instance")
                .unwrap_or_default()
                .trim()
                .to_string();
            let credentials = presented_credentials(head);
            if credentials.is_empty() {
                respond_json(reader, 401, r#"{"ok":false,"error":"device credential required"}"#).await?;
                return Ok(true);
            }
            if instance_id.is_empty() {
                respond_json(reader, 400, r#"{"ok":false,"error":"x-dsh-instance required"}"#).await?;
                return Ok(true);
            }
            if !crate::mirror::credential_ok(&instance_id, &credentials) {
                respond_json(reader, 403, r#"{"ok":false,"error":"bad device credential"}"#).await?;
                return Ok(true);
            }
            let body = match read_console_body(reader, head, MAX_CONSOLE_BODY).await {
                Ok(body) => body,
                Err(()) => {
                    respond_json(reader, 413, r#"{"ok":false,"error":"body too large"}"#).await?;
                    return Ok(true);
                }
            };
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
            let device_id = request
                .get("deviceId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            let token = request
                .get("token")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            let platform = request
                .get("platform")
                .and_then(|v| v.as_str())
                .unwrap_or("ios")
                .trim()
                .to_string();
            if device_id.is_empty() || token.is_empty() {
                respond_json(reader, 400, r#"{"ok":false,"error":"deviceId and token are required"}"#).await?;
                return Ok(true);
            }
            match crate::console() {
                Some(console) => {
                    console.store.upsert_push_token(&instance_id, &device_id, &platform, &token);
                    respond_json(reader, 200, r#"{"ok":true}"#).await?;
                }
                None => respond_json(reader, 503, r#"{"ok":false,"error":"no store on this relay"}"#).await?,
            }
            Ok(true)
        }
        other => {
            // 插件 OTA 临时通道：`/api/desktop-plugins/ota/**`。它独立于控制台开关
            // （宿主可能没开控制台但仍在用这条救急通道），所以单独判。
            if let Some(rest) = other.strip_prefix("/api/desktop-plugins/ota/") {
                let Some(console) = crate::console() else {
                    return Ok(false);
                };
                let body = if head.method == "POST" {
                    match read_console_body(reader, head, MAX_OTA_PUBLISH_BODY).await {
                        Ok(body) => body,
                        Err(()) => {
                            respond_json(
                                reader,
                                413,
                                r#"{"ok":false,"error":"package too large"}"#,
                            )
                            .await?;
                            return Ok(true);
                        }
                    }
                } else {
                    Vec::new()
                };
                let response = match (head.method.as_str(), rest) {
                    ("GET", "latest") => {
                        crate::console::ota::handle_latest(&console.store, &console.config, &head.query)
                    }
                    ("POST", "publish") => crate::console::ota::handle_publish(
                        &console.store,
                        &console.config,
                        &head.query,
                        &head.headers,
                        &body,
                    ),
                    ("GET", download) if download.starts_with("download/") => {
                        crate::console::ota::handle_download(
                            &console.store,
                            download.trim_start_matches("download/"),
                        )
                    }
                    _ => crate::console::ConsoleResponse::text(404, "not found\n"),
                };
                respond_console(reader, &response).await?;
                return Ok(true);
            }

            // 控制台：只有开启时（PLATFORM_ENABLED=1）才认领这些路径。
            // 没开时它们和其它路径一样进隧道，行为与加控制台之前完全一致。
            let Some(console) = crate::console() else {
                return Ok(false);
            };
            if console.matches_api(other) {
                // 控制台要读 POST 体（只有被控端上报那条会用到，但读法统一）。
                let body = match read_console_body(reader, head, MAX_CONSOLE_BODY).await {
                    Ok(body) => body,
                    Err(()) => {
                        respond_json(reader, 413, r#"{"ok":false,"error":"body too large"}"#)
                            .await?;
                        return Ok(true);
                    }
                };
                let response = console
                    .handle_api(
                        &head.method,
                        other,
                        &head.query,
                        &head.headers,
                        &body,
                        peer,
                    )
                    .await;
                respond_console(reader, &response).await?;
                return Ok(true);
            }
            if console.matches_web(other) {
                let response = crate::console::serve_web(&console, other);
                respond_console(reader, &response).await?;
                return Ok(true);
            }
            Ok(false)
        }
    }
}

/// 处理一个 TCP 连接。HTTP 与 WebSocket 升级都在这里分流。
pub async fn serve_connection(stream: TcpStream, slot: Arc<TunnelSlot>) -> std::io::Result<()> {
    let peer = stream.peer_addr().ok();
    let mut reader = BufReader::new(stream);

    let head = match read_request_head(&mut reader).await {
        Ok(head) => head,
        Err(ParseError::Closed) => return Ok(()),
        Err(ParseError::Malformed(reason)) => {
            log(format!("请求格式错误：{reason}"));
            return Ok(());
        }
    };

    // 宿主控制面在中转上一律 404，**绝不转发**。留着转发等于把宿主的控制面挂到公网上
    // —— 宿主那些「是不是本机来的」判断在转发链路上本来就不可靠；宿主侧按转发标记判
    // 远程的那一道之外，这里是第二道。
    //
    // 必须判在 WebSocket 升级分支**之前**：升级分支一旦先返回，`/api/relay/**` 的 WS
    // 请求就绕过这道判断直接进宿主。也必须判在认领路径之前：`/api/relay/status`、
    // `/api/relay/healthz` 以中转自己的路径结尾，会被 `strip_deploy_prefix` 的末尾
    // 判定抢答成 200，那就不是 404 了。
    if is_control_plane_path(&head.normalized_pathname()) {
        respond_text(&mut reader, 404, "not found").await?;
        return Ok(());
    }

    // 升级请求先判：`/tunnel` 是宿主，其余一律当作手机 WS 桥接。
    if head.is_websocket_upgrade() {
        if strip_deploy_prefix(&head.normalized_pathname()) == "/tunnel" {
            return crate::ws::accept_tunnel(reader, head, slot, peer).await;
        }
        return crate::ws::accept_phone_ws(reader, head, slot).await;
    }

    // 普通 HTTP：先看是不是中转自己认领的路径。
    if handle_owned_path(&mut reader, &head, &slot, peer).await? {
        return Ok(());
    }
    // 宿主那条隧道不在的时候，中转手上还有它最后推上来的那份清单（见 `mirror`）。
    //
    // **只在隧道不可用时**走这条路：隧道活着就照旧转发，哪怕对面慢，也不让一份旧副本
    // 顶掉新数据。给不出去（没有缓存、凭据对不上、这次读的是归档/翻页/写后刷新）就
    // 原样往下走，回到今天那句「那台宿主不在线」——不新增错误面。
    let instance_id = head.header("x-dsh-instance").unwrap_or_default().trim().to_string();
    // 这台实例已经不在本中转上了，而它走之前留了「我搬到 X 了」：直接 503 指路。
    //
    // **排在镜像兜底之前**：让镜像先答一份 200 的话，手机拿到旧清单就满足了，永远
    // 学不到新地址——那正是这条迁移记录要解决的那个问题。判据与镜像那条「不可用」同一
    // 口径（找不到，或者表里那条已经关了）；没有迁移记录就什么都不做，往下照旧。
    if !instance_id.is_empty() {
        let unreachable = slot
            .get_for(&instance_id)
            .map(|tunnel| tunnel.is_closed())
            .unwrap_or(true);
        if unreachable {
            if let Some((body, to)) = crate::migrate::migrated_response(&instance_id) {
                respond_with(
                    &mut reader,
                    503,
                    "application/json; charset=utf-8",
                    body.as_bytes(),
                    &[("x-dsh-migrated-to".to_string(), to)],
                )
                .await?;
                return Ok(());
            }
        }
    }
    // 这一次读能不能用镜像兜底：隧道不在就直接给，隧道在就带着它去转发（弱网阈值到点才用）。
    let mut mirror_fallback: Option<crate::mirror::Fallback> = None;
    if !instance_id.is_empty() && crate::config().mirror_cache {
        let routed = strip_forward_prefix(&head.normalized_pathname()).to_string();
        if let Some((kind, rev)) = crate::mirror::parse_read(&head.method, &routed, &head.query) {
            let credentials = presented_credentials(&head);
            let unreachable = slot
                .get_for(&instance_id)
                .map(|tunnel| tunnel.is_closed())
                .unwrap_or(true);
            let fallback = crate::mirror::Fallback::new(instance_id.clone(), kind, rev, credentials);
            if unreachable {
                if let Some(body) = fallback.serve() {
                    respond_with(
                        &mut reader,
                        200,
                        "application/json; charset=utf-8",
                        body.as_bytes(),
                        &[("x-dsh-relay-mirror".to_string(), "stale".to_string())],
                    )
                    .await?;
                    return Ok(());
                }
            } else {
                mirror_fallback = Some(fallback);
            }
        }
    }

    // 分发给哪条隧道，看手机自己带的 `X-Dsh-Instance`。
    //
    // **找不到就 503，绝不退回到「随便挑一条」**：公用中转上随便挑一条等于把 A 家的
    // 请求送进 B 家的电脑，那是最坏的串台。宁可报「那台不在线」，让手机自己判断
    // 是切换地址还是重连。
    //
    // 没带实例 id 的唯一例外是手动输配对码（见下）：中转上只有一台宿主时才无歧义。
    let instance = instance_id.as_str();
    let tunnel = if instance.trim().is_empty() {
        match slot.sole() {
            Some(tunnel) => tunnel,
            None => {
                let body = if slot.online_count() == 0 {
                    r#"{"ok":false,"error":"missing x-dsh-instance header"}"#
                } else {
                    r#"{"ok":false,"error":"this relay has more than one host online; scan the QR code instead of typing the pairing code"}"#
                };
                respond_json(&mut reader, 503, body).await?;
                return Ok(());
            }
        }
    } else {
        let Some(tunnel) = slot.get_for(instance) else {
            respond_json(
                &mut reader,
                503,
                r#"{"ok":false,"error":"that host is not connected to this relay"}"#,
            )
            .await?;
            return Ok(());
        };
        tunnel
    };

    crate::proxy::proxy_request(reader, head, tunnel, slot, mirror_fallback).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(path: &str) -> RequestHead {
        let (pathname, query) = match path.split_once('?') {
            Some((pathname, query)) => (pathname.to_string(), format!("?{query}")),
            None => (path.to_string(), String::new()),
        };
        RequestHead {
            method: "GET".into(),
            path: pathname,
            query,
            version: "HTTP/1.1".into(),
            headers: Vec::new(),
        }
    }

    #[test]
    fn owned_path_is_hit_under_deploy_prefix() {
        // 反代把中转挂在子路径下时，用户照抄进 App 的地址就带前缀，请求是这个形状。
        for path in ["/relay/healthz", "/healthz"] {
            assert_eq!(strip_deploy_prefix(path), "/healthz", "{path}");
        }
        assert_eq!(strip_deploy_prefix("/relay/status"), "/status");
        assert_eq!(
            strip_deploy_prefix("/relay/api/mobile/v1/health"),
            "/api/mobile/v1/health"
        );
        assert_eq!(strip_deploy_prefix("/relay/tunnel"), "/tunnel");
        assert_eq!(
            strip_deploy_prefix("/relay/api/mobile/v1/push-token"),
            "/api/mobile/v1/push-token"
        );
        // 末尾判定是刻意取舍：`/relay/status` 会命中 `/status`。但**手机 API 前缀下的
        // 路径绝不能被末尾匹配抢走**——见下面那条用例。
    }

    /// `/api/mobile/v1/status` 必须归宿主，不能被中转的 `/status` 末尾判定抢答。
    ///
    /// 真机上撞到的：中转发回的是自己的 `{"hostConnected":…}`，App 当成宿主的 status，
    /// 读不到宿主名与平台，设备行退化成实例 id + 通用图标（Linux 那台显示成 `99d9d3ee`）。
    #[test]
    fn mobile_prefix_paths_are_never_claimed_by_the_relay() {
        // 不带部署前缀的原样归宿主；带了前缀的剥掉前缀之后同样归宿主。
        assert_eq!(
            strip_deploy_prefix("/api/mobile/v1/status"),
            "/api/mobile/v1/status",
            "手机 API 路径不能被中转的 /status 抢答"
        );
        assert_eq!(
            strip_deploy_prefix("/relay/api/mobile/v1/status"),
            "/api/mobile/v1/status",
            "部署前缀要剥掉，剥完仍是手机 API 路径"
        );
        // 中转自己那几条照旧认领。
        assert_eq!(strip_deploy_prefix("/status"), "/status");
        assert_eq!(strip_deploy_prefix("/relay/status"), "/status");
        // 手机 API 路径带部署前缀：剥掉前缀后交给宿主。
        assert_eq!(
            strip_deploy_prefix("/relay/api/mobile/v1/status"),
            "/api/mobile/v1/status"
        );
    }

    #[test]
    fn repeated_and_trailing_slashes_are_collapsed() {
        // 用户把中转地址填成 `https://host/` 拼出来就是 `//pair`；而宿主用 URL 解析器
        // 会把它当成协议相对地址解析成 `/`。中转必须先把斜杠压平。
        assert_eq!(head("//pair").routed_path(), "/pair");
        assert_eq!(head("///pair").routed_path(), "/pair");
        assert_eq!(head("//api/mobile/v1/sessions").routed_path(), "/api/mobile/v1/sessions");
        assert_eq!(head("/api//mobile/v1/sessions").routed_path(), "/api/mobile/v1/sessions");
        assert_eq!(head("/api/mobile/v1/sessions/").routed_path(), "/api/mobile/v1/sessions");
        // 规范路径不变，查询串照旧带过去。
        assert_eq!(head("/api/mobile/v1/sessions?x=1").routed_path(), "/api/mobile/v1/sessions?x=1");
        // 根路径不能被压成空串。
        assert_eq!(head("/").routed_path(), "/");
    }

    #[test]
    fn slashes_are_collapsed_before_owned_path_checks() {
        // 用户把地址填成 /healthz/ 也要认出来。
        assert_eq!(
            strip_deploy_prefix(&head("/relay//healthz/").normalized_pathname()),
            "/healthz"
        );
        assert_eq!(
            strip_deploy_prefix(&head("//tunnel").normalized_pathname()),
            "/tunnel"
        );
    }

    #[test]
    fn forwarded_path_drops_prefix_but_keeps_query() {
        // 前缀必须丢掉：宿主只认 /api/mobile/v1/...，带前缀那边一律 404。
        assert_eq!(
            head("/relay/api/mobile/v1/health?x=1").routed_path(),
            "/api/mobile/v1/health?x=1"
        );
        // 部署前缀也可能落在中间：中转地址被填成 `https://host/relay` 时，
        // 真实流量长成这个形状。
        assert_eq!(
            head("/relay/api/mobile/v1/sessions?x=1").routed_path(),
            "/api/mobile/v1/sessions?x=1"
        );
        assert_eq!(
            head("/relay/api/mobile/v1/sessions").routed_path(),
            "/api/mobile/v1/sessions"
        );
        // 不含手机 API 前缀的路径不做任何改写。
        assert_eq!(
            head("/relay/whatever/thing").routed_path(),
            "/relay/whatever/thing"
        );
    }

    #[test]
    fn presented_credentials_lists_the_header_before_the_bearer() {
        // 两份都在：header 那份排前面，判据先算它、未命中再算 Bearer。两份都不看前缀
        // ——T1 之后设备凭据本身就是一段任意 Bearer。
        let mut both = head("/api/mobile/v1/sessions");
        both.headers = vec![
            (
                "authorization".into(),
                "Bearer 99d9d3ee.1800000000.bearer".into(),
            ),
            (
                "x-dsh-device-credential".into(),
                " 99d9d3ee.1800000000.header ".into(),
            ),
        ];
        assert_eq!(
            presented_credentials(&both),
            vec![
                "99d9d3ee.1800000000.header".to_string(),
                "99d9d3ee.1800000000.bearer".to_string(),
            ]
        );

        // 只带 Bearer 的那一版（很早的客户端把凭据塞在 Bearer 位上）照旧认。
        let mut bearer_only = head("/api/mobile/v1/sessions");
        bearer_only.headers = vec![(
            "authorization".into(),
            "Bearer 99d9d3ee.1800000000.bearer".into(),
        )];
        assert_eq!(
            presented_credentials(&bearer_only),
            vec!["99d9d3ee.1800000000.bearer".to_string()]
        );

        // 两头都没有、或者 Bearer 是空的：空列表，调用方据此回 401。
        assert!(presented_credentials(&head("/api/mobile/v1/sessions")).is_empty());
        let mut empty_bearer = head("/api/mobile/v1/sessions");
        empty_bearer.headers = vec![("authorization".into(), "Bearer   ".into())];
        assert!(presented_credentials(&empty_bearer).is_empty());
    }

    /// 起一条真连接跑一遍 `serve_connection`，把响应原样拿回来。
    ///
    /// 控制面那几条必须由中转**自己**当场写完，所以这条路径上不会有等待宿主的部分；
    /// 跑不通会撞到下面那个超时，而不是把用例挂死。
    async fn respond_to(raw_request: &str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let slot = Arc::new(TunnelSlot::new());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            serve_connection(stream, slot).await.unwrap();
        });
        let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
        client.write_all(raw_request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::io::AsyncReadExt::read_to_end(&mut client, &mut response),
        )
        .await
        .expect("控制面路径必须当场应答，不能挂在转发或等宿主上")
        .unwrap();
        server.await.unwrap();
        String::from_utf8_lossy(&response).to_string()
    }

    /// 宿主控制面在中转上一律 404，裸路径与带部署前缀的形态都要覆盖。
    ///
    /// 最后两条单列，是因为它们以中转自己的认领路径结尾（`/status`、`/healthz`）：
    /// 只判控制面字符串而不抢在认领路径之前，会被末尾判定答成 200。
    #[tokio::test]
    async fn control_plane_paths_are_404_in_both_forms() {
        for path in [
            "/api/relay",
            "/api/relay/config",
            "/api/relay/config?x=1",
            "/relay/api/relay/config",
            "/relay/api/relay/status",
            "/api/relay/healthz",
        ] {
            let response = respond_to(&format!("GET {path} HTTP/1.1\r\nhost: relay\r\n\r\n")).await;
            assert!(
                response.starts_with("HTTP/1.1 404 "),
                "{path} 必须 404，实际是 {response}"
            );
        }
    }

    /// WebSocket 升级请求走同一道判断：升级分支若排在控制面判断之前，控制面的 WS
    /// 请求就绕过 404 直接进宿主。
    #[tokio::test]
    async fn control_plane_websocket_upgrades_are_404_too() {
        let response = respond_to(
            "GET /relay/api/relay/ws HTTP/1.1\r\n\
             host: relay\r\n\
             upgrade: websocket\r\n\
             connection: Upgrade\r\n\
             sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             sec-websocket-version: 13\r\n\r\n",
        )
        .await;
        assert!(
            response.starts_with("HTTP/1.1 404 "),
            "控制面的升级请求必须 404，实际是 {response}"
        );
    }

    /// 迁移记录里那份凭据摘要的算法（与 `mirror` 内部同一判据）。
    fn sha256_hex(text: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(text.as_bytes());
        hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// 实例搬走了：503 里带上新地址与响应头，手机据此自己切过去。
    ///
    /// 这条是这项功能的主用例——没有它，拿旧地址的手机只会看到「那台宿主不在线」。
    #[tokio::test]
    async fn moved_instance_points_the_phone_at_the_new_relay() {
        let _guard = crate::migrate::test_lock();
        assert!(crate::migrate::remember(
            "http-moved",
            br#"{"to":"https://new.example.com","at":1700000000000}"#
        ));
        let response = respond_to(
            "GET /api/mobile/v1/sessions HTTP/1.1\r\n\
             host: relay\r\n\
             x-dsh-instance: http-moved\r\n\r\n",
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 503 "), "要 503，实际是 {response}");
        assert!(
            response.contains("x-dsh-migrated-to: https://new.example.com"),
            "响应头必须带新地址：{response}"
        );
        assert!(response.contains(r#""code":"migrated""#), "{response}");
        assert!(
            response.contains(r#""to":"https://new.example.com""#),
            "响应体里的 to 必须是同一个地址：{response}"
        );
        assert!(
            response.contains(r#""error":"that host moved to another relay""#),
            "{response}"
        );
    }

    /// 没有迁移记录时**仍是原来那句 503**：老客户端靠它判断「那台不在线」，
    /// 一个字节都不许变，也不许凭空多一个头。
    #[tokio::test]
    async fn instance_without_a_migration_keeps_the_plain_503() {
        let _guard = crate::migrate::test_lock();
        let response = respond_to(
            "GET /api/mobile/v1/sessions HTTP/1.1\r\n\
             host: relay\r\n\
             x-dsh-instance: http-absent\r\n\r\n",
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 503 "), "实际是 {response}");
        assert!(
            !response.contains("x-dsh-migrated-to"),
            "没有记录就不该带这个头：{response}"
        );
        assert!(
            response.ends_with(r#"{"ok":false,"error":"that host is not connected to this relay"}"#),
            "那句 503 必须原样：{response}"
        );
    }

    /// 手机 WS 桥接与 HTTP 走同一条判据：握手阶段就把新地址交出去。
    #[tokio::test]
    async fn moved_instance_also_points_the_phone_ws_at_the_new_relay() {
        let _guard = crate::migrate::test_lock();
        assert!(crate::migrate::remember(
            "ws-moved",
            br#"{"to":"https://new.example.com","at":1}"#
        ));
        let response = respond_to(
            "GET /api/mobile/v1/ws HTTP/1.1\r\n\
             host: relay\r\n\
             x-dsh-instance: ws-moved\r\n\
             upgrade: websocket\r\n\
             connection: Upgrade\r\n\
             sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             sec-websocket-version: 13\r\n\r\n",
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 503 "), "实际是 {response}");
        assert!(
            response.contains("x-dsh-migrated-to: https://new.example.com"),
            "{response}"
        );
    }

    /// 迁移记录**压过镜像兜底**。
    ///
    /// 反过来的话，手机拿到一份 200 的旧清单就满足了，永远学不到新地址——那正是这条
    /// 记录要解决的那个问题（`mirror` 的缓存命中不改变「这台实例已经不在这儿了」）。
    #[tokio::test]
    async fn migration_beats_the_mirror_cache() {
        let _guard = crate::migrate::test_lock();
        let instance = "http-moved-with-mirror";
        let credential = "http-moved-with-mirror.1800000000.cred";
        let sync = serde_json::json!({
            "kind": "sync",
            "at": 1,
            "sessions": { "ok": true, "items": [], "revision": "aaa", "generatedAt": 111 },
            "workspaces": { "ok": true, "items": [], "revision": "bbb", "generatedAt": 222 },
            "creds": [{ "hash": sha256_hex(credential) }],
        })
        .to_string();
        assert!(crate::mirror::remember(instance, sync.as_bytes()));
        assert!(crate::migrate::remember(
            instance,
            br#"{"to":"https://new.example.com","at":1}"#
        ));

        let response = respond_to(&format!(
            "GET /api/mobile/v1/sessions HTTP/1.1\r\n\
             host: relay\r\n\
             x-dsh-instance: {instance}\r\n\
             x-dsh-device-credential: {credential}\r\n\r\n"
        ))
        .await;
        assert!(
            response.starts_with("HTTP/1.1 503 "),
            "有迁移记录时不该回镜像的 200：{response}"
        );
        assert!(
            response.contains("x-dsh-migrated-to: https://new.example.com"),
            "{response}"
        );
        assert!(!response.contains("x-dsh-relay-mirror"), "{response}");
    }
}
