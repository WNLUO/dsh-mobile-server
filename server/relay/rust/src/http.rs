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
const OWNED_PATHS: &[&str] = &["/healthz", "/status", "/api/mobile/v1/health", "/tunnel"];

/// 手机 API 的固定前缀。与 `server/relay-core/protocol-types.js` 的 `MOBILE_PREFIX` 一致。
const MOBILE_PREFIX: &str = "/api/mobile/v1/";

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
    // 部署前缀照旧剥掉：`/relay-worker/api/mobile/v1/health` 要能被认成手机 API 路径。
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

/// 读控制台请求体。上限 64KB——控制台只有被控端上报那条带体，且内容是个小 JSON。
async fn read_console_body(reader: &mut BufReader<TcpStream>, head: &RequestHead) -> Vec<u8> {
    const MAX_CONSOLE_BODY: usize = 64 * 1024;
    let Some(length) = head.content_length() else {
        return Vec::new();
    };
    let length = length.min(MAX_CONSOLE_BODY);
    let mut body = vec![0u8; length];
    // ⚠️ 必须从 **BufReader** 读，不能从 `reader.get_mut()` 读：读请求头时 BufReader
    // 很可能已经把 body 一起预读进自己的缓冲区了，这时裸流上已经没有字节，
    // `read_exact` 会一直等（请求挂死、服务端什么都不记）。同 A4-12 那个
    // `into_inner()` 丢缓冲区的坑，方向相反但同一个根因。
    match tokio::io::AsyncReadExt::read_exact(&mut *reader, &mut body).await {
        Ok(_) => body,
        Err(_) => Vec::new(),
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
            // 与 Workers 版对齐的在线状态：只回答「隧道通没通」，不泄露实例与设备。
            let host_connected = slot.get().map(|t| !t.is_closed()).unwrap_or(false);
            let body = format!(r#"{{"ok":true,"hostConnected":{host_connected}}}"#);
            respond_json(reader, 200, &body).await?;
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
                    read_console_body(reader, head).await
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
                let body = read_console_body(reader, head).await;
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
    // 分发给哪条隧道，看手机自己带的 `X-Dsh-Instance`。
    //
    // **找不到就 503，绝不退回到「随便挑一条」**：公用中转上随便挑一条等于把 A 家的
    // 请求送进 B 家的电脑，那是最坏的串台。宁可报「那台不在线」，让手机自己判断
    // 是切换地址还是重连。
    //
    // 没带实例 id 的唯一例外是手动输配对码（见下）：中转上只有一台宿主时才无歧义。
    let instance = head.header("x-dsh-instance").unwrap_or_default();
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

    crate::proxy::proxy_request(reader, head, tunnel, slot).await
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
        // Worker 挂在自定义域名下时，控制台给的路由带前缀；用户照抄进 App 就是这个形状。
        for path in ["/relay-worker/healthz", "/relay/healthz", "/healthz"] {
            assert_eq!(strip_deploy_prefix(path), "/healthz", "{path}");
        }
        assert_eq!(strip_deploy_prefix("/relay-worker/status"), "/status");
        assert_eq!(
            strip_deploy_prefix("/relay-worker/api/mobile/v1/health"),
            "/api/mobile/v1/health"
        );
        assert_eq!(strip_deploy_prefix("/relay-worker/tunnel"), "/tunnel");
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
            strip_deploy_prefix("/relay-worker/api/mobile/v1/status"),
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
            head("/relay-worker/api/mobile/v1/health?x=1").routed_path(),
            "/api/mobile/v1/health?x=1"
        );
        // 部署前缀也可能落在中间：用户照抄 Cloudflare 路由、或者把中转地址填成
        // `https://host/relay` 时，真实流量长成这个形状。
        assert_eq!(
            head("/relay/api/mobile/v1/sessions?x=1").routed_path(),
            "/api/mobile/v1/sessions?x=1"
        );
        assert_eq!(
            head("/relay-worker/api/mobile/v1/sessions").routed_path(),
            "/api/mobile/v1/sessions"
        );
        // 不含手机 API 前缀的路径不做任何改写。
        assert_eq!(
            head("/relay/whatever/thing").routed_path(),
            "/relay/whatever/thing"
        );
    }
}
