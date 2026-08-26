# STT-evals Bug Register — ox-alpha synthesis

- Method: 100-agent parallel bug-hunt swarm; 98 returned reports; deduplicated to 81 register entries (raw ~190 findings → 81 after merging same-file/same-root-cause reports; every P0/P1 claim re-verified against source by the synthesizer).
- Date: 2026-08-25
- Branch: `provider-adapters-run-executor` (HEAD `6e985e6`, "Fix unplayable audio: Vapi recording URLs are signed and expire")
- Repo layout audited: `artifacts/stt-benchmark` (web UI), `artifacts/api-server` (Express API + run executor + rehearsal script), `lib/{scoring,stt-providers,db,vapi?*,api-zod,api-client-react,api-spec}` (`lib/vapi.ts` lives in `artifacts/api-server/src/lib/`), `scripts/src`, `.github/workflows`.

## Known-fixed / excluded (not registered)

Agents re-flagged several things the code already fixed or documents as accepted; these were dropped after spot-checks:

- Duplicate failed-result rows accumulating across retries — fixed 2026-08-25 (stale non-ok row delete, `run-executor.ts:246-262`).
- Server-side refusal to re-execute `complete`/`running` runs — fixed (`run-executor.ts:195-217`); the surviving gap is UI-only (B-15).
- Run `notes` piling up across retries — fixed (`run-executor.ts:374-381`); loss of caller-authored notes registered separately (B-68).
- `createdAtGe` vs `Gt` cursor tie-group loss — fixed (comment at `vapi.ts:257-261`).
- Unsigned bare `recordingUrl` fallback after retries — documented accepted risk (bucket-403 item, `docs/backlog/good-to-have.md`).
- Legacy truncated `vapiLabelFor` labels orphaning old rows — moot; `sourceCallId` backfilled on all legacy rows (`docs/backlog/good-to-have.md:125`).
- Generated-schema drift (`api-zod` vs `openapi.yaml`) — none; regen verified byte-identical (agent-95).
- Negative `costPerMinute` accepted end-to-end — REFUTED: zod `.min(0)` enforced on create and update (`lib/api-zod/src/generated/api.ts:328,365`); dropped.
- x-actor no-auth stopgap is acknowledged in `lib/audit.ts` header — still escalated below as B-1/B-4 because the blast radius is unstated anywhere.

---

## P0

### B-1 · Entire API is unauthenticated: full corpus transcript/audio dump + live workspace exposure + unauth vendor spend
- File: `artifacts/api-server/src/app.ts` (no auth middleware, verified) · `artifacts/api-server/src/routes/benchmark.ts:226-230` (serializeCall exposes goldTranscript/draftTranscript/audioObjectPath on GET /calls), `:503-526` (audio 302 proxy), `:1067-1068` (results incl. hypotheses + errorMessage), `:1091-1124` (audit-log returns serializeCall before/after snapshots written at `:421-422`), `:600-690` (POST /vapi/preview returns live presigned recording URLs + transcript previews for the whole workspace window)
- Trigger: two anonymous GETs (`/calls` → id list → `/calls/:id/audio`) download every customer call's text + audio; any curl can mint attestations, rewrite gold, launch paid provider runs, or hold all pg pool clients with ~10 concurrent scans.
- Impact: total PHI/transcript breach; unbounded vendor billing; FR-C3 compliance gate defeatable by body-supplied `approverLabel`.
- Fix: auth middleware on `/api`; redact transcripts from list/audit serializers; serve audio only through gated proxy; drop `recordingUrl` from preview responses; take actor identity from principal.
- Confidence: high (verified: `app.ts` mounts cors/json/router only; serializers confirmed).

### B-2 · Speechmatics adapter submits audio under wrong config key — provider dead on arrival
- File: `lib/stt-providers/src/adapters/speechmatics.ts:58`
- Trigger: every `transcribe()` posts `"fetch_url": { url }`; Speechmatics JobConfig defines the URL-input section as `fetch_data` ([Speechmatics Input – Batch](https://docs.speechmatics.com/speech-to-text/batch/input)).
- Impact: no input source is recognized → submit 400s or job rejects instantly → every Speechmatics cell in every run fails permanently (4xx = non-retryable).
- Fix: rename key to `fetch_data: { url }` (or `input.fetch_data` per current schema); add a contract test hitting the real API.
- Confidence: high (code verified; docs verified).

### B-3 · Vercel deploy uploads only `artifacts/stt-benchmark`, so the production web build can never succeed
- File: `.github/workflows/deploy-web.yml` (deploy step `working-directory: artifacts/stt-benchmark`) + `artifacts/stt-benchmark/package.json:51-52` (`@workspace/*: workspace:*`) and `catalog:` specs resolvable only via repo-root `pnpm-workspace.yaml`/lockfile
- Trigger: push to main → `vercel deploy` uploads only the subdirectory → install fails on unresolvable workspace deps.
- Impact: web app cannot deploy, ever; CI shows red or the failure is buried in Vercel logs.
- Fix: deploy repo root with project Root Directory set to `artifacts/stt-benchmark`, or vendor the two workspace libs with pinned versions into the app package.
- Confidence: high (verified both files).

---

## P1

### B-4 · CORS wildcard makes x-actor trust browser-exploitable (drive-by forgery)
- File: `artifacts/api-server/src/app.ts:28` (bare `cors()`, verified) + `artifacts/api-server/src/lib/audit.ts:8-12` (actor from `x-actor`)
- Trigger: any malicious page fetches `POST /attest-deid` etc. from a visitor's browser; preflight passes with `Access-Control-Allow-Origin: *` and reflected `x-actor`.
- Impact: drive-by forging of de-ID attestations (defeats FR-C3), gold rewrites, paid runs — attributed to a spoofed actor in the audit trail.
- Fix: origin allowlist from env; ignore client-supplied `x-actor` for privileged mutations once auth exists.
- Confidence: high.

### B-5 · Presigned recording URL leaked through persisted `errorMessage` to any results reader
- File: `lib/stt-providers/src/types.ts:55` (interpolates full `${audioUrl}` into thrown Error, verified) → copied verbatim by adapters (e.g. `adapters/openai.ts:51`, `cartesia.ts:194`, elevenlabs) → persisted at `run-executor.ts:472-475` → served by `routes/benchmark.ts:1068`.
- Trigger: any audio-fetch failure while the signed URL is valid (storage 5xx, reset mid-body).
- Impact: unauthenticated clients reading `/runs/:id/results` get a live `X-Amz-Signature` credential to call recordings until expiry — combines with B-1 into silent PII exfil.
- Fix: propagate only `new URL(audioUrl).pathname` (strip query) in error text; scrub existing rows.
- Confidence: high.

### B-6 · Orphan `ok` result row permanently skips an unscored cell (resume + rankings hole)
- File: `artifacts/api-server/src/lib/run-executor.ts:500-520` (inserts row with provider-reported status, then `return "failed"` when transcript empty), `:239-243` (`alreadyOk` keys on `status==="ok"` only), `:255-262` (stale cleanup keeps ok rows), `:554-573` (score-insert throw leaves ok row + adds second failed row); fed by adapters that report ok-on-empty: `adapters/deepgram.ts:86-96` (verified unconditional `status:"ok"`), `openai.ts:85`, `elevenlabs.ts:90-92`, `gladia.ts:103`, `speechmatics.ts:112-117`.
- Trigger: provider returns HTTP 200 with null/"" transcript (silent/hold-music audio), or score insert throws after result commit.
- Impact: cell never retried, never scored, invisible to rankings innerJoin; run reports "complete" while notes claim "can be retried"; duplicate contradictory rows possible.
- Fix: transaction around result+score inserts; persist `failed` (with reason) whenever transcript falsy; define `alreadyOk` as results having a score row.
- Confidence: high (all executor lines verified).

### B-7 · `runningRuns` entry / advisory lock leak bricks a run's re-entry until process restart
- File: `artifacts/api-server/src/lib/run-executor.ts:160-181` — `runningRuns.add(runId)` at `:160`, `pool.connect()` at `:162` outside the `try`; `finally` unlock query at `:177` unguarded, skipping `release()`+`delete()` (verified).
- Trigger: `pool.connect()` rejection (DB bounce/exhaustion) or advisory-unlock failure (failover).
- Impact: every future POST `/execute` for that runId silently no-ops ("already running"); pinned pool client leaks; documented crash-recovery path dead.
- Fix: outer try/finally guaranteeing `delete(runId)`; wrap unlock in its own try/catch.
- Confidence: high.

### B-8 · Attest-deid route: TOCTOU races lose/overwrite approvals; whitespace & Unicode defeat FR-C3
- File: `artifacts/api-server/src/routes/benchmark.ts:446` (trim AFTER zod min(2) → `"  "` stored as ""), `:448-453` + `:480-484` (blind UPDATEs guarded only by `eq(id)` — verified), `:468` (case-fold-only distinctness: no NFC normalize; locale-sensitive `toLowerCase`).
- Trigger: two curators attest concurrently (last-write-wins; worst interleaving yields first="Bob", second="Bob"); one person submits `"Renée"` then NFD variant; whitespace-only label.
- Impact: compliance record corruption: two-person gate satisfied by one actor, or an approval silently discarded with 200s + lying audit rows.
- Fix: validate trimmed length ≥2 in zod; conditional atomic UPDATEs (`WHERE de_id_... IS NULL` / `ne(first)`); NFC-normalize both sides; 409 on 0 rows.
- Confidence: high.

### B-9 · In-flight agent scan overwrites human decisions (resurrect / error-clobber)
- File: `artifacts/api-server/src/routes/agent.ts:236-240` (success path sets `flagged` unconditionally), `:253-260` (catch sets `error` unconditionally — both verified); enabled by reject route accepting `scanning` scans (`:359-361`, verified).
- Trigger: operator rejects a scan while its pipeline (providers + 2 LLM calls, minutes) is still awaited.
- Impact: rejection silently reverted to approvable `flagged`, or decided scan flipped to `error`; audit contradicts row state.
- Fix: CAS final writes `.where(and(eq(id), eq(status,"scanning")))`; skip if 0 rows; restrict reject to `flagged`.
- Confidence: high.

### B-10 · Approve-vs-reject TOCTOU corrupts gold provenance; approve resurrects archived calls
- File: `artifacts/api-server/src/routes/agent.ts:275-330` (approve: guard read, then unconditional call + scan updates — verified), `:359-369` (reject: blocks only approved/rejected), `:313-318` (`canAdvanceStatus ? "ready_to_run" : call.status` ignores terminal `archived`).
- Trigger: approve + reject race (two tabs/operators); or approve a still-flagged old scan whose call was archived.
- Impact: goldTranscript replaced by a pick whose scan says "rejected … no change made"; archived call re-enters run eligibility with agent-picked gold; contradictory audit.
- Fix: single conditional `UPDATE … WHERE id AND status='flagged'` per decision, 409 on 0 rows before touching the call; refuse approve when `call.status==="archived"`; disable sibling button while either isPending (frontend half).
- Confidence: high.

### B-11 · PATCH strips the ready_to_run gold invariant → paid runs score against an emptied reference
- File: `artifacts/api-server/src/routes/benchmark.ts:389-405` — gate fires only when incoming `body.data.status === "ready_to_run"` (verified); `{"goldTranscript":""}` alone passes zod (plain optional string) and clears gold on an already-ready call.
- Impact: executor scores `gold ?? ""` (`run-executor.ts:531`), persists `wer:null` rows, publishes garbage rankings after real vendor spend.
- Fix: gate on resulting state `(body.data.status ?? current.status) === "ready_to_run"`; add CHECK constraint.
- Confidence: high.

### B-12 · Audit insert failure poisons already-committed operations (double-billing, fake 500s)
- File: `artifacts/api-server/src/lib/audit.ts:21` (awaited insert, no internal catch — verified); hot sites: `routes/agent.ts:250` catch marks fully-paid scan `error`; `routes/benchmark.ts` CRUD awaits `writeAudit` after commit before responding; `run-executor.ts:385-392` terminal audit unguarded.
- Trigger: transient DB error during any post-commit audit write.
- Impact: same failure yields three inconsistent outcomes — paid scan marked error (re-run = double spend), persisted mutation reported 500 (retry duplicates rows), or swallowed as "execution crashed"; NFR-5 record lost in all.
- Fix: make `writeAudit` best-effort internally (log-and-continue); never let audit failure alter request outcome.
- Confidence: high.

### B-13 · Background refetch failure swaps the whole Review editor for the error panel, destroying unsaved edits
- File: `artifacts/stt-benchmark/src/pages/Review.tsx:346` (`if (isError)` unconditional — verified; cached `data` remains but is ignored)
- Trigger: any Save/list invalidation refetch that fails after retries (network blip) while curator has typed gold/entities.
- Impact: silent loss of curated edits; Retry remounts with saved values, hiding that anything was lost.
- Fix: `if (isError && !calls)`; inline banner + refetch button when data exists.
- Confidence: high.

### B-14 · Sidebar SPA navigation discards unsaved Review edits without confirm
- File: `artifacts/stt-benchmark/src/App.tsx:59-67` (conditional mount per path — verified) + `pages/Review.tsx:319-324` (only `beforeunload` guarded)
- Trigger: type gold text, click any sidebar link — pushState never fires beforeunload, Review unmounts.
- Impact: silent loss of curated gold/entities via the primary nav path (queue-click/j-k/tab-close are guarded; this isn't).
- Fix: shared navigate wrapper confirming when `dirty`, or keep Review mounted across routes.
- Confidence: high.

### B-15 · Execute button hidden for `complete`/`running` runs the backend explicitly supports retrying
- File: `artifacts/stt-benchmark/src/pages/Runs.tsx:115` (`(run.status==='failed'||run.status==='queued') && <ExecuteButton/>` — verified) vs `run-executor.ts:195-217` (gate deliberately accepts `complete`+`running` — verified).
- Trigger: partial outage → run ends `complete` with notes "…can be retried by re-executing this run"; crash leaves `running` zombie.
- Impact: the promised idempotent retry is unreachable from the only UI that mentions it; workaround (new run) re-bills every successful cell; zombie polls forever with no recovery.
- Fix: render ExecuteButton for `complete|running|failed|queued` (backend guards make it safe); show badge for running.
- Confidence: high.

### B-16 · Cross-account stale-preview gate is inert — imports account A's ticked ids under account B
- File: `artifacts/stt-benchmark/src/pages/Import.tsx:95` (`previewedAccountId !== null && …`) with handlers clearing the binding instead of arming the compare: account `:247`, dates `:281`,`:285` (all verified); Import enabled at `:453`.
- Trigger: preview under account A, tick rows, switch account (or edit dates) → `previewedAccountId=null` ⇒ `stalePreview===false` ⇒ banner never shows, submit sends A's `vapiCallIds` with `accountId: B`.
- Impact: every row fetches under the wrong key → per-row `failed`, wasted curation, zero warning.
- Fix: keep binding and compare; or clear `previewCalls`+`selected` in those handlers.
- Confidence: high.

### B-17 · Provider create form can never mint an adapter-matched provider — mints permanent dead rows
- File: `artifacts/stt-benchmark/src/pages/Providers.tsx:202-203` (helper text demands exact adapter id — verified) vs `routes/benchmark.ts:859` (`id = slug(name-model)-uuid6` — verified) + `lib/stt-providers/src/registry.ts` exact-key lookup (verified).
- Trigger: operator follows the note ("Must match … deepgram-nova-3") → stored id gets uuid suffix → `getProviderAdapter` never matches.
- Impact: every UI-created row is `hasAdapter:false`, runs fail its cells, and it can never be deleted (no DELETE route).
- Fix: accept/derive exact registry id (reject unknown ones server-side), or let payload carry the id verbatim when it matches the registry.
- Confidence: high.

### B-18 · Documented `VITE_API_BASE_URL` value doubles the `/api` prefix — every API call 404s in split-host deploys
- File: `lib/api-client-react/src/custom-fetch.ts` (`setBaseUrl` strips slashes only; `applyBaseUrl` prepends base to `/api/...` generated paths — verified) + `artifacts/stt-benchmark/src/main.tsx:15`; recommended value WITH `/api`: `.github/workflows/deploy-web.yml` comment + `ox-alpha/deployment.md:38` (both verified).
- Trigger: configure exactly as documented → requests go to `https://host/api/api/healthz`.
- Impact: total data failure in the deployment mode the feature was built for.
- Fix: strip trailing `/api` segment in `setBaseUrl`, or fix docs/workflow to origin-only value (do both: defensive strip + doc).
- Confidence: high.

### B-19 · Entity normalization strips diacritics — accented gold entities can never match
- File: `lib/scoring/src/index.ts:90-95` — `normalizeEntity` does NFKC→upper→`[^A-Z0-9]` strip with no NFD/Mark decomposition (verified): `"CAFÉ"→"CAF"` vs hyp `"cafe"→"CAFE"`.
- Impact: perfectly-read accented names/cities score as miss, deflating entityAccuracy + alphanumericAccuracy (0.40+0.25 composite weight) for any vertical with diacritics.
- Fix: NFD-normalize and strip `\p{M}` before the A-Z0-9 filter.
- Confidence: high.

### B-20 · Entity matching is boundary-less substring — partial/wrong reads scored as exactMatch
- File: `lib/scoring/src/index.ts:192` — `normalizedHypothesis.includes(normalized)` (verified): `"14512"` contains `"4512"` ✓; `"CALL"` contains `"AL"` ✓; cross-token fusion `"FOR1216"`.
- Impact: inserted/missing digits or unrelated words satisfy entity reads; inflates the heaviest composite metric and skews procurement rankings.
- Fix: anchor matches with `(?<![A-Z0-9]) … (?![A-Z0-9])` over separators-preserving normalized hypothesis (still permits spaced-VIN gaps the tests codify).
- Confidence: high.

### B-21 · Cartesia: post-finalize abnormal close returns truncated transcript as `ok`
- File: `lib/stt-providers/src/adapters/cartesia.ts:381-385` (close handler checks only `!finalizeSent`) + `:394-400` (`connectError ?? reduced.errorMessage ?? …`; any partial transcript ⇒ ok) — verified.
- Trigger: server drops (close 1006/1011) after finalize sent but before finals flush.
- Impact: silently truncated transcripts enter WER/rankings as good data — same corruption class the in-file comments say previously tanked Cartesia's scores.
- Fix: treat any close code ≠1000 as failure, or require a final segment received after `finalizeSent` before returning ok.
- Confidence: high.

### B-22 · Presigned audio URL resolved once per run — expiry mid-run truncates long runs silently
- File: `artifacts/api-server/src/lib/run-executor.ts:270-310` (per-call resolution Map frozen into every cell + retries — verified); Vapi presign TTL observed 1800s (`docs/provider-data-samples.md`).
- Trigger: run wall-time > ~25min (certain at target scale with real-time Cartesia streaming + concurrency 4).
- Impact: late cells die on S3 403-expired classified non-retryable; run still finalizes `complete` over a non-randomly biased subset; notes misattribute cause.
- Fix: record per-URL resolve time; re-resolve (or add "stale-audio" outcome that refreshes once) when older than ~25min.
- Confidence: medium-high (mechanism verified; TTL from repo docs, not live test).

---

## P2

### B-23 · Poll adapters swallow transient errors into unretryable results; ignore HTTP status; orphan billed jobs
- File: `lib/stt-providers/src/adapters/assemblyai.ts:85-113`, `gladia.ts:93-123`, `speechmatics.ts:100-139`, `poll.ts:14-21`
- Trigger: one network reset/non-JSON 5xx during polling → blanket catch returns `{status:"failed", httpStatus:null}` → `isRetryableOutcome(null,…)=false` → zero retries though the remote job completes and bills; poll HTTP status never checked (404/401 hammer until 120s timeout); timeout path never DELETEs the job (re-runs double-bill).
- Impact: paid transcripts discarded on single blips; compounding orphan jobs; misleading "Polling timed out" diagnostics.
- Fix: let unknown poll/fetch errors throw (executor retries them); check `pollRes.ok` (429/5xx → keep waiting/backoff, definitive 4xx → fail fast); best-effort DELETE job in every post-submit failure path.
- Confidence: high (three independent agents converge; executor contract comment confirms intent).

### B-24 · Cartesia transport failures get zero retries (null httpStatus unclassified)
- File: `artifacts/api-server/src/lib/run-executor.ts:124-129` + `adapters/cartesia.ts:277,287,375`
- Trigger: WS connect/response timeouts and connection errors surface as `httpStatus:null` with messages lacking "safe to retry".
- Impact: most likely failures under load permanently fail Cartesia cells in one shot, biasing latency/WER rankings vs batch providers.
- Fix: classify null-status results whose message matches timeout/connection patterns (or carry wsCloseCode marker) as retryable.
- Confidence: medium.

### B-25 · Vapi list pagination depends on undocumented `order=asc`; failure mode is silent one-page truncation
- File: `artifacts/api-server/src/lib/vapi.ts:256` (`params.set("order","asc")` — verified) with `freshCount===0` break at `:277` acknowledging "sort-order surprise".
- Trigger: if Vapi's GET /call ignores/rejects unknown `order` (official param list: limit, createdAt*, ids, assistantId… — not verifiable from this repo), descending results make the `Ge` cursor immediately exhausted.
- Impact: previews silently return ~one newest page (reintroducing the >1000-call truncation this function was written to fix) or hard-fail; operators import incomplete windows believing them complete.
- Fix: paginate natively descending with `createdAtLt` watermark, or probe sort direction once and fail loudly on `freshCount==0` at page 0.
- Confidence: medium (param support unconfirmed against live API).

### B-26 · Dashboard `latestRunStatus` polluted by `agent_scan` runs
- File: `artifacts/api-server/src/routes/benchmark.ts:264-271` (newest run, no purpose filter — verified) vs `:941` and `:1148` (both filter `purpose="batch"`).
- Trigger: any Agent-page scan after the last batch run.
- Impact: Overview "Latest run"/decision cards flip on 1-call scans; a failed scan masks a healthy pipeline (and vice versa), inviting duplicate paid launches.
- Fix: add `eq(benchmarkRunsTable.purpose,"batch")` to the dashboard query.
- Confidence: high.

### B-27 · QueueRunDialog: 201-blocked run toasted as "started"; stale provider selection sent verbatim
- File: `artifacts/stt-benchmark/src/pages/Runs.tsx:197` (unconditional success toast — verified), `:151,177-189` (selection pruned nowhere except post-success; grid renders only readyProviders), `:160-171` (cellCount counts stale ids, estimatedCost skips them).
- Trigger: any selected provider loses readiness before submit (concurrent edit, agent scan).
- Impact: operator told paid eval started when the run is `blocked`; blocker notes only visible as truncated badge text; displayed price ≠ submitted scope.
- Fix: inspect `data.status` in onSuccess (destructive toast with `notes`, keep dialog open); intersect selection with readyProviders for display+submit.
- Confidence: high.

### B-28 · `save()` always sends `status:"gold_in_review"` and ⌘Enter bypasses dirty/pending guards
- File: `artifacts/stt-benchmark/src/pages/Review.tsx:240` (status construction — verified), `:292-295` (Cmd+Enter calls `save()` raw — verified), `:498` (button disabled `!dirty || isPending`).
- Trigger: Save (or repeated ⌘Enter) on a call manually moved to `ready_to_run`/`archived` in Corpus demotes it back; overlapping PATCHes can land out of order.
- Impact: calls silently drop out of Runs eligibility (FR-C2 violation); last-committed-wins lost updates reported as "Saved".
- Fix: send `status` only when current status is `needs_review|ready_for_gold`; early-return in handler when `!dirty || updateCall.isPending`.
- Confidence: high.

### B-29 · Play/pause icon desyncs from native audio controls (Space then pauses instead of playing)
- File: `artifacts/stt-benchmark/src/pages/Review.tsx:604-622` — `<audio controls>` wires only `onEnded/onError`; no `onPlay/onPause` (verified).
- Trigger: start playback via native bar → `playing` stays false → Space toggles opposite of the visible icon until ended/switch.
- Impact: constant reviewer confusion in the core verification loop.
- Fix: `onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)}` on the element.
- Confidence: high.

### B-30 · Review audio player hardcodes same-origin `/api` — playback dead under supported split-hosting
- File: `artifacts/stt-benchmark/src/pages/Review.tsx:611` (`src={`/api/benchmark/calls/${id}/audio`}` — verified).
- Trigger: static deploy with `VITE_API_BASE_URL` (supported mode, see B-18); audio request hits the static host, gets index.html.
- Impact: "Couldn't load audio" for every call; gold can't be verified against audio in production topology.
- Fix: build src from the configured base (same helper the client uses).
- Confidence: high.

### B-31 · Rankings CSV export: formula injection, bare `\r` row splits, no UTF-8 BOM
- File: `artifacts/stt-benchmark/src/pages/Rankings.tsx:53-76` — escape quotes only `[",\n]`; no `=`/`+`/`-`/`@`/Tab neutralization; blob lacks `\uFEFF` (three agents converge).
- Trigger: provider name (free-text, creatable by anyone per B-1) like `=HYPERLINK(...)` flows into the exported decision sheet.
- Impact: formula/DDE execution in Excel on open; `\r` silently shifts columns; non-ASCII names mojibake.
- Fix: prefix dangerous leading chars with `'`; add `\r` to escape class; prepend BOM.
- Confidence: high.

### B-32 · Query invalidation gaps: dashboard aggregate never invalidated; Execute skips rankings
- File: `artifacts/stt-benchmark/src/pages/Runs.tsx:194` (+ every other mutate site) never invalidates `["/api/benchmark/dashboard"]`; `Runs.tsx:291` Execute invalidates only the runs list.
- Trigger: queue/execute/import/attest then reach Overview (or /results) within staleTime 30s with focus-refetch off.
- Impact: stale `latestRunStatus` renders "Queue a run" next-action right after queuing — the duplicate-paid-launch invite; re-executed rankings lag behind retries.
- Fix: add dashboard (and rankings on execute) `invalidateQueries` next to existing list invalidations.
- Confidence: medium-high.

### B-33 · Duplicate `vapiCallIds` / concurrent imports hit unique index → whole batch 500s with partial state
- File: `artifacts/api-server/src/routes/benchmark.ts:721-730` (check-then-insert), `:765-794` (insert+audit outside the fetch-only try/catch), `:817-823` (non-VapiConfigError rethrown); zod allows duplicates (`generated/api.ts:280`); five agents independently confirmed.
- Trigger: same id twice in one request, or overlapping import requests.
- Impact: 500 despite N successful imports committed+audited; per-call outcomes lost; contradicts the route's own batch-continues contract.
- Fix: dedupe ids pre-drain; wrap insert in try/catch mapping PG 23505 to `skipped_duplicate` (`.onConflictDoNothing`).
- Confidence: high.

### B-34 · Disabled provider still transcribes via run re-execute
- File: `artifacts/api-server/src/routes/benchmark.ts:1014-1037` (execute path: no `syncProviderReadiness`, no status check) + `runCell` gates only adapter+key (`run-executor.ts:405-417`).
- Trigger: PATCH `{disabled:true}` then POST `/runs/:id/execute` on any eligible run containing that provider.
- Impact: explicitly disabled vendor's cells run and bill anyway, entering rankings.
- Fix: drop/mark `manuallyDisabled` providers' cells config_blocked inside `executeBenchmarkRun`.
- Confidence: medium-high.

### B-35 · Self-confirm guard is dead code — Vapi vendor string compared against registry id
- File: `artifacts/api-server/src/routes/agent.ts:167-169` (`p.id !== call.sourceTranscriberProvider`) vs `routes/benchmark.ts:783` (`transcriber?.provider` from Vapi cost entry, e.g. "Deepgram") vs registry ids like `deepgram-nova-3` (verified mismatch by construction).
- Trigger: agent scan on a Vapi-imported call drafted by Deepgram.
- Impact: the flagged span gets "fixed" by the same provider that mis-transcribed it; one Approve click (advertised as "every other provider") writes that self-confirmation into gold, poisoning every WER.
- Fix: map vendor/model string to registry ids (prefix match) before exclusion.
- Confidence: high.

### B-36 · Concurrent scans on one call double-bill providers; UI pending state lost across unmount
- File: `artifacts/api-server/src/routes/agent.ts:134-143,185-206` (no per-call dedup; advisory lock is per-runId) + `artifacts/stt-benchmark/src/pages/Agent.tsx:41,106` (mutation-local `isPending` resets on remount — verified mechanism).
- Trigger: navigate away and back mid-scan (pipeline takes minutes), then resubmit.
- Impact: duplicate full-corpus provider runs (real spend), competing flagged rows, silent last-write-wins on approve.
- Fix: 409 on existing `scanning` scan for callId (partial unique index); frontend derives in-flight from the polled scans list.
- Confidence: high.

### B-37 · Assistant-ID / Max-calls changes leave stale preview "fresh"
- File: `artifacts/stt-benchmark/src/pages/Import.tsx:269-271` (assistantId onChange) and `:294` (limit onBlur) — neither touches `previewedAccountId` unlike account/date handlers (verified).
- Trigger: preview blank-filter (all rows pre-ticked), type an assistant ID, click Import without re-previewing.
- Impact: imports the entire untightened set while operator believes scope narrowed; no warning.
- Fix: mirror the account/date handlers (`setPreviewedAccountId(null)`) in both onChange paths.
- Confidence: high.

### B-38 · `fetchAudioBytes` has no timeout and no size cap
- File: `lib/stt-providers/src/types.ts:52-58` (bare `fetch`, unbounded `arrayBuffer()` — verified).
- Trigger: storage trickles a body, or an oversized/wrong object fans out to 16 concurrent cells.
- Impact: hung cell pins its global worker slot + provider semaphore + the run's advisory lock/runningRuns guard until restart; RSS spike can OOM-kill the API mid-run (run stuck `running`).
- Fix: `AbortSignal.timeout(...)` sized above transcription time; reject when content-length exceeds a cap.
- Confidence: high.

### B-39 · OpenAI judge/flag calls lack timeouts; response parsing fragile
- File: `artifacts/api-server/src/lib/agent.ts:50` (no AbortSignal), `:73` (`res.json()` before `!res.ok` — HTML gateway bodies throw SyntaxError, losing status), `:85` (unguarded `JSON.parse(content)` — `finish_reason:"length"` truncation explodes).
- Impact: scans hang up to undici's 300s ×2 calls; typed errors lost to parse noise in `errorMessage`.
- Fix: `AbortSignal.timeout(120_000)`; text-first fetch with status check; wrap parse rethrowing `AgentRequestError`.
- Confidence: medium-high.

### B-40 · Session-scoped advisory lock broken under the transaction poolers the DB client blesses
- File: `lib/db/src/index.ts:14-20` (comment endorses Neon/Supabase/pgbouncer strings — verified) vs `run-executor.ts:165-177` (`pg_try_advisory_lock` on a dedicated session).
- Trigger: DATABASE_URL via transaction-mode pooling with ≥2 API instances.
- Impact: lock/unlock may land on different backends → two instances execute the same run concurrently → duplicate provider calls/double billing.
- Fix: `pg_advisory_xact_lock` inside a transaction held for the run, or enforce/document session-mode pooling requirement.
- Confidence: medium (deployment-dependent).

### B-41 · Zero secondary indexes on the hottest query paths
- File: `lib/db/src/schema/benchmark-results.ts`, `benchmark-scores.ts`, `benchmark-rankings.ts` (only index in the repo is `benchmark_calls_source_unique` — verified by grep).
- Trigger: every execute/retry/results fetch seq-scans by `runId`; rankings delete-by-runId rescans an accumulate-forever table each completion; rehearsal cascade deletes degrade quadratically.
- Impact: latency/cliff degradation as data grows; sole DDL path is drizzle-kit push, so nothing fixes it incidentally.
- Fix: add indexes `results(run_id)`, `scores(result_id)`, `rankings(run_id)`.
- Confidence: high.

### B-42 · `PGPOOL_MAX` ≤0 silently hangs the entire API
- File: `lib/db/src/index.ts:19` (`Number.parseInt(...) || 20` passes −5 — verified; siblings clamp `<=0`, e.g. `run-executor.ts:42-54`).
- Trigger: operator typo `PGPOOL_MAX=-5` → pg-pool `_isFull()` true at 0 clients → first query waits forever, no log.
- Impact: every DB-touching route wedges with zero diagnostic surface.
- Fix: `const n=parseInt(x,10); max: Number.isFinite(n)&&n>0 ? Math.min(n,cap) : 20`.
- Confidence: high.

### B-43 · "Cost/Min" ranking column actually stores mean per-call dollars
- File: `artifacts/api-server/src/lib/run-executor.ts:536` (`(costPerMinute * durationSeconds)/60` persisted into `cost_per_minute` — verified) averaged plainly at `:680`, rendered as $/min (`Rankings.tsx:30,240`, CSV header).
- Trigger: any run mixing call durations ≠60s.
- Impact: providers compared on an economically wrong number; a provider failing long calls looks artificially cheap in the composite cost component (weight 0.05).
- Fix: aggregate duration-weighted `Σcost/Σduration×60` (or store the true rate) and relabel.
- Confidence: high.

### B-44 · Standalone `-`/`'` survive transcript normalization as phantom word tokens
- File: `lib/scoring/src/index.ts:78` (`punctuation = /[^\p{L}\p{N}\s'-]/u` keeps them; token split then yields `"-"` — verified).
- Trigger: gold "call - about load 12" vs hyp "call about load 12" → spurious deletion.
- Impact: inflated WER + bogus wordDiff entries feeding the 0.20 composite weight; contradicts the rule's stated inside-word intent.
- Fix: drop tokens matching `/^[-']+$/` after split (or keep `-`/`'` only between letters).
- Confidence: high.

### B-45 · Strict response enums turn one bad DB row into full-endpoint 500s
- File: `artifacts/api-server/src/routes/benchmark.ts:328` (`ListBenchmarkCallsResponse.parse` pins 3-value `vertical`) and `:1166` (rankings likewise).
- Trigger: any row with a new/typo'd vertical (only reachable via direct DB write today).
- Impact: GET /calls (and Rankings entirely, all verticals) 500 until DB surgery — Corpus, Review, Runs picker, Dashboard, Agent all die together.
- Fix: widen response/query schemas to `z.string()` (or extend the enum in openapi.yaml and regenerate) so bad data degrades one row, not the endpoint.
- Confidence: medium (parse strictness verified; trigger requires out-of-band write).

### B-46 · Manual/non-Vapi `audioObjectPath` rows can never play or score
- File: `artifacts/api-server/src/lib/vapi.ts:359-362` — `guessVapiCallId` null ⇒ `VapiNoRecordingError("no audio was ever imported")` even when a plain URL is stored (verified); consumers: audio route `benchmark.ts:503-526`, executor `run-executor.ts:280-286`.
- Trigger: `POST /calls` with `audioObjectPath:"https://cdn.example.com/interview.wav"` (accepted free-text), then playback or any run.
- Impact: 404 lie to the operator; every provider cell for that call fails; Review shows a player that can't work.
- Fix: fall back to the stored URL when no Vapi id is recoverable (and gate the claim "never imported" on a null path).
- Confidence: high.

### B-47 · Cartesia timing constants fail long / non-16kHz recordings deterministically
- File: `lib/stt-providers/src/adapters/cartesia.ts:30-33,286-294` (RESPONSE_TIMEOUT_MS arms before open and caps the whole near-realtime session) + `:333-347` (fixed 6400B/190ms pacing assumes 16kHz/16-bit regardless of decoded WAV format).
- Trigger: recording longer than ~125s (or >~63s at 32-bit / ~46s at 44.1kHz) → timer fires mid-send → "timed out waiting for a final transcript".
- Impact: all long calls fail as provider errors, polluting the eval with deterministic non-transient failures.
- Fix: reset deadline on activity (idle-gap timeout only) and derive pacing from `sampleRate*bitsPerSample/8`.
- Confidence: medium-high.

### B-48 · Successful attest silently swaps the reviewed call and drops unsaved edits
- File: `artifacts/stt-benchmark/src/pages/Review.tsx:177` (`queue.find(...) ?? queue[0]` fallback) + `:166-174` (completed calls sort last) + `:197-205` (editor reload effect).
- Trigger: deep-link-less session working queue[0]; attest #2 succeeds → invalidated queue re-sorts → `selected` jumps to a different call without either dirty-guard (`goTo:226`, queue-click `:404`).
- Impact: loss of dirty gold edits; further ⌘S can write call A's text onto call B.
- Fix: pin selection once after first queue load (`setSelectedId(queue[0].id)` instead of eternal null fallback).
- Confidence: medium-high.

### B-49 · Two contradictory readiness definitions on one Dashboard screen
- File: `artifacts/stt-benchmark/src/pages/Dashboard.tsx:70` (vertical bar counts done by gold+both labels) vs `:105-106,154` (Stage-3 counts by `ready_to_run` status / needsDeid) — criterion difference verified.
- Trigger: normal flow (attest never flips status; nothing auto-PATCHes `ready_to_run`).
- Impact: bar shows 100% green while nextAction says "missing de-identification sign-off", routing to re-attest an attested call; the real step (manual ready-flip, Corpus) is never named.
- Fix: derive the vertical bar from `status==="ready_to_run"` to match server-side counts.
- Confidence: high.

---

## P3

### B-50 · Attest failure always blamed on "two distinct approvers required"
- File: `artifacts/stt-benchmark/src/pages/Review.tsx:279-285` — network error, 400 (short name), 404, real 409 all render the same toast; server message available but ignored.
- Impact: operators fetch a second person or retry instead of fixing the cause. Fix: surface `err.body?.error ?? err.message`. Confidence: high.

### B-51 · j/k/space shortcuts fire with modifiers held
- File: `artifacts/stt-benchmark/src/pages/Review.tsx:304-309` — modifier exclusion only guards the ⌘Enter branch; Ctrl+J navigates queue (prompting discard-confirm), Alt+Space toggles playback.
- Impact: accidental navigation/edit loss prompts. Fix: bail when `metaKey||ctrlKey||altKey` before shortcut handling. Confidence: high.

### B-52 · Trailing slash on any valid route renders 404
- File: `artifacts/stt-benchmark/src/App.tsx:59-67` (exact-match Set, verified); bookmarks/proxy-added slash ⇒ NotFound for all 8 routes; active-nav state misses too.
- Fix: normalize `location.split("?")[0].replace(/\/+$/,"") || "/"`. Confidence: high.

### B-53 · Call-status dialog reopens with stale prop, can silently revert a saved change
- File: `artifacts/stt-benchmark/src/pages/Corpus.tsx:307` (`if (next) setStatus(call.status)` reads pre-refetch prop).
- Impact: reopening mid-refetch shows old status; Save persists the revert. Fix: reset from fresh cache or effect on `[call.status, open]`. Confidence: medium-high.

### B-54 · Scientific-notation duration input corrupts `durationSeconds`
- File: `artifacts/stt-benchmark/src/pages/Corpus.tsx:213` — `parseInt("1e3",10)===1` for a spec-valid number-input value passing `min={1}`.
- Impact: 1000s call stored as 1s, skewing per-call cost math downstream. Fix: `Number(duration)` + `Number.isFinite` check. Confidence: high.

### B-55 · ready_to_run guard implements only half the server's 409 conditions
- File: `artifacts/stt-benchmark/src/pages/Corpus.tsx:346` — disables on de-id completeness but not missing gold (attestation route doesn't require gold).
- Impact: guaranteed-409 submit enabled, contradicting the file's own comment. Fix: add `|| !call.goldTranscript?.trim()`. Confidence: high.

### B-56 · Calls/providers fetch loading & error conflated with empty states on Dashboard
- File: `artifacts/stt-benchmark/src/pages/Dashboard.tsx:64-65,200-201` ("No calls imported yet." while corpusCount>0) and `:76-77,233-258` (silent empty provider card contradicting "N configured" CTA).
- Fix: branch loading/error before empty-states; surface hook errors. Confidence: medium-high.

### B-57 · Manually disabled provider labeled "Disabled / no key"
- File: `artifacts/stt-benchmark/src/pages/Dashboard.tsx:254` — `.some(status==="disabled")` paints one label over keyed-disabled rows, contradicting the adjacent comment (only `not_configured` means no key).
- Fix: per-provider label split on `not_configured` vs `disabled`. Confidence: high.

### B-58 · Zombie `scanning` rows are unresolvable via UI and polled forever
- File: `artifacts/stt-benchmark/src/pages/Agent.tsx:147,293-294` — Reject hidden for `scanning` though the route permits it; 3s poll never stops on such rows.
- Fix: show Reject for `scanning|error` (server already accepts). Confidence: high.

### B-59 · Whitespace-only approver labels persisted as attribution
- File: `artifacts/stt-benchmark/src/pages/Agent.tsx:154,168` (`if (!approver)` passes `" "`; server trims to "") → `decidedByLabel:""` in DB + audit ("Approved by  --"). Fix: trim + require non-empty in prompt handler. Confidence: high.

### B-60 · Import date-window edges: inverted range reads as false "empty window"; DST fall-back hour dropped
- File: `artifacts/stt-benchmark/src/pages/Import.tsx:125-126` (no From≤To guard; Vapi returns [] for `Ge>Le` presented as truth) and `:45` (`23:59:59.999` ambiguous local time in fall-back zones truncates the repeated hour).
- Fix: inline validation before mutate; build end bound as next-day-midnight − 1ms. Confidence: high / low-frequency respectively.

### B-61 · Select-all checkbox never reports indeterminate
- File: `artifacts/stt-benchmark/src/pages/Import.tsx:346` — boolean-only checked; SR announces "not checked" while subset ticked.
- Fix: three-state checked (`false | true | "indeterminate"`). Confidence: high.

### B-62 · import-vapi-calls CLI: apply always 400s past 200 ids; exit 0 on partial failure; dates roll over silently
- File: `scripts/src/import-vapi-calls.ts:205-211` (preview up to 500 → apply capped 200 → raw zod 400), `:214-231` (HTTP 200 with failedCount>0 exits 0), `:110-118` (month/day out-of-range rolls over instead of throwing).
- Impact: advertised backfill flow impossible as-is; scripted callers blind to failures. Fix: chunk applies ≤200; `process.exitCode=1` when failedCount>0; round-trip-validate date parts. Confidence: high.

### B-63 · stt-score CLI crashes with undebuggable TypeError on malformed input rows
- File: `scripts/src/stt-score.ts:14` — blind `JSON.parse` cast; missing fields explode inside scoring with no row/field context. Fix: validate rows against ScoreInput before mapping. Confidence: high.

### B-64 · rehearsal-scale "proofs" are vacuous; failure path strands 150 synthetic calls in the target DB
- File: `artifacts/api-server/src/rehearsal-scale.ts:182` (in-process Set intercepts racer before Postgres contention), `:213` (score VALUES never asserted — all-null scorer passes), `:190` (post-seed rejection skips cleanup block).
- Fix: drive racer through a held advisory lock; assert `wer===0 && entityAccuracy!==null` given hypothesis≡gold; try/finally cleanup. Confidence: high.

### B-65 · vite `preview` lacks the `/api` proxy its own main.tsx claims; non-root BASE_PATH breaks SPA routing
- File: `artifacts/stt-benchmark/vite.config.ts:83-87` (only `server.proxy` set) and `:21,24` vs `App.tsx:52-67` (no router base stripping) — `pnpm serve` of the built app 404s every API call; subpath deploys NotFound everything.
- Fix: mirror proxy into `preview.proxy`; derive router base from `import.meta.env.BASE_URL`. Confidence: high.

### B-66 · Deploy path filter ignores dependency-definition changes
- File: `.github/workflows/deploy-web.yml:20-27` — catalog/lockfile bumps don't trigger redeploy; production serves stale-dep builds indefinitely.
- Fix: add `pnpm-lock.yaml`, `pnpm-workspace.yaml`, root `package.json` to paths. Confidence: high.

### B-67 · `start` requires Node ≥22.9 (`--env-file-if-exists`) but no engines/.nvmrc declared
- File: `artifacts/api-server/package.json:9` — Node 20 boots into `bad option` crash instead of install-time failure.
- Fix: `"engines":{"node":">=22.9"}` + `.nvmrc`. Confidence: high.

### B-68 · Executor wipes caller-authored `run.notes` on first execution
- File: `artifacts/api-server/src/lib/run-executor.ts:381` (`notes: notes.join("\n") || null` replaces create-time notes; the 2026-08-25 fix stopped accumulation but not substitution).
- Fix: preserve original notes (prefix attempt summary instead). Confidence: high.

### B-69 · Unguarded bookkeeping inserts abort the whole run mid-materialization
- File: `artifacts/api-server/src/lib/run-executor.ts:298,407` — audio-unresolved / no-adapter insertResult throws escape the worker, skipping notes/rankings/finalization (siblings honor the "never take down the run" invariant).
- Fix: wrap both sites try/catch-log-count like `:477-481`. Confidence: high.

### B-70 · `hashtext()` 32-bit collision silently drops another run's execution
- File: `artifacts/api-server/src/lib/run-executor.ts:166,177` — collided runId logs "locked by another instance" and returns success-shaped silence; queued forever; agent-scan variant flags with bogus "no candidates" reasoning.
- Fix: key lock on parsed uuid halves via two-int advisory lock; treat `locked=false` on a queued run as retryable failure. Confidence: medium.

### B-71 · "(after N attempt(s))" appended to single-attempt terminal failures
- File: `artifacts/api-server/src/lib/run-executor.ts:472-475` — Deepgram 401 breaks loop on attempt 1 yet message claims CELL_MAX_ATTEMPTS. Fix: track actual attemptsMade. Confidence: high.

### B-72 · Deepgram parser crashes on non-JSON 2xx bodies
- File: `lib/stt-providers/src/adapters/deepgram.ts:70,86` — `rawOutput=null` then `body.results` TypeError; retried wastefully then cryptically logged. Fix: guard `!rawOutput` like openai.ts. Confidence: high.

### B-73 · Diarization "not measured" recorded as measured 0
- File: `lib/stt-providers/src/adapters/deepgram.ts:37` — words-without-speakers yields `diarizationScore:0` instead of null, skewing averages (reachable only when `diarize:false`; caller hardcodes true today).
- Fix: return null when `speakers.size===0`. Confidence: high (latent).

### B-74 · Missing latency/cost telemetry scored as best-possible composite component
- File: `lib/scoring/src/index.ts:272-279` — null latencyFinalMs/cost gets component=1, outranking measured-slow providers; contradicts its own "insufficient evidence" contract.
- Fix: weight-exclude and renormalize nulls. Confidence: high.

### B-75 · Env-derived Vapi account id/label collisions resolve silently to first match
- File: `artifacts/api-server/src/lib/vapi.ts:97,108` (`VAPI_API_KEY_DEFAULT` vs `VAPI_API_KEY` normalize identically, no uniqueness check) and `:370-372` (case-insensitive label find, ambiguity unchecked despite docstring).
- Impact: traffic uses whichever env var enumerates first; refresh may hit the wrong workspace (404→502 masking misconfig).
- Fix: throw `VapiConfigError` on duplicate normalized id/label in `listVapiAccounts`. Confidence: high.

### B-76 · Whitespace-padded API key marks provider ready then burns vendor calls
- File: `artifacts/api-server/src/routes/benchmark.ts:186,214` — `Boolean(env)` treats `" "` as configured; upstream 401s recorded as failed cells instead of clean config_blocked.
- Fix: trim before Boolean in both spots. Confidence: high.

### B-77 · Label-fallback duplicate checks lack `sourceProvider='vapi'` guard
- File: `artifacts/api-server/src/routes/benchmark.ts:574,649` — manual call with colliding hash-label makes real import return `skipped_duplicate` pointing at an unrelated row; preview annotations skewed.
- Fix: add `eq(sourceProvider,"vapi")` to label branches. Confidence: high.

### B-78 · Preview truncation invisible: page cap (MAX_VAPI_PAGES) and limit slice look identical to full coverage
- File: `artifacts/api-server/src/lib/vapi.ts:245,283-285` + `routes/benchmark.ts:683` + `Import.tsx:331` — ascending walk always keeps the OLDEST slice with no `hasMore`/`truncated` signal anywhere.
- Impact: operators import systematically oldest-biased subsets believing the window was fully enumerated.
- Fix: compute `truncated` server-side, extend response schema, warn-banner in step-2 card. Confidence: high.

### B-79 · Results endpoint returns 200 `[]` for unknown runId
- File: `artifacts/api-server/src/routes/benchmark.ts:1039-1054` — no existence check while sibling execute route 404s; "no results yet" indistinguishable from "typo'd run".
- Fix: look up run first, 404 like execute. Confidence: high.

### B-80 · Scan catch-all persists/returns raw internal error strings
- File: `artifacts/api-server/src/routes/agent.ts:250-263` — pg/drizzle/network messages stored to `errorMessage` and returned in the 201 body.
- Fix: surface only typed `AgentConfigError`/`AgentRequestError` messages. Confidence: high.

### B-81 · Served implementation plan permanently stale
- File: `artifacts/api-server/src/lib/benchmark-plan.ts:156-166` (PRO-03 lists six adapters; seven ship; statuses hardcoded) via `benchmark.ts:1188-1190`.
- Fix: regenerate plan content or derive PRO-03 scope/status from the registry. Confidence: high (content drift, low impact).

---

## Wave 2 — 10-lens adversarial hunt (verified 2026-08-25)

Method: 10 waves × ~100 dispatched agents — concurrency/races, error-paths/failure-injection, security/adversarial-inputs, state-machine integrity, numeric/boundary, contract drift, resource lifecycle, async ordering, recovery/rollback, cross-module contracts. **591 hunters completed**; every P0–P2 claim was then re-checked against source by 11 independent verifier agents: **391 CONFIRMED, 83 REFUTED, 95 duplicates** of B-1..B-81. The complete verbatim confirmed set (clustered by file) lives in [bug-register-waves.md](./bug-register-waves.md); the 19 verified P1s are promoted to full entries below. Zero P0s survived verification.

### B-82 · syncProviderReadiness stale-snapshot RMW resurrects disabled provider  (wave-2, verified)
- `benchmark.ts:183-196` (+PATCH `:904-915`)
- Trigger/impact: GET-sync SELECTs snapshot→PATCH commits `manuallyDisabled=true`+own sync→slow sync computes `ready` from stale row, blind UPDATE WHERE id → disabled vendor `status=ready`, bil
- Confidence: high (verifier-traced).

### B-83 · POST /runs has zero in-flight/scope dedup  (wave-2, verified)
- `benchmark.ts:946-1011`
- Trigger/impact: blockers check only per-call status/provider readiness; two tabs/operators insert two `queued` runs, distinct runIds → distinct advisory locks (`run-executor.ts:166`) → both drain full corpus concurrently; 2× vendor spend,
- Confidence: high (verifier-traced).

### B-84 · Executor never re-validates call eligibility at execution  (wave-2, verified)
- `run-executor.ts:224-237` vs gate `benchmark.ts:971`
- Trigger/impact: calls loaded by bare `inArray`, no status/gold filter; archive/demote after create (or before retry, which B-15 invites) still bills cells, scores into rankings; sibling of B-34
- Confidence: high (verifier-traced).

### B-85 · Gold lost update: editor dirty-baseline vs live cache + unconditional PATCH  (wave-2, verified)
- `Review.tsx:206-227,251-271` + `benchmark.ts:407-414` (spread `.set`, no version precondition)
- Trigger/impact: frozen stale cache (staleTime 30s, focus off) hides concurrent writer → ⌘Enter overwrites; or mid-session invalidatio
- Confidence: high (verifier-traced).

### B-86 · Adapter submit-leg throws escape try → executor auto-resubmits billed job  (wave-2, verified)
- `assemblyai.ts:41-65` (fetch+json outside try :80), `speechmatics.ts:64-84` (outside try :99), `openai.ts:61` (unwrapped upload)
- Trigger/impact: lost response ⇒ generic Error ⇒ `isRetryableError=true` (`run-executor.ts:140`) ⇒ job
- Confidence: high (verifier-traced).

### B-87 · Cartesia immortal send interval when open lands after connect-timeout finish  (wave-2, verified)
- `cartesia.ts:264-272,312-315`
- Trigger/impact: timer fires finish(settled=true)→late `open` listener still creates `sendTimer`; later close event hits `if (settled) return` → interval leaks forever, re-sends into dead socket, re
- Confidence: high (verifier-traced).

### B-88 · pg Pool has no `error` listener  (wave-2, verified)
- `lib/db/src/index.ts:13-20`
- Trigger/impact: idle-client ECONNRESET emits Pool 'error', zero listeners repo-wide → unhandled event kills API mid-run; all runs strand `running`.
- Confidence: high (verifier-traced).

### B-89 · Deploy not gated on CI; prod mutex keyed by ref  (wave-2, verified)
- `deploy-web.yml:18-32,62-69`
- Trigger/impact: push fires CI+deploy independently (broken commit ships while CI red); `group: deploy-web-${{ github.ref }}` + open `workflow_dispatch` + unconditional `--prod` lets stale-branch deploy finish last and roll back
- Confidence: high (verifier-traced).

### B-90 · scanInFlight blind exactly when needed (extends B-36)  (wave-2, verified)
- `Agent.tsx:47-49,113,326-327`
- Trigger/impact: guard derives from cached scans list; conditional poll fires only if cache already has scanning row; staleTime/focus-off → remount/cross-tab window re-enables Scan → second paid pipeline, server has no pe
- Confidence: high (verifier-traced).

### B-91 · alignWords dense O(n·m) DP uncapped  (wave-2, verified)
- `lib/scoring/src/index.ts:102-140`
- Trigger/impact: long/repetition-looped transcripts (no cap anywhere; also runs client-side in Review) → multi-second event-loop stall / heap-OOM kills run mid-score — cap words or banded/linear-space DP.
- Confidence: high (verifier-traced).

### B-92 · Typographic ’ ‑ – split words → WER up to 200%  (wave-2, verified)
- `index.ts:78` keeps ASCII `'`/`-` only; NFKC doesn't fold U+2019/U+2013
- Trigger/impact: identical speech vs ASCII gold → sub+ins per word, feeds 0.20 weight — fold `[’‘‛]→'`, `[–—―−]→-` before strip.
- Confidence: high (verifier-traced).

### B-93 · CSV formula-guard bypassed on quoted fields  (wave-2, verified)
- `Rankings.tsx:56-60`
- Trigger/impact: prefix test runs on the *escaped* string; `"=IF(TRUE,1,0)"` starts with `"` so `'` never fires; Excel evaluates — test raw `s` before quoting (defeats B-31's fix).
- Confidence: high (verifier-traced).

### B-94 · Re-executed run shows stale then inflated duration  (wave-2, verified)
- `run-executor.ts:219-222` sets only `{status:"running"}`, never clears completedAt; `Runs.tsx:109-110` renders old seconds during retry, then newCompleted−createdAt (idle gap included, e.g. 60s work → 14520s)
- Trigger/impact: set `completedAt:null` when
- Confidence: high (verifier-traced).

### B-95 · `costPerMinute: Infinity` accepted end-to-end  (wave-2, verified)
- `api-zod/generated/api.ts:330,365` min-only (`JSON.parse("1e999")===Infinity` passes) → pg float4 stores Infinity → wire `null` → `Providers.tsx:91` `.toFixed` TypeError bricks page; poisons cost math
- Trigger/impact: add finite/maximum + serialize guard.
- Confidence: high (verifier-traced).

### B-96 · Tied composites get nondeterministic ranks  (wave-2, verified)
- `run-executor.ts:708` comparator ties; stable sort preserves order of ORDER-BY-less SELECT (`:625-640`) → re-execute flips rank 1↔2 / "Leading candidate"
- Trigger/impact: deterministic tiebreak (providerId).
- Confidence: high (verifier-traced).

### B-97 · Executor trusts run arrays; silent shrink fakes success  (wave-2, verified)
- `run-executor.ts:224-232,357,368`
- Trigger/impact: dangling callIds/providerIds (out-of-band delete/rehearsal purge) dropped by inArray: ghost vendor missing from "complete" run; partial shrink lies in totalCells audit; zero-cell `0===0` → status "c
- Confidence: high (verifier-traced).

### B-98 · Import fabricates 1s duration when endedAt missing/invalid  (wave-2, verified)
- `benchmark.ts:770` `Math.max(1, durationSecondsOf(call))` (`vapi.ts:197-201` returns 0 on missing/NaN) while preview `:669` shows true 0
- Trigger/impact: crashed calls book rate×1s (~300× understatement into Rankings/composite) — persist unknown,
- Confidence: high (verifier-traced).

### B-99 · PGPOOL_MAX=1 wedges whole API  (wave-2, verified)
- `lib/db/src/index.ts:19` (passes B-42's own >0 fix) + `run-executor.ts:162`
- Trigger/impact: lockClient pins the pool's only client; Inner's first query needs a second → circular wait, zero logs — dedicated lock pool or clamp max≥RUN_CONCURRENCY+2.
- Confidence: high (verifier-traced).

### B-100 · Duplicate/variant entities double-weight accuracy  (wave-2, verified)
- `Review.tsx:297` dedups exact `type+value` only; scorer maps every ref independently (`index.ts:187-203`)
- Trigger/impact: "RO 4721"+"ro-4721" → 2 hits inflate entityAccuracy (0.40 weight) — dedupe on normalizeEntity.
- Confidence: high (verifier-traced).

### Refuted (sample — full list in wave outputs)

83 candidate findings were REFUTED by verifiers, e.g.: "negative costPerMinute
accepted" (zod `.min(0)` blocks it), "alignWords empty-input crash" (fuzzed
3000 pairs, correct), "CORS preflight breaks DELETE" (no DELETE routes),
"pg advisory lock deadlock with PGPOOL_MAX=1" (registered separately as
B-92 with the real circular-wait mechanism), "React 19 removed X" style
framework claims, and several "missing cleanup" claims where cleanup exists
on all paths. Negative results are recorded in the wave outputs and were
weighted like corroborating sources in the triage method.

---

## Tally

Severity × area (areas: frontend = `artifacts/stt-benchmark/src`, api = `artifacts/api-server`, lib = `lib/*`, config/scripts = workflows, vite, package.json, env, scripts):

| Severity | frontend | api | lib | config/scripts | total |
|---|---|---|---|---|---|
| P0 | 0 | 1 | 1 | 1 | **3** |
| P1 | 4 | 10 | 4 | 1 | **19** |
| P2 | 9 | 8 | 9 | 1 | **27** |
| P3 | 12 | 8 | 5 | 7 | **32** |
| **total** | **25** | **27** | **19** | **10** | **81** |

Dedup: raw ~190 agent findings → 81 entries (wave 1). Wave 2 added 19 verified P1 entries (B-82..B-100) plus a 391-line verbatim confirmed appendix (bug-register-waves.md); grand total 100 curated entries + appendix. Heaviest merges: orphan-ok-row family (7 agents), import-duplicate-batch-abort (5), attest race (5), CSV injection (3), dashboard agent_scan pollution (3), poll-adapter robustness (3), approve/reject TOCTOU (5), SPA-nav edit loss (2), trailing-slash 404 (2).
