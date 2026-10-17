//! 中转自身的自动更新。
//!
//! 从一个**自己控制的静态地址**取新版本，下载对应架构的二进制，校验 sha256，
//! 原子替换，然后退出让 systemd 拉起来。
//!
//! ## 为什么不用 GitHub Release
//!
//! 试过。`api.github.com` 能连，但 `github.com`（Release 资产真正的下载域名）在
//! 国内服务器上连不通；绕开它走 API 的资产直链也只有几十 KB/s，一个 8MB 的二进制
//! 要下一个多小时。中转的更新源必须在国内能稳定访问，所以改成「自己的域名下一组
//! 静态文件」：一个 `latest.json` 描述版本与地址，二进制放在旁边。
//!
//! 代价照实说：这个地址是公开的，谁都能下载（校验和只防篡改，不防别人占用带宽）；
//! 而且它得长期在——地址挂了，自动更新就只是日志里的一条失败，不影响转发。
//!
//! ## 为什么是「替换文件 + 退出」，不是自己重启自己
//!
//! 进程没办法在保持监听的同时把自己的可执行文件换成新的。能做到的做法只有两种：
//! 要么设 `PR_SET_PTRACER` 之后再 exec，要么让外部进程来管。这台中转的生产形态是
//! `Restart=always` 的 systemd 服务，**退出就是重启**——把这件事交给已经存在的机制，
//! 比自己实现一套 `exec` 简单得多，也不会因为 `exec` 失败留下一台僵尸进程。
//!
//! ## 回滚
//!
//! 替换前把旧文件改名留一份。新版本起来之后若 `/health` 拿不到 200，就换回旧文件
//! 再退出一次。**判据是「新进程真的能回答」，不是「文件写成功了」**——写成功但起不来
//! 才是自动更新最坏的形态：机器上没人，服务死了。
//!
//! 回滚状态记录在 `数据目录/.update-state` 里：新版起不来时它会留下一条记录，
//! 下一次启动读到这里就**不再尝试升级**，直到那个文件被删掉（说明人已经上去看过了）。
//!
//! ## 校验的边界
//!
//! `checksums.txt` 和二进制放在同一个 Release 里，能挡住传输损坏（下载到一半、
//! 被中间设备改写），**挡不住同时改了这两个文件的人**。真要防那个得上签名，
//! 那要引入密钥管理与轮换，对一台自发布的中转来说成本远大于收益。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

// 更新源没有默认值：`latest.json` 与二进制放在哪由部署方用 `SELF_UPDATE_SOURCE` 指定。
// 这里曾经留着一个指向我们自己运营机的常量，虽然没人引用，但它出现在对外发布的代码里
// 就是一句误导——跟着抄的人会把自己的中转配到别人的域名上。

/// 回滚记录的键。有值＝上一次升级之后没健康起来，别再自动升级。
const POISON_KEY: &str = "self_update_rollback";

/// GitHub 的匿名接口限制每小时 60 次/IP。默认一天一次，怎么算都够。
const DEFAULT_INTERVAL: Duration = Duration::from_secs(24 * 3600);

/// 当前编译出来的目标三元组里的架构段。只支持跑在 Linux 上的两种。
fn asset_arch() -> Option<&'static str> {
    if cfg!(target_arch = "x86_64") {
        Some("x86_64")
    } else if cfg!(target_arch = "aarch64") {
        Some("aarch64")
    } else {
        None
    }
}

/// 当前程序应该下载的产物名。
pub fn asset_name() -> Option<String> {
    asset_arch().map(|arch| format!("dsh-relay-linux-{arch}"))
}

/// `latest.json` 的形状。发布脚本（`deploy/publish-relay-update.sh`）生成它。
///
/// ```json
/// {
///   "version": "0.1.2",
///   "binaries": {
///     "x86_64":  { "url": "https://…/dsh-relay-linux-x86_64", "sha256": "…" },
///     "aarch64": { "url": "https://…/dsh-relay-linux-aarch64", "sha256": "…" }
///   }
/// }
/// ```
///
/// **校验和写在清单里，不单独放一个文件**：这样版本号、地址、校验和出自同一份
/// 文件，不会出现「清单更新了、checksums 还是旧的」那种自相矛盾的状态。
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub binaries: std::collections::HashMap<String, Binary>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Binary {
    pub url: String,
    pub sha256: String,
}

/// 从 `latest.json` 的文本里取本架构那一条。
///
/// 校验和长度不对就当作没有——一个格式不对的哈希会让后面永远比对失败，
/// 不如在这里就说清楚。
pub fn binary_for(text: &str, arch: &str) -> Result<(Manifest, Binary), String> {
    let manifest: Manifest =
        serde_json::from_str(text).map_err(|e| format!("latest.json 解析失败：{e}"))?;
    let binary = manifest
        .binaries
        .get(arch)
        .cloned()
        .ok_or_else(|| format!("latest.json 里没有 {arch} 这个架构的包"))?;
    if binary.sha256.len() != 64 {
        return Err("latest.json 里的 sha256 不是 64 位十六进制".into());
    }
    Ok((manifest, binary))
}

/// 升级的完整决策，纯函数，不碰网络也不碰文件——单测就钉它。
#[derive(Debug, PartialEq)]
pub enum Plan {
    /// 已经是最新。
    UpToDate,
    /// 可以升，给出要下载的东西。
    Upgrade {
        version: String,
        url: String,
        sha256: String,
    },
}

/// 根据当前版本与清单决定升不升。
///
/// 比的是版本号，不是发布时间——重新上传一次旧版本不该让机器降级。
pub fn plan(current: &str, manifest_text: &str, arch: &str) -> Result<Plan, String> {
    let (manifest, binary) = binary_for(manifest_text, arch)?;
    if crate::store::compare_versions(&manifest.version, current)
        != std::cmp::Ordering::Greater
    {
        return Ok(Plan::UpToDate);
    }
    Ok(Plan::Upgrade {
        version: manifest.version,
        url: binary.url,
        sha256: binary.sha256.to_ascii_lowercase(),
    })
}

/// 升级任务。由 `main` 在启动时 spawn，默认不启用。
pub fn spawn_self_update(ctx: UpdateContext) {
    if !ctx.enabled {
        return;
    }
    tokio::spawn(async move {
        // 先看是不是上次升级没起来。是的话**这轮直接不升**，等人上来看。
        if let Some(reason) = ctx.store.get_setting(POISON_KEY) {
            crate::tunnel::log(format!(
                "上一次自动更新没有成功启动（{reason}），本轮不再自动升级。查清楚后删掉 {} 再重启",
                ctx.state_path().display()
            ));
            return;
        }
        // 启动后先缓一会儿：别和绑端口、连隧道抢带宽。
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            match check_and_apply(&ctx).await {
                Ok(Some(version)) => {
                    // 已经把新文件换上去并退出重启了，走不到这里；留一行日志兜底。
                    crate::tunnel::log(format!("自动更新到 {version} 已提交，准备重启"));
                    return;
                }
                Ok(None) => {}
                Err(error) => crate::tunnel::log(format!("自动更新检查失败：{error}")),
            }
            tokio::time::sleep(ctx.interval).await;
        }
    });
}

pub struct UpdateContext {
    pub enabled: bool,
    pub interval: Duration,
    /// 更新源基址：下面要能取到 `latest.json`。末尾斜杠无所谓。
    pub source: String,
    pub store: crate::store::Store,
    /// 数据目录；回滚记录与下载的临时文件都放这里。
    pub data_dir: PathBuf,
}

impl UpdateContext {
    fn state_path(&self) -> PathBuf {
        self.data_dir.join(".update-state")
    }
}

/// 查一次、能升就升。返回升级到的版本（调用前已经把文件换好并准备退出）。
///
/// 不升、或者升不了，都返回 `Ok(None)` 并记日志——自动更新失败绝不能影响这台
/// 中转的转发。
pub async fn check_and_apply(ctx: &UpdateContext) -> Result<Option<String>, String> {
    if asset_name().is_none() {
        return Err("这个架构没有预编译的更新包".into());
    }
    let arch = asset_arch().unwrap_or_default();
    // 下载可能是个几 MB 的文件，超时给足；连不上就不要在那儿干等。
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .user_agent("dsh-relay-self-update")
        .build()
        .map_err(|e| e.to_string())?;

    let manifest_url = format!("{}/latest.json", ctx.source.trim_end_matches('/'));
    let manifest_text = client
        .get(&manifest_url)
        .send()
        .await
        .map_err(|e| format!("问 {manifest_url} 失败：{e}"))?
        .error_for_status()
        .map_err(|e| format!("latest.json HTTP 错误：{e}"))?
        .text()
        .await
        .map_err(|e| format!("latest.json 读取失败：{e}"))?;

    let current = env!("CARGO_PKG_VERSION");
    match plan(current, &manifest_text, arch)? {
        Plan::UpToDate => Ok(None),
        Plan::Upgrade {
            version,
            url,
            sha256,
        } => {
            crate::tunnel::log(format!(
                "发现新版本 {version}（当前 {current}），开始下载"
            ));
            apply(ctx, &client, &version, &url, &sha256).await?;
            Ok(Some(version))
        }
    }
}

/// 下载、校验、替换。失败时**不留下任何半截状态**。
async fn apply(
    ctx: &UpdateContext,
    client: &reqwest::Client,
    version: &str,
    url: &str,
    expected: &str,
) -> Result<(), String> {
    std::fs::create_dir_all(&ctx.data_dir).map_err(|e| format!("建数据目录失败：{e}"))?;

    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载二进制失败：{e}"))?
        .error_for_status()
        .map_err(|e| format!("二进制 HTTP 错误：{e}"))?
        .bytes()
        .await
        .map_err(|e| format!("二进制读取失败：{e}"))?;

    let actual = sha256_hex(&bytes);
    if actual != expected {
        // **校验不过就到此为止**，连临时文件都不留。这是整个流程里最硬的一条。
        return Err(format!(
            "校验失败，放弃这次更新（期望 {expected}，实际 {actual}）"
        ));
    }

    let staging = ctx.data_dir.join(format!(".dsh-relay-{version}.new"));
    write_executable(&staging, &bytes)?;

    let exe = std::env::current_exe().map_err(|e| format!("拿不到当前程序路径：{e}"))?;
    let backup = exe.with_extension("previous");
    // 旧文件改名留一份：这是回滚的唯一依据。
    if backup.exists() {
        let _ = std::fs::remove_file(&backup);
    }
    std::fs::rename(&exe, &backup).map_err(|e| format!("备份旧版本失败：{e}"))?;
    if let Err(error) = std::fs::rename(&staging, &exe) {
        // 换不上去就把旧的放回原位，别留下一台没有可执行文件的中转。
        let _ = std::fs::rename(&backup, &exe);
        return Err(format!("替换失败，已回滚：{error}"));
    }

    // 记下「这次升级还没被验证过」。新版本如果健健康康起来，启动时会清掉这条。
    ctx.store
        .set_setting("self_update_pending", version);
    crate::tunnel::log(format!(
        "已替换为 {version}，退出后由 systemd 拉起新版"
    ));
    // 直接退出：`Restart=always` 的服务管理器会立刻再拉一次。
    std::process::exit(0);
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn write_executable(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = std::fs::File::create(path).map_err(|e| format!("写入临时文件失败：{e}"))?;
    file.write_all(bytes)
        .map_err(|e| format!("写入临时文件失败：{e}"))?;
    // 先落盘再换名，免得断电时换上去一个空文件。
    file.sync_all()
        .map_err(|e| format!("临时文件落盘失败：{e}"))?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("设置可执行权限失败：{e}"))?;
    }
    Ok(())
}

/// 启动时调一次：处理「上次替换上去的新版本到底起没起来」。
///
/// 约定：
///   - `self_update_pending` 有值、且这次启动的是**那个新版本** → 说明它起来了，
///     清掉待验证标记，升级成功。
///   - `self_update_pending` 有值、但当前版本**不是**它 → 说明新版本没起来，
///     systemd 拉起来的是回滚后的旧文件（或人手动换回来了）。留一条回滚记录，
///     以后的自动更新一律停手，等人上来看。
///
/// 必须在那之后调用 `verify_health`：光「进程起来了」不等于「服务能用」。
pub fn finish_pending_update(store: &crate::store::Store, current: &str) -> Option<String> {
    // 空值＝没有待验证的升级。**必须先判这个**：早先的写法拿到空串就往下走，
    // 拿空版本号跟自己比，必然不等，于是把一次成功的升级误判成失败、还去改
    // 「不再自动升级」的标记。上线前的测试里撞到过（同一份库被两个进程用，
    // 一个刚把标记清掉、另一个立刻把它读成失败）。
    let pending = store.get_setting("self_update_pending")?;
    let pending = pending.trim().to_string();
    if pending.is_empty() {
        return None;
    }
    store.set_setting("self_update_pending", "");
    if pending == current {
        crate::tunnel::log(format!("自动更新到 {current} 成功"));
        return None;
    }
    store.set_setting(POISON_KEY, &format!("升级到 {pending} 后回来的是 {current}"));
    crate::tunnel::log(format!(
        "自动更新到 {pending} 没有成功启动（现在是 {current}），已停止后续自动更新"
    ));
    Some(pending)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "894abda363801759263b8d6deab2d1f9cb6f2dcd4c188adfa396519c537e4076";

    fn manifest(version: &str, arch: &str) -> String {
        format!(
            r#"{{"version":"{version}","binaries":{{"{arch}":{{"url":"https://example.com/dsh-relay-linux-{arch}","sha256":"{HASH}"}}}}}}"#
        )
    }

    #[test]
    fn upgrades_when_manifest_is_newer() {
        match plan("0.1.0", &manifest("0.1.1", "x86_64"), "x86_64").unwrap() {
            Plan::Upgrade { version, url, sha256 } => {
                assert_eq!(version, "0.1.1");
                assert!(url.ends_with("dsh-relay-linux-x86_64"));
                assert_eq!(sha256, HASH);
            }
            other => panic!("{other:?}"),
        }
    }

    /// 比的是版本号，不是清单是否刷新过：重新上传一次旧版本不该让机器降级。
    #[test]
    fn does_not_downgrade() {
        assert_eq!(plan("0.1.0", &manifest("0.1.0", "x86_64"), "x86_64").unwrap(), Plan::UpToDate);
        assert_eq!(plan("0.2.0", &manifest("0.1.0", "x86_64"), "x86_64").unwrap(), Plan::UpToDate);
    }

    /// 清单里没有本架构的包就不能升——别的架构的二进制下下来也跑不了。
    #[test]
    fn requires_this_arch() {
        let err = plan("0.1.0", &manifest("0.2.0", "aarch64"), "x86_64").unwrap_err();
        assert!(err.contains("x86_64"), "{err}");
    }

    /// 格式不对的哈希必须在决定升级**之前**就挡掉，不要等下载完才发现永远对不上。
    #[test]
    fn rejects_malformed_hash() {
        let bad = format!(
            r#"{{"version":"0.2.0","binaries":{{"x86_64":{{"url":"https://e/x","sha256":"abc"}}}}}}"#
        );
        assert!(plan("0.1.0", &bad, "x86_64").unwrap_err().contains("sha256"));
    }

    #[test]
    fn rejects_broken_json() {
        assert!(plan("0.1.0", "not json", "x86_64").is_err());
        assert!(plan("0.1.0", r#"{"version":"0.2.0"}"#, "x86_64").is_err());
    }

    #[test]
    fn asset_names_cover_the_two_platforms_we_ship() {
        // 在这个测试机上（macOS aarch64）asset_name 是 None —— 我们不发布 macOS 包。
        // 真正要钉的是「有产物时名字对得上发布脚本」，所以在目标架构上才断言。
        #[cfg(target_os = "linux")]
        {
            let name = asset_name().expect("linux 上必须有产物名");
            assert!(name == "dsh-relay-linux-x86_64" || name == "dsh-relay-linux-aarch64", "{name}");
        }
        let _ = asset_name();
    }

    /// 升级没起来：记一条，之后不再自动升级，直到人处理。
    #[test]
    fn failed_upgrade_poisons_future_attempts() {
        let store = crate::store::Store::in_memory().unwrap();
        store.set_setting("self_update_pending", "0.2.0");
        let failed = finish_pending_update(&store, "0.1.0");
        assert_eq!(failed.as_deref(), Some("0.2.0"));
        assert!(store.get_setting(POISON_KEY).is_some(), "必须留下回滚记录");
        assert_eq!(store.get_setting("self_update_pending").as_deref(), Some(""), "待验证标记要清掉");
    }

    /// 空标记＝没有待验证的升级，**不能**被当成失败。
    #[test]
    fn empty_pending_is_not_a_failure() {
        let store = crate::store::Store::in_memory().unwrap();
        store.set_setting("self_update_pending", "");
        assert_eq!(finish_pending_update(&store, "0.1.1"), None);
        assert!(store.get_setting(POISON_KEY).is_none(), "空值绝不能写回滚标记");
    }

    #[test]
    fn successful_upgrade_clears_pending() {
        let store = crate::store::Store::in_memory().unwrap();
        store.set_setting("self_update_pending", "0.2.0");
        assert_eq!(finish_pending_update(&store, "0.2.0"), None);
        assert!(store.get_setting(POISON_KEY).is_none(), "成功就不该有毒标记");
    }
}
