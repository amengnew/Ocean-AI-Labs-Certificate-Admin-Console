/**
 * App.jsx — 只做考核 §3 要求的 5 个交互：
 *   U1 actor 切换 / U2 列表(搜索·排序·分页·三态) / U3 批量签发(防重复提交+逐人结果)
 *   U4 详情+吊销确认 / U5 导出(保留当前搜索与排序)
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';

const ACTORS = ['alice@east.test', 'bob@west.test'];
const SORTS = [
  { id: 'issued_local_date', label: 'Issue date (local)' },
  { id: 'learner_name', label: 'Learner name' },
  { id: 'serial_no', label: 'Serial number' },
];

const newKey = () => `bulk-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

async function call(actor, path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Actor-Email': actor, ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body, headers: res.headers };
}

const fmt = (v) => (v == null ? '—' : String(v));

export default function App() {
  const [actor, setActor] = useState(ACTORS[0]);
  const [me, setMe] = useState(null);
  const [courses, setCourses] = useState([]);

  // U2 列表
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState('issued_local_date');
  const [order, setOrder] = useState('desc');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // U3 批量签发
  const [courseId, setCourseId] = useState('');
  const [idemKey, setIdemKey] = useState(newKey);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const [bulkError, setBulkError] = useState(null);

  // U4 详情 / 吊销
  const [detail, setDetail] = useState(null);
  const [audit, setAudit] = useState([]);
  const [detailError, setDetailError] = useState(null);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ search: debounced, sort, order, page: String(page), pageSize: '20' });
      const { ok, status, body } = await call(actor, `/api/certificates?${qs}`);
      if (!ok) throw new Error(body?.error?.message ?? `HTTP ${status}`);
      setItems(body.items);
      setMeta(body.meta);
    } catch (err) {
      setError(err.message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [actor, debounced, sort, order, page]);

  useEffect(() => { loadList(); }, [loadList]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [rMe, rCourses] = await Promise.all([call(actor, '/api/me'), call(actor, '/api/courses')]);
      if (!alive) return;
      setMe(rMe.ok ? rMe.body : null);
      const list = rCourses.ok ? rCourses.body.items : [];
      setCourses(list);
      setCourseId((prev) => (list.some((c) => c.id === prev) ? prev : (list[0]?.id ?? '')));
      setPage(1);
      setDetail(null);
      setBulkResult(null);
      setBulkError(null);
      setIdemKey(newKey());
    })();
    return () => { alive = false; };
  }, [actor]);

  const openDetail = async (id) => {
    setDetailError(null);
    setAudit([]);
    const { ok, status, body } = await call(actor, `/api/certificates/${id}`);
    if (!ok) { setDetail(null); setDetailError(body?.error?.message ?? `HTTP ${status}`); return; }
    setDetail(body);
    const rA = await call(actor, `/api/certificates/${id}/audit`);
    if (rA.ok) setAudit(rA.body.items);
  };

  const runBulk = async () => {
    if (!courseId || bulkRunning) return;
    setBulkRunning(true);
    setBulkError(null);
    setBulkResult(null);
    try {
      const { ok, status, body, headers } = await call(actor, '/api/certificates/bulk-issue', {
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey },
        body: JSON.stringify({ courseId }),
      });
      if (!ok) throw new Error(body?.error?.message ?? `HTTP ${status}`);
      setBulkResult({ ...body, replayed: headers.get('Idempotent-Replay') === 'true' });
      await loadList();
    } catch (err) {
      setBulkError(err.message);
    } finally {
      setBulkRunning(false);
    }
  };

  const revoke = async () => {
    if (!detail || revoking) return;
    if (!window.confirm(`Revoke certificate ${detail.serialNumber}? This cannot be undone.`)) return;
    setRevoking(true);
    try {
      const { ok, status, body } = await call(actor, `/api/certificates/${detail.id}/revoke`, { method: 'POST', body: '{}' });
      if (!ok) throw new Error(body?.error?.message ?? `HTTP ${status}`);
      setDetail({ ...body });
      const rA = await call(actor, `/api/certificates/${detail.id}/audit`);
      if (rA.ok) setAudit(rA.body.items);
      await loadList();
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setRevoking(false);
    }
  };

  const exportCsv = async () => {
    const qs = new URLSearchParams({ search: debounced, sort, order });
    const res = await fetch(`/api/certificates/export?${qs}`, { headers: { 'X-Actor-Email': actor } });
    if (!res.ok) { setError(`Export failed: HTTP ${res.status}`); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `certificates-${actor.replace(/[@.]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalPages = meta?.totalPages ?? 1;
  const summary = useMemo(() => bulkResult?.summary, [bulkResult]);

  return (
    <div className="wrap">
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17212b; background: #f6f7f9; }
        .wrap { max-width: 1080px; margin: 0 auto; padding: 24px 20px 60px; }
        h1 { font-size: 18px; margin: 0 0 4px; }
        .sub { color: #64748b; font-size: 12px; margin-bottom: 20px; }
        .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
        .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
        .grow { flex: 1; min-width: 180px; }
        label { font-size: 12px; color: #475569; display: block; margin-bottom: 4px; }
        input, select, button { font: inherit; padding: 7px 10px; border: 1px solid #cbd5e1; border-radius: 7px; background: #fff; }
        button { cursor: pointer; }
        button.primary { background: #1d4ed8; border-color: #1d4ed8; color: #fff; font-weight: 600; }
        button.danger { background: #b91c1c; border-color: #b91c1c; color: #fff; }
        button:disabled { opacity: .55; cursor: not-allowed; }
        table { width: 100%; border-collapse: collapse; margin-top: 12px; }
        th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eef2f7; }
        th { font-size: 12px; color: #475569; font-weight: 600; background: #f8fafc; }
        tbody tr { cursor: pointer; }
        tbody tr:hover { background: #f1f5f9; }
        .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
        .ACTIVE { background: #dcfce7; color: #166534; }
        .REVOKED { background: #fee2e2; color: #991b1b; }
        .issued { color: #166534; font-weight: 600; }
        .skipped { color: #b45309; font-weight: 600; }
        .failed { color: #b91c1c; font-weight: 600; }
        .alert { padding: 10px 12px; border-radius: 8px; margin-top: 12px; font-size: 13px; }
        .alert.error { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
        .alert.ok { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
        .muted { color: #64748b; font-size: 12px; }
        .pager { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 12px; font-size: 12px; }
        dl { display: grid; grid-template-columns: 150px 1fr; gap: 6px 12px; margin: 0; }
        dt { color: #64748b; font-size: 12px; }
        dd { margin: 0; }
      `}</style>

      <h1>Certificate Admin Console</h1>
      <div className="sub">
        Multi-tenant certificate administration · actor is identified by the <code>X-Actor-Email</code> header
      </div>

      {/* U1 */}
      <div className="card">
        <div className="row">
          <div className="grow">
            <label>Acting as (tenant)</label>
            <select value={actor} onChange={(e) => setActor(e.target.value)}>
              {ACTORS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className="grow">
            <label>Tenant timezone</label>
            <input readOnly value={me ? `${me.tenant.name} · ${me.tenant.timezone}` : '—'} />
          </div>
        </div>
      </div>

      {/* U3 */}
      <div className="card">
        <label>Bulk issue — issue certificates to all eligible learners of a course</label>
        <div className="row">
          <select className="grow" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            {courses.length === 0 && <option value="">(no courses)</option>}
            {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
          <input style={{ minWidth: 250 }} value={idemKey} onChange={(e) => setIdemKey(e.target.value)} title="Idempotency-Key" />
          <button onClick={() => setIdemKey(newKey())} disabled={bulkRunning}>New key</button>
          <button className="primary" onClick={runBulk} disabled={bulkRunning || !courseId}>
            {bulkRunning ? 'Issuing…' : 'Issue certificates'}
          </button>
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          Same key + same course = same logical operation (safe to retry). Same key + different course = 409.
        </div>

        {bulkError && <div className="alert error">Bulk issue failed: {bulkError}</div>}
        {bulkResult && (
          <div className="alert ok">
            operation <b>{bulkResult.operationId}</b>
            {bulkResult.replayed ? ' (replayed — no new certificates)' : ''} · issued {summary.issued} · skipped {summary.skipped} · failed {summary.failed}
            <table>
              <thead><tr><th>Learner</th><th>Outcome</th><th>Reason</th><th>Serial</th></tr></thead>
              <tbody>
                {bulkResult.outcomes.map((o) => (
                  <tr key={o.learnerId} style={{ cursor: 'default' }}>
                    <td>{o.learnerName}</td>
                    <td className={o.status}>{o.status}</td>
                    <td className="muted">{fmt(o.reason)}</td>
                    <td className="muted">{fmt(o.serialNumber)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* U2 */}
      <div className="card">
        <div className="row">
          <div className="grow">
            <label>Search learner name or serial number</label>
            <input style={{ width: '100%' }} value={search} placeholder="e.g. Alex or CERT-EAST" onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <div>
            <label>Sort by</label>
            <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}>
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <div>
            <label>Order</label>
            <select value={order} onChange={(e) => { setOrder(e.target.value); setPage(1); }}>
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </div>
          <div style={{ alignSelf: 'flex-end' }}>
            <button onClick={exportCsv}>Export CSV</button>
          </div>
        </div>

        {error && (
          <div className="alert error">
            Could not load certificates: {error} <button onClick={loadList} style={{ marginLeft: 8 }}>Retry</button>
          </div>
        )}
        {loading && <div className="alert">Loading…</div>}
        {!loading && !error && items.length === 0 && (
          <div className="alert">No certificates match this search.</div>
        )}
        {!error && items.length > 0 && (
          <>
            <table>
              <thead>
                <tr><th>Serial</th><th>Learner</th><th>Course</th><th>Issued (local)</th><th>Status</th></tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} onClick={() => openDetail(c.id)}>
                    <td>{c.serialNumber}</td>
                    <td>{c.learner.name}</td>
                    <td>{c.course.title}</td>
                    <td>{c.issuedLocalDisplay}</td>
                    <td><span className={`badge ${c.status}`}>{c.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pager">
              <span className="muted">{meta?.total ?? 0} rows · page {meta?.page ?? 1} / {totalPages}</span>
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>Prev</button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next</button>
            </div>
          </>
        )}
      </div>

      {/* U4 */}
      {(detail || detailError) && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h1 style={{ fontSize: 15 }}>Certificate detail</h1>
            <button onClick={() => { setDetail(null); setDetailError(null); }}>Close</button>
          </div>
          {detailError && <div className="alert error">{detailError}</div>}
          {detail && (
            <>
              <dl>
                <dt>Serial number</dt><dd>{detail.serialNumber}</dd>
                <dt>Course</dt><dd>{detail.course.title}</dd>
                <dt>Learner</dt><dd>{detail.learner.name}</dd>
                <dt>Issued (tenant local)</dt><dd>{detail.issuedLocalDisplay} <span className="muted">({detail.tenantTimezone})</span></dd>
                <dt>Issued (UTC)</dt><dd className="muted">{detail.issuedAtUtc}</dd>
                <dt>Status</dt><dd><span className={`badge ${detail.status}`}>{detail.status}</span></dd>
                {detail.revokedAtUtc && (<><dt>Revoked</dt><dd>{detail.revokedAtUtc} by {detail.revokedBy}</dd></>)}
              </dl>
              <div className="row" style={{ marginTop: 14 }}>
                <button className="danger" onClick={revoke} disabled={revoking || detail.status === 'REVOKED'}>
                  {detail.status === 'REVOKED' ? 'Already revoked' : revoking ? 'Revoking…' : 'Revoke certificate'}
                </button>
                <span className="muted">{audit.length} audit event(s)</span>
              </div>
              {audit.length > 0 && (
                <table>
                  <thead><tr><th>Action</th><th>Actor</th><th>At (UTC)</th></tr></thead>
                  <tbody>
                    {audit.map((a) => (
                      <tr key={a.id} style={{ cursor: 'default' }}>
                        <td>{a.action}</td><td>{a.actorEmail}</td><td className="muted">{a.atUtc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
