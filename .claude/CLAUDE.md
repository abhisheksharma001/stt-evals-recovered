# STT-evals — project brain

This file loads automatically whenever Claude Code works in this repo. It's the
starting point — read this first, then follow the links out to the other files in
`.claude/` and `docs/` for depth. Written so Abhishek (non-developer, learned to code
with Claude Code, background in n8n/prompt engineering) can read it directly too, not
just as machine instructions.

## What this project is, in one paragraph

Ellavox.ai deploys AI voice agents for client companies. Every voice agent needs a
speech-to-text (STT) engine underneath it, and there are 7+ real vendors (Deepgram,
AssemblyAI, Cartesia, Gladia, ElevenLabs, OpenAI, Speechmatics) with real trade-offs on
accuracy, speed, and cost — none of them win at everything. This tool answers "which
STT provider should we actually use for this client's calls?" with evidence instead of
a guess: it takes real recorded calls from a client's Vapi account, runs the same audio
through every candidate provider, scores each one against a human-corrected "gold"
transcript, and produces a ranked recommendation per vertical (Rush truck parts,
property management, trucking dispatch — expect more verticals as more clients come on).

Think of it as an n8n-style pipeline, but the "workflow" is: pull calls → human review
→ run all providers → score → rank → recommend. Each of those is a real pipeline stage
with its own UI page (Corpus, Review, Runs, Rankings).

## How we work (read this before picking anything up)

`~/.claude/skills/mystandard/SKILL.md` is the working standard, set by Abhishek on
2026-08-31. In one line: **a step is one PR, one PR is one win, and a weaker model must
be able to do any step alone without asking what was meant.**

- The work lives in **`docs/step-register.md`** — one step, one PR, each self-contained
  (exact files, what is there today, what to change, an acceptance sentence, the verify
  command, and what the step may not touch). Take the top `todo`. Do only that.
- A feature is **grilled before it is stepped**: is it already built, is there a skill
  for it, what is the smallest useful version, what must it never do. Only settled
  parts become steps; the rest sit at the bottom of the register with the question
  blocking them.
- A big spec is not the opening move. `docs/PRD-v5-optimize.md` holds reasoning;
  the register holds work.
- A bug found is a spec update first, a fix second, and the fix goes next.

## Read next, in this order

1. **`.claude/VISION.md`** — why this matters, what "great" looks like, the top-1%
   bar we're building toward (not just "does it run").
2. **`.claude/REQUIREMENTS.md`** — what Abhishek needs to have ready (accounts, keys,
   recurring checks) to keep this moving.
3. **`.claude/STANDARDS.md`** — the concrete checklist this tool is judged against,
   current-market-standard through beyond-standard.
4. **`docs/PRD.md`** — the full product requirements doc (goals, non-goals, users,
   open decisions). The source of truth for scope.
5. **`docs/backlog/good-to-have.md`** — everything deliberately deferred past MVP,
   plus every real bug found and fixed during live testing, with evidence. Read the
   top of this file for the most recent findings before touching run execution,
   scoring, or the Cartesia/Vapi adapters — there's hard-won context there.
6. **`docs/scoring-policy.md`** — what is normalized away before a provider is
   scored, what counts as "the same words in a different convention", and the
   gaps that are still open (`[inaudible]`, substring entity matching). Read
   before changing anything in `lib/scoring`, and before correcting gold.
7. **`docs/provider-data-samples.md`** — real (not hypothetical) examples of exactly
   what each provider's API and Vapi's API send back. Read before adding any new
   provider field or metric.
8. **`docs/reproducibility.md`, `docs/logic-register.md`, `docs/execution-plan.md`** —
   deeper technical decisions, as needed.

## Current state (keep this updated)

- **MVP pipeline works end-to-end, verified against real audio and real provider
  APIs**: import → human review/de-identification → run providers → score → rank.
- **Providers wired with real keys**: AssemblyAI, Cartesia, Gladia, Deepgram.
  ElevenLabs, OpenAI, Speechmatics have adapter code but no key yet.
- **Real, evidenced findings from live testing** (full detail in the backlog doc):
  some Vapi recordings never get a working signed audio URL (storage-bucket-specific,
  not fixable from here); Cartesia has an intermittent server-side mid-call drop not
  yet root-caused; no durable job queue yet (a run-execution race is a known,
  documented gap, not silently ignored).
- **Word-level diff view** shipped — see exactly which words a provider got wrong,
  not just an aggregate WER number.
- **Confidence scores**: 3 of 4 live providers return them (AssemblyAI, Deepgram,
  Gladia); Cartesia doesn't. Extracted since 2026-08-27 (hybrid signal 2,
  `lib/provider-confidence.ts`, keyed by vendor since T-110) and, since batch 8,
  underlined in the word diff (T-109).
- **2026-08-25: full launch-readiness pass done** — typecheck, both unit suites,
  a production UI build, and live traffic through the real run-executor (not a
  bypass). Found and fixed 4 real bugs (retry race condition, duplicate result
  rows on retry, notes-field accumulation, a name leak in a live API field) —
  all verified live afterward. True corpus health: 16/21 calls succeed per
  provider (76% — only 5 genuinely fail, all one known storage-bucket issue),
  not the ~71% failure rate the stale pre-fix "notes" text implied. See the top of
  `docs/backlog/good-to-have.md` for full detail before touching run execution.
- **2026-08-25: second Vapi org wired** (`VAPI_API_KEY_LAND_AND_APARTMENT`,
  label "Land And Apartment"). Adding it surfaced a real, urgent side effect:
  the 22 pre-existing calls all predate per-account labeling
  (`sourceAccountLabel` empty), and the resolver's single-account fallback
  only applies when exactly one account is configured — with two, it
  correctly refuses to guess, which would have silently broken re-fetching
  audio for the entire existing corpus. Backfilled `sourceAccountLabel =
  "Default"` on all 22 (safe: the new key didn't exist when they were
  imported, so none could be ambiguous). **Adding a third Vapi account
  later needs the same check** — anything with an empty `sourceAccountLabel`
  at that point is genuinely ambiguous and needs a real decision, not another
  blind backfill.
- **OpenAI key added** — also lit up the `openai-gpt-4o-transcribe` STT
  provider adapter for free (same env var both use).
- **AI check (transcript-quality agent) runs on every run** — it started
  as an on-demand `/agent` page (2026-08-26); on 2026-08-27 (`e0399cc`) the
  page was removed and the check folded into the run executor, so every bulk
  and ad-hoc run scans each call automatically (`lib/agent.ts`,
  `lib/run-executor.ts`; `routes/agent.ts` keeps only list / approve /
  reject). Per call: the hybrid flags (cross-provider disagreement, entity
  mismatch, low confidence) decide whether the OpenAI judge is asked at all;
  when it is, it picks whichever provider's transcript reads most sensibly,
  with reasoning and (since batch 8) a typed confidence. **The pick is a
  suggestion, never gold on its own.** Results and Calls show the verdicts
  read-only (T-112, T-117).

- **2026-08-30, batch 4 (PR #52): no human judge.** Span adjudication, the
  judge-accuracy report and the `benchmark_adjudications` table are gone; a
  person only flags a whole call (hard case / notes). Results is **org →
  assistant** ("org" = the Vapi account; the API field is still `clientLabel`),
  with **words to watch** per assistant (`GET /benchmark/words-to-watch`) — the
  words providers keep splitting on, tagged number / word / filler, linking to
  the call to listen. Per-card trend charts removed; one trend chart folded
  under "More evidence". Import page shows call providers (Vapi only; future
  ones named in `docs/backlog/good-to-have.md` only).

- **2026-08-30, batch 6: Calls grouped org → assistant; production config
  shown; words-to-watch noise cut.** Results baseline now reads the assistant's
  live Vapi transcriber config (`GET /benchmark/assistants/{id}/transcriber`,
  read-only) — fallback plan and Deepgram `keyterm` boosts that the benchmark
  never gets (Rush: 120 keyterms + numerals). Words to watch has a `format`
  kind (hyphen / spacing / "one" vs "1" / stray um) hidden with fillers. Q-2
  answered (only Cartesia + Gladia share a Whisper base; weak signal live).
  The four data backfills were applied in batch 9 (T-111) — see
  `docs/runbooks/pending-backfills.md` for the before/after counts.

- **2026-08-30, batch 7: convention ≠ disagreement; judge prompt v2; live model
  lists.** `lib/scoring/src/equivalence.ts` `canonicalTranscript()` is what flags,
  spans and words-to-watch compare on (WER/diff untouched). `judge.baml` has the
  rules and a typed verdict (confidence, key differences); `AnalyzeFailure` is BAML
  too; **any prompt edit needs `pnpm run judge:contract:record`** (paid). Judge
  models come live from OpenAI with the pinned five first. Each STT vendor's
  newest model is one click on Setup, as its **own provider row** (`<vendor>-<apiModel>`).
  Re-check the dated catalogs (AssemblyAI, Gladia, Cartesia, ElevenLabs) when a
  vendor announces a model — they have no list API.

- **2026-08-30, batch 8: bulk → runs nesting; catalog age; judge fields; unsure
  words; vendor-keyed extraction.** Bulks rows expand to their shard runs; the
  bottom section is ad-hoc runs only. Setup says how old each dated catalog is
  (warns past 60 days). `benchmark_agent_scans.judge_confidence` /
  `judge_key_differences` are real columns (from the BAML verdict, never parsed
  from prose), shown as a chip + list on the call comparison. The diff underlines
  a provider's own low-confidence words. **Anything provider-specific must key
  on `vendorOfProviderId()`**, never an exact id — T-104 model rows
  (`gladia-solaria-3`) got no confidence/timings/slots until T-110.
  `assemblyai-universal` is pinned to `universal-3-5-pro`.

- **2026-08-30, batch 10: paid vs list price; judge chip on Calls; pages
  code-split; catalog age on Overview; doc-path check.** Results' `$/min`
  column is **what the bulk paid** (each cell's recorded cost over audio
  minutes, `aggregateRankingRows`), not the Setup list price -- re-ranking
  never changes it; a `list $x` chip appears when Setup's price differs >2%
  (T-116). Every Calls row carries the latest AI-check verdict (T-117).
  Pages load lazily -- entry chunk 1.05 MB → 350 kB, Vite's chunk notice
  gone (T-118). Overview counts vendor catalogs older than 60 days (T-119).
  `scripts/check-doc-paths.sh` (CI) fails on a backticked path that does
  not exist in the live docs; four planning-era docs carry a "historical"
  banner instead (T-120). **Convention: backticks around a path = it
  exists**; a planned or deleted name is written plain.

- **2026-09-02: the working copy was swept out of `/tmp` — it lives at
  `~/gh-projects/stt-evals-recovered` now.** A nightly sweep on this Mac deleted 166
  tracked files, 209 git history objects, 64 cached audio files and part of
  `node_modules` from the old scratchpad clone. Nothing committed was lost; audio for
  **6 calls is gone for good** (cached count 107 → 101). Runbook, loss list and the
  relocation steps: `docs/runbooks/working-copy-location.md`; register step S-0.1
  finishes the move (`.env` copy, deploy from the new home, restart Claude Code there).

- **2026-08-31, batch 23: the pages, rendered.** The UI package had 39
  tests, all on pure `src/lib` helpers; **no test had ever rendered a
  page.** Now 84 across 13 files: a shared harness
  (`artifacts/stt-benchmark/src/pages/__render__/harness.tsx`) with jsdom
  shims, a `fetch` stub driven by a route table — **anything unlisted
  answers 500 and lands in `unmatched`**, so a page depending on an
  endpoint the test did not plan for fails instead of rendering an empty
  section — and `renderPage()`. **Fixtures are typed as the generated
  response types, so `pnpm run typecheck` is the contract check.** Held:
  Overview degrades honestly (no bulk → says so and fetches no verdict;
  vendor list unreachable → "?", never "all verified"; API down → says
  so, never a stale build), Results keeps **"Winner" as the verdict's
  word** (rank 1 alone reads "Ahead, not a winner"; the all-time view
  names nobody) and asks the server for the bulk rather than filtering
  in the browser, Calls states audio as fact (cached at 60 days is still
  "audio saved"; unknown age gets **no chip at all**) and the rescue
  button counts only what a click can save, Bulks **fires no launch on
  render or expand** (every spending path is left out of the stub on
  purpose) and never sums STT with the AI check, Setup keeps the disable
  toggle inert on a keyless provider. Two harness lessons:
  **duck-typing a non-200 answer by an object's `status` field corrupts
  this API's fixtures** (`HealthStatus.status` is `"ok"`), and **an
  assertion that still passes when you delete the behaviour is not an
  assertion** — run ids render truncated to 8 characters and two fixture
  ids shared those 8. **Flagged, not changed:** the template Launch
  button has no confirm — the gate is server-side, so a bulk estimated
  under **$50** (`BULK_COST_THRESHOLD_CENTS`) spends on one click.

- **2026-08-31, batch 22: the writes batch 21 missed.** Suite 90 → 110 (25
  files). Batch 21's closing line ("every route without a network call or
  spend now has tests") **was wrong**: eight write routes had none. Now
  held: bulk-template CRUD (name-ordered list, duplicate 409, delete keeps
  the recipe in the audit before-state), manual call create + the FR-C3
  de-id gate (**"Bob" then "bob" is one person, not two**), run create on
  the **blocked path only** — `POST /benchmark/runs` executes what it
  creates the moment nothing blocks it, so every run in that suite is
  blocked by construction and the file says so — provider create/edit
  (status is derived on writes too; **an operator-disabled provider reads
  `disabled`, not `not_configured`**), and bulk preview + cancel (T-14's
  matched + excluded = in-scope; **a hand-picked call skips the band by
  design**; cancelling stops queued shards so nothing wakes up to spend).
  Fixtures gained `adoptCall` / `adoptRun` / `adoptProvider` and template
  cleanup. Left untested for stated reasons only: vendor list APIs, live
  Vapi, or real money.

- **2026-08-31, batch 21: the last routes.** Suite 69 → 90 (20 files):
  per-call disagreement (agent-scan runs and failed cells never count; a
  call that ran but was never scored is ABSENT, not zero), the two
  reproducibility manifests (**correcting gold afterwards changes nothing**
  — FR-REP1 held through the route; a pre-manifest run is refused, never
  fabricated; shards compose in `shardIndex` order), the verdict JSON and
  `verdict.html` (org grouping, production resolved to a provider row, no
  winner under the five-shared-call floor; the artefact must contain no
  `<script` and no `http` — it is saved and mailed, not served), the
  offline refusals of the Vapi-backed reads (the account is inferred from
  the majority org label on the assistant's calls; every assertion holds
  with or without a key), and the writes that spend nothing (call PATCH
  and settings audit actor + before/after, empty `agentModel` means null,
  a scan is decided once). Fixtures gained `actor` so route-written audit
  rows get cleaned. **Every route that runs without a network call or
  provider spend now has tests**; what is left is left for a stated reason
  (vendor list APIs, live Vapi, or real money). Lesson repeated: the
  settings row id was written from memory as a uuid — it is the literal
  `"default"`, exported from `@workspace/db`.

- **2026-08-31, batch 20: the last reads.** Suite 52 → 69 (15 files):
  provider-correlation (excess 1.0 vs −0.5 through the route; failed-only
  provider stays out; two providers → excess null), volume/vapi-accounts
  (offline refusals; account rows carry env var NAMES only, and the row
  shape check must not regex /key/ — the NAME contains it), runs list
  (batch-only, bulkName join) + run results (score join; T-41 sentence
  derived from failureClass, stored analysis wins; T-73 retryable),
  agent-scans + audit-log filters (fixtures gained `audit()`), settings /
  providers (FR-P3 derived on the list route too) / single call. Purpose
  filter and T-41 fallback proved by breaking. Lesson repeated: `notes`
  guessed, column is `entityNotes` — vitest transpiles without
  typechecking. Untested leftovers: calls/disagreement, manifest routes,
  live-external lists.

- **2026-08-31, batch 19: the aggregate reads, swept.** Every remaining
  bulk-derived read has seeded route tests (suite 34 → 52): words-to-watch
  (the batch-7 canonical rule proven at the route — "four" vs "4" makes no
  word, a real split does; spans NEED a timed reference and extraction is
  vendor-keyed, so span fixtures use deepgram-prefixed ids + Deepgram-shaped
  rawOutput), assistant-signals (T-35 latest-scan-per-call, "judged" =
  reasoning present), bulks list (status filter both directions), bulk
  detail (callsRun double-count guard, coverage-vs-spend split, three
  agent-cost states, T-07 breakdown order + server-side retryable), trend
  (finished bulks only; a null peer-flag count is never a clean call). Both
  T-35 and the trend filter proved by breaking. Left without tests: volume
  (Vapi-backed) and provider-correlation.

- **2026-08-31, batch 18: the reads the compile check cannot hold.** The four
  highest-traffic read routes have seeded integration tests now (suite 20 → 34):
  dashboard (deltas; FR-P3 derived provider status; T-134 archived-run skip),
  rankings (bulk scope, latest-per-group, snapshot retirement, agent-scan
  exclusion, Vapi-down label fallback), calls list (filters, order, 400 on an
  unknown vertical), call comparison (draft-as-reference, diff numbers, retry
  verdict, T-73 missing row, judge pick). Shared suffix-tagged fixture builders
  in `artifacts/api-server/src/routes/__integration__/fixtures.ts`; suites
  assert deltas/containment, never global counts. Real find: scans' `run_id`
  FK has no cascade — a scan blocks its run's delete (cleanup deletes scans
  first). Both T-134 behaviors proved by breaking the filter. Zero provider
  spend — fixture provider ids match no adapter, so nothing can call out.

- **2026-08-31, batch 17: the response edge is compile-checked.** All 58
  success-response sites go through `respondJson(res, schema, value, status?)`
  (`artifacts/api-server/src/lib/respond.ts`), which types the payload as the
  schema's own input (`ZodInput`, re-exported from api-zod) -- the T-136 bug
  class (required field missing from a hand-built mapping = production 500) is
  a tsc error now, held by an `@ts-expect-error` test on that exact omission.
  Four hand-written contract mirrors in `lib/` (CallComparison family,
  OverviewBulkRef, MonthSpend, ClientVolume) are projections of the generated
  schema; **a lib type that describes a response is derived from the contract,
  never restated** (scoring's TrendBulk stays string-dated on purpose -- UI
  package, no api-zod dep; the route rehydrates at the edge). Dates travel as
  `Date` (schemas are `zod.coerce.date()`; wire bytes unchanged). Enum-shaped
  text columns carry a commented boundary cast; the runtime parse still holds
  values. `scripts/check-response-edge.mjs` (CI, `pnpm run
  check:response-edge`) fails on any bypass -- proved by breaking all three
  forms. Suites: api-server 71 unit + 20 integration.

- **2026-08-31, batch 16: the routes the spec fix could not reach; spec/router
  drift is CI now; refusals speak English.** Sweeping the *write* routes the way
  batch 15 swept the read ones found five more live failures. Two handlers read
  `req.params` raw, so `format: uuid` never bound them: the call-audio route
  (also missing from the spec entirely) and the run-archive route both
  answered **500 for a malformed id** (T-146).
  `POST /benchmark/agent/scans` had been in the spec with no route since
  `e0399cc`, so orval generated a client function that could only return
  Express's **HTML** 404 (T-147) — both directions of that drift now fail CI
  (`scripts/check-api-routes.mjs`, `pnpm run check:api-routes`; 58 operations,
  proved by breaking it each way) (T-148). Unmatched paths answer JSON now
  (T-149). **All 43 validation failures answer a sentence** —
  `describeInvalidInput` / `respondInvalid` in
  `artifacts/api-server/src/lib/validation-error.ts`, so "criteria is
  required; providerIds is required"
  instead of zod's stringified issue array, which the client used to render
  straight onto the screen (T-150). `PATCH /benchmark/settings` with a typo'd
  field crashed on drizzle's empty `.set({})`; 400 now (T-151). **Rule this
  leaves: a fix at the spec edge reaches only handlers that read the spec —
  grep for `req.params` / `req.query` / `req.body` after one.** Suites:
  api-server 67 unit + 20 integration.

- **2026-08-31, batch 15: ids checked at the edge; coercion narrowed; scoring
  policy written down.** Sweeping all 23 GET endpoints with bad input found
  five that answered **500 for a caller's typo**: an id was a bare
  `type: string` in the spec, so it reached `where id = $1` on a uuid column
  and Postgres threw. The 30 uuid-backed parameters now carry `format: uuid`
  (T-141); text-backed ones (`providerId`, `assistantId`, `accountLabel`,
  audit `entityId`) deliberately do not. **`zod.coerce.string()` turned a
  missing parameter into the literal string `"undefined"`** (and a repeated
  one into `"a,b"`), so coercion is `number` only now (T-142) -- a URL carries
  text, strings never need coercing, and `Boolean("false")` is true. 5 route
  tests hold both (integration 10 → 15, T-143), proven by putting the old
  schemas back. **`docs/scoring-policy.md` now states what is normalized away
  before scoring** and what counts as the same words in a different convention
  (T-144) -- with three measured gaps recorded, not fixed: `[inaudible]` in
  gold costs a provider a deletion, entity matching is a substring match
  (`44712` is credited with `4471`), and `normalizationVersion` is hard-coded
  "v1". Results' bulk picker is controlled from its first render (T-145); the
  batch-14 note blaming Corpus for that warning was read off a stale console
  buffer and is corrected -- **clear the console before attributing a warning
  to a page.** Orval's zod output is pinned (`version: 3`); `auto` inferred
  Zod 4 from a Zod 3.25 install.

- **2026-08-31, batch 14: spans endpoint was 500ing; play-from-caret; span
  loop; route tests; retry figure explained.** `GET /benchmark/disagreement-spans`
  had answered **500 for every call since batch 4** (the hand-written response
  mapping lost `majorityText`, which T-47 made required) — the Corpus "hear the
  disagreements" panel was dead and nothing was watching (T-136). Fixed, and the
  three newest endpoints (spans, run archive, cache-audio) now have route tests
  in the integration suite, 5 → 10 (T-139). **Rule this leaves: a
  `res.json(Schema.parse({…}))` mapping is only checked at runtime — add a route
  test whenever you hand-build a response.** The reading is clickable now:
  `referenceWordStartMs` gives every reference word its exact start, so clicking
  any word plays the call from there (T-137), and a disputed span can be put on
  repeat (Loop, `L` / `Esc`; boundary logic in
  `artifacts/stt-benchmark/src/lib/span-playback.ts`, T-138). Overview's
  "transcripts a retry could fix" now says what it is made of — **all 15 are
  Cartesia `provider_timeout` cells from 2026-08-27**, and the hover warns a
  retry costs provider money (`artifacts/stt-benchmark/src/lib/retry-figure.ts`,
  T-140).

- **2026-08-31, batch 13: attempt outcomes; refused-set identity; mining tool;
  run archive; playback speed.** `benchmark_calls` carries the last audio-cache
  ATTEMPT outcome (`lib/audio-attempt.ts`; pure classifier split db-free) —
  "source_refused" (Vapi retention 400 / fresh bucket 403) stops counting in
  Overview's "audio not saved" figure and the Calls rescue button, so both now
  read **0** (107 cached + 14 refused = whole corpus; chip: "source refuses
  audio"). **T-132 verified call-by-call: the 5 refused 2026-08-19 calls ARE
  the storage-bucket `audio_url_forbidden` set** — "refused at day 12" was
  never a retention event; Vapi wraps the unsigned-bucket failure in its
  retention message. Pair mining is a committed tool now
  (`src/mine-reading-pairs.ts`; 63 calls → 1,060 unfolded pairs; top new fold
  candidates: am/pm vs "a m"/"p m", villaroma vs "villa roma" — folding is
  deliberately its own future task). Ad-hoc runs soft-archive
  (`POST /benchmark/runs/{id}/archive`, bulk shards 409; archived runs leave
  the default list + all "latest snapshot" picks; nothing deleted). Call audio
  players have 1×–2× playback speed. Backlog items "statistical significance"
  and "decision export" found already shipped (T-20 bootstrap / T-32 artefact).

- **2026-08-31, batch 12: audio rescue; import auto-cache; model-list cache;
  component tests; unsaved-audio figure.** `POST /benchmark/calls/cache-audio`
  saves every uncached call's audio to the server's disk (free — a Vapi
  download, no STT provider; cached calls skipped, so safe to repeat), with a
  "Save audio now (N)" button on Calls. Run live: **107 of 121 calls cached
  (was 64)**; the 14 refusals were all Vapi retention 400s — 9 date-unknown
  pre-labeling calls + the 5 dated 2026-08-19, refused at day 12. Import now
  caches audio the moment a call lands (failure named in the import outcome,
  never fails the import). The 14-day constant lives once in
  `lib/vapi-retention.ts`. Vendor model lists are served from a 30-minute
  server cache with stale-on-error (≤24 h; `lib/model-list-cache.ts`) — the
  51 s Deepgram wait hits at most twice an hour. `*.test.tsx` runs in jsdom
  (per-file pragma; vitest needed the `@` alias + automatic JSX); `JudgeChip`
  extracted to `components/judge-chip.tsx` and rendered under test — 39 web
  tests. Overview "Needs a person" gains "calls' audio not saved on the
  server yet" (attemptable only). Rescue outcomes are not persisted — the 14
  refused calls keep counting there; backlog names the follow-up.

- **2026-08-31, batch 11: web tests; recharts on demand; retention facts;
  T-79 progress.** The UI package runs vitest (CI too) on pure `src/lib`
  logic — `judgeChipFor()`, `paidVsListDiffers()`, `catalogAge`,
  `retentionState()` extracted and tested (23 tests); pages keep the live
  browser pass. recharts loads only when Results' "More evidence" opens
  (Rankings chunk 453 kB → 47 kB). `BenchmarkCall.audioCached` (read routes
  only) says whose audio bytes are on the server's disk: Calls chips read
  "audio saved" / "Nd left" / "audio gone" as facts — an uncached call past
  day 14 is gone for everyone — and the grouping bar counts both. A clean
  `pnpm install` on this machine drops platform-optional binaries; the
  darwin pins (esbuild, rollup, lightningcss, tailwind oxide) in the root
  package.json are the standing fix. `GET /benchmark/calls`'s query lives
  in `lib/calls.ts` now (T-79 tracks handler moves in its register row).

- **2026-08-30, batch 9: backfills applied; judge confidence + hard cases on
  Results; Vite warnings; Q-3.** All pending backfills and the hybrid-flag
  recompute are applied (T-111). `GET /benchmark/assistant-signals` feeds two
  lines per Results assistant card: how sure the AI judge was (counts; "not
  recorded" = pre-batch-8 verdicts) and which calls a person flagged hard
  (`/corpus?hard=1`). shadcn's `'use client'` lines are gone (they were the
  two build warnings). **The database is local Docker Postgres on :5433 —
  there is no Supabase project for this tool, and no pgvector.**

## Standing rules for this project specifically

- **The working copy lives at `~/gh-projects/stt-evals-recovered` — never under
  `/private/tmp` and never inside a Claude Code scratchpad.** Something on this Mac
  sweeps `/private/tmp` nightly (2026-09-01: lost source, git history objects and six
  calls' audio for good). If `git status` ever shows ` D` lines nobody made, read
  `docs/runbooks/working-copy-location.md` before doing anything else.
- **API keys**: ephemeral env-vars only. Never in the database, never sent to the
  browser, never logged, never committed (`.env`/`.env.*` are gitignored). Writing a
  real key to the local `.env` file requires the user to explicitly say so, same as
  it did the first time.
- **MVP vs. good-to-have**: when in doubt about scope, default to "what's actually
  necessary right now" and put the rest in `docs/backlog/good-to-have.md` — don't
  silently build extra scope, and don't silently skip something necessary either.
- **Don't assume, don't anticipate** — this is the user's explicit standing
  instruction from early in this project. If genuinely unsure what's wanted, ask;
  don't guess and proceed.
- **Verify against the real API, not memory or convention.** Every provider-field
  assumption that got caught wrong this project (Vapi's `assistant.transcriber` that
  doesn't exist, the unsigned `recordingUrl` vs. the real `presignedMonoUrl`) came from
  guessing instead of checking. `docs/provider-data-samples.md` exists because of this.
- **Draft transcript ≠ gold transcript, ever.** The draft is the provider Vapi itself
  used live on the call — never let it become the gold standard a candidate provider
  is scored against; that's an unfair thumb on the scale for whichever provider
  happens to match Vapi's own choice.
- **A run must be resumable, not just retryable-by-luck.** Re-executing a run should
  only touch cells that didn't succeed yet — never blindly reprocess everything (costs
  real provider money on every paid call).
- **`pnpm run typecheck` (repo root) clean, plus the relevant package's tests, before
  calling any change done.** Not optional, not "looks right."
- **Use a worktree for anything experimental, a big rewrite, or a schema change** —
  per the global rule. Straightforward bug fixes and docs don't need one.

## Quick commands

- `pnpm --filter @workspace/api-server run dev` — API server, dev mode
- `pnpm --filter @workspace/api-spec run codegen` — after editing `lib/api-spec/openapi.yaml`
- `pnpm --filter @workspace/db run push` — push schema changes (needs `DATABASE_URL`)
- `pnpm run typecheck` — full typecheck, all packages
- `pnpm run check:doc-paths` — every backticked path in the live docs exists (CI runs it)
- `artifacts/stt-benchmark` — the UI (Vite dev server, port 5173)
- `artifacts/api-server` — the API (port 8177 in local dev)

## Who to ask

Abhishek — Ellavox.ai, also runs freelance AI-automation work on the side. Not a
professional developer; explain new concepts in plain English with simple analogy before the code. See the global `~/.claude/CLAUDE.md` for full communication
preferences — they apply here too, this file doesn't override them.
