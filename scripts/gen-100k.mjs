#!/usr/bin/env node
/**
 * gen-100k.mjs — B5：为单租户生成 10 万张证书。
 * 默认写 data/perf.db，**不触碰** data/app.db 的 quick-start 数据集。
 *   npm run seed:100k                  → data/perf.db
 *   DB_PATH=data/perf.db npm start     → 用大数据集跑 A6
 */
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { openDb, localDisplay } from '../server/db.mjs';
import { seedDatabase } from '../server/seed.mjs';

/**
 * 直接在给定连接上生成证书。刻意制造"相同排序键"的重复值（A6 要求）。
 * @returns {{generated:number, existing:number, ms:number}}
 */
export function generatePerfCertificates(db, {
  count = 100000,
  tenantId = 'tenant-east',
  tz = 'Australia/Sydney',
  courseId = 'course-east-perf',
  courseTitle = 'Perf Lab',
  prefix = 'perf',
} = {}) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM certificates WHERE tenant_id = ? AND course_id = ?').get(tenantId, courseId).n;
  if (existing >= count) return { generated: 0, existing, ms: 0 };

  const t0 = Date.now();
  const base = Date.UTC(2025, 0, 1, 12, 0, 0);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT 1 AS ok FROM courses WHERE id = ?').get(courseId)) {
      db.prepare('INSERT INTO courses (id, tenant_id, title) VALUES (?,?,?)').run(courseId, tenantId, courseTitle);
    }
    const insL = db.prepare('INSERT INTO learners (id, tenant_id, name, email) VALUES (?,?,?,?)');
    const insE = db.prepare('INSERT INTO enrollments (id, tenant_id, course_id, learner_id, status) VALUES (?,?,?,?,?)');
    const insC = db.prepare(`INSERT INTO certificates
      (id, tenant_id, course_id, learner_id, enrollment_id, serial_no,
       issued_at_utc, issued_local_date, issued_local_display, status)
      VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')`);

    for (let i = existing; i < count; i += 1) {
      const learnerId = `${prefix}-learner-${i}`;
      const enrId = `${prefix}-enr-${i}`;
      // 按 480 小时循环 → 大量相同的本地日历日 / 相同的学员名，用于 A6 排序稳定性
      const utc = new Date(base + (i % 480) * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const localDisp = localDisplay(utc, tz);
      insL.run(learnerId, tenantId, `Perf Learner ${String(i % 200).padStart(3, '0')}`, `${learnerId}@perf.test`);
      insE.run(enrId, tenantId, courseId, learnerId, 'completed');
      insC.run(`${prefix}-cert-${i}`, tenantId, courseId, learnerId, enrId,
        `CERT-PERF-${String(i).padStart(6, '0')}`, utc, localDisp.slice(0, 10), localDisp);
    }
    db.prepare('UPDATE tenants SET next_serial = ? WHERE id = ? AND next_serial < ?').run(900000, tenantId, 900000);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
  return { generated: count - existing, existing, ms: Date.now() - t0 };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dbPath = process.env.DB_PATH ?? 'data/perf.db';
  const count = Number(process.env.COUNT ?? process.argv[2] ?? 100000);
  const db = openDb(dbPath);
  seedDatabase(db);
  console.log(`▸ generating ${count.toLocaleString()} certificates into ${dbPath} (tenant-east)…`);
  const r = generatePerfCertificates(db, { count });
  const total = db.prepare('SELECT COUNT(*) AS n FROM certificates WHERE tenant_id = ?').get('tenant-east').n;
  db.close();
  console.log(`✓ generated ${r.generated.toLocaleString()} rows in ${r.ms} ms (east total=${total.toLocaleString()})`);
  console.log(`→ 用大数据集运行：DB_PATH=${dbPath} npm start`);
}
