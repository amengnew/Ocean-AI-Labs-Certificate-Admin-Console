# Certificate Admin Console

Internal admin console for a multi-tenant training platform. Tenant admins review course completions,
issue certificates in bulk, revoke them, and export certificate data.

**Stack**: Node 24 · Express · SQLite (`node:sqlite`, file-backed, WAL) · React 18 + Vite
(no native modules, no external services).

---

## Quick start — one command

```bash
npm start
```

That single command:
1. installs declared dependencies (if `node_modules` is missing),
2. installs the AI-evidence git hook,
3. builds the React frontend (if `web/dist` is missing),
4. initialises the SQLite demo dataset (if `data/app.db` is missing),
5. starts the app at **http://localhost:3000**.

Second command (verification):

```bash
npm run verify      # runs A1–A7 end-to-end against a throwaway database
```

### Actor context (no login UI)

Identity is carried by a header — there is exactly one admin per tenant:

| Admin | Header | Tenant | Timezone |
|---|---|---|---|
| `alice@east.test` | `X-Actor-Email: alice@east.test` | East | `Australia/Sydney` |
| `bob@west.test` | `X-Actor-Email: bob@west.test` | West | `Australia/Perth` |

Missing/unknown actor → `401`. Use the actor switcher in the UI, or send the header directly.

### Demo data

Both tenants contain a course titled **Safety 101** and a learner named **Alex Lee**.
`Safety 101` (East) deliberately covers all three outcome classes in one bulk operation:
Alex Lee (completed, eligible), Priya Nair (already certified), Tom Silva (incomplete).
Two certificates share the UTC timestamp `2026-01-10T13:30:00Z` — one per tenant — to demonstrate DST.

---

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | no actor required |
| GET | `/api/me` | resolved actor + tenant + timezone |
| GET | `/api/courses` | courses of the actor's tenant |
| GET | `/api/certificates` | `search`, `sort` (`issued_local_date`\|`learner_name`\|`serial_no`), `order`, `page`, `pageSize` |
| GET | `/api/certificates/:id` | cross-tenant → **404** |
| GET | `/api/certificates/:id/audit` | audit trail of one certificate |
| POST | `/api/certificates/bulk-issue` | body `{courseId}`, header `Idempotency-Key` |
| POST | `/api/certificates/:id/revoke` | idempotent; `alreadyRevoked` in response |
| GET | `/api/certificates/export` | `text/csv`, honours current `search`/`sort`/`order`, **not paginated** |

---

## Reproducing the acceptance scenarios

Start the app (`npm start`) and run these in another shell.

**A1 — Tenant isolation.** Bob must only ever see West data; cross-tenant detail must be a non-revealing 404.

```bash
# only West serials appear
curl -s "localhost:3000/api/certificates?pageSize=100" -H 'X-Actor-Email: bob@west.test'
# cross-tenant detail → 404
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/certificates/cert-east-a5 -H 'X-Actor-Email: bob@west.test'
# cross-tenant bulk → 404, and no certificate/audit/operation is created
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/certificates/bulk-issue \
  -H 'X-Actor-Email: bob@west.test' -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-a1' \
  -d '{"courseId":"course-east-safety"}'
```

**A2 — Retry safety.** Same key twice (serially, then concurrently) ⇒ one logical operation.

```bash
for i in 1 2; do curl -s -X POST localhost:3000/api/certificates/bulk-issue \
  -H 'X-Actor-Email: alice@east.test' -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-a2' \
  -d '{"courseId":"course-east-safety"}'; echo; done
# concurrent: all five responses are identical, certificates are not duplicated
for i in 1 2 3 4 5; do curl -s -X POST localhost:3000/api/certificates/bulk-issue \
  -H 'X-Actor-Email: alice@east.test' -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-a2c' \
  -d '{"courseId":"course-east-privacy"}' & done; wait
```

**A3 — Key misuse.** Same key with a different course ⇒ `409`, first result untouched.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/certificates/bulk-issue \
  -H 'X-Actor-Email: alice@east.test' -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-a2' \
  -d '{"courseId":"course-east-privacy"}'          # → 409
```

**A4 — Learner outcomes.** The bulk response lists `issued` / `skipped(incomplete_enrollment)` /
`skipped(already_certified)` per learner.

**A5 — DST and local date.** Same UTC instant, different tenants:

```bash
curl -s localhost:3000/api/certificates/cert-east-a5 -H 'X-Actor-Email: alice@east.test' | grep -o '"issuedLocalDisplay":"[^"]*"'
# → "2026-01-11 00:30"     (Sydney, AEDT +11 — crossed the date boundary)
curl -s localhost:3000/api/certificates/cert-west-a5 -H 'X-Actor-Email: bob@west.test'  | grep -o '"issuedLocalDisplay":"[^"]*"'
# → "2026-01-10 21:30"     (Perth, AWST +8)
```

**A6 — Export growth.** See the next section; `npm run verify` automates the full check
(100,000 rows, repeated export byte-identical, list still served during export).

**A7 — Revocation audit.**

```bash
curl -s -X POST localhost:3000/api/certificates/cert-east-a5/revoke -H 'X-Actor-Email: alice@east.test' -d '{}' -H 'Content-Type: application/json'
# repeat: alreadyRevoked=true, and no duplicate REVOKED audit event
```

---

## 100,000-row export dataset

Generates into a **separate** database so the quick-start dataset is untouched:

```bash
npm run seed:100k                    # → data/perf.db (100,000 East certificates, lots of equal sort keys)
DB_PATH=data/perf.db npm start       # run the app against the large dataset
```

Then, for example:

```bash
curl -s -o /tmp/out.csv -w 'rows=%{size_download} time=%{time_total}s\n' \
  "localhost:3000/api/certificates/export?search=Perf%20Learner&sort=learner_name&order=asc"
```

The export is streamed in batches with an explicit event-loop yield between batches and a total
order (`ORDER BY <sort>, id ASC`), so (a) it finishes well under the 60 s budget, (b) repeated
exports are byte-identical even for equal sort keys, and (c) the certificate list keeps answering
while an export is in flight.

Measured on the development machine: **100,000 rows in ~0.3 s**, repeated exports byte-identical,
and the list answering in ~55 ms while the export streams.

---

## Verification

```bash
npm run verify
```

Boots the real server against `data/.verify.db` and asserts A1_1–A7_2 over real HTTP, plus B1/B2.
Current result: **44 passed, 0 failed**.

---

## Design notes

- **Uniqueness is enforced by the database, not by careful code**: `(tenant_id, course_id, learner_id)`
  unique on certificates; partial unique indexes give exactly one `ISSUED` and one `REVOKED` audit event
  per certificate; `PRIMARY KEY (tenant_id, idem_key)` serialises idempotent operations.
- **Idempotency**: the operation row is claimed and committed *before* work starts, so a concurrent
  duplicate sees `IN_PROGRESS` and waits for the stored response instead of erroring; the payload
  fingerprint is compared first, so key reuse with a different payload is a `409`. Each claim carries a
  `claim_id`, and a claim older than 60 s is taken over — so a crash between claim and completion cannot
  strand a key forever, and a stale owner can never overwrite the new owner's result.
- **Per-learner savepoints** during bulk issue: one learner's failure rolls back only that learner, so a
  partial failure can never leave a certificate without its audit event.
- **Tenant-local time** is materialised into `issued_local_date` / `issued_local_display` at write time,
  which makes A5 correct and keeps A6's sorting index-friendly.
- **Actor context** is derived from a header; every query is tenant-scoped, and cross-tenant access is
  always `404` rather than `403` so existence is not leaked.
- **Search input is escaped** (`ESCAPE '\'`) so `%` and `_` are matched literally instead of acting as
  wildcards.

---

## Known defects and unfinished work

1. **No re-issue after revocation.** The unique index is on `(tenant, course, learner)` regardless of
   status, so a revoked certificate blocks a fresh one for the same learner+course. Deliberate trade-off
   (see `ai/decision-log.md` D4); the fix would be a partial unique index on `ACTIVE` plus re-issue logic.
2. **Stale-claim takeover is time-based, not lease-based.** A claim older than 60 s is treated as crashed.
   If a genuine operation ever ran longer than that, a second caller could take over; the unique indexes
   keep that safe from duplicate certificates, but the reported per-learner outcome could differ.
3. **CSV issue date is a calendar date** (`YYYY-MM-DD`) only. The API and UI show the full
   `YYYY-MM-DD HH:mm`; the CSV follows the spec's "tenant-local calendar date" wording.
4. **Offset pagination** (`page`/`pageSize`, max 100). No cursor pagination; deep pages scan.
5. **Single process.** No clustering, no rate limiting, no auth beyond the actor header (out of scope).
6. **Perf dataset has no audit events.** Generated rows exist to exercise export scale, not the issuance path.
7. **`npm run verify` writes ~100k rows** into `data/.verify.db`; it takes a few seconds and removes the file
   again on exit.


## AI interaction evidence

`ai/` is generated by `scripts/ai-evidence.mjs`, which is wired into a `pre-commit` hook — every commit
refreshes the evidence and stages it, so nothing here is maintained by hand:

- `ai/sessions/*.jsonl` — native session exports (prompts, full assistant responses, tool calls/results, timestamps, model)
- `ai/session-index.csv` — one row per session; `purpose` from the session title, `related_commits` matched from `git log` time windows
- `ai/decision-log.md` — rendered from `ai/decisions.jsonl` (accepted / rejected / trade-off, each with session id, evidence, commit)
- `ai/completeness-declaration.md` — tools used and export limitations

`written-answers.md` is answered by the candidate without AI assistance.
