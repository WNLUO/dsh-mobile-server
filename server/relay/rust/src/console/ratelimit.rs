//! 公开接口的限流。
//!
//! 只挡一类事：**有人拿公开端点当免费查询服务无限地打**。这些端点必须匿名可调
//! （激活码校验要手机在配对前就能问，被控端上报没有账号），所以挡不住就不挡了，
//! 每一下都要扫一次数据库。
//!
//! ## 边界
//!
//! 这里不是防爆破设计。激活码是 32^16 的码空间，猜中是天文数字级别的小概率；
//! 限流的目标是**成本**——让刷的人每单位时间只能花我们有限的查询量，而不是
//! 让猜测变得不可能。所以阈值定得松：正常用户手抄一个码、填错两三次再改对，
//! 远在限额之内。
//!
//! ## 为什么是固定窗口而不是令牌桶
//!
//! 要的是「别无限打」，不是精确平滑。固定窗口一个计数器就够，代码短、看得懂、
//! 不容易出错。代价是窗口边界上最多能过两倍额度，对这个用途无所谓。
//!
//! ## 按什么分桶
//!
//! 优先取 nginx 传进来的 `x-real-ip`，没有就用连接的对端地址。**不能只取
//! `x-forwarded-for` 的第一段**——那是客户端自己填的，随便伪造；
//! 而 `x-real-ip` 是本机 nginx 覆盖写入的（`proxy_set_header X-Real-IP $remote_addr`），
//! 客户端改不了。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 一个桶：某类请求在某个窗口里的次数。
#[derive(Debug)]
struct Bucket {
    window_start: Instant,
    count: u32,
}

/// 按键计数。几类请求各用一个实例。
#[derive(Debug)]
pub struct Limiter {
    /// 窗口长度。
    window: Duration,
    /// 一个窗口内允许的次数。
    limit: u32,
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl Limiter {
    pub fn new(limit: u32, window: Duration) -> Self {
        Self {
            window,
            limit,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// 记一次，返回「这次允不允许」。
    ///
    /// 超了也照样计数（只是不再放行），所以持续猛刷不会在窗口末尾突然被放过去。
    pub fn allow(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());

        // 顺手收拾过期桶：不然刷的人换个 IP 就换一个桶，内存只涨不落。
        // 只在表比较大时才扫，避免每请求都遍历一遍。
        if buckets.len() > 1024 {
            let window = self.window;
            buckets.retain(|_, bucket| now.duration_since(bucket.window_start) < window);
        }

        let bucket = buckets.entry(key.to_string()).or_insert(Bucket {
            window_start: now,
            count: 0,
        });
        if now.duration_since(bucket.window_start) >= self.window {
            bucket.window_start = now;
            bucket.count = 0;
        }
        bucket.count = bucket.count.saturating_add(1);
        bucket.count <= self.limit
    }
}

/// 从请求里取客户端 IP。
///
/// 顺序：`x-real-ip`（nginx 覆盖写入，可信）→ 连接对端。都没有就归到一个公共桶
/// ——宁可共用一个额度，也不要因为拿不到 IP 就整个不限。
pub fn client_key(headers: &[(String, String)], peer: Option<SocketAddr>) -> String {
    if let Some(value) = headers
        .iter()
        .find(|(k, _)| k == "x-real-ip")
        .map(|(_, v)| v.trim())
        .filter(|v| !v.is_empty())
    {
        return value.to_string();
    }
    match peer {
        Some(addr) => addr.ip().to_string(),
        None => "unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(value: &str) -> Vec<(String, String)> {
        vec![("x-real-ip".to_string(), value.to_string())]
    }

    #[test]
    fn allows_up_to_limit_then_blocks() {
        let limiter = Limiter::new(3, Duration::from_secs(60));
        assert!(limiter.allow("1.2.3.4"));
        assert!(limiter.allow("1.2.3.4"));
        assert!(limiter.allow("1.2.3.4"));
        assert!(!limiter.allow("1.2.3.4"), "第四次必须被挡");
        // 别的来源不受影响。
        assert!(limiter.allow("5.6.7.8"));
    }

    #[test]
    fn window_rolls_over() {
        let limiter = Limiter::new(1, Duration::from_millis(80));
        assert!(limiter.allow("a"));
        assert!(!limiter.allow("a"));
        std::thread::sleep(Duration::from_millis(120));
        assert!(limiter.allow("a"), "过了窗口应该重新放行");
    }

    #[test]
    fn prefers_real_ip_then_peer() {
        let peer = Some("9.9.9.9:1234".parse().unwrap());
        assert_eq!(client_key(&headers("1.2.3.4"), peer), "1.2.3.4", "有 x-real-ip 就信它");
        // 只带 x-forwarded-for 时**不当真**：那是客户端自己填的。
        let spoofed = vec![("x-forwarded-for".to_string(), "6.6.6.6".to_string())];
        assert_eq!(client_key(&spoofed, peer), "9.9.9.9", "伪造的 forwarded-for 不许当 IP");
        assert_eq!(client_key(&[], None), "unknown");
        assert_eq!(client_key(&headers("   "), peer), "9.9.9.9", "空的 x-real-ip 落到对端");
    }
}
