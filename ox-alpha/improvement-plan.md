# Improvement plan — every way this project gets better

Prioritized. "Now" items were implemented in this session (branch
`provider-adapters-run-executor`); the rest is a sequenced roadmap with effort
estimates for one engineer.

## P0 — Shipped this session

| # | Item | Where |
|---|---|---|
| 0.1 | Concurrent run execution: worker pool + per-provider caps + retry/backoff, config via env (`RUN_CONCURRENCY`, `PROVIDER_CONCURRENCY`, `CELL_MAX_ATTEMPTS`) | `run-executor.ts` |
| 0.2 | Cross-instance double-execution guard: Postgres advisory lock per run | `run-executor.ts` |
| 0.3 | Rankings rewrite wrapped in a transaction (delete+insert atomic) | `run-executor.ts` |
| 0.4 | pg pool tuning knob (`PGPOOL_MAX`, sane default) | `lib/db/src/index.ts` |
| 0.5 | Vercel workflow: `vercel.json` for the web app, GitHub Actions CI (typecheck+unit+build) and web-deploy workflow | `.github/`, `artifacts/stt-benchmark/vercel.json` |
| 0.6 | Portable frontend/API split: optional `VITE_API_BASE_URL` wired through `setBaseUrl()`; vite no longer hard-requires `PORT`/`BASE_PATH` | `custom-fetch.ts`, `vite.config.ts`, `main.tsx` |
| 0.7 | Env loading that actually works locally: `--env-file` in api-server dev/start scripts | `artifacts/api-server/package.json` |
| 0.8 | ox-alpha docs folder (this review, plan, scalability design, E2E report) | `ox-alpha/` |

## P1 — Next two sprints (scale + trust)

1. **Durable job queue** (the doc-named Phase 2 decision): move cell execution to a
   `benchmark_run_jobs` table consumed by N workers (BullMQ+Redis already proven in
   the sibling ellavox stack; pg-boss keeps it single-dependency). API process only
   enqueues; workers own retries/backoff/caps. Unlocks horizontal scale past what an
   in-process pool should carry and survives deploys mid-run.
   Effort: 2–3 d.
2. **Real auth**: even pre-RBAC, replace free-text `x-actor` with signed sessions
   (Supabase Auth or OIDC-lite), map to the 5 PRD personas later. Attest/approve/run
   routes require auth on day one of deployment; audit rows gain `user_id`.
   Effort: 2–4 d.
3. **Audio object storage**: persist imported audio to S3/R2 under corpus-owned keys;
   `audioObjectPath` becomes a bucket path with signed read URLs; runs stop depending
   on Vapi presigned URL lifetimes; reproducibility manifest gets a stable hash.
   Effort: 2–3 d.
4. **Import parallelism + pagination**: page through `/call?limit=1000` with cursors,
   import with bounded concurrency (reuse the same pool helper). Effort: 0.5–1 d.

## P2 — Statistical & product rigor ("beyond market standards")

5. **Significance testing** (OD-5): bootstrap CIs on WER deltas per vertical; rankings
   UI shows CI + pairwise significance vs current winner instead of bare averages.
6. **Word-confidence extraction**: 3 of 4 major providers return token confidences —
   surface calibration curves; flag gold spans where all providers disagree AND are
   confident (highest-value review queue ordering).
7. **Cost pre-flight** (NFR-8): estimate run cost from durations × provider prices,
   show before queueing, require explicit confirm above a threshold.
8. **Streaming TTFP for Deepgram/ElevenLabs** (RUN-02): their streaming APIs exist;
   makes latency ranking honest across the board, not just Cartesia.

## P3 — Frontend quality

9. QueryClient defaults: `staleTime 30s`, `retry: 2`, global error toast + per-page
   error states everywhere (currently only Dashboard handles query errors).
10. Rankings: metric sort/filter, CSV export (FR-R3), confidence column, provider
    names not UUIDs in Runs table.
11. Agent scans become async job + polling (same queue infra as P1-1); kill the
    "spinner for a minute or two" UX.
12. Replace both `window.prompt` identity inputs with a lightweight identity picker
    persisted in localStorage until real auth lands.
13. Route the existing `not-found.tsx`; centralize verticals list in shared lib.

## P4 — Hygiene

14. Fix `docs/tasks.yaml` statuses or delete it in favor of backlog/ (it currently
    misleads every new contributor).
15. Test pyramid: api-server route tests (supertest) incl. de-id gate + attestation
    409 paths; executor concurrency test against stub adapters; Playwright happy-path
    once auth exists.
16. Extract Replit-isms behind a deploy adapter so `.replit`, vite env requirements,
    and prod plugins stop leaking into other targets.

## Explicit non-goals

- Live voice-agent concurrency inside this tool (it benchmarks recordings, it does
  not place calls at scale) — keep it that way; scale story here = provider cells.
- MCP in the runtime path — already correctly banned by architecture docs.
