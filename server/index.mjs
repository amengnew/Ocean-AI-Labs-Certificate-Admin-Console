/**
 * index.mjs — HTTP API（Express + node:sqlite）。
 *
 * 编号对应：B2 actor 上下文 / A1_* 租户隔离 / A2_* 幂等 / A3_* key 误用 /
 *           A4_* 学员结果 / A5_* 本地时间 / A6_* 导出 / A7_* 吊销审计
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openDb, localDisplay, localDate, nowUtcIso, tx } from './db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH ?? path.join(ROOT, 'data', 'app.db');
const PORT = Number(process.env.PORT ?? 3000);

const db = openDb(DB_PATH);
const app = express();
app.use(express.json({ limit: '256kb' }));

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ---------------------------------------------------------------- B2 actor
function loadActor(email) {
  if (!email) return null;
  return db.prepare(`
    SELECT a.email, a.display_name, t.id AS tenant_id, t.name AS tenant_name,
           t.code AS tenant_code, t.timezone
    FROM admins a JOIN tenants t ON t.id = a.tenant_id
    WHERE a.email = ?`).get(String(email).trim().toLowerCase()) ?? null;
}

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/health' || req.path === '/api/demo/actors') return next();
  const actor = loadActor(req.get('x-actor-email') ?? req.get('x-actor'));
  if (!actor) return fail(res, 401, 'unauthorized', 'Unknown or missing actor. Send X-Actor-Email header.');
  req.actor = actor;
  return next();
});

// ---------------------------------------------------------------- 基础
app.get('/api/health', (_req, res) => res.json({ ok: true, db: path.relative(ROOT, DB_PATH) }));

app.get('/api/demo/actors', (_req, res) => {
  const rows = db.prepare(`
    SELECT a.email, a.display_name, t.name AS tenant_name, t.timezone
    FROM admins a JOIN tenants t ON t.id = a.tenant_id ORDER BY a.email`).all();
  res.json({ items: rows.map((r) => ({ email: r.email, name: r.display_name, tenantName: r.tenant_name, timezone: r.timezone })) });
});

app.get('/api/me', (req, res) => res.json({
  actor: { email: req.actor.email, name: req.actor.display_name },
  tenant: { id: req.actor.tenant_id, name: req.actor.tenant_name, code: req.actor.tenant_code, timezone: req.actor.timezone },
}));

app.get('/api/courses', (req, res) => {
  const rows = db.prepare('SELECT id, title FROM courses WHERE tenant_id = ? ORDER BY title, id').all(req.actor.tenant_id);
  res.json({ items: rows.map((r) => ({ id: r.id, title: r.title })) });
});

// ---------------------------------------------------------------- 查询构造
const SORTABLE = {
  issued_local_date: 'c.issued_local_date',
  learner_name: 'l.name',
  serial_no: 'c.serial_no',
};

function buildFilter(tenantId, search) {
  const where = ['c.tenant_id = ?'];
  const params = [tenantId];
  const q = String(search ?? '').trim();
  if (q) {
    // 转义 LIKE 通配符：用户输入按字面匹配，避免 '%' / '_' 变成模式
    const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`);
    where.push("(l.name LIKE ? ESCAPE '\\' OR c.serial_no LIKE ? ESCAPE '\\')");
    params.push(`%${escaped}%`, `%${escaped}%`);
  }
  return { whereSql: where.join(' AND '), params };
}

/** 总加 `c.id ASC` 兜底 → 相同 sort key 顺序稳定（A6_2） */
function buildOrderBy(sort, order) {
  const col = SORTABLE[sort] ?? SORTABLE.issued_local_date;
  const dir = String(order ?? '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return { col, dir, orderSql: `ORDER BY ${col} ${dir}, c.id ASC` };
}

const CERT_SELECT = `
  SELECT c.id, c.serial_no, c.status, c.issued_at_utc, c.issued_local_date,
         c.issued_local_display, c.revoked_at_utc, c.revoked_by,
         c.course_id, c.learner_id, l.name AS learner_name, co.title AS course_title
  FROM certificates c
  JOIN learners l ON l.id = c.learner_id
  JOIN courses co ON co.id = c.course_id`;

const serializeCert = (r, tz) => ({
  id: r.id,
  serialNumber: r.serial_no,
  status: r.status,
  course: { id: r.course_id, title: r.course_title },
  learner: { id: r.learner_id, name: r.learner_name },
  issuedAtUtc: r.issued_at_utc,
  issuedLocalDate: r.issued_local_date,
  issuedLocalDisplay: r.issued_local_display,
  tenantTimezone: tz,
  revokedAtUtc: r.revoked_at_utc ?? null,
  revokedBy: r.revoked_by ?? null,
});

// ---------------------------------------------------------------- A1_1 / A5_2 列表
app.get('/api/certificates', (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20));
    const { whereSql, params } = buildFilter(req.actor.tenant_id, req.query.search);
    const { dir, orderSql, col } = buildOrderBy(req.query.sort, req.query.order);

    const total = db.prepare(`SELECT COUNT(*) AS n FROM certificates c JOIN learners l ON l.id = c.learner_id WHERE ${whereSql}`)
      .get(...params).n;
    const rows = db.prepare(`${CERT_SELECT} WHERE ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize);

    res.json({
      items: rows.map((r) => serializeCert(r, req.actor.timezone)),
      meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), sort: col, order: dir },
    });
  } catch (err) { fail(res, 500, 'internal_error', err.message); }
});

// ---------------------------------------------------------------- A6 导出（流式、不阻塞）
app.get('/api/certificates/export', async (req, res) => {
  const actor = req.actor;
  const { whereSql, params } = buildFilter(actor.tenant_id, req.query.search);
  const { orderSql } = buildOrderBy(req.query.sort, req.query.order);

  const ro = new DatabaseSync(DB_PATH, { readOnly: true });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="certificates-${actor.tenant_code.toLowerCase()}.csv"`);
  res.setHeader('X-Row-Fields', 'learner_name,course_title,serial_number,issue_date_local');

  // 客户端中断时停止迭代，避免继续为一个已关闭的连接读完整张表
  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    res.write('learner_name,course_title,serial_number,issue_date_local\n');
    const stmt = ro.prepare(`${CERT_SELECT} WHERE ${whereSql} ${orderSql}`);
    let buf = [];
    let n = 0;
    for (const row of stmt.iterate(...params)) {
      if (aborted) break;
      buf.push([csvCell(row.learner_name), csvCell(row.course_title), csvCell(row.serial_no), csvCell(row.issued_local_date)].join(','));
      if (++n % 2000 === 0) {
        if (!res.write(buf.join('\n') + '\n')) {
          await Promise.race([once(res, 'drain'), once(res, 'close')]);
        }
        buf = [];
        // 让出事件循环：导出期间列表请求仍可被处理（A6_3）
        await new Promise((r) => setImmediate(r));
      }
    }
    if (buf.length && !aborted) res.write(buf.join('\n') + '\n');
    res.end();
  } catch (err) {
    if (!res.headersSent) fail(res, 500, 'internal_error', err.message);
    else res.end();
  } finally {
    ro.close();
  }
});

// ---------------------------------------------------------------- A2 / A3 / A4 批量签发
function nextSerial(tenantId) {
  const t = db.prepare('SELECT code, next_serial FROM tenants WHERE id = ?').get(tenantId);
  db.prepare('UPDATE tenants SET next_serial = ? WHERE id = ?').run(t.next_serial + 1, tenantId);
  return `CERT-${t.code}-${String(t.next_serial).padStart(6, '0')}`;
}

const CLAIM_STALE_MS = 60_000;

/**
 * 占位：独立语句并立即提交，让并发的重复请求看得见 IN_PROGRESS。
 * 崩溃遗留的 IN_PROGRESS 超过 CLAIM_STALE_MS 允许被接管；claim_id 保证只有当前持有者能写回结果。
 */
function claimOperation(tenantId, key, fingerprint, courseId) {
  const claimId = crypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = db.prepare('SELECT * FROM idempotency_operations WHERE tenant_id = ? AND idem_key = ?').get(tenantId, key);
    if (row) {
      if (row.fingerprint !== fingerprint) return { kind: 'mismatch' };
      if (row.status === 'COMPLETED') return { kind: 'replay', httpStatus: row.http_status ?? 200, response: JSON.parse(row.response_json) };
      const age = Date.now() - Date.parse(row.created_at);
      if (age > CLAIM_STALE_MS) {
        const took = db.prepare(`UPDATE idempotency_operations SET claim_id = ?, created_at = ?
                                 WHERE tenant_id = ? AND idem_key = ? AND status = 'IN_PROGRESS'`)
          .run(claimId, nowUtcIso(), tenantId, key).changes;
        if (took === 1) return { kind: 'owner', claimId };
      }
      return { kind: 'pending' };
    }
    try {
      db.prepare(`INSERT INTO idempotency_operations
                  (tenant_id, idem_key, fingerprint, course_id, status, claim_id, created_at)
                  VALUES (?,?,?,?,'IN_PROGRESS',?,?)`)
        .run(tenantId, key, fingerprint, courseId, claimId, nowUtcIso());
      return { kind: 'owner', claimId };
    } catch (err) {
      if (!/UNIQUE|constraint/i.test(String(err.message))) throw err;
    }
  }
  return { kind: 'pending' };
}

async function waitForOperation(tenantId, key, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db.prepare('SELECT status, http_status, response_json FROM idempotency_operations WHERE tenant_id = ? AND idem_key = ?')
      .get(tenantId, key);
    if (row?.status === 'COMPLETED') return { httpStatus: row.http_status ?? 200, response: JSON.parse(row.response_json) };
    await sleep(25);
  }
  return null;
}

function runBulkIssue(actor, course, idemKey, claimId) {
  const tz = actor.timezone;
  const now = nowUtcIso();
  const localD = localDate(now, tz);
  const localDisp = localDisplay(now, tz);

  const enrollments = db.prepare(`
    SELECT e.id, e.status, e.learner_id, l.name AS learner_name
    FROM enrollments e JOIN learners l ON l.id = e.learner_id
    WHERE e.tenant_id = ? AND e.course_id = ?
    ORDER BY l.name ASC, e.id ASC`).all(actor.tenant_id, course.id);

  const already = new Set(
    db.prepare('SELECT learner_id FROM certificates WHERE tenant_id = ? AND course_id = ?')
      .all(actor.tenant_id, course.id).map((r) => r.learner_id),
  );

  const outcomes = [];
  let issued = 0, skipped = 0, failed = 0;
  let response;

  tx(db, () => {
    const insCert = db.prepare(`INSERT INTO certificates
      (id, tenant_id, course_id, learner_id, enrollment_id, serial_no,
       issued_at_utc, issued_local_date, issued_local_display, status)
      VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')`);
    const insAudit = db.prepare(`INSERT INTO audit_events
      (tenant_id, certificate_id, action, actor_email, at_utc, metadata_json)
      VALUES (?,?,'ISSUED',?,?,?)`);

    for (let i = 0; i < enrollments.length; i += 1) {
      const e = enrollments[i];
      if (already.has(e.learner_id)) {
        outcomes.push({ learnerId: e.learner_id, learnerName: e.learner_name, status: 'skipped', reason: 'already_certified' });
        skipped += 1;
        continue;
      }
      if (e.status !== 'completed') {
        outcomes.push({ learnerId: e.learner_id, learnerName: e.learner_name, status: 'skipped', reason: 'incomplete_enrollment' });
        skipped += 1;
        continue;
      }
      // 每个学员一个 savepoint：单个学员失败只回滚这一条，不会留下"有证书无审计"的半成品
      const sp = `sp_${i}`;
      db.exec(`SAVEPOINT ${sp}`);
      try {
        const certId = `cert-${crypto.randomUUID()}`;
        const serial = nextSerial(actor.tenant_id);
        insCert.run(certId, actor.tenant_id, course.id, e.learner_id, e.id, serial, now, localD, localDisp);
        insAudit.run(actor.tenant_id, certId, actor.email, now, JSON.stringify({ source: 'bulk-issue', idempotencyKey: idemKey }));
        db.exec(`RELEASE ${sp}`);
        outcomes.push({ learnerId: e.learner_id, learnerName: e.learner_name, status: 'issued', serialNumber: serial, certificateId: certId });
        issued += 1;
      } catch (err) {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
        outcomes.push({ learnerId: e.learner_id, learnerName: e.learner_name, status: 'failed', reason: 'issue_failed' });
        failed += 1;
      }
    }

    const built = {
      operationId: idemKey,
      courseId: course.id,
      courseTitle: course.title,
      issuedAtUtc: now,
      summary: { total: enrollments.length, issued, skipped, failed },
      outcomes,
    };
    response = built;
    // 只由当前占位持有者写回结果：若已被接管（claim_id 变化），不覆盖新持有者的结果
    db.prepare(`UPDATE idempotency_operations
                SET status='COMPLETED', http_status=200, response_json=?, completed_at=?
                WHERE tenant_id=? AND idem_key=? AND claim_id=?`)
      .run(JSON.stringify(built), now, actor.tenant_id, idemKey, claimId);
  });

  return response;
}

app.post('/api/certificates/bulk-issue', async (req, res) => {
  try {
    const actor = req.actor;
    const courseId = req.body?.courseId;
    if (typeof courseId !== 'string' || !courseId.trim()) return fail(res, 400, 'validation_error', 'courseId is required');

    const idemKey = req.get('idempotency-key');
    if (!idemKey) return fail(res, 400, 'idempotency_key_required', 'Idempotency-Key header is required');

    // A1_4：先校验课程归属，任何写入之前 → 跨租户不留任何副作用
    const course = db.prepare('SELECT id, title FROM courses WHERE id = ? AND tenant_id = ?').get(courseId, actor.tenant_id);
    if (!course) return fail(res, 404, 'course_not_found', 'Course not found');

    const fingerprint = sha(JSON.stringify({ courseId }));
    const claim = claimOperation(actor.tenant_id, idemKey, fingerprint, courseId);

    if (claim.kind === 'mismatch') {
      return fail(res, 409, 'idempotency_key_reuse', 'Idempotency-Key was already used with a different request payload');
    }
    if (claim.kind === 'replay') {
      return res.status(claim.httpStatus).set('Idempotent-Replay', 'true').json(claim.response);
    }
    if (claim.kind === 'pending') {
      // A2_2：并发重复请求不使用 409，而是等待首个操作完成后返回同一份结果
      const done = await waitForOperation(actor.tenant_id, idemKey);
      if (!done) return fail(res, 409, 'operation_in_progress', 'A concurrent operation with this key is still running');
      return res.status(done.httpStatus).set('Idempotent-Replay', 'true').json(done.response);
    }

    let response;
    try {
      response = runBulkIssue(actor, course, idemKey, claim.claimId);
    } catch (err) {
      db.prepare('DELETE FROM idempotency_operations WHERE tenant_id = ? AND idem_key = ?').run(actor.tenant_id, idemKey);
      throw err;
    }
    return res.status(200).json(response);
  } catch (err) {
    return fail(res, 500, 'internal_error', err.message);
  }
});

// ---------------------------------------------------------------- A1_2 详情
app.get('/api/certificates/:id', (req, res) => {
  try {
    const row = db.prepare(`${CERT_SELECT} WHERE c.tenant_id = ? AND c.id = ?`).get(req.actor.tenant_id, req.params.id);
    // 跨租户一律 404，避免泄露"该证书存在"
    if (!row) return fail(res, 404, 'not_found', 'Certificate not found');
    return res.json(serializeCert(row, req.actor.timezone));
  } catch (err) { return fail(res, 500, 'internal_error', err.message); }
});

app.get('/api/certificates/:id/audit', (req, res) => {
  try {
    const cert = db.prepare('SELECT id FROM certificates WHERE id = ? AND tenant_id = ?').get(req.params.id, req.actor.tenant_id);
    if (!cert) return fail(res, 404, 'not_found', 'Certificate not found');
    const rows = db.prepare(`SELECT id, action, actor_email, at_utc, metadata_json FROM audit_events
                             WHERE tenant_id = ? AND certificate_id = ? ORDER BY id ASC`).all(req.actor.tenant_id, cert.id);
    return res.json({
      items: rows.map((r) => ({ id: r.id, action: r.action, actorEmail: r.actor_email, atUtc: r.at_utc, metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null })),
    });
  } catch (err) { return fail(res, 500, 'internal_error', err.message); }
});

// ---------------------------------------------------------------- A7 吊销（幂等审计）
app.post('/api/certificates/:id/revoke', (req, res) => {
  try {
    const actor = req.actor;
    const cert = db.prepare('SELECT id FROM certificates WHERE id = ? AND tenant_id = ?').get(req.params.id, actor.tenant_id);
    if (!cert) return fail(res, 404, 'not_found', 'Certificate not found');

    const now = nowUtcIso();
    let changed = 0;
    tx(db, () => {
      changed = db.prepare(`UPDATE certificates SET status='REVOKED', revoked_at_utc=?, revoked_by=?
                            WHERE id = ? AND tenant_id = ? AND status='ACTIVE'`)
        .run(now, actor.email, cert.id, actor.tenant_id).changes;
      // 只有真正从 ACTIVE 变更的那一次才写审计（A7_2）
      if (changed === 1) {
        db.prepare(`INSERT INTO audit_events (tenant_id, certificate_id, action, actor_email, at_utc, metadata_json)
                    VALUES (?,?,'REVOKED',?,?,?)`)
          .run(actor.tenant_id, cert.id, actor.email, now, JSON.stringify({ source: 'revoke' }));
      }
    });

    const fresh = db.prepare(`${CERT_SELECT} WHERE c.tenant_id = ? AND c.id = ?`).get(actor.tenant_id, cert.id);
    return res.json({ ...serializeCert(fresh, actor.timezone), alreadyRevoked: changed === 0 });
  } catch (err) { return fail(res, 500, 'internal_error', err.message); }
});

// ---------------------------------------------------------------- 静态前端 + 兜底
const DIST = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

app.use('/api', (_req, res) => fail(res, 404, 'not_found', 'Endpoint not found'));

// 统一错误信封：畸形 JSON / body 解析失败也返回 JSON，而不是 Express 默认的 HTML 堆栈
app.use((err, _req, res, _next) => {
  if (res.headersSent) return;
  if (err?.type === 'entity.parse.failed') return fail(res, 400, 'invalid_json', 'Request body is not valid JSON');
  if (err?.type === 'entity.too.large') return fail(res, 413, 'payload_too_large', 'Request body is too large');
  return fail(res, 400, 'bad_request', err?.message ?? 'Bad request');
});

app.listen(PORT, () => {
  const seeded = db.prepare('SELECT COUNT(*) AS n FROM certificates').get().n;
  console.log(`certificate-admin listening on http://localhost:${PORT}  (db=${path.relative(ROOT, DB_PATH)}, certificates=${seeded})`);
  console.log('actors: alice@east.test (East/Sydney) | bob@west.test (West/Perth)');
});
