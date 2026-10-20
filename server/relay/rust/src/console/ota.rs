//! 插件 OTA 的**临时通道**。
//!
//! 正式分发归 npm 插件市场（`dsh-mobile-plugin/lib/shell/updater.js`）；这里只服务
//! 宿主里那条救急通道（`lib/shell/device-ota.js`）：
//!
//!   GET  /api/desktop-plugins/ota/latest?platform=&channel=
//!        → `{ ok, data: { version, platform, channel, packageUrl } }`
//!   GET  /api/desktop-plugins/ota/download/<platform>/<channel>/<version>.tar.gz
//!        → 那个包本身
//!   POST /api/desktop-plugins/ota/publish   （Bearer 控制面 token）
//!        → 登记一个包并让它成为该平台/渠道的最新版
//!
//! **刻意比运营版简单**：不再有 manifest 校验、content hash、增量发布、多插件矩阵——
//! 那套是给「正式分发」设计的，而这边是临时救急：把某个版本塞给某台机器。客户端
//! （`device-ota.js`）只读得到那五个字段（version / platform / channel / packageUrl / sha256）。
//!
//! 包格式必须与客户端的解包器对得上：tar 里条目以 `package/` 打头，且包含
//! `package.json` 与 `lib/impl.js`，否则客户端会判「OTA 包结构不完整」。包里还有一份
//! `lib/ota-manifest.json`（发布脚本生成），客户端解包后逐项核对——缺文件、大小不符都在
//! **激活之前**失败。哈希也在这里算：下载回来的字节对不上就不装。

use std::path::{Path, PathBuf};

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::store::Store;
use super::config::ConsoleConfig;
use super::ConsoleResponse;

/// 一个版本号长什么样：`X.Y.Z`。
fn valid_version(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// 平台与渠道只允许字母数字与 `-`：它们要拼进磁盘路径，不能让 `..` 混进去。
fn safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn channel_of(query: &str) -> String {
    super::oidc::query_param(query, "channel").unwrap_or_else(|| "stable".to_string())
}

fn platform_of(query: &str) -> String {
    super::oidc::query_param(query, "platform").unwrap_or_default()
}

/// 客户端问「该装哪个版本」。没有匹配的版本就回 `ok:false` 让客户端判「没有更新」。
pub fn handle_latest(
    store: &Store,
    config: &ConsoleConfig,
    query: &str,
) -> ConsoleResponse {
    let platform = platform_of(query);
    let channel = channel_of(query);
    if platform.is_empty() {
        return ConsoleResponse::json(
            400,
            json!({ "ok": false, "error": "platform is required" }),
        );
    }
    match store.latest_ota_release(&platform, &channel) {
        Some(release) => ConsoleResponse::json(
            200,
            json!({
                "ok": true,
                "data": {
                    "version": release.version,
                    "platform": release.platform,
                    "channel": release.channel,
                    // 下载地址由配置的公开基址拼，**不反射请求的 Host**——
                    // 否则任何人都能让响应指向自己的域名。
                    "packageUrl": format!(
                        "{}/api/desktop-plugins/ota/download/{}/{}/{}",
                        config.public_base_url,
                        release.platform,
                        release.channel,
                        release.version
                    ),
                    "size": release.size,
                    // 客户端下载后核对；老库/老记录这里是空串，客户端见到空串就跳过校验。
                    "sha256": release.sha256,
                }
            }),
        ),
        None => ConsoleResponse::json(200, json!({ "ok": false, "reason": "no release" })),
    }
}

/// 下载一个包。路径结构 `<platform>/<channel>/<version>`（`.tar.gz` 后缀可省）。
pub fn handle_download(store: &Store, rest: &str) -> ConsoleResponse {
    let trimmed = rest.trim_end_matches(".tar.gz");
    let mut parts = trimmed.split('/');
    let (Some(platform), Some(channel), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return ConsoleResponse::text(404, "not found\n");
    };
    if parts.next().is_some() || !safe_segment(platform) || !safe_segment(channel) || !valid_version(version) {
        return ConsoleResponse::text(404, "not found\n");
    }
    let Some(release) = store.latest_for_exact(platform, channel, version) else {
        return ConsoleResponse::text(404, "not found\n");
    };
    match std::fs::read(&release.package_path) {
        Ok(bytes) => ConsoleResponse {
            status: 200,
            content_type: "application/gzip",
            body: bytes,
            set_cookie: None,
            redirect: None,
        },
        // 库里有记录、盘上没文件：说明运维动过目录，如实回 404 而不是空 200。
        Err(_) => ConsoleResponse::text(404, "package missing on disk\n"),
    }
}

/// 接收一个包。请求体就是 tar.gz 本身，平台/渠道/版本走查询串。
///
/// 鉴权是 Bearer 控制面 token；没配 token 时整个发布接口关闭（下载不受影响）。
pub fn handle_publish(
    store: &Store,
    config: &ConsoleConfig,
    query: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> ConsoleResponse {
    if config.ota_control_token.is_empty() {
        return ConsoleResponse::json(
            403,
            json!({ "ok": false, "error": "publishing is disabled (PLATFORM_OTA_CONTROL_TOKEN unset)" }),
        );
    }
    let provided = headers
        .iter()
        .find(|(k, _)| k == "authorization")
        .map(|(_, v)| v.trim_start_matches("Bearer ").trim().to_string())
        .unwrap_or_default();
    if provided != config.ota_control_token {
        return ConsoleResponse::json(401, json!({ "ok": false, "error": "bad control token" }));
    }

    let platform = platform_of(query);
    let channel = channel_of(query);
    let version = super::oidc::query_param(query, "version").unwrap_or_default();
    if !safe_segment(&platform) || !safe_segment(&channel) || !valid_version(&version) {
        return ConsoleResponse::json(
            400,
            json!({ "ok": false, "error": "platform / channel / version (X.Y.Z) are required" }),
        );
    }
    if body.is_empty() {
        return ConsoleResponse::json(400, json!({ "ok": false, "error": "empty package" }));
    }
    // gzip 魔数。先挡一层明显不是包的东西，免得盘上留一堆垃圾。
    if body.len() < 2 || body[0] != 0x1f || body[1] != 0x8b {
        return ConsoleResponse::json(
            400,
            json!({ "ok": false, "error": "body must be a gzip tarball" }),
        );
    }

    let dir: PathBuf = Path::new(&config.ota_root)
        .join(&platform)
        .join(&channel);
    if let Err(error) = std::fs::create_dir_all(&dir) {
        return ConsoleResponse::json(
            500,
            json!({ "ok": false, "error": format!("创建目录失败: {error}") }),
        );
    }
    let file = dir.join(format!("{version}.tar.gz"));
    if let Err(error) = std::fs::write(&file, body) {
        return ConsoleResponse::json(
            500,
            json!({ "ok": false, "error": format!("写包失败: {error}") }),
        );
    }
    // 哈希在这里算：客户端下载后会核对，半个包 / 被中间层改过的包在激活之前就会被挡下。
    let sha256 = format!("{:x}", Sha256::digest(body));
    store.put_ota_release(
        &platform,
        &channel,
        &version,
        &file.to_string_lossy(),
        body.len() as i64,
        &sha256,
    );
    ConsoleResponse::json(
        200,
        json!({
            "ok": true,
            "data": { "platform": platform, "channel": channel, "version": version, "size": body.len(), "sha256": sha256 },
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ConsoleConfig {
        let mut config = ConsoleConfig::from_env();
        config.public_base_url = "https://relay.example.com".into();
        config.ota_control_token = "tok".into();
        config
    }

    #[test]
    fn version_and_segment_validation() {
        assert!(valid_version("0.1.60"));
        assert!(!valid_version("v0.1.60"));
        assert!(!valid_version("0.1"));
        assert!(safe_segment("darwin"));
        assert!(!safe_segment(".."));
        assert!(!safe_segment("a/b"));
        assert!(!safe_segment(""));
    }

    #[test]
    fn latest_reports_no_release_before_any_publish() {
        let store = Store::in_memory().unwrap();
        let response = handle_latest(&store, &config(), "platform=darwin&channel=stable");
        assert_eq!(response.status, 200);
        let body: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(body["ok"], false, "没发过包时必须是 ok:false，客户端据此判没有更新");
    }

    #[test]
    fn publish_then_latest_returns_download_url() {
        let store = Store::in_memory().unwrap();
        let config = config();
        let dir = std::env::temp_dir().join(format!("dsh-ota-test-{}", std::process::id()));
        let mut config = config;
        config.ota_root = dir.to_string_lossy().to_string();

        let headers = vec![("authorization".to_string(), "Bearer tok".to_string())];
        // 最小合法 gzip 头（内容不重要，这里只验登记与回 URL 这两步）
        let published = handle_publish(
            &store,
            &config,
            "platform=darwin&channel=stable&version=0.1.61",
            &headers,
            &[0x1f, 0x8b, 0x08, 0x00],
        );
        assert_eq!(published.status, 200, "{:?}", String::from_utf8_lossy(&published.body));
        let published_body: serde_json::Value = serde_json::from_slice(&published.body).unwrap();
        assert_eq!(published_body["data"]["size"].as_u64().unwrap(), 4, "回执里的 size 必须是真收下的字节数");
        assert_eq!(
            published_body["data"]["sha256"].as_str().unwrap(),
            format!("{:x}", Sha256::digest([0x1f, 0x8b, 0x08, 0x00])),
            "发布回执必须带上哈希，发布脚本据此核对"
        );

        let latest = handle_latest(&store, &config, "platform=darwin&channel=stable");
        let body: serde_json::Value = serde_json::from_slice(&latest.body).unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["data"]["version"], "0.1.61");
        assert!(body["data"]["packageUrl"]
            .as_str()
            .unwrap()
            .starts_with("https://relay.example.com/api/desktop-plugins/ota/download/darwin/stable/0.1.61"));
        // 客户端拿这个哈希核对下载回来的字节：发布体是 [0x1f,0x8b,0x08,0x00] 这四字节。
        assert_eq!(
            body["data"]["sha256"].as_str().unwrap(),
            format!("{:x}", Sha256::digest([0x1f, 0x8b, 0x08, 0x00])),
            "latest 必须把发布时算好的 sha256 原样带回去"
        );
        assert_eq!(body["data"]["size"].as_u64().unwrap(), 4);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn publish_requires_token() {
        let store = Store::in_memory().unwrap();
        let config = config();
        let body = handle_publish(&store, &config, "platform=darwin&channel=stable&version=1.0.0", &[], &[0x1f, 0x8b]);
        assert_eq!(body.status, 401, "没有 Bearer token 必须拒");

        let wrong = handle_publish(
            &store,
            &config,
            "platform=darwin&channel=stable&version=1.0.0",
            &[("authorization".to_string(), "Bearer nope".to_string())],
            &[0x1f, 0x8b],
        );
        assert_eq!(wrong.status, 401);

        // 没配 token 时整个发布关闭
        let mut disabled = config.clone();
        disabled.ota_control_token = String::new();
        let closed = handle_publish(&store, &disabled, "platform=darwin&channel=stable&version=1.0.0", &[], &[0x1f, 0x8b]);
        assert_eq!(closed.status, 403);
    }

    #[test]
    fn only_latest_version_is_served() {
        let store = Store::in_memory().unwrap();
        let mut config = config();
        let dir = std::env::temp_dir().join(format!("dsh-ota-test2-{}", std::process::id()));
        config.ota_root = dir.to_string_lossy().to_string();
        let headers = vec![("authorization".to_string(), "Bearer tok".to_string())];

        handle_publish(&store, &config, "platform=darwin&channel=stable&version=1.0.0", &headers, &[0x1f, 0x8b, 0]);
        handle_publish(&store, &config, "platform=darwin&channel=stable&version=1.0.1", &headers, &[0x1f, 0x8b, 0]);

        let latest = handle_latest(&store, &config, "platform=darwin&channel=stable");
        let body: serde_json::Value = serde_json::from_slice(&latest.body).unwrap();
        assert_eq!(body["data"]["version"], "1.0.1", "latest 必须是最后发的那个");

        // 老版本仍可下载（客户端可能拿着旧链接）。
        assert_eq!(handle_download(&store, "darwin/stable/1.0.0").status, 200);
        // 不存在的版本 404。
        assert_eq!(handle_download(&store, "darwin/stable/9.9.9").status, 404);
        // 路径穿越 404。
        assert_eq!(handle_download(&store, "darwin/stable/../../etc/passwd").status, 404);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
