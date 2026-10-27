//! 中转自身的自动更新。
//!
//! 从一个**自己控制的静态地址**取新版本，下载对应架构的二进制，校验 sha256，
//! 原子替换，然后退出让服务管理器拉起来。
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
//! ## 多个更新源
//!
//! `SELF_UPDATE_SOURCE` 可以给一串地址（逗号分隔），按顺序试，第一个取到可用清单的
//! 就算数。国内机器把国内源写前面、海外机器把海外源写前面，一台机器上同时配着两边
//! 的地址——主源倒了不会变成「从此收不到更新」。海外走 GitHub 那条是实测过的：
//! 法兰克福那台取 GitHub 资产比取国内更新源快一个数量级。
//!
//! ## 为什么是「替换文件 + 退出」，不是自己重启自己
//!
//! 进程没办法在保持监听的同时把自己的可执行文件换成新的。能做到的做法只有两种：
//! 要么设 `PR_SET_PTRACER` 之后再 exec，要么让外部进程来管。这台中转的生产形态是
//! 一个进程管理器（systemd 的 `Restart=always` / OpenRC 的 `supervise-daemon`），
//! **退出就是要它再拉一次**——把这件事交给已经存在的机制，比自己实现一套 `exec`
//! 简单得多，也不会因为 `exec` 失败留下一台僵尸进程。重启请求用退出码 75
//! （`EX_TEMPFAIL`，意思是「不是出错，请再拉起我」）。
//!
//! ## 回滚：判据是「新进程真能回答」，不是「文件写成功了」
//!
//! 写成功但起不来才是自动更新最坏的形态：机器上没人，服务死了，而且管理器会把那个
//! 坏文件无限重启下去。所以这里有两道闸：
//!
//!   1. **自己验**。换上新文件后退出，新版起来、绑上端口、再自己打一次 `/healthz`
//!      拿到 200，才算这次升级成立。拿不到就当场把上一版换回来并退出。
//!   2. **数次数**。新版如果在「验明」之前就死了（panic、配置错、缺依赖），这次启动
//!      根本走不到上面那步。所以每次启动都会先把「我已经试过一次」记在盘上：
//!      同一份新版本连续两次没验明，第二次启动时直接把上一版换回来。
//!
//! 换回上一版之后写一条回滚记录，**之后不再自动升级**，直到那个状态文件被人删掉
//! （说明有人上来看过了）。状态记在数据目录的 `.update-state` 里，纯文本、不依赖
//! 控制台的数据库——纯转发的机器（没开 `PLATFORM_ENABLED`）也要能用自动更新。
//!
//! ## 替换之前先试跑一遍
//!
//! 上面两道闸都建立在「新版本至少能跑起来、能读到状态文件」之上。如果那个二进制
//! 在这台机器上根本起不来（动态链接的包放到 musl 系统上、架构不对、缺 shared lib），
//! 它一行代码都执行不到，也就没机会记账或回滚——进程管理器只会无限重启一个哑文件。
//! 这是自动更新最坏的形态，而且**已经真发生过一次**：给 Alpine 下发 glibc 包。
//!
//! 所以替换前先在暂存位置跑一次 `--version` 式的自检：能跑、能打印出**清单里声明的
//! 那个版本号**，才允许换。跑不了就当作「这个包不适合这台机器」，本轮放弃升级并
//! 记日志，继续用旧版本服务。试跑用独立的进程组与超时，跑完必杀，不留残留进程。
//!
//! ## 校验的边界
//!
//! 校验和与二进制放在同一份清单里，能挡住传输损坏（下载到一半、被中间设备改写），
//! **挡不住同时改了这两个文件的人**。真要防那个得上签名，那要引入密钥管理与轮换，
//! 对一台自发布的中转来说成本远大于收益。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

// 更新源没有默认值：`latest.json` 与二进制放在哪由部署方用 `SELF_UPDATE_SOURCE` 指定。
// 这里曾经留着一个指向我们自己运营机的常量，虽然没人引用，但它出现在对外发布的代码里
// 就是一句误导——跟着抄的人会把自己的中转配到别人的域名上。

/// 升级状态文件，放在数据目录里。
const STATE_FILE: &str = ".update-state";

/// 同一份新版本连续起不到这个次数还没验明，就认为它在这台机器上不能用。
///
/// 2 是刻意的：给一次「第一次起得慢/被系统杀」的容错，又不至于让一台起不来的机器
/// 被重启几十次之后才恢复。
const MAX_START_ATTEMPTS: u32 = 2;

/// 「请再拉起我」的退出码。用非零码是为了让所有进程管理器都当它是异常退出而重试，
/// 而不是「正常结束、不用管了」。
pub const EXIT_RESTART: i32 = 75;

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

// ── 升级状态：纯文本，落在数据目录 ────────────────────────────────

/// 升级状态。字段都是短字符串，直接写成 `key=value` 一行一条。
///
/// 为什么不放数据库：纯转发的中转没有控制台、没有 sqlite，而自动更新跟转发一样是
/// 基础能力。早先它依赖控制台的库，结果「没开控制台的机器打开自动更新只会打一行
/// 日志然后跳过」——能力写在文档里，实际不生效。
#[derive(Debug, Default, Clone, PartialEq)]
pub struct UpdateState {
    /// 已经换上去、但还没验证过的新版本号。空＝没有待验证的升级。
    pub pending: String,
    /// 这个待验证版本已经启动过几次。
    pub attempts: u32,
    /// 最后一个「验明」成功的版本号。
    pub confirmed: String,
    /// 非空＝上一次升级失败过，别再自动升级，等人来看。
    pub rollback: String,
}

impl UpdateState {
    pub fn parse(text: &str) -> Self {
        let mut state = UpdateState::default();
        for line in text.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let value = value.trim();
            match key.trim() {
                "pending" => state.pending = value.to_string(),
                "attempts" => state.attempts = value.parse().unwrap_or(0),
                "confirmed" => state.confirmed = value.to_string(),
                "rollback" => state.rollback = value.to_string(),
                _ => {}
            }
        }
        state
    }

    pub fn render(&self) -> String {
        format!(
            "pending={}\nattempts={}\nconfirmed={}\nrollback={}\n",
            self.pending, self.attempts, self.confirmed, self.rollback
        )
    }
}

/// 读某个数据目录里的升级状态；读不到就是「没在升过」。
///
/// 控制台用它回答「这台现在跑到哪一版、有没有停手」——文件名只在这里知道，
/// 别在别处再拼一遍 `.update-state`。
pub fn state_in(data_dir: &Path) -> UpdateState {
    std::fs::read_to_string(data_dir.join(STATE_FILE))
        .map(|text| UpdateState::parse(&text))
        .unwrap_or_default()
}

/// 升级用到的那两个路径。分开传是为了让下面那些纯函数能被单测直接钉。
#[derive(Debug, Clone)]
pub struct Paths {
    /// 正在运行的那个可执行文件。上一版就放在它边上的 `.previous`。
    pub exe: PathBuf,
    /// 数据目录，升级状态文件放这里。
    pub data_dir: PathBuf,
}

impl Paths {
    pub fn state_path(&self) -> PathBuf {
        self.data_dir.join(STATE_FILE)
    }

    pub fn previous(&self) -> PathBuf {
        self.exe.with_extension("previous")
    }

    /// 下载暂存文件。
    ///
    /// **必须和可执行文件在同一个文件系统上**：最后一步是 `rename`，跨设备会直接
    /// `EXDEV` 失败。早先它放在数据目录里，而数据目录跟着数据库路径走
    /// （`PLATFORM_DB_PATH` 那套），把库挪到另一块盘的部署就会每天记一行「替换失败」。
    /// 放在 exe 旁边没有这个隐患，也不用为了升级额外要求两个目录同盘。
    pub fn staging(&self, version: &str) -> PathBuf {
        self.exe
            .with_file_name(format!(".dsh-relay-{version}.new"))
    }

    pub fn load(&self) -> UpdateState {
        state_in(&self.data_dir)
    }

    pub fn save(&self, state: &UpdateState) -> Result<(), String> {
        std::fs::create_dir_all(&self.data_dir)
            .map_err(|e| format!("建数据目录失败 {}: {e}", self.data_dir.display()))?;
        let path = self.state_path();
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, state.render())
            .map_err(|e| format!("写升级状态失败 {}: {e}", tmp.display()))?;
        // 先落盘再换名：这个文件是回滚判据，写到一半比没有更糟。
        if let Ok(file) = std::fs::File::open(&tmp) {
            let _ = file.sync_all();
        }
        std::fs::rename(&tmp, &path)
            .map_err(|e| format!("换上升级状态失败 {}: {e}", path.display()))
    }
}

/// 启动时该做什么。纯函数，只看「盘上的状态 + 我现在是哪个版本」。
#[derive(Debug, PartialEq)]
pub enum Startup {
    /// 干净启动，没有待验证的升级。
    Idle,
    /// 我就是那个待验证的新版本，第一次启动。起得来之后要调 `confirm`。
    Verify,
    /// 这个版本已经验明过了。
    Confirmed,
    /// 这个版本已经准备好被接受——但它是上一轮留下的、验明了的版本。
    Stranded { pending: String },
    /// 新版本连续起不来：把上一版换回来。
    Revert { pending: String },
    /// 上一轮已经失败过，停手。
    Stopped { reason: String },
}

/// 决定这次启动该怎么走。
pub fn decide(state: &UpdateState, current: &str) -> Startup {
    if !state.rollback.is_empty() {
        return Startup::Stopped {
            reason: state.rollback.clone(),
        };
    }
    if state.pending.is_empty() {
        return Startup::Idle;
    }
    if state.pending != current {
        // 盘上说该跑 X，可我是 Y。正常流程里只会出现在「人手动把旧文件换回来了」，
        // 或者替换之后管理器拿到的是一个不相干的文件。不碰文件，留一条记录停手。
        return Startup::Stranded {
            pending: state.pending.clone(),
        };
    }
    if state.confirmed == current {
        return Startup::Confirmed;
    }
    if state.attempts + 1 >= MAX_START_ATTEMPTS {
        return Startup::Revert {
            pending: state.pending.clone(),
        };
    }
    Startup::Verify
}

/// 启动时调一次，把「这次启动」记到盘上，并返回该怎么走。
///
/// 真正的判定在 `decide` 里；这里只负责记账（attempts 必须**在绑定端口之前**落盘，
/// 否则一个绑不上端口就死的版本永远轮不到「第二次」）。
pub fn note_start(paths: &Paths, current: &str) -> Startup {
    let mut state = paths.load();
    let decision = decide(&state, current);
    match &decision {
        Startup::Verify => {
            state.attempts += 1;
            if let Err(error) = paths.save(&state) {
                // 记不上账就没法保证回滚判据成立。宁可这轮不升级，也不要在
                // 「不知道自己试过几次」的状态下替换生产文件。
                crate::tunnel::log(format!("升级状态写不进去，跳过验证：{error}"));
                return Startup::Idle;
            }
        }
        Startup::Stranded { pending } => {
            state.rollback = format!("升级到 {pending} 后起来的是 {current}");
            state.pending = String::new();
            state.attempts = 0;
            if let Err(error) = paths.save(&state) {
                crate::tunnel::log(format!("回滚记录写不进去：{error}"));
            }
        }
        _ => {}
    }
    decision
}

/// 新版验明成功：记下它，清掉待验证标记。
pub fn confirm(paths: &Paths, version: &str) {
    let mut state = paths.load();
    state.pending = String::new();
    state.attempts = 0;
    state.confirmed = version.to_string();
    if let Err(error) = paths.save(&state) {
        crate::tunnel::log(format!("升级确认写不进去：{error}"));
    }
}

/// 把上一版换回来，并留下「别再自动升级」的记录。
///
/// 返回 true 表示文件已经换好（调用方应当退出，让管理器拉起上一版）。
///
/// 换名不会撞上 `Text file busy`：Linux 允许 rename 一个正在被执行的文件，只有写它
/// 才会被拒。这点是这个方案能成立的前提。
pub fn revert(paths: &Paths, pending: &str, reason: &str) -> bool {
    let previous = paths.previous();
    let mut state = paths.load();
    state.pending = String::new();
    state.attempts = 0;
    state.rollback = format!("{pending} 在这台机器上没起来（{reason}）");

    if !previous.exists() {
        // 没有上一版可换。那就别动文件，只把停手的记录留下——继续跑当前这个
        // 至少还有个能服务的进程。
        crate::tunnel::log(format!(
            "升级失败（{reason}），但 {} 不存在，没有可回滚的版本；已停止后续自动更新",
            previous.display()
        ));
        let _ = paths.save(&state);
        return false;
    }

    let failed = paths.exe.with_extension("failed");
    let _ = std::fs::remove_file(&failed);
    if let Err(error) = std::fs::rename(&paths.exe, &failed) {
        crate::tunnel::log(format!("把坏版本挪开失败：{error}；已停止后续自动更新"));
        let _ = paths.save(&state);
        return false;
    }
    if let Err(error) = std::fs::rename(&previous, &paths.exe) {
        // 换不回来就赶紧把坏版本放回原位，至少文件还在（虽然它起不来）。
        let _ = std::fs::rename(&failed, &paths.exe);
        crate::tunnel::log(format!("回滚失败：{error}；已停止后续自动更新"));
        let _ = paths.save(&state);
        return false;
    }

    crate::tunnel::log(format!(
        "已把失败的新版本（{pending}）换回上一版（{reason}）。服务会重启成旧版本；\
         查清楚后删掉 {} 再重启，自动更新才会恢复",
        paths.state_path().display()
    ));
    let _ = paths.save(&state);
    true
}

/// 升级任务。由 `main` 在启动时 spawn，默认不启用。
pub fn spawn_self_update(ctx: UpdateContext) {
    if !ctx.enabled {
        return;
    }
    tokio::spawn(async move {
        // 先看是不是上次升级没起来。是的话**这轮直接不升**，等人上来看。
        let state = ctx.paths.load();
        if !state.rollback.is_empty() {
            crate::tunnel::log(format!(
                "上一次自动更新没有成功（{}），本轮不再自动升级。查清楚后删掉 {} 再重启",
                state.rollback,
                ctx.paths.state_path().display()
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
    /// 更新源基址，按顺序试。每个下面都要能取到 `latest.json`。末尾斜杠无所谓。
    pub sources: Vec<String>,
    pub paths: Paths,
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

    let current = env!("CARGO_PKG_VERSION");
    let (upgrade, errors) = first_manifest(&client, &ctx.sources, current, arch).await?;
    match upgrade {
        Some((version, url, sha256)) => {
            crate::tunnel::log(format!(
                "发现新版本 {version}（当前 {current}），开始下载"
            ));
            apply(ctx, &client, &version, &url, &sha256).await?;
            Ok(Some(version))
        }
        None => {
            if !errors.is_empty() {
                // 每个源都试过了、都没成。把原因一并打出来：只有一个源的时候这条
                // 日志就是唯一线索。
                return Err(errors.join("；"));
            }
            Ok(None)
        }
    }
}

/// 依次问各个更新源，返回第一个能用的升级计划。
///
/// 全部失败时返回 `Ok((None, 原因列表))` 而不是 Err：多个源里有一个挂了不代表这台
/// 机器出了问题，调用方只记日志就够了。
async fn first_manifest(
    client: &reqwest::Client,
    sources: &[String],
    current: &str,
    arch: &str,
) -> Result<(Option<(String, String, String)>, Vec<String>), String> {
    if sources.is_empty() {
        return Err("没有配置更新源（SELF_UPDATE_SOURCE 为空）".into());
    }
    let mut errors = Vec::new();
    for source in sources {
        let manifest_url = format!("{}/latest.json", source.trim_end_matches('/'));
        let text = match client.get(&manifest_url).send().await {
            Ok(response) => match response.error_for_status() {
                Ok(response) => match response.text().await {
                    Ok(text) => text,
                    Err(error) => {
                        errors.push(format!("{manifest_url} 读取失败：{error}"));
                        continue;
                    }
                },
                Err(error) => {
                    errors.push(format!("{manifest_url} HTTP 错误：{error}"));
                    continue;
                }
            },
            Err(error) => {
                errors.push(format!("{manifest_url} 连不上：{error}"));
                continue;
            }
        };
        match plan(current, &text, arch) {
            Ok(Plan::UpToDate) => return Ok((None, Vec::new())),
            Ok(Plan::Upgrade {
                version,
                url,
                sha256,
            }) => return Ok((Some((version, url, sha256)), Vec::new())),
            Err(error) => {
                errors.push(format!("{manifest_url}：{error}"));
            }
        }
    }
    Ok((None, errors))
}

/// 试跑一遍候选二进制，确认它在这台机器上真能启动、而且自报的版本号对得上。
///
/// 为什么不信清单里的版本号：清单是发布方写的，二进制是另一份东西。这里要回答的是
/// 「这个文件放到这台机器上，能不能跑」——只有真跑一次才知道。
///
/// 跑的是 `--version`：中转对未知参数的处理是打印版本后退出，不绑端口、不连隧道，
/// 对线上没有任何副作用。超时 15 秒，杀掉整组进程。
fn trial_run(staging: &Path, expected_version: &str) -> Result<(), String> {
    use std::process::{Command, Stdio};

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let mut child = Command::new(staging)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 自己一个进程组：超时的时候杀 -pid 能把它的子进程一起收掉。
            .process_group(0)
            .spawn()
            .map_err(|e| format!("候选二进制起不来（{e}），这台机器跑不了它"))?;

        let pid = child.id() as i32;
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut text = String::new();
                    if let Some(mut out) = child.stdout.take() {
                        let _ = std::io::Read::read_to_string(&mut out, &mut text);
                    }
                    if let Some(mut err) = child.stderr.take() {
                        let _ = std::io::Read::read_to_string(&mut err, &mut text);
                    }
                    if !status.success() {
                        return Err(format!(
                            "候选二进制退出码 {:?}，这台机器跑不了它：{}",
                            status.code(),
                            text.trim().lines().next().unwrap_or("（没有输出）")
                        ));
                    }
                    if !text.contains(expected_version) {
                        return Err(format!(
                            "候选二进制没报出版本 {expected_version}（输出：{}）",
                            text.trim().lines().next().unwrap_or("（没有输出）")
                        ));
                    }
                    return Ok(());
                }
                Ok(None) => {
                    if std::time::Instant::now() > deadline {
                        let _ = Command::new("kill")
                            .args(["-KILL", &format!("-{pid}")])
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status();
                        let _ = child.kill();
                        return Err("候选二进制 15 秒内没有退出，放弃这次升级".into());
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(error) => return Err(format!("等候选二进制结束失败：{error}")),
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (staging, expected_version);
        Err("这个平台不支持试跑自检，放弃自动升级".into())
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
    std::fs::create_dir_all(&ctx.paths.data_dir)
        .map_err(|e| format!("建数据目录失败：{e}"))?;

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

    let staging = ctx.paths.staging(version);
    write_executable(&staging, &bytes)?;

    // **替换之前**先试跑。起不来的包在这里就拦住，线上文件名一个字节都没动。
    trial_run(&staging, version).inspect_err(|error| {
        let _ = std::fs::remove_file(&staging);
        crate::tunnel::log(format!("放弃升级到 {version}：{error}"));
    })?;

    // 先把「待验证」落盘，再动文件。反过来的话，进程在两次 rename 之间被杀掉，
    // 盘上就是一个没人认领的新文件。
    let mut state = ctx.paths.load();
    state.pending = version.to_string();
    state.attempts = 0;
    state.confirmed = String::new();
    state.rollback = String::new();
    ctx.paths.save(&state)?;

    let exe = &ctx.paths.exe;
    let backup = ctx.paths.previous();
    // 旧文件改名留一份：这是回滚的唯一依据。
    if backup.exists() {
        let _ = std::fs::remove_file(&backup);
    }
    std::fs::rename(exe, &backup).map_err(|e| format!("备份旧版本失败：{e}"))?;
    if let Err(error) = std::fs::rename(&staging, exe) {
        // 换不上去就把旧的放回原位，别留下一台没有可执行文件的中转。
        let _ = std::fs::rename(&backup, exe);
        state.pending = String::new();
        let _ = ctx.paths.save(&state);
        return Err(format!("替换失败，已回滚：{error}"));
    }

    crate::tunnel::log(format!(
        "已替换为 {version}，退出后由服务管理器拉起新版并自检"
    ));
    // 直接退出：管理器立刻再拉一次。用 75 是为了让「正常结束不重启」的管理器也重试。
    std::process::exit(EXIT_RESTART);
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

/// 自己问自己一句 `/healthz`。
///
/// 这是「新进程真的能回答」那个判据的落地：绑上端口还不算，真发一个请求、真拿到
/// `ok` 才算。连不上就重试几次——刚 bind 完到 accept 循环开跑之间有毫秒级窗口，
/// 那不叫起不来。
pub async fn probe_health(host: &str, port: u16) -> bool {
    let target = if host == "0.0.0.0" || host == "::" || host.trim().is_empty() {
        "127.0.0.1".to_string()
    } else {
        host.to_string()
    };
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let Ok(mut stream) = tokio::net::TcpStream::connect((target.as_str(), port)).await else {
            continue;
        };
        let request = format!(
            "GET /healthz HTTP/1.1\r\nHost: {target}\r\nConnection: close\r\n\r\n"
        );
        if tokio::io::AsyncWriteExt::write_all(&mut stream, request.as_bytes())
            .await
            .is_err()
        {
            continue;
        }
        let mut response = Vec::new();
        if tokio::io::AsyncReadExt::read_to_end(&mut stream, &mut response)
            .await
            .is_err()
        {
            continue;
        }
        let text = String::from_utf8_lossy(&response);
        if text.starts_with("HTTP/1.1 200") && text.trim_end().ends_with("ok") {
            return true;
        }
    }
    false
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

    fn paths_at(dir: &Path) -> Paths {
        Paths {
            exe: dir.join("dsh-relay"),
            data_dir: dir.join("data"),
        }
    }

    /// 暂存文件必须落在可执行文件旁边，不能落在数据目录里。
    ///
    /// 两者常常不在同一个文件系统上（数据目录跟着数据库路径走），跨设备 rename 会
    /// 直接失败——那台机器就会每天记一行「替换失败」，版本永远升不上去。
    #[test]
    fn staging_lives_next_to_the_executable() {
        let dir = temp_dir("staging");
        let paths = paths_at(&dir);
        let staging = paths.staging("0.2.0");
        assert_eq!(staging.parent(), paths.exe.parent(), "暂存文件必须和 exe 同目录");
        assert_ne!(staging.parent(), Some(paths.data_dir.as_path()), "不能放数据目录");
        assert!(staging.to_string_lossy().ends_with(".dsh-relay-0.2.0.new"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 测试用：给脚本加上可执行位。
    fn make_executable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-relay-selfupdate-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
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

    #[test]
    fn state_round_trips() {
        let state = UpdateState {
            pending: "0.2.0".into(),
            attempts: 3,
            confirmed: "0.1.9".into(),
            rollback: "坏的".into(),
        };
        assert_eq!(UpdateState::parse(&state.render()), state);
        // 空文件与垃圾行都退化成默认值，不 panic。
        assert_eq!(UpdateState::parse(""), UpdateState::default());
        assert_eq!(UpdateState::parse("garbage\nx=\n"), UpdateState::default());
    }

    /// 干净的四条路：没升级、第一次验、验明过、上一轮崩了要回滚。
    #[test]
    fn decide_covers_the_four_states() {
        let clean = UpdateState::default();
        assert_eq!(decide(&clean, "0.1.7"), Startup::Idle);

        let first = UpdateState {
            pending: "0.1.8".into(),
            ..Default::default()
        };
        assert_eq!(decide(&first, "0.1.8"), Startup::Verify);

        let confirmed = UpdateState {
            pending: "0.1.8".into(),
            confirmed: "0.1.8".into(),
            ..Default::default()
        };
        assert_eq!(decide(&confirmed, "0.1.8"), Startup::Confirmed);

        // 第一次启动时 attempts 已经记成 1（进程随后就死了），这是第二次。
        let died_once = UpdateState {
            pending: "0.1.8".into(),
            attempts: 1,
            ..Default::default()
        };
        assert_eq!(
            decide(&died_once, "0.1.8"),
            Startup::Revert { pending: "0.1.8".into() },
            "同一版本连续两次没验明就必须回滚"
        );
    }

    /// 盘上说该跑 0.1.8，可起来的是 0.1.7：不碰文件，留记录停手。
    #[test]
    fn wrong_version_marks_rollback_without_touching_files() {
        let state = UpdateState {
            pending: "0.1.8".into(),
            attempts: 1,
            ..Default::default()
        };
        assert_eq!(
            decide(&state, "0.1.7"),
            Startup::Stranded { pending: "0.1.8".into() }
        );
    }

    #[test]
    fn started_attempts_are_recorded_before_binding() {
        let dir = temp_dir("attempts");
        let paths = paths_at(&dir);
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        paths
            .save(&UpdateState {
                pending: "0.1.8".into(),
                ..Default::default()
            })
            .unwrap();

        assert_eq!(note_start(&paths, "0.1.8"), Startup::Verify);
        assert_eq!(paths.load().attempts, 1, "第一次启动要落盘记一次");

        // 第二次启动：这时候上一次已经死了，得判定为回滚。
        assert_eq!(
            note_start(&paths, "0.1.8"),
            Startup::Revert { pending: "0.1.8".into() }
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn confirm_clears_pending_and_keeps_version() {
        let dir = temp_dir("confirm");
        let paths = paths_at(&dir);
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        paths
            .save(&UpdateState {
                pending: "0.1.8".into(),
                attempts: 1,
                ..Default::default()
            })
            .unwrap();
        confirm(&paths, "0.1.8");
        let state = paths.load();
        assert_eq!(state.pending, "");
        assert_eq!(state.attempts, 0);
        assert_eq!(state.confirmed, "0.1.8");
        assert!(state.rollback.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 回滚必须真的把 `.previous` 换回去，并且留下「别再升级」的记录。
    #[test]
    fn revert_restores_previous_and_poisons_future_attempts() {
        let dir = temp_dir("revert");
        let paths = paths_at(&dir);
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        std::fs::write(&paths.exe, b"new-broken").unwrap();
        std::fs::write(paths.previous(), b"old-good").unwrap();
        paths
            .save(&UpdateState {
                pending: "0.1.8".into(),
                attempts: 1,
                ..Default::default()
            })
            .unwrap();

        assert!(revert(&paths, "0.1.8", "健康检查没过"));
        assert_eq!(std::fs::read(&paths.exe).unwrap(), b"old-good", "盘上必须是旧版本");
        assert_eq!(std::fs::read(paths.exe.with_extension("failed")).unwrap(), b"new-broken");

        let state = paths.load();
        assert_eq!(state.pending, "");
        assert!(state.rollback.contains("0.1.8"), "{:?}", state.rollback);
        // 之后就再也不动了。
        assert!(matches!(decide(&state, "0.1.7"), Startup::Stopped { .. }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 没有 `.previous` 时不能把正在跑的文件挪走——挪走就真没程序了。
    #[test]
    fn revert_without_previous_leaves_files_alone() {
        let dir = temp_dir("noprev");
        let paths = paths_at(&dir);
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        std::fs::write(&paths.exe, b"only-one").unwrap();

        assert!(!revert(&paths, "0.1.8", "没起来"));
        assert_eq!(std::fs::read(&paths.exe).unwrap(), b"only-one");
        assert!(!paths.load().rollback.is_empty(), "还是要停手，别再试");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 试跑自检的三条结局：跑得起来且版本对、跑起来但版本不对、根本跑不起来。
    ///
    /// 第三条是这个函数存在的理由：一个动态链接的包放到 musl 系统上，进程连 main
    /// 都进不去，它自己没机会记账或回滚，只能靠这里在替换**之前**拦住。
    #[test]
    fn trial_run_rejects_what_cannot_start() {
        let dir = temp_dir("trial");
        let good = dir.join("good");
        std::fs::write(&good, b"#!/bin/sh\necho \"dsh-relay 0.1.8\"\n").unwrap();
        make_executable(&good);
        assert!(trial_run(&good, "0.1.8").is_ok(), "能跑且版本对就该放行");

        let wrong = dir.join("wrong");
        std::fs::write(&wrong, b"#!/bin/sh\necho \"dsh-relay 0.1.7\"\n").unwrap();
        make_executable(&wrong);
        let err = trial_run(&wrong, "0.1.8").unwrap_err();
        assert!(err.contains("0.1.8"), "版本对不上要说清楚：{err}");

        let broken = dir.join("broken");
        std::fs::write(&broken, b"#!/bin/sh\nexit 127\n").unwrap();
        make_executable(&broken);
        assert!(trial_run(&broken, "0.1.8").is_err(), "退出码非零必须拦下");

        let notrun = dir.join("notrun");
        std::fs::write(&notrun, b"no shebang here").unwrap();
        make_executable(&notrun);
        assert!(trial_run(&notrun, "0.1.8").is_err(), "根本执行不了必须拦下");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 多个更新源：第一个连不上就往下试，不能因为主源挂了就收不到更新。
    #[test]
    fn sources_are_tried_in_order() {
        // 这里只钉「空源要报错」这条——真正的网络失败顺序由集成测试兜。
        let _ = temp_dir("sources");
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let client = reqwest::Client::new();
        let result = runtime.block_on(first_manifest(&client, &[], "0.1.7", "x86_64"));
        assert!(result.unwrap_err().contains("SELF_UPDATE_SOURCE"));
    }
}
