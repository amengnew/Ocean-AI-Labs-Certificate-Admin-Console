#!/usr/bin/env node
/**
 * verify.mjs — B6：对 A1_1–A7_2 做端到端断言（真实起服务 + 真实 HTTP + 真实 SQLite）。
 *   npm run verify
 * 使用独立数据库 data/.verify.db，不污染 quick-start 数据集。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.mjs';
import { seedDatabase } from '../server/seed.mjs';
import { generatePerfCertificates } from './gen-100k.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VERIFY_PORT ?? 4399);
const DB_PATH = path.join(ROOT, 'data', '.verify.db');
const BASE = `http://127.0.0.1:${PORT}`;
const ALICE = 'alice@east.test';
const BOB = 'bob@west.test';

let pass = 0;
let fail = 0;
const failures = [];

function check(code, desc, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${code}  ${desc}`); }
  else { fail += 1; failures.push(`${code} ${desc} ${detail}`); console.log(`  ✗ ${code}  ${desc}  ${detail}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(actor, p, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(actor ? { 'X-Actor-Email': actor } : {}),
    ...(opts.headers ?? {}),
  };
  const r = await fetch(BASE + p, { ...opts, headers });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, ok: r.ok, body, text, headers: r.headers };
}

function dbGet(sql, ...params) {
  const d = new DatabaseSync(DB_PATH, { readOnly: true });
  try { return d.prepare(sql).get(...params); } finally { d.close(); }
}
const countCertsEast = () => dbGet('SELECT COUNT(*) AS n FROM certificates WHERE tenant_id = ?', 'tenant-east').n;

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(DB_PATH + suffix); } catch { /* ignore */ } }
  const seedDb = openDb(DB_PATH);
  const seedRes = seedDatabase(seedDb);
  seedDb.close();
  console.log(`\n▸ seeded ${DB_PATH} (${JSON.stringify(seedRes)})`);

  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  try {
    let healthy = false;
    for (let i = 0; i < 100 && !healthy; i += 1) {
      try { healthy = (await fetch(`${BASE}/api/health`)).ok; } catch { /* not up yet */ }
      if (!healthy) await sleep(100);
    }
    check('B1', 'one-command server starts, /api/health → 200', healthy);
    if (!healthy) { console.error(log); throw new Error('server did not start'); }

    // ---------------------------------------------------------- B2
    console.log('\nB2 actor 上下文');
    check('B2', 'missing actor header → 401', (await req(null, '/api/certificates')).status === 401);
    check('B2', 'unknown actor → 401', (await req('nobody@nowhere.test', '/api/certificates')).status === 401);
    check('B2', 'valid actor resolves tenant + timezone', (await req(ALICE, '/api/me')).body?.tenant?.timezone === 'Australia/Sydney');

    // ---------------------------------------------------------- A1 隔离
    console.log('\nA1 租户隔离');
    const bobList = await req(BOB, '/api/certificates?pageSize=100');
    check('A1_1', 'list returns only own-tenant rows', bobList.ok && bobList.body.items.every((i) => i.serialNumber.startsWith('CERT-WEST')), JSON.stringify(bobList.body.items?.map((i) => i.serialNumber)));
    const aliceDetail = await req(ALICE, '/api/certificates/cert-east-a5');
    const bobCross = await req(BOB, '/api/certificates/cert-east-a5');
    check('A1_2', 'own detail → 200', aliceDetail.ok, `got ${aliceDetail.status}`);
    check('A1_2', 'cross-tenant detail → 404 (non-revealing)', bobCross.status === 404, `got ${bobCross.status}`);
    check('A1_2', 'cross-tenant revoke → 404', (await req(BOB, '/api/certificates/cert-east-a5/revoke', { method: 'POST', body: '{}' })).status === 404);
    const bobExport = await req(BOB, '/api/certificates/export');
    check('A1_3', 'export contains only own-tenant rows', bobExport.ok && !bobExport.text.includes('CERT-EAST') && bobExport.text.startsWith('learner_name'));

    const snap = () => ({
      certs: dbGet('SELECT COUNT(*) AS n FROM certificates WHERE tenant_id = ?', 'tenant-east').n,
      audits: dbGet('SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ?', 'tenant-east').n,
      ops: dbGet('SELECT COUNT(*) AS n FROM idempotency_operations').n,
    });
    const b4 = snap();
    const bobBulkEast = await req(BOB, '/api/certificates/bulk-issue', {
      method: 'POST', headers: { 'Idempotency-Key': 'k-a1-4' }, body: JSON.stringify({ courseId: 'course-east-safety' }),
    });
    const a4 = snap();
    check('A1_4', 'cross-tenant bulk rejected → 404', bobBulkEast.status === 404, `got ${bobBulkEast.status}`);
    check('A1_4', 'cross-tenant bulk creates no certificates/audits/operations', JSON.stringify(b4) === JSON.stringify(a4), `${JSON.stringify(b4)} → ${JSON.stringify(a4)}`);

    // ---------------------------------------------------------- A5 时间
    console.log('\nA5 DST 与本地日期');
    const east = await req(ALICE, '/api/certificates/cert-east-a5');
    const west = await req(BOB, '/api/certificates/cert-west-a5');
    check('A5_1', 'East (Sydney) 2026-01-10T13:30Z → 2026-01-11 00:30', east.body?.issuedLocalDisplay === '2026-01-11 00:30', `got ${east.body?.issuedLocalDisplay}`);
    check('A5_1', 'West (Perth) 2026-01-10T13:30Z → 2026-01-10 21:30', west.body?.issuedLocalDisplay === '2026-01-10 21:30', `got ${west.body?.issuedLocalDisplay}`);
    const asc = await req(ALICE, '/api/certificates?sort=issued_local_date&order=asc&pageSize=100');
    const dates = asc.body.items.map((i) => i.issuedLocalDate);
    check('A5_2', 'list sorts by tenant-local calendar date', dates.every((d, i) => i === 0 || dates[i - 1] <= d), dates.join(','));
    const eastExport = await req(ALICE, '/api/certificates/export');
    check('A5_3', 'CSV uses East local calendar date', eastExport.text.includes('2026-01-11'));
    check('A5_3', 'CSV uses West local calendar date for same UTC instant', bobExport.text.includes('2026-01-10') && !bobExport.text.includes('2026-01-11'));

    // ---------------------------------------------------------- U2 列表能力
    console.log('\nU2 列表：搜索 / 分页');
    const byLearner = await req(ALICE, '/api/certificates?search=Priya');
    check('U2', 'search by learner name', byLearner.ok && byLearner.body.items.length === 1 && byLearner.body.items[0].learner.name === 'Priya Nair', `rows=${byLearner.body.items?.length}`);
    const bySerial = await req(ALICE, '/api/certificates?search=CERT-EAST-000001');
    check('U2', 'search by serial number', bySerial.ok && bySerial.body.items.length === 1 && bySerial.body.items[0].serialNumber === 'CERT-EAST-000001');
    const byWildcard = await req(ALICE, '/api/certificates?search=%25');
    check('U2', 'LIKE wildcards are treated literally (% matches nothing)', byWildcard.ok && byWildcard.body.items.length === 0, `rows=${byWildcard.body.items?.length}`);

    // ---------------------------------------------------------- B2 边界
    console.log('\nB2 请求边界');
    check('B2', 'export without actor → 401', (await req(null, '/api/certificates/export')).status === 401);
    const badJson = await fetch(`${BASE}/api/certificates/bulk-issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Actor-Email': ALICE, 'Idempotency-Key': 'k-badjson' },
      body: '{not json',
    });
    const badBody = await badJson.json().catch(() => null);
    check('B2', 'malformed JSON → 400 JSON envelope', badJson.status === 400 && badBody?.error?.code === 'invalid_json', `got ${badJson.status}`);
    check('B2', 'unknown endpoint → 404 JSON', (await req(ALICE, '/api/nope')).status === 404);

    // ---------------------------------------------------------- A2 幂等
    console.log('\nA2 重试安全');
    const c0 = countCertsEast();
    const bulk = (key, courseId, actor = ALICE) => req(actor, '/api/certificates/bulk-issue', {
      method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ courseId }),
    });
    const r1 = await bulk('k-a2-1', 'course-east-safety');
    const c1 = countCertsEast();
    const r2 = await bulk('k-a2-1', 'course-east-safety');
    const c2 = countCertsEast();
    check('A2_1', 'sequential replay returns the same logical operation', r1.ok && r2.ok && r1.body.operationId === r2.body.operationId && JSON.stringify(r1.body.outcomes) === JSON.stringify(r2.body.outcomes));
    check('A2_1', 'replay is flagged (Idempotent-Replay header)', r2.headers.get('idempotent-replay') === 'true');
    check('A2_1', 'sequential replay issues no extra certificate', c1 === c0 + 1 && c2 === c1, `c0=${c0} c1=${c1} c2=${c2}`);

    const c2b = countCertsEast();
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => bulk('k-a2-2', 'course-east-privacy')));
    const c2c = countCertsEast();
    const bodies = new Set(concurrent.map((r) => JSON.stringify(r.body)));
    check('A2_2', '5 concurrent identical requests → one logical operation', concurrent.every((r) => r.ok) && bodies.size === 1, `unique bodies=${bodies.size}`);
    check('A2_2', 'concurrent replay issues exactly one certificate', c2c === c2b + 1, `+${c2c - c2b}`);

    // 模拟崩溃遗留：claim 已提交但从未完成，且已超过接管阈值
    const staleKey = 'k-stale';
    const staleFp = createHash('sha256').update(JSON.stringify({ courseId: 'course-east-privacy' })).digest('hex');
    const wdb0 = new DatabaseSync(DB_PATH);
    wdb0.prepare(`INSERT INTO idempotency_operations
      (tenant_id, idem_key, fingerprint, course_id, status, claim_id, created_at)
      VALUES (?,?,?,?,'IN_PROGRESS','crashed-claim',?)`)
      .run('tenant-east', staleKey, staleFp, 'course-east-privacy', new Date(Date.now() - 5 * 60_000).toISOString());
    wdb0.close();
    const recovered = await bulk(staleKey, 'course-east-privacy');
    const recoveredRow = dbGet('SELECT status, claim_id FROM idempotency_operations WHERE tenant_id = ? AND idem_key = ?', 'tenant-east', staleKey);
    check('A2_2', 'stale IN_PROGRESS claim (crash) is taken over and completed', recovered.ok && recoveredRow.status === 'COMPLETED' && recoveredRow.claim_id !== 'crashed-claim', `status=${recoveredRow.status}`);

    const dups = dbGet('SELECT COUNT(*) AS n FROM (SELECT tenant_id, course_id, learner_id, COUNT(*) c FROM certificates GROUP BY 1,2,3 HAVING c > 1)').n;
    check('A2_3', 'no learner holds more than one certificate per course', dups === 0);
    const multiAudit = dbGet("SELECT COUNT(*) AS n FROM (SELECT certificate_id, COUNT(*) c FROM audit_events WHERE action='ISSUED' GROUP BY certificate_id HAVING c <> 1)").n;
    const missingAudit = dbGet("SELECT COUNT(*) AS n FROM certificates c WHERE NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.certificate_id = c.id AND a.action='ISSUED')").n;
    check('A2_4', 'each actual issuance has exactly one ISSUED audit', multiAudit === 0 && missingAudit === 0, `multi=${multiAudit} missing=${missingAudit}`);

    // ---------------------------------------------------------- A3 key 误用
    console.log('\nA3 idempotency key 误用');
    const c3 = countCertsEast();
    const misuse = await bulk('k-a2-1', 'course-east-privacy');
    check('A3_1', 'same key + different payload → 409', misuse.status === 409, `got ${misuse.status}`);
    check('A3_2', 'misuse executes no second operation', countCertsEast() === c3);
    const stored = dbGet('SELECT response_json FROM idempotency_operations WHERE tenant_id = ? AND idem_key = ?', 'tenant-east', 'k-a2-1');
    const storedBody = JSON.parse(stored.response_json);
    check('A3_2', 'first result is not overwritten', storedBody.operationId === 'k-a2-1' && storedBody.courseId === 'course-east-safety', storedBody.courseId);

    // ---------------------------------------------------------- A4 学员结果
    console.log('\nA4 学员结果');
    const byName = (n) => r1.body.outcomes.find((o) => o.learnerName === n);
    check('A4_1', 'eligible learner → issued', byName('Alex Lee')?.status === 'issued', JSON.stringify(byName('Alex Lee')));
    check('A4_2', 'incomplete learner → skipped(incomplete_enrollment)', byName('Tom Silva')?.status === 'skipped' && byName('Tom Silva')?.reason === 'incomplete_enrollment');
    check('A4_3', 'already-certified learner → skipped(already_certified)', byName('Priya Nair')?.status === 'skipped' && byName('Priya Nair')?.reason === 'already_certified');

    // ---------------------------------------------------------- A7 吊销审计
    console.log('\nA7 吊销审计');
    const issuedId = byName('Alex Lee').certificateId;
    const rev1 = await req(ALICE, `/api/certificates/${issuedId}/revoke`, { method: 'POST', body: '{}' });
    const revCount = () => dbGet("SELECT COUNT(*) AS n FROM audit_events WHERE certificate_id = ? AND action = 'REVOKED'", issuedId).n;
    check('A7_1', 'revoke flips status and writes one REVOKED audit', rev1.ok && rev1.body.status === 'REVOKED' && revCount() === 1, `audits=${revCount()}`);
    const rev2 = await req(ALICE, `/api/certificates/${issuedId}/revoke`, { method: 'POST', body: '{}' });
    check('A7_2', 'repeat revoke creates no duplicate audit', rev2.ok && rev2.body.alreadyRevoked === true && revCount() === 1, `audits=${revCount()}`);

    // 此时 East 已有 3 张证书，分页断言才有意义
    const page1 = await req(ALICE, '/api/certificates?pageSize=1&page=1&sort=serial_no&order=asc');
    const page2 = await req(ALICE, '/api/certificates?pageSize=1&page=2&sort=serial_no&order=asc');
    check('U2', 'pagination returns distinct rows', page1.ok && page2.ok && page1.body.items[0].id !== page2.body.items[0].id);
    const overflow = await req(ALICE, '/api/certificates?page=9999&pageSize=20');
    check('U2', 'out-of-range page returns empty items with stable total', overflow.ok && overflow.body.items.length === 0 && overflow.body.meta.total === page1.body.meta.total);
    const clamp = await req(ALICE, '/api/certificates?pageSize=1000');
    check('U2', 'pageSize is clamped to 100', clamp.ok && clamp.body.meta.pageSize === 100);

    // ---------------------------------------------------------- A6 导出租户规模
    console.log('\nA6 导出规模（100,000 行）');
    const wdb = new DatabaseSync(DB_PATH);
    wdb.exec('PRAGMA busy_timeout = 10000;');
    const gen = generatePerfCertificates(wdb, { count: 100000 });
    wdb.close();
    console.log(`  · generated ${gen.generated} certificates in ${gen.ms} ms`);

    const qs = `search=${encodeURIComponent('Perf Learner')}&sort=learner_name&order=asc`;
    const t0 = Date.now();
    const exp1 = await req(ALICE, `/api/certificates/export?${qs}`);
    const dur = Date.now() - t0;
    const rows = exp1.text.split('\n').filter(Boolean).length - 1;
    check('A6_1', '100k-row export completes under 60s', exp1.ok && dur < 60000 && rows >= 100000, `${dur}ms rows=${rows}`);
    const exp2 = await req(ALICE, `/api/certificates/export?${qs}`);
    check('A6_2', 'repeated export is byte-identical (stable ties)', exp1.text === exp2.text);

    const pending = req(ALICE, '/api/certificates/export?search=Perf&sort=issued_local_date&order=asc');
    await sleep(40);
    const during = await req(ALICE, '/api/certificates?pageSize=5');
    const done = await pending;
    check('A6_3', 'certificate list succeeds while export is running', during.status === 200 && done.ok, `list=${during.status} export=${done.status}`);
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    // 清理临时库，避免在仓库里留下大文件（A6 会写入 10 万行）
    for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(DB_PATH + suffix); } catch { /* ignore */ } }
  }

  console.log(`\n${'─'.repeat(58)}`);
  console.log(`结果：${pass} passed, ${fail} failed`);
  if (fail) { console.log('\n失败项：'); for (const f of failures) console.log(`  - ${f}`); }
  console.log('');
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => { console.error('\nverify crashed:', err); process.exit(1); });
