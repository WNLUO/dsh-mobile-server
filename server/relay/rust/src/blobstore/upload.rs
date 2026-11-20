//! 每条宿主隧道串行接收有界 blob 分片，写盘确认不阻塞隧道分发。
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Duration;

use base64::Engine as _;
use dsh_relay_protocol::t;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::{BlobStore, Cred, KNOWN_SCOPES, MAX_CREDS};
use crate::tunnel::Tunnel;

pub const MAX_CHUNK_BYTES: usize = 48 * 1024;
pub type Command = (u8, u32, Vec<u8>);

struct PendingUpload {
    id: u32,
    scope: String,
    key: String,
    creds: Vec<Cred>,
    total: usize,
    offset: usize,
    path: PathBuf,
    file: std::fs::File,
}

impl Drop for PendingUpload {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.path); }
}

pub fn spawn(store: Arc<BlobStore>, tunnel: Weak<Tunnel>) -> mpsc::Sender<Command> {
    let (tx, mut rx) = mpsc::channel::<Command>(2);
    tokio::spawn(async move {
        let mut pending = None;
        loop {
            let command = match tokio::time::timeout(Duration::from_secs(90), rx.recv()).await {
                Ok(Some(command)) => command,
                Ok(None) => break,
                Err(_) => {
                    let old = pending.take();
                    let _ = tokio::task::spawn_blocking(move || drop(old)).await;
                    continue;
                }
            };
            let Some(tunnel) = tunnel.upgrade() else { break };
            if tunnel.is_closed() { break; }
            let Some(instance) = tunnel.instance_id() else { continue };
            let worker_store = store.clone();
            let worker_tunnel = tunnel.clone();
            let (kind, id, payload) = command;
            let result = tokio::task::spawn_blocking(move || {
                let mut pending = pending;
                if worker_tunnel.is_closed() { return (pending, None); }
                let value: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
                let ack = if kind == t::BLOB_DELETE {
                    delete(&worker_store, &instance, &value, &mut pending);
                    None
                } else if id == 0 {
                    put_legacy(&worker_store, &instance, &value);
                    None
                } else {
                    Some(match receive(&worker_store, &worker_tunnel, &instance, id, &value, &mut pending) {
                        Ok((offset, done)) => json!({"ok":true,"nextOffset":offset,"done":done}),
                        Err(error) => {
                            pending = None;
                            json!({"ok":false,"nextOffset":0,"done":false,"error":error})
                        }
                    })
                };
                (pending, ack)
            }).await;
            match result {
                Ok((next, ack)) => {
                    pending = next;
                    if !tunnel.is_closed() {
                        if let Some(ack) = ack {
                            // 回执也是有界发送：满水位时留在此worker等待，不能静默丢掉已落盘进度。
                            let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
                            let body = ack.to_string();
                            while !tunnel.send_json(t::BLOB_PUT, id as u64, &body) {
                                if tunnel.is_closed() || tokio::time::Instant::now() >= deadline { break; }
                                tokio::time::sleep(Duration::from_millis(25)).await;
                            }
                        }
                    }
                }
                Err(error) => {
                    pending = None;
                    tunnel.send_json(t::BLOB_PUT, id as u64, &json!({"ok":false,"nextOffset":0,"done":false,"error":format!("blob worker failed: {error}")}).to_string());
                }
            }
        }
        let _ = tokio::task::spawn_blocking(move || drop(pending)).await;
    });
    tx
}

fn cipher(value: &Value) -> Result<Vec<u8>, String> {
    let raw = value.get("cipher").and_then(Value::as_str).ok_or("missing cipher")?;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw.trim())
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(raw.trim()))
        .map_err(|_| "invalid cipher encoding".to_string())
}

fn metadata(value: &Value) -> Result<(String, String, Vec<Cred>), String> {
    let scope = value.get("scope").and_then(Value::as_str).unwrap_or("").trim();
    let key = value.get("key").and_then(Value::as_str).unwrap_or("").trim();
    let creds = crate::proxy::parse_creds(value.get("creds"));
    if !KNOWN_SCOPES.contains(&scope) || key.is_empty() || creds.is_empty() || creds.len() > MAX_CREDS {
        return Err("invalid blob metadata".into());
    }
    Ok((scope.to_string(), key.to_string(), creds))
}

fn number(value: &Value, key: &str) -> Result<usize, String> {
    value.get(key).and_then(Value::as_u64).and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| format!("invalid {key}"))
}

fn receive(store: &BlobStore, tunnel: &Tunnel, instance: &str, id: u32, value: &Value, pending: &mut Option<PendingUpload>) -> Result<(usize, bool), String> {
    let offset = number(value, "offset")?;
    let total = number(value, "total")?;
    let final_chunk = value.get("final").and_then(Value::as_bool).ok_or("missing final")?;
    let bytes = cipher(value)?;
    let end = offset.checked_add(bytes.len()).ok_or("offset overflow")?;
    if total == 0 || total > store.max_blob_bytes.min(store.max_per_instance_bytes).min(store.max_total_bytes)
        || bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES || end > total || final_chunk != (end == total) {
        return Err("invalid blob chunk bounds".into());
    }
    // 上一轮回执丢失后，新id从零重推可替换旧临时上传，不必先失败一整轮。
    if offset == 0 && pending.as_ref().map(|upload| upload.id != id).unwrap_or(false) { *pending = None; }
    if pending.is_none() {
        if offset != 0 { return Err("blob upload must start at zero".into()); }
        let (scope, key, creds) = metadata(value)?;
        let dir = store.dir_for(instance);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("{}.upload.{}.tmp", BlobStore::hash_for(&scope, &key), super::next_seq()));
        let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        *pending = Some(PendingUpload { id, scope, key, creds, total, offset: 0, path, file });
    }
    let upload = pending.as_mut().ok_or("missing upload")?;
    if upload.id != id || upload.total != total || upload.offset != offset {
        return Err("blob upload id or offset mismatch".into());
    }
    upload.file.write_all(&bytes).and_then(|_| upload.file.sync_data()).map_err(|e| e.to_string())?;
    upload.offset = end;
    if final_chunk {
        if tunnel.is_closed() { return Err("tunnel closed".into()); }
        let upload = pending.take().ok_or("missing upload")?;
        if !store.commit_upload(instance, &upload.scope, &upload.key, &upload.path, total, upload.creds.clone()) {
            return Err("blob commit rejected".into());
        }
    }
    Ok((end, final_chunk))
}

fn put_legacy(store: &BlobStore, instance: &str, value: &Value) {
    let Ok((scope, key, creds)) = metadata(value) else { return };
    let Ok(bytes) = cipher(value) else { return };
    if !store.put(instance, &scope, &key, &bytes, creds) {
        crate::tunnel::log(format!("blob put rejected instance={instance} scope={scope} bytes={}", bytes.len()));
    }
}

fn delete(store: &BlobStore, instance: &str, value: &Value, pending: &mut Option<PendingUpload>) {
    let scope = value.get("scope").and_then(Value::as_str).unwrap_or("").trim();
    let mut keys = Vec::new();
    if let Some(key) = value.get("key").and_then(Value::as_str) { keys.push(key.to_string()); }
    if let Some(list) = value.get("keys").and_then(Value::as_array) {
        keys.extend(list.iter().filter_map(Value::as_str).map(str::to_string));
    }
    if pending.as_ref().map(|p| p.scope == scope && keys.contains(&p.key)).unwrap_or(false) { *pending = None; }
    for key in keys { store.delete(instance, scope, key.trim()); }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Arc<BlobStore>, Arc<Tunnel>, tokio::sync::mpsc::Receiver<tokio_tungstenite::tungstenite::Message>) {
        let root = std::env::temp_dir().join(format!("dsh-blob-upload-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(BlobStore::new(root, 1024, 4096, 8192, 3600).unwrap());
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        let tunnel = Tunnel::new(tx);
        assert!(tunnel.bind_instance("instance"));
        (store, tunnel, rx)
    }

    fn chunk(offset: usize, total: usize, final_chunk: bool, bytes: &[u8]) -> Value {
        json!({"scope":"messages","key":"session","creds":[super::super::hex_of(&super::super::sha256_bytes(b"device"))],
            "offset":offset,"total":total,"final":final_chunk,
            "cipher":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)})
    }

    #[test]
    fn partial_upload_keeps_old_blob_then_final_publishes_complete_bytes() {
        let (store, tunnel, _rx) = setup();
        let cred = Cred { hash: super::super::sha256_bytes(b"device"), expires_at: 0 };
        assert!(store.put("instance", "messages", "session", b"old", vec![cred]));
        let mut pending = None;
        assert_eq!(receive(&store, &tunnel, "instance", 7, &chunk(0, 6, false, b"abc"), &mut pending).unwrap(), (3, false));
        assert_eq!(store.get("instance", "messages", "session", b"device").unwrap(), b"old");
        let continuation = json!({"offset":3,"total":6,"final":true,"cipher":"ZGVm"});
        assert_eq!(receive(&store, &tunnel, "instance", 7, &continuation, &mut pending).unwrap(), (6, true));
        assert!(pending.is_none());
        assert_eq!(store.get("instance", "messages", "session", b"device").unwrap(), b"abcdef");
        let reloaded = BlobStore::new(store.root.clone(), 1024, 4096, 8192, 3600).unwrap();
        assert_eq!(reloaded.get("instance", "messages", "session", b"device").unwrap(), b"abcdef");
    }

    #[test]
    fn invalid_offset_empty_tail_and_abandoned_upload_do_not_publish() {
        let (store, tunnel, _rx) = setup();
        let mut pending = None;
        assert!(receive(&store, &tunnel, "instance", 1, &chunk(0, 6, false, b"abc"), &mut pending).is_ok());
        let temporary = pending.as_ref().unwrap().path.clone();
        assert!(temporary.exists());
        assert!(receive(&store, &tunnel, "instance", 1, &chunk(2, 6, true, b"defg"), &mut pending).is_err());
        assert!(receive(&store, &tunnel, "instance", 1, &chunk(3, 3, true, b""), &mut pending).is_err());
        drop(pending.take());
        assert!(!temporary.exists());
        assert!(store.get("instance", "messages", "session", b"device").is_none());
    }

    #[tokio::test]
    async fn worker_acknowledges_only_written_progress_and_cleans_on_close() {
        let (store, tunnel, mut replies) = setup();
        let sender = spawn(store.clone(), Arc::downgrade(&tunnel));
        sender.send((t::BLOB_PUT, 8, chunk(0, 6, false, b"abc").to_string().into_bytes())).await.unwrap();
        let reply = replies.recv().await.unwrap();
        let mut decoder = dsh_relay_protocol::FrameDecoder::new(128 * 1024);
        let mut ack = None;
        decoder.push(&reply.into_data(), |frame| { ack = Some(serde_json::from_slice::<Value>(frame.payload).unwrap()); });
        assert_eq!(ack.as_ref().unwrap(), &json!({"ok":true,"nextOffset":3,"done":false}));
        assert_eq!(store.stats().0, 0);
        // 非法后片必须失败并释放临时文件，旧id不影响HTTP/WS pending。
        sender.send((t::BLOB_PUT, 8, chunk(4, 6, true, b"de").to_string().into_bytes())).await.unwrap();
        let reply = replies.recv().await.unwrap();
        decoder.push(&reply.into_data(), |frame| { ack = Some(serde_json::from_slice::<Value>(frame.payload).unwrap()); });
        assert_eq!(ack.as_ref().unwrap()["ok"], false);
        assert_eq!(ack.as_ref().unwrap()["nextOffset"], 0);
        assert!(tunnel.pending.lock().unwrap().is_empty());
        tunnel.mark_closed();
        drop(sender);
    }
}
