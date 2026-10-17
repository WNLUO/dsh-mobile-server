//! 控制台的数据层：SQLite 建表与查询。
//!
//! 从 Node 运营版（`server/dsh-mobile-hub/lib/platform/`）译过来，**表结构与授权码规则
//! 原样保留**——那些已经过验证，改结构只会制造迁移问题。
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
/// 判据是「查一下这一列在不在」，不是版本号：只有一个列要补，不值得为它引入迁移框架。
fn ensure_columns(conn: &Connection) {
    for (probe, ddl) in [
        (
            "SELECT desired_mode FROM nodes LIMIT 1",
            "ALTER TABLE nodes ADD COLUMN desired_mode TEXT NOT NULL DEFAULT ''",
        ),
        (
            "SELECT revoked_at FROM nodes LIMIT 1",
            "ALTER TABLE nodes ADD COLUMN revoked_at TEXT",
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

    pub fn set_setting(&self, key: &str, value: &str) {
        let ts = now_iso();
        let _ = self.lock().execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, ts],
        );
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
    /// **第一个登录的人是管理员**：这是运营版定下的规则（冷启动首个用户即管理员），
    /// 沿用不重新发明——中转搭起来之后，搭的人第一个登录就拿到了管理权。
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
        let is_first = self.user_count() == 0;
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
                if is_first { 1 } else { 0 },
                ts
            ],
        );
        self.find_user_by_id(&id).expect("刚插入的用户读不回来")
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
    pub fn save_login_state(&self, state: &str, nonce: &str, verifier: &str, next_path: &str) {
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
                iso_after_seconds(600)
            ],
        );
    }

    /// 取出一次登录事务。返回 (code_verifier, next_path)。
    ///
    /// **查到不删**（2026-10-17 改）。原来这里是「查到即删」的一次性消费，结果线上
    /// 出过一次真故障：回调请求被上游重发了一次（第一次 502、第二次才到），第一次
    /// 已经把 state 删了，于是重试报「登录状态无效」——用户永远登不进去。
    ///
    /// 现在只在**换 token 成功之后**删（见 `finish_login_state`）。失败时 state 留着，
    /// 重试还能接着用；反正 `expires_at` 到了自己就作废，过期行由 `save_login_state`
    /// 顺手清掉。防重放靠的是有效期，不是「删得早」。
    pub fn take_login_state(&self, state: &str) -> Option<(String, String)> {
        let conn = self.lock();
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT code_verifier, next_path, expires_at FROM login_states WHERE state = ?1",
                params![state],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .ok()
            .flatten();
        let (verifier, next_path, expires_at) = row?;
        if expires_at < now_iso() {
            return None;
        }
        Some((verifier, next_path))
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
    pub fn create_license(&self, owner_id: Option<&str>, note: &str) -> License {
        let ts = now_iso();
        let mut code = generate_license_code();
        for _ in 0..5 {
            if self.find_license_by_code(&code).is_none() {
                break;
            }
            code = generate_license_code();
        }
        let id = uuid::Uuid::new_v4().to_string();
        let _ = self.lock().execute(
            "INSERT INTO licenses (id, owner_id, code, device_limit, status, note, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, 'active', ?4, ?5, ?5)",
            params![id, owner_id, code, note, ts],
        );
        self.find_license_by_id(&id).expect("刚插入的激活码读不回来")
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

    pub fn set_license_status(&self, id: &str, status: &str) {
        let _ = self.lock().execute(
            "UPDATE licenses SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now_iso(), id],
        );
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
        if let Some(existing) = self.find_device(license_id, device_id) {
            let _ = self.lock().execute(
                "UPDATE devices SET device_name = ?1, platform = ?2, status = 'active', last_seen_at = ?3
                 WHERE id = ?4",
                params![
                    if device_name.is_empty() { existing.device_name.clone() } else { device_name.to_string() },
                    if platform.is_empty() { existing.platform.clone() } else { platform.to_string() },
                    ts,
                    existing.id
                ],
            );
            return self
                .find_device(license_id, device_id)
                .ok_or_else(|| "设备更新后读不回来".to_string());
        }
        let limit = self
            .find_license_by_id(license_id)
            .map(|l| l.device_limit)
            .unwrap_or(1);
        if self.count_active_devices(license_id) >= limit {
            return Err("device limit reached".to_string());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let _ = self.lock().execute(
            "INSERT INTO devices (id, license_id, device_id, device_name, platform, status, bound_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)",
            params![id, license_id, device_id, device_name, platform, ts],
        );
        self.find_device(license_id, device_id)
            .ok_or_else(|| "设备插入后读不回来".to_string())
    }

    pub fn touch_device(&self, license_id: &str, device_id: &str) {
        let _ = self.lock().execute(
            "UPDATE devices SET last_seen_at = ?1 WHERE license_id = ?2 AND device_id = ?3",
            params![now_iso(), license_id, device_id],
        );
    }

    /// 解绑：删掉这条设备记录，名额放回去。**允许改绑**就是靠它。
    pub fn unbind_device(&self, license_id: &str, device_id: &str) -> bool {
        self.lock()
            .execute(
                "DELETE FROM devices WHERE license_id = ?1 AND device_id = ?2",
                params![license_id, device_id],
            )
            .map(|n| n > 0)
            .unwrap_or(false)
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
    pub fn create_node(&self, name: &str) -> Node {
        // 认领码在全表唯一，**包括已移除的行**——所以查重要连它们一起看。
        // 只查 `find_node_by_claim`（会跳过已移除的）的话，撞上一条已移除的码会
        // 直接违反唯一约束、INSERT 静默失败，表现是「生成了认领码但列表里没有」。
        let taken = |code: &str| -> bool {
            self.find_node_by_claim(code).is_some()
                || self.find_revoked_node_by_claim(code).is_some()
        };
        let id = uuid::Uuid::new_v4().to_string();
        let ts = now_iso();
        for _ in 0..5 {
            let code = generate_claim_code();
            if taken(&code) {
                continue;
            }
            let normalized = normalize_claim_code(&code);
            if self
                .lock()
                .execute(
                    "INSERT INTO nodes (id, claim_code, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![id, normalized, name, ts],
                )
                .is_ok()
            {
                return self.find_node_by_id(&id).expect("刚插入的被控端读不回来");
            }
        }
        // 五次都没插进去（理论上不可能：码空间 32^8）。退一步把已移除的行清掉再试，
        // 宁可丢掉一条历史，也不要让「生成认领码」这个动作失效。
        self.lock()
            .execute("DELETE FROM nodes WHERE revoked_at IS NOT NULL", [])
            .ok();
        let code = normalize_claim_code(&generate_claim_code());
        let _ = self.lock().execute(
            "INSERT INTO nodes (id, claim_code, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, code, name, ts],
        );
        self.find_node_by_id(&id).expect("刚插入的被控端读不回来")
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
    pub fn set_desired_mode(&self, id: &str, mode: Option<&str>) -> bool {
        self.lock()
            .execute(
                "UPDATE nodes SET desired_mode = ?1, updated_at = ?2 WHERE id = ?3",
                params![mode.unwrap_or(""), now_iso(), id],
            )
            .map(|n| n > 0)
            .unwrap_or(false)
    }

    /// 让一个认领码失效。被控端之后再报到会被拒。
    ///
    /// **只打时间戳、不删行**。删了之后主控端自己也看不出这台曾经存在过，被控端那边
    /// 收到的又只是 404，和「认领码填错了」长得一模一样——而这两件事该做的处置完全不同
    /// （重新生成认领码 vs 去核对地址）。留一行就能把话说清楚。
    pub fn revoke_node(&self, id: &str) {
        let _ = self.lock().execute(
            "UPDATE nodes SET revoked_at = ?1, updated_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
            params![now_iso(), id],
        );
    }

    /// 把一条已移除的记录彻底删掉（面板上的「彻底删除」，只收拾残局用）。
    pub fn forget_node(&self, id: &str) {
        let _ = self.lock().execute("DELETE FROM nodes WHERE id = ?1", params![id]);
    }

    // ── ota_releases（插件 OTA 临时通道）──────────────────────────
    //
    // 只服务一件事：客户端按 `latest?platform=&channel=` 问「我该装哪个版本」，然后
    // 按返回的下载地址拿包。**不做增量、不做多插件矩阵**——那套归 npm 市场，
    // 这里是救急用的临时通道，够用就停。
    //
    // 包文件落在 `PLATFORM_OTA_ROOT` 下按 `<platform>/<channel>/<version>.tar.gz` 存，
    // 库里只记路径与大小。

    /// 登记一个包，并让它成为该平台/渠道的最新版。
    pub fn put_ota_release(
        &self,
        platform: &str,
        channel: &str,
        version: &str,
        package_path: &str,
        size: i64,
    ) {
        let _ = self.lock().execute(
            "INSERT INTO ota_releases (id, platform, channel, version, package_path, size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(platform, channel, version) DO UPDATE SET
               package_path = excluded.package_path, size = excluded.size, created_at = excluded.created_at",
            params![
                uuid::Uuid::new_v4().to_string(),
                platform,
                channel,
                version,
                package_path,
                size,
                now_iso()
            ],
        );
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

    pub fn audit(&self, actor_id: Option<&str>, action: &str, target: &str, detail: &str) {
        let _ = self.lock().execute(
            "INSERT INTO audit_logs (id, actor_id, action, target, detail, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                uuid::Uuid::new_v4().to_string(),
                actor_id,
                action,
                target,
                detail,
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

/// 当前时间的 UTC ISO-8601 字符串。与 Node 版 `new Date().toISOString()` 同形，
/// 这样两份实现写进库里的时间可以直接字符串比较。
pub fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    epoch_to_iso(secs)
}

/// 当前时间往后若干秒的 UTC ISO 字符串。会话过期与登录事务有效期都用它。
pub fn iso_after_seconds(seconds: i64) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    epoch_to_iso((now + seconds.max(0)) as u64)
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
    fn first_user_becomes_admin() {
        let store = Store::in_memory().unwrap();
        let first = store.upsert_user("sub-1", "甲", "", None, None);
        assert!(first.is_admin, "第一个登录的用户必须是管理员");
        let second = store.upsert_user("sub-2", "乙", "", None, None);
        assert!(!second.is_admin, "后来的用户不该自动成为管理员");
    }

    #[test]
    fn one_license_binds_one_device_until_unbound() {
        let store = Store::in_memory().unwrap();
        let license = store.create_license(None, "");
        store.bind_device(&license.id, "dev-a", "手机", "ios").unwrap();
        // 同一个 deviceId 再来是更新，不是第二个名额。
        store.bind_device(&license.id, "dev-a", "手机改名", "ios").unwrap();
        assert_eq!(store.count_active_devices(&license.id), 1);
        // 换一台设备会被名额挡住。
        assert!(store.bind_device(&license.id, "dev-b", "另一台", "android").is_err());
        // 解绑之后能改绑——这是「允许改绑」规则的落点。
        assert!(store.unbind_device(&license.id, "dev-a"));
        store.bind_device(&license.id, "dev-b", "另一台", "android").unwrap();
        assert_eq!(store.count_active_devices(&license.id), 1);
    }

    #[test]
    fn login_state_survives_until_explicitly_finished() {
        // 线上真故障的回归：回调被上游重发时，第一次失败不能把 state 弄丢，
        // 否则重试只会拿到「登录状态无效」。
        let store = Store::in_memory().unwrap();
        store.save_login_state("state-1", "nonce-1", "verifier-1", "/");

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
        store.save_login_state("state-old", "nonce", "verifier", "/");
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
        store.save_login_state("st-old", "nonce", "verifier", "/");
        store.save_login_state("st-new", "nonce", "verifier", "/");

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
        assert!(store.set_desired_mode("n-old", Some("restricted")));
        assert_eq!(store.desired_mode_of("n-old"), "restricted");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
