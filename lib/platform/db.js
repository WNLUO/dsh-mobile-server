'use strict';

/**
 * 平台数据库（SQLite，走 node:sqlite 内置模块，零新增依赖）。
 *
 * 为什么是 SQLite：用户明确说「当前数据库我忘记是 SQLite 还是 MySQL 了，目前用
 * 什么我们就先用什么，后续肯定需要改成 MySQL」。平台是新立的项目，中转本体
 * 完全没有数据库，所以这里选 SQLite——单文件、可备份、node 内置。
 *
 * 迁移到 MySQL 时的改动面被刻意收窄到本文件 + store.js：
 *   - 所有 SQL 都写在这两个文件里，且只用最基础的类型（TEXT/INTEGER）；
 *   - 时间统一存 UTC 的 ISO-8601 字符串（`2026-10-07T10:00:00.000Z`），
 *     MySQL 侧对应 DATETIME(3) / VARCHAR(32)，字符串比较即时间比较；
 *   - 金额一律存「分」的整数，绝不存浮点。
 *
 * node:sqlite 在 node 22.5+ 才有；本项目 engines 写的是 >= 20，所以这里在加载
 * 失败时给出可诊断的报错，而不是让 require 抛一个 MODULE_NOT_FOUND。
 */

const fs = require('node:fs');
const path = require('node:path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  throw new Error(
    `平台数据库需要 node:sqlite（node >= 22.5，当前 ${process.version}）：${error.message}`,
  );
}

const SCHEMA = `
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

-- OIDC 授权事务（state / PKCE verifier / nonce）。用完即删。
CREATE TABLE IF NOT EXISTS login_states (
  state         TEXT PRIMARY KEY,
  nonce         TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL,
  next_path     TEXT NOT NULL DEFAULT '/',
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  out_trade_no   TEXT NOT NULL UNIQUE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_count   INTEGER NOT NULL,
  months         INTEGER NOT NULL,
  unit_cents     INTEGER NOT NULL,
  amount_cents   INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'created',
  pay_trade_no   TEXT,
  pay_url        TEXT,
  transaction_id TEXT,
  license_id     TEXT,
  paid_at        TEXT,
  closed_at      TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_pay_trade ON orders(pay_trade_no);

-- 授权码：用户付款后生成，一台设备占一个名额。
CREATE TABLE IF NOT EXISTS licenses (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id     TEXT,
  code         TEXT NOT NULL UNIQUE,
  device_limit INTEGER NOT NULL,
  months       INTEGER NOT NULL,
  starts_at    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licenses_user ON licenses(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  license_id  TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  platform    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  bound_at    TEXT NOT NULL,
  last_seen_at TEXT,
  UNIQUE (license_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_devices_license ON devices(license_id);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- Pay v2 通知的原始记录，event_id 唯一 → 天然幂等。
CREATE TABLE IF NOT EXISTS payment_events (
  id           TEXT PRIMARY KEY,
  event_id     TEXT UNIQUE,
  event_type   TEXT,
  trade_no     TEXT,
  out_trade_no TEXT,
  amount_cents INTEGER,
  order_id     TEXT,
  applied      INTEGER NOT NULL DEFAULT 0,
  payload      TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

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
`;

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

/** 把一次操作包进事务；抛错自动回滚。 */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch { /* 回滚失败时保留原始错误 */ }
    throw error;
  }
}

module.exports = { openDatabase, transaction, SCHEMA };
