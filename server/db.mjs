/**
 * db.mjs — SQLite schema + 时区工具。
 *
 * 设计要点（对应考核 A1–A7）：
 *  - 唯一性用「索引」保证，而不是靠代码小心：
 *      ux_cert_once      → A2/A4 每学员每课至多一张证书
 *      ux_audit_issued   → A2 每次实际签发恰好一条审计
 *      ux_audit_revoked  → A7 重复吊销不产生重复审计
 *      PK(tenant,key)    → A2 并发去重锚点
 *  - 本地时间在写入时落库（issued_local_date / issued_local_display），
 *    排序与 CSV 直接用列，既满足 A5 又能吃到索引（A6）。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  code         TEXT NOT NULL UNIQUE,
  timezone     TEXT NOT NULL,
  next_serial  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS admins (
  email        TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  title     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learners (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name      TEXT NOT NULL,
  email     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollments (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  course_id  TEXT NOT NULL REFERENCES courses(id),
  learner_id TEXT NOT NULL REFERENCES learners(id),
  status     TEXT NOT NULL CHECK (status IN ('completed','incomplete')),
  UNIQUE (tenant_id, course_id, learner_id)
);

CREATE TABLE IF NOT EXISTS certificates (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  course_id            TEXT NOT NULL REFERENCES courses(id),
  learner_id           TEXT NOT NULL REFERENCES learners(id),
  enrollment_id        TEXT NOT NULL REFERENCES enrollments(id),
  serial_no            TEXT NOT NULL,
  issued_at_utc        TEXT NOT NULL,
  issued_local_date    TEXT NOT NULL,
  issued_local_display TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  revoked_at_utc       TEXT,
  revoked_by           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cert_serial ON certificates(tenant_id, serial_no);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cert_once   ON certificates(tenant_id, course_id, learner_id);
CREATE INDEX IF NOT EXISTS ix_cert_date  ON certificates(tenant_id, issued_local_date, id);
CREATE INDEX IF NOT EXISTS ix_cert_status ON certificates(tenant_id, status);

CREATE TABLE IF NOT EXISTS audit_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL,
  certificate_id TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('ISSUED','REVOKED')),
  actor_email    TEXT NOT NULL,
  at_utc         TEXT NOT NULL,
  metadata_json  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_issued  ON audit_events(certificate_id) WHERE action = 'ISSUED';
CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_revoked ON audit_events(certificate_id) WHERE action = 'REVOKED';
CREATE INDEX IF NOT EXISTS ix_audit_cert ON audit_events(tenant_id, certificate_id);

CREATE TABLE IF NOT EXISTS idempotency_operations (
  tenant_id     TEXT NOT NULL,
  idem_key      TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  course_id     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  claim_id      TEXT,
  http_status   INTEGER,
  response_json TEXT,
  created_at    TEXT NOT NULL,
  completed_at  TEXT,
  PRIMARY KEY (tenant_id, idem_key)
);
`;

/** 轻量迁移：CREATE TABLE IF NOT EXISTS 不会给已存在的表补列。 */
function ensureColumn(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/** 打开（必要时创建）数据库并保证 schema 到位。 */
export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  ensureColumn(db, 'idempotency_operations', 'claim_id', 'TEXT');
  return db;
}

const FMT = new Map();

/**
 * 租户本地时间：'YYYY-MM-DD HH:mm'
 * 用 sv-SE locale 直接得到 ISO 风格输出，与 A5 期望格式逐字一致。
 * East/Sydney('2026-01-10T13:30:00Z') => '2026-01-11 00:30'  (AEDT +11)
 * West/Perth ('2026-01-10T13:30:00Z') => '2026-01-10 21:30'  (AWST +8)
 */
export function localDisplay(utcIso, timezone) {
  let fmt = FMT.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    FMT.set(timezone, fmt);
  }
  return fmt.format(new Date(utcIso)); // 'YYYY-MM-DD HH:mm'
}

/** 租户本地日历日：'YYYY-MM-DD'（A5 排序 / A6 CSV 用） */
export const localDate = (utcIso, tz) => localDisplay(utcIso, tz).slice(0, 10);

export const nowUtcIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** 事务helper：同步回调，异常回滚。 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}
