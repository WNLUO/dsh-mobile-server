// 管理写入返回数据库错误；不存在与重复删除保留独立的幂等语义。
//! 控制台数据层：身份稳定匹配、有限登录事务与原子设备名额。
//!
//! 沿用 Node 运营版的授权码规则与基础表结构；新增列按已有探测补列方式升级。
//!
//! 约定沿用原版：
//!   - 时间一律 UTC ISO-8601 字符串，字符串比较即时间比较；
//!   - 对外暴露的 id 都是 UUID v4；
//!   - 授权码字母表去掉 `0/O/1/I/L`，`DSH-XXXX-XXXX-XXXX-XXXX`。
//!
//! 与纯转发无关：`store` 只被控制台与准入校验用到，转发路径不碰数据库。

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// 建表 SQL。与 Node 版 `db.js` 的 SCHEMA 逐表对应，砍掉了订单与支付两张表
/// （自建中转不卖授权），其余保持一致。
const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  subject       TEXT NOT NULL UNIQUE,
  oidc_sub      TEXT,
  display_name  TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT NOT NULL DEFAULT '',
  openid        TEXT,
  union_id      TEXT,
  wechat_appid  TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_states (
  state         TEXT PRIMARY KEY,
  nonce         TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  attempts_left INTEGER NOT NULL DEFAULT 3,
  redirect_uri  TEXT NOT NULL,
  next_path     TEXT NOT NULL DEFAULT '/',
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

-- 激活码：一个码一台设备。绑上之后锁死，面板解绑才能换设备。
CREATE TABLE IF NOT EXISTS licenses (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT,
  code         TEXT NOT NULL UNIQUE,
  device_limit INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'active',
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licenses_owner ON licenses(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  license_id  TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  platform    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  bound_at    TEXT NOT NULL,
  last_seen_at TEXT,
  UNIQUE (license_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_devices_license ON devices(license_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 插件 OTA 这条**临时通道**的版本索引（正式分发仍归 npm 市场）。
-- 只存够客户端用的一样东西：某个平台/渠道当前该给哪个版本、包在哪。
CREATE TABLE IF NOT EXISTS ota_releases (
  id           TEXT PRIMARY KEY,
  platform     TEXT NOT NULL,
  channel      TEXT NOT NULL,
  version      TEXT NOT NULL,
  package_path TEXT NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0,
  -- 包的 sha256（小写十六进制）。客户端下载后核对：半个包 / 被中间层改过的包在激活前就挡住。
  -- 老库补列时默认为空串，客户端见到空串就不校验（向后兼容）。
  sha256       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  UNIQUE (platform, channel, version)
);
CREATE INDEX IF NOT EXISTS idx_ota_lookup ON ota_releases(platform, channel, created_at DESC);

-- 主控端侧的「我管着谁」。被控端拿认领码来报到，主控端记下它。
-- 只在主控端用得到；被控端自己的库里这张表是空的。
CREATE TABLE IF NOT EXISTS nodes (
  id             TEXT PRIMARY KEY,
  claim_code     TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL DEFAULT '',
  public_url     TEXT NOT NULL DEFAULT '',
  -- 被控端自己报的状态快照，JSON。主控端只读不改。
  status_json    TEXT NOT NULL DEFAULT '',
  -- 被控端**实际在用**的准入模式（它自己报上来的）。
  admission_mode TEXT NOT NULL DEFAULT 'open',
  -- 主控端希望它用哪个：'open' / 'restricted'。空串＝主控端不管，由被控端自己决定。
  -- 被控端每次上报时把它取走并落地。
  desired_mode   TEXT NOT NULL DEFAULT '',
  license_count  INTEGER NOT NULL DEFAULT 0,
  device_count   INTEGER NOT NULL DEFAULT 0,
  tunnel_online  INTEGER NOT NULL DEFAULT 0,
  -- 上次心跳。离线判定看它。
  last_seen_at   TEXT,
  -- 主控端点「移除」时只打这个时间戳，**不删行**：删了之后既看不出它曾经存在，
  -- 也没法在日志/面板里告诉人「这台是被移掉的，不是连不上」。
  revoked_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
"#;

/// 给老库补列。`CREATE TABLE IF NOT EXISTS` 不会改动已经存在的表——加字段只能 ALTER，
/// 否则老库一直在用缺列的表，新代码一查就报 `no such column`。
///
/// 判据是列是否存在，沿用现有方式逐列补齐。
fn ensure_columns(conn: &Connection) {
    for (probe, ddl) in [
        (
            "SELECT oidc_sub FROM users LIMIT 1",
            "ALTER TABLE users ADD COLUMN oidc_sub TEXT",
        ),
        (
            "SELECT attempts_left FROM login_states LIMIT 1",
            "ALTER TABLE login_states ADD COLUMN attempts_left INTEGER NOT NULL DEFAULT 3",
        ),
        (
            "SELECT desired_mode FROM nodes LIMIT 1",
            "ALTER TABLE nodes ADD COLUMN desired_mode TEXT NOT NULL DEFAULT ''",
        ),
        (
            "SELECT revoked_at FROM nodes LIMIT 1",
            "ALTER TABLE nodes ADD COLUMN revoked_at TEXT",
        ),
        (
            "SELECT sha256 FROM ota_releases LIMIT 1",
            "ALTER TABLE ota_releases ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''",
        ),
    ] {
        if conn.prepare(probe).is_err() {
            let _ = conn.execute(ddl, []);
        }
    }
}

/// 授权码字母表：去掉 0/O/1/I/L，手抄不会看错。
pub const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/// 生成一个授权码，形如 `DSH-XXXX-XXXX-XXXX-XXXX`。
pub fn generate_license_code() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let mut out = String::from("DSH-");
    for i in 0..16 {
        if i > 0 && i % 4 == 0 {
            out.push('-');
        }
        let idx = rng.gen_range(0..CODE_ALPHABET.len());
        out.push(CODE_ALPHABET[idx] as char);
    }
    out
}

/// 用户抄写时可能带空格、小写、中文破折号，归一化后再查。
///
/// 与 Node 版 `normalizeLicenseCode` 逐条对应：trim → 大写 → 各类破折号/下划线统一成
/// `-` → 折叠连续的 `-` → 补上 `DSH-` 前缀。用户从微信里复制过来的码几乎必带前后空白。
pub fn normalize_license_code(input: &str) -> String {
    let upper: String = input.trim().to_uppercase();
    // 空格 + Unicode 各种破折号（U+2010..U+2015）+ 全角连字符（U+FF0D）+ 下划线，统一成 '-'
    let mut unified = String::with_capacity(upper.len());
    for ch in upper.chars() {
        let is_sep = ch.is_whitespace()
            || ch == '_'
            || ch == '\u{FF0D}'
            || ('\u{2010}'..='\u{2015}').contains(&ch);
        unified.push(if is_sep { '-' } else { ch });
    }
    let mut folded = String::with_capacity(unified.len());
    let mut prev_dash = false;
    for ch in unified.chars() {
        if ch == '-' {
            if prev_dash {
                continue;
            }
            prev_dash = true;
        } else {
            prev_dash = false;
        }
        folded.push(ch);
    }
    if let Some(rest) = folded.strip_prefix("DSH-") {
        format!("DSH-{rest}")
    } else if let Some(rest) = folded.strip_prefix("DSH") {
        format!("DSH-{rest}")
    } else {
        format!("DSH-{folded}")
    }
}

fn now_iso() -> String {
    crate::store::iso_now()
}

/// 一个用户。字段与 `users` 表一一对应。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub subject: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: String,
    pub openid: Option<String>,
    #[serde(rename = "unionId")]
    pub union_id: Option<String>,
    #[serde(rename = "isAdmin")]
    pub is_admin: bool,
    pub status: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastLoginAt")]
    pub last_login_at: Option<String>,
}

/// 一个激活码。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct License {
    pub id: String,
    #[serde(rename = "ownerId")]
    pub owner_id: Option<String>,
    pub code: String,
    #[serde(rename = "deviceLimit")]
    pub device_limit: i64,
    pub status: String,
    pub note: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// 一条设备绑定。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    #[serde(rename = "licenseId")]
    pub license_id: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "deviceName")]
    pub device_name: String,
    pub platform: String,
    pub status: String,
    #[serde(rename = "boundAt")]
    pub bound_at: String,
    #[serde(rename = "lastSeenAt")]
    pub last_seen_at: Option<String>,
}

/// 数据层。内部一个 `Mutex<Connection>`：请求量是面板级别，不需要连接池。
#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl Store {
    /// 打开数据库并建表。`:memory:` 用于测试。
    pub fn open(path: &Path) -> Result<Self, String> {
        checked_system_time();
        if let Some(dir) = path.parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("建数据目录失败 {}: {e}", dir.display()))?;
            }
        }
        let conn = Connection::open(path).map_err(|e| format!("打开数据库失败: {e}"))?;
        conn.execute_batch(SCHEMA).map_err(|e| format!("建表失败: {e}"))?;
        ensure_columns(&conn);
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// 内存库，测试用。
    pub fn in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("打开内存库失败: {e}"))?;
        conn.execute_batch(SCHEMA).map_err(|e| format!("建表失败: {e}"))?;
        ensure_columns(&conn);
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ── settings ──────────────────────────────────────────────────

    pub fn get_setting(&self, key: &str) -> Option<String> {
        self.lock()
            .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let ts = now_iso();
        self.lock().execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, ts],
        ).map(|_| ()).map_err(|error| error.to_string())
    }

    // ── users ─────────────────────────────────────────────────────

    pub fn user_count(&self) -> i64 {
        self.lock()
            .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
            .unwrap_or(0)
    }

    pub fn find_user_by_id(&self, id: &str) -> Option<User> {
        self.lock()
            .query_row("SELECT * FROM users WHERE id = ?1", params![id], map_user)
            .optional()
            .ok()
            .flatten()
    }

    pub fn find_user_by_subject(&self, subject: &str) -> Option<User> {
        self.lock()
            .query_row("SELECT * FROM users WHERE subject = ?1", params![subject], map_user)
            .optional()
            .ok()
            .flatten()
    }

    /// 微信登录落地。
    ///
    /// 建号 / 更新资料，**不自动提权**：是否给管理员由调用方决定（控制台回调按
    /// `PLATFORM_BOOTSTRAP_FIRST_ADMIN` 开关与 `PLATFORM_ADMIN_SUBS` 白名单显式提）。
    /// 旧实现里「库里第一个用户无条件成管理员」等于任何能过 OIDC 登录的人，在新部署上
    /// 抢在运营者之前登录就能白拿管理权——这个判断不该埋在存储层。
    pub fn upsert_user(
        &self,
        subject: &str,
        display_name: &str,
        avatar_url: &str,
        openid: Option<&str>,
        union_id: Option<&str>,
    ) -> User {
        let ts = now_iso();
        if let Some(existing) = self.find_user_by_subject(subject) {
            let _ = self.lock().execute(
                "UPDATE users SET display_name = ?1, avatar_url = ?2, last_login_at = ?3, updated_at = ?3
                 WHERE id = ?4",
                params![display_name, avatar_url, ts, existing.id],
            );
            return self.find_user_by_id(&existing.id).unwrap_or(existing);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let _ = self.lock().execute(
            "INSERT INTO users (id, subject, display_name, avatar_url, openid, union_id,
               is_admin, status, created_at, updated_at, last_login_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?8, ?8)",
            params![
                id,
                subject,
                display_name,
                avatar_url,
                openid,
                union_id,
                0,
                ts
            ],
        );
        self.find_user_by_id(&id).expect("刚插入的用户读不回来")
    }

    /// 只按同类型标识匹配一个用户；冲突不归并，已有 subject 与权限保持稳定。
    pub fn upsert_oidc_user(
        &self,
        sub: Option<&str>,
        openid: Option<&str>,
        union_id: Option<&str>,
        display_name: &str,
        avatar_url: &str,
    ) -> Result<User, String> {
        let sub = sub.filter(|v| !v.is_empty());
        let openid = openid.filter(|v| !v.is_empty());
        let union_id = union_id.filter(|v| !v.is_empty());
        let subject = sub.map(|v| format!("sub:{v}"))
            .or_else(|| union_id.map(|v| format!("unionid:{v}")))
            .or_else(|| openid.map(|v| format!("openid:{v}")))
            .ok_or_else(|| "登录系统没有返回可用的身份标识".to_string())?;
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let mut candidates = Vec::new();
        {
            let mut stmt = tx.prepare(
                "SELECT * FROM users WHERE
                 (?1 IS NOT NULL AND (oidc_sub = ?1 OR subject = 'sub:' || ?1)) OR
                 (?2 IS NOT NULL AND (openid = ?2 OR subject = 'openid:' || ?2)) OR
                 (?3 IS NOT NULL AND (union_id = ?3 OR subject = 'unionid:' || ?3))"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![sub, openid, union_id], map_user).map_err(|e| e.to_string())?;
            for row in rows { candidates.push(row.map_err(|e| e.to_string())?); }
        }
        if candidates.len() > 1 {
            return Err("登录身份标识对应多个账号，请联系管理员处理".into());
        }
        let ts = now_iso();
        let id = if let Some(user) = candidates.first() {
            let stored_sub: Option<String> = tx.query_row(
                "SELECT oidc_sub FROM users WHERE id = ?1", params![user.id], |row| row.get(0)
            ).map_err(|e| e.to_string())?;
            for (incoming, stored, prefix) in [
                (sub, stored_sub.as_deref(), "sub:"),
                (openid, user.openid.as_deref(), "openid:"),
                (union_id, user.union_id.as_deref(), "unionid:"),
            ] {
                let stored = stored.filter(|v| !v.is_empty()).or_else(|| user.subject.strip_prefix(prefix));
                if matches!((incoming, stored), (Some(a), Some(b)) if a != b) {
                    return Err("登录身份标识与已有账号冲突，请联系管理员处理".into());
                }
            }
            tx.execute(
                "UPDATE users SET oidc_sub = COALESCE(?1, oidc_sub), openid = COALESCE(?2, openid),
                 union_id = COALESCE(?3, union_id), display_name = ?4, avatar_url = ?5,
                 last_login_at = ?6, updated_at = ?6 WHERE id = ?7",
                params![sub, openid, union_id, display_name, avatar_url, ts, user.id],
            ).map_err(|e| e.to_string())?;
            user.id.clone()
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO users (id, subject, oidc_sub, openid, union_id, display_name, avatar_url,
                 is_admin, status, created_at, updated_at, last_login_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 'active', ?8, ?8, ?8)",
                params![id, subject, sub, openid, union_id, display_name, avatar_url, ts],
            ).map_err(|e| e.to_string())?;
            id
        };
        let user = tx.query_row("SELECT * FROM users WHERE id = ?1", params![id], map_user)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(user)
    }

    /// 把用户提成管理员（`PLATFORM_ADMIN_SUBS` 白名单命中时用）。
    pub fn promote_admin(&self, id: &str) {
        let _ = self.lock().execute(
            "UPDATE users SET is_admin = 1, updated_at = ?1 WHERE id = ?2",
            params![now_iso(), id],
        );
    }

    // ── login_states（OIDC 授权事务）─────────────────────────────

    /// 记一次登录事务。顺手清掉过期的，别让它们堆着（与 Node 版同一做法）。
    pub fn save_login_state(&self, state: &str, nonce: &str, verifier: &str, next_path: &str, ttl_seconds: i64) {
        let conn = self.lock();
        let _ = conn.execute(
            "DELETE FROM login_states WHERE expires_at < ?1",
            params![now_iso()],
        );
        let _ = conn.execute(
            "INSERT INTO login_states (state, nonce, code_verifier, redirect_uri, next_path, created_at, expires_at)
             VALUES (?1, ?2, ?3, '', ?4, ?5, ?6)",
            params![
                state,
                nonce,
                verifier,
                next_path,
                now_iso(),
                iso_after_seconds(ttl_seconds)
            ],
        );
    }

    /// 外呼前原子占用一次尝试；最多三次，保留短暂失败后的有限重试。
    pub fn take_login_state(&self, state: &str) -> Option<(String, String)> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).ok()?;
        let updated = tx.execute(
            "UPDATE login_states SET attempts_left = attempts_left - 1
             WHERE state = ?1 AND expires_at > ?2 AND attempts_left > 0",
            params![state, now_iso()],
        ).ok()?;
        if updated != 1 { return None; }
        let result = tx.query_row(
            "SELECT code_verifier, next_path FROM login_states WHERE state = ?1",
            params![state], |row| Ok((row.get(0)?, row.get(1)?)),
        ).ok()?;
        tx.commit().ok()?;
        Some(result)
    }

    /// 登录成功之后把这条事务删掉。迟到的重试会拿到 None，这是对的。
    pub fn finish_login_state(&self, state: &str) {
        let _ = self
            .lock()
            .execute("DELETE FROM login_states WHERE state = ?1", params![state]);
    }

    // ── sessions ──────────────────────────────────────────────────

    /// 清掉过期数据：过期的会话、过期的登录事务。
    ///
    /// 不删也不会坏，`session_user` / `take_login_state` 都自己判过期；但一个人登录
    /// 一年就是几百行死记录，`login_states` 更是从来没人登出就一直在。这不是安全问题，
    /// 是不想让它无限长。每天跑一次就够。
    ///
    /// 返回 (清掉的会话数, 清掉的登录事务数)。
    pub fn purge_expired(&self) -> (usize, usize) {
        let ts = now_iso();
        let sessions = self
            .lock()
            .execute("DELETE FROM sessions WHERE expires_at < ?1", params![ts])
            .unwrap_or(0);
        let states = self
            .lock()
            .execute("DELETE FROM login_states WHERE expires_at < ?1", params![ts])
            .unwrap_or(0);
        (sessions, states)
    }

    pub fn create_session(&self, user_id: &str, token_hash: &str, expires_at: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let ts = now_iso();
        let _ = self.lock().execute(
            "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, user_id, token_hash, expires_at, ts],
        );
        id
    }

    /// 按 token 哈希查会话，顺带把 user 一并取出来（面板每次请求都要用户）。
    pub fn session_user(&self, token_hash: &str) -> Option<User> {
        let conn = self.lock();
        let user_id: Option<String> = conn
            .query_row(
                "SELECT user_id FROM sessions WHERE token_hash = ?1 AND expires_at > ?2",
                params![token_hash, now_iso()],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten();
        drop(conn);
        user_id.and_then(|id| self.find_user_by_id(&id))
    }

    pub fn delete_session(&self, token_hash: &str) {
        let _ = self
            .lock()
            .execute("DELETE FROM sessions WHERE token_hash = ?1", params![token_hash]);
    }

    // ── licenses ──────────────────────────────────────────────────

    /// 生成一个新码。撞码时重试几次（16^16 的空间，撞上基本不可能，但保留原版的重试）。
    pub fn create_license(&self, owner_id: Option<&str>, note: &str) -> Result<License, String> {
        let ts = now_iso();
        let conn = self.lock();
        for _ in 0..5 {
            let id = uuid::Uuid::new_v4().to_string();
            let code = generate_license_code();
            match conn.execute(
                "INSERT INTO licenses (id, owner_id, code, device_limit, status, note, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 1, 'active', ?4, ?5, ?5)",
                params![id, owner_id, code, note, ts],
            ) {
                Ok(_) => return conn.query_row("SELECT * FROM licenses WHERE id = ?1", params![id], map_license)
                    .map_err(|error| error.to_string()),
                Err(error) if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("无法生成唯一激活码，请重试".into())
    }

    pub fn find_license_by_id(&self, id: &str) -> Option<License> {
        self.lock()
            .query_row("SELECT * FROM licenses WHERE id = ?1", params![id], map_license)
            .optional()
            .ok()
            .flatten()
    }

    pub fn find_license_by_code(&self, code: &str) -> Option<License> {
        self.lock()
            .query_row("SELECT * FROM licenses WHERE code = ?1", params![code], map_license)
            .optional()
            .ok()
            .flatten()
    }

    /// 面板列表：最新的在前。
    pub fn list_licenses(&self, limit: i64) -> Vec<License> {
        let conn = self.lock();
        let mut stmt = match conn.prepare(
            "SELECT * FROM licenses ORDER BY created_at DESC LIMIT ?1",
        ) {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![limit], map_license);
        match rows {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn set_license_status(&self, id: &str, status: &str) -> Result<bool, String> {
        self.lock().execute(
            "UPDATE licenses SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now_iso(), id],
        ).map(|count| count > 0).map_err(|error| error.to_string())
    }

    // ── devices ───────────────────────────────────────────────────

    pub fn find_device(&self, license_id: &str, device_id: &str) -> Option<Device> {
        self.lock()
            .query_row(
                "SELECT * FROM devices WHERE license_id = ?1 AND device_id = ?2",
                params![license_id, device_id],
                map_device,
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn count_active_devices(&self, license_id: &str) -> i64 {
        self.lock()
            .query_row(
                "SELECT COUNT(*) FROM devices WHERE license_id = ?1 AND status = 'active'",
                params![license_id],
                |row| row.get(0),
            )
            .unwrap_or(0)
    }

    /// 绑定一台设备。已绑过就更新名字与时间，不重复插。
    ///
    /// 返回 `Err` 表示这个码的名额已满：一个码一台设备，多出来的必须先解绑。
    pub fn bind_device(
        &self,
        license_id: &str,
        device_id: &str,
        device_name: &str,
        platform: &str,
    ) -> Result<Device, String> {
        let ts = now_iso();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let existing = tx.query_row(
            "SELECT * FROM devices WHERE license_id = ?1 AND device_id = ?2",
            params![license_id, device_id], map_device,
        ).optional().map_err(|e| e.to_string())?;
        if existing.as_ref().map(|d| d.status != "active").unwrap_or(true) {
            let limit: i64 = tx.query_row(
                "SELECT device_limit FROM licenses WHERE id = ?1", params![license_id], |row| row.get(0),
            ).map_err(|e| e.to_string())?;
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM devices WHERE license_id = ?1 AND status = 'active'",
                params![license_id], |row| row.get(0),
            ).map_err(|e| e.to_string())?;
            if count >= limit { return Err("device limit reached".into()); }
        }
        if let Some(existing) = existing {
            tx.execute(
                "UPDATE devices SET device_name = ?1, platform = ?2, status = 'active', last_seen_at = ?3 WHERE id = ?4",
                params![if device_name.is_empty() { existing.device_name.as_str() } else { device_name },
                    if platform.is_empty() { existing.platform.as_str() } else { platform }, ts, existing.id],
            ).map_err(|e| e.to_string())?;
        } else {
            tx.execute(
                "INSERT INTO devices (id, license_id, device_id, device_name, platform, status, bound_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)",
                params![uuid::Uuid::new_v4().to_string(), license_id, device_id, device_name, platform, ts],
            ).map_err(|e| e.to_string())?;
        }
        let device = tx.query_row(
            "SELECT * FROM devices WHERE license_id = ?1 AND device_id = ?2",
            params![license_id, device_id], map_device,
        ).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(device)
    }

    pub fn touch_device(&self, license_id: &str, device_id: &str) {
        let _ = self.lock().execute(
            "UPDATE devices SET last_seen_at = ?1 WHERE license_id = ?2 AND device_id = ?3",
            params![now_iso(), license_id, device_id],
        );
    }

    /// 解绑：删掉这条设备记录，名额放回去。**允许改绑**就是靠它。
    pub fn unbind_device(&self, license_id: &str, device_id: &str) -> Result<bool, String> {
        self.lock()
            .execute(
                "DELETE FROM devices WHERE license_id = ?1 AND device_id = ?2",
                params![license_id, device_id],
            )
            .map(|n| n > 0)
            .map_err(|error| error.to_string())
    }

    pub fn list_devices(&self, license_id: &str) -> Vec<Device> {
        let conn = self.lock();
        let mut stmt = match conn
            .prepare("SELECT * FROM devices WHERE license_id = ?1 ORDER BY bound_at DESC")
        {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![license_id], map_device);
        match rows {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }

    // ── nodes（主控端 / 被控端）──────────────────────────────────
    //
    // 两种角色共用一套表，但用途相反：
    //   - 主控端：这张表就是「我管着哪些被控端」，按 claim_code 认领；
    //   - 被控端：它只往主控端上报，自己不写这张表。
    //
    // 主控端**只存被控端报上来的快照**，不下发隧道流量——主控端挂了不影响任何转发。

    /// 建一个认领码。搭建者把它填到被控端的配置里，被控端拿它来报到。
    pub fn create_node(&self, name: &str) -> Result<Node, String> {
        let ts = now_iso();
        let conn = self.lock();
        for _ in 0..5 {
            let id = uuid::Uuid::new_v4().to_string();
            let code = normalize_claim_code(&generate_claim_code());
            match conn.execute(
                "INSERT INTO nodes (id, claim_code, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                params![id, code, name, ts],
            ) {
                Ok(_) => return conn.query_row("SELECT * FROM nodes WHERE id = ?1", params![id], map_node)
                    .map_err(|error| error.to_string()),
                // 唯一约束覆盖已移除行；只换新码重试，不删除任何历史。
                Err(error) if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("无法生成唯一认领码，请重试".into())
    }

    pub fn find_node_by_id(&self, id: &str) -> Option<Node> {
        self.lock()
            .query_row("SELECT * FROM nodes WHERE id = ?1", params![id], map_node)
            .optional()
            .ok()
            .flatten()
    }

    /// 按认领码找。**两边都归一化**：库里存的是生成时的规范形，用户抄来的可能是
    /// 小写、带空格或者被聊天软件换成中文破折号的那种。
    pub fn find_node_by_claim(&self, claim: &str) -> Option<Node> {
        let wanted = normalize_claim_code(claim);
        self.lock()
            .query_row(
                "SELECT * FROM nodes WHERE claim_code = ?1",
                params![wanted],
                map_node,
            )
            .optional()
            .ok()
            .flatten()
    }

    /// 按认领码找**已经移除**的那台。上报被拒时用它把话说清楚：是「被移除了」
    /// 还是「这个码从来不认识」。两者要的处置不一样。
    pub fn find_revoked_node_by_claim(&self, claim: &str) -> Option<Node> {
        let wanted = normalize_claim_code(claim);
        self.lock()
            .query_row(
                "SELECT * FROM nodes WHERE claim_code = ?1 AND revoked_at IS NOT NULL",
                params![wanted],
                map_node,
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn list_nodes(&self, limit: i64) -> Vec<Node> {
        let conn = self.lock();
        let mut stmt = match conn.prepare("SELECT * FROM nodes ORDER BY created_at DESC LIMIT ?1") {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![limit], map_node);
        match rows {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// 被控端报到 / 心跳。主控端拿快照刷新自己这边的行。
    pub fn touch_node(&self, id: &str, report: &NodeReport) {
        let _ = self.lock().execute(
            "UPDATE nodes SET name = ?1, public_url = ?2, status_json = ?3, admission_mode = ?4,
               license_count = ?5, device_count = ?6, tunnel_online = ?7, last_seen_at = ?8, updated_at = ?8
             WHERE id = ?9",
            params![
                report.name,
                report.public_url,
                report.status_json,
                report.admission_mode,
                report.license_count,
                report.device_count,
                if report.tunnel_online { 1 } else { 0 },
                now_iso(),
                id
            ],
        );
    }

    /// 主控端希望这台被控端用哪个准入模式。空串＝主控端不管它。
    ///
    /// 上报回包与面板都从这里取，**只有这一处是事实源**——被控端自己库里那份
    /// `admission_mode` 是「它现在实际在用的」，两者不一样就说明还没落地。
    pub fn desired_mode_of(&self, id: &str) -> String {
        self.lock()
            .query_row(
                "SELECT desired_mode FROM nodes WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .unwrap_or_default()
    }

    /// 主控端设置希望被控端用的模式。`None` 表示交还给被控端自己决定。
    ///
    /// 返回 `false` 表示这台被控端不存在（或已被吊销）。
    pub fn set_desired_mode(&self, id: &str, mode: Option<&str>) -> Result<bool, String> {
        self.lock()
            .execute(
                "UPDATE nodes SET desired_mode = ?1, updated_at = ?2 WHERE id = ?3 AND revoked_at IS NULL",
                params![mode.unwrap_or(""), now_iso(), id],
            )
            .map(|n| n > 0)
            .map_err(|error| error.to_string())
    }

    /// 让一个认领码失效。被控端之后再报到会被拒。
    ///
    /// **只打时间戳、不删行**。删了之后主控端自己也看不出这台曾经存在过，被控端那边
    /// 收到的又只是 404，和「认领码填错了」长得一模一样——而这两件事该做的处置完全不同
    /// （重新生成认领码 vs 去核对地址）。留一行就能把话说清楚。
    pub fn revoke_node(&self, id: &str) -> Result<bool, String> {
        self.lock().execute(
            "UPDATE nodes SET revoked_at = ?1, updated_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
            params![now_iso(), id],
        ).map(|count| count > 0).map_err(|error| error.to_string())
    }

    /// 把一条已移除的记录彻底删掉（面板上的「彻底删除」，只收拾残局用）。
    pub fn forget_node(&self, id: &str) -> Result<bool, String> {
        self.lock().execute("DELETE FROM nodes WHERE id = ?1", params![id])
            .map(|count| count > 0).map_err(|error| error.to_string())
    }

    #[cfg(test)]
    pub(crate) fn reject_writes_for_test(&self) {
        self.lock().execute_batch("PRAGMA query_only = ON").unwrap();
    }

    // ── ota_releases（插件 OTA 临时通道）──────────────────────────
    //
    // 只服务一件事：客户端按 `latest?platform=&channel=` 问「我该装哪个版本」，然后
    // 按返回的下载地址拿包。**不做增量、不做多插件矩阵**——那套归 npm 市场，
    // 这里是救急用的临时通道，够用就停。
    //
    // 包文件落在 `PLATFORM_OTA_ROOT/<platform>/<channel>/` 下；索引记录本次发布的
    // 独立文件路径、大小与摘要，外部下载 URL 仍按版本号查索引。

    /// 登记一个包，并让它成为该平台/渠道的最新版。
    pub fn put_ota_release(
        &self,
        platform: &str,
        channel: &str,
        version: &str,
        package_path: &str,
        size: i64,
        sha256: &str,
    ) -> Result<(), String> {
        self.lock().execute(
            "INSERT INTO ota_releases (id, platform, channel, version, package_path, size, sha256, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(platform, channel, version) DO UPDATE SET
               package_path = excluded.package_path, size = excluded.size,
               sha256 = excluded.sha256, created_at = excluded.created_at",
            params![
                uuid::Uuid::new_v4().to_string(),
                platform,
                channel,
                version,
                package_path,
                size,
                sha256,
                now_iso()
            ],
        ).map(|_| ()).map_err(|error| format!("登记 OTA 版本失败: {error}"))
    }

    /// 某个平台/渠道的最新版。没有就 None——客户端据此判「没有更新」。
    ///
    /// **按版本号比，不按时间排**：两次发布可能落在同一秒，`created_at` 分不出先后，
    /// 按时间排会给出旧的；而且版本号回退（重发旧版）时也不该把「最新」判成旧的那个。
    pub fn latest_ota_release(&self, platform: &str, channel: &str) -> Option<OtaRelease> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT * FROM ota_releases WHERE platform = ?1 AND channel = ?2",
            )
            .ok()?;
        let rows = stmt.query_map(params![platform, channel], map_ota).ok()?;
        let mut best: Option<OtaRelease> = None;
        for release in rows.filter_map(|r| r.ok()) {
            match &best {
                Some(current) if compare_versions(&release.version, &current.version) != std::cmp::Ordering::Greater => {}
                _ => best = Some(release),
            }
        }
        best
    }

    /// 精确到版本的查询。下载接口用它——客户端可能拿着旧链接。
    pub fn latest_for_exact(&self, platform: &str, channel: &str, version: &str) -> Option<OtaRelease> {
        self.lock()
            .query_row(
                "SELECT * FROM ota_releases WHERE platform = ?1 AND channel = ?2 AND version = ?3",
                params![platform, channel, version],
                map_ota,
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn list_ota_releases(&self, limit: i64) -> Vec<OtaRelease> {
        let conn = self.lock();
        let mut stmt = match conn.prepare(
            "SELECT * FROM ota_releases ORDER BY created_at DESC LIMIT ?1",
        ) {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![limit], map_ota);
        match rows {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }

    // ── audit ─────────────────────────────────────────────────────

    pub fn audit(&self, actor_id: Option<&str>, action: &str, target: &str, detail: &str, ip: Option<&str>) {
        let _ = self.lock().execute(
            "INSERT INTO audit_logs (id, actor_id, action, target, detail, ip, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                uuid::Uuid::new_v4().to_string(),
                actor_id,
                action,
                target,
                detail,
                ip,
                now_iso()
            ],
        );
    }
}

/// 一个被控端。主控端的视角：我管着谁、它现在什么状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    #[serde(rename = "claimCode")]
    pub claim_code: String,
    pub name: String,
    #[serde(rename = "publicUrl")]
    pub public_url: String,
    /// 被控端实际在用的模式。
    #[serde(rename = "admissionMode")]
    pub admission_mode: String,
    /// 主控端希望它用的模式。空串＝主控端不管这台。
    #[serde(rename = "desiredMode")]
    pub desired_mode: String,
    #[serde(rename = "licenseCount")]
    pub license_count: i64,
    #[serde(rename = "deviceCount")]
    pub device_count: i64,
    #[serde(rename = "tunnelOnline")]
    pub tunnel_online: bool,
    /// 与 last_seen_at 同行的状态快照；老节点缺失时不猜测周期。
    #[serde(rename = "reportIntervalSeconds")]
    pub report_interval_seconds: Option<u64>,
    #[serde(rename = "lastSeenAt")]
    pub last_seen_at: Option<String>,
    /// 被主控端移除的时间。有值＝已移除，但记录留着给人看。
    #[serde(rename = "revokedAt")]
    pub revoked_at: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// 被控端报到时带上来的状态快照。字段刻意只收「看一眼就知道」的聚合值，
/// 不收设备列表——主控端不需要知道谁在用某台被控端，那是那台自己的事。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NodeReport {
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "publicUrl")]
    pub public_url: String,
    #[serde(default, rename = "admissionMode")]
    pub admission_mode: String,
    #[serde(default, rename = "licenseCount")]
    pub license_count: i64,
    #[serde(default, rename = "deviceCount")]
    pub device_count: i64,
    #[serde(default, rename = "tunnelOnline")]
    pub tunnel_online: bool,
    #[serde(default)]
    pub status_json: String,
}

/// 认领码字母表：与授权码同一套易读字符，长度短一些（人要在两台机器之间抄）。
pub const CLAIM_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/// 生成认领码，形如 `NODE-XXXX-XXXX`。
pub fn generate_claim_code() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let mut out = String::from("NODE-");
    for i in 0..8 {
        if i == 4 {
            out.push('-');
        }
        out.push(CLAIM_ALPHABET[rng.gen_range(0..CLAIM_ALPHABET.len())] as char);
    }
    out
}

/// 认领码归一化：大小写、空格、各种破折号都吃掉，再统一成可读形 `NODE-XXXX-XXXX`。
///
/// **库里存的就是这个可读形**，查询时把用户输入归一化到同一形式再比——所以读写必须
/// 都过这一个函数，否则库里存 `NODE-ABCDEFGH` 而查的是 `NODE-ABCD-EFGH`，永远查不到。
///
/// 中文破折号（U+2010..U+2015）与全角连字符（U+FF0D）要一起处理——用户从聊天软件
/// 里复制出来的码经常是这些，不是 ASCII 的 `-`。
pub fn normalize_claim_code(input: &str) -> String {
    let upper: String = input.trim().to_uppercase();
    let body: String = upper
        .chars()
        .filter(|c| {
            !c.is_whitespace()
                && *c != '-'
                && *c != '\u{FF0D}'
                && !('\u{2010}'..='\u{2015}').contains(c)
        })
        .collect();
    let digits = body.strip_prefix("NODE").unwrap_or(&body);
    // 统一成 NODE-XXXX-XXXX：两位一组的可读形，与 generate_claim_code 的输出一致。
    let chars: Vec<char> = digits.chars().collect();
    if chars.len() == 8 {
        format!(
            "NODE-{}-{}",
            chars[0..4].iter().collect::<String>(),
            chars[4..8].iter().collect::<String>()
        )
    } else {
        format!("NODE-{digits}")
    }
}

fn map_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<Node> {
    let status: String = row.get("status_json")?;
    let report_interval_seconds = serde_json::from_str::<serde_json::Value>(&status).ok()
        .and_then(|value| value.get("reportIntervalSeconds").and_then(|value| value.as_u64()))
        .filter(|seconds| *seconds > 0);
    Ok(Node {
        id: row.get("id")?,
        claim_code: row.get("claim_code")?,
        name: row.get("name")?,
        public_url: row.get("public_url")?,
        admission_mode: row.get("admission_mode")?,
        desired_mode: row.get("desired_mode")?,
        license_count: row.get("license_count")?,
        device_count: row.get("device_count")?,
        tunnel_online: row.get::<_, i64>("tunnel_online")? != 0,
        report_interval_seconds,
        last_seen_at: row.get("last_seen_at")?,
        revoked_at: row.get("revoked_at")?,
        created_at: row.get("created_at")?,
    })
}

/// 一条 OTA 版本记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OtaRelease {
    pub id: String,
    pub platform: String,
    pub channel: String,
    pub version: String,
    #[serde(rename = "packagePath")]
    pub package_path: String,
    pub size: i64,
    #[serde(default)]
    pub sha256: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

fn map_ota(row: &rusqlite::Row<'_>) -> rusqlite::Result<OtaRelease> {
    Ok(OtaRelease {
        id: row.get("id")?,
        platform: row.get("platform")?,
        channel: row.get("channel")?,
        version: row.get("version")?,
        package_path: row.get("package_path")?,
        size: row.get("size")?,
        sha256: row.get("sha256")?,
        created_at: row.get("created_at")?,
    })
}

fn map_user(row: &rusqlite::Row<'_>) -> rusqlite::Result<User> {
    Ok(User {
        id: row.get("id")?,
        subject: row.get("subject")?,
        display_name: row.get("display_name")?,
        avatar_url: row.get("avatar_url")?,
        openid: row.get("openid")?,
        union_id: row.get("union_id")?,
        is_admin: row.get::<_, i64>("is_admin")? != 0,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        last_login_at: row.get("last_login_at")?,
    })
}

fn map_license(row: &rusqlite::Row<'_>) -> rusqlite::Result<License> {
    Ok(License {
        id: row.get("id")?,
        owner_id: row.get("owner_id")?,
        code: row.get("code")?,
        device_limit: row.get("device_limit")?,
        status: row.get("status")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_device(row: &rusqlite::Row<'_>) -> rusqlite::Result<Device> {
    Ok(Device {
        id: row.get("id")?,
        license_id: row.get("license_id")?,
        device_id: row.get("device_id")?,
        device_name: row.get("device_name")?,
        platform: row.get("platform")?,
        status: row.get("status")?,
        bound_at: row.get("bound_at")?,
        last_seen_at: row.get("last_seen_at")?,
    })
}

/// 比较两个 `X.Y.Z` 版本号。客户端那边是同样的 semver 比较，这里保持同一套语义。
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect()
    };
    let (left, right) = (parse(a), parse(b));
    for i in 0..3 {
        let x = left.get(i).copied().unwrap_or(0);
        let y = right.get(i).copied().unwrap_or(0);
        if x != y {
            return x.cmp(&y);
        }
    }
    std::cmp::Ordering::Equal
}

/// 只观察本机时钟，不修改时钟，也不把相对稳定误称为已经与外部时间同步。
#[derive(Default)]
struct ClockWatch {
    previous: Option<(std::time::SystemTime, std::time::Instant)>,
}

impl ClockWatch {
    fn observe(&mut self, wall: std::time::SystemTime, monotonic: std::time::Instant) -> Option<&'static str> {
        use std::time::{Duration, UNIX_EPOCH};
        let previous = self.previous.replace((wall, monotonic));
        let Some((old_wall, old_monotonic)) = previous else {
            // 2020 年以前不可能是当前部署时间；不设随日历过时的“未来年份”阈值。
            return match wall.duration_since(UNIX_EPOCH) {
                Ok(age) if age.as_secs() >= 1_577_836_800 => None,
                _ => Some("系统日期早于 2020-01-01，会话过期与时间排序可能不可靠，请检查系统时间同步。"),
            };
        };
        let elapsed = monotonic.saturating_duration_since(old_monotonic);
        let drift = match wall.duration_since(old_wall) {
            Ok(wall_elapsed) => wall_elapsed.abs_diff(elapsed),
            Err(backward) => backward.duration().saturating_add(elapsed),
        };
        if drift > Duration::from_secs(60) {
            Some("墙钟与单调计时相差超过 60 秒（时间跳变或进程休眠）；会话过期与时间排序可能受影响，请检查系统时间。")
        } else { None }
    }
}

fn checked_system_time() -> std::time::SystemTime {
    use std::sync::OnceLock;
    static WATCH: OnceLock<Mutex<ClockWatch>> = OnceLock::new();
    let mut watch = WATCH.get_or_init(|| Mutex::new(ClockWatch::default()))
        .lock().unwrap_or_else(|e| e.into_inner());
    let wall = std::time::SystemTime::now();
    if let Some(warning) = watch.observe(wall, std::time::Instant::now()) {
        crate::tunnel::log(format!("[clock] WARNING: {warning}"));
    }
    wall
}

/// 当前时间的 UTC ISO-8601 字符串。与 Node 版 `new Date().toISOString()` 同形，
/// 这样两份实现写进库里的时间可以直接字符串比较。
pub fn iso_now() -> String {
    let secs = checked_system_time().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    epoch_to_iso(secs)
}

/// 当前时间往后若干秒的 UTC ISO 字符串。会话过期与登录事务有效期都用它。
pub fn iso_after_seconds(seconds: i64) -> String {
    let now = checked_system_time().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64).unwrap_or(0);
    epoch_to_iso(now.saturating_add(seconds.max(0)) as u64)
}

/// 秒级时间戳 → `YYYY-MM-DDTHH:MM:SS.000Z`。
fn epoch_to_iso(secs: u64) -> String {
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (hour, min, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.000Z")
}

/// 从 1970-01-01 起的天数换算成公历年月日（Howard Hinnant 的算法）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_watch_reports_only_observed_anomalies() {
        use std::time::{Duration, Instant, UNIX_EPOCH};
        let wall = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let monotonic = Instant::now();
        let mut clock = ClockWatch::default();
        assert!(clock.observe(wall, monotonic).is_none());
        assert!(clock.observe(wall + Duration::from_secs(20), monotonic + Duration::from_secs(20)).is_none());
        assert!(clock.observe(wall + Duration::from_secs(21), monotonic + Duration::from_secs(200)).is_some(), "实际回拨/时基差异必须报警");
        assert!(clock.observe(wall + Duration::from_secs(22), monotonic + Duration::from_secs(201)).is_none(), "跳变后正常推进不能反复报警");
        assert!(clock.observe(wall + Duration::from_secs(400), monotonic + Duration::from_secs(202)).is_some(), "前跳必须报警");
        let mut early = ClockWatch::default();
        assert!(early.observe(UNIX_EPOCH, monotonic).is_some());
        assert!(early.observe(UNIX_EPOCH + Duration::from_secs(1), monotonic + Duration::from_secs(1)).is_none(), "启动日期告警只报一次");
        let mut backward = ClockWatch::default();
        backward.observe(wall, monotonic);
        assert!(backward.observe(wall - Duration::from_secs(120), monotonic + Duration::from_secs(1)).is_some());
    }

    #[test]
    fn node_report_period_is_read_from_the_same_snapshot_as_last_seen() {
        let store = Store::in_memory().unwrap();
        let node = store.create_node("test").unwrap();
        assert_eq!(node.report_interval_seconds, None);
        store.touch_node(&node.id, &NodeReport {
            tunnel_online: true, status_json: r#"{"reportIntervalSeconds":45}"#.to_string(), ..NodeReport::default()
        });
        let reported = store.list_nodes(10).remove(0);
        assert_eq!(reported.report_interval_seconds, Some(45));
        assert!(reported.last_seen_at.is_some());
        assert_eq!(serde_json::to_value(&reported).unwrap()["reportIntervalSeconds"], 45);
        for status in ["{}", r#"{"reportIntervalSeconds":0}"#, r#"{"reportIntervalSeconds":-2}"#, "invalid"] {
            store.touch_node(&node.id, &NodeReport { status_json: status.to_string(), ..NodeReport::default() });
            assert_eq!(store.find_node_by_id(&node.id).unwrap().report_interval_seconds, None);
        }
    }

    #[test]
    fn license_code_shape_matches_node() {
        // 形如 DSH-XXXX-XXXX-XXXX-XXXX，字母表里没有 0/O/1/I/L。
        for _ in 0..50 {
            let code = generate_license_code();
            // DSH- + 16 个字母 + 中间 3 个连字符 = 23 位
            assert_eq!(code.len(), 23, "{code}");
            assert!(code.starts_with("DSH-"));
            let body = &code[4..];
            for (i, ch) in body.chars().enumerate() {
                if i % 5 == 4 {
                    assert_eq!(ch, '-', "{code}");
                    continue;
                }
                assert!(CODE_ALPHABET.contains(&(ch as u8)), "{ch} 不在字母表里：{code}");
                assert!(!"01OIL".contains(ch), "{ch} 是刻意去掉的易混字符");
            }
        }
    }

    #[test]
    fn license_code_normalizes_like_node() {
        assert_eq!(normalize_license_code("  dsh-abcd-efgh  "), "DSH-ABCD-EFGH");
        // 中文破折号与全角连字符
        assert_eq!(normalize_license_code("DSH—ABCD—EFGH"), "DSH-ABCD-EFGH");
        assert_eq!(normalize_license_code("DSH\u{FF0D}ABCD"), "DSH-ABCD");
        // 没有前缀也补上
        assert_eq!(normalize_license_code("ABCD-EFGH"), "DSH-ABCD-EFGH");
        // 连续分隔符折叠
        assert_eq!(normalize_license_code("DSH--ABCD__EFGH"), "DSH-ABCD-EFGH");
    }

    #[test]
    fn iso_now_has_node_shape() {
        let iso = iso_now();
        assert_eq!(iso.len(), 24, "{iso}");
        assert!(iso.ends_with('Z'));
        assert_eq!(&iso[10..11], "T");
    }

    #[test]
    fn upsert_never_auto_promotes() {
        // 自动提权由调用方（控制台回调）按 bootstrap 开关 / admin 白名单决定，存储层只建号。
        // 否则任何能过 OIDC 登录的人，在新部署上抢在运营者之前登录就能无条件下拿到管理权。
        let store = Store::in_memory().unwrap();
        let first = store.upsert_user("sub-1", "甲", "", None, None);
        assert!(!first.is_admin, "建号不自动提管理员");
        store.promote_admin(&first.id);
        let promoted = store.find_user_by_id(&first.id).unwrap();
        assert!(promoted.is_admin, "显式 promote 之后才是管理员");
        let second = store.upsert_user("sub-2", "乙", "", None, None);
        assert!(!second.is_admin, "后来的用户也不会自动成为管理员");
    }

    #[test]
    fn one_license_binds_one_device_until_unbound() {
        let store = Store::in_memory().unwrap();
        let license = store.create_license(None, "").unwrap();
        store.bind_device(&license.id, "dev-a", "手机", "ios").unwrap();
        // 同一个 deviceId 再来是更新，不是第二个名额。
        store.bind_device(&license.id, "dev-a", "手机改名", "ios").unwrap();
        assert_eq!(store.count_active_devices(&license.id), 1);
        // 换一台设备会被名额挡住。
        assert!(store.bind_device(&license.id, "dev-b", "另一台", "android").is_err());
        // 解绑之后能改绑——这是「允许改绑」规则的落点。
        assert!(store.unbind_device(&license.id, "dev-a").unwrap());
        store.bind_device(&license.id, "dev-b", "另一台", "android").unwrap();
        assert_eq!(store.count_active_devices(&license.id), 1);
    }

    async fn publish_with_read_only_database_keeps_previous_release(replace_same_version: bool) {
        let store = Store::in_memory().unwrap();
        let root = std::env::temp_dir().join(format!("dsh-ota-read-only-{}", uuid::Uuid::new_v4()));
        let mut config = crate::console::config::ConsoleConfig::from_env();
        config.ota_root = root.to_string_lossy().into();
        config.ota_control_token = "tok".into();
        let headers = vec![("authorization".into(), "Bearer tok".into())];
        let original = vec![0x1f, 0x8b, 7, 8, 9];
        let published = crate::console::ota::handle_publish(
            &store, &config, "platform=darwin&version=1.0.0", &headers, original.clone(),
        ).await;
        assert_eq!(published.status, 200);
        let previous = store.latest_for_exact("darwin", "stable", "1.0.0").unwrap();
        let previous_json = serde_json::to_value(&previous).unwrap();
        // 使用真实 SQLite 只读写入错误，包目录仍然可写。
        store.lock().execute_batch("PRAGMA query_only = ON").unwrap();
        let version = if replace_same_version { "1.0.0" } else { "1.0.1" };
        let failed = crate::console::ota::handle_publish(
            &store, &config, &format!("platform=darwin&version={version}"), &headers, vec![0x1f, 0x8b, 1, 2],
        ).await;
        assert_eq!(failed.status, 500, "数据库写失败不能报告发布成功");
        let error: serde_json::Value = serde_json::from_slice(&failed.body).unwrap();
        assert_eq!(error["ok"], false);
        let retained = store.latest_ota_release("darwin", "stable").unwrap();
        assert_eq!(serde_json::to_value(&retained).unwrap(), previous_json, "旧索引全部元数据必须保留");
        assert_eq!(std::fs::read(&previous.package_path).unwrap(), original);
        if !replace_same_version {
            assert!(store.latest_for_exact("darwin", "stable", version).is_none());
        }
        let mut download = crate::console::ota::handle_download(&store, "darwin/stable/1.0.0").await.ok().unwrap();
        assert_eq!(download.sha256, previous.sha256);
        let (next, bytes) = download.read_chunk().await.unwrap();
        download = next;
        assert_eq!(bytes, original, "发布失败后旧版本仍能按原摘要下载");
        drop(download);
        let files: Vec<_> = std::fs::read_dir(root.join("darwin/stable")).unwrap().collect();
        assert_eq!(files.len(), 1, "失败候选包必须清理");
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn new_ota_release_database_failure_keeps_existing_latest_and_cleans_candidate() {
        publish_with_read_only_database_keeps_previous_release(false).await;
    }

    #[tokio::test]
    async fn same_version_ota_database_failure_keeps_original_package_and_metadata() {
        publish_with_read_only_database_keeps_previous_release(true).await;
    }

    #[test]
    fn oidc_identifiers_keep_existing_user_and_admin_across_field_changes() {
        let store = Store::in_memory().unwrap();
        let first = store.upsert_user("openid:wx-a", "旧名字", "", Some("wx-a"), None);
        store.promote_admin(&first.id);
        let enriched = store.upsert_oidc_user(Some("subject-a"), Some("wx-a"), Some("union-a"), "新名字", "avatar").unwrap();
        assert_eq!(enriched.id, first.id);
        assert!(enriched.is_admin);
        assert_eq!(enriched.subject, "openid:wx-a", "旧 subject 不漂移");
        let only_sub = store.upsert_oidc_user(Some("subject-a"), None, None, "再次登录", "").unwrap();
        assert_eq!(only_sub.id, first.id);
        let only_union = store.upsert_oidc_user(None, None, Some("union-a"), "", "").unwrap();
        assert_eq!(only_union.id, first.id);
        assert_eq!(store.user_count(), 1);
    }

    #[test]
    fn oidc_never_merges_conflicting_or_cross_type_identities() {
        let store = Store::in_memory().unwrap();
        let a = store.upsert_oidc_user(Some("same"), Some("openid-a"), None, "同名", "").unwrap();
        let b = store.upsert_oidc_user(None, Some("same"), None, "同名", "").unwrap();
        assert_ne!(a.id, b.id, "同字串不同标识类型不是同一人");
        assert!(store.upsert_oidc_user(Some("same"), Some("same"), None, "同名", "").is_err());
        assert!(store.upsert_oidc_user(Some("changed-sub"), Some("openid-a"), None, "同名", "").is_err());
        assert_eq!(store.user_count(), 2);
        assert_eq!(store.find_user_by_id(&a.id).unwrap().openid.as_deref(), Some("openid-a"));
        assert!(store.upsert_oidc_user(None, None, None, "同名", "").is_err());
    }

    #[test]
    fn old_identity_and_login_tables_gain_columns_without_losing_rows() {
        let path = std::env::temp_dir().join(format!("dsh-store-login-{}.db", uuid::Uuid::new_v4()));
        {
            let conn = Connection::open(&path).unwrap();
            let legacy = SCHEMA.replace("  oidc_sub      TEXT,\n", "")
                .replace("  attempts_left INTEGER NOT NULL DEFAULT 3,\n", "");
            conn.execute_batch(&legacy).unwrap();
            conn.execute("INSERT INTO users (id,subject,is_admin,created_at,updated_at) VALUES ('old-admin','openid:old',1,'2026-01-01','2026-01-01')", []).unwrap();
            conn.execute("INSERT INTO login_states (state,nonce,code_verifier,redirect_uri,created_at,expires_at) VALUES ('old-state','n','v','','2026-01-01','2999-01-01T00:00:00.000Z')", []).unwrap();
        }
        let store = Store::open(&path).unwrap();
        let user = store.upsert_oidc_user(Some("new-sub"), Some("old"), None, "", "").unwrap();
        assert_eq!(user.id, "old-admin");
        assert!(user.is_admin);
        for _ in 0..3 { assert!(store.take_login_state("old-state").is_some()); }
        assert!(store.take_login_state("old-state").is_none());
        drop(store);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn login_state_attempt_budget_is_atomic_and_ttl_is_used() {
        let store = Store::in_memory().unwrap();
        store.save_login_state("limited", "nonce", "verifier", "/", 1800);
        let (created, expires): (String, String) = store.lock().query_row(
            "SELECT created_at, expires_at FROM login_states WHERE state = 'limited'", [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert!(expires > created);
        assert!(expires >= iso_after_seconds(1798), "有效期必须使用传入值");
        let gate = std::sync::Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8).map(|_| {
            let (store, gate) = (store.clone(), gate.clone());
            std::thread::spawn(move || { gate.wait(); store.take_login_state("limited").is_some() })
        }).collect();
        let allowed = threads.into_iter().map(|t| t.join().unwrap() as usize).sum::<usize>();
        assert_eq!(allowed, 3, "并发也只能占用三次外呼额度");
        assert!(store.take_login_state("limited").is_none());
        store.save_login_state("zero-ttl", "n", "v", "/", 0);
        assert!(store.take_login_state("zero-ttl").is_none());
    }

    #[test]
    fn concurrent_binding_cannot_exceed_device_limit() {
        let store = Store::in_memory().unwrap();
        let license = store.create_license(None, "").unwrap();
        let gate = std::sync::Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8).map(|i| {
            let (store, gate, license) = (store.clone(), gate.clone(), license.id.clone());
            std::thread::spawn(move || { gate.wait(); store.bind_device(&license, &format!("device-{i}"), "", "ios").is_ok() })
        }).collect();
        let accepted = threads.into_iter().map(|t| t.join().unwrap() as usize).sum::<usize>();
        assert_eq!(accepted, 1);
        assert_eq!(store.count_active_devices(&license.id), 1);
    }

    #[test]
    fn audit_records_given_source_ip_and_background_can_omit_it() {
        let store = Store::in_memory().unwrap();
        store.audit(Some("admin"), "license.create", "code", "", Some("203.0.113.8"));
        store.audit(None, "settings.admission_mode", "open", "master", None);
        let conn = store.lock();
        let ip: String = conn.query_row("SELECT ip FROM audit_logs WHERE actor_id = 'admin'", [], |row| row.get(0)).unwrap();
        assert_eq!(ip, "203.0.113.8");
        let ip: Option<String> = conn.query_row("SELECT ip FROM audit_logs WHERE actor_id IS NULL", [], |row| row.get(0)).unwrap();
        assert_eq!(ip, None);
    }

    #[test]
    fn login_state_survives_until_explicitly_finished() {
        // 线上真故障的回归：回调被上游重发时，第一次失败不能把 state 弄丢，
        // 否则重试只会拿到「登录状态无效」。
        let store = Store::in_memory().unwrap();
        store.save_login_state("state-1", "nonce-1", "verifier-1", "/", 600);

        // 第一次：取得到
        let first = store.take_login_state("state-1");
        assert_eq!(
            first,
            Some(("verifier-1".to_string(), "/".to_string())),
            "第一次必须取得到"
        );
        // 模拟「换 token 失败」：什么都没删
        let retry = store.take_login_state("state-1");
        assert_eq!(
            retry,
            Some(("verifier-1".to_string(), "/".to_string())),
            "失败之后重试必须还能取到——这条是防上游重发导致永远登不进去"
        );

        // 成功落地之后才删，迟到的重试拿不到
        store.finish_login_state("state-1");
        assert_eq!(store.take_login_state("state-1"), None);
    }

    #[test]
    fn expired_login_state_is_rejected() {
        let store = Store::in_memory().unwrap();
        store.save_login_state("state-old", "nonce", "verifier", "/", 600);
        // 手动把过期时间拨到过去
        let conn = store.lock();
        let _ = conn.execute(
            "UPDATE login_states SET expires_at = '1970-01-01T00:00:00.000Z' WHERE state = 'state-old'",
            [],
        );
        drop(conn);
        assert_eq!(store.take_login_state("state-old"), None, "过期了就该拒");
    }

    #[test]
    fn session_round_trips_and_expires() {
        let store = Store::in_memory().unwrap();
        let user = store.upsert_user("sub-1", "甲", "", None, None);
        store.create_session(&user.id, "hash-1", "2999-01-01T00:00:00.000Z");
        assert_eq!(store.session_user("hash-1").map(|u| u.id), Some(user.id.clone()));
        // 过期的查不到。
        store.create_session(&user.id, "hash-expired", "1970-01-01T00:00:00.000Z");
        assert!(store.session_user("hash-expired").is_none());
    }

    /// 过期数据每天清一次。不清也不会读出错（查询自带过期判定），
    /// 但行数只涨不落；`login_states` 更是没人登出就一直在。
    #[test]
    fn purge_expired_removes_only_expired() {
        let store = Store::in_memory().unwrap();
        let user = store.upsert_user("sub-1", "甲", "", None, None);
        store.create_session(&user.id, "hash-old", "1970-01-01T00:00:00.000Z");
        store.create_session(&user.id, "hash-new", "2999-01-01T00:00:00.000Z");
        store.save_login_state("st-old", "nonce", "verifier", "/", 600);
        store.save_login_state("st-new", "nonce", "verifier", "/", 600);

        // 手工把一条说过期：save_login_state 自己算的是未来时间。
        {
            let conn = store.lock();
            conn.execute(
                "UPDATE login_states SET expires_at = '1970-01-01T00:00:00.000Z' WHERE state = 'st-old'",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE login_states SET expires_at = '2999-01-01T00:00:00.000Z' WHERE state = 'st-new'",
                [],
            )
            .unwrap();
        }

        let (sessions, states) = store.purge_expired();
        assert_eq!(sessions, 1, "只清过期的会话");
        assert_eq!(states, 1, "只清过期的登录事务");
        assert!(store.session_user("hash-new").is_some(), "没过期的会话必须还在");
        assert!(store.take_login_state("st-new").is_some(), "没过期的事务必须还在");
    }

    /// 老库里的 `nodes` 表没有 `desired_mode` 这一列。打开时必须自动补上，
    /// 否则新代码一查就 `no such column`，整个面板的「被控端」区块垮掉。
    #[test]
    fn old_nodes_table_gains_desired_mode_on_open() {
        let dir = std::env::temp_dir().join(format!("dsh-store-migrate-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("old.db");
        let _ = std::fs::remove_file(&path);

        {
            let conn = Connection::open(&path).unwrap();
            // 2026-10-17 之前那份建表语句：没有 desired_mode。
            conn.execute_batch(
                "CREATE TABLE nodes (
                   id TEXT PRIMARY KEY, claim_code TEXT NOT NULL UNIQUE,
                   name TEXT NOT NULL DEFAULT '', public_url TEXT NOT NULL DEFAULT '',
                   status_json TEXT NOT NULL DEFAULT '',
                   admission_mode TEXT NOT NULL DEFAULT 'open',
                   license_count INTEGER NOT NULL DEFAULT 0,
                   device_count INTEGER NOT NULL DEFAULT 0,
                   tunnel_online INTEGER NOT NULL DEFAULT 0,
                   last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                 INSERT INTO nodes (id, claim_code, name, created_at, updated_at)
                 VALUES ('n-old', 'NODE-OLD-COLR', '老机器', '2026-01-01', '2026-01-01');",
            )
            .unwrap();
        }

        let store = Store::open(&path).expect("老库必须能打开");
        let node = store.find_node_by_id("n-old").expect("老行还在");
        assert_eq!(node.desired_mode, "", "补上的列默认是空串＝主控端本来就不管它");
        assert!(store.set_desired_mode("n-old", Some("restricted")).unwrap());
        assert_eq!(store.desired_mode_of("n-old"), "restricted");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
