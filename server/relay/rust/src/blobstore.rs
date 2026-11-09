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
//! 预算是三道闸：单 blob、每实例总量、全局总量；超了按 `updated_at` 从旧到新淘汰。
//! TTL 读写时顺手清一次。与 `mirror` 的取舍一致——进程重启丢索引可以接受，下一次
//! 宿主推 blob 会补回来。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// 内存索引里一条 blob 的元数据。正文不在内存里。
#[derive(Debug, Clone)]
struct Meta {
    bytes: usize,
    /// 落地时刻（毫秒），预算淘汰与 TTL 都按它。
    updated_at: u64,
    /// 插入序号，`updated_at` 撞同一毫秒时用来稳定淘汰顺序。
    seq: u64,
    /// 本实例已签发设备凭据的 sha256 摘要。
    creds: Vec<[u8; 32]>,
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
        };
        store.rebuild_index();
        store.sweep_expired();
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
    /// 返回 `false` 表示这次没收（单 blob 超限、写盘失败、或它自己就超过实例/全局预算）。
    /// 无论成败，旧的那份都保持原样（先写新文件再换索引，不会写坏旧 blob）。
    pub fn put(
        &self,
        instance: &str,
        scope: &str,
        key: &str,
        cipher: &[u8],
        creds: Vec<[u8; 32]>,
    ) -> bool {
        if instance.trim().is_empty() || scope.trim().is_empty() || key.trim().is_empty() {
            return false;
        }
        // 单 blob 上限：超了直接拒收，保留旧的。
        if cipher.len() > self.max_blob_bytes {
            return false;
        }
        self.sweep_expired();

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
        self.enforce_budgets(&blob_key)
    }

    /// 取密文正文。出示的凭据算 sha256，与存下的摘要逐个比，命中才给。
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
        self.sweep_expired();
        let digest = sha256_bytes(presented_cred);
        let updated_at = {
            let index = self.index.lock().unwrap_or_else(|e| e.into_inner());
            let meta = index.get(&(
                instance.to_string(),
                scope.to_string(),
                key.to_string(),
            ))?;
            if !meta.creds.iter().any(|stored| stored == &digest) {
                return None;
            }
            meta.updated_at
        };
        let cipher = std::fs::read(self.blob_path(instance, scope, key)).ok()?;
        Some((cipher, updated_at))
    }

    /// 当前索引里的条目数与总字节数（诊断 / 测试用）。
    pub fn stats(&self) -> (usize, usize) {
        let index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        (index.len(), index.values().map(|meta| meta.bytes).sum())
    }

    fn write_blob(
        &self,
        instance: &str,
        scope: &str,
        key: &str,
        cipher: &[u8],
        meta: &Meta,
    ) -> std::io::Result<()> {
        std::fs::create_dir_all(self.dir_for(instance))?;
        std::fs::write(self.blob_path(instance, scope, key), cipher)?;
        let record = serde_json::json!({
            "instance": instance,
            "scope": scope,
            "key": key,
            "bytes": meta.bytes,
            "updatedAt": meta.updated_at,
            "creds": meta.creds.iter().map(|c| hex_of(c)).collect::<Vec<_>>(),
        });
        std::fs::write(
            self.meta_path(instance, scope, key),
            serde_json::to_vec(&record).unwrap_or_default(),
        )?;
        Ok(())
    }

    /// 从 `updated_at` 最旧的开始淘汰，直到落回实例/全局预算之内。
    ///
    /// 刚写进去的那条是这里最新的，正常不会先被淘汰；只有当它自己就超过预算时才会
    /// 把自己删掉并返回 `false`（那种配置下它本就不该被收下）。
    fn enforce_budgets(&self, keep: &BlobKey) -> bool {
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());

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
                Some(victim) => self.remove_entry(&mut index, &victim),
                None => {
                    self.remove_entry(&mut index, keep);
                    return false;
                }
            }
        }

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
                Some(victim) => self.remove_entry(&mut index, &victim),
                None => {
                    self.remove_entry(&mut index, keep);
                    return false;
                }
            }
        }
        true
    }

    fn remove_entry(&self, index: &mut HashMap<BlobKey, Meta>, key: &BlobKey) {
        index.remove(key);
        let _ = std::fs::remove_file(self.blob_path(&key.0, &key.1, &key.2));
        let _ = std::fs::remove_file(self.meta_path(&key.0, &key.1, &key.2));
    }

    /// 清掉超过 TTL 的条目。`ttl_ms == 0` 视为不设 TTL。
    fn sweep_expired(&self) {
        if self.ttl_ms == 0 {
            return;
        }
        let now = now_ms();
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        let expired: Vec<BlobKey> = index
            .iter()
            .filter(|(_, meta)| now.saturating_sub(meta.updated_at) >= self.ttl_ms)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.remove_entry(&mut index, &key);
        }
    }

    /// 启动时扫 `root/<instance>/ *.meta` 重建索引（懒加载，读的是小文件）。
    fn rebuild_index(&self) {
        let Ok(instance_dirs) = std::fs::read_dir(&self.root) else {
            return;
        };
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        for instance_dir in instance_dirs.flatten() {
            let Ok(files) = std::fs::read_dir(instance_dir.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("meta") {
                    continue;
                }
                let Ok(raw) = std::fs::read(&path) else {
                    continue;
                };
                let Ok(value) = serde_json::from_slice::<serde_json::Value>(&raw) else {
                    continue;
                };
                let Some(instance) = value.get("instance").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(scope) = value.get("scope").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(key) = value.get("key").and_then(|v| v.as_str()) else {
                    continue;
                };
                let bytes = value
                    .get("bytes")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                let updated_at = value
                    .get("updatedAt")
                    .and_then(|v| v.as_u64())
                    .unwrap_or_else(now_ms);
                let creds = value
                    .get("creds")
                    .and_then(|v| v.as_array())
                    .map(|list| {
                        list.iter()
                            .filter_map(|item| item.as_str().and_then(decode_hex32))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                index.insert(
                    (instance.to_string(), scope.to_string(), key.to_string()),
                    Meta {
                        bytes,
                        updated_at,
                        seq: next_seq(),
                        creds,
                    },
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-blob-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn cred(tag: &[u8]) -> [u8; 32] {
        sha256_bytes(tag)
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
        assert!(store.put("inst-1", "messages", "old", &vec![1u8; 200], vec![credential]));
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
        let (count, total) = store.stats();
        assert_eq!(count, 1);
        assert!(total <= 300);
    }

    #[test]
    fn expired_blobs_are_swept_on_read() {
        // ttl_ms 走内部构造；推完睡过 5ms，读时先扫掉。
        let store = BlobStore::build(temp_root(), 1024, 4096, 8192, 1).unwrap();
        let credential = cred(b"device-a");
        assert!(store.put("inst-1", "messages", "ttl", b"payload", vec![credential]));
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(store.get("inst-1", "messages", "ttl", b"device-a"), None);
        assert_eq!(store.stats().0, 0, "过期条目读完要清掉");
    }
}
