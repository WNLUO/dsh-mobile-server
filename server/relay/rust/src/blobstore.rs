//! 加密历史 blob 的落盘仓库（`BLOB_STORE` 打开时才存在）。
//!
//! 电脑侧用一把实例历史密钥（HK）把会话正文/文件封成密文 blob，经隧道推到这里；
//! 手机离线时来拉密文，用自己那份 HK 解开。**中转不持钥、不解密**：这一层只认识
//! `(instance, scope, key)`、一段 `bytes` 和一串凭据摘要，正文原样落盘、原样取回。
//!
//! 落盘在 `data_dir/blobs/`：`<sha256(instance)>/<sha256(scope|key)>.blob`，旁边一份
//! `.meta` 记 `updated_at` 与凭据摘要（重启时靠它重建内存索引——目录名是哈希，反推
//! 不出原文）。内存里只放元数据，正文每次按需从盘上读。
//!
//! **写盘是「临时文件 + 原子 rename」**：先写同目录下的 `<hash>.blob.<seq>.tmp` 再
//! rename 成目标名，`.meta` 在正文就位之后写。这样同一 key 并发写时，读到的要么是
//! 旧的完整正文、要么是新的完整正文，不会拿到写了一半的字节；进程在两步之间被杀掉，
//! 留下的也只是孤儿 `.tmp`（下次启动清掉）或「有正文没 meta」的孤儿 `.blob`。
//!
//! 预算是三道闸：单 blob、每实例总量、全局总量；超了按 `updated_at` 从旧到新淘汰。
//! TTL 由两条判据兜：读时直接按 `updated_at` 判过期（不依赖清理跑过），盘上垃圾则由
//! 节流的清理定期收掉。与 `mirror` 的取舍一致——进程重启丢索引可以接受，下一次
//! 宿主推 blob 会补回来。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// scope 白名单。中转只认这两档，别的值当非法帧丢掉（拉取路径用同一份判据）。
pub const SCOPE_MESSAGES: &str = "messages";
pub const SCOPE_FILE: &str = "file";
const KNOWN_SCOPES: [&str; 2] = [SCOPE_MESSAGES, SCOPE_FILE];

/// 一条 blob 最多带多少条设备凭据摘要。
///
/// 与镜像那份（`mirror::MAX_CREDS`）取同一个数，也就是插件 `activeDigests` 的上限：
/// 宿主一趟最多报这么多条摘要，中转这边收窄成更小的数会让凭据多的实例整条 blob 被拒——
/// 而 `blobPut` 没有回执，现场表现是「这台机器永远存不上离线历史」且没有任何提示。
const MAX_CREDS: usize = 200;

/// 两次过期清理之间至少隔这么久（毫秒）。清理晚一分钟没有后果：读时另有 TTL 判据。
const SWEEP_INTERVAL_MS: u64 = 60_000;

/// 一条设备凭据摘要：`sha256(凭据原文)` + 过期时刻（毫秒）。
///
/// 形状与 `mirror` 里那份 `(hash, expiresAt)` 同一口径：`expires_at == 0` 表示
/// 「没有这个字段的旧条目」，按不过期处理，只到 blob 自己的 TTL 为止。
#[derive(Debug, Clone)]
pub struct Cred {
    pub hash: [u8; 32],
    pub expires_at: i64,
}

impl Cred {
    /// 到 `now_ms` 这一刻还有效吗。
    fn valid_at(&self, now_ms: i64) -> bool {
        self.expires_at == 0 || self.expires_at > now_ms
    }
}

/// 内存索引里一条 blob 的元数据。正文不在内存里。
#[derive(Debug, Clone)]
struct Meta {
    bytes: usize,
    /// 落地时刻（毫秒），预算淘汰与 TTL 都按它。
    updated_at: u64,
    /// 插入序号，`updated_at` 撞同一毫秒时用来稳定淘汰顺序。
    seq: u64,
    /// 本实例已签发设备凭据的 sha256 摘要（带各自的过期时刻）。
    creds: Vec<Cred>,
}

/// 索引键：`(instance, scope, key)`。
type BlobKey = (String, String, String);

/// 自增序号，只用于同一毫秒内的稳定排序。
static SEQ: AtomicU64 = AtomicU64::new(1);

fn next_seq() -> u64 {
    SEQ.fetch_add(1, Ordering::Relaxed)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hex_of(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn sha256_bytes(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// 把 64 位十六进制字符串解成 32 字节摘要；形状不对返回 `None`（整条丢弃）。
pub fn decode_hex32(raw: &str) -> Option<[u8; 32]> {
    let raw = raw.trim();
    if raw.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, pair) in raw.as_bytes().chunks(2).enumerate() {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out[i] = ((hi << 4) | lo) as u8;
    }
    Some(out)
}

/// 只存不读的 blob 仓库。
pub struct BlobStore {
    root: PathBuf,
    max_blob_bytes: usize,
    max_per_instance_bytes: usize,
    max_total_bytes: usize,
    ttl_ms: u64,
    index: Mutex<HashMap<BlobKey, Meta>>,
    /// 累计淘汰条数（预算淘汰 + TTL 过期）。`/status` 报这个数。
    evicted: AtomicU64,
    /// 上一次过期清理的时刻（毫秒），用来节流。
    last_sweep_ms: AtomicU64,
}

impl BlobStore {
    /// `ttl_seconds` 转成毫秒。目录不存在会建好；已有的盘上记录会被扫进内存索引。
    pub fn new(
        root: PathBuf,
        max_blob_bytes: usize,
        max_per_instance_bytes: usize,
        max_total_bytes: usize,
        ttl_seconds: u64,
    ) -> std::io::Result<Self> {
        Self::build(
            root,
            max_blob_bytes,
            max_per_instance_bytes,
            max_total_bytes,
            ttl_seconds.saturating_mul(1000),
        )
    }

    fn build(
        root: PathBuf,
        max_blob_bytes: usize,
        max_per_instance_bytes: usize,
        max_total_bytes: usize,
        ttl_ms: u64,
    ) -> std::io::Result<Self> {
        std::fs::create_dir_all(&root)?;
        let store = Self {
            root,
            max_blob_bytes,
            max_per_instance_bytes,
            max_total_bytes,
            ttl_ms,
            index: Mutex::new(HashMap::new()),
            evicted: AtomicU64::new(0),
            last_sweep_ms: AtomicU64::new(0),
        };
        store.rebuild_index();
        // 启动时强制清一次：盘上可能留着上次运行过期的条目。
        let now = now_ms();
        store.sweep_expired(now);
        store.last_sweep_ms.store(now, Ordering::Relaxed);
        Ok(store)
    }

    fn dir_for(&self, instance: &str) -> PathBuf {
        self.root.join(hex_of(&sha256_bytes(instance.as_bytes())))
    }

    fn hash_for(scope: &str, key: &str) -> String {
        hex_of(&sha256_bytes(format!("{scope}|{key}").as_bytes()))
    }

    fn blob_path(&self, instance: &str, scope: &str, key: &str) -> PathBuf {
        self.dir_for(instance).join(format!("{}.blob", Self::hash_for(scope, key)))
    }

    fn meta_path(&self, instance: &str, scope: &str, key: &str) -> PathBuf {
        self.dir_for(instance).join(format!("{}.meta", Self::hash_for(scope, key)))
    }

    /// 把一条 blob 落盘并进索引。
    ///
    /// 返回 `false` 表示这次没收：scope 不在白名单、creds 空或超过 `MAX_CREDS` 条、单 blob
    /// 超限、写盘失败、或它自己就超过实例/全局预算。无论成败，旧的那份都保持原样
    /// （新文件走临时文件 + rename，不会写坏旧 blob）。
    ///
    /// `cipher` 为空串是**另一种操作**：只更新 creds/元数据，不动已落盘的密文
    /// （设备集合变化时宿主就用它补一轮 creds）。目标不存在时返回 `false`。
    pub fn put(
        &self,
        instance: &str,
        scope: &str,
        key: &str,
        cipher: &[u8],
        creds: Vec<Cred>,
    ) -> bool {
        if instance.trim().is_empty() || !KNOWN_SCOPES.contains(&scope) || key.trim().is_empty() {
            return false;
        }
        if creds.is_empty() || creds.len() > MAX_CREDS {
            return false;
        }
        if cipher.is_empty() {
            return self.update_creds(instance, scope, key, creds);
        }
        // 单 blob 上限：超了直接拒收，保留旧的。
        if cipher.len() > self.max_blob_bytes {
            return false;
        }

        let meta = Meta {
            bytes: cipher.len(),
            updated_at: now_ms(),
            seq: next_seq(),
            creds,
        };
        if self.write_blob(instance, scope, key, cipher, &meta).is_err() {
            return false;
        }
        let blob_key = (instance.to_string(), scope.to_string(), key.to_string());
        {
            let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
            index.insert(blob_key.clone(), meta);
        }
        self.maybe_sweep_expired();
        self.enforce_budgets(&blob_key)
    }

    /// 只换 creds，不动正文。`blobPut` 带空 `cipher` 时走这条。
    ///
    /// 目标不存在就返回 `false`：凭空造一条没有正文的 blob 没有意义，也读不出来。
    fn update_creds(&self, instance: &str, scope: &str, key: &str, creds: Vec<Cred>) -> bool {
        let blob_key = (instance.to_string(), scope.to_string(), key.to_string());
        let Some((bytes, updated_at)) = ({
            let index = self.index.lock().unwrap_or_else(|e| e.into_inner());
            index
                .get(&blob_key)
                .map(|meta| (meta.bytes, meta.updated_at))
        }) else {
            return false;
        };
        // 小文件（几百字节）先写，落好了再更新内存索引：写失败时索引还是旧 creds。
        if self
            .write_meta(instance, scope, key, bytes, updated_at, &creds)
            .is_err()
        {
            return false;
        }
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        match index.get_mut(&blob_key) {
            Some(meta) => {
                meta.creds = creds;
                true
            }
            // 两次持锁之间被删掉了（blobDelete 刚好在跑）：把刚写下的那份 meta 收回去，
            // 否则盘上会留一份没有正文的孤儿。
            None => {
                let _ = std::fs::remove_file(self.meta_path(instance, scope, key));
                false
            }
        }
    }

    /// 删掉一条 blob（`blobDelete` 帧走这条）。返回索引里是否真有这一条。
    pub fn delete(&self, instance: &str, scope: &str, key: &str) -> bool {
        let blob_key = (instance.to_string(), scope.to_string(), key.to_string());
        let removed = {
            let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
            index.remove(&blob_key).is_some()
        };
        // 索引里没有也照删：可能是上次重启留下的孤儿文件。
        self.remove_files(&blob_key);
        removed
    }

    /// 取密文正文。出示的凭据算 sha256，与存下的摘要逐个比，命中且没过期才给。
    pub fn get(
        &self,
        instance: &str,
        scope: &str,
        key: &str,
        presented_cred: &[u8],
    ) -> Option<Vec<u8>> {
        self.get_meta(instance, scope, key, presented_cred)
            .map(|(cipher, _)| cipher)
    }

    /// 取密文正文 + `updatedAt`（http 应答要带这个字段）。
    pub fn get_meta(
        &self,
        instance: &str,
        scope: &str,
        key: &str,
        presented_cred: &[u8],
    ) -> Option<(Vec<u8>, u64)> {
        if presented_cred.is_empty() {
            return None;
        }
        self.maybe_sweep_expired();
        let digest = sha256_bytes(presented_cred);
        let now = now_ms();
        let updated_at = {
            let index = self.index.lock().unwrap_or_else(|e| e.into_inner());
            let meta = index.get(&(
                instance.to_string(),
                scope.to_string(),
                key.to_string(),
            ))?;
            // 读时判 TTL：清理是节流的，过期条目可能还在索引里，但绝不能再给出去。
            if self.ttl_ms > 0 && now.saturating_sub(meta.updated_at) >= self.ttl_ms {
                return None;
            }
            let now_i64 = now as i64;
            if !meta
                .creds
                .iter()
                .any(|cred| cred.hash == digest && cred.valid_at(now_i64))
            {
                return None;
            }
            meta.updated_at
        };
        let cipher = std::fs::read(self.blob_path(instance, scope, key)).ok()?;
        Some((cipher, updated_at))
    }

    /// 当前索引里的 (条目数, 总字节数, 累计淘汰数)。`/status` 与测试用。
    pub fn stats(&self) -> (usize, usize, u64) {
        let index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        (
            index.len(),
            index.values().map(|meta| meta.bytes).sum(),
            self.evicted.load(Ordering::Relaxed),
        )
    }

    /// 正文先落、`.meta` 后落。
    ///
    /// 两步都走「临时文件 + rename」：rename 在同一个目录内是原子的，所以同一 key
    /// 并发写时读者拿到的永远是某一次的完整正文，不会读到半截。临时文件名带序号，
    /// 并发两次写不会互相覆盖同一个 tmp。
    fn write_blob(
        &self,
        instance: &str,
        scope: &str,
        key: &str,
        cipher: &[u8],
        meta: &Meta,
    ) -> std::io::Result<()> {
        let dir = self.dir_for(instance);
        std::fs::create_dir_all(&dir)?;
        let target = self.blob_path(instance, scope, key);
        let tmp = dir.join(format!(
            "{}.blob.{}.tmp",
            Self::hash_for(scope, key),
            next_seq()
        ));
        if let Err(error) = std::fs::write(&tmp, cipher) {
            let _ = std::fs::remove_file(&tmp);
            return Err(error);
        }
        if let Err(error) = std::fs::rename(&tmp, &target) {
            let _ = std::fs::remove_file(&tmp);
            return Err(error);
        }
        self.write_meta(instance, scope, key, meta.bytes, meta.updated_at, &meta.creds)
    }

    /// 单独写一份 `.meta`（creds-only 更新只动它）。
    fn write_meta(
        &self,
        instance: &str,
        scope: &str,
        key: &str,
        bytes: usize,
        updated_at: u64,
        creds: &[Cred],
    ) -> std::io::Result<()> {
        let dir = self.dir_for(instance);
        std::fs::create_dir_all(&dir)?;
        let record = serde_json::json!({
            "instance": instance,
            "scope": scope,
            "key": key,
            "bytes": bytes,
            "updatedAt": updated_at,
            "creds": creds
                .iter()
                .map(|cred| serde_json::json!({
                    "hash": hex_of(&cred.hash),
                    "expiresAt": cred.expires_at,
                }))
                .collect::<Vec<_>>(),
        });
        let target = self.meta_path(instance, scope, key);
        let tmp = dir.join(format!(
            "{}.meta.{}.tmp",
            Self::hash_for(scope, key),
            next_seq()
        ));
        let payload = serde_json::to_vec(&record).unwrap_or_default();
        if let Err(error) = std::fs::write(&tmp, payload) {
            let _ = std::fs::remove_file(&tmp);
            return Err(error);
        }
        if let Err(error) = std::fs::rename(&tmp, &target) {
            let _ = std::fs::remove_file(&tmp);
            return Err(error);
        }
        Ok(())
    }

    /// 从 `updated_at` 最旧的开始淘汰，直到落回实例/全局预算之内。
    ///
    /// 刚写进去的那条是这里最新的，正常不会先被淘汰；只有当它自己就超过预算时才会
    /// 把自己删掉并返回 `false`（那种配置下它本就不该被收下）。
    ///
    /// **锁内只摘索引，删盘放到锁外**：删文件是这里最慢的一段，把它留在锁里会让每次
    /// put 都按表大小线性变慢。
    fn enforce_budgets(&self, keep: &BlobKey) -> bool {
        let (victims, kept) = {
            let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
            let mut victims: Vec<BlobKey> = Vec::new();
            let mut kept = true;

            loop {
                let total: usize = index
                    .iter()
                    .filter(|(key, _)| key.0 == keep.0)
                    .map(|(_, meta)| meta.bytes)
                    .sum();
                if total <= self.max_per_instance_bytes {
                    break;
                }
                let victim = index
                    .iter()
                    .filter(|(key, _)| key.0 == keep.0 && *key != keep)
                    .min_by_key(|(_, meta)| (meta.updated_at, meta.seq))
                    .map(|(key, _)| key.clone());
                match victim {
                    Some(victim) => {
                        index.remove(&victim);
                        victims.push(victim);
                    }
                    None => {
                        index.remove(keep);
                        victims.push(keep.clone());
                        kept = false;
                        break;
                    }
                }
            }

            if kept {
                loop {
                    let total: usize = index.values().map(|meta| meta.bytes).sum();
                    if total <= self.max_total_bytes {
                        break;
                    }
                    let victim = index
                        .iter()
                        .filter(|(key, _)| *key != keep)
                        .min_by_key(|(_, meta)| (meta.updated_at, meta.seq))
                        .map(|(key, _)| key.clone());
                    match victim {
                        Some(victim) => {
                            index.remove(&victim);
                            victims.push(victim);
                        }
                        None => {
                            index.remove(keep);
                            victims.push(keep.clone());
                            kept = false;
                            break;
                        }
                    }
                }
            }

            (victims, kept)
        };

        if !victims.is_empty() {
            self.evicted
                .fetch_add(victims.len() as u64, Ordering::Relaxed);
            for victim in &victims {
                self.remove_files(victim);
            }
        }
        kept
    }

    /// 删掉一条 blob 的两份文件（锁外调用）。
    fn remove_files(&self, key: &BlobKey) {
        let _ = std::fs::remove_file(self.blob_path(&key.0, &key.1, &key.2));
        let _ = std::fs::remove_file(self.meta_path(&key.0, &key.1, &key.2));
    }

    /// 节流后的过期清理：每 `SWEEP_INTERVAL_MS` 最多一次。
    ///
    /// 每次 `get` 都全表扫一遍再逐个删盘，代价随表大小线性涨；而清理晚一分钟没有
    /// 后果（读时另有 TTL 判据，过期条目不会给出去）。抢不到这轮就直连返回，不排队。
    fn maybe_sweep_expired(&self) {
        if self.ttl_ms == 0 {
            return;
        }
        let now = now_ms();
        let last = self.last_sweep_ms.load(Ordering::Relaxed);
        if now.saturating_sub(last) < SWEEP_INTERVAL_MS {
            return;
        }
        if self
            .last_sweep_ms
            .compare_exchange(last, now, Ordering::AcqRel, Ordering::Relaxed)
            .is_err()
        {
            return;
        }
        self.sweep_expired(now);
    }

    /// 清掉超过 TTL 的条目。`ttl_ms == 0` 视为不设 TTL。
    fn sweep_expired(&self, now: u64) {
        if self.ttl_ms == 0 {
            return;
        }
        let expired: Vec<BlobKey> = {
            let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
            let keys: Vec<BlobKey> = index
                .iter()
                .filter(|(_, meta)| now.saturating_sub(meta.updated_at) >= self.ttl_ms)
                .map(|(key, _)| key.clone())
                .collect();
            for key in &keys {
                index.remove(key);
            }
            keys
        };
        if expired.is_empty() {
            return;
        }
        self.evicted
            .fetch_add(expired.len() as u64, Ordering::Relaxed);
        for key in &expired {
            self.remove_files(key);
        }
    }

    /// 启动时扫 `root/<instance>/ *.meta` 重建索引（懒加载，读的是小文件）。
    ///
    /// 顺手清两类垃圾：没有 `.meta` 的孤儿 `.blob`（上次写到一半被杀），以及残留的
    /// `.tmp`。有 `.meta` 却没有正文的条目直接丢掉——索引里留着它只会让 `/status`
    /// 的字节数说谎，读也永远读不到。
    fn rebuild_index(&self) {
        let Ok(instance_dirs) = std::fs::read_dir(&self.root) else {
            return;
        };
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        for instance_dir in instance_dirs.flatten() {
            let Ok(files) = std::fs::read_dir(instance_dir.path()) else {
                continue;
            };
            let mut metas: Vec<(PathBuf, String)> = Vec::new();
            let mut blobs: Vec<(PathBuf, String)> = Vec::new();
            let mut temps: Vec<PathBuf> = Vec::new();
            for file in files.flatten() {
                let path = file.path();
                match path.extension().and_then(|e| e.to_str()) {
                    Some("meta") => metas.push((path.clone(), stem_of(&path))),
                    Some("blob") => blobs.push((path.clone(), stem_of(&path))),
                    Some("tmp") => temps.push(path),
                    _ => {}
                }
            }
            // 残留临时文件一律清掉：它们是「写了一半」的中间物，没有恢复价值。
            for temp in temps {
                let _ = std::fs::remove_file(temp);
            }
            let mut live: Vec<String> = Vec::new();
            for (path, stem) in &metas {
                match read_meta_record(path) {
                    Some(record) => {
                        let blob_path = instance_dir.path().join(format!("{stem}.blob"));
                        if !blob_path.exists() {
                            // 有 meta 没正文：清掉这份 meta，别让索引记一条读不到的。
                            let _ = std::fs::remove_file(path);
                            continue;
                        }
                        live.push(stem.clone());
                        index.insert(
                            (record.instance, record.scope, record.key),
                            Meta {
                                bytes: record.bytes,
                                updated_at: record.updated_at,
                                seq: next_seq(),
                                creds: record.creds,
                            },
                        );
                    }
                    None => {
                        // 解析不出来（截断 / 手改坏）就丢掉，正文由孤儿清理接手。
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
            // 没有 meta 的孤儿 `.blob`：正文在盘上但没人认得它。
            for (path, stem) in blobs {
                if !live.contains(&stem) {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }
}

/// 文件名去掉扩展名的部分（`<hash>.blob` → `<hash>`）。
fn stem_of(path: &std::path::Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

/// 重建索引时读一份 `.meta`。形状不对返回 `None`（整条丢弃）。
struct MetaRecord {
    instance: String,
    scope: String,
    key: String,
    bytes: usize,
    updated_at: u64,
    creds: Vec<Cred>,
}

fn read_meta_record(path: &std::path::Path) -> Option<MetaRecord> {
    let raw = std::fs::read(path).ok()?;
    let value = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    let instance = value.get("instance")?.as_str()?.to_string();
    let scope = value.get("scope")?.as_str()?.to_string();
    let key = value.get("key")?.as_str()?.to_string();
    let bytes = value.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let updated_at = value
        .get("updatedAt")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(now_ms);
    let creds = value
        .get("creds")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    // 旧条目直接是 hex 串（没有 expiresAt）：按不过期读，只到 blob 的 TTL。
                    if let Some(raw) = item.as_str() {
                        return decode_hex32(raw).map(|hash| Cred {
                            hash,
                            expires_at: 0,
                        });
                    }
                    let hash = decode_hex32(item.get("hash")?.as_str()?)?;
                    let expires_at = item
                        .get("expiresAt")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0)
                        .max(0);
                    Some(Cred { hash, expires_at })
                })
                .take(MAX_CREDS)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(MetaRecord {
        instance,
        scope,
        key,
        bytes,
        updated_at,
        creds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-blob-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// 不过期的凭据（`expiresAt == 0`，旧条目同口径）。
    fn cred(tag: &[u8]) -> Cred {
        Cred {
            hash: sha256_bytes(tag),
            expires_at: 0,
        }
    }

    #[test]
    fn put_then_get_roundtrips_the_cipher() {
        let store = BlobStore::new(temp_root(), 1024, 4096, 8192, 3600).unwrap();
        let credential = cred(b"device-a");
        let cipher = b"sealed-envelope-bytes".to_vec();
        assert!(store.put("inst-1", "messages", "sess-1", &cipher, vec![credential]));

        assert_eq!(
            store.get("inst-1", "messages", "sess-1", b"device-a"),
            Some(cipher.clone()),
            "正确凭据要能取回原样密文"
        );
        let (bytes, updated_at) = store
            .get_meta("inst-1", "messages", "sess-1", b"device-a")
            .expect("命中要带 updatedAt");
        assert_eq!(bytes, cipher);
        assert!(updated_at > 0);
    }

    #[test]
    fn wrong_credential_is_rejected() {
        let store = BlobStore::new(temp_root(), 1024, 4096, 8192, 3600).unwrap();
        let credential = cred(b"device-a");
        store.put("inst-1", "file", "file-1", b"payload", vec![credential]);
        assert_eq!(store.get("inst-1", "file", "file-1", b"device-b"), None);
        assert_eq!(store.get("inst-1", "file", "file-1", b""), None);
        assert!(store.get("inst-1", "file", "file-1", b"device-a").is_some());
    }

    /// 凭据带 `expiresAt`：过了那一刻就再也读不出来；没有这个字段的旧条目照旧有效。
    #[test]
    fn expired_credential_stops_reading() {
        let store = BlobStore::new(temp_root(), 1024, 4096, 8192, 3600).unwrap();
        let past = Cred {
            hash: sha256_bytes(b"device-old"),
            expires_at: 1,
        };
        let forever = Cred {
            hash: sha256_bytes(b"device-new"),
            expires_at: 0,
        };
        assert!(store.put(
            "inst-1",
            "messages",
            "sess-1",
            b"payload",
            vec![past, forever]
        ));
        assert_eq!(
            store.get("inst-1", "messages", "sess-1", b"device-old"),
            None,
            "过期的凭据不能再读到密文"
        );
        assert!(
            store
                .get("inst-1", "messages", "sess-1", b"device-new")
                .is_some(),
            "expiresAt=0 的旧条目按不过期处理"
        );
    }

    /// `cipher` 为空串 = 只更新 creds/元数据，密文原样不动。
    #[test]
    fn empty_cipher_only_updates_creds() {
        let store = BlobStore::new(temp_root(), 1024, 4096, 8192, 3600).unwrap();
        let cipher = b"sealed-envelope-bytes".to_vec();
        assert!(store.put(
            "inst-1",
            "messages",
            "sess-1",
            &cipher,
            vec![cred(b"device-a")]
        ));
        // 新配对了一台：只换 creds。
        assert!(store.put(
            "inst-1",
            "messages",
            "sess-1",
            b"",
            vec![cred(b"device-a"), cred(b"device-b")]
        ));
        assert_eq!(
            store.get("inst-1", "messages", "sess-1", b"device-b"),
            Some(cipher.clone()),
            "creds-only 更新后新设备能读到原来那份密文"
        );
        // 目标不存在时不能凭空造一条没有正文的 blob。
        assert!(!store.put("inst-1", "messages", "missing", b"", vec![cred(b"device-a")]));
    }

    /// scope 只认白名单，creds 必须非空且不超过 `MAX_CREDS` 条。
    ///
    /// 上限与插件 `activeDigests`（200）一致：收窄会让凭据多的实例整条被拒，而
    /// `blobPut` 没有回执，现场只是「离线历史一直存不上」。
    #[test]
    fn invalid_scope_or_creds_are_refused() {
        let store = BlobStore::new(temp_root(), 1024, 4096, 8192, 3600).unwrap();
        assert!(!store.put("inst-1", "settings", "k", b"payload", vec![cred(b"a")]));
        assert!(!store.put("inst-1", "messages", "k", b"payload", Vec::new()));
        let too_many: Vec<Cred> = (0..201).map(|i| cred(format!("d{i}").as_bytes())).collect();
        assert!(!store.put("inst-1", "messages", "k", b"payload", too_many));
        let ok: Vec<Cred> = (0..200).map(|i| cred(format!("d{i}").as_bytes())).collect();
        assert!(store.put("inst-1", "messages", "k", b"payload", ok), "200 条是上限，要能过");
    }

    #[test]
    fn delete_removes_blob_and_index_entry() {
        let store = BlobStore::new(temp_root(), 1024, 4096, 8192, 3600).unwrap();
        assert!(store.put(
            "inst-1",
            "messages",
            "sess-1",
            b"payload",
            vec![cred(b"device-a")]
        ));
        assert!(store.delete("inst-1", "messages", "sess-1"));
        assert_eq!(store.get("inst-1", "messages", "sess-1", b"device-a"), None);
        assert_eq!(store.stats().0, 0);
        assert!(!store.delete("inst-1", "messages", "sess-1"), "重复删除返回 false");
    }

    #[test]
    fn oversized_single_blob_is_refused() {
        let store = BlobStore::new(temp_root(), 16, 4096, 8192, 3600).unwrap();
        let credential = cred(b"device-a");
        assert!(!store.put("inst-1", "messages", "big", &vec![0u8; 17], vec![credential]));
        assert_eq!(store.get("inst-1", "messages", "big", b"device-a"), None);
    }

    #[test]
    fn over_budget_evicts_the_oldest_blob() {
        // 每实例预算 300B：连推两条 200B，最早那条要被淘汰。
        let store = BlobStore::new(temp_root(), 1024, 300, 8192, 3600).unwrap();
        let credential = cred(b"device-a");
        assert!(store.put("inst-1", "messages", "old", &vec![1u8; 200], vec![credential.clone()]));
        assert!(store.put("inst-1", "messages", "new", &vec![2u8; 200], vec![credential]));

        assert_eq!(
            store.get("inst-1", "messages", "old", b"device-a"),
            None,
            "最旧的那条要被淘汰"
        );
        assert!(
            store.get("inst-1", "messages", "new", b"device-a").is_some(),
            "刚推的那条要留下"
        );
        let (count, total, evicted) = store.stats();
        assert_eq!(count, 1);
        assert!(total <= 300);
        assert_eq!(evicted, 1, "淘汰数要记进 /status 那份账");
    }

    /// TTL 过期在**读**时判定（不依赖清理跑过），盘上垃圾由清理收掉。
    #[test]
    fn expired_blobs_are_refused_on_read_and_swept() {
        // ttl_ms 走内部构造；推完睡过 5ms，读时按 TTL 判掉。
        let store = BlobStore::build(temp_root(), 1024, 4096, 8192, 1).unwrap();
        let credential = cred(b"device-a");
        assert!(store.put("inst-1", "messages", "ttl", b"payload", vec![credential]));
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(store.get("inst-1", "messages", "ttl", b"device-a"), None);
        // 清理是节流的，所以直接触发一次看盘上那条有没有被收掉。
        store.sweep_expired(now_ms());
        assert_eq!(store.stats().0, 0, "过期条目要被清掉");
    }

    /// 启动重建：孤儿 `.blob`（没有 meta）与残留 `.tmp` 一律清掉，能读的照旧重建。
    #[test]
    fn rebuild_drops_orphans_and_temps() {
        let root = temp_root();
        let credential = cred(b"device-a");
        {
            let store = BlobStore::new(root.clone(), 1024, 4096, 8192, 3600).unwrap();
            assert!(store.put(
                "inst-1",
                "messages",
                "sess-1",
                b"payload",
                vec![credential]
            ));
        }
        // 造两样垃圾：一份没有 meta 的正文、一份写了一半的临时文件。
        let dir = root.join(hex_of(&sha256_bytes(b"inst-1")));
        std::fs::write(dir.join("deadbeef.blob"), b"orphan").unwrap();
        std::fs::write(dir.join("cafebabe.blob.1.tmp"), b"half").unwrap();

        let store = BlobStore::new(root.clone(), 1024, 4096, 8192, 3600).unwrap();
        assert!(
            store.get("inst-1", "messages", "sess-1", b"device-a").is_some(),
            "有 meta 有正文的条目要能重建出来"
        );
        assert!(!dir.join("deadbeef.blob").exists(), "孤儿正文要清掉");
        assert!(!dir.join("cafebabe.blob.1.tmp").exists(), "残留临时文件要清掉");
    }
}
