# Project review — STT Benchmark Command Center

Audit date: 2026-08-24 · branch `provider-adapters-run-executor` (dirty tree preserved).
Severity: **S1** = blocks scale/correctness today, **S2** = hurts reliability or trust soon,
**S3** = quality/velocity debt.

The short version: the product logic is unusually honest (no fabricated results,
immutable raw output, resumable runs) but the execution layer is a single-threaded
loop in one Node process, there is no CI/deploy story at all, and auth is a
free-text header. Everything below is ranked against "be ready for 500–1000
calls at once" and "beyond market standards".

---

## S1 — Execution & scale

### 1. Run executor is fully serial (`artifacts/api-server/src/lib/run-executor.ts`)

- Nested `for` loops: outer over calls, inner over providers, each cell
  `await runCell(...)` (`run-executor.ts:125–162`). Wall time ≈ Σ(cells × provider
  latency). 500 calls × 7 providers × ~10 s ≈ 10 hours serial; with Cartesia's
  near-real-time streaming it is worse.
- No retries and no backoff anywhere in the executor or adapters; a transient 429/5xx
  permanently marks a cell failed unless someone re-runs the whole run.
- The only concurrency guard is an in-process `Set<string>` (`run-executor.ts:28`) —
  two API instances double-execute the same run (already logged in
  `docs/backlog/good-to-have.md:74-80`).

### 2. Fire-and-forget execution in the web process

- `void executeBenchmarkRun(...)` at `routes/benchmark.ts:972-974` and `:998-1000`.
  Process restart mid-run leaves status `running` forever until a human re-POSTs.
  No worker separation, no durable queue table (the results table is only a
  cell ledger).

### 3. Database pool untuned

- `lib/db/src/index.ts:13` creates `new Pool({ connectionString })` — pg defaults to
  **max 10 clients**. At any real write concurrency the executor starves on
  client checkout and latency explodes.

### 4. Import path is sequential too

- `POST /benchmark/vapi/import` loops calls one-by-one with per-call Vapi fetches
  (`routes/benchmark.ts:679+`). A 1000-call backfill takes hours and hammers Vapi
  politely but slowly.

---

## S1 — Trust & security

### 5. No authentication at all

- Actor attribution is a free-text `x-actor` header (`lib/audit.ts:9-11`). Anyone who
  can reach the API can attest de-ID, approve agent picks into `goldTranscript`, or
  queue paid provider runs. HANDOFF.md admits this; for an internal tool it is
  tolerable, but it caps the product below "market standard" for anything shared.

### 6. CORS wide open + small body limit mismatch

- `cors()` with no origin config (`app.ts:28`); `express.json()` default 100 KB body
  limit (`app.ts:29`) will 413 on bulk manual-call creation payloads.

### 7. Secrets handling is good, env loading is not

- Keys are never stored/logged/sent to browser (verified in vapi.ts) — good.
- But `artifacts/api-server/.env` is **never loaded by any code** (no dotenv, no
  `--env-file`). Local/Vercel runs silently see zero keys → providers show unready.

---

## S2 — Correctness gaps that bite at scale

8. **Rankings recompute deletes then inserts without a transaction**
   (`run-executor.ts:393+`) — a crash mid-way leaves a vertical with no rankings.
9. **No statistical significance** on rankings (OD-5 open): composite averages of
   tiny samples get presented as winners with only a low-confidence caveat.
10. **Vapi pagination absent** (`vapi.ts:219-238`): >1000-call date windows silently
    truncate; assistantId workaround over-fetches ×10.
11. **Audio object path is just a URL string** — no access control, no local cache;
    every run re-downloads every recording from Vapi signed URLs (rate-limit risk
    at 500+ cells, and non-reproducible if Vapi expires them).
12. **Cartesia WebSocket close handshake still inferred**, premature-close fix is
    uncommitted and live-unverified (`adapters/cartesia.ts`, backlog :91-113).

---

## S2 — Delivery infrastructure (missing entirely)

13. **Zero CI**: no `.github/`, no lint/typecheck/test gate on push.
14. **Zero deploy config**: no vercel.json / Dockerfile / fly.toml anywhere; docs
    assume Replit. `vite.config.ts:8-28` hard-throws without `PORT`/`BASE_PATH`
    env vars — a Vercel build fails out of the box.
15. **Frontend assumes same-origin `/api`**: nothing ever calls `setBaseUrl()`
    (`custom-fetch.ts:28`), so split hosting (static frontend + long-running API)
    needs code before config.

---

## S3 — Product/UX debt (from full page audit)

16. `/results` (Rankings.tsx): no sort/filter by metric (FR-R1), no CSV export
    (FR-R3), no confidence display, `ranks.sort()` mutates during render (:66),
    hardcoded metric caption (:48).
17. Runs.tsx: provider column shows raw UUID not name (:334); no cost pre-flight
    estimate before queueing a paid run (NFR-8); results dialog doesn't poll while
    the run is in flight.
18. Review.tsx: approver identity via `window.prompt` (:264); keyboard shortcuts
    effect re-binds every render (:284-303).
19. Agent page: synchronous POST that "can take a minute or two" with just a
    spinner; navigating away orphansscan progress; same `window.prompt` identity.
20. Providers page: create-only, no edit; raw checkbox inconsistent with UI kit.
21. QueryClient has zero defaults (App.tsx:17) — no staleTime, global retry noise,
    refetch-on-focus storms against a single-node Express.
22. `not-found.tsx` exists but is never routed; unknown URLs render blank.
23. Verticals hardcoded in three places (Dashboard :12-16, Import :393-396, schema
    check constraint presumably) — adding a vertical means code edits in N spots.

## S3 — Repo hygiene

24. `docs/tasks.yaml` claims every task `not_started` while most Phase 0-1 work is
    shipped — the tracker actively lies now.
25. No tests outside scoring/parsers (both good). No api-server route tests, no
    executor test, no frontend test runner.
26. `mockup-sandbox` artifact still requires PORT/BASE_PATH and ships Replit
    plugins into prod builds.
