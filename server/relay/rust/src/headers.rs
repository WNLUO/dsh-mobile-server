//! 请求头转发与显式可信代理来源解析，供中转和控制面共用。
//!
//! 中转不解释业务语义：逐跳头与 `host` 之外一律原样带过去。
//!
//! 逐跳头集合与 `dsh-mobile-plugin/lib/relay/lan-proxy.js` 手工同步，由
//! `dsh-mobile-plugin/test/shared-helpers-parity.test.cjs` 逐项比对——改这里要同步改那边。

use std::net::{IpAddr, SocketAddr};

#[derive(Debug, Clone)]
pub struct ProxyCidr { network: IpAddr, prefix: u8 }

impl ProxyCidr {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let (ip, prefix) = raw.trim().split_once('/').ok_or_else(|| format!("invalid proxy CIDR: {raw}"))?;
        let network: IpAddr = ip.parse().map_err(|_| format!("invalid proxy IP: {raw}"))?;
        let prefix: u8 = prefix.parse().map_err(|_| format!("invalid proxy prefix: {raw}"))?;
        if prefix > if network.is_ipv4() { 32 } else { 128 } { return Err(format!("invalid proxy prefix: {raw}")); }
        Ok(Self { network, prefix })
    }
    pub fn contains(&self, address: IpAddr) -> bool {
        match (self.network, address) {
            (IpAddr::V4(a), IpAddr::V4(b)) => {
                let mask = u32::MAX.checked_shl((32 - self.prefix) as u32).unwrap_or(0);
                u32::from(a) & mask == u32::from(b) & mask
            }
            (IpAddr::V6(a), IpAddr::V6(b)) => {
                let mask = u128::MAX.checked_shl((128 - self.prefix) as u32).unwrap_or(0);
                u128::from(a) & mask == u128::from(b) & mask
            }
            _ => false,
        }
    }
}

pub fn parse_trusted_proxies(raw: &str) -> Result<Vec<ProxyCidr>, String> {
    raw.split(',').map(str::trim).filter(|s| !s.is_empty()).map(ProxyCidr::parse).collect()
}

pub fn default_trusted_proxies() -> Vec<ProxyCidr> {
    parse_trusted_proxies("127.0.0.0/8,::1/128").expect("fixed loopback CIDRs")
}

pub fn trusted_proxy(peer: IpAddr, proxies: &[ProxyCidr]) -> bool {
    proxies.iter().any(|cidr| cidr.contains(peer))
}

/// 不信任代理时永远用peer；可信代理只认一个严格IP形式的X-Real-IP。
pub fn client_ip(peer: Option<SocketAddr>, headers: &[(String, String)], proxies: &[ProxyCidr]) -> Option<IpAddr> {
    let peer = peer?.ip();
    if !trusted_proxy(peer, proxies) { return Some(peer); }
    headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("x-real-ip"))
        .and_then(|(_, value)| value.trim().parse().ok()).or(Some(peer))
}

/// 状态接口仍单独鉴权：远端直连不能靠伪造头放行，代理缺真实来源时也不放行。
pub fn local_status_request(peer: Option<SocketAddr>, headers: &[(String, String)], proxies: &[ProxyCidr]) -> bool {
    let Some(peer) = peer else { return false };
    let real = headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("x-real-ip"));
    let forwarded = headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("x-forwarded-for"));
    if real.is_none() && !forwarded { return peer.ip().is_loopback(); }
    if !trusted_proxy(peer.ip(), proxies) { return false; }
    real.and_then(|(_, value)| value.trim().parse::<IpAddr>().ok()).map(|ip| ip.is_loopback()).unwrap_or(false)
}

/// 默认探测逐跳头时用的集合。
///
/// 这些头只对单条 TCP 连接有意义，转给对端会把连接语义一起带过去。
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
];

/// 某个头是否可转发：逐跳头之外一律转发；`host` 指向中转自己的域名，不能带给宿主。
pub fn forwardable_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !HOP_BY_HOP.contains(&lower.as_str()) && lower != "host"
}

/// 从一串头里挑出可转发的，名字统一小写。
pub fn pick_forward_headers<'a, I>(headers: I) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    headers
        .into_iter()
        .filter_map(|(name, value)| {
            let lower = name.to_ascii_lowercase();
            forwardable_header(&lower).then(|| (lower, value.to_string()))
        })
        .collect()
}

/// 响应头与请求头只差一处：**`content-length` 不是逐跳头，要留着**。
///
/// 它描述的是这条响应自己的体积，转发它不会把连接语义带过去；丢掉它的唯一后果是
/// 每一发响应都退化成 `transfer-encoding: chunked` —— 客户端拿不到长度（进度条、
/// 断点续传都无从下手），中间的 nginx 也没法定长转发（只能攒批）。宿主侧每发响应
/// 本来就带这个头（`sendJson` 的定长 JSON），所以这里几乎总能拿到。
fn forwardable_response_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower == "content-length" {
        return true;
    }
    forwardable_header(&lower)
}

/// 响应头走同一套规则（+ `content-length`，见上）。
pub fn sanitize_resp_headers(headers: Vec<(String, String)>) -> Vec<(String, String)> {
    headers
        .into_iter()
        .filter_map(|(name, value)| {
            let lower = name.to_ascii_lowercase();
            forwardable_response_header(&lower).then(|| (lower, value))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_cidrs_and_source_headers_have_one_trust_boundary() {
        let proxies = parse_trusted_proxies("127.0.0.0/8,::1/128,10.2.0.0/16,2001:db8::/32").unwrap();
        let socket = |raw: &str| Some(raw.parse::<SocketAddr>().unwrap());
        let headers = |raw: &str| vec![("x-real-ip".to_string(), raw.to_string())];
        assert_eq!(client_ip(socket("10.2.1.2:80"), &headers("203.0.113.8"), &proxies), Some("203.0.113.8".parse().unwrap()));
        assert_eq!(client_ip(socket("10.3.1.2:80"), &headers("127.0.0.1"), &proxies), Some("10.3.1.2".parse().unwrap()));
        assert_eq!(client_ip(socket("127.0.0.1:80"), &headers("203.0.113.8, 127.0.0.1"), &proxies), Some("127.0.0.1".parse().unwrap()));
        assert!(!local_status_request(socket("127.0.0.1:80"), &headers("203.0.113.8"), &proxies));
        assert!(local_status_request(socket("10.2.1.2:80"), &headers("::1"), &proxies));
        assert!(!local_status_request(socket("10.3.1.2:80"), &headers("::1"), &proxies));
        assert!(!local_status_request(socket("10.2.1.2:80"), &[], &proxies));
        assert!(!local_status_request(socket("127.0.0.1:80"), &headers("bad"), &proxies));
        assert!(parse_trusted_proxies("10.0.0.0/33").is_err());
        assert!(parse_trusted_proxies("::1/129").is_err());
        assert!(parse_trusted_proxies("").unwrap().is_empty());
    }

    #[test]
    fn hop_by_hop_and_host_are_dropped() {
        for name in HOP_BY_HOP {
            assert!(!forwardable_header(name), "{name} 应当被丢掉");
        }
        assert!(!forwardable_header("host"));
        assert!(!forwardable_header("Host"));
    }

    #[test]
    fn ordinary_headers_pass_through() {
        for name in ["accept", "content-type", "authorization", "x-dsh-device-credential"] {
            assert!(forwardable_header(name), "{name} 应当被转发");
        }
    }

    #[test]
    fn mixed_case_hop_headers_are_dropped() {
        // 大小写混杂不能让逐跳头漏过去。
        for name in ["Connection", "CONTENT-LENGTH", "Transfer-Encoding", "Keep-Alive"] {
            assert!(!forwardable_header(name), "{name} 应当被丢掉");
        }
    }

    #[test]
    fn pick_keeps_values_and_lowercases_names() {
        let picked = pick_forward_headers(vec![
            ("Accept", "text/html"),
            ("Host", "relay.example"),
            ("X-Request-Id", "abc"),
        ]);
        assert_eq!(
            picked,
            vec![
                ("accept".to_string(), "text/html".to_string()),
                ("x-request-id".to_string(), "abc".to_string()),
            ]
        );
    }

    #[test]
    fn response_headers_use_the_same_rules() {
        let cleaned = sanitize_resp_headers(vec![
            ("Content-Type".to_string(), "text/plain".to_string()),
            ("Transfer-Encoding".to_string(), "chunked".to_string()),
        ]);
        assert_eq!(cleaned, vec![("content-type".to_string(), "text/plain".to_string())]);
    }

    /// 响应侧的 `content-length` 要留着，请求侧照旧丢掉。
    ///
    /// 响应侧的它只描述这条响应自己的体积，不是逐跳头；丢掉只会让每发响应退化成
    /// chunked，客户端拿不到长度、中间的 nginx 也只能攒批转发。请求侧留着它没有意义
    /// ——宿主读的是转发过来的 body，长度由中转这条连接自己定。
    #[test]
    fn content_length_survives_on_responses_only() {
        let kept = sanitize_resp_headers(vec![("Content-Length".to_string(), "42".to_string())]);
        assert_eq!(kept, vec![("content-length".to_string(), "42".to_string())]);
        assert!(!forwardable_header("content-length"));
    }
}
