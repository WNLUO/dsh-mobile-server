//! 公开接口的固定窗口限流；来源与审计共用可信代理解析。
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
//! 调用方传入共享来源解析结果：只信显式可信代理的严格单 IP `x-real-ip`，
//! 其余连接使用对端地址；未知来源共用一个桶，不跳过限流。

use std::collections::HashMap;
use std::net::IpAddr;
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

/// 未知来源归入公共桶，与有来源请求一样受限。
pub fn client_key(ip: Option<IpAddr>) -> String {
    ip.map(|ip| ip.to_string()).unwrap_or_else(|| "unknown".into())
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
    fn uses_shared_trusted_source_and_keeps_unknown_limited() {
        let proxies = crate::headers::default_trusted_proxies();
        let direct = Some("9.9.9.9:1234".parse().unwrap());
        let local = Some("127.0.0.1:1234".parse().unwrap());
        let key = |peer, headers: &[(String, String)]| client_key(crate::headers::client_ip(peer, headers, &proxies));
        // CONSOLE05：直连携带可伪造头也只能落在对端桶。
        assert_eq!(key(direct, &headers("1.2.3.4")), "9.9.9.9");
        assert_eq!(key(direct, &headers("5.6.7.8")), "9.9.9.9");
        assert_eq!(key(local, &headers("1.2.3.4")), "1.2.3.4");
        assert_eq!(key(local, &headers("1.2.3.4, 5.6.7.8")), "127.0.0.1");
        assert_eq!(key(None, &headers("1.2.3.4")), "unknown");
        assert!(!Limiter::new(0, Duration::from_secs(60)).allow(&client_key(None)));
    }
}
