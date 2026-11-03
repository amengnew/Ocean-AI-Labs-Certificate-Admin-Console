/**
 * seed.mjs — 演示数据（考核 §4 "Required demo data"）。
 *
 *  - Tenant East (Australia/Sydney) / West (Australia/Perth)
 *  - 每租户一个 admin：alice@east.test / bob@west.test
 *  - 两租户都有课程 "Safety 101" 和学员 "Alex Lee"
 *  - 覆盖 completed / incomplete / already-certified 三种 enrollment
 *  - 预置两张 UTC 同为 2026-01-10T13:30:00Z 的证书（A5 时区对照）
 *
 * 幂等：已存在 tenant 则不动，除非 --reset。
 */
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { openDb, localDisplay, localDate, tx } from './db.mjs';

const A5_UTC = '2026-01-10T13:30:00Z';

const TENANTS = [
  { id: 'tenant-east', name: 'East', code: 'EAST', timezone: 'Australia/Sydney' },
  { id: 'tenant-west', name: 'West', code: 'WEST', timezone: 'Australia/Perth' },
];

const ADMINS = [
  { email: 'alice@east.test', tenant_id: 'tenant-east', display_name: 'Alice (East)' },
  { email: 'bob@west.test', tenant_id: 'tenant-west', display_name: 'Bob (West)' },
];

const COURSES = [
  { id: 'course-east-safety', tenant_id: 'tenant-east', title: 'Safety 101' },
  { id: 'course-east-privacy', tenant_id: 'tenant-east', title: 'Data Privacy' },
  { id: 'course-west-safety', tenant_id: 'tenant-west', title: 'Safety 101' },
  { id: 'course-west-privacy', tenant_id: 'tenant-west', title: 'Data Privacy' },
];

const LEARNERS = [
  { id: 'learner-east-alex', tenant_id: 'tenant-east', name: 'Alex Lee', email: 'alex@east.test' },
  { id: 'learner-east-priya', tenant_id: 'tenant-east', name: 'Priya Nair', email: 'priya@east.test' },
  { id: 'learner-east-tom', tenant_id: 'tenant-east', name: 'Tom Silva', email: 'tom@east.test' },
  { id: 'learner-west-alex', tenant_id: 'tenant-west', name: 'Alex Lee', email: 'alex@west.test' },
  { id: 'learner-west-omar', tenant_id: 'tenant-west', name: 'Omar Haddad', email: 'omar@west.test' },
  { id: 'learner-west-mei', tenant_id: 'tenant-west', name: 'Mei Chen', email: 'mei@west.test' },
];

// Safety 101 East：Alex 可发 / Priya 已持证(跳过) / Tom 未完成(跳过) → 一次 bulk 覆盖 A4 三种结果
const ENROLLMENTS = [
  { id: 'enr-e-safety-alex', tenant_id: 'tenant-east', course_id: 'course-east-safety', learner_id: 'learner-east-alex', status: 'completed' },
  { id: 'enr-e-safety-priya', tenant_id: 'tenant-east', course_id: 'course-east-safety', learner_id: 'learner-east-priya', status: 'completed' },
  { id: 'enr-e-safety-tom', tenant_id: 'tenant-east', course_id: 'course-east-safety', learner_id: 'learner-east-tom', status: 'incomplete' },
  { id: 'enr-e-privacy-tom', tenant_id: 'tenant-east', course_id: 'course-east-privacy', learner_id: 'learner-east-tom', status: 'completed' },
  { id: 'enr-w-safety-alex', tenant_id: 'tenant-west', course_id: 'course-west-safety', learner_id: 'learner-west-alex', status: 'completed' },
  { id: 'enr-w-safety-omar', tenant_id: 'tenant-west', course_id: 'course-west-safety', learner_id: 'learner-west-omar', status: 'completed' },
  { id: 'enr-w-safety-mei', tenant_id: 'tenant-west', course_id: 'course-west-safety', learner_id: 'learner-west-mei', status: 'incomplete' },
];

export function seedDatabase(db) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n;
  if (existing > 0) return { seeded: false, reason: 'already-seeded' };

  const tzOf = Object.fromEntries(TENANTS.map((t) => [t.id, t.timezone]));

  tx(db, () => {
    const insTenant = db.prepare('INSERT INTO tenants (id,name,code,timezone,next_serial) VALUES (?,?,?,?,?)');
    for (const t of TENANTS) insTenant.run(t.id, t.name, t.code, t.timezone, 2); // 预置 1 张，serial 从 000002 起

    const insAdmin = db.prepare('INSERT INTO admins (email,tenant_id,display_name) VALUES (?,?,?)');
    for (const a of ADMINS) insAdmin.run(a.email, a.tenant_id, a.display_name);

    const insCourse = db.prepare('INSERT INTO courses (id,tenant_id,title) VALUES (?,?,?)');
    for (const c of COURSES) insCourse.run(c.id, c.tenant_id, c.title);

    const insLearner = db.prepare('INSERT INTO learners (id,tenant_id,name,email) VALUES (?,?,?,?)');
    for (const l of LEARNERS) insLearner.run(l.id, l.tenant_id, l.name, l.email);

    const insEnr = db.prepare('INSERT INTO enrollments (id,tenant_id,course_id,learner_id,status) VALUES (?,?,?,?,?)');
    for (const e of ENROLLMENTS) insEnr.run(e.id, e.tenant_id, e.course_id, e.learner_id, e.status);

    // A5 对照证书：两租户，同一 UTC 时间戳，本地显示不同
    const insCert = db.prepare(`INSERT INTO certificates
      (id,tenant_id,course_id,learner_id,enrollment_id,serial_no,issued_at_utc,issued_local_date,issued_local_display,status)
      VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')`);
    const insAudit = db.prepare(`INSERT INTO audit_events
      (tenant_id,certificate_id,action,actor_email,at_utc,metadata_json) VALUES (?,?,'ISSUED',?,?,?)`);

    const fixtures = [
      { id: 'cert-east-a5', tenant: 'tenant-east', course: 'course-east-safety', learner: 'learner-east-priya', enr: 'enr-e-safety-priya', serial: 'CERT-EAST-000001', actor: 'alice@east.test' },
      { id: 'cert-west-a5', tenant: 'tenant-west', course: 'course-west-safety', learner: 'learner-west-alex', enr: 'enr-w-safety-alex', serial: 'CERT-WEST-000001', actor: 'bob@west.test' },
    ];
    for (const f of fixtures) {
      const tz = tzOf[f.tenant];
      insCert.run(f.id, f.tenant, f.course, f.learner, f.enr, f.serial,
        A5_UTC, localDate(A5_UTC, tz), localDisplay(A5_UTC, tz));
      insAudit.run(f.tenant, f.id, f.actor, A5_UTC, JSON.stringify({ source: 'seed' }));
    }
  });

  return { seeded: true, tenants: TENANTS.length, certificates: 2, enrollments: ENROLLMENTS.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dbPath = process.env.DB_PATH ?? 'data/app.db';
  const reset = process.argv.includes('--reset');
  if (reset) {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      try { (await import('node:fs')).rmSync(p); } catch { /* ignore */ }
    }
  }
  const db = openDb(dbPath);
  console.log(JSON.stringify(seedDatabase(db), null, 2));
  db.close();
}
