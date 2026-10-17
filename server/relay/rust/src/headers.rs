//! 请求头 / 响应头的转发规则。
//!
//! 中转不解释业务语义：逐跳头与 `host` 之外一律原样带过去。
//!
//! 逐跳头集合与 `dsh-mobile-plugin/lib/relay/lan-proxy.js` 手工同步，由
//! `dsh-mobile-plugin/test/shared-helpers-parity.test.cjs` 逐项比对——改这里要同步改那边。

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

/// 响应头走同一套规则。
pub fn sanitize_resp_headers(headers: Vec<(String, String)>) -> Vec<(String, String)> {
    headers
        .into_iter()
        .filter_map(|(name, value)| {
            let lower = name.to_ascii_lowercase();
            forwardable_header(&lower).then(|| (lower, value))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
