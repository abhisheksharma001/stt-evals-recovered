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
6. **`docs/provider-data-samples.md`** — real (not hypothetical) examples of exactly
   what each provider's API and Vapi's API send back. Read before adding any new
   provider field or metric.
7. **`docs/reproducibility.md`, `docs/logic-register.md`, `docs/execution-plan.md`** —
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
