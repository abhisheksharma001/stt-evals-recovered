# STT Benchmark Handoff

## What exists today

- Standalone React command-center foundation at the workspace root.
- Typed API contract for corpus, provider, run, ranking, dashboard, plan, results,
  and audit-log views (`lib/api-spec/openapi.yaml`, codegen'd into `lib/api-zod`
  and `lib/api-client-react` via `pnpm --filter @workspace/api-spec run codegen`).
- PostgreSQL schema (Drizzle) covering calls, providers, runs, per-cell
  `benchmark_provider_call_results` (immutable raw provider output),
  `benchmark_scores` (derived, versioned), `benchmark_rankings`, and an
  append-only `audit_log`.
- Shared scoring library at `lib/scoring` (WER via Levenshtein, entity/
  alphanumeric accuracy, composite ranking score) used by both the CLI
  (`scripts/src/stt-score.ts`) and the API server's run executor.
- **Seven real provider adapters** at `lib/stt-providers`: Deepgram,
  AssemblyAI, OpenAI, ElevenLabs, Gladia, Speechmatics -- each hits the
  vendor's actual batch/URL REST API -- plus **Cartesia (Ink-Whisper)**,
  which is different in kind: Cartesia has no batch REST endpoint, only a
  WebSocket streaming one, so its adapter decodes the call's WAV audio to
  raw PCM and streams it in near-real-time chunks. That makes Cartesia the
  one provider where RUN-02 time-to-first-partial is a real measured number
  end-to-end (adapter -> `firstPartialAt` -> `latencyFirstPartialMs` in
  scores and rankings) instead of the placeholder 0 every batch adapter
  reports. Cartesia was added on direct request (named in the Slack ask,
  not in the original written ticket's candidate list -- see PRD.md).
  Every adapter's response parser is unit tested against fixture data; the
  network path itself has been live-verified against Deepgram's real
  endpoint (see "What was verified live" below) but the other six have
  **not** been called with real keys yet -- do that before trusting their
  output shape. Cartesia in particular has an inferred (not confirmed) close
  handshake -- see the comment at the top of `adapters/cartesia.ts`.
- A run executor (`artifacts/api-server/src/lib/run-executor.ts`) that
  actually calls providers, stores raw output + scores, is resumable
  (skips cells that already succeeded), and aggregates per-vertical rankings
  with a documented (open-decision) weighting.
- Provider readiness is **derived**, not manually toggled: a provider shows
  `ready` only when its adapter exists AND its API key env var is set. An
  operator can still manually `disabled` a provider (FR-P3).
- Two-person de-identification attestation gate (FR-C3), enforced server-side
  (`POST /benchmark/calls/:id/attest-deid`, blocks `ready_to_run` without two
  distinct approvers) and surfaced in the Corpus UI.
- Append-only audit log on every mutating route, attributed via an `x-actor`
  header (no real auth system exists -- see gaps below).
- A Vapi call importer, driven from the **Import Calls** page (`/import`) or
  the CLI (`pnpm --filter @workspace/scripts import:vapi`, now a thin wrapper
  over the same routes rather than a second implementation). The operator
  picks a Vapi account, a date range, a max call count, and an optional
  assistant id, previews what's there (read-only -- nothing is written), ticks
  the calls they want, tags a vertical, and imports. It never auto-approves
  and never promotes a provider's own transcript to `goldTranscript` (that
  would bias the benchmark); Vapi's transcript is stored as a labeled draft.
  - **Multiple Vapi accounts** are supported by env-var convention:
    `VAPI_API_KEY` (shows as "Default") and `VAPI_API_KEY_<LABEL>` (e.g.
    `VAPI_API_KEY_ELLAVOX` -> "Ellavox"). Accounts are derived from the
    environment on every request, so adding one is an env change plus a
    restart -- no schema change and no secret in Postgres. **Keys are never
    stored in the database and never sent to the browser**; the API exposes
    only an account's label, its env var name, and an 8-char sha256
    fingerprint so an operator can confirm which key the server loaded.
  - Duplicate protection: `benchmark_calls` now carries provenance
    (`sourceProvider`, `sourceCallId`, `sourceAccountLabel`,
    `sourceAssistantId`, `sourceStartedAt`) with a unique index on
    `(sourceProvider, sourceCallId)`, so re-importing an overlapping date
    range is a no-op. Calls imported by the older CLI predate those columns,
    so the duplicate check also falls back to matching the derived
    `vapi-<first8>` label.
  - At import time the server **re-fetches each call from Vapi by id** rather
    than trusting a recording URL posted by the browser.
- Runs page: execute/resume button + per-cell results drill-down (raw status,
  WER, entity accuracy, error message) reading `/benchmark/runs/:id/results`.
- **Bulks (PRD v2 §7.3, FR-BLK-1..11)** at `POST/GET /benchmark/bulks` +
  `routes/bulks.ts` / `lib/bulks.ts`: a named evaluation batch over a frozen
  corpus slice. Launch fans the frozen call set into shards (default 50
  calls/shard, FR-BLK-3); each shard × providers is an ordinary run (new
  `benchmark_runs.bulkId`/`shardIndex`) through the unchanged executor. Bulk
  status machine (FR-BLK-4): `draft → estimating → awaiting_confirmation →
  running → complete | partial | failed | cancelled`, recomputed from ground
  truth (`lib/bulk-status.ts`) every time a shard run finalizes. Includes:
  cost gate (`BULK_COST_THRESHOLD_CENTS`, default $50, FR-BLK-5),
  `POST /bulks/:id/retry-failed` (re-executes only runs with
  failed/skipped cells; succeeded cells never re-billed, FR-BLK-6),
  `POST /bulks/:id/cancel` (queued shard runs flip to `cancelled`; the
  in-flight run is signalled cooperatively -- cells inside a provider call
  finish and are recorded, un-started cells get `cancelled` result rows,
  FR-BLK-7), and the 3-live-bulks cap with synchronous oldest-first eviction
  that cascade-deletes only that bulk's own runs/results/scores/rankings --
  never the corpus (FR-BLK-10). Bulk-triggered runs do NOT require every
  call to be reviewed: the not-ready subset is recorded as
  `skipped_pending_review` result rows (a new outcome class, not a failure)
  and only the `ready_to_run` subset executes (FR-BLK-11); the ad-hoc
  Runs-page flow keeps its strict all-or-nothing gate. Shard runs carry the
  bulk's name and structured counts (FR-BLK-13) on `GET /benchmark/runs` and
  `GET /benchmark/bulks/:id` (progress aggregates from one grouped query).
- **Reusable bulk templates (FR-BLK-9)** at `POST/GET
  /benchmark/bulk-templates` + `POST /benchmark/bulk-templates/:id/launch`:
  criteria stored UNFROZEN -- a relative window (`lastNDays: 7`) is
  re-resolved against launch time on every launch (AC-2.7), while the bulk
  created from it freezes its own concrete date range + resolved call ids.
- **Run manifests (RUN-01 / P2-T1 / FR-BLK-8)**: every run created now
  snapshots an immutable manifest (`benchmark_runs.manifest` jsonb --
  scoring version, call ids + gold sha256, provider ids + config sha256) via
  `lib/manifest.ts`; export at `GET /benchmark/runs/:id/manifest` and the
  bulk-level composition at `GET /benchmark/bulks/:id/manifest`. Runs that
  predate manifests 404 rather than fabricate one.
- **Boot recovery**: on startup the server re-enters any run stranded as
  `queued`/`running` by a process death (safe -- execution is resumable and
  idempotent) and recomputes mid-flight bulk statuses. Verified live: a
  hand-stranded `running` run finalized to `failed` seconds after boot
  instead of being stuck forever.

## What was verified live (bulks slice, this session)

`pnpm --filter @workspace/api-server run e2e:bulks`
(`src/e2e-bulks.ts`, against a throwaway Postgres 16 container with
in-process stub provider adapters -- same pattern as rehearsal-scale.ts --
plus a mock Vapi server via the `VAPI_BASE_URL` seam; no real vendor keys or
spend): **36/36 assertions pass** covering shard fan-out (8 calls @
shardSize 3 → 3 runs), skipped_pending_review partitioning, in-cell 429
retry, bulk/run manifests with pinned hashes, cooperative cancel mid-flight
(in-flight cells completed, un-started cancelled), retry-failed after
provider heal (failed cells attempted exactly CELL_MAX_ATTEMPTS×, healed
retry completes the bulk), cost gate park → explicit launch, template
rolling-window re-resolution (10-day-old call excluded), second same-day
template launch naming, eviction cap with cascade + corpus preservation, and
audit coverage. Two real bugs found and fixed this way: drizzle wraps pg
error codes (`err.cause.code`, not `err.code` -- unique-violation detection
was silently dead), and a `callIds`-only criteria matched the whole corpus
through the always-on min-duration filter. Workspace typecheck clean; 24
scoring + 21 provider-parser unit tests still pass.

## What was verified live (this session)

Ran a full local stack against a throwaway Postgres 16 container (not
Replit's) and a real `node`/`pnpm` build:
- Schema pushes cleanly (`drizzle-kit push`), workspace typechecks clean,
  20 scoring unit tests + 12 provider-parser unit tests pass.
- End-to-end HTTP flow: create call -> two-person de-id attest (rejects a
  self-approval with 409) -> gold transcript + entity refs -> `ready_to_run`
  gate -> queue run -> **real HTTP call to Deepgram's live API** (fake key,
  got a real 401, captured verbatim) -> run finalized correctly -> audit log
  captured every transition.
- Found and fixed a real bug this way: an empty-results ranking insert
  crashed the executor and left runs stuck at `running` forever; also added
  resume-from-`running` so a crashed run doesn't need manual DB surgery.
- Seeded one successful score row to verify the untested "happy path":
  WER, entity accuracy, and composite ranking all computed correctly, with
  an automatic low-confidence caveat for small sample sizes.

## What was verified live (Vapi import UI)

- `GET /benchmark/vapi/accounts` with no keys set returns `[]` (the page then
  shows the env-var setup instructions rather than a broken form).
- With two keys set, both accounts are discovered with distinct fingerprints
  and correct env var attribution; neither key value appears in the response.
- `POST /benchmark/vapi/preview` made a **real HTTPS call to api.vapi.ai**
  with a deliberately invalid key and surfaced the verbatim 401 as a 502 with
  the upstream status attached. An unknown account id returns 400 without any
  network call.
- `POST /benchmark/vapi/import` against a call id matching one of the 22
  existing CLI-imported calls returned `skipped_duplicate` pointing at the
  existing corpus row (label fallback working), and a second, unknown id in
  the same batch failed independently without aborting the batch. Corpus row
  count was unchanged at 22 afterwards.
- Workspace typecheck clean; frontend production build succeeds.
- **Not yet verified:** a successful import against a real Vapi key (needs a
  live key), so the happy path through `fetchVapiCall` -> insert is exercised
  only by the duplicate/failure branches so far.

## What is intentionally not implemented

- **Real credentials for 6 of 7 providers** -- only the Deepgram HTTP path has
  been exercised against a live endpoint (with a deliberately invalid key).
  Get real keys and run one call through each before trusting the adapters.
  Cartesia especially needs this: its WebSocket finalize/close handshake is
  inferred from docs, not confirmed against a live connection.
- **Streaming latency capture** (first-partial vs final) -- wired end-to-end
  now, but only Cartesia's adapter actually populates it (it's the only
  WebSocket-streaming one); every batch/URL adapter still reports 0 because
  there's genuinely no first-partial moment in a single batch HTTP call.
  Deepgram/AssemblyAI/ElevenLabs/Gladia/Speechmatics do offer their own
  streaming APIs (RUN-02) -- that's still separate, harder work if the team
  wants real TTFP for those too, not just Cartesia.
- **Real auth/RBAC** -- the 5 PRD personas (Operator/Curator/Decision
  Maker/Compliance/Data Governor) are not enforced. Actor attribution is a
  free-text `x-actor` header, not a login. Anyone hitting the API can attest,
  approve, or queue a run.
- **Durable job queue (FR-EXC-1)** -- bulks got the full async state
  machine, cooperative cancel, retry-failed, and boot recovery on top of the
  in-process executor, but execution is still fire-and-forget inside the API
  process; the pg-boss move (separate worker, lease/reclaim, FR-EXC-6's
  automatic crash recovery beyond boot-time) remains open. Also still open
  from PRD v2 M2: per-provider token-bucket rate limits beyond the
  concurrency semaphores (FR-EXC-2 partial), content-addressed audio caching
  (FR-EXC-5), gzip-compressed raw outputs (FR-EXC-7), the 20k-row results
  ceiling (FR-EXC-8), bulk-triggered agent scans (FR-BLK-12), and any
  bulk/template UI -- the API surface is complete and codegen'd into
  `lib/api-client-react`, but no pages consume it yet.
- **Object storage for audio** -- `audioObjectPath` is just a URL string.
  Nothing enforces access control on it (NFR-4). Fine for MVP if URLs point
  at an already-access-controlled bucket; not fine as a long-term answer.
- **Diarization scoring against gold** -- adapters return a coarse "did the
  provider return >1 speaker" signal, not DER/JER against human-verified
  speaker segments (OD-4/OD-7 still open).
- **Statistical significance on rankings** (OD-5) -- composite score and a
  sample-size confidence caveat exist; no bootstrap/permutation test yet.

The application communicates readiness and blocks run execution until
corpus/gold/de-id/provider prerequisites exist. It does not fabricate results.

## Source-of-truth documents

| Need | Read |
|---|---|
| Standalone Vapi-specific system design | `docs/standalone-vapi-architecture.md` |
| External service route and MCP boundary | `docs/integration-strategy.md` |
| Full PRD and general requirements | `docs/PRD.md` |
| Small-to-micro implementation tasks | `docs/execution-plan.md` and `docs/tasks.yaml` |
| Dependency graph | `docs/task-graph.mmd` |
| Algorithm/logic decisions | `docs/logic-register.md` |
| Privacy and data handling | `docs/data-governance.md` |
| Re-runs and evidence package | `docs/reproducibility.md` |

## First implementation slice

Build only this vertical slice before any ranking or provider work:

1. Vapi date-range import job with checkpointing.
2. Private object-storage persistence for downloaded audio.
3. Manual upload fallback that produces the same import record shape.
4. Review/approval screen that prevents unapproved audio from entering a run.
5. Corpus manifest export.

This proves the data boundary and gives the team safe audio to use when implementing the first provider adapter.