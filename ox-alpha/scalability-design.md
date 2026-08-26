# Scalability design — 500–1000 provider calls at once

Target: a benchmark run over ~150 calls × 7 providers (~1050 cells, of which up to
~1000 can be in flight across vendors at peak) must complete in minutes, survive
process restarts, and never double-execute when two API instances are behind the
same database.

## What limited us before

- Serial nested loops (`run-executor.ts:125-162`) — O(cells × latency).
- In-process `Set` re-entrancy guard — useless with >1 instance.
- Delete+insert rankings without a transaction.
- pg pool capped at 10 clients.

## Implemented now (this branch)

### 1. Bounded worker pool with per-provider caps

Cells are materialized into a flat list, then drained by N workers
(`RUN_CONCURRENCY`, default 16). A second, finer gate caps in-flight requests per
vendor (`PROVIDER_CONCURRENCY`, default 4) because vendor 429s — not our CPU — are
the real ceiling. Cartesia streams near-real-time audio; its cap is respected by the
same mechanism, so its slot count effectively throttles wall-clock streaming.

Both knobs are plain env vars — no new dependencies (the pool is ~40 lines of
Promise bookkeeping), keeping `pnpm-lock.yaml` untouched.

### 2. Retry with exponential backoff + jitter

Each cell gets up to `CELL_MAX_ATTEMPTS` (default 3). Retryable = HTTP 408/429/5xx,
network errors, and Cartesia's explicit "safe to retry" premature-close failure.
Non-retryable: 401/403 config errors (`ProviderConfigError` → `config_blocked`,
unchanged semantics). Backoff: `min(30s, 500ms · 2^attempt)` + full jitter.
Resumability semantics preserved: cells already `ok` are skipped on re-execute;
stale non-ok rows are deleted before their retry insert.

### 3. Cross-instance guard: Postgres advisory lock

Before executing, `SELECT pg_try_advisory_lock(hashtext('bench-run:' || runId))`.
Loser returns "already running" instead of racing. Lock is session-scoped and
released in a `finally`; a crashed process auto-releases (Postgres kills the
session), which composes correctly with the existing resume-from-`running` path.

### 4. Atomic rankings rewrite

`computeRankingsForRun` now runs inside `db.transaction`: delete prior rows for the
run, compute, insert — a crash can no longer strand a vertical with zero rankings.

### 5. Pool sizing

`PGPOOL_MAX` (default 20) on the shared Pool. Rule of thumb used:
`max ≈ RUN_CONCURRENCY + import concurrency + headroom`, still far under a Neon/
Supabase direct-connection budget; pooled connection strings work unchanged.

### 6. Honest capacity math (defaults)

| Phase | Bottleneck | Expectation |
|---|---|---|
| Batch adapters (~5–15 s/cell) | vendor concurrency caps | 7 providers × 4 slots ≈ 28 concurrent cells → ~1000 cells ≈ 6–10 min |
| Cartesia streaming | real-time duration | bounded by its own cap; long calls dominate tail |
| DB writes | pool | trivial (1 insert ×2 per cell) |
| Audio fetch | Vapi signed URLs | each cell fetches independently; P1 roadmap moves this to object storage |

## Deliberately not done yet (and why)

- **Durable queue table / separate worker process** — right next step (P1-1 in
  improvement-plan.md), but it's a bigger architectural change (BullMQ+Redis or
  pg-boss) than this session's scope; the advisory lock + resumable executor makes
  the current design crash-safe meanwhile.
- **Import parallelism** — same helper applies; deferred to keep the diff reviewable.
- **Serverless execution** — explicitly wrong fit: Cartesia needs minutes-long
  WebSocket streams; fire-and-forget execution conflicts with serverless lifetimes.
  Vercel hosts the web tier only (see vercel notes); the API stays long-running.

## Test evidence

See `ox-alpha/e2e-report.md`: a synthetic 1000-cell run executed against stub
adapters on a throwaway Postgres proves the executor drains ≥1000 cells
concurrently, respects per-provider caps, retries injected transient failures,
and finalizes rankings/audit exactly once.
