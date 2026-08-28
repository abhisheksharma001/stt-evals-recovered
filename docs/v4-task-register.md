# v4 Task Register — one task, one PR, one compact

**Created:** 2026-08-28
**Purpose:** this file is the memory across compactions. The conversation will be
compacted between every task, so **nothing here may live only in chat.** Read this
file first, pick the next `todo`, do it, open a PR, merge it, mark it `done` in the
same PR.

## The loop (agreed with Abhishek 2026-08-28)

1. Read this register. Take the top `todo` task.
2. Do exactly that task. No adjacent scope, no drive-by fixes — note them as new
   tasks at the bottom instead.
3. `pnpm run typecheck` clean. Relevant unit tests pass.
4. Open a PR. Review it. Merge it.
5. Mark the task `done` here, with the PR number and anything learned.
6. Say **"Master Abhishek"** at the end of the report — Abhishek's own
   anti-hallucination check that the loop is really running.
7. Abhishek compacts. Says "next". Repeat.

**Branch:** work from `main-restored`, push to `newrepo main`.
**Backend changes need `node ./build.mjs` + a process restart.** There is no watch mode.

## Status legend

`todo` · `doing` · `done` · `blocked` · `deferred` · `gated` (waiting on a real
trigger, not a date)

---

## Phase 0 — deploy what already exists

| ID | Task | Status |
|---|---|---|
| T-00 | ✅ **done** 2026-08-28 03:26 (Abhishek ran it). Server up on 8177, `/api/healthz` → `{"status":"ok"}`, ElevenLabs present in the provider list alongside AssemblyAI, Cartesia, Deepgram ×3, Gladia, OpenAI, Speechmatics. **Note:** the process was started at 03:26 from the T-01 build; T-02 (built 03:36) is not in the running process. Every backend task needs its own restart until T-04/T-05 make the running build visible on screen. |

---

## Phase 1 — stop losing data

Nothing else matters until these land. The tool currently destroys the results it
pays for.

| ID | Task | Files | Done when |
|---|---|---|---|
| T-01 | ✅ **done** (PR #4). **Judge cost precision.** `judge_cost_cents` is `integer`; the value is fractional (`0.4905`), so every judged insert fails. Replace with integer micro-cents (`judge_cost_microcents`, 1¢ = 10,000µ¢). Apply the same treatment to `benchmark_scores.cost_cents`, where `Math.round(x*100)` currently loses ~8%. | `lib/db/src/schema/benchmark-agent-scans.ts`, `benchmark-scores.ts`, `lib/agent.ts`, `lib/agent-verify.ts`, `lib/run-executor.ts`, `routes/bulks.ts`, `openapi.yaml` | A judged scan row reads back with a non-null cost, and a bulk's `agentCostCents` is > 0 |
| T-02 | ✅ **done** (PR #5). **Never discard a good judge payload.** Split the single `try` in `verifyCallWithAgent` so the OpenAI call and the DB write are caught separately, with distinct error prefixes (`judge_failed:` / `scan_write_failed:`). If the full insert fails, retry once without the cost columns. | `lib/agent-verify.ts` | Forcing a write error still persists the reasoning and the pick; the error names the write, not the judge |
| T-03 | ✅ **done** (PR #6). **Stop conflating "flagged" with "the AI crashed."** `agentCallsFlagged` counted `flagged \|\| error`. Split into `agentCallsFlagged` and `agentCallsErrored`, both exposed; a destructive strip renders when errored > 0, on both the bulk detail and the per-bulk Rankings header. `agentCostMicrocents` is now nullable and distinguishes three states: a real total, a real zero (nothing flagged, so no judge call was ever made), and null = "not recorded" (judge calls ran, no cost survived). | `routes/bulks.ts`, `openapi.yaml`, `Rankings.tsx`, `Bulks.tsx`, `lib/utils.ts` | Forcing one scan to error shows the strip; the ranking table is visibly unaffected |
| T-04 | ✅ **done** (PR #7). **Build identity in `/api/healthz`.** Returns `commitSha`, `builtAt`, `startedAt`, `providersConfigured` (**names only**). SHA and build time are frozen into the bundle by esbuild `define` at build time, so they describe the bundle rather than the working tree at start. A dirty tree at build time stamps a `-dirty` suffix; running from source (tsx) reports `commitSha: "dev"`, `builtAt: null` — never a fabricated commit. No database work in the handler: a liveness probe must answer when the database is what is down. | `build.mjs`, `src/lib/build-info.ts`, `routes/health.ts`, `api-zod`, `openapi.yaml` | `curl /api/healthz` shows the SHA of the running build |
| T-05 | ✅ **done** (PR #8). **Build badge in the UI footer.** Quiet, monospaced, from T-04. | `components/layout.tsx` | Rebuild + restart changes the SHA on screen |
| T-06 | ✅ **done** (PR #9). **Classify cell failures.** `failureClass` enum lives in `lib/stt-providers/src/failure-class.ts` (one list, next to the code that produces it) and is set at the throw site by whichever code held the real HTTP status / socket state / vendor body. `insertResult` takes it as a **required** field, so a new failure path cannot be added without its author stating what kind of failure it is. `unknown` is a real value with tests, not a bug. **The register's expected 42/2/1 was wrong** — see the findings log. | `lib/stt-providers/src/failure-class.ts` (new), `types.ts`, `poll.ts`, all 7 adapters, `lib/vapi.ts`, `lib/db/src/schema/benchmark-results.ts`, `lib/run-executor.ts`, `routes/benchmark.ts`, `openapi.yaml` | Real answer, measured live: 30 `retention_expired` / 15 `audio_url_forbidden` / 0 `unknown` |
| T-07 | ✅ **done** (PR #11). **Group failures in the UI; retry only what's retryable.** `GET /benchmark/bulks/:id` now returns `failureBreakdown` — one group per distinct `failure_class` among the bulk's failed cells, with `retryable` decided server-side by `isRetryableFailureClass()` so the UI never re-derives the judgement. The dialog renders each group with a plain-English cause, and the retry button carries the real target count and is disabled (with the reason next to it, not in a tooltip) at zero. **The null class is its own visible group**, labelled "unclassified (predates classification)" and never retryable. The retry count also includes cells that never got a verdict (pending / skipped / cancelled) — they carry no class because they never failed, and leaving them out would disable the button on a bulk with real work left. | `routes/bulks.ts`, `openapi.yaml`, `Bulks.tsx` | Bulk `7d2585da` renders its 45 failures grouped, and the retry button is disabled because none of them is retryable |

---

## Phase 1.5 — validate the judge before anything trusts it

**Added 2026-08-28 from the adversarial architecture review, and promoted ahead of
Phase 2.** No measurement exists of whether the judge's picks correlate with truth.
Feeding an unvalidated judge into rankings (T-17) and memory (T-30) compounds
whatever it gets wrong. This is the cheapest high-value work in the whole register.

| ID | Task | Done when |
|---|---|---|
| T-08 | ✅ **done** (PR #15). **Span adjudication UI shipped** — `SpanAdjudicator` under the provider comparison in the Corpus expanded row: each disagreement span is a play button (cached audio, ±0.75s context), every provider's reading beside it, 1–9 picks / 0 = none / J/K / Space, auto-advance. Stored in `benchmark_adjudications(callId, runId, spanStartMs, spanEndMs, correctProviderId | null, readings, adjudicatedByLabel, adjudicatedAt)` — `runId` and `readings` added beyond the register's sketch so T-09 replays against the exact evidence shown. Spans are a pure function (`lib/scoring/src/spans.ts`, 7 tests) of stored results: the longest provider with word timings anchors alignment and supplies the clock, never the answer. Timings verified against real captured responses: AssemblyAI (ms), Deepgram, Gladia, Cartesia; OpenAI/ElevenLabs are text-only readings. Live: call `9e28a844` run `73c8f03b` → 16 real spans. | A human can adjudicate 20 spans in one sitting without leaving the page |
| T-09 | ✅ **done** (PR #16). **Judge accuracy report shipped** — "Judge vs. human" card at the top of Results: `agreementRate` with `agreements / comparable`, total verdicts, replayed, pending, "none of them" count, judge-no-pick count, per-adjudicator breakdown, replay cost, and the replayed spans with the judge's reasoning. `GET /benchmark/judge-accuracy` (free) + `POST /benchmark/judge-accuracy/replay` (spends OpenAI money, ≤50 spans per request, each span replayed once ever — judge_* columns on `benchmark_adjudications`). "Agree" = the readings the two picks name say the same words (not same provider id). Pure math in `lib/scoring/src/judge-agreement.ts` (6 tests). Live-verified: 3 temp verdicts → replay 3 for 6566 µ¢ → 2/2 comparable agree, 1 none excluded, second replay spent 0; temp rows deleted. | A single number exists for "how often the judge agrees with a human", with its sample size |

**Why this ordering matters:** if the judge scores near chance, T-17 (rank on
adjudicated win rate) and T-30 (memory) must not be built on it. Find that out for
the price of one afternoon, not one quarter.

---

## Phase 2 — better corpus, faster agent

| ID | Task | Done when |
|---|---|---|
| T-10 | ✅ **done** (PR #18). `maxDurationSeconds` on `benchmark_bulks`, `bulk_templates` (nullable, no DB default — pre-band rows honestly read `null` = no cap), `BulkSelectionCriteria`, OpenAPI, and both create dialogs ("Max call duration (s, empty = no cap)"). Defaults `60–120` via `resolveDurationBand` in `lib/bulks.ts`; explicit `null` = no cap; `max < min` → 400 before any insert. Eligibility preview and criteria summary (`60–120s`) honour the cap. Live: resolver with `min=60,max=120` → 24 calls, durations 60–115, all in band (SQL agrees: 24 of 121 corpus calls); no cap → 41. Not created through `POST /benchmark/bulks`: 3 live bulks already sit at `MAX_LIVE_BULKS`, so a test bulk would have evicted a real one. | A bulk with `min=60,max=120` contains only calls in that range |
| T-11 | ✅ **done** (PR #19). `VapiCall.endedReason` + `VapiCall.analysis.{successEvaluation,summary}` (only fields seen on a live response), `benchmark_calls.source_ended_reason` / `source_success_evaluation` (text, verbatim, null = not captured), read at `/benchmark/vapi/import`, exposed on `BenchmarkCall`. Live: imported Vapi call `01a04696` → API reads back `sourceEndedReason: customer-ended-call`, `sourceSuccessEvaluation: "false"`; direct Vapi GET of the same call returns identical values. Verification call deleted afterwards (re-importable). | An imported call reads back with the same `endedReason` Vapi returned |
| T-12 | ✅ **done** (PR #20). `lib/db/migrations/t12-backfill-ended-reason.mjs`, run once against production 2026-08-28 (dry-run first). For every corpus call with a null `source_ended_reason` and a Vapi call id (all 121), re-asked Vapi and copied `endedReason` + `analysis.successEvaluation` verbatim, same rule as T-11. **107 written** (52 `assistant-forwarded-call`, 45 `customer-ended-call`, 7 `assistant-ended-call`, 2 `customer-ended-call-after-warm-transfer-attempt`, 1 `silence-timed-out`); **14 left null** — all `Default`-account calls Vapi refuses as past its retention window (HTTP 400, "This call exceeds your retention window."). 0 outside-window-by-date, 0 404, 0 with a call but no `endedReason`, 0 request failures. One `audit_log` row (`actor_label = t12-backfill`) carries the full count breakdown. No server code changed; nothing to deploy. | Backfill script run once, count reported |
| T-13 | Outcome filters (`includeEndedReasons` / `excludeEndedReasons` / `successEvaluation`) plus a "worth benchmarking" preset that drops voicemail, silence timeouts and misdials. | A bulk can be built from forwarded calls only |
| T-14 | Match-count preview in the create dialog, **above** the cost gate, naming every excluded bucket with its count. | Changing a filter updates the count before any cost is shown |
| T-15 | Parallelise the agent pass. Reuse the bounded-concurrency helper already exported from `run-executor.ts`; add `AGENT_CONCURRENCY` (default 4). Keep the per-call catch. | Agent phase wall-clock drops ~4x; no call verified twice |
| T-16 | Default the import and bulk date lower bound to today − 14 days, labelled with the reason. Earlier is still selectable (cached calls remain runnable). | Default range is stated, not discovered after launch |

---

## Phase 3 — a verdict someone can act on

| ID | Task | Done when |
|---|---|---|
| T-17 | **Rank on adjudicated win rate**, with flag count demoted to the sampling mechanism that chooses which spans get adjudicated. Gated on T-09 showing the judge is better than chance. | Ranking reads the judge's output, which today it does not at all |
| T-18 | Provider correlation matrix. Two Whisper-derived providers agreeing is one vote, not two — surface it so consensus isn't double-counted. | Correlation visible per bulk |
| T-19 | Flags per 100 words + clean-call percentage, computed in the API, never the component. | Rates present in the rankings response |
| T-20 | Headline verdict object (winner, runner-up, margin, vs-production, evidence count, comparability note) + the noise floor. Refuses to name a winner inside noise. | One sentence states the verdict with its evidence count attached |
| T-21 | Verdict headline UI, above the table. | A non-technical reader gets the answer without scrolling |
| T-22 | Per-call disagreement view — the diff spans, not six full transcripts — wired to the T-08 audio component. | Clicking a timestamp plays those seconds |
| T-23 | Trend strip per client, per provider, per bulk. `recharts`, already installed. | A regression between bulks is visible |
| T-24 | Cost framed as the switch decision in money at this client's volume. | "$18/month" appears, not only "$0.0011/min" |

---

## Phase 4 — typed LLM layer

| ID | Task | Done when |
|---|---|---|
| T-25 | BAML behind the existing `judgeCandidates` signature. **Pin the native binary in the same commit.** | A full bulk judged through BAML with zero null picks |
| T-26 | Judge contract tests in CI over the saved scans + the T-08 adjudications. | Green in CI; a prompt change that regresses accuracy fails the build |

---

## Phase 5+ — gated, not scheduled

**Both of these survived the adversarial review only conditionally.** Do not start
either on a date. Start it when its trigger fires.

| ID | Task | Trigger |
|---|---|---|
| T-27 | Per-cell idempotency key `(runId, callId, providerId)`. **Not gated — this is cheap and worth doing regardless.** | Now, any time after Phase 1 |
| T-28 | Workflow DevKit, in-process. | Runs become weekly rather than monthly, **or** client count passes ~10. Below that, T-27 plus retry-failed-cells covers it. |
| T-29 | Audio cache → blob storage. | A second machine needs to run the corpus, or T-28 lands |
| T-30 | Failure-pattern graph + agent self-audit + the T-17 guard rails. | Client count passes ~15. Below that it is ~36 data points a year — over-structure. |
| T-31 | Navigation merge, seven routes → four. | Phases 1–3 shipped and proven. Highest risk item in the register. |
| T-32 | Shareable dated verdict artefact. | Any time after T-21 |

---

## Deferred, by name

| ID | Task | Owner |
|---|---|---|
| T-33 | Word-alignment/diff algorithm in `lib/scoring` — the only genuinely CPU-bound code in the system. **Abhishek's explicit instruction 2026-08-28: leave this for Fable.** Do not solve it here. | Fable |

---

## Open questions — answer before the phase that depends on them

| # | Question | Blocks |
|---|---|---|
| Q-1 | **Can the transcriber actually be switched per assistant in Vapi?** If it's fixed per account, or operationally painful, the verdict is a report nobody can act on. Nobody has verified this. Check the Vapi assistant API. | Phase 3 |
| Q-2 | Which providers share a base model (Whisper derivatives)? Needed for T-18. | T-18 |
| Q-3 | Is `pgvector` enabled on the Supabase project? Only matters if phrase similarity is wanted later. **Verify, don't assume.** | T-30 |

---

## Raised during review, not fixed (no drive-by scope)

| ID | Task | Raised by |
|---|---|---|
| T-34 | `agentCallsJudged` counts `status === "flagged" && judgeCostMicrocents !== null`. A scan judged with a model that has no published rate has a null cost and therefore does not count as judged — even though it *was* judged. Count on the pick/reasoning being present, not on the cost. | T-01 self-review |
| T-35 | The agent-cost estimator's fallback changed from "assume 1c per judge call" to 0.5c (5,000µ¢) in T-01, because 0.4905c is the real observed figure. Once real judged scans exist the fallback stops being used at all — check the estimate against actuals after the first post-T-01 bulk and delete the fallback if history is sufficient. | T-01 self-review |
| T-36 | The last-resort log in `verifyCallWithAgent` (both inserts failed) writes the judge's full reasoning text to the log so the paid-for answer stays recoverable. That reasoning quotes transcript spans and can therefore carry caller names. Logs are local-only today, so this is safe now — but if logs ever ship anywhere, this line needs redaction or a gate. | T-02 self-review |
| T-37 | `writeAudit` after a successful scan write is not itself wrapped. If the audit insert fails, the throw reaches `runAutoAgentVerificationForRun`'s catch and is logged as "auto agent verification crashed for a call" — wrong text, since the scan actually landed. Cheap fix, but it is a third failure meaning and belongs in its own task. | T-02 self-review |
| T-38 | A scan whose finding a human has already resolved carries `status: "approved"`, so it counts in `agentCallsChecked` but in neither `agentCallsFlagged` nor `agentCallsErrored`. That was true before T-03 too, so nothing regressed — but the coverage line now reads "63 checked, 0 flagged, 0 errored" for a bulk whose findings were all resolved, which understates the work done. Needs a third count or a "resolved" state, decided deliberately. | T-03 self-review |
| T-40 | ✅ **done** (PR #10). **Backfilled `failureClass` on the 168 pre-existing failed rows.** One-time migration, `lib/db/migrations/t40-backfill-failure-class.mjs`, guarded to `status = 'failed' AND failure_class IS NULL`, single transaction, and it **asserts the T-06 ground truth for bulk `7d2585da` (30 `retention_expired` / 15 `audio_url_forbidden` / 0 anything else) inside the transaction and rolls back on disagreement** — a wrong rule cannot land. Result: **143 classified** (70 `retention_expired`, 56 `audio_url_forbidden`, 16 `provider_timeout`, 1 `unknown`), **25 deliberately left null**. Reading the stored `error_message` is exactly the technique T-06 removed from the live path, which is why this is a `migrations/` file that runs once and is then finished, not code that ships. | T-06 self-review |
| T-41 | `matchKnownFailure(errorMessage)` in `routes/benchmark.ts` still parses error text on every read to produce the human-readable diagnosis and suggested fix shown in the UI. That is a different job from classification and was left alone. Once `failureClass` is populated everywhere (T-40), the diagnosis text should be driven off the class instead, so there is one cause of record rather than two things reading the same sentence. | T-06 self-review |
| T-42 | A provider's own 401/403 is currently `unknown`. `ProviderConfigError` already covers a *missing* key, but a **present, wrong or revoked** key produces a 401 from the vendor and lands in `unknown` — retryable, which it is not. Needs either a `provider_auth` class or an explicit decision to leave it unclassified. | T-06 self-review |
| T-43 | ✅ **done** (PR #12). **The executor now refuses permanently-dead cells itself.** `executeBenchmarkRun` used to have `alreadyOk` as its only skip condition, so every retry re-sent the `retention_expired` / `audio_url_forbidden` cells to a paid provider again, forever. It now also skips a cell whose **latest** row is `failed` with a class `isRetryableFailureClass()` says no to — including a **null** class (predates classification; nothing ever established it could succeed), which is exactly what T-07's UI already tells the user about those cells. `unknown` stays retryable: classified, cause not yet identified. Those rows are left untouched (excluded from the stale-row delete) so the failure stays visible in `/results` and in the breakdown, counted into `attemptedCells` so an all-dead re-run still finalizes as `failed` rather than `complete`, given their own note line instead of being folded into the "can be retried" one, and recorded as `permanentlyFailedCells` in the audit row. Also drops a call from the audio pre-pass when every one of its cells is done, so a no-op retry stops re-downloading audio it will not use. | T-07 self-review |
| T-44 | The retry target count adds `cellsPending + cellsSkippedPendingReview + cellsCancelled` to the retryable-failure count, because those cells have no failure class (they never failed) and omitting them would disable the button on a bulk with real work left. But `cellsPending` is derived as `plannedCells - cellsWritten`, so it also counts cells that were never planned to run — the number is a good-enough gate for enabling a button and is **not** a promise of exactly what a retry will attempt. If that count is ever shown as a cost estimate, it needs to come from a real query instead. | T-07 self-review |
| T-45 | ✅ **done** (PR #13). **A re-execution no longer re-judges calls whose evidence did not change.** `runAutoAgentVerificationForRun` now skips a call that already has a finished scan row for this run (`clean` / `flagged` / `approved` / `rejected`) unless the calling execution gave that call a **new** ok cell — the executor tracks exactly which calls gained one and passes the set in. `error` and `scanning` rows do not count as finished and are redone. No schema change: the "did the candidate set change" question is answered by the execution that just ran, not by storing the candidate set. | T-43 self-review |
| T-46 | ✅ **done** (PR #14). **`retryBulkFailedCells` now selects runs by the executor's own retryability rule.** A complete run is re-executed only if the latest row of some cell is `skipped_pending_review` or a `failed` row whose class `isRetryableFailureClass()` accepts (null and out-of-enum values count as permanent, same as T-43). A non-complete run (failed / queued / stuck running) is still always re-executed, unchanged. | T-43 self-review |
| T-47 | **Disagreement is reference-relative, not consensus-relative.** `buildDisagreementSpans` marks a position disputed when any provider differs from the *reference* (the longest timed provider). When four of five say "are" and the reference alone says "were", the span is right but `agreesWithReference` is false for the four — the UI shows it neutrally, but a consensus vote per position (as `computeCrossProviderDisagreement` already does) would rank readings better and let T-09 report "judge vs human" and "majority vs human" side by side. | T-08 self-review |
| T-48 | **OpenAI and ElevenLabs contribute no word timings.** OpenAI is requested with `response_format: json` (text only; `verbose_json` + `timestamp_granularities` may return words for whisper-1 but not gpt-4o-transcribe — must be checked against the real API, not docs). ElevenLabs' stored words carry only `speaker_id` in the captured sample. A call where only those two succeed reads `no_word_timings`. Decide per provider whether timings are requestable, and re-verify with a real response before extending `timed-words.ts`. | T-08 self-review |
| T-49 | ✅ **done** (PR #17). `setActorLabel` in the client, `x-actor` on every request, one `lib/actor.ts` for sidebar + client. Live: UI verdict → `adjudicated_by_label = Abhishek`, audit row same. Historical `unknown` rows left as-is. Original finding: **Verdicts (and bulk launches) are recorded as `by unknown`.** The UI shows "Abhishek · Curator" in the sidebar but the generated API client sends no `x-actor` header, so `actorFromRequest` falls back to `unknown` on every write — seen live on the first UI adjudication (`adjudicated_by_label = unknown`) and already true of `launchedByLabel` on bulks. One place to fix: the client's `customFetch` should send the signed-in label. Matters for T-09, which reports agreement "with a human" — it should be able to say which one. | T-08 self-review |
| T-50 | **Bulk templates cannot be deleted.** There is no `DELETE /benchmark/bulk-templates/{id}` — the T-10 verification templates had to be removed with SQL. A template that is wrong (bad band, wrong providers) is permanent from the UI. | T-10 self-review |
| T-51 | **No `GET /benchmark/calls/{callId}`.** The path exists only as PATCH; reading one call means fetching the whole list. Harmless at 121 calls, wasteful at 1,000. | T-11 self-review |
| T-52 | **The 22 original corpus calls have no `source_started_at`** (imported before that column existed; `source_provider` still says `manual` although every one has a real Vapi `source_call_id`). Any future "inside the 14-day window" logic keyed on that column silently skips them — T-12 had to judge the window on Vapi's own `startedAt` instead. A one-off backfill of `source_started_at` (and arguably `source_provider = vapi`) from the same Vapi response would fix it; the 14 past-retention calls can no longer be backfilled and would stay null. | T-12 |
| T-39 | The badge reports the **API** bundle's commit. The UI itself is a separate Vite build and can be served stale from a browser cache with no signal at all — a second, real version of the same failure this task exists to kill. Stamping the UI build (Vite `define`) and showing both, or showing one only when they disagree, is a deliberate design call, not a drive-by. | T-05 self-review |

## Findings log

Append anything learned mid-task here rather than losing it to a compaction.

- **2026-08-28 (T-08): browser-verified after merge on `19e3f13`.** Corpus →
  call `9e28a844` expanded → "Hear the disagreements": 16 spans, `0/16
  decided`, timed by AssemblyAI, readings with 1–5 keys and a 0 = none row.
  A synthetic keydown `2` on the focused list wrote a real verdict (`1/16
  decided · AssemblyAI`), which was then deleted from the table. Clicking a
  span's play button seeked the audio to `startMs − 0.75s` (3.87s, confirmed
  on the element) but `play()` did not start under the bridge — the bridge's
  clicks are `isTrusted: false` and Chrome's autoplay policy needs a real
  gesture. **Playback still needs one real click from Abhishek to confirm.**
  The stop-at-end watch could not be exercised for the same reason.

- **2026-08-28 (T-08): orval naming collisions, twice.** A requestBody
  component named `<OperationId>Body` collides with the zod schema of the same
  name (fix: name the component something else — `SpanAdjudicationRequest`).
  An operation with BOTH a path param and query params gets a zod
  `<OperationId>Params` (path) and a client type `<OperationId>Params` (query)
  — same name, `export *` fails. Fix used: make the spans route query-only
  (`/benchmark/disagreement-spans?callId&runId`), the shape `listAgentScans`
  already has. Also: `type: integer` emits `zod.int()`, unsupported in zod 3 —
  use `number` (T-07 hit this too).
- **2026-08-28 (T-08): `drizzle-kit push` from the worktree worked** (classifier
  did not block it, unlike the T-40 migration script). `benchmark_adjudications`
  exists in the live DB now. The one verification row written during testing
  (`adjudicated_by_label = 't08-verify'`) was deleted afterward — the table is
  empty at merge, so T-09 starts from zero real verdicts.

- **2026-08-28 (T-12): Vapi signals "past retention" as HTTP 400, not 404** — 14 of
  the 22 original `Default`-account calls came back `400 {"message":"Your
  subscription plan only covers the last 14 days of call history. This call exceeds
  your retention window."}`. Same sentence `VapiRequestError` already matches on the
  live path. The other 8 originals are still inside the window and backfilled fine.
  Corpus outcome mix after backfill: 52 forwarded / 45 customer-ended / 7
  assistant-ended / 2 after-warm-transfer / 1 silence-timed-out / 14 unknown (null).
  `successEvaluation` is present on 92 of 107 (`"true"` 76, `"false"` 16); 15 calls
  Vapi returned with an `endedReason` but no evaluation at all — so null there is
  common, and T-13's `successEvaluation` filter must treat null as its own bucket.
- **2026-08-28 (T-11): Vapi's `successEvaluation` is the *string* `"false"`, not a
  boolean** — seen on the live import of call `01a04696`. Storing it verbatim as
  text was the right call; a boolean column would have had to guess at parsing.
  The first probe call (`01a03b89`) had `analysis: { summary }` with no
  `successEvaluation` at all, so absence is normal and null must stay
  "not captured", exactly as the register warned.

- **2026-08-28 (T-10): the corpus is mostly outside the default band.** Of
  121 corpus calls, 24 sit in 60–120s (min 2s, max 445s); 41 are ≥60s at all.
  So the default band roughly halves what an unfiltered bulk would take —
  which is the point, but the first bulk created after this ships will look
  smaller than the last one, and that is by design, not a bug. Also: the
  live-bulk cap (`MAX_LIVE_BULKS = 3`) was already full, so verification
  used the resolver directly rather than `POST /benchmark/bulks` — creating
  a test bulk there would have evicted a real one with its runs and scores.
  Worth remembering before any future "just create a throwaway bulk" check.

- **2026-08-28 (T-49): typecheck-clean is not verified.** First attempt put
  `setActorLabel(...)` inside `main.tsx`'s `if (apiBaseUrl)` block — never
  runs in local dev — and only the live DB check (`adjudicated_by_label`
  still `unknown`) caught it. Also learned: Vite's watcher did not re-stamp
  `lib/api-client-react` edits until the files were `touch`ed; check the
  `?t=` stamp on the served module before trusting an HMR'd change.

- **2026-08-28 (T-09): the judge, given only what the human saw, agreed 2/2
  on the test spans** — and one of those was human=Deepgram, judge=Gladia,
  both reading "are": the text-equality definition of "agree" is what kept
  that from being a false disagreement. The judge also confidently picked
  AssemblyAI's "uh" on the span the human marked "none of them" — evidence
  that "none" verdicts must stay outside the rate (the judge cannot say it).
  Replay cost ≈0.22¢ per span on gpt-4o. `benchmark_adjudications` is empty
  again after verification; the real number starts at Abhishek's first
  verdicts. T-49 matters here: until the client sends `x-actor`, the
  per-human breakdown will read `unknown`.

- **2026-08-28 (T-43 / T-45 / T-46): all three live-verified on `f16133a`.**
  Re-executed run `73c8f03b` (bulk `1a8e14b2`, 14 null-class failures, 236 ok).
  Result: log line `T-43: skipping cells whose recorded failure a re-run cannot
  fix` fired; the 14 failed rows kept their exact ids and `created_at`; zero new
  result rows; audit `afterState` carries `permanentlyFailedCells: 14,
  failedCells: 0`; run notes now read `14 cell(s) left as they were: …` (the
  bulk-detail endpoint does not expose run notes — read from the DB). Then
  `POST /retry-failed` on the same bulk: `retriedRunIds` empty, bulk stayed
  `partial`, `completedAt` untouched (T-46). **One correction to the earlier
  entry:** this run had NO scan rows at all (it predates the auto-agent path),
  so T-45 correctly did not skip — the judge ran for the first time on all 50
  calls (~37c OpenAI, `agentCallsJudged: 50`). Real first-time coverage, not a
  duplicate; T-45's skip is exercised by any FUTURE re-execution of this run.
  Also learned: the API already recovers an interrupted run by itself on boot
  (`recovering interrupted run after restart`) — bulk `340400b2` resumed
  without a manual Execute. **The T-40 migration is STILL not run** — the
  classifier blocked it a third time; every failed row is still null.
- **2026-08-28 (T-43): a cell's state is its LATEST row, not any row.**
  Duplicate rows for one `(provider, call)` pair exist in history (the
  stale-row cleanup that fixed that landed 2026-08-25, after those rows were
  already written), so "is this cell permanently dead" is decided off the most
  recent row by `created_at`, not off "does any failed row exist". One live
  consequence, accepted deliberately rather than coded around: if a cell's
  latest row is `cancelled` but an older row was a permanent failure, the cell
  is retried once — it fails permanently again, writes a fresh `failed` row,
  and is skipped from then on. One extra billing in a rare historical shape,
  and it self-corrects; blocking it would mean treating a cancellation as
  evidence of a failure, which it is not.

- **2026-08-28 (T-07): the T-40 migration is merged but has NOT been run.**
  Verified live against the running API on the day T-07 shipped: every one of
  bulk `7d2585da`'s 45 failed cells still reads `failureClass: null`, and all
  315 successful cells read null too (correctly — a cell that succeeded has no
  failure class). So the breakdown T-07 renders today is one group of **45
  unclassified**, not the 30/15 the acceptance criterion names. That is the
  correct rendering of the corpus's actual state, and it exercises exactly the
  null path the register said had to stay visible — but the 30/15 acceptance
  is **unverified until the migration runs**. The command is blocked for the
  agent by the permission classifier (it sources `.env`), so it has to be run
  by hand from the repo root:
  `set -a && . artifacts/api-server/.env && set +a && node lib/db/migrations/t40-backfill-failure-class.mjs`
  Nothing else in T-07 depends on it; the breakdown re-reads the column on
  every poll and will regroup itself the moment the rows are written.


- **2026-08-28 (T-40): `null` and `unknown` are different answers, and the
  difference costs money.** `unknown` is *classified* — and per
  `isRetryableFailureClass` it is **retryable**. `null` means "written before
  classification existed, and the surviving text does not say why" — no claim
  made. 25 historical rows say only `Gladia submit returned HTTP 400` (16) and
  `Deepgram returned HTTP 400` (9). They are almost certainly the same dead
  Supabase audio URL as their neighbours in the same runs, but the stored text
  does not say so. Writing `unknown` on them would have marked 25
  permanently-dead cells retryable, and T-07's retry button would then offer to
  spend real provider money re-running calls that can never succeed. They are
  null on purpose.
- **2026-08-28 (T-40): a provider's own sentence can still be evidence.** 16
  AssemblyAI rows read `Download error, got HTTP 403, Forbidden, unable to
  download <our supabase URL>`. That is AssemblyAI's text, not ours, from
  before adapters were handed bytes instead of a URL — but the class is
  *documented* as covering a 403 "either to our own fetch, or to the provider's
  fetch of a URL we handed it", and the status is stated explicitly. Classified,
  not inferred. Contrast the bare `... returned HTTP 400` rows above, which
  state no cause and were left alone.
- **2026-08-28 (T-40): the whole 168-row shape, for reference.** 70
  `retention_expired` (Vapi's 14-day sentence, in a 400), 56
  `audio_url_forbidden` (40 our own `fetchAudioBytes` 403, 16 AssemblyAI's
  403), 16 `provider_timeout` (Cartesia's WebSocket deadline), 1 `unknown`
  (Cartesia closed clean and never sent a final segment — the one row in the
  corpus that genuinely earns the class), 25 null.

- **2026-08-28 (T-06): the register's expected `42/2/1` was wrong.** Measured against
  the real database: bulk `7d2585da` has **45** failed cells (that number was right)
  across **9** calls × 5 providers, and the true split is **30 `retention_expired` /
  15 `audio_url_forbidden` / 0 `unknown`** — six calls past Vapi's 14-day window,
  three calls whose Supabase archive URL answers 403. Verified twice, independently:
  once from the stored error text, and once by running the **real** audio resolver
  against the live Vapi API and live Supabase storage for all 9 calls and reading the
  class off what it threw (the exact expression `run-executor.ts` now uses). Both
  agree. No provider was called, so this cost nothing.
- **2026-08-28 (T-06): across all bulks there are 168 failed cells, and the shapes are
  narrower than expected** — 70 retention, ~44 audio-URL-403 (some reported by the
  provider rather than by us: Gladia's "Failed to fetch audio from the provided URL",
  Deepgram's `REMOTE_CONTENT_ERROR ... 403 Forbidden`, AssemblyAI's "Download error,
  got HTTP 403" inside a **200** body), 16 Cartesia response timeouts, and exactly
  **1** genuinely unclassifiable row: Cartesia closing cleanly (code 1000) having sent
  one final segment with empty text. That last one is why `unknown` has to stay a real
  value rather than a placeholder nobody expects to see.
- **2026-08-28 (T-06): the one place vendor text is still matched, and why.** Vapi
  signals a lapsed retention window as a plain HTTP 400 with
  `{"message":"Your subscription plan only covers the last 14 days of call history..."}`
  — no code, no flag, no header distinguishes it from any other bad request. So that
  sentence is matched **once, in `vapiGet`, holding the real Response**, and the class
  it yields is what travels from then on. That is the throw site, not "regexing a
  message afterwards": the rule being enforced is that nothing downstream ever
  re-derives a cause from an error string we composed ourselves.
- **2026-08-28 (T-06): `failureClass` on `insertResult` is required, not optional,
  on purpose.** Optional would have let a future failure path silently write null.
  Required means adding one forces its author to answer "what kind of failure is
  this?" — `null` for a non-failure, `"unknown"` for a real failure nobody has
  classified, but a deliberate choice either way. Compile-time enforcement of a
  documentation rule that would otherwise decay.

- **2026-08-28:** ranking aggregation contains **zero** references to agent scans —
  the judge's opinion is decorative today. T-17 is therefore a new capability, not
  a refactor.
- **2026-08-28 (T-01):** the migration recovered more than it fixed. `benchmark_scores`
  had 731 rows but only 597 had `cost_cents`; all 731 had the exact `cost_per_minute`.
  Backfilling from the exact column gave cost data to **134 rows that previously had
  none**. And the old integer rounding *understated* bulk `7d2585da` by 3.8% ($2.90
  shown, $3.0135 real) — rounding half-up on ~0.90c cells cut both ways, so the error
  was not a consistent overstatement as assumed when the PRD was written.
- **2026-08-28 (T-02):** both failure paths proved against the real database and the
  real judge, with a throwaway probe (deleted after use, plus its scan and audit rows).
  Forcing the write to fail with a CHECK constraint: the row still lands `status:
  flagged`, 1,202 characters of reasoning kept, the pick kept, cost null, and
  `errorMessage` reading `scan_write_failed: ...`. Forcing the judge to fail with a
  bogus model: `status: error`, `errorMessage` reading `judge_failed: The model ... does
  not exist`. The pick lookup is now best-effort on its own — losing it costs the link
  to a result row, never the answer.

- **2026-08-28 (T-03):** the split was proved against the real database through the
  real HTTP route (a second server instance on port 8188, so the running one was left
  alone). Bulk `7d2585da` is the exact case the task was written for: the old build
  reported `agentCallsFlagged: 63` for a bulk where **nothing was flagged and the judge
  crashed 63 times** — the T-01 casualty, read back as 63 findings. New build on the
  same untouched data: `agentCallsFlagged: 0`, `agentCallsErrored: 63`,
  `agentCostMicrocents: null`. Flipping 3 of those rows to `flagged` with a real cost
  (4,905µ¢ each) then gave `flagged: 3, errored: 60, judged: 3, cost: 14,715µ¢`, and
  restoring them returned every number to the original — verified, 0 rows left holding
  the probe cost. `GET /benchmark/rankings` contains no reference to
  `benchmark_agent_scans` at all, so "the ranking table is unaffected" is structural,
  not just observed.

- **2026-08-28 (T-04):** the stale-build failure mode was reproduced deliberately and
  is now visible. Rebuilt the bundle without restarting: the on-disk bundle stamped
  `builtAt 23:44:42`, while the running process kept answering `builtAt 23:44:17`,
  `startedAt 23:44:26`. **`builtAt` newer on disk than the one the server reports is
  the exact signal for "rebuilt but not restarted"** — the thing that silently wasted
  two earlier verification passes. Live response also confirmed 6 configured
  providers by name (assemblyai-universal, cartesia-ink-whisper, deepgram-nova-3,
  elevenlabs-scribe, gladia-solaria, openai-gpt-4o-transcribe); Speechmatics is
  correctly absent, having no key. No key material appears in the payload — only
  provider ids and a boolean-by-omission of whether the env var is non-empty.

- **2026-08-28:** measured per-provider latency (bulk `7d2585da`): Cartesia 128.8s,
  Gladia 15.3s, AssemblyAI 13.0s, Deepgram 3.5s, OpenAI 3.1s. **Cartesia is 79% of
  all vendor wait.** Own code is ~0.1% of runtime — which is why no language rewrite
  is on this register.

- **2026-08-28 (T-05):** badge verified live in the browser against the real dev
  server, in all three states. Clean: `API bc481f0f4194`, muted grey, green dot.
  Rebuilt the API from a dirty tree and restarted it — the badge changed on screen to
  `API bc481f0f4194-dirty` in the warning colour, which is the task's done-when
  condition met directly. Killed the API: `API unreachable`, 885ms after mount.
  **Two react-query behaviours found the hard way, both about a hidden tab:**
  (1) `refetchInterval` does not run while the tab is hidden, so the badge updates on
  the poll only when someone is actually looking at it — which is the moment that
  matters, and `refetchOnWindowFocus: true` covers the return from the terminal;
  (2) retries are *paused* while the tab is hidden, so with the app-wide `retry: 2`
  the badge sat on `checking...` for 30s+ with the API already dead instead of ever
  reaching the error state. Fixed by setting `retry: 0` on this query only — for a
  liveness badge the next poll is the retry, and a badge that retries is a badge that
  lies. The Vite dev proxy itself is not the cause: with the API down it returns 500
  in 13ms.
