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
| T-13 | ✅ **done** (PR #21). `BulkSelectionCriteria.includeEndedReasons` / `excludeEndedReasons` / `successEvaluation` (verbatim string match), applied in `resolveCriteriaCallIds` and in the dialog's eligibility preview. Rule, stated in code and spec: **a call with no captured outcome (null) never passes either list** — `NOT IN` is written with an explicit `isNotNull` so that is a decision, not three-valued-logic luck. "Worth benchmarking" preset button (`WORTH_BENCHMARKING_ENDED_REASONS`: customer-ended-call, assistant-forwarded-call, assistant-ended-call, assistant-said-end-call-phrase) + only-these / all-except-these toggle; reason checklist is built from the corpus's real distinct values with counts. Live (worktree build, real DB): resolver vs SQL — forwarded-only 52/52, preset 104/104, exclude silence 106/106 (drops 1 silence + 14 unknown), success=false 16/16, forwarded∧true 45/45. Template with `includeEndedReasons` + `successEvaluation` round-trips through POST/GET unchanged; row deleted afterwards. | A bulk can be built from forwarded calls only |
| T-14 | ✅ **done** (PR #22). `POST /benchmark/bulks/preview` dry-runs creation through the same matcher `createBulk` freezes with (`resolveCriteriaSelection` — "who" filters in SQL, then one classifier for window / band / outcome / success / retention returning a named bucket or "selected"; invariant `inScope = matched + Σ excluded`). Dialog shows count → every bucket by name with count → cost (STT + agent, gate verdict), cost only once a provider is picked; client-side matcher copy deleted. Verified live: 6 previews equal direct SQL counts (24 / 52 / 106 / 9 and buckets 80 / 22 / 64); bad band → 400. Match-count preview in the create dialog, **above** the cost gate, naming every excluded bucket with its count. | Changing a filter updates the count before any cost is shown |
| T-15 | ✅ **done** (PR #23). `runAutoAgentVerificationForRun` drains its calls through `drainWithConcurrency`, `AGENT_CONCURRENCY` wide (default 4, clamp 16, `envInt`, read inside the function because `agent-verify.ts` ↔ `run-executor.ts` import each other). Per-call catch kept; `byCallId` is a Map so no call is a work item twice. Logs `calls / concurrency / wallClockMs` per pass. Measured live on an 8-call run (7 flagged): 27.9 s serial → 10.4 s at 4 (2.7×; two rounds of 4, so ~4× needs more calls), 1 scan row per call each pass, identical statuses; 16 probe rows (8.6¢) deleted after. Parallelise the agent pass. Reuse the bounded-concurrency helper already exported from `run-executor.ts`; add `AGENT_CONCURRENCY` (default 4). Keep the per-call catch. | Agent phase wall-clock drops ~4x; no call verified twice |
| T-16 | ✅ **done** (PR #24). `stt-benchmark/src/lib/retention.ts` (`VAPI_RETENTION_WINDOW_DAYS`, reason sentence, `defaultDateLowerBound()`); Import "From date" pre-fills today − 14 with the reason under it (no `min`, earlier selectable); bulk + template window default `14` with the reason (raise or clear to go further back — template's old `7` folded into the same default); Corpus reads the shared constant. Browser-verified: `/sources` From = 2026-08-15 on 2026-08-29; New bulk window = 14, preview "20 match · 64 shorter · 22 no start date · 15 longer". Default the import and bulk date lower bound to today − 14 days, labelled with the reason. Earlier is still selectable (cached calls remain runnable). | Default range is stated, not discovered after launch |

---

## Phase 3 — a verdict someone can act on

| ID | Task | Done when |
|---|---|---|
| T-17 | **Rank on adjudicated win rate**, with flag count demoted to the sampling mechanism that chooses which spans get adjudicated. Gated on T-09 showing the judge is better than chance. | Ranking reads the judge's output, which today it does not at all |
| T-18 | ✅ **done** (PR #25). `lib/scoring/src/provider-correlation.ts` (pairwise word agreement per pair averaged over shared calls **plus `excessAgreement`** = pair agreement − each side's mean agreement with everyone else; raw agreement alone can't tell "same engine" from "both correct" — live every pair is 0.78–0.94 — so `CORRELATED_EXCESS_AGREEMENT = 0.03` is the first-cut rule, documented as such). `GET /benchmark/bulks/{id}/provider-correlation`; `ProviderCorrelationCard` on Results one-bulk view under the cost line. Live on all 3 bulks: AssemblyAI + Gladia top pair every time (+3.3…+4.7 pts), OpenAI gpt-4o negative vs everyone (most independent). 6 unit tests (scoring 70/70). Provider correlation matrix. Two Whisper-derived providers agreeing is one vote, not two — surface it so consensus isn't double-counted. | Correlation visible per bulk |
| T-19 | ✅ **done** (PR #26). `benchmark_rankings.peer_flags_per_100_words` + `clean_call_rate` (pushed); computed in `aggregateRankingRows` from the same peer-only flags the composite uses, over the provider's own `normalizeTranscript` words; null when nothing scored (cells with null `peerFlagCount` excluded, never counted clean). On `Score` in `GET /benchmark/rankings`; two sortable Results columns + CSV fields read them. Live: 3 bulks recomputed, 115 rows each carry rates; one group cross-checked vs SQL (0.56 vs ≈0.57, clean 50% exact). Flags per 100 words + clean-call percentage, computed in the API, never the component. | Rates present in the rankings response |
| T-20 | ✅ **done** (PR #27). `GET /benchmark/bulks/{id}/verdicts` → one `HeadlineVerdict` per assistant group: `decision` (`winner`/`too_close`/`too_few_calls`/`insufficient`), winner, runner-up, `leaderProviderId`, `marginPct`, `vsProductionPct`, `productionProviderId`, `evidenceCalls`, `provisional` (<20), `callsToSettle`, `noiseFloor {sharedCalls, difference, ci95, withinNoise}`, `confidenceComparable {reporting, total}`, `rates[]`, `sentence`. Metric = peer flags/100 words pooled per provider (T-19 basis). Noise floor = seeded paired bootstrap (1,000 resamples) over the calls the top two both scored; winner only when the 95% interval excludes zero. **Caught live in this PR:** 1 shared call → bootstrap resamples the same call → interval collapses to a point → "2% cleaner, based on 1 call" named a winner. Now `MIN_SHARED_CALLS_FOR_VERDICT = 5` gates the floor (`too_few_calls`) and `callsToSettle > 500` reads "effectively tied". Production baseline resolved in the API (most common Vapi vendor/model per group → provider row by name+model); confidence-reporting providers decided from one real response each via `extractProviderConfidenceWords`. Pure core `lib/scoring/src/verdict.ts` (14 tests, scoring 84/84). Live on all 3 bulks: **zero winners** — 20+ groups/bulk are 1–2-call assistant groups (`too_few_calls`), the three 9-call groups are `too_close` (gaps 0.001–0.003 flags/100w). Headline verdict object (winner, runner-up, margin, vs-production, evidence count, comparability note) + the noise floor. Refuses to name a winner inside noise. | One sentence states the verdict with its evidence count attached |
| T-21 | ✅ done — PR #28 (`deccb3c`). `components/verdict-headline.tsx`: `BulkVerdictBanner` at top of Results (above cost/correlation/tables) — one headline sentence for whole bulk, decision chip (Clear winner / Too close to call / Too few calls / Not enough providers), per-decision counts, scored-call total, list of any group with a named winner + its T-20 sentence, one-line legend of what "winner" means. `GroupVerdictHeadline` inside each assistant card above its table: chip + evidence line (calls, provisional, shared-by-top-two, ~calls-to-settle) + the group sentence. Single fetch of `GET /benchmark/bulks/{id}/verdicts` per bulk; single-bulk view only (all-time view has no noise floor → shows no verdict rather than a wrong one). Winner text only ever comes from T-20; missing verdict renders "No verdict computed", never blank. Verified live in browser on newest bulk: banner "No clear winner in this bulk yet: 20 of 22 assistant groups have fewer than 5 calls shared…", 22 group headlines. Typecheck clean. | A non-technical reader gets the answer without scrolling |
| T-22 | ✅ **done** (PR #29, `63f62be`). **Disagreement reading view shipped** inside `SpanAdjudicator` (Corpus expanded row, "Hear the disagreements"): the call once, as one flowing reading from the reference provider's normalized words, with each disputed stretch swapped inline for a timestamped play chip (warning-tinted until adjudicated, then success; primary while active/playing; hover lists the readings that differ). Clicking a chip plays those seconds through the same T-08 `<audio>` (±0.75s context) and selects the span in the list below, which scrolls into view. Backend: `buildDisagreementSpans` now returns `referenceWords`; response exposes it plus per-span `referencePositions` (spec + codegen; test asserts the slice round-trips to the reference reading). Corpus provider rows keep their flag chips; full transcript tucked behind a `<details>` toggle. Live: call `9e28a844` → 298 words, 16 chips inline, chip 3 = `the power's` vs OpenAI `the power is` / Cartesia `the powers`, active row synced. | Clicking a timestamp plays those seconds |
| T-23 | ✅ **done** (PR #30, `fad6198`; axis/label polish `direct`). `GET /benchmark/trend` → finished bulks (complete/partial, ordered by completedAt else createdAt) + one summed cell per (bulk, client account label, assistant, provider): peer flags, normalized words, scored calls, clean calls — totals only, same basis as T-19 (verified live: 110 per-assistant cells vs stored `peerFlagsPer100Words`, 0 mismatches). Pure `buildTrend(cells, bulks, scope)` in `lib/scoring/src/trend.ts` (7 tests, scoring 91/91) pools exactly and yields one series per provider: point per bulk (null when not scored, never 0), latest-vs-previous delta in flags/100w, direction worse/better/flat (flat band 0.05) or `unknown` when either bulk has <5 scored calls. `components/trend-strip.tsx`: recharts line chart (x = bulks oldest→newest, same-day bulks get a time in the label, dashed "this bulk" marker, tooltip with rate + calls) + delta list in words; `ClientTrendSection` picker over account labels (null = visible "Unlabelled account"), defaults to the open bulk's client. Results: client strip under the correlation card (both views) + compact strip in every assistant card. Live: Land And Apartment, 3 bulks, Cartesia 0.23 → 0.35 → 0.22 reads "−0.14 better, 41→56 calls"; others flat. | A regression between bulks is visible |
| T-24 | ✅ **done** (PR #31, `1a08d1c`; client-wide line + cost-only sentence `direct`). `GET /benchmark/volume?accountLabel=` reads the account's real Vapi calls over its **14-day retention window** (verified live: 30 days → HTTP 400 "Your subscription plan only covers the last 14 days"), total + per assistant; pages newest-first with the page's oldest `createdAt` as the next `createdAtLe` (new `fetchVapiCallPage`); cached fresh 15 min / stale up to 6 h with background refresh / in-flight deduped / warmed at boot (cold fetch of Land And Apartment = 131 s, 3,448 calls, 3,030 min, 46 assistants; Default 36 calls). Results: per-card **Volume** line (calls, min, ≈ min/month *projected*), **$/month** column = provider **list** $/min × projection, production sentence gains money: real comparison when production is a candidate, else "Cost alone … quality not compared" from the catalog price; client-wide line under the trend picker (Land And Apartment ≈ 6,495 min/month → Cartesia $14/mo … Gladia $66/mo). No volume basis renders "—" with the reason, never $0; `truncated` shown as "at least". | "$18/month" appears, not only "$0.0011/min" |

---

## Phase 4 — typed LLM layer

| ID | Task | Done when |
|---|---|---|
| T-25 | ✅ **done** (PR #32, `743fc58`). `judgeCandidates` keeps its signature; underneath it calls BAML `JudgeCandidates` (`artifacts/api-server/baml_src/judge.baml`, generated `src/baml_client/`) with a `@@dynamic PickedProvider` enum populated per call from the candidate IDs, so the pick is a validated type and a non-candidate answer throws (`BamlValidationError` → `judge_failed` scan row) instead of silently nulling; regex fallback `inferPickFromReasoning` deleted. Tokens from BAML `Collector`, priced by the existing cost table. `@boundaryml/baml` pinned `0.226.1` plus `optionalDependencies` for `darwin-arm64` and `linux-x64-gnu` at the same version; generator version in `generators.baml` must match. Package external in `build.mjs`; BAML logger set to `warn` unless `BAML_LOG`. `analyzeFailure` untouched (PRD Part C: judge only). Acceptance: re-executed run `4ba80a99` (bulk "Land and apartment ( monthly check)", 72 calls, 5 providers) — 63/63 flagged calls judged through BAML, **0 null picks**, 0 `judge_failed`, 0 validation errors; 138,679 prompt / 12,444 completion tokens, 471,151 µ¢ ≈ $0.47 on gpt-4o. Raised T-63, T-64. | A full bulk judged through BAML with zero null picks |
| T-26 | ✅ **done** (PR #33, `c658907`). **Judge contract in CI, offline.** `src/judge-contract-record.ts` (live, dev machine, `pnpm run judge:contract:record`) re-judges every T-08 adjudication + a deterministic 30-scan sample (latest flagged scan per call, by call id) with the current prompt and writes `src/lib/__fixtures__/judge-contract.json` — ids, provider ids, picks, booleans only, no transcript/reasoning text. `src/lib/judge-contract.test.ts` (vitest, CI, no key, no DB) pins the fixture to sha256(`judge.baml` + `clients.baml` + `JUDGE_MODEL`): a prompt edit without a re-record fails with the re-record command in the message; ≥20 scans, 0 null picks, every pick ∈ candidates (T-25 acceptance made permanent); human agreement ≥60% asserted once ≥10 comparable verdicts exist, **visibly skipped until then — 0 adjudications exist in the DB today** (T-09 was verified on temp rows). Floors live in the test, not the fixture. Recorded: 30/30 picks, 22/30 same as stored (informational), $0.22. CI green (run 33213173837, first since PR #20): needed T-53's pin fix plus pnpm 11's `allowBuilds` (old keys gone; `@scarf/scarf` = baml's install telemetry, set false). Raised T-65–T-68. | Green in CI; a prompt change that regresses accuracy fails the build |

---

## Phase 5+ — gated, not scheduled

**Both of these survived the adversarial review only conditionally.** Do not start
either on a date. Start it when its trigger fires.

| ID | Task | Trigger |
|---|---|---|
| T-27 | ✅ **done** (PR #40). Unique index `benchmark_provider_call_results_cell_key` on `(run_id, call_id, provider_id)`; every result write goes through one `upsertResult()` — a non-ok attempt is replaced in place (same `id`, so scores/picks never dangle; `created_at` moves to the new attempt), an `ok` row is never overwritten except by its own scoring-failure path, and a duplicate `ok` from a concurrent executor is logged and discarded instead of stacking a second row + score. Live table had 1,161 rows, 0 duplicate cells, so the index creates cleanly. **Deploy gate: index not yet pushed** — `drizzle-kit push` is a DB write the auto-mode classifier blocked; Abhishek runs `cd lib/db && set -a && . ../../artifacts/api-server/.env && set +a && pnpm run push`, **then** API rebuild + restart. Deploying the code before the index exists makes every cell write fail on `ON CONFLICT`. Live API stays on `5d19e22e5084` until then. | Now, any time after Phase 1 |
| T-28 | Workflow DevKit, in-process. | Runs become weekly rather than monthly, **or** client count passes ~10. Below that, T-27 plus retry-failed-cells covers it. |
| T-29 | Audio cache → blob storage. | A second machine needs to run the corpus, or T-28 lands |
| T-30 | Failure-pattern graph + agent self-audit + the T-17 guard rails. | Client count passes ~15. Below that it is ~36 data points a year — over-structure. |
| T-31 | Navigation merge, seven routes → four. | Phases 1–3 shipped and proven. Highest risk item in the register. **2026-08-30: Abhishek asked for the hierarchy fix incl. the PRD part — see Phase 6 / PRD Part E. Runs after T-70–T-74, pending his answer on full merge vs in-page only.** |
| T-32 | ✅ **done** (PR #42, `ba356ea`). `GET /benchmark/bulks/:id/verdict.html` (`lib/verdict-artefact.ts`): one self-contained, print-clean HTML page rendered server-side from the same `bulkVerdicts` numbers as the Results banner, stamped with produced-at (UTC), build SHA, scoring version, bulk id + launch/complete dates. Per client group: decision chip, winner + margin (only on `decision === "winner"`; a too-close leader is shown as "leader (not a verdict)"), evidence/shared calls, 95% CI of the gap, production transcriber + vs-production %, cost delta as list price vs list price with prose for every reason a delta is missing, provisional + confidence-comparability caveats, rate table, legend (what winner means, prices operator-entered, dated snapshot). Every DB string HTML-escaped; no scripts/assets; `Cache-Control: no-store`; dated filename in `Content-Disposition`; 404 on unknown bulk. "Share verdict" link beside the bulk picker on Results opens it in a new tab (Save as PDF from there). In openapi as `text/html`, not used via generated client. 5 unit tests. Smoke-tested from source on local DB: newest bulk renders honestly (Land And Apartment: too close, Gladia named leader not winner, no fake cost delta). Not yet deployed — same T-27 index gate. Original: Shareable dated verdict artefact. | Any time after T-21 |
---

## Phase 6 — Part E (added 2026-08-30, per Abhishek after T-32)

Spec: `docs/PRD-v4-uiux.md` Part E; measured findings with file:line in **E.8** (audit 2026-08-30). Do in this order. Each is one PR; E.3/E.4/T-31 in a
worktree. Deploy is still gated on the T-27 index push + T-69 backfill.

| ID | Task | Acceptance |
|---|---|---|
| T-70 | **Warm light theme** (E.2). Replace the dark clay `:root` in `index.css` with a light warm palette: cream/sand ground, warm ink, hue-biased warm greys, one accent that holds on cream, jade/rose re-tuned. Token-level only. Drop the unused `.dark` block unless Abhishek says keep a toggle. | Every text/ground pair ≥ 4.5:1 incl. muted text and chips; app palette agrees with the T-32 artefact; no per-component colour edits; screenshot of every page in the browser. |
| T-71 | **Overview rewrite** (E.3). `Dashboard.tsx` → latest verdict (from `/bulks/{id}/verdicts`), what needs a human (unreviewed, hard cases, unadjudicated spans, retryable failed cells), running-now bulk with progress + est vs actual cost, this month's STT and agent spend separately + healthz build/health. Remove corpus-by-vertical, provider list, recent runs. | Verified in browser against the live DB; "no bulk completed yet" state renders when applicable; nothing on the page duplicates Corpus/Providers/Bulks. |
| T-72 | **Per-call provider comparison section** (E.4). One section per call: reference transcript on top (gold if reviewed, else Vapi draft labelled *draft* — never as gold), audio anchored, every provider's output as a word-diff row with WER/peer flags/latency/cost and the judge pick marked; reachable from Corpus and from a Results group card. Reuse the existing diff view. Open decision: Vapi draft as an extra "production" row when gold exists — default yes. | Verified in browser on a reviewed call and an unreviewed call; the word *gold* never appears next to a draft. |
| T-73 | **Show what we did not get** (E.5). In T-72's section and every per-call/provider grid: a failed/missing cell renders "<Provider>: no output — <failure class in plain words>" with T-41 diagnosis, T-43 retryable state and a retry action when retryable; per-provider missing count in the section header. Never an empty cell or a dash. Depends on T-69 having run. | Verified in browser on bulk `7d2585da` (45 failed cells); every one of the 45 shows a class and a diagnosis or "unknown". |
| T-74 | **In-page hierarchy** (E.1 layer 1). Reorder sections on Results (verdict → cost → judge accuracy → correlation → cards), Bulks (live/recent bulk first, creation collapsed while running), Corpus (needs-a-human first), Providers (live first, active-provider setting beside its list). No route changes. Then, if Abhishek confirms, un-gate T-31 (D.4 seven → four). | Each page's first screen answers its one question without scrolling; typecheck clean; browser check per page. |

## Phase 7 — backend structure (added 2026-08-30, from PRD-v4-technical Part J)

Small, independent, each one PR. Order after Phase 6 unless one blocks a Phase 6
task (T-75 blocks nothing today; do it first because it is 20 minutes).

| ID | Task | Acceptance |
|---|---|---|
| T-75 | **Break the `run-executor` ↔ `agent-verify` import cycle** (J.3). Move `drainWithConcurrency` and `envInt` to `lib/concurrency.ts`; both files import from there. | No cycle in a script that walks relative imports under `api-server/src`; typecheck clean; api-server tests pass. |
| T-76 | **Central JSON error handler** (J.1). One `app.use((err, req, res, next) => …)` after the router: logs via pino with the request id, answers `{ error }` with 500 (or the thrown status), never Express's HTML page. Zod parse failures already 400 in handlers — unchanged. | A route that throws returns JSON 500 with the request id; verified with a temporary throwing route in a test. |
| T-77 | **Route-level tests for the three riskiest endpoints** (J.6): (a) T-27 upsert — second write to an `ok` cell is discarded, a `failed` cell is replaced; (b) `POST /bulks/{id}/launch` twice — second is refused by the status machine; (c) `GET /bulks/{id}/verdicts` and `verdict.html` — 404 on unknown, 200 with expected shape on a seeded bulk. `supertest` against a throwaway schema (`DATABASE_URL` in CI = a service container). | Runs in `ci.yml`; fails if any of the three regresses. |
| T-78 | **One-command API deploy + rollback runbook** (J.5). `scripts/deploy-api.sh`: refuse if typecheck fails or tree is dirty; build UI + API; kill by PID (never `pkill`); restart; poll `/api/healthz`; print old → new `commitSha`. `docs/runbooks/deploy-and-rollback.md`: rollback = `git revert <sha>` → same script. | Used for the next real deploy; healthz SHA matches `git rev-parse --short=12 HEAD`. |
| T-79 | **Move `routes/benchmark.ts` queries into `lib/`** (J.1) — *only* as each handler is touched for another reason. Not a sweep. | Gated: no standalone PR. Track handlers moved in this row. |

## Deferred, by name

| ID | Task | Owner |
|---|---|---|
| T-33 | ✅ **done** (PR #39, Fable). `alignWords` rewritten on typed arrays: two `Int32Array` distance rows + one `Uint8Array` op matrix, zero allocation in the inner loop; recurrence and `sub > del > ins` tie-break unchanged, proven op-for-op identical to a verbatim copy of the old code over 400 random tie-heavy pairs (`align.test.ts`). Measured: 32 words 0.285→0.028 ms (10×), 160 words 3.0→0.12 ms (24×), 2,000 words 607→32 ms (19×). Original: array-of-arrays + 3 objects sorted per cell. | Fable |

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
| T-34 | ✅ **done** (PR #34, `45af8d5`). `agentCallsJudged` now counts reasoning-present scans (flagged/approved/rejected), cost irrelevant. Original: `agentCallsJudged` counts `status === "flagged" && judgeCostMicrocents !== null`. A scan judged with a model that has no published rate has a null cost and therefore does not count as judged — even though it *was* judged. Count on the pick/reasoning being present, not on the cost. | T-01 self-review |
| T-35 | ✅ **done** (PR #34, `45af8d5`). Fallback deleted. Checked: bulk 1 estimated 4¢ vs 42¢ actual (56/56 flagged, ~0.75¢/judge); bulk 2 60¢ vs 47¢ (history-based). Estimator returns `null` = "unknown, no scan history" on an empty scan table; preview/create/UI carry it. Live after: 24 calls → 14¢. Original: The agent-cost estimator's fallback changed from "assume 1c per judge call" to 0.5c (5,000µ¢) in T-01, because 0.4905c is the real observed figure. Once real judged scans exist the fallback stops being used at all — check the estimate against actuals after the first post-T-01 bulk and delete the fallback if history is sufficient. | T-01 self-review |
| T-36 | ✅ **done** (PR #34, `45af8d5`). `REDACT_TRANSCRIPT_TEXT_IN_LOGS=1` replaces the reasoning in the last-resort log with its length. Default unchanged (logs local). Original: The last-resort log in `verifyCallWithAgent` (both inserts failed) writes the judge's full reasoning text to the log so the paid-for answer stays recoverable. That reasoning quotes transcript spans and can therefore carry caller names. Logs are local-only today, so this is safe now — but if logs ever ship anywhere, this line needs redaction or a gate. | T-02 self-review |
| T-37 | ✅ **done** (PR #34, `45af8d5`). `auditOrLog` wraps both post-scan audit writes; failure logs `audit_write_failed`, never reaches the executor catch. Original: `writeAudit` after a successful scan write is not itself wrapped. If the audit insert fails, the throw reaches `runAutoAgentVerificationForRun`'s catch and is logged as "auto agent verification crashed for a call" — wrong text, since the scan actually landed. Cheap fix, but it is a third failure meaning and belongs in its own task. | T-02 self-review |
| T-38 | ✅ **done** (PR #34, `45af8d5`). `agentCallsResolved` (approved+rejected) added to `BulkActualCost`, shown on Bulks + Results. Also found and fixed: coverage counted scan **rows** not calls — bulk 2 read "126 checked" of 72 after one re-execution; now latest scan per call (63 checked). Spend still sums every row. Original: A scan whose finding a human has already resolved carries `status: "approved"`, so it counts in `agentCallsChecked` but in neither `agentCallsFlagged` nor `agentCallsErrored`. That was true before T-03 too, so nothing regressed — but the coverage line now reads "63 checked, 0 flagged, 0 errored" for a bulk whose findings were all resolved, which understates the work done. Needs a third count or a "resolved" state, decided deliberately. | T-03 self-review |
| T-40 | ✅ **done** (PR #10). **Backfilled `failureClass` on the 168 pre-existing failed rows.** One-time migration, `lib/db/migrations/t40-backfill-failure-class.mjs`, guarded to `status = 'failed' AND failure_class IS NULL`, single transaction, and it **asserts the T-06 ground truth for bulk `7d2585da` (30 `retention_expired` / 15 `audio_url_forbidden` / 0 anything else) inside the transaction and rolls back on disagreement** — a wrong rule cannot land. Result: **143 classified** (70 `retention_expired`, 56 `audio_url_forbidden`, 16 `provider_timeout`, 1 `unknown`), **25 deliberately left null**. Reading the stored `error_message` is exactly the technique T-06 removed from the live path, which is why this is a `migrations/` file that runs once and is then finished, not code that ships. | T-06 self-review |
| T-41 | ✅ **done** (PR #41). `KNOWN_FAILURE_BY_CLASS` in `lib/agent.ts` keyed on `retention_expired` / `audio_url_forbidden`; `matchKnownFailure({failureClass, errorMessage})` reads the class, and `analyzeFailure` + both routes pass it. The error sentence is consulted only when `failureClass` is null (pre-T-06 rows), via `legacyKnownFailureFromMessage`, and that branch is documented as deletable once T-40 has run. **Finding: T-40 never committed on the local DB** — see T-69. Unit test `known-failure.test.ts` (3 cases). | T-06 self-review |
| T-42 | ✅ **done** (PR #35). `provider_auth` class (vendor 401/403 with a present key), never retryable, set in `classifyProviderHttpStatus`; audio-URL 403 unchanged (`fetchAudioBytes` classifies first). Enum in stt-providers, openapi, DB type, Bulks copy. Original: A provider's own 401/403 is currently `unknown`. `ProviderConfigError` already covers a *missing* key, but a **present, wrong or revoked** key produces a 401 from the vendor and lands in `unknown` — retryable, which it is not. Needs either a `provider_auth` class or an explicit decision to leave it unclassified. | T-06 self-review |
| T-43 | ✅ **done** (PR #12). **The executor now refuses permanently-dead cells itself.** `executeBenchmarkRun` used to have `alreadyOk` as its only skip condition, so every retry re-sent the `retention_expired` / `audio_url_forbidden` cells to a paid provider again, forever. It now also skips a cell whose **latest** row is `failed` with a class `isRetryableFailureClass()` says no to — including a **null** class (predates classification; nothing ever established it could succeed), which is exactly what T-07's UI already tells the user about those cells. `unknown` stays retryable: classified, cause not yet identified. Those rows are left untouched (excluded from the stale-row delete) so the failure stays visible in `/results` and in the breakdown, counted into `attemptedCells` so an all-dead re-run still finalizes as `failed` rather than `complete`, given their own note line instead of being folded into the "can be retried" one, and recorded as `permanentlyFailedCells` in the audit row. Also drops a call from the audio pre-pass when every one of its cells is done, so a no-op retry stops re-downloading audio it will not use. | T-07 self-review |
| T-44 | ✅ **done** (PR #35). Button reads "Retry up to N cell(s)" with a tooltip: upper bound, not a cost estimate. Decided: leave the count as a gate; a real cost preview would need its own query (not built). Original: The retry target count adds `cellsPending + cellsSkippedPendingReview + cellsCancelled` to the retryable-failure count, because those cells have no failure class (they never failed) and omitting them would disable the button on a bulk with real work left. But `cellsPending` is derived as `plannedCells - cellsWritten`, so it also counts cells that were never planned to run — the number is a good-enough gate for enabling a button and is **not** a promise of exactly what a retry will attempt. If that count is ever shown as a cost estimate, it needs to come from a real query instead. | T-07 self-review |
| T-45 | ✅ **done** (PR #13). **A re-execution no longer re-judges calls whose evidence did not change.** `runAutoAgentVerificationForRun` now skips a call that already has a finished scan row for this run (`clean` / `flagged` / `approved` / `rejected`) unless the calling execution gave that call a **new** ok cell — the executor tracks exactly which calls gained one and passes the set in. `error` and `scanning` rows do not count as finished and are redone. No schema change: the "did the candidate set change" question is answered by the execution that just ran, not by storing the candidate set. | T-43 self-review |
| T-46 | ✅ **done** (PR #14). **`retryBulkFailedCells` now selects runs by the executor's own retryability rule.** A complete run is re-executed only if the latest row of some cell is `skipped_pending_review` or a `failed` row whose class `isRetryableFailureClass()` accepts (null and out-of-enum values count as permanent, same as T-43). A non-complete run (failed / queued / stuck running) is still always re-executed, unchanged. | T-43 self-review |
| T-47 | ✅ **done** (PR #38). `buildDisagreementSpans` now votes per span: `majorityText` = plurality reading (reference is one vote; null on a tie), each reading carries `agreesWithMajority`. `computeJudgeAgreement` reports `majorityAgreementRate` (majority vote vs human, no LLM, ties excluded) as the baseline the judge must beat; shown on the judge-accuracy card and in the span tooltip. Currently 0 comparable — arms with T-67. Original: reference-relative only. | T-08 self-review |
| T-48 | ✅ **done** (PR #36). Verified against the real APIs 2026-08-29: `gpt-4o-transcribe` rejects `verbose_json` ("not compatible with model") and returns `{text, usage}` only with `json` + `timestamp_granularities[]=word` — **no word timings possible**, documented in `timed-words.ts` with the exact error. ElevenLabs Scribe already returns `{text,start,end,type,speaker_id,logprob}` per word (the adapter type just never declared them) — `timed-words.ts` now reads it (type "word" only, seconds); unit test on the captured shape. No ElevenLabs ok result exists in the DB yet to see it in a live span. Original: **OpenAI and ElevenLabs contribute no word timings.** OpenAI is requested with `response_format: json` (text only; `verbose_json` + `timestamp_granularities` may return words for whisper-1 but not gpt-4o-transcribe — must be checked against the real API, not docs). ElevenLabs' stored words carry only `speaker_id` in the captured sample. A call where only those two succeed reads `no_word_timings`. Decide per provider whether timings are requestable, and re-verify with a real response before extending `timed-words.ts`. | T-08 self-review |
| T-49 | ✅ **done** (PR #17). `setActorLabel` in the client, `x-actor` on every request, one `lib/actor.ts` for sidebar + client. Live: UI verdict → `adjudicated_by_label = Abhishek`, audit row same. Historical `unknown` rows left as-is. Original finding: **Verdicts (and bulk launches) are recorded as `by unknown`.** The UI shows "Abhishek · Curator" in the sidebar but the generated API client sends no `x-actor` header, so `actorFromRequest` falls back to `unknown` on every write — seen live on the first UI adjudication (`adjudicated_by_label = unknown`) and already true of `launchedByLabel` on bulks. One place to fix: the client's `customFetch` should send the signed-in label. Matters for T-09, which reports agreement "with a human" — it should be able to say which one. | T-08 self-review |
| T-50 | ✅ **done** (PR #36). `DELETE /benchmark/bulk-templates/{id}` (204/404, audit `delete`) + trash button with confirm. Launched bulks untouched (no FK; a bulk freezes its own selection). Live: create → 204 → 404. Original: **Bulk templates cannot be deleted.** There is no `DELETE /benchmark/bulk-templates/{id}` — the T-10 verification templates had to be removed with SQL. A template that is wrong (bad band, wrong providers) is permanent from the UI. | T-10 self-review |
| T-51 | ✅ **done** (PR #36). `GET /benchmark/calls/{id}` (200/404). Live-verified. Callers not migrated (nothing reads one call today except by list). Original: **No `GET /benchmark/calls/{callId}`.** The path exists only as PATCH; reading one call means fetching the whole list. Harmless at 121 calls, wasteful at 1,000. | T-11 self-review |
| T-52 | ✅ **done** (PR #39) — script written, **not applied** (classifier blocks the write; run `pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/backfill-t52-started-at.ts --apply`). Dry run against Vapi: **8 of 22 resolvable**, 14 past the 14-day retention (HTTP 400, metadata gone too) stay null forever. Writes `source_started_at` + `source_provider = vapi`. Original: 22 calls with no `source_started_at`. | T-12 |
| T-53 | ✅ **fixed in PR #33 (T-26)** — both workflows on `pnpm/action-setup` 11, plus `allowBuilds` for pnpm 11 strictness; `ci.yml` green on main since `c658907`. Original: **GitHub CI has been red on every run since PR #20, `main` included, before any test runs**: `.github/workflows/ci.yml` and `deploy-web.yml` pin `pnpm/action-setup` to `version: 9`, but `pnpm-lock.yaml` is written by pnpm 11 (local `pnpm --version` = 11.1.2), so `pnpm install --frozen-lockfile` fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH ... "overrides" configuration doesn't match the value found in the lockfile`. Nothing in the loop depends on CI today (every PR is typechecked, tested, and deployed locally), but `gh pr merge` refuses an UNSTABLE PR — #22 was merged through the REST merge endpoint (same as the UI button, no protection bypass). Fix is one line: pin the action to the pnpm major the lockfile was written with (or read `packageManager` from `package.json`). Also check `deploy-web.yml`, which has the same pin and presumably fails the same way. | T-14 |
| T-54 | ✅ **done** (PR #34, `45af8d5`). BAML `retry_policy JudgeRetry` (3 retries, exponential 500ms→8s) bound through `ClientRegistry`; `callOpenAi` (analyzeFailure) retries 429/5xx with the same back-off. `retry.baml` deliberately outside the T-26 prompt hash. Verified live with one judge call. Original: **OpenAI 429s get no back-off in the agent path.** `callOpenAi` (`lib/agent.ts`) throws `AgentRequestError` on any non-2xx with no retry, so a rate-limited judge call lands as a `status: "error"` scan row (redone on the next execution, per T-45). With T-15 running 4 judge calls per shard × `BULK_SHARD_CONCURRENCY` 3 shards = up to 12 in flight, 429s are likelier than before. PRD-v4-technical §V4-T15 asks for the same halve-and-back-off providers get (`run-executor.ts` T-6 fix); the register row for T-15 did not include it. Not seen in the live probe (16 calls, zero errors). | T-15 |
| T-55 | ✅ **done** (PR #38). Verdict groups are per **client** (call's Vapi account label), not per assistant; Rankings cards stay per assistant and find their client group via `assistantIds`, with a "Client-level verdict for X: N calls across M assistants" line. Live: weekly bulks went from 22 groups of 1–2 calls (all `too_few_calls`) to one group of 56 shared calls → `too_close` (Gladia vs AssemblyAI inside the noise). Original: per-assistant grouping starved the verdict. | T-20 live data, 2026-08-29 |
| T-56 | ✅ **done** (PR #35). Chose the no-money option: `BulkPreview.productionCoverage` + a warning in the create dialog when production's provider is not among the candidates. Live: flux 17/24 calls not benchmarked → warning; adding `deepgram-flux-general-en` clears it. Templates unchanged (adding production costs real money per bulk — your call, still open as a preference). Original: **`vsProductionPct` can never fill on the current bulks.** Production for every group is `deepgram / flux-general-en` (or `nova-2`), and the provider rows exist (`deepgram-flux-general-en`, `deepgram-nova-2`) but no bulk selects them, so the verdict's vs-production comparison is always null and U-12's "22% cleaner than production" line has nothing to say. Either add the production provider to the bulk templates by default (costs real money per bulk) or have the preview warn when production isn't among the candidates. | T-20 live data, 2026-08-29 |
| T-57 | ✅ **done** (PR #38). The verdict owns "Recommended": badge only on the provider the T-20 verdict named winner; rank 1 otherwise says "Leading, not decided" (tooltip differs bulk vs all-time). Footer relabelled "Composite order (not the decision)" unless a winner exists. Original: trophy + "Recommended" under a "too close to call" headline. | T-21 live, 2026-08-29 |
| T-58 | ✅ **done** (PR #36). `Math.round` on the latency cell. Original: Latency column prints unrounded floats (`17189.889ms`, `124769.11ms`, `2973.3333ms`) next to integer values (`9509ms`). Format to whole ms. Cosmetic, pre-existing. | T-21 live, 2026-08-29 |
| T-59 | ✅ **done** (PR #36). Branches on `DOMException.name`: `NotAllowedError` → "click anywhere on the page first", `AbortError` → interrupted, else the cache/expiry copy. Original: **"Couldn't play audio" toast blames the wrong thing.** `SpanAdjudicator.play()` catches every `audio.play()` rejection with "The recording isn't cached on the server and its Vapi link may have expired." Seen in T-22 verification: the audio endpoint returned 200 `audio/wav` 3.6MB, yet the toast fired — the rejection was `NotAllowedError` (browser autoplay policy, no prior user gesture on the document). Branch on `err.name`: `NotAllowedError` → "Click anywhere on the page first, then play"; `NotSupportedError`/network → the cache/expiry copy. Cosmetic-but-misleading. | T-22 live, 2026-08-29 |
| T-60 | ✅ **done** (PR #35). Pages newest-first on the oldest `createdAt` (`createdAtLe`), like `lib/volume.ts`; `fetchVapiCallsPaged` reports `truncated`. Live: 1,299 unique calls over 2 pages where the old walk stopped at 1,000. Original: `fetchVapiCalls` (`lib/vapi.ts`) paging silently stops after one page when Vapi returns newest-first: cursor = newest `createdAt` on the page → next page has 0 fresh → break. Seen live 2026-08-29: same 14-day window returned exactly 1,000 calls via `fetchVapiCalls` and 3,448 via descending paging. Any import with `limit > 1000` undercounts without saying so. Fix: page on the oldest `createdAt` (as `lib/volume.ts` now does) or set `truncated`. | todo |
| T-61 | ✅ **done** (PR #35). Ranking `costPerMinute` = group spend ÷ group audio minutes (real $/min). Rankings recomputed for all 3 bulks: 23/23 rows equal list price per provider. Column label "Cost/Min" is now true. Original: Ranking rows' `score.costPerMinute` is not a per-minute price: for one bulk it reads 0.0036–0.0348 for AssemblyAI across groups (list $0.006), 0.0013–0.0127 for Cartesia — it moves with call length, so it is a per-cell average of something else. The Cost/Min column and the baseline sentence's "$/min cheaper" both read it. T-24 deliberately used catalog list prices instead. Decide what the cell metric is and label or fix the column. | todo |
| T-62 | ✅ **done** (PR #37). Verified on deepgram.com/pricing 2026-08-29: Flux English is streaming-only, **$0.0077/min** regular pay-as-you-go ($0.0065 promo showing). Catalog updated; Nova-3 stays $0.0043 (pre-recorded rate, which is what the benchmark calls). Live provider row repriced by `backfill-t65-t66.ts --apply` (seed is insert-only). Original: price copied from Nova-3. | todo |
| T-63 | ✅ **done** (PR #37). `runAutoAgentVerificationForRun` no longer counts a `flagged` scan with a null pick as finished, so re-execute re-judges it (new row, history kept). Tried live on the 3 remaining runs: **0 ok cells for those calls** — nothing to judge, same shape as T-66. Backfill rule widened to call-level (flagged + no pick + no ok cell): 5 rows, reclassified to `error` on `--apply`. Original: 10 null-pick scans stuck forever. | Decide; either is small. |
| T-64 | ✅ **exercised in PR #33 (T-26)** — ubuntu CI installed `@boundaryml/baml-linux-x64-gnu`, the contract test imported `lib/agent.ts` and the binding loaded (`[BAML] Log level set to WARN` in the step log). Original: BAML `linux-x64-gnu` native pin is in the lockfile but has never been exercised: CI is permanently red (T-53) and the only deploy target is this Mac. First Linux install/build will be the first real test of the pin. Pairs with T-53. | None until CI or a Linux host exists. |
| T-65 | ✅ **done** (PR #34, `45af8d5`). Lookup scoped to `params.runId`. Existing 106 links: `src/backfill-t65-t66.ts` (dry-run default, `--apply`, idempotent, audit-logged) — **not yet applied, waiting on Abhishek** (the auto-mode classifier blocked a direct UPDATE). Original: **106 of 178 `flagged` scans link `agentPickResultId` to a result row from a different run than the scan's own** (5 have no link). `agent-verify.ts` resolves the pick as the latest `ok` row for (call, provider) across *all* runs, not `(runId, callId, providerId)`. The provider id is right; the row link is the wrong evidence for anything that reads the picked transcript by result id (T-22's disagreement view, bulk cost attribution by result). Scope the lookup to `params.runId`. Found while recording the T-26 fixture. | T-26 self-review |
| T-66 | ✅ **done** (PR #34, `45af8d5`). Same script reclassifies the 2 legacy scans to `error` with a note. **Not yet applied** — same go needed. Original: Two 2026-08-24 manual `agent_scan` runs (`ef4692f5`, `83a51677`) have 5/5 failed cells yet their scans are `flagged` (pre-hybrid, LLM-only flags, no candidates ever existed). "Latest scan per call" treats them as real flagged findings with nothing behind them. Either backfill `status: "error"` with a note, or exclude scans whose run has zero ok cells from the flagged views. | T-26 self-review |
| T-67 | The human half of the judge contract is dormant: `benchmark_adjudications` is empty, so "a prompt change that regresses accuracy" can only bite on the shape floors (null picks, membership) until someone adjudicates ≥10 spans via the Corpus `SpanAdjudicator` (T-08) and re-records. ~10 minutes of listening; then the ≥60% floor arms itself on the next re-record, and the floor constant should be raised to the observed rate. | Abhishek |
| T-68 | ✅ **done** (PR #37). `deploy-web.yml` is `workflow_dispatch` only; the removed `paths` push trigger is kept in a comment for when Vercel hosting is decided and secrets exist. Original: permanent red X on main. | Decide |
| T-69 | **Backfill run by Abhishek 2026-08-30** (index push + `t40-backfill-failure-class.mjs`, ground-truth assertion passed): 142 of 167 classified (70 retention_expired, 56 audio_url_forbidden, 15 provider_timeout, 1 unknown); 25 left null on purpose — `Gladia submit returned HTTP 400` ×16, `Deepgram returned HTTP 400` ×9, text states no cause. Deployed `47759b0d9838` same day. **Remaining code step:** delete `legacyKnownFailureFromMessage` in `lib/agent.ts` (the 25 null rows match none of its patterns anyway, so nothing is lost). Original: **T-40's backfill never committed on the local DB** (`localhost:5433`, the one every session here runs against). Found 2026-08-30 while doing T-41: all 167 `status='failed'` rows have `failure_class IS NULL`, and `audit_log` has T-12's backfill row (2026-08-28) but no T-40 row — the migration either was never run against this DB or rolled back on its own ground-truth assertion. Consequences today: T-43 treats null as permanent, so **no legacy failed cell is retryable**; T-41's free diagnosis runs on the legacy text path for every one of them. By text: 70 retention, 56 archive-403, 41 other. Fix is not code: run `DATABASE_URL=... node lib/db/migrations/t40-backfill-failure-class.mjs` (it asserts bulk `7d2585da` = 30/15/0 and rolls back if not), then delete `legacyKnownFailureFromMessage`. Left for Abhishek — a DB write. | T-41 |
| T-39 | ✅ **done** (PR #36). UI bundle stamped via Vite `define` (same git logic as `build.mjs`; "dev" on the dev server). Badge shows `api X ≠ ui Y` in the down tone when both are real commits and differ; tooltip names the stale side. Verified stamp in the built bundle. Original: The badge reports the **API** bundle's commit. The UI itself is a separate Vite build and can be served stale from a browser cache with no signal at all — a second, real version of the same failure this task exists to kill. Stamping the UI build (Vite `define`) and showing both, or showing one only when they disagree, is a deliberate design call, not a drive-by. | T-05 self-review |

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
