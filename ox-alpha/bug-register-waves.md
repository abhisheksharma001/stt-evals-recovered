# Bug Register — Wave 2 appendix (full confirmed findings, verbatim)

Method: 10 waves × ~100 dispatched adversarial agents (concurrency, error-paths,
security/adversarial-input, state-machines, numeric/boundary, contract-drift,
resource-lifecycle, async-ordering, recovery/rollback, cross-module contracts).
591 hunters completed. 11 verifier agents then re-checked every P0–P2 claim
against source: 391 findings CONFIRMED, 83 REFUTED, 95 duplicates of the
existing B-1..B-81 register. This appendix preserves every confirmed line
verbatim, clustered by primary file. The curated top entries live as
B-82+ in bug-register.md.


===== run-executor.ts (60) =====
3. [P1] Executor never re-validates call eligibility at execution — `run-executor.ts:224-237` vs gate `benchmark.ts:971` — calls loaded by bare `inArray`, no status/gold filter; archive/demote after create (or before retry, which B-15 invites) still bills cells, scores into rankings; sibling of B-34
10. [P2] Per-run semaphores defeat vendor cap across runs/scans — `run-executor.ts:316-324` — fresh `Semaphore(4)` per invocation; N overlapping executors = N×4 in-flight/vendor → self-inflicted 429 storms, retried spend, latency-ranking pollution; RUN_CONCURRENCY likewise ×N vs pool max.
11. [P2] Mid-run PATCH drift frozen permanently — `run-executor.ts:224-237,527-538` + `alreadyOk :239-243` — gold/entities/cost edited mid-drain score vs snapshot; retry skips cell forever → mixed scoring basis within one run's rankings.
12. [P2] Retry bulk-deletes non-ok rows before replacements exist — `run-executor.ts:255-262` + readers `benchmark.ts:1046-1054` (createdAt DESC reshuffle) — polling `/results` sees rows vanish minutes; crash post-delete loses failure forensics; expanded diff/keys collapse (Runs.tsx id-keyed).
13. [P2] drainWithConcurrency lacks stop-on-fatal — `run-executor.ts:96-110` — first worker throw rejects Promise.all but siblings keep pulling cursor: import route commits inserts/audits after error response (`benchmark.ts:809-823`); cell-drain variant bills providers after unlock/Set cleared, then
[P1] drain early-reject strands paying zombies past lock release — run-executor.ts:96-110 + finally:175-181 — insertResult throw (:298/:407) rejects Promise.all; siblings keep submitting paid cells while advisory lock+runningRuns clear → next execute overlaps orphans — fix: allSettled + cancel flag 
[P1] Lock acquire pends forever under pool exhaustion — run-executor.ts:160-162 + no connectionTimeoutMillis (db index) — RUN_CONCURRENCY≤64 vs max 20 clients → `pool.connect()` never settles after `runningRuns.add` → runId bricked in-process, awaited agent scan never responds — fix: connect timeout
[P2] Rankings-compute failure swallowed; stale/missing served as current — run-executor.ts:347-355 (tx rollback preserves old rows) — retry presents previous snapshot as latest, notes/audit silent — fix: notes line + best-effort delete (244/247/277/301/304)
[P2] Unguarded finalize/status writes zombie fully-paid runs — run-executor.ts:219-237,370-383 — transient DB error after 100% spend → run stuck `running`, notes/audit lost — fix: guarded catch marking failed (246/276)
[P1] Executor concurrency gates are per-run, not global — `run-executor.ts:316-327` (semaphores built inside `executeBenchmarkRunInner`) vs comment at :39-40 claiming "overall"; N POSTs /runs → N×16 cells + N advisory-lock clients vs pool 20.
[P2] "safe to retry" contract abuse — `run-executor.ts:129,430` matches provider-authored `errorMessage`; assemblyai/openai/elevenlabs copy provider error text verbatim → paid re-submit loop ×CELL_MAX_ATTEMPTS per cell.
[P1] Executor ignores `call.status` — `run-executor.ts:224-237` (only `audioObjectPath` checked) — archived call still transcribed, scored, ranked; paid spend on withdrawn data.
[P1] Whole-pool deadlock — executor pins dedicated client entire run (`run-executor.ts:162-179`) while Inner uses shared pool (`lib/db/src/index.ts:19` max 20, no connectionTimeoutMillis); N≥20 fire-and-forget creates (`benchmark.ts:1006`) → all clients held, infinite wait, API-wide starvation.
[P1] Lock evaporation on PG failover — `run-executor.ts:165-181` no liveness recheck; 2nd executor admitted (gate takes `running`), stale-deletes in-flight rows (`:255-262`); no unique(runId,providerId,callId) (`benchmark-results.ts:17-43`) → dup ok rows, double bill.
[P1] `keywordBoosting` write-only dead-end — sole transcribe call passes `{callId,audioUrl,diarize}` only (`run-executor.ts:425-429`); adapters implement `keywordBoosts` (deepgram:57, assemblyai:47, gladia:59, speechmatics:56) — capability benchmarked never exercised; PATCH body can't fix it either.
[P1] Scoring-version blend — `alreadyOk` keys status only (`run-executor.ts:239-243`), rankings join lacks `scoringVersion` predicate (`:631-640`); no rescore endpoint anywhere; `:542` persists constant not `scored.scoringVersion` — bump+retry averages incompatible methodologies into one table.
[P2] Audit gaps — `queued→running` unaudited (`run-executor.ts:219-222`, contradicts `:379-380` comment); provider derived flips unaudited via GET-fired sync (`benchmark.ts:182-199`,`:260`,`:839`); scan `clean/error` terminals unaudited (`agent.ts:149-153,172-180`); audit GET unbounded, no limit/cur
[P2] Run materialization drops dangling ids silently — `inArray` load, no length reconciliation (`run-executor.ts:224-237`,`:357`) → `complete` under-covered; duplicate ids falsely "do not exist" (`benchmark.ts:965-970` length compare un-deduped) → born `blocked`.
[P2] Scores carry no gold revision — no gold hash column; scored against live `call.goldTranscript` (`run-executor.ts:531`) — gold edit after run leaves published WERs stale, undetectable (NFR-6).
4. [P1] Re-executed run shows stale then inflated duration — `run-executor.ts:219-222` sets only `{status:"running"}`, never clears completedAt; `Runs.tsx:109-110` renders old seconds during retry, then newCompleted−createdAt (idle gap included, e.g. 60s work → 14520s) — set `completedAt:null` when 
6. [P1] Tied composites get nondeterministic ranks — `run-executor.ts:708` comparator ties; stable sort preserves order of ORDER-BY-less SELECT (`:625-640`) → re-execute flips rank 1↔2 / "Leading candidate" — deterministic tiebreak (providerId).
7. [P1] Executor trusts run arrays; silent shrink fakes success — `run-executor.ts:224-232,357,368` — dangling callIds/providerIds (out-of-band delete/rehearsal purge) dropped by inArray: ghost vendor missing from "complete" run; partial shrink lies in totalCells audit; zero-cell `0===0` → status "c
14. [P2] Null-composite providers minted rank 1..N + 🏆 "Recommended" — `run-executor.ts:730,747-752` vs text "do not rank"; `Rankings.tsx:222-229` crowns purely on rank===1 — gate rank/badge on composite!==null.
27. [P2] Executor cosmetic/status bugs — `run-executor.ts:368` dead ternary arm (both arms "complete"); `:338-343` log denominator (cells.length) contradicts audit `:357,:391` (calls×providers) — collapse ternary; log real denominator.
28. [P2] Backoff/slot issues — `run-executor.ts:115-116` jitter applied after 30s cap (cap dead code until attempts raised; future 45s waits); `:327-345,444-451` RUN_CONCURRENCY=1 sleeps inside worker+vendor slot → one 429 serializes run — jitter inside cap; requeue outside slots.
[P1] Execute-on-`blocked` run is a lying 202 + silent no-op forever — `run-executor.ts:210-217` gate omits `blocked`; minted at `routes/benchmark.ts:984`, acked pre-exec at `:1036` — blocked runs unrecoverable via API though tasks.yaml:375 promises resume.
[P2] keywordBoosts wired in 4 adapters; sole caller passes only callId/audioUrl/diarize — `run-executor.ts:425-429` — vocab-hint paths unreachable.
[P2] Exhausted-retry persistence drops measured firstPartialAt — insertResult call `run-executor.ts:465-476` has no slot for it.
[P2] Fractional ms averages persisted to `real` ranking cols and rendered raw `${n}ms` in table+CSV — `run-executor.ts` avg() + `Rankings.tsx:242,65-72`.
[P1] Worker-pool zombies bill after abort + lock released mid-drain — `run-executor.ts:96-110,175-181` — one worker throw (B-69 sites) rejects `Promise.all` while siblings keep vendor calls; `finally` unlocks/reletes runId → second `/execute` passes guards → concurrent duplicate-billing pass; late s
[P1] Drizzle BEGIN outside try leaks pooled client — `run-executor.ts:757`; verified drizzle@0.45.2 `session.cjs`: `begin` awaited before the try, `release()` skipped when BEGIN throws — repeated DB blips wedge all queries at max=20 — fix: explicit `pool.connect()`+finally release.
[P1] Executor heap-loads full result rows incl. `raw_output`/wordDiff twice — `run-executor.ts:233-236` (`select *` for id/status sets) + `:625-640` (rankings joins whole rows) — GB-scale RSS @10k cells → OOM strands paid run — fix: slim column projection / SQL aggregation.
[P1] Drain rejection creates zombie billing workers + re-entry collision — `run-executor.ts:96-110,175-181,298,407` — `Promise.all` fast-fails but sibling runners keep pulling/billing; `finally` releases advisory lock + `runningRuns` while zombies live; operator re-executes (documented path) → attem
[P1] Gold/provider snapshot frozen at run start; repair impossible — `run-executor.ts:224-237,531,536,239-243` — mid-run gold approval or price correction invisible to scoring; `alreadyOk` permanently skips ok cells on re-execute → rankings graded against wrong reference/cost, no retry fixes it.
[P1] Missing pg error listeners crash the whole API — `run-executor.ts:162` checked-out lockClient has zero error listeners (pg-pool removes idleListener on checkout); `lib/db/src/index.ts:13-20` Pool has no `on("error")` — one dropped/failover connection = unhandled 'error' emit, no uncaughtExcepti
[P1] Stale idle client silently kills auto-fired runs — `run-executor.ts:162-168` + `benchmark.ts:1006` — pool.connect() hands out idle client unchecked; first try-lock rejects on dead socket; `.catch` logs; run stays `queued` forever, nothing marks/retries it (distinct from B-7 leak).
[P2] Per-execution vendor semaphores + backoff-inside-slots — `run-executor.ts:316-324` (Map inside Inner), `:450` sleep within `acquire`/`release` scope — overlapping runs multiply vendor load 2-N× (self-inflicted 429 storms); 429 bursts park all slots sleeping ~30s → HOL starvation across vendors.
[P2] Stale-row bulk delete destroys prior diagnostics before replacements exist — `run-executor.ts:255-262` — delete precedes minutes-long audio-resolution/drain; crash in window leaves previously-failed cells with zero rows, errorMessages unrecoverable.
[P2] Full-corpus audio re-resolution on every retry click — `run-executor.ts:274-287` drains ALL calls before pending filter at `:296` — Vapi round trip per call even when zero cells pending.
[P2] Swallowed ranking failure serves stale rankings — `run-executor.ts:347-355` catch logs only; retry leaves attempt-1 ranking rows standing while run finalizes `complete` (first-ever failure silently drops the vertical).
[P2] Re-execute during live run toasts a lie — `run-executor.ts:156-158` warn-and-return yet route still 202s pre-state → "Run started… Retrying cells" though nothing started; no 409/already-running signal.
[P1] Kill between transcribe-resolve and result-insert commit silently loses a billed transcript; resume re-bills it — `run-executor.ts:425→500-516` — no intent row/vendor idempotency key; persist-failure catch also discards in-memory transcript (`rawOutput:null`, `:554-572`)
[P1] `drainWithConcurrency` never cancels siblings — `run-executor.ts:96-110` + import caller `benchmark.ts:810-823` — after `Promise.all` rejects, surviving runners keep pulling cursor: imports commit rows after the 500 (retry races stragglers into 23505); executor workers bill/write past lock rele
[P1] No cross-run breaker + notes label every failure "failed transiently and can be retried" (`run-executor.ts:365`, unconditional) — readiness = env-var presence only (`benchmark.ts:182-199`) → revoked-key provider re-billed infinitely by operators following the note
[P1] Retry idempotency ignores mutable scoring inputs — `run-executor.ts:239-243` keys `(providerId,callId)` only — gold/entity edit or scoring-version bump + re-execute republishes old WER vs dead gold, no error/note (contrast: scans snapshot `sourceTranscript`)
[P1] Audit trail holes: per-cell retry history logged nowhere while finalize comment `:379-380` falsely claims "that history already lives in audit_log" (verified: counts only, `:390-391`); crashed executions leave zero audit rows (no start marker) — `run-executor.ts:385-392,444-450`; crash-window b
[P2] Bulk stale-row purge erases prior failure diagnostics before replacements exist; crash in window leaves zombie with unexplainable empty cells — `run-executor.ts:255-262`
[P2] Swallowed `computeRankingsForRun` failure finalizes `complete` over stale/empty rankings, no marker ("nothing is lost" comment false for derived layer) — `run-executor.ts:347-355`
[P2] Blocked runs unrecoverable: gate silently refuses (`run-executor.ts:210-217`) yet route 202s (`benchmark.ts:1036`); UI omits `blocked` from ExecuteButton (`Runs.tsx:121`) → terminal orphan, only escape re-create
[P2] Mid-run lock-session evaporation ends mutual exclusion → dual executors double-submit; dup ok rows corrupt sampleSize/aggregates — `run-executor.ts:162-181` (extends B-40's split-lock model)
[P2] Submit-phase ambiguity double-bills: retryable-classified failure after vendor job creation resubmits fresh; statusless generic Errors blanket-retryable (`isRetryableError` default true) so post-accept TypeErrors resubmit ×3 — `run-executor.ts:120-141`
[P2] Cartesia close-handler stamps "safe to retry" onto ANY pre-finalize close incl. auth failures (marker beats real reason via precedence `:394-395` → futile retries + misdiagnosis); trailing error event nulls already-paid finals (`:166`); contract is unpinned magic string ↔ `run-executor.ts:129`
[P2] Latency telemetry incomparable/inconsistent: capture point varies by transport (bytes-mode includes our download), retry backoff excluded from stored latency, max-normalizers shift on retry flipping untouched ranks, ties ordered by read order — `run-executor.ts:522-523,664-668,708`
[P2] `completedAt: new Date()` on every finalize → Duration column spans idle time between attempts, true timeline lost — `run-executor.ts:374`
[P3] backoffMs is equal jitter mislabeled "full jitter"; 30s cap dead code (max nominal 4s) — `run-executor.ts:114-116`
[P2] `keywordBoosts` consumed-never-produced; `keywordBoosting` produced-never-consumed — `run-executor.ts:425-429` sends 3 fields; 4 adapters branch on boosts — vendor vocab boosting dead in every run.
[P2] `diarize:true` hardcoded — `run-executor.ts:428`; `supportsDiarization/supportsStreaming` have zero executor consumers (Cartesia seeded false, `benchmark.ts:157`) — forced/billed diarization contradicts the row. (4 reports merged)
[P2] Per-cell TTFP unreachable — `firstPartialAt` persisted (`run-executor.ts:508`) but results serializer omits it and ScoreDetail lacks `latencyFirstPartialMs` (`benchmark.ts:1059-1085`, openapi ScoreDetail; rankings carry it :1177).
[P2] `detail.edits/entityResults` persisted, stripped at API, zero readers — `run-executor.ts:550` vs whitelist `benchmark.ts:1071-1085`. (3 reports merged)
[P2] Agent-scan runs emit unreadable ranking rows — compute unconditional (`run-executor.ts:347`) vs `purpose="batch"` join (`benchmark.ts:1148`) — dead delete+insert churn per scan.

===== benchmark.ts (51) =====
1. [P1] syncProviderReadiness stale-snapshot RMW resurrects disabled provider — `benchmark.ts:183-196` (+PATCH `:904-915`) — GET-sync SELECTs snapshot→PATCH commits `manuallyDisabled=true`+own sync→slow sync computes `ready` from stale row, blind UPDATE WHERE id → disabled vendor `status=ready`, bil
2. [P1] POST /runs has zero in-flight/scope dedup — `benchmark.ts:946-1011` — blockers check only per-call status/provider readiness; two tabs/operators insert two `queued` runs, distinct runIds → distinct advisory locks (`run-executor.ts:166`) → both drain full corpus concurrently; 2× vendor spend,
16. [P2] Provider PATCH `?? existing[0].x` full-row rebuild reverts concurrent edits — `benchmark.ts:894-913` — cost/configNote/disable restored from stale read; disable silently reverted → billable again.
[P2] Execute on `blocked` run: lying 202, silent eternal no-op — benchmark.ts:1032-1036 + run-executor.ts:210-217 bare return (no log); locked/running exits equally invisible — fix: discriminated outcome → 409 (242/244/267/275/303)
[P2] Malformed uuid path params → PG 22P02 → HTML 500 — benchmark.ts:1021-1025,1046-1053,505-509 — typo'd id crashes instead of 400/404 — fix: `.uuid()` param schemas (242/280/305)
[P2] Dashboard aggregates lie — benchmark.ts:271 `latestRunStatus ?? "blocked"` paints destructive stage on fresh installs; :272-275 counts `gold_in_review` as gold-ready → invites doomed blocked runs — fix: neutral sentinel + ready_to_run-only count (222/277)
[P2] Import drain uncancellable; write-stage unguarded; 401 not fatal — benchmark.ts:737-794 (insert/audit outside fetch try; catch rethrows only VapiConfigError, contradicting :805-807 "invalid key is fatal") + :809-825 — write-stage throw answers 500 while siblings insert post-response; revoked ke
[P2] Import fabricates 1s duration for timestamp-broken Vapi calls — benchmark.ts:770 `Math.max(1,…)` — silently poisons per-call cost math forever (duplicate-skip blocks repair) — fix: fail row or explicit unknown-marker (302)
[P1] Results endpoint unbounded — `benchmark.ts:1046-1088` — no LIMIT, full `wordDiff` passthrough (persisted uncapped at `run-executor.ts:550`), sync zod-parse of multi-hundred-MB payload blocks the single event loop.
[P2] Filename UUID hijack — `POST /calls` accepts free-text `audioObjectPath` (`benchmark.ts:348`), `guessVapiCallId` (`vapi.ts:329-340`) extracts any UUID → single-account fallback (:369-372) serves victim call's live recording for a manual row.
[P2] Malformed Vapi `startedAt` aborts import batch with partial commits — `new Date("not-a-date")` Invalid Date throws at pg insert (`benchmark.ts:780`), outside `importOne`'s fetch-only try, rethrown at :822 — distinct root cause from B-33, same partial-commit-500 shape.
[P1] POST /runs trusts unsynced provider status — `benchmark.ts:953-976` skips `syncProviderReadiness` (every other entry syncs) — restart minus key → `queued` credential-less spend; rehearsal `--keep` plants fake-`ready` providers (`rehearsal-scale.ts:133`).
[P1] De-ID attestations irrevocable — only attest route writes the 4 columns (`benchmark.ts:448-493`); `UpdateBenchmarkCallBody` omits them (`api-zod/generated/api.ts:134-144`); no revoke route — typo'd approver name permanent.
[P1] Blind-overwrite lost updates (no CAS) — `benchmark.ts:407-414` `.set({...body})` id-keyed; editor reload keyed `selected?.id` only (`Review.tsx:206-214`) — 2nd tab / agent-approve writes silently reverted by stale save; Corpus dialog blind-sends `{status}` (`Corpus.tsx:304-307`) → stale-open di
[P2] Batch execute crosses purpose boundary — no filter at `benchmark.ts:1014-1037` — decided `agent_scan` runs re-billed, result rows purged/rewritten outside scan flow.
[P2] Attest ignores `status` — `benchmark.ts:448` guards empty-label only — archived calls accrue approvals; spec'd self-attestation 422 absent (`docs/tasks.yaml:84`; creator never captured).
[P2] Rankings stale fallback — newest run with zero ranking rows absent from map (`benchmark.ts:1153-1163`) → prior snapshot served as current, no run-id/date signal in UI.
[P2] `vertical` immutable + silent strip — body schema lacks field, non-strict zod strips unknown keys (`api-zod:134-144`) → mis-tagged vertical stuck (dup check ignores status, `benchmark.ts:721-730`); re-tag returns 200 no-op + zero-diff audit row.
[P2] Mid-batch config abort reported as total failure — `VapiConfigError` throws after K autocommitted inserts (`benchmark.ts:808-823`), UI shows failure banner, invalidate skipped — Corpus hides K imported rows (distinct trigger from B-33).
[P2] FR-C3 invariant unenforced downstream — `ready_to_run⇒two approvers` checked nowhere after create-gate (`benchmark.ts:971` status-only); rehearsal seeds 150 such calls (`rehearsal-scale.ts:151-160`), kept ones enter real runs, fail on `rehearsal://` audio, pollute results; kept run poses as gen
8. [P1] Import fabricates 1s duration when endedAt missing/invalid — `benchmark.ts:770` `Math.max(1, durationSecondsOf(call))` (`vapi.ts:197-201` returns 0 on missing/NaN) while preview `:669` shows true 0 — crashed calls book rate×1s (~300× understatement into Rankings/composite) — persist unknown,
20. [P2] durationSeconds int32 overflow → raw 500 — `api-zod:83` no `.int()/.max`; `benchmark.ts:344` rounds but 2147483648 survives → pg 22003 (fractional sub-claim refuted, see below) — `.int().max()`.
[P2] Duplicate ids in POST /runs body mint permanently-dead `blocked` run with false "calls do not exist" note — `benchmark.ts:957-987` count-match blocker trips, raw arrays stored.
[P2] Score-detail contract gaps: per-cell `latencyFirstPartialMs` stored but dropped at `benchmark.ts:1071-1084` while aggregate Score requires it; `detail.{edits,entityResults}` write-only; SCORING_VERSION never filtered/compared (`run-executor.ts:675-681`); normalizationVersion never persisted.
[P2] Speechmatics seeded Realtime/streaming/realtime-price but adapter calls batch `/v2/jobs` — `benchmark.ts:142-147` vs `speechmatics.ts:53-66`.
[P2] Blocked run rendered like zero-runs ("—"/pending) and nextAction invites duplicate paid queue — `benchmark.ts:271` sentinel + `Dashboard.tsx:119,129,165-166`.
[P2] decisionStatus derived ignoring run state, contradicting "in flight" headline printed beside it — `benchmark.ts:287-294` + `Dashboard.tsx:186`.
[P1] Unpaginated full-payload results × unconditional 3s poll — `benchmark.ts:1046-1054` (no LIMIT; ships `hypothesisTranscript`+`wordDiff`/cell `:1067,:1080-1083`; openapi.yaml:295-314 contracts bare array) × `Runs.tsx:379` static `refetchInterval` polling settled/erroring runs while open — GBs/hr 
[P2] Audit-log: full-transcript before/after snapshots per PATCH, append-only, served unbounded — writes `benchmark.ts:421-422`(`:358,:793`), route `:1103-1110` no LIMIT either branch — GB-scale growth; endpoint stall/OOM at scale — fix: field diffs + limit/keyset pagination.
[P2] Vapi import drain continues past error response — `benchmark.ts:808-823` — `respondVapiError` returns while siblings still INSERT calls+audit ("aborts the drain" comment false) — partial dupes/500s on retry — fix: cooperative abort flag.
[P1] Concurrent gold lost-update, last-write-wins — `benchmark.ts:364-426`, `Review.tsx:251-286` — PATCH applies full `goldTranscript` verbatim, no revision/If-Match/updatedAt guard; two curators (multi-user by design) overwrite silently, audit shows one actor.
[P1] Execute-poll race: retry runs invisibly — `benchmark.ts:1032-1036` 202s the PRE-flip row; executor flips `running` only after pool.connect→advisory lock→re-select (`run-executor.ts:162-174,219-222`); invalidated refetch lands first, `refetchInterval` predicate sees no queued/running (`Runs.tsx:
[P1] Executor crash paths strand run non-terminal forever — `benchmark.ts:1006-1008,1032-1034` (`.catch` logs only) + no compensating status write on drain-throw, setup-throw post-`running` flip, or process death — UI polls eternally (or sits stale); recovery exists (execute accepts `running`) but n
[P1] syncProviderReadiness TOCTOU resurrects disabled vendor — `benchmark.ts:182-199` snapshot-read → concurrent PATCH disabled commits + syncs → GET's stale loop writes `status:"ready"`; POST /runs (`:974`) gates on status without re-sync → bills manually-disabled provider.
[P2] Import route answers 500 while zombie workers finish the batch — `benchmark.ts:810-823` + shared `drainWithConcurrency` — first rejection sends 500; siblings keep fetching+inserting+auditing after response; retry interleaves with moving state (manufactures B-33's race).
[P1] POST /runs ambiguous failure double-bills whole matrix — `benchmark.ts:981-1011` + `Runs.tsx:222-224` — insert→`await writeAudit`→fire all precede 201; lost response → toast "Failed to queue run", onError invalidates nothing, dialog stays armed, no idempotency key/server dedupe → relaunch = sec
[P2] Execute always answers 202 success even when executor refuses (busy lock/already-running) → "Run started · Retrying cells…" toast over zero scheduled work — `benchmark.ts:1036` + `run-executor.ts:156-173`
[P2] Retried creates fork undeletable orphans: provider id = slug+uuid6, no natural-key unique, no DELETE route; manual POST /calls has zero dedup (import path does) — `benchmark.ts:855-859`, `:339-351`
[P2] Attest neither idempotent nor correctable: replay of committed request gets false 409 (can't distinguish violation from retry); wrong/phantom approver labels immutable via API (FR-C3 permanently satisfied by phantom) — `benchmark.ts:468-477`, `:428-493`
[P2] Execute no-op invisible — `benchmark.ts:1021-1036` always 202s pre-exec snapshot; executor silently refuses busy/blocked/running (`run-executor.ts:156-172,210-217`); UI toasts "Run started" ignoring body (`Runs.tsx:312-316`). (merges 4 wave reports)
[P2] `hypothesisTranscript` served, never rendered — emitted `benchmark.ts:1067`; zero UI references (grep) — drill-down shows WER with nothing to inspect.
[P2] Newest zero-ranking run resurrects previous standings, undated — `benchmark.ts:1153-1163` picks latest-with-rows; "Recommended" badge carries no run date (`Rankings.tsx:228`).
[P2] Audit before/afterState 4 incompatible shapes — attest label-only (`benchmark.ts:459,490`, timestamps omitted), provider-create raw row (:880) vs update serializer (:927-928), calls full `serializeCall` — compliance log not diffable. (3 reports merged)
[P2] Empty workspace fabricates `blocked` — `benchmark.ts:271` `?? "blocked"` rendered as Latest-run state (`Dashboard.tsx:165-166`) — indistinguishable from a real blocked run.
[P2] Duration fabrication drift — preview prints raw 0s (`benchmark.ts:669`) vs import `Math.max(1,…)` (:770) — unknown-duration call cost-scored at 1/60 real spend.
[P2] Recording-URL robustness holes — `skipped_no_recording` decided off one fetch with no retry (`benchmark.ts:749-758`) unlike refresh path's 2×1.5s (`vapi.ts:390-401`); `??` chain lets `""` win precedence (`vapi.ts:169-176`) vs `!` checks downstream — transient presign states and empty-string art
[P2] Compliance timeline invisible in product — attestation/decision/result timestamps serialized (`benchmark.ts:232-239`, `agent.ts:80`) but no UI reads them; `useListAuditLog` imported nowhere — FR-C3 trail unverifiable outside curl.
[P3] Duplicate ids in POST /runs create false permanent blocker — benchmark.ts:965-969 length-compare without dedupe (zod allows repeats) — valid run becomes `blocked` forever with lying notes — dedupe `[...new Set(...)]` before compare.
[P3] GET /calls/:callId/audio 500s on non-UUID id — benchmark.ts:504 raw param into uuid-PK eq() → Postgres cast error, Express default 500 instead of 404 — validate params with zod uuid schema like sibling routes.
[P3] Execute endpoint 202s `blocked` runs into a silent no-op — benchmark.ts:1036 returns 202 unconditionally while executor gate (run-executor.ts:210-217) excludes `blocked` and nothing ever transitions out — 409, or re-run blocker validation on execute.
[P3] Import insert and its audit write are non-transactional — benchmark.ts:765 insert then :788 awaited writeAudit — crash between them persists an imported call with zero audit trail (NFR-5 gap) — wrap both in `db.transaction`.

===== Review.ts (26) =====
4. [P1] Gold lost update: editor dirty-baseline vs live cache + unconditional PATCH — `Review.tsx:206-227,251-271` + `benchmark.ts:407-414` (spread `.set`, no version precondition) — frozen stale cache (staleTime 30s, focus off) hides concurrent writer → ⌘Enter overwrites; or mid-session invalidatio
[P2] Mutation commits held hostage by post-invalidate refetch — Review.tsx:224-227,274-312,386; Providers.tsx:166-176; Agent.tsx:159-162 — 200 lands, refetch fails → phantom-dirty ⌘Enter re-PATCH loop, attest panel shows unapproved after recorded approval, decided row stays actionable; endpoints alr
[P2] Review metric/tagging edges — null draftTranscript scores fake "Draft WER 100.0%" (Review.tsx:99-104,511-516); duplicate entity-tag click silently no-ops leaving selection stuck (:297) — fix: null-guard WER; clear+toast on dupe (228)
[P2] Deep-link latch locks wrong call — Review.tsx:192-202 — stale-cache miss falls back to queue[0] AND latches `appliedDeepLink`; unknown ?call= silently redirects too — fix: skip while fetching / explicit not-found state (226)
[P2] Duplicate `hardCases` strings → duplicate React keys — `Review.tsx:794` `key={hc}`, array accepted undeduped via PATCH.
[P2] `gold_in_review` workflow dead-end — save advances only from `needs_review|ready_for_gold` (`Review.tsx:266-270`), attest never touches status — completing both inside Review can't reach `ready_to_run`; run-create rejects (`benchmark.ts:971`); only Corpus override exits.
[P2] Orphan entity anchors — tagged value deletable from gold pre-save; no containment check client or server (`Review.tsx:295-300`) — entityAccuracy (0.40 weight) silently deflated.
[P2] Discard-confirm inversion during in-flight save — all four guards test `dirty` only (`Review.tsx:233,247,360,445`); `mutate()`-level callbacks dropped on unmount (hook spreads `mutationFn` only, `generated/api.ts:439`) — confirmed "Discard" yet PATCH lands, invalidation skipped, 30s-stale edito
[P2] Media-error state hole — `onError` doesn't `setPlaying(false)` (`Review.tsx:659-665`; pause never fires on fatal error) — Pause icon over silence, Space inverted; stale `play().catch` clobbers successor call (`:370`, no element guard); no `preload` attr → metadata prefetch fires unsolicited err
[P2] Pinned-selection dead-end — `queue.find??null` (`Review.tsx:183-186`) + early-return `:401-408` + one-shot deep-link latch — out-of-band removal bricks page over non-empty queue, edits vanish unguarded; only exit is undiscoverable `j`.
[P2] `beforeunload` no-op in Safari — `e.preventDefault()` only, no `returnValue` (`Review.tsx:361`) — close-tab leg silently absent.
[P3] bundle — deep-link bad-id silently latches queue[0] (`Review.tsx:193-201`); selection never written back to URL; own-completion re-sort breaks j/k traversal (`goTo` raw index offset `:216,241-249`); post-success double-PATCH window before refetch lands (audit noise); Corpus status filter offers
10. [P1] Duplicate/variant entities double-weight accuracy — `Review.tsx:297` dedups exact `type+value` only; scorer maps every ref independently (`index.ts:187-203`) — "RO 4721"+"ro-4721" → 2 hits inflate entityAccuracy (0.40 weight) — dedupe on normalizeEntity.
11. [P2] Junk/zero-width entities accepted, scored as guaranteed misses — `Review.tsx:291,296` (trim misses ZWSP/Cf; "--" passes); scorer counts ""-normalized refs in denominator (`index.ts:192-203`) — deflates all providers' accuracy — reject `normalizeEntity(value)===""`.
16. [P2] Gold textarea unbounded → unsavable 413 dead end — `Review.tsx:586-601`, `app.ts:29` default 100kb json, no schema max — big paste enables Save, every retry deterministically 413s blind — maxLength + `.max()`.
17. [P2] Deleted selected call bricks Review, drops edits without confirm — `Review.tsx:184` `?? null`, one-shot deep-link, dirty recomputes false (`:224`) clearing all guards — re-pin queue[0] when pinned id vanishes.
34. [P3] Stale draft memo deps — `Review.tsx:218-222` deps omit draftTranscript → agent-scan-backfilled draft invisible (WER/turns stale) until id/gold changes — add dep.
[P2] Review save/attest callbacks dropped on unmount — `Review.tsx:256-285,306-323` — PATCH lands but cache/toast skipped → editor re-shows pre-save gold as dirty (retyped, duplicate PATCH); attest invisible → FR-C3 confusion — fix: hoisted options callbacks.
[P2] Detached `<audio>` keeps streaming after guarded nav/switch — `Review.tsx:645` keyed remount, `:206-214` resets icon only, no pause-on-unmount — stacked ghost playback + proxy/Vapi bandwidth — fix: `el?.pause()` in keyed cleanup.
[P2] No `preload="none"` on Review audio — `Review.tsx:645-654` — audio-proxy GET (fresh Vapi resolution per `:648-651`) fires on every mount regardless of playback — Vapi rate-limit/cost amplification — fix: `preload="none"`.
[P1] Stale-cache status demotion — `Review.tsx:266-270` reads cached `selected.status`; server gate (`benchmark.ts:389`) guards only `ready_to_run` submissions, everything else applied verbatim → call moved to ready_to_run/archived by another actor silently demoted to `gold_in_review`, leaves Runs q
[P1] Nav guard lies during pending save / phantom-dirty — `Review.tsx:224-239` — dirty computed vs cache: prompts "Discard?" while save is mid-flight (trains click-through → real loss when PATCH later fails post-unmount); failed post-save refetch leaves dirty=true forever against persisted data (572
[P1] Tab close during in-flight PATCH kills an explicit save — `Review.tsx:256,361` + grep: no keepalive/sendBeacon/pagehide anywhere — unload aborts fetch after UI showed "Saving…"; same loses in-flight attestation.
[P2] Deep-link one-shot latch burns itself on stale first paint — `Review.tsx:192-202` — flag consumed before refetch resolves; `/review?call=X` opens queue[0] for the session (also: in-place param change ignored) — 3 independent reporters.
[P2] Accepted "Discard" cannot stop an in-flight PATCH — mutation outlives unmount, no AbortSignal passed (`Review.tsx:256`) — server persists text user just discarded.
[P2] In-flight save survives confirmed discard-navigation → ghost edits land post-unmount — `Review.tsx:232-239` (dirty-only guard, mutation not cancelled)

===== Runs.ts (19) =====
22. [P2] Runs poll lost-wakeup — `Runs.tsx:34-39` predicate reads cached data only — initial-load failure leaves data undefined ⇒ interval false forever; execute-race variant: invalidate refetch beats executor's status write → poll never arms; run invisible until manual reload.
[P2] Ready-intersect can empty selection → guaranteed 400 loop — Runs.tsx:191,199 — ghost ids submitted as `providerIds:[]`, zod `.min(1)` 400s behind generic toast forever — fix: pre-compute intersect, bail with reason (229/230)
[P2] Runs poll hammers dead API with no backoff — Runs.tsx:34-39 — interval ignores error state, 3s polls all outage — fix: `if (isError) return false` (270)
[P2] Execute "Run started" toast when executor ignores (running/lock-conflict) — `Runs.tsx:312-316` unconditional + route always 202 (`benchmark.ts:1032-1036`) vs `run-executor.ts:156-159`; retry keeps stale `completedAt` (`:219-222` sets status only) — `Runs.tsx:109-111` shows duration, hides in-fl
[P2] Parked-tab monitors blind — poll predicates read own cache only (`Runs.tsx:34-39`, `Agent.tsx:326-328`), focus-refetch off — out-of-band transitions invisible; operator relaunches paid run believing first died.
[P2] Dialog/form residue — QueueRunDialog selection survives cancel (`Runs.tsx:157`, cleared only on success `:218`) → one-click paid relaunch of forgotten scope; Provider form never resets (`Providers.tsx:154-181`) → near-duplicate undeletable row; cost input lacks `min={0}` → negative → 400 loop, 
[P2] Keyboard/a11y — QueueRunDialog picker divs + ResultsDialog expandable rows are onClick-only (zero tabIndex/role hits in Runs.tsx) — keyboard users can't launch runs or expand diffs; autofocus hits "View in Results" (Enter ejects drill-down); attest-success unmounts focused row → focus to body; 
30. [P2] Runs display nits — `Runs.tsx:106` client-behind clock renders "in 5 minutes" for past run; `:110` raw seconds (172800s) inconsistent with m:ss elsewhere — clamp to now; shared formatDuration.
31. [P2] Diff header implied ratio ≠ adjacent WER — `Runs.tsx:337-340` counts `ins` in numerator and denominator; WER divides by gold words — exclude ins ops.
[P2] Nits: dead `format` import Runs.tsx:17; 7 @theme border tokens reference undefined vars; Inter loaded but Archivo is the sans token; destructive-toast close uses raw red-* against token contract.
[P1] createRun/execute inline mutate-callbacks dropped after unmount — `Runs.tsx:203-225,312-320` — v5 gates them behind `hasListeners()` (verified `mutationObserver.js:77`) → invalidations+toast never run; billed launch invisible ≤30s, execute failure silent — fix: hoist callbacks into `useMutation
[P2] Execute pending-state lost across unmount → duplicate execute POSTs — `Runs.tsx:302-326` — remounted idle button over started run; backend deliberately re-executes — fix: derive in-flight from polled status.
[P2] Per-row dialogs/observers mount over unpaged runs list — `Runs.tsx:82,115,369-384` × `benchmark.ts:938-942` (no LIMIT) — observers/heap grow linearly with run history — fix: paginate + render dialog content only when open.
[P2] Poll intervals survive persistent API errors via stale cached data — `Runs.tsx:34-39`, `Agent.tsx:326-328` read `q.state.data` retained on failure — 3s ticks + retry bursts into dead endpoint forever per tab — fix: bail on `state.error`/failureCount.
[P1] Ambiguous create/execute failure strands paid launch — `Runs.tsx:204,217,314` — unawaited invalidate; if the lone refetch fails (retry:2 then stop), stale list + no focus refetch + interval off ⇒ spending run absent from only monitoring surface; onError path never invalidates either.
[P2] Runs table resilience: background-refetch failure swaps whole table for error row with no Retry (`Runs.tsx:67-71`, B-13 sibling, different file/mechanism); results drill-down: unconditional 3s interval hammers through errors and past finalize (`:379`), reopen serves unvalidated cache incl. stal
[P1] Every mutation onError lies about committed state and never reconciles cache — `Runs.tsx:222,318` (lost 202 → "Failed to start execution"/"Failed to queue" while billing; polling off since cached data lacks running row), `Review.tsx:282-283` ("Nothing was written" after PATCH commit → invites o
[P2] Frontend error dead-ends: six pages swap cached data for bare error panel, no Retry, remount-inside-staleTime won't refetch (`Runs.tsx:67` etc.); TOAST_LIMIT=1 slices unread failure toasts — often the ONLY failure evidence (`use-toast.ts:3,77`); ErrorBoundary "Try again" remounts identical payl
[P2] Multi-line notes truncated — `Runs.tsx:94` `truncate`, no `whitespace-pre-line` (grep: absent) — retry guidance hidden when blockers+failures coexist.

===== vapi.ts (16) =====
19. [P2] vapi pagination last-write-wins can downgrade signed→bare URL — `vapi.ts:270-272` unconditional `collected.set` + inclusive Ge re-serving boundary ties during documented re-signing transient — dead preview links, stale stored paths.
[P2] vapiGet: no timeout, no typed network wrap — vapi.ts:203-216 — black-holed Vapi wedges preview/audio/import/executor resolution ~300s/socket; TypeError escapes as opaque "fetch failed" 502 — fix: AbortSignal.timeout + VapiRequestError (239/245/248/271/278/280/299/309)
[P2] Presign-refresh loop aborts on first throw — vapi.ts:393-401 — fetchVapiCall throw escapes despite remaining attempts → every cell of a call failed off one blip — fix: per-attempt try/catch (248/280/304)
[P2] `fetchVapiCalls` buffers pre-filter pages — `vapi.ts:272` collects before assistant filter (applied only at :283) × 50k calls incl. transcripts held in heap per request.
24. [P2] Vapi pagination early-exit edges — `vapi.ts:245-285` — ≥page-size createdAt tie stalls cursor (freshCount==0 misread as EOF); inclusive Ge wastes 1 slot/page starving final page (1499/1500 trace); lexicographic watermark regresses on mixed precision; "" cursor drops lower bound; docstring p
25. [P2] guessVapiCallId unanchored, case-verbatim — `vapi.ts:310,338-339` — second UUID in filename wins (wrong-audio/wrong-id risk), uppercase match returned → 404 — anchor segment, toLowerCase.
[P1] Empty pagination watermark erases date lower bound — `vapi.ts:262,275,280` — full page whose calls all lack createdAt sets cursor=""→ falsy → next page sends NO createdAtGe → ascending walk floods pre-window calls, slice keeps oldest; no caller re-filters dates. Rare trigger, exact mechanism.
[P1] Signing retry loop can't bridge its own documented window — `vapi.ts:390-401` — 2×1500ms retries vs in-file comment "signed a few minutes apart" (`:381-384`) → returns unsigned URL → S3 403 fails every cell of that call; distinct from register's accepted-risk never-signed fallback. Also: thrown
[P2] Short final page conflates "end of window" with "not yet served" — `vapi.ts:279` length-break; trigger (replica lag) speculative but indistinguishable in code; complements B-78.
[P1] Zero HTTP timeouts anywhere: adapter transcription fetches (grep: no AbortSignal/timeoutMs override in any adapter), `vapiGet` `vapi.ts:204` (hang wedges cap-8 presign phase before any cell), poll deadline unenforced mid-`fn` + fixed 120s < long-file processing → deterministic non-retryable fai
[P2] Wrong-workspace fallback: `sourceAccountLabel` set but account removed + exactly one other → `accounts[0]` cross-account 404 presented as "recording deleted" — `vapi.ts:369-372`
[P2] Transient Vapi 500 bypasses resolveFreshRecordingUrl's own retry budget (throw exits loop, remaining attempts never run); recording-not-generated-yet treated as gone at attempt 0 — `vapi.ts:393-403`
[P2] Terminal failures marketed retryable — audio-unresolved (:297-307), missing-adapter (:405-416), first-attempt-terminal cells all hit "failed transiently and can be retried" note (:365); `VapiNoRecordingError` flattened to string (`vapi.ts:349-354` vs catch :281-286) — futile re-executes re-bill
[P2] Window filters bind `createdAt` while UI correlates "Started" — `vapi.ts:163-165,257,263` vs Import table — queued/scheduled calls land on wrong window edge, no warning.
[P2] Presign TTL invisible — `presignedUrlsExpiresAt` documented live (`provider-data-samples.md:41-43`) but omitted from artifact type (`vapi.ts:139-150`, zero refs) — blocks clean B-22 fix; plus transcriber provenance first-match (`costs.find`, `vapi.ts:191`) may name the wrong engine.
[P2] `vapiGet` unbounded — no AbortSignal (`vapi.ts:203-216`); 3 sequential resolveFresh fetches awaited under held advisory lock pre-cell (`run-executor.ts:274-287`) — stuck fetch stalls run start minutes/call (new site beyond B-38/B-39).

===== other (14) =====
26. [P2] TanStack v5 inline mutate callbacks dropped on unmount/boundary — all pages use inline form; boundary Try-again remounts from poisoned success-cache (reset never calls resetQueries) → committed op invisible, deterministic re-crash loop, resubmission dups.
[P2] customFetch robustness — no timeout anywhere (:371, hung upstream = forever-pending queries/mutations); parseErrorBody unguarded (:374/:274, reset mid-error-body replaces ApiError with status-less TypeError) — fix: default AbortSignal.timeout; wrap body read (237/283/284)
[P2] Review audio state edges — no pause-cleanup in `[selected?.id]` effect (:206-214) + keyed remount :646 → pending play() of detached element audibly plays previous call, unstoppable; onError never `setPlaying(false)` (:659-665, icon stuck Pause); post-error retries silent (:370) — fix: effect cl
[P2] Providers form edges — no `min="0"` on cost (:214) + three onError discard ApiError detail (:127-129,177-179) → 400 loops look transient; fields never reset + Cancel not pending-gated (:142-148,233-237) → near-duplicate permanent rows (no unique constraint); post-commit throw fakes failure with
[P2] CLI/scripts robustness — import-vapi-calls: empty flag values silently widen date window/default account, --limit NaN→null 400-dump, undici cause swallowed, non-JSON 200 context-free SyntaxError, mid-batch VapiConfigError masks N committed rows as total 502; stt-score: Infinity numerics stringi
[P2] `durationSeconds` no upper bound rigs cost normalization — trigger corrected: int4-valid ~2×10⁹ s (not 1e308, which 500s) → per-cell cost ≈$140k becomes vertical max, pins all other costComponents.
[P1] Merge hook brick — `post-merge.sh:4` non-TTY `db push` fails on destructive diff; `.replit:20` `timeoutMs=20000` SIGKILLs even additive pushes — deploy proceeds on unmigrated DB; no retry path.
[P1] post-merge DB push matches no package (`--filter db` vs name `@workspace/db`) → merged schema never pushed, exits 0 — `scripts/post-merge.sh:4`.
[P1] Full CASCADE graph modeled, zero DELETE endpoints/spec ops anywhere — mis-imported batches, runs/results/scans unremovable via product surface.
[P2] Terminal job with null text mapped to ok (AssemblyAI/Gladia parsers) → same ok-row-never-scored skip chain via `:518` gate.
[P2] Preview dates `zod.coerce.date()` accept numbers/bools — `{"startDate":0}` queries a 56-year window instead of 400ing.
[P2] .replit runButton="Project" targets nonexistent workflow — Run button dead on fresh clone.
[P2] Delete-policy split on call_id (scans CASCADE vs results NO ACTION) + rehearsal cleanup FK-blocked via scans.runId/pick refs without onDelete — schema reads confirmed (latter B-64-adjacent success-path variant).
[P2] POST /providers skips readiness sync — hardcodes `not_configured` (:866), serializes+audits pre-sync (:883) vs GET/PATCH syncing (:839,:915) — 201 body and audit row permanently wrong.

===== agent.ts (10) =====
27. [P3] Lower-sev confirmations: agent-scan silent-no-op judges partial candidates cross-instance (`agent.ts:206-229`, B-70 shape); stranded eternally-queued run when pool.connect/linkage throws (`agent.ts:185-206` catch updates scan only); third unconditional final-write site resurrects rejected s
[P2] GET `/agent/scans` N+1 + transcript dump — `agent.ts:44-59` per-scan query embedding all candidates' full transcripts, `Promise.all` over all rows (:103), no pagination → pool exhaustion + second unthrottled PHI surface.
[P1] Approve non-atomic — `agent.ts:314-328` call-update then scan-update, no transaction — crash between → gold swapped, scan still `flagged`, audit skipped; later Reject records "no change made".
[P2] Scan flags lost on mid-persist throw — computed `agent.ts:146`, catch `:257-261` writes status+errorMessage only — billed flag spans invisible.
[P2] Archived calls scannable — `agent.ts:113-143` existence/transcript checks only; `Agent.tsx:27` same — paid fan-out on retired rows; Review queue keeps archived members, burning dual attestation on dead work (`Review.tsx:67-72,169-177`).
[P2] Total cell failure scanned as actionable "flagged" — `agent.ts:206-239` + `agent.ts lib:140-142` — executor returns void on all-fail, judgeCandidates([]) returns null pick, scan written `flagged`/null pick; approve always 409s; should be status:"error".
[P2] Orphaned agent_scan run stays executable via /execute (no purpose filter) → bills providers feeding an unreachable scan — `agent.ts:185-200` + `benchmark.ts:1014-1037`
[P2] Gold-author self-confirm chain — approve writes picked transcript but leaves `sourceTranscriberProvider` stale (`agent.ts:314-322`); next scan excludes only the original transcriber (:167-169) — prior pick "confirms" its own text.
[P2] Scan `sourceTranscript` persisted, never served — written `agent.ts:139` (schema `benchmark-agent-scans.ts:44`); `serializeScan` omits (:67-82); absent from openapi — flagged spans unverifiable.
[P2] Agent audit gaps — catch-path `error` transition unaudited (`agent.ts:257-261`); approve keyed `entityType:"call"`+scanId buried (:330-337) vs siblings keyed `agent_scan` — failed scans and gold-writing approvals vanish from audit-log filters.

===== Import.ts (9) =====
17. [P2] Superseded preview onSuccess re-binds account + wholesale replaces selection — `Import.tsx:99,135-146` (+clear sites :291/:295/:307) — filter edit during flight sets binding null, late response re-binds old account ⇒ stalePreview false, old-window rows pre-ticked under narrowed form — async
[P2] Unmount drops `.mutate()` callbacks — Import.tsx:163-187, Providers.tsx:123-129 — nav-away mid-mutation loses invalidation/toast/untick though server commits — fix: hook-level options (233/234/235)
[P2] Fetch failure masquerades as misconfiguration/empty — Import.tsx:75,190,254-262; Runs.tsx:155-161,263-264; Agent.tsx:25-29,103 — outages rendered as "set env vars"/"No providers ready"/"import first", no retry — fix: isError branches (229/230/232/271/285/310)
[P1] Preview race — `Import.tsx:135-137` binding set unconditionally — filters edited in-flight re-arm `stalePreview` false with pre-edit window; out-of-order responses last-write-wins → wrong-window paid import.
[P2] Import lifecycle — imported rows stay "importable", select-all re-ticks (`Import.tsx:166-176` vs `:107`); Import button live during in-flight preview (`:468` lacks `preview.isPending`); accounts-fetch error renders "No Vapi accounts configured" remediation lie (`:75` drops isError, `:190`); dat
18. [P2] Untick treats `skipped_no_recording` as done — `Import.tsx:173` `outcome !== "failed"` — vanished-recording rows cleared though never imported, silently out of pipeline — gate on `=== "imported"`.
19. [P2] Import limit misparse — `Import.tsx:128,314` `parseInt||50` — "1e9"→limit 1 (silent scope collapse), "0"→default 50 — `Number()`+isFinite, then clamp.
[P2] Late preview response re-arms stale gate — `Import.tsx:135-147` vs clearing handlers `:251,:277,:291,:295,:307` — slow response resets binding, old-window rows importable mis-scoped — fix: request-generation token or disable filters while pending.
[P1] Late preview resolve resurrects invalidated binding — `Import.tsx:135-147` vs filter handlers `:251-308` — handlers clear only `previewedAccountId`, onSuccess unconditionally rewrites binding + pre-ticks OLD scope; account-match variant slips the compare-gate → silent wrong-window import throug

===== index.ts (9) =====
24. [P2] Exit-path gaps compound zombies: no SIGTERM handler/pool.end (`index.ts:18-25`) → deploy mid-run strands `running` + committed-but-unacked writes invite resubmit dups; `listen` err-callback is dead code (EADDRINUSE crashes as unhandled 'error'); PGPOOL_MAX=1 self-deadlocks executor (lock cl
[P2] Process lifecycle — zero SIGTERM/SIGINT handlers (`index.ts` ends at `app.listen`) — every restart mid-run mints zombie + unpersisted billed jobs; ghost-backend lock blocks documented recovery until TCP reap (`run-executor.ts:165-173`, locked=false warn-return + 202).
2. [P1] Typographic ’ ‑ – split words → WER up to 200% — `index.ts:78` keeps ASCII `'`/`-` only; NFKC doesn't fold U+2019/U+2013 — identical speech vs ASCII gold → sub+ins per word, feeds 0.20 weight — fold `[’‘‛]→'`, `[–—―−]→-` before strip.
12. [P2] Combining marks & Cf chars become word separators — `index.ts:78` — İ→"i stanbul", ZWNJ→"co op" → phantom sub+ins — NFD+strip `\p{M}`, drop `\p{Cf}` instead of spacing.
13. [P2] Non-ASCII digits deleted from entities — `index.ts:95` NFKC won't fold `\p{Nd}` → "AB١٢٣"→"AB", silently unmatchable — fold `\p{Nd}`→ASCII before strip.
15. [P2] compositeScore lacks floor/non-finite clamps — `index.ts:269-279` — negative latency/cost → component 1.5 (>ceiling), NaN propagates; latent today (same-process clocks, cost≥0… except finding 5) — clamp [0,1] + isFinite.
[P2] Shutdown never drains fire-and-forget executors — `index.ts` (no SIGTERM/SIGINT handling, grep-verified) — redeploy mid-run strands `running`, half-done billed cells.
[P0] Idle pg client error crashes entire API (no pool `'error'` listener repo-wide, listen-only `index.ts`, pg@8.22) — `lib/db/src/index.ts:13-20` — DB failover/RST → idle clients emit error → `pool.emit('error')` with zero listeners → uncaught → process dies mid-run; fire-and-forget executor killed
[P2] No graceful shutdown: SIGTERM hard-kills mid-cell (billed-unwritten, zombie running) — api-server `index.ts:18-25`

===== routes/agent.ts (9) =====
[P2] Judge-phase throw strands billed scan as terminal `error` — routes/agent.ts:250-263 (flags+runId persisted :196-200 before execute) — approve needs `flagged`; only exit is reject/full rebill — fix: remain flagged with null pick or judge-retry (273/300)
[P2] Catch-block compensation can throw → zombie `scanning` + opaque 500 — routes/agent.ts:257-263, insert :134 outside try — second DB failure escapes catch; `serializeScan(undefined)` TypeErrors — fix: inner try/catch + undefined guard (243/268/306)
[P2] Approve's two UPDATEs non-transactional — routes/agent.ts:314-328 — mid-handler failure splits gold-write from decision-record; subsequent Reject yields rejected-scan-with-changed-gold — fix: db.transaction (307)
[P2] Audit gaps: clean/error scans never audited (routes/agent.ts:146-156,250-263); approve audit omits ready_to_run flip + entityType asymmetry (:330-337 vs :371-377); /benchmark/audit-log unbounded full-table select (benchmark.ts:1091-1126) — fix: audit every terminal branch, include status, add l
[P1] Approve applies pick judged against stale basis — `routes/agent.ts:299-322` never compares `scan.sourceTranscript` (`:126-127` snapshot) to current gold — human gold v2 silently replaced by v1-derived pick; sequential 2nd approve clobbers again (`:284` guards own scan only).
[P1] Judge-phase failure strands fully-paid candidates in unapprovable scan; sole recovery re-bills every provider — `routes/agent.ts:218-263` — `judgeCandidates` throw after `executeBenchmarkRun` → catch flips terminal `error`; approve gated to `flagged` (`:284`); no re-judge endpoint; OpenAI calls
[P1] Approve = two autocommit writes, no transaction — `routes/agent.ts:314-337` — death between call-update and scan-update: gold swapped, scan still `flagged`, audit never written → Reject then records "no change made" over changed gold; prior gold recorded nowhere
[P1] No janitor/sweeper/boot reconciliation anywhere — `routes/agent.ts:145-264`, api-server `index.ts` — crash leaves `scanning`/`queued`/`running` rows forever (catch writeback itself fails on dead pool → 500 + immortal scanning; runs-list filters `purpose="batch"` so agent_scan corpses invisible;
[P2] All-providers-failed scan lands actionable-looking `flagged` with null pick → approve 409s forever, reject the only exit — `routes/agent.ts:228-239` + `lib/agent.ts:140-141` sentinel (verified)

===== cartesia.ts (7) =====
6. [P1] Cartesia immortal send interval when open lands after connect-timeout finish — `cartesia.ts:264-272,312-315` — timer fires finish(settled=true)→late `open` listener still creates `sendTimer`; later close event hits `if (settled) return` → interval leaks forever, re-sends into dead socket, re
20. [P2] Cartesia connectError plain `=` clobbers typed provider error — `cartesia.ts:322,339` (siblings use `??=`) — send-fail race replaces root cause with InvalidStateError noise, misclassifying retryability.
21. [P2] Cartesia late error destroys completed transcript — reducer `cartesia.ts:166` returns `transcript:null` whenever errorMessage set, even with finals collected — good data discarded, cell re-billed.
[P1] Cartesia failure-precedence destroys retry classification — cartesia.ts:339 direct assign + error-frame branch (:360-366) leaves sendTimer armed → InvalidStateError text preempts both frame error and close-handler "safe to retry" via `??` (:394-397) — deterministic quota fails burn retries; tra
[P2] Attacker/upstream text persisted unbounded into `errorMessage` — `cartesia.ts:155`, `assemblyai.ts:25`, `openai.ts:23`, `elevenlabs.ts:25`; Vapi body echo `vapi.ts:212`→`benchmark.ts:588`; drizzle/pg failure text `run-executor.ts:566` — all served at `benchmark.ts:1068`.
33. [P3] Cartesia nits — `cartesia.ts:160` whitespace-only text pins TTFP early; `:114` truncated WAV → negative length → empty PCM, provider blamed — trim check; throw on dataLength≤0.
[P1] Cartesia idle-close races final flush — `cartesia.ts:296-310,371,380` — timer sends "close"+closes immediately after 2s quiet post-finalize; slow flush truncated; `finalizeSent=true` suppresses error → partial transcript scored ok (client-initiated variant surviving any close-code-based B-21 fi

===== Agent.ts (7) =====
9. [P1] scanInFlight blind exactly when needed (extends B-36) — `Agent.tsx:47-49,113,326-327` — guard derives from cached scans list; conditional poll fires only if cache already has scanning row; staleTime/focus-off → remount/cross-tab window re-enables Scan → second paid pipeline, server has no pe
[P1] Scan POST transport-drop orphans live scan, disarms guard — Agent.tsx:74-77 vs :47-49,:326-328 — proxy timeout mid minutes-long sync POST → onError never invalidates; polling gated on cached `scanning` row (absent) → button re-arms, retry double-bills — fix: invalidate in onError (232/273/274/2
[P2] Scan control desyncs — remount freezes "Scanning… 0s" (local `scanStartedAt` vs server-derived inFlight, `Agent.tsx:41-54,113-116`); client-timeout onError leaves idle UI + no invalidate (`:74-77`) while server scan completes invisibly; sub-30s round-trip re-enables Scan (staleTime) — server ha
29. [P2] Agent timer defects — `Agent.tsx:52` wall-clock anchor → "-540s"/jumps on clock step; `:47-54,115` derived in-flight (scanStartedAt null) freezes "Scanning… 0s" — performance.now(); seed from polled row.
[P2] Elapsed scan counter freezes at 0s on remount-mid-scan — `Agent.tsx:47-51,115` — `scanStartedAt===null` early-return while badge shows "Scanning… 0s"; reads as hang, feeds B-36 resubmits — fix: seed from scanning row `createdAt`.
[P1] Scan in-flight guard goes dark exactly while a scan runs — `Agent.tsx:47-49,56-77,326-328` — poll gate needs a scanning row already in cache; no invalidate at submit or in onError; POST awaited minutes server-side (`agent.ts:134-206`) → second tab / quick-return passes guard → duplicate full-pr
[P2] Adopted in-flight scan freezes elapsed counter at "Scanning… 0s" — `Agent.tsx:113-115` vs `:41-54` — remount sets scanInFlight from list but `scanStartedAt=null`, timer effect never arms; reads as hang, nudges toward the P1 resubmit.

===== Corpus.ts (7) =====
18. [P2] Corpus dialog resync clobbers unsaved selection mid-edit — `Corpus.tsx:292-294` (deps `[open, call.status]`, resyncs while open); same page: create/status/attest late onSuccess hijack reopened dialog / cancelled write still commits (`:223-228,:308-311,:387-389`).
[P2] isError checked before data on every list page — Corpus.tsx:99, Providers.tsx:30, Rankings.tsx:127, Dashboard.tsx:94 — failed background refetch swaps valid cache for full-page error; open dialogs unmount mid-edit; no Retry — fix: gate on `!data` + banner (222/225/231/269/285)
[P2] Corpus/Import form-data edges — `1e400` → `durationSeconds:0` → 400 behind detail-free toast (Corpus.tsx:217-218,229-230); whitespace-only label persists invisible row, no DELETE (:247); close-during-pending mints duplicate call (:236,268); live `call.status` effect clobbers unsaved select (:29
[P2] Unawaited-invalidate family (Corpus/Providers/Import/Runs): late onSuccess force-closes a reopened dialog wiping fresh input (`Corpus.tsx:223-228,308-311`); success toasts precede persistence confirmation; failed refetch leaves stale tables inviting duplicate saves; Import unmount destroys per-
[P2] Whitespace-only label passes both validators — `Corpus.tsx:247` `minLength={2}` untrimmed + zod `min(2)`; inserted verbatim (`benchmark.ts:342`) — blank-looking rows, search/picker miss.
[P2] Create-call error swallowed — `Corpus.tsx:218` sends `durationSeconds:0` fallback, `onError` drops server reason (:229-231) — opaque "Failed to add call".
[P2] Corpus status filter offers 2 of 5 statuses — `Corpus.tsx:62-65` vs full enum honored server-side (`benchmark.ts:311-313`). (2 reports merged)

===== Rankings.ts (7) =====
25. [P2] isError-swap destroys populated views/dialogs beyond B-13's file — `Rankings.tsx:127`, `Providers.tsx:30-34`, `Corpus.tsx:99-104` (kills open dialog + typed approver), `Import.tsx:148-151` (wipes curated ticks) — transient refetch failure blanks working state.
[P2] CSV export edges — formula-guard tested AFTER quoting (Rankings.tsx:54-61: leading `"` defeats `/^[=+\-@\t]/` for comma/newline cells → Excel executes formulas, voiding B-31); sync `URL.revokeObjectURL` races Safari/Firefox download start (:87); policy-blocked downloads give zero feedback (:79-
[P1] B-31 remediation bypass — `Rankings.tsx:56,60` — formula-prefix test runs AFTER quote-wrapping, so any cell containing quote/comma/newline ships unguarded (`=HYPERLINK("")` executes in Excel).
3. [P1] CSV formula-guard bypassed on quoted fields — `Rankings.tsx:56-60` — prefix test runs on the *escaped* string; `"=IF(TRUE,1,0)"` starts with `"` so `'` never fires; Excel evaluates — test raw `s` before quoting (defeats B-31's fix).
22. [P2] toFixed rounds near-perfect to "100.0%" — `Rankings.tsx:236,239,248`, `Runs.tsx:442`, `Review.tsx:513` — 0.9995 WER renders perfect yet ranks below true-zero — ">99.9%" formatter.
23. [P2] Rankings cells/CSV break formatting contract — `Rankings.tsx:242` prints raw float32 round-trip digits (`real` col, `benchmark-rankings.ts:28`); `buildCsv :68-74` emits fractions/raw floats while table shows %/$ formatted, contradicting "mirrors exactly" comment `:50-52` — round/format both
[P2] CSV download silently fails on WebKit — `Rankings.tsx:86-87` synchronous revokeObjectURL after click — known WebKit async blob resolution race; Safari export intermittently zero-byte, UI reports success.

===== layout.ts (7) =====
[P1] Browser Back/Forward bypasses nav guard — layout.tsx:34 sole `runNavGuard` call site, zero popstate handlers repo-wide — dirty gold editor unmounts silently on history nav; beforeunload can't fire on SPA nav — fix: location-diff/popstate hook (236/286/316)
[P2] Nav-guard edge cases — layout.tsx:34 compares path-only href vs full location → deep-linked `/review?call=x` + sidebar click fires lying discard-confirm (nothing unmounts); Chrome dialog-suppression makes confirm() fail closed silently everywhere; beforeunload uses preventDefault only, no promp
[P1] Browser Back/Forward bypasses dirty guard — `layout.tsx:34` is sole `runNavGuard()` caller, no popstate handling repo-wide — SPA history nav unmounts Review, edits gone, beforeunload never fires.
[P1] Browser Back/Forward bypasses nav-guard — `layout.tsx:33-35` sole `runNavGuard` site; no popstate interception (`nav-guard.ts`, App.tsx:63 unmount) — one Back press silently discards dirty gold — fix: history/popstate interception consulting the guard.
[P1] Browser Back discards dirty gold edits — `layout.tsx:34`,`nav-guard.ts:15`,`Review.tsx:232-239,359-364` — zero popstate listeners in src (grep); beforeunload never fires on SPA history nav → most common nav gesture silently kills unsaved work; B-14's sidebar fix can't cover it.
[P2] Guard/query mismatches: self-click "Review" on `/review?call=x` runs confirm then delivers nothing — accepted discard, instance preserved, edits survive to be saved later (`layout.tsx:34` compares href incl. query vs location); same compare causes false discard prompt on no-op nav.
[P2] Nav guard miscouples — active-item click with query string prompts false discard (`layout.tsx:34` raw compare vs path-only :30); Browser Back bypasses guard entirely (sole consumer is sidebar click; popstate unrouted) — dirty edits lost via primary gesture. (2 reports merged)

===== lib/db/src/index.ts (6) =====
7. [P1] pg Pool has no `error` listener — `lib/db/src/index.ts:13-20` — idle-client ECONNRESET emits Pool 'error', zero listeners repo-wide → unhandled event kills API mid-run; all runs strand `running`.
[P0] pg pool missing `error` listener — lib/db/src/index.ts:13-20 — idle-client fatal error (failover/LB idle-kill) → unhandled 'error' event kills whole API; all active runs zombie `running` — fix: `pool.on("error", log)` (261/276/297)
[P2] Pool lacks connection/statement timeouts; lockClient pinned per run — lib/db/src/index.ts:13-20, run-executor.ts:162-179 — wedged client stalls all acquires invisibly; ≥18 concurrent runs starve API traffic — fix: timeouts + dedicated lock pool (261/294/297)
9. [P1] PGPOOL_MAX=1 wedges whole API — `lib/db/src/index.ts:19` (passes B-42's own >0 fix) + `run-executor.ts:162` — lockClient pins the pool's only client; Inner's first query needs a second → circular wait, zero logs — dedicated lock pool or clamp max≥RUN_CONCURRENCY+2.
[P1] pg Pool missing `'error'` listener — `lib/db/src/index.ts:13-20` — idle-client backend loss (failover/NAT kill) → unhandled `'error'` kills process mid-run — fix: `pool.on("error", log)`.
[P1] Shared-pool advisory lock deadlocks API — `lib/db/src/index.ts:19` + `run-executor.ts:162-181` — fire-and-forget `/execute` has no global cap (`runningRuns` is per-runId, `benchmark.ts:1006/1032`); ≥PGPOOL_MAX(20) concurrent runs pin every client, inner queries queue forever → API-wide freeze u

===== poll.ts (6) =====
15. [P2] pollUntil deadline voided while `await fn()` hung; no AbortSignal in lib/stt-providers — `poll.ts:16-24` — stalled poll holds semaphore slot ~300s undici default instead of 120s budget; wall-clock `Date.now()` deadline also NTP-sensitive; deepgram/openai transcribe fetches equally unbounded
[P2] Poll budget unenforced — deadline checked between iterations only (`poll.ts:16-20`), adapter poll fetches take no AbortSignal, executor has no watchdog — stalled socket hangs cell past `timeoutMs` (undici ~300s per-request bound only; "indefinite" overstated).
26. [P2] Fixed 120s poll ceiling deterministically fails legit long jobs — `poll.ts:14` default never overridden (assemblyai/gladia/speechmatics) → permanent fail + billed orphan (adjacent B-23) — derive from audio duration.
[P1] pollUntil enforces deadline only between attempts; adapters' bare fetch has no AbortSignal — `poll.ts:16-23` + speechmatics/assemblyai/gladia — one stalled GET blocks a worker slot ≫120s, stalls whole run (distinct from B-40).
[P1] Poll deadline advisory-only — `poll.ts:16-23` — deadline checked between iterations, no AbortSignal racing `fn()`; one stalled GET suspends timeout ~300s holding vendor slot + worker + advisory lock, all three poll adapters; plus systematic overshoot (full sleep then one request past expiry) an
[P1] Poll timeout untuned and terminal — `poll.ts:14` (120s default) called bare at `assemblyai.ts:81`, `gladia.ts:92`, `speechmatics.ts:100` — job >~117s throws → `{failed,httpStatus:null}` → non-retryable (`run-executor.ts:120-130`) → permanent cell loss while the vendor job completes and bills.

===== app.ts (6) =====
[P1] No terminal error middleware + `start` never sets NODE_ENV — app.ts:32, package.json:9 — any uncaught async throw/malformed-JSON/413 → finalhandler text/html 500 with source-mapped stack to anonymous clients; ApiError becomes HTML garbage — fix: JSON error mw + NODE_ENV=production (238/251/295/
[P1] No error middleware + NODE_ENV never production — `app.ts` ends at router (verified none in `routes/index.ts`), `package.json:9` start sets nothing → Express 5 finalhandler emits `err.stack` (paths, SQL fragments, DB host) for malformed-JSON/Zod/db errors on every route.
[P1] Non-uuid path/body ids vs uuid PKs → PG 22P02 → Express5 default HTML 500 (no error middleware, `app.ts:9-33`) — `api-zod/generated/api.ts:126,427,576…` coerce.string on every param'd route.
[P2] No Express error middleware — framework errors emit HTML, breaking the `{error}` JSON contract every toast parses — `app.ts:9-33`.
[P2] No Express error middleware — `app.ts:32` router is last — async rejections become built-in HTML/plain-text 500s leaking full stacks (dev default), compounding B-1; also scan catch-block's own DB write unguarded (`agent.ts:257-261`) → 500 with scan still `scanning`.
[P3] No terminal error middleware — app.ts (verified: none registered) — any async rejection outside route try-blocks yields HTML stack-trace 500 whenever NODE_ENV≠production — add trailing JSON error handler.

===== api.ts (5) =====
[P2] zod/PG boundary gaps — unbounded `z.number()` overflows int4/float4 as opaque 500 (api.ts:83,330,365); 20+ validation sites return multi-line JSON ZodError.message blobs; `approverLabel` trims to "" accepted, spec lacks minLength (openapi.yaml:801-805); empty/punctuation entity values normalize
[P2] Approve/reject accept blank `approverLabel` server-side — `api.ts:613,650` bare `z.string()` (attest has `.min(2)` at :188), `agent.ts:309,364` trims to `""` → gold rewritten with empty compliance attribution; B-59 fix is client-only.
[P2] Zero length ceilings × full-row audit snapshots × unpaged full-table reads — `api.ts:81,84,137,143,407-408` no `.max()`/maxItems; `benchmark.ts:416-423` before+after serializeCall per PATCH; `/calls`:300-328 and `/audit-log`:1103-1110 select everything → storage-fill + memory/bandwidth DoS; fro
[P2] Non-finite `costPerMinute` bypasses `.min(0)` — `api.ts:330,365` min-only; zod@^3.25.76 accepts `1e999`→Infinity; PG `real` stores it (`schema/benchmark-providers.ts:18`); `maxCostPerMinute`=∞ pins rivals' costComponent to 1, own composite NaN (`scoring/index.ts:277-279`) — silently corrupts ra
[P2] Run bodies no `maxItems` — `api.ts:407-408` `.min(1)`-only vs import's `.max(200)` → ~2.5k-call × N-provider cell fan-out fits 100KB body.

===== deepgram.ts (5) =====
[P1] Uncapped provider-response ingest + verbatim persist — `deepgram.ts:70`, `elevenlabs.ts:74`, `assemblyai.ts:65,96`, `gladia.ts:96`, `speechmatics.ts:116` `res.json()` (gzip bombs included) → `run-executor.ts:491,512` stringify into `raw_output`; plus `cartesia.ts:359,393` unconditional `events.
[P2] No `AbortSignal.timeout` on provider POSTs — `deepgram.ts:61` (all batch adapters) — stalled socket holds semaphore + global slot ~300s until undici headers timeout; distinct sink from B-38/B-39.
[P2] Adapter HTTP calls untimeout'd; poll deadline checked only between attempts — `deepgram.ts:61-70`, `openai.ts:61-65`, `elevenlabs.ts:68-72`, `poll.ts:16-21` (`await fn()` before deadline), `vapi.ts:204` — stalled socket pins executor slot ≈300s×attempts, defeating 120s budget — fix: per-fetch `
[P1] Adapter/Vapi control-plane fetches have no timeout — `deepgram.ts:61` bare fetch; `vapi.ts:203-216` vapiGet — hung responses pin PROVIDER_CONCURRENCY slots / stall run kickoff + audio playback up to undici defaults ×attempts; B-38/B-39 cover other files only.
[P2] Diarization semantics flipped — producers score `speakers.size>0?1:0` (`deepgram.ts:37`, `gladia.ts:37`) vs tooltip "more than one speaker detected" (`Rankings.tsx:247`).

===== App.ts (5) =====
[P2] Same-path nav: confirmed "Discard" discards nothing — `App.tsx:63` reconciles same `<Review>` element, no remount — edits survive, operator told opposite.
[P2] wouter 3.10 location is pathname-only (verified `useBrowserLocation→usePathname`): resetKey constant so crashed Review persists across ?call= switches (App.tsx:60); active Review nav click strips deep link AND bypasses dirty guard (layout.tsx:34); cmd-click View-in-Results leaves dialog open (R
[P2] `retry: 2` retries permanent 4xx — `App.tsx:27` no predicate — 400/401/404/409 triple-fire per mounted query during outages/auth rollouts — fix: skip non-408/429 4xx. (downgraded P1)
[P2] HMR edit of App.tsx swaps dead QueryClient under live traffic — module-scope const (`App.tsx:22`) — in-flight mutations resolve into orphaned cache, invalidations lost; dev-only.
[P2] Global `retry:2` retries 4xx — `App.tsx:27`, zero page overrides (grep) + `refetchInterval:3000` (`Runs.tsx:376-380`) — 404 hammered ~3 req/s while dialog open; triple-fire on 401/403 app-wide.

===== custom-fetch.ts (4) =====
[P1] 200 text/html cached as typed success data — custom-fetch.ts:293-299,317-320,378 (generated hooks pass no responseType — grep-verified) — SPA-fallback/proxy HTML resolves as `BenchmarkCall[]`; `.filter` crashes into ErrorBoundary or silent fake-empty — fix: auto-mode JSON validation (237/283/28
[P2] setBaseUrl doesn't `.trim()`; CI injects VITE_API_BASE_URL verbatim — `custom-fetch.ts:28-29` + `deploy-web.yml:42,68` — whitespace repo var kills all requests.
[P2] Browser fetch has no timeout — `custom-fetch.ts:371` bare fetch, no signal — hung connection pins queries pending forever (retry/error never trigger); client twin of B-38/B-39.
[P2] No client fetch timeouts: stalled POST locks pending UI (Import/attest/approve/save buttons disabled forever, no cancel) — `custom-fetch.ts:371` bare fetch

===== lib/scoring/src/index.ts (4) =====
[P1] Unbounded O(n·m) DP in scoring — lib/scoring/src/index.ts:104-109 — hallucination-length hypothesis × long gold allocates two full matrices + sync event-loop DP mid-request → multi-second blocks/OOM; paid transcript becomes failed row — fix: token caps/banded DP (252; CLI twin 264)
[P0] Scoring DP bomb, no input ceiling — `lib/scoring/src/index.ts:102-140` via `run-executor.ts:527` (in-process) — hostile/huge provider transcript (or ~100KB gold via PATCH) → two full (n+1)×(m+1) matrices allocated sync → API-wide event-loop freeze + heap-OOM, run wedged `running` — no guard any
1. [P1] alignWords dense O(n·m) DP uncapped — `lib/scoring/src/index.ts:102-140` — long/repetition-looped transcripts (no cap anywhere; also runs client-side in Review) → multi-second event-loop stall / heap-OOM kills run mid-score — cap words or banded/linear-space DP.
[P2] wordDiff persists every `"ok"` pair — `lib/scoring/src/index.ts:151-153` → `run-executor.ts:550` detail jsonb — ~3× transcript bytes stored+served per cell forever — fix: persist non-ok ops only.

===== vercel.json (4) =====
[P2] Deploys ungated/misroutable — vercel.json:4 bare vite build (no typecheck) + deploy-web.yml:28,66 workflow_dispatch any-ref → --prod with per-ref concurrency; ci.yml independent — broken commits ship green while CI burns red — fix: gated check job + main-only condition (265/266)
[P2] SPA catch-all answers /api/* with 200 text/html — vercel.json:6 (same-origin fallback when VITE_API_BASE_URL unset) — every API call "succeeds" with index.html; combined with auto-responseType poisons caches silently — fix: /api 404 rule or build-time fail (266)
[P2] Health gate only on Replit; CI never boots API bundle, deploy-web just `vercel ls`; vercel.json `/(.*)` rewrite launders API misses into 200 HTML — ci.yml:43-47, deploy-web.yml:62-75, stt-benchmark/vercel.json:6.
[P2] vercel.json catch-all serves SPA for `/api/*` misses — `vercel.json:6` — with same-origin fallback every data call returns 200 HTML; screens silently data-dead.

===== lib/agent.ts (4) =====
[P2] lib/agent.ts verdict integrity — malformed flags payload → `[]` → recorded "clean" (:127-128); empty-candidates reasoning asserts "(every re-run provider failed)" when transcripts were empty-ok (:141); missing reasoning coerced "" beside valid pick (:171-172) — fix: throw on shape drift, neutra
[P2] Prompt injection steers LLM judge + scripts approver-facing reasoning — transcripts verbatim into prompts (`lib/agent.ts:104,154-158`), stage-1 `flags[]` launder instructions past any transcript fence, `vertical` interpolated into system prompt (:103); pick enum-pinned but reasoning persisted (
[P2] "Verbatim" flag text unenforced — description-only schema + type-only guard (`lib/agent.ts:114,129-132`); rendered as quoted evidence (`Agent.tsx:226`).
[P2] Zero-candidate reasoning lies — hardcoded "every re-run provider failed" (`lib/agent.ts:140-141`) when truth may be ok-but-empty rows filtered at `routes/agent.ts:217` (B-6 root).

===== rehearsal-scale.ts (4) =====
[P2] Rehearsal harness asserts — rankings expect `VERTICALS.length×PROVIDERS` even for `--calls<3` (rehearsal-scale.ts:221 vs executor deriving verticals from present calls) → healthy run false-FAILs; cap proof reads requested env while executor silently clamps to 16 (run-executor.ts:49-57) → headli
32. [P2] Rehearsal script edge bugs — `rehearsal-scale.ts:32` parseInt||fallback accepts -1, swallows 0/0x10 to defaults; `:146,221` CALLS<3 spuriously FAILs healthy run (asserts VERTICALS×PROVIDERS); `:233` serial estimate understates ~33% (mean 1.5L×2 attempts vs ×2L) — validate args; assert min(C
[P2] Rehearsal stubs leak in global registry off happy-path/--keep; scores assert loads whole table — `rehearsal-scale.ts:254` sole delete (earlier exits skip), `:213` SELECT no WHERE — in-process reuse accumulates closures + O(all-history) RAM — fix: try/finally unregister + scoped WHERE.
[P2] Rehearsal cleanup: runs deleted before FK-less rankings, non-atomic (crash strands dangling ranking rows forever); `Date.now()` prefix makes reruns unable to reclaim prior debris — `rehearsal-scale.ts:250-253`, `:51`

===== openapi.yaml (4) =====
[P2] Key rotation invisible — preview/import bind accountId only; no fingerprint echo/requirement (`openapi.yaml:605-609`) — rotated key 404s whole batch as ordinary per-row failures, 201-shaped; dropdown fingerprint frozen by 30s cache; `sourceAccountLabel` rename orphans playback+runs permanently 
[P2] `approverLabel` minLength drift at API layer — `openapi.yaml:805` bare string vs `:637` minLength 2 — empty attribution on gold-provenance writes reachable by any client (B-59 scoped UI prompt only).
[P2] Audio endpoint absent from OpenAPI spec — `openapi.yaml` has no audio path vs `benchmark.ts:503-526` (302/404/502) — no generated op; hand-built URL already caused B-30.
[P2] Success-only spec declarations: PATCH calls 200-only despite 400/404/two 409 gates; attest's second 409 undeclared; most 400s undeclared — `openapi.yaml:96-128`.

===== api-server/src/index.ts (4) =====
[P1] PORT hard-required but replit.md lists only DATABASE_URL (and says port 5000 vs code/CLI 8177) — `api-server/src/index.ts:6-10` vs `replit.md:7,12` — fresh boot per docs crashes; CLI ECONNREFUSED.
[P1] Zero graceful-shutdown wiring — `api-server/src/index.ts:18-25` (no captured server/signal handlers/`pool.end`; executors fire-and-forget `benchmark.ts:1006,1032`) — SIGTERM hard-kills mid-cell: paid work unwritten, runs zombie `running` — fix: capture server + SIGTERM drain + `pool.end`.
[P1] No `unhandledRejection`/`uncaughtException` handlers — `api-server/src/index.ts` — stray rejection (pg pool error is live today) insta-kills co-located hours-long executor — fix: process handlers with drain.
[P1] `PORT` required but unproducible — `api-server/src/index.ts:6-10` throws; no `.env*` committed; same var drives vite `strictPort` (`vite.config.ts:11-19,61`) — fresh clone can't boot; exporting it collides vite onto the API port.

===== generated/api.ts (4) =====
[P2] Mutations carry no AbortSignal; customFetch has no default timeout — `generated/api.ts` mutations, `custom-fetch.ts:371`, callers `Import.tsx:163`/`Agent.tsx:60`/`Review.tsx:256` — orphaned multi-minute billed POSTs; hung POST wedges buttons until reload — fix: page AbortController + `AbortSign
[P1] Malformed id ⇒ HTML 500, never 404 — id params are `coerce.string()` with no `.uuid()` (`generated/api.ts:127,356,427,609`) fed to eq(uuid col) (`benchmark.ts:379,505,897,1022`, agent routes); no error middleware (`app.ts`); UI invites truncated ids (`Runs.tsx:85` substring).
[P2] `configNote` write/read asymmetry — requests `.optional()` vs responses `.nullish()` (`generated/api.ts:334,366` vs `309,346,378`); PATCH `??` keeps old (`benchmark.ts:909`) — note clearable only to "".
[P2] Date-only strings widen to UTC midnight via `coerce.date` (`generated/api.ts:244`) vs UI local-midnight intent — API clients silently shift windows.

===== assemblyai.ts (3) =====
5. [P1] Adapter submit-leg throws escape try → executor auto-resubmits billed job — `assemblyai.ts:41-65` (fetch+json outside try :80), `speechmatics.ts:64-84` (outside try :99), `openai.ts:61` (unwrapped upload) — lost response ⇒ generic Error ⇒ `isRetryableError=true` (`run-executor.ts:140`) ⇒ job
[P2] Job-id path injection — `assemblyai.ts:82`, `speechmatics.ts:101,113` interpolate provider-controlled id into authenticated URL paths (same-host bounded, token replay).
[P2] AssemblyAI submit never pins model — `assemblyai.ts:44-49` — vendor default drift measured as "Universal".

===== deploy-web.yml (3) =====
8. [P1] Deploy not gated on CI; prod mutex keyed by ref — `deploy-web.yml:18-32,62-69` — push fires CI+deploy independently (broken commit ships while CI red); `group: deploy-web-${{ github.ref }}` + open `workflow_dispatch` + unconditional `--prod` lets stale-branch deploy finish last and roll back
[P2] VERCEL_TOKEN as `--token` argv — `deploy-web.yml:69,75` — process-cmdline exposure plus advisory GHSA-pgf8-2hgj-grqg suggested-command leak into CI logs — fix: drop flags; env var already works.
[P1] Unset GH var sent as explicit empty `--build-env` — `deploy-web.yml:42,68` — overrides Vercel-dashboard `VITE_API_BASE_URL`; bundle bakes same-origin mode, every call 404s against static host.

===== logger.ts (3) =====
[P2] Logger boot/transport fragility — logger.ts:6 `?? "info"` keeps empty/invalid LOG_LEVEL → pino throws at module load (bricks boot); pretty-transport worker 'error' unhandled → crash mid-serving; NODE_ENV gate inverted for prod-like runs (:3,12-19) — fix: validate level, attach error handler (29
[P2] pino-pretty transport default unless NODE_ENV=production — `logger.ts:12-19` — throughput collapse/backpressure + non-JSON logs in misconfigured prod.
[P2] pino transport stream lacks error listener — `logger.ts:15-18` — worker crash ⇒ ERR_UNCAUGHT_EXCEPTION kills server; `package.json` start omits NODE_ENV so default-prod uses transport — fix: `transport({...}).on('error')`.

===== schema/benchmark-results.ts (3) =====
[P2] No unique index on `(run_id,call_id,provider_id)` — `schema/benchmark-results.ts:17-43` — duplicates under documented B-40 race → duplicate `key={c.providerId}` (`Agent.tsx:240`) + double "agent's pick" badge deceiving approver.
[P2] `raw_output` TEXT uncapped on ok AND failed cells, zero retention (no DELETE routes exist) — `schema/benchmark-results.ts:36`, `run-executor.ts:471,:512`, cartesia `events[]` verbatim `cartesia.ts:359,393` — unreclaimable GB bloat feeding seq-scans — fix: truncate/cap or content-address via exi
[P2] No uniqueness constraints: results table lacks UNIQUE(run,provider,call) despite "one row per cell" comment (`schema/benchmark-results.ts:14-43`), scores lack UNIQUE(result_id,scoring_version) — duplicates persist forever and double-count in rankings averages

===== package.json (3) =====
[P2] Preinstall deletes lockfiles before PM check — root `package.json:6` `rm -f package-lock.json yarn.lock` runs before the pnpm case-guard.
[P2] Toolchain pins drift: @types/node ^25 vs node 24 runtime; no `packageManager` field; preinstall guard checks brand not ≥10.16 — workspace catalog:49, root package.json.
[P1] `.env` reaches one entry point — `--env-file-if-exists` only on api-server `start` (`package.json:9`); drizzle-kit/rehearsal/tsx scripts get raw env → db-push/rehearsal abort "DATABASE_URL required".

===== pnpm-workspace.yaml (3) =====
[P2] Supply-chain age gate bypassed via exclusion wildcards — `pnpm-workspace.yaml:30-35` `'@replit/*'`, `stripe-replit-sync` skip `minimumReleaseAge` entirely.
[P1] darwin-arm64 natives overridden `"-"`, zero lockfile resolutions → fresh macOS ARM install can't build vite/tailwind/rollup — `pnpm-workspace.yaml:79,105,115,126` (current tree survives via hand-placed real dir).
[P2] Phantom expo constraint pins react exactly; zero expo deps in any manifest — `pnpm-workspace.yaml:58-61,148-157`.

===== Dashboard.ts (3) =====
[P2] Dashboard CTA poisoned by archived — `needsReview = corpusCount − goldReadyCount` counts archived forever (`Dashboard.tsx:109-129`; server aggregates unfiltered) — phantom "N calls need gold" after routine archive.
[P2] Dashboard Overview freezes on "run in flight" forever — `Dashboard.tsx:60,119,165` — no refetchInterval, focus-refetch off; CTA screen never learns the outcome (Runs solved this for itself).
[P3] Confirmed nits: bare `$` implies wrong unit (`Dashboard.tsx:245`); `costPerMinute` unit undocumented + column `default(0)` mints free rows winning cost component (`openapi.yaml:648,660`; `benchmark-providers.ts:18`; `scoring:277`); all-disabled fleet reads "credentials not configured" (`benchma

===== ci.yml (3) =====
[P1] CI pins pnpm 9 but `minimumReleaseAge`/`onlyBuiltDependencies` are pnpm≥10.16/10.5 workspace settings → supply-chain gates dead in CI+deploy installs — `ci.yml:21`,`deploy-web.yml:48` vs `pnpm-workspace.yaml:28,71` ([changelog](https://gitlab.syncad.com/hive/beekeeper/-/merge_requests/45)).
[P2] ox-alpha doc drift: deployment.md claims CI on every push but ci.yml filters push to main (feature branch = zero CI); import parallelism/pagination documented deferred though shipped (vapi pagination + VAPI_IMPORT_CONCURRENCY present).
[P2] Supply-chain gate inert under pnpm 9 pin — `ci.yml:21`, `deploy-web.yml:48` vs `minimumReleaseAge`/`onlyBuiltDependencies` living in `pnpm-workspace.yaml:28,71` (pnpm-10-only placement; no `packageManager` field) — "critical, DO NOT DISABLE" check never runs in CI.

===== openai.ts (3) =====
[P2] submittedAt stamped pre-download/pre-stream for upload adapters vs URL-pass peers — openai.ts:38, elevenlabs.ts:45, cartesia.ts:179 — latency component structurally biased.
[P2] Download-phase failures pre-wrapped `{failed,null-status}` → terminal — openai.ts:41-54, elevenlabs.ts:49-61, cartesia.ts:184-197 + `isRetryableOutcome` :124-130 (extends B-23/B-24 class to new sites).
[P2] Audio buffer copied 3× through upload — `openai.ts:57`, `elevenlabs.ts:64` (`new Blob([new Uint8Array(buf)])`) — concurrency×3×filesize RSS spike/OOM mid-run — fix: `new Blob([buf])`.

===== Providers.ts (3) =====
[P1] Provider create invisible-success → duplicate dead rows — `Providers.tsx:166-176` — unawaited invalidate, form/dialog state never reset, no delete API; failed background refetch leaves toast-saved row unseen; resubmit mints another permanent unusable provider row (compounds B-17).
[P2] Provider toggle double-fire window — `Providers.tsx:118-134` — button re-enables before invalidated refetch repaints; duplicate no-op PATCH + toast; idempotent, cosmetic.
[P2] CreateProviderDialog never resets fields after success/cancel — Providers.tsx:142-181 (`onSuccess` :166-176 only closes+toasts) — save provider → reopen dialog pre-filled → accidental near-duplicate row that can never be deleted (no DELETE route; helper text :201-204 admits it) — reset state in

===== lib/vapi.ts (2) =====
[P1] Unvalidated Vapi recording URL = SSRF + open redirect — `lib/vapi.ts:169-176,395-405` verbatim → `types.ts:52-58` bare `fetch` (redirect-following, no scheme/host/IP check) + `benchmark.ts:517` 302; hostile Vapi → internal/metadata GETs, status oracle persisted to `/results`, fetched bytes uplo
[P1] `vapiGet` unbounded + unthrottled upstream amplification — `lib/vapi.ts:204-215` (buffers full body before `.slice(0,500)`, no AbortSignal, unbounded `res.json()`), fed by public audio-302 (×3 attempts)/preview (50 pages)/import (≤200 fetches), no rate limit anywhere.

===== gladia.ts (2) =====
[P1] GLADIA_API_KEY exfil — `gladia.ts:93-95` — hostile submit response's `result_url` polled ~40×/120s with `x-gladia-key` header, zero host validation.
[P1] Gladia fixed 120s poll cap < long-audio completion time — `gladia.ts:92`(default)+`poll.ts:14` — deterministic timeout, `httpStatus:null` + message without "safe to retry" → terminal fail while Gladia completes and bills; distinct from B-23's swallowing.

===== error-boundary.ts (2) =====
[P2] ErrorBoundary trio — Try-again clears state only (`error-boundary.tsx:46`), poisoned cache rethrows synchronously (staleTime 30s) → OK⇄ERROR flip-flop; render-throw swap destroys armed edits without consult (`:15-17`); outer boundary lacks `resetKey` (`main.tsx`) → shell errors unrecoverable in
[P2] ErrorBoundary reset replays poisoned query cache — `error-boundary.tsx:46` reset paths never invalidate; provider sits above boundary — cache-driven crash recurs on Try again/route return until reload — fix: `invalidateQueries()` on reset.

===== speechmatics.ts (2) =====
[P2] Speechmatics transcript GET never checks `.ok` → HTTP-error body parsed as ok row with "" transcript — `speechmatics.ts:112-128`; alreadyOk keys on status="ok" (`run-executor.ts:239-243`) so cell skips forever while notes claim retriable.
[P2] Speechmatics rejection reason discarded — literal throw drops `body.job` (`speechmatics.ts:106-108`), rawOutput reduced to jobId (:136).

===== import-vapi-calls.ts (2) =====
[P2] CLI `--limit` unclamped vs preview max 500 — `import-vapi-calls.ts:96` — whole preview 400s raw (B-62 sibling, different flag/route).
[P2] CLI args unvalidated — `--limit` NaN→JSON null→400 mid-flow; `" "` assistantId passes zod then filters everything silent-zero (`import-vapi-calls.ts:96,99,172` vs `vapi.ts:239-240`).

===== benchmark-rankings.ts (2) =====
[P2] rankings.run_id nullable uuid, no FK/notNull → NULL-run_id rows silently vanish from GET /rankings innerJoin; future deletes strand snapshots — `benchmark-rankings.ts:14` + `benchmark.ts:1144-1157` (latent).
[P2] `rankings.run_id` lacks FK/cascade — `benchmark-rankings.ts:14` bare uuid vs cascading siblings — run deletes leak phantom ranking rows the rehearsal comment claims cleaned.

===== stt-score.ts (2) =====
[P2] Docs promise re-score-from-rawOutput (reproducibility.md:129,165 / P2-T2); no implementation exists (stt-score.ts can't parse raw_output, no API route) — evidence-loss recovery = full re-bill
[P2] `stt-score` trusts `JSON.parse(...) as ScoreInput` (`stt-score.ts:14`) — bogus verticals/types, string numerics → exit-0 output with NaN components.

===== scoring/index.ts (2) =====
[P2] `normalizationVersion` produced, never stored — `scoring/index.ts:223` vs executor persistence :550 — normalization bumps indistinguishable on rows.
[P2] `EntityReference.type` ignored — alphanumericAccuracy gates on value regex `[A-Z]&&\d` (`scoring/index.ts:196-197`) — name-tagged values inflate digit metric.

===== lib/db/src/schema/benchmark-results.ts (1) =====
14. [P2] No unique(run_id,provider_id,call_id) backstop — `lib/db/src/schema/benchmark-results.ts` (grep: none) — any lock failure (B-40/B-70 scenario) yields permanent duplicate ok rows; rankings average cell twice, sampleSize inflated.

===== audit-log.ts (1) =====
23. [P2] Audit trail ordering/attribution — occurredAt=insert-time (`audit-log.ts:17-19`), pool-delayed inserts reorder desc(occurredAt) history; provider-PATCH afterState re-read post-sync (`benchmark.ts:915-928`) records another writer's values as this actor's change.

===== types.ts (1) =====
[P1] Transient audio-download failures are terminal — types.ts:52-58 + openai.ts:41-53 + elevenlabs.ts:50-61 — storage 5xx/reset flattened to `failed{httpStatus:null}` → `isRetryableOutcome(null)`=false → 0 of 3 attempts; run completes over biased subset — fix: propagate status/retryable classificat

===== routes/health.ts (1) =====
[P1] healthz static `ok`, gates deploys — routes/health.ts:6-9 — no DB ping; dead-DB instance stays "healthy" to orchestrator — fix: SELECT 1 readiness (251/297)

===== benchmark-agent-scans.ts (1) =====
[P2] Cascade-deleted call mid-scan — benchmark-agent-scans.ts:38 onDelete:cascade + routes/agent.ts:231-263 — `.returning()`=[] → undefined destructure; writeAudit records "flagged" for vanished row; crash inside catch → 500 (today requires out-of-band/manual call deletion; no DELETE route) — fix: g

===== routes/benchmark.ts (1) =====
[P1] `blocked` run absorbing; execute lies 202 — `routes/benchmark.ts:984`,`:1014-1036` + `run-executor.ts:210-217` (gate omits blocked, bare return) — no PATCH/unblock route, UI hides button (`Runs.tsx:121`) — fixing blockers → endless silent-no-op retries; 8 agents converged.

===== benchmark-results.ts (1) =====
[P2] Failed-row purge violates declared immutability — `benchmark-results.ts:14-16` comment vs delete+reinsert (`run-executor.ts:255-262`), audit logs counts only — recomputability evidence destroyed.

===== use-toast.ts (1) =====
[P2] Toast machine — `TOAST_LIMIT=1` slice evicts older toast without dismiss (`use-toast.ts:74-78`) — destructive error swallowed when two land together (example pair in report sloppy; real pairs exist, e.g. audio-error + save toast); evicted timers leak ~16.7min phantom REMOVE (`:4,56-70`); unifor

===== lib/db/package.json (1) =====
[P2] Infra hardening — `push-force` auto-accepts data-loss with no env guard (`lib/db/package.json:12`, config accepts any DATABASE_URL); dev-shell vs postMerge hook two writers share one URL; no post-push introspection assert.

===== api-zod/generated/api.ts (1) =====
5. [P1] `costPerMinute: Infinity` accepted end-to-end — `api-zod/generated/api.ts:330,365` min-only (`JSON.parse("1e999")===Infinity` passes) → pg float4 stores Infinity → wire `null` → `Providers.tsx:91` `.toFixed` TypeError bricks page; poisons cost math — add finite/maximum + serialize guard.

===== benchmark-providers.ts (1) =====
21. [P2] Unpriced provider (DB DEFAULT 0, `benchmark-providers.ts:18`) wins cost component — `run-executor.ts:536` books $0 → component 1 (`index.ts:277`) beats priced rivals; all-zero vertical silently inert — treat 0 as unknown.

===== select.ts (1) =====
[P1] Tailwind v4 voids `[--var]` bracket classes (needs parens) — `select.tsx:77`, tailwindcss 4.3.3 installed — Radix Select loses max-height cap; Agent picker overflows viewport.

===== benchmark-scores.ts (1) =====
[P2] Scores table 1:N-by-design vs 1:0..1 results contract; first re-score double-counts rows/rankings — `benchmark-scores.ts:6-15` + leftJoin `benchmark.ts:1049-1052` (latent).

===== api-client-react/src/index.ts (1) =====
[P2] ApiError/ResponseParseError not exported from client root — `api-client-react/src/index.ts` — Dashboard reports erroring-but-healthy API as "not running".

===== agentScan.ts (1) =====
[P2] Latent type drift: generated TS promises Date where wire is ISO string (agentScan.ts:33, masked by `new Date()` today); unconstrained dead-twin insertBenchmarkCallSchema export; updatedAt column hand-written but API-invisible — benchmark-calls.ts:86-103.

===== ui/toaster.ts (1) =====
[P2] Toasts never auto-dismiss + 16.7min dismissal retention — `ui/toaster.tsx:10` (bare ToastProvider, Radix duration ∞), `use-toast.ts:4` — stale destructive error squats the single TOAST_LIMIT=1 slot, misleading operator — fix: `duration={5000}` + sane remove delay.

===== github/workflows/ci.yml (1) =====
[P2] Poisoned pnpm store cache pinned by failed install — `.github/workflows/ci.yml:23-29` — setup-node post-save unconditional, exact-key restore (shared with deploy-web) — CI reinstalls crippled tail every run until lockfile changes — fix: actions/cache gated `if: success()`.

===== main.ts (1) =====
[P2] Empty `VITE_API_BASE_URL=""` silently skipped — `main.tsx:14` truthiness — split-host deploy 404s every API call with zero config error (distinct from B-18).

===== schema/benchmark-rankings.ts (1) =====
[P2] Schema integrity gaps: `rankings.run_id` no FK → stranded rows vanish silently from innerJoin readers, no rebuild endpoint; scans' runId/pickResultId FKs default NO ACTION → run cleanup deadlocks its own cascade — `schema/benchmark-rankings.ts:14`, `benchmark-agent-scans.ts:52-55`

===== scripts/src/import-vapi-calls.ts (1) =====
[P1] CLI bills wrong workspace by default — `scripts/src/import-vapi-calls.ts:153-155` takes label-sorted `accounts[0]` (`vapi.ts:104` localeCompare; "Client Acme"<"Default") during documented no-flag invocation.

===== res.json (1) =====
[P2] Submit-phase `res.json()` outside try ×3 — `assemblyai.ts:65`, `gladia.ts:77`, `speechmatics.ts:84` — non-JSON 2xx SyntaxError is generic-retryable (`run-executor.ts:140`) → submit re-run N×, duplicate billed jobs.

===== audit.ts (1) =====
[P2] Actor attribution broken — `x-actor` read (`audit.ts`) but web app never sends it (grep: zero); bearer getter attaches `Authorization` nobody parses (`custom-fetch.ts:362-367`; `app.ts` mounts no auth) — every UI mutation logged "unknown".

