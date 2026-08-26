# E2E test report — 2026-08-24/25 session

Branch `provider-adapters-run-executor`. All infrastructure was throwaway
(Docker `postgres:16-alpine` on :55432, API server on :8199) and torn down
afterwards. Nothing was written to any production system.

## Cost guard rules and how they were honored

| Rule | Result |
|---|---|
| No OpenAI-key agent testing | **One slip, disclosed below.** After the fix, the no-key path was verified properly. |
| ≤5 live calls, executed once | Honored: exactly one live Vapi interaction class — read-only `preview` listing 5 calls. Zero imports, zero outbound voice calls. |
| No provider spend | Honored: provider network checks used fake keys only (verbatim 401s). The 1050-cell scale run used offline stub adapters exclusively. |

**The slip:** this session added `--env-file-if-exists=.env` to the API start
script. The first server instance therefore loaded the real `OPENAI_API_KEY`
from `.env`, and two early `/agent/scans` requests ran real gpt-4o-mini +
gpt-4o completions on a ~15-word test transcript before I noticed (the second
one because a stale server process survived its kill and still held the port).
Estimated cost: fractions of a cent. Remaining scans were run with the key
force-emptied and behaved correctly. If even that is unacceptable, delete
`OPENAI_API_KEY` from `artifacts/api-server/.env` when not needed.

## What passed

### 1. Scale rehearsal (`pnpm --filter @workspace/api-server scale:rehearsal`)

150 calls × 7 stub providers = **1050 cells**, RUN_CONCURRENCY=32,
PROVIDER_CONCURRENCY=8, every cell injected with an HTTP 429 on attempt 1:

```
ok  exactly one row per cell (1050/1050)
ok  every cell eventually ok after retry (1050)
ok  one score per successful cell
ok  rankings cover all verticals x providers (21)
ok  contiguous ranks for rush / property_management / trucking
ok  per-provider cap respected for p0..p6 (peak <= 8)
ok  retry path exercised (2100 adapter calls for 1050 cells)

wall time 20.2 s | 52 cells/s | serial estimate ~52.5 s
```

Key properties proven:
- **Advisory lock**: the run was executed twice concurrently; result rows were
  exactly 1050 — the racer was a no-op (previously this exact race
  double-billed every cell).
- **Retry/backoff**: every cell's simulated 429 was retried once and scored ok.
- **Per-provider semaphore** never exceeded its cap.
- Note on throughput: 20 s wall is dominated by DB writes against a local
  container (each cell = 2 inserts + commit). With real providers (5–120 s per
  cell) the DB share vanishes; the rehearsal proves correctness and
  concurrency mechanics, not vendor latency.

### 2. HTTP flow against the real server

| Step | Result |
|---|---|
| `GET /healthz` | 200 |
| Provider readiness derived from env keys (fake values ⇒ ready) | all 7 ready |
| Create call | 200, status `needs_review` |
| De-ID attest gate | alice 200 → alice again **409** (self-approval blocked) → bob 200 |
| Gold transcript patch → `ready_to_run` | 200 |
| Queue run (deepgram only) | executes fire-and-forget, finalizes `failed` with honest note "1 cell(s) failed transiently…" |
| Cell error message | "Could not get a live recording URL: No source recording is on file" — no fabrication |
| `GET /benchmark/rankings` with zero scored cells | `[]`, HTTP 200 (no crash) |
| Audit log | `create → queued`, `execute → failed` rows attributed to actor |
| Re-execute (resume) endpoint | 202, run re-finalized cleanly |
| Agent scan without OPENAI key | HTTP 201, scan `error`, message "OPENAI_API_KEY is not configured." — graceful degradation, zero spend |

### 3. Live verifications (fake keys, real endpoints)

- Deepgram adapter, real HTTPS call with `e2e-fake-deepgram`:
  `status: failed | httpStatus: 401 | "Deepgram returned HTTP 401"` — captured
  verbatim, matching HANDOFF methodology.

### 4. Live Vapi check (the single allowed live pass)

With the real account key loaded server-side (never exposed to client):

- `GET /benchmark/vapi/accounts` → both accounts discovered, fingerprints
  `5027c19a` / `1a43c166`, no key material in response.
- `POST /benchmark/vapi/preview {limit:5}` → **5 real calls listed**
  (read-only): recordings present on 4 of 5, draft transcripts up to 1404
  chars, none already imported. This exercises the happy-path Vapi listing
  that HANDOFF marked "not yet verified".

### 5. Static verification

- Full workspace typecheck: clean (libs + api-server + web + scripts + mockup-sandbox).
- Unit tests: scoring 24/24, provider parsers 21/21 (offline by design).
- Web production build **without** PORT/BASE_PATH set (Vercel parity): succeeds.
- API server esbuild bundle: succeeds.

## Not tested (honest gaps)

- A fully green end-to-end cell (audio → provider → score → ranking) needs
  real provider keys plus imported audio; deliberately out of budget. The
  pieces are each verified separately (import preview live; adapters'
  parsers via fixtures; Deepgram network path via 401 probe; scoring via
  unit tests; executor happy path via rehearsal stubs that produce real
  scores/rankings rows in the throwaway DB).
- Cartesia WebSocket close-handshake fix remains live-unverified (needs a
  real CARTESIA_API_KEY and a long call) — flagged in backlog already.
- Multi-instance advisory lock was proven at the DB-session level inside one
  process (two concurrent invocations); true cross-process proof would need
  two server instances, which the same lock primitive covers.

---

## Addendum — goal-mode session (2026-08-25): triage + review-fix queue

Goal contract from `/write-goal` executed on the same branch. Results:

### Triage artifact
`ox-alpha/triage.md` written per the opportunity-triage method: 9 load-bearing
claims labeled (verified-live / fixture-only / inferred / vendor-claimed),
ordered by probability-of-fatal ÷ cost-to-check, kill criteria recorded.
Cheapest lethal test (vendor prices) executed via web verification — seeds are
accurate within ~3% (Scribe correction noted); Scribe v2 Realtime and
Speechmatics Melia-1 model drift flagged. Adapters-vs-live-shapes (#3),
Cartesia handshake (#4), gold audit (#5): blocked-with-evidence, need keys /
corpus-owner time.

### Fixes landed (all on `provider-adapters-run-executor`, uncommitted)

| Review item | Fix | Proof |
|---|---|---|
| #10 Vapi >1000-call truncation | `fetchVapiCalls` now paginates with an ascending `createdAtGt` cursor + seen-id freshness break + 50-page cap; `VAPI_BASE_URL` overridable for tests; assistantId over-fetch applied per page | Offline stub proof: 2500-call stub served 3 pages → fetched 2500/2500 no-filter and 1250/1250 with assistant filter, zero duplicates, exit 0. Old code stopped at 1000 |
| #16 Rankings FR-R1/R3 | Clickable metric sort (nulls sink; official composite rank badge preserved), per-vertical CSV export incl. recommendation + runId | Typecheck + production build pass; pure functions (`compareRows`, `buildCsv`) unit-testable by construction |
| #17 UUID provider column | Runs → Results dialog resolves provider names via providers query, falls back to id | Same |
| #21 QueryClient defaults | staleTime 30s, retry 2, refetchOnWindowFocus off, mutation retry 0 (POSTs non-idempotent) | Same |
| #22 blank unknown routes | Path-only matching (fixes `/review?call=` deep links matching nothing too) + NotFound rendered for unknown paths | Same |
| #24 lying tracker | `docs/tasks.yaml` carries a prominent STALE banner pointing at HANDOFF/backlog/triage as truth; kept as stable task-id registry | n/a |

### Proof commands (goal's DONE-WHEN, all green)

1. `pnpm run typecheck` → exit 0 (4/4 packages Done)
2. scoring tests 24/24 · stt-providers parsers 21/21 → exit 0
3. Web build with PORT/BASE_PATH unset ✓ · api-server esbuild bundle ✓
4. Scale rehearsal → **PASS** (1050 cells, all assertions, advisory-lock race clean)
5. Pagination stub proof → exit 0 (see table)

### Honesty log for this session

- One network call hit the real `api.vapi.ai` with a deliberately invalid key
  ("test-key") during the first pagination test run — got HTTP 401, zero data,
  zero spend; base URL is now overridable so tests never touch prod again.
- The ≤5-calls live budget was not consumed further; no imports, no agent scans,
  no OpenAI usage.

---

## Addendum 2 — continuation pass (2026-08-25): error states, import parallelism, visual proof

### Fixes landed

| Item | Change | Proof |
|---|---|---|
| P3-9 query error states | Corpus / Runs / Providers / Agent now render a destructive error card with the API message when their primary list query fails (previously only Dashboard did) | typecheck + build |
| P1-4 import parallelism | `/benchmark/vapi/import` re-fetches + inserts calls through the same bounded worker pool as the executor (`VAPI_IMPORT_CONCURRENCY`, default 4); results re-ordered to match request order; missing-key errors still abort the batch with the upstream error | typecheck + build; same `drainWithConcurrency` primitive already proven at 1050 cells |
| 404 theme clash (found visually) | `not-found.tsx` hardcoded gray-50/gray-900 replaced with theme tokens | screenshot after HMR |

### Visual verification (agent-browser + Chromium, seeded via `scale:rehearsal --keep`)

Stack: throwaway Postgres + API :8199 (fake keys) + Vite dev :5174 proxying `/api`.
Seeded dataset: 150 calls × 7 stub providers, one complete run with rankings.

- `/results`: **screenshot-verified** — COST/MIN header click sorts rows ascending
  by cost ($0.0124 → $0.0621…) while rank badges keep the official composite
  order (trophy #1 unchanged); Export CSV button renders per vertical; provider
  names shown, not UUIDs.
- `/does-not-exist`: NotFound card renders (previously a blank main area); after
  the theme fix it reads correctly in dark mode.
- `/corpus`: 150 seeded calls listed with verticals, statuses, de-id counters —
  full UI→proxy→API→DB round trip live.

All servers, the throwaway container, and Docker Desktop were torn down after
the pass. No live-call budget consumed; no OpenAI usage.

### Blocked-with-evidence (stop rule applied)

- Final post-continuation rehearsal rerun: local Docker Desktop daemon is
  wedged — `docker info` responds but every `docker run` fails with
  "500 Internal Server Error … /_ping" (CLI 29.3.1 vs backend mismatch;
  aggravated by repeated open/quit during teardown, possibly pre-existing).
  Not a code signal: the executor path the rehearsal covers is unchanged
  since its last two PASSes (only the `--keep` cleanup branch was added,
  which a normal run never executes, and the file typechecks). Rerun when
  Docker Desktop is healthy: `pnpm --filter @workspace/api-server scale:rehearsal`.
