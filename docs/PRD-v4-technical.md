# Technical PRD v4 — Durable execution, a typed LLM layer, and honest cost

**Version:** 1.0
**Date:** 2026-08-28
**Companion doc:** `docs/PRD-v4-uiux.md` (same review, UI/UX side — cross-referenced as U-n)
**Supersedes nothing.** v3 (`docs/PRD-v3-technical.md`) is still the ranking-correctness
doc. This one is about the *platform underneath it*: what breaks, what silently loses
data, and whether Vercel Workflow + BAML are the right answers.
**Baseline at review time:** HEAD `7313012`, `pnpm run typecheck` clean.
Bulk `7d2585da` ("Land and apartment", 72 calls × 5 providers) completed as `partial`:
**315/360 cells ok, 45 failed, 72/72 calls attempted.**
**Implementer note:** written for a Sonnet-class model. Every item names the file, the
current behaviour, the required behaviour, and how to prove it's done. Do not infer
scope beyond what an item says.

---

## 0. The one-paragraph mental model

The tool is a pipeline: **import calls → run every provider over the same audio →
flag what looks wrong (free, deterministic) → ask an LLM to judge the flagged ones →
rank providers → recommend one.** All five stages work. What does *not* work is
everything around the stages: the work isn't durable (a restart loses it), the LLM
stage's output is silently discarded on write, the cost numbers round to zero, and
the deployed binary can be four commits behind the repo with nothing on screen
saying so. This document fixes that layer.

---

## 1. Where we actually are (verified, not remembered)

### 1.1 What works

| Stage | State | Evidence |
|---|---|---|
| Import from Vapi | Works, 2 accounts wired | `lib/vapi.ts`, `sourceAccountLabel` resolver |
| Audio caching | Works, permanent | `lib/audio-cache.ts` → `./audio-cache/<callId>.audio` |
| Multi-provider run | Works, 5 providers live in last bulk | 315/360 cells ok |
| Hybrid flagging (gold-free) | Works, runs on every run automatically | `lib/hybrid-flagging.ts` |
| LLM judge | **Runs, then throws its answer away** — see V4-T1 | 63/63 scans, `status: "error"` |
| Ranking + recommendation | Works, bulk-scoped and all-time | `routes/benchmark.ts` |

### 1.2 Providers

| Provider | Adapter | Key configured | Live-proven |
|---|---|---|---|
| AssemblyAI (`assemblyai-universal`) | yes | yes | yes |
| Deepgram (`deepgram-nova-3`) | yes | yes | yes |
| Gladia (`gladia-solaria`) | yes | yes | yes |
| Cartesia (`cartesia-ink-whisper`) | yes | yes | yes (timeout fix undeployed) |
| OpenAI (`openai-gpt-4o-transcribe`) | yes | yes | yes |
| **ElevenLabs (`elevenlabs-scribe`)** | yes | **yes, added 2026-08-27** | **no — needs restart** |
| Speechmatics | yes | no key | no |

### 1.3 The architecture, stated plainly

```
Browser (Vite/React, :5173)
    │  /api/* proxy
    ▼
Express 5, single Node process (:8177), esbuild single-file bundle
    │
    ├── HTTP handler returns 202 immediately
    └── void executeBenchmarkRun(runId)   ← fire-and-forget, in-process
            ├── in-memory Set<runId> guard against double-execution
            ├── in-memory per-provider concurrency pools
            ├── per-cell retry loop (CELL_MAX_ATTEMPTS = 3)
            ├── 429 back-off (halves that provider's concurrency for 60s)
            ├── computeHybridFlagsForRun()
            └── runAutoAgentVerificationForRun()  → OpenAI judge
    │
    ├── Postgres (Supabase) via Drizzle
    └── Local disk: ./audio-cache/
```

**Every piece of state that makes a run resumable lives in one process's memory.**
That is the single sentence that explains most of Part B.

---

## Part A — P0 bugs found in this review. Fix these before anything else.

### V4-T1 (P0): Every LLM judgement in the last bulk was computed, paid for, and thrown away

**This is the most expensive bug in the project so far, because it destroys work
that already cost real money.**

**What happens.** `judge_cost_cents` is declared `integer`
(`lib/db/src/schema/benchmark-agent-scans.ts:88`). `costCentsFor()`
(`artifacts/api-server/src/lib/agent.ts:34`) returns a *fractional* number of cents —
a real observed value is `0.49050000000000005`. Postgres rejects the insert. The
insert is inside a `try` whose `catch` (`lib/agent-verify.ts:213`) assumes any
exception means *the judge failed*, so it writes a `status: "error"` row and drops
the judge's actual output on the floor.

**Proof (bulk `7d2585da`):**

```
actualCost: { agentCostCents: 0, agentCallsChecked: 63,
              agentCallsFlagged: 63, agentCallsJudged: 0 }
```

Every one of those 63 "flagged" rows is really a `status: "error"` row. Reading one
back shows the OpenAI call fully succeeded — 1350 prompt tokens, 153 completion
tokens, a coherent 900-character reasoning paragraph picking AssemblyAI, and a
resolved `agent_pick_result_id`. All of it discarded. Roughly **31 cents of OpenAI
spend and 63 real judgements lost**, reported to the user as `$0.00` and "0 judged".

**Three distinct defects, all required:**

1. **Precision.** Cents cannot hold sub-cent costs. Store integer **micro-cents**
   (`judge_cost_microcents integer`, 1 cent = 10,000 µ¢) or `numeric(12,6)`.
   Micro-cents is preferred — it matches the existing integer convention and can't
   drift with float maths. Apply the same treatment to
   `benchmark_scores.cost_cents`: `run-executor.ts:820` does
   `Math.round(costForThisCell * 100)`, so a 0.92¢ cell is recorded as 1¢ — an
   ~8% error that compounds across 315 cells.
2. **Blast radius.** A *storage* failure must never be reported as a *judge*
   failure. Split the `try` so the OpenAI call and the DB write are separately
   caught, with separate `errorMessage` prefixes (`judge_failed:` /
   `scan_write_failed:`).
3. **Never discard a good payload.** If the full insert fails, retry once writing
   the judgement *without* the cost columns, and log the cost separately. Losing
   a cost number is annoying; losing the judgement is unacceptable.

**Also fix while here:** `routes/bulks.ts:260` counts
`status === "flagged" || status === "error"` as `agentCallsFlagged`. That conflates
"the AI found problems" with "the AI crashed" — it is exactly why this bug looked
like a UI oddity instead of total data loss. Split into `agentCallsFlagged` and
`agentCallsErrored` and surface both (U-1).

**Done when:** a fresh bulk shows `agentCallsJudged == agentCallsFlagged`,
`agentCostCents > 0`, `agentCallsErrored == 0`, and at least one scan row read back
from the API carries non-empty `agentPickReasoning` and a non-null
`agentPickResultId`. Backfill is impossible — the payloads are gone. Say so in the
release note rather than quietly re-running.

### V4-T2 (P0): The running binary can be arbitrarily far behind the repo, and nothing says so

The process serving traffic right now started `Thu Aug 27 22:40:33`, from a bundle
built *before* commit `2bf1bcd` — so it is missing the Cartesia long-call timeout
fix, the judge-pick fallback, the retention-window exclusion, and the peer-flag
exposure. Four commits of fixes, live-invisible. `artifacts/api-server` has no watch
mode; every backend change needs `node ./build.mjs` + a manual process restart, and
it is trivially easy to forget one.

**Required.** `GET /api/healthz` (`routes/health.ts`) returns
`{ status, commitSha, builtAt, startedAt, providersConfigured: string[] }` —
`commitSha`/`builtAt` injected at build time by `build.mjs` via esbuild `define`,
`providersConfigured` derived from which env vars are present (**names only, never
values, never partial keys**). The UI footer renders `commitSha` (U-5). A stale
deploy becomes visible in one glance instead of requiring `ps`.

### V4-T3 (P0): Cell failures have three unrelated causes and one indistinguishable label

45 cells failed in the last bulk. They are not one problem:

| Cause | Fixable here? | Correct user action |
|---|---|---|
| Cartesia response timeout on long calls | Yes — **fixed, undeployed** (`2bf1bcd`) | Retry after deploy |
| Vapi 14-day retention expired, no cached audio | **No, ever** | Exclude from selection (**fixed, undeployed**, `74a7edd`) |
| Supabase `archive` bucket 403 on signing | No, not from this app | Needs Vapi support / bucket access |

Today all three write `status: "failed"` with only a free-text message. The UI can
therefore only say "45 failed", which reads as "the tool is 12% broken" when in
truth ~93% of those failures are *known and unfixable from here*.

**Required.** Add `failureClass` (enum) to the provider-call-result row:
`retention_expired | audio_url_forbidden | provider_timeout | provider_5xx |
rate_limited | audio_decode | unknown`. Classify at the throw site in
`run-executor.ts`, never by regexing the message afterwards. Surface counts by class
(U-2). `unknown` must stay in the enum and must be visible — an unclassified failure
is a signal, not a rounding error.

---

## Part B — Vercel Workflow: yes to durable execution, with a specific caveat

### B.1 What it actually is

Vercel's [Workflow Development Kit](https://vercel.com/blog/introducing-workflow) is
a **durable execution** engine for TypeScript. You mark an async function
`"use workflow"` and the units of work inside it `"use step"`. The runtime records
each step's input and output to an event log; if the process crashes, redeploys, or
times out, it **replays the log and resumes without re-running completed steps**.
Steps get automatic retries with exponential backoff (3 by default, configurable per
step). It is open source and in public beta.

**n8n analogy:** today, `executeBenchmarkRun` is one giant Code node that holds all
its state in variables. Close the browser tab — sorry, restart the process — and the
whole thing is gone. Workflow turns each cell into its own node with its own saved
output, so restarting picks up exactly where it stopped.

### B.2 Why it fits this project unusually well

The run executor is *already* shaped like a durable workflow and has hand-rolled,
in-memory versions of four things the engine gives you for free:

| Hand-rolled today | Workflow primitive |
|---|---|
| `Set<runId>` double-execution guard | Workflow identity / idempotent start |
| Per-cell retry loop, `CELL_MAX_ATTEMPTS` | `step.maxRetries` + backoff |
| 429 back-off halving provider concurrency | Step retry policy + sleep |
| "Resumable, not retryable-by-luck" (project rule) | Event-log replay — the actual definition |

The natural decomposition is already in the code:
**bulk → shard run → call → provider cell**. Each provider cell is a perfect step:
pure-ish, idempotent by `(runId, callId, providerId)`, and independently retryable.
A long Gladia poll or a 15-minute Cartesia socket stops being "a promise we hope
survives" and becomes a step the engine owns.

### B.3 What it costs here — the honest blockers

1. **The audio cache is local disk.** `CACHE_DIR = path.join(process.cwd(),
   "audio-cache")` (`lib/audio-cache.ts:27`). Serverless has no durable shared
   filesystem. This must move to object storage (Vercel Blob / S3 / Supabase
   Storage) **before** any serverless hosting. This is the single biggest
   migration item, and it is not optional — the cache is what makes
   retention-expired calls still runnable.
2. **Audio payload size.** Runs hold real audio buffers. The executor already
   fought this once (a 50-call shard held ~200MB). Steps must pass *references*
   (a blob key), never buffers, or memory/payload limits will bite.
3. **Cartesia is a WebSocket.** A long-lived socket inside a step is the least
   natural fit in the whole system. It works, but it wants to be one step that
   owns the whole socket lifecycle, not a step that hands a socket to another step.
4. **DB connections.** Many concurrent serverless invocations against Postgres
   needs pooling discipline (Supabase pooler / a serverless driver). Today one
   process holds one pool.
5. **Long-lived process assumptions.** The in-memory concurrency pools and 429
   back-off state are per-process. Under serverless fan-out they'd need to become
   shared state or be replaced by the engine's own rate controls.

### B.4 Recommendation — separate "durable" from "Vercel"

**Adopt the durable-execution engine. Do not migrate hosting in the same step.**

The Workflow DevKit is open source and not Vercel-only. So:

- **Phase 1 (recommended, low risk):** run the workflow engine **inside the existing
  Express process**. Convert `executeBenchmarkRun` into a workflow with
  cell-level steps. Keep local disk, keep the current deploy, keep everything else.
  You get resumability across restarts and engine-managed retries **without**
  touching hosting, storage, or connection pooling. This directly closes the
  "no durable job queue" gap that `.claude/CLAUDE.md` has been carrying as a known
  documented risk since MVP.
- **Phase 2 (only if Phase 1 proves out):** move the audio cache to blob storage
  and pass keys between steps. This is worth doing *on its own merits* regardless of
  hosting — it also makes the corpus portable to a second machine.
- **Phase 3 (optional, a business decision, not a technical one):** host on Vercel.
  Only meaningful once this tool needs to be reachable by people who aren't at
  Abhishek's laptop. Nothing about the benchmark work requires it today.

**Do not** rewrite the provider adapters. They are pure functions with real live
proof behind them (`docs/provider-data-samples.md`); they become step bodies
unchanged.

---

## Part C — BAML: yes, for the LLM layer only

### C.1 What it is

[BAML](https://boundaryml.com/) is a small DSL for LLM functions. You declare the
input, the output *type*, and the prompt together in a `.baml` file; a Rust compiler
generates a typed TypeScript client. Its **Schema-Aligned Parsing** coerces
imperfect model output (markdown-wrapped JSON, trailing prose, chain-of-thought)
into the declared type instead of hard-failing, without the accuracy cost of strict
JSON mode.

### C.2 Why this project specifically needs it

The judge's contract is currently enforced by hope. When the model didn't return a
usable `pickedProviderId`, the fix was a **regex over the reasoning prose**:

```ts
// artifacts/api-server/src/lib/agent.ts
function inferPickFromReasoning(reasoning, candidates) {
  // finds whichever provider name appears earliest in the paragraph
}
```

That is a heuristic guessing at what the model meant, in the exact place where the
project's own rule says *never guess*. It works, and it should be replaced.

In BAML the pick becomes a **type**, not a string to be parsed:

```baml
enum PickedProvider { AssemblyAI Deepgram Gladia Cartesia OpenAI ElevenLabs }

class JudgeVerdict {
  picked      PickedProvider
  confidence  float          @description("0-1, how sure you are")
  reasoning   string
  perProvider PerProviderNote[]
}

function JudgeCandidates(draft: string, flags: Flag[], candidates: Candidate[]) -> JudgeVerdict {
  client GPT4o
  prompt #" ... "#
}
```

Concrete wins, each mapped to something that actually went wrong here:

| Problem seen in this repo | What BAML gives |
|---|---|
| `agentPickProviderId` null → regex fallback | Output is an enum; unparseable = loud failure, not a guess |
| Prompt buried in a TS template literal | Prompt is versioned, diffable, reviewable in a `.baml` file |
| No way to test a prompt change | Test cases run against saved transcripts in CI |
| One model, hardcoded | Client fallback/round-robin (gpt-4o → gpt-4o-mini) declared, not coded |
| V4-T1's cost capture | Still yours to write — **BAML does not solve cost precision** |

We also already have the fixtures: **75 real agent-scan rows** with real transcripts
and real flags, ready to become a regression suite for the judge prompt.

### C.3 Costs and the one thing to watch

- Another codegen step. Acceptable — the repo already runs `orval` codegen for the
  API client, so the pattern and the muscle memory exist.
- **Native binary per platform.** This repo has already been bitten twice by
  platform-pinned binaries (`@esbuild/darwin-arm64`, `@rollup/rollup-darwin-arm64`
  had to be pinned by hand in `81fbbb4` after a Linux-only lockfile broke codegen on
  macOS). BAML ships native bindings; **pin them the same way, in the same commit
  that adds BAML**, or the next fresh checkout breaks identically.
- A DSL to learn. Small — one file, one function, to start.

### C.4 Recommendation

**Adopt BAML for `judgeCandidates` only, behind the existing function signature.**
`lib/agent-verify.ts` keeps calling `judgeCandidates(...)` and doesn't know or care
what's underneath. If BAML disappoints, the swap back is one file. Do not migrate
anything else to BAML until the judge has run a full bulk on it.

**Sequencing note:** do V4-T1 *first*. Putting BAML in front of a write path that
discards its output would make a better judge produce exactly the same `$0.00`.

---

## Part C-2 — Did the new requirements change the recommendation? (Asked directly, answered directly)

Abhishek asked whether Workflow + BAML are genuinely the right choices, or whether
something else fits better now that parallelism, comparison detail and graph memory
are in scope. Honest answer: **the new requirements strengthen the case for both, and
add exactly one thing neither of them covers.**

### The Workflow call, re-checked against Parts F–H

Parts F–H add: agent parallelism (V4-T13), per-call comparison work, and an
incremental memory write at the end of every run. All three are *more* work fanned
out per bulk, with *more* places to fail halfway. That is the argument for durable
execution getting stronger, not weaker. Still **adopt the engine in-process first**;
nothing here changes the hosting caveat, and the local-disk audio cache remains the
blocker for anything serverless.

**Alternatives weighed, and why not:**

| Option | Why not here |
|---|---|
| **Temporal** | The most capable durable-execution engine, and the heaviest — a server cluster to operate. Correct at a scale this project is nowhere near. |
| **Inngest / Trigger.dev** | Both good, both hosted-first — they'd want to reach your API, which means exposing it. Workflow DevKit runs in-process today with no such requirement. |
| **BullMQ + Redis** | A job queue, not durable execution. Gives retries and a queue; does **not** give resume-mid-function-after-crash, which is the actual requirement. Adds Redis to operate. |
| **Keep hand-rolling it** | The status quo. Already produced one documented race condition and an in-memory guard that only protects a single process. |

**Verdict: unchanged. Workflow DevKit, in-process, Phase 3.**

### The BAML call, re-checked

V4-T14 (structured verdicts with margins), the per-call comparison (U-13) and V4-T16
(feeding known blind spots into the judge prompt) all want **the same thing**: the
LLM returning a typed object with several fields, reliably, from a prompt that is
going to be edited repeatedly and must not silently regress. That is precisely BAML's
job, and the case is stronger than it was an hour ago.

**Alternatives weighed:**

| Option | Why not here |
|---|---|
| **OpenAI structured outputs / strict JSON mode** | Free, no new dependency, and already available. Real option — but it's per-vendor, it constrains generation in a way that measurably costs quality on reasoning-heavy prompts, and it gives you no prompt versioning and no test harness. |
| **Zod + a retry loop** | Roughly what exists today, one layer better. Fixes parsing; does nothing for prompt versioning, testing, or model fallback. |
| **Vercel AI SDK `generateObject`** | Genuinely good, and pairs naturally if you go Vercel. Typed output via Zod, multi-provider. Weaker than BAML on prompt-as-artifact and on a real test suite. **This is the credible runner-up** — pick it over BAML if you want one less toolchain and are already committing to the Vercel stack. |
| **LangChain / LlamaIndex** | Far more framework than one judge function needs. |

**Verdict: BAML, for the judge only, behind the existing signature.** If adding a
Rust-compiled codegen step proves annoying in practice, `generateObject` from the AI
SDK is the fallback and costs a day to switch.

### The one thing neither covers, and the only new tool worth considering

Neither Workflow nor BAML gives you the **graph memory** in Part H. The right answer
there is deliberately boring: **build it in the Postgres you already run.** Two
tables, a unique index, recursive CTEs for traversal. Do not add Neo4j, and do not
reach for a hosted memory product — the value is in *your* flags and *your* audit
trail, which no general-purpose memory service knows anything about, and this project
has already removed one memory dependency (Mem0) rather than carry it.

### The honest risk in all of this

Three new subsystems — parallel agent, structured verdicts, graph memory — is a lot
of new surface for a tool whose *current* problem is that it silently discards the
results it already computes. **Sequencing is the actual recommendation here.** Fix
the data loss, deploy, prove one bulk end to end with real numbers on screen. Then
add memory. A memory built on top of a pipeline that loses 63 of 63 judgements would
faithfully remember nothing.


---

## Part F — Corpus selection: pick the calls that actually teach us something

Added 2026-08-28 at Abhishek's request. **Every number in this part was measured
against the live Vapi API on 2026-08-28 (100 most recent calls, "Land And
Apartment" account), not assumed.**

### V4-T10 (P1): Duration band, not a floor

**Today.** `resolveCriteriaCallIds` supports `minDurationSeconds` only
(`lib/bulks.ts:135`, `gte(...)`, default 5). There is no upper bound, so a
20-second "wrong number" and an 8-minute outlier land in the same bulk with equal
weight.

**Required.** Add `maxDurationSeconds` alongside it (`lte(...)`), thread it through
`selectionCriteria`, the OpenAPI `Bulk`/`BulkDetail`/create schemas, and the create
dialog. **Default the band to 60–120 seconds**, overridable — a 1–2 minute call is
long enough to contain names, numbers, addresses and a real exchange, and short
enough to stay cheap.

**Measured consequence — read this before shipping the default.** Of the 100 most
recent calls:

| Band | Count |
|---|---|
| 0–20s | 42 |
| 20–60s | 33 |
| **60–120s (the target band)** | **11** |
| 2–5 min | 9 |
| >5 min | 1 |
| no start/end times | 4 |

**The 1–2 minute band is 11% of traffic.** The band is the right *quality* call —
but a bulk built from it will be roughly a tenth the size of one built from
everything over 20s. Two consequences the UI must state, not hide (U-11): a bulk may
come back much smaller than expected, and reaching a useful sample size will need a
wider date range than a single week.

**Done when:** a bulk created with `min=60, max=120` contains only calls whose
`durationSeconds` is in that range, and the create dialog shows the resulting count
*before* the cost gate.

### V4-T11 (P1): Capture Vapi's call outcome — we currently throw it away

**Today.** `VapiCall` (`lib/vapi.ts:129`) declares `status` and never reads
`endedReason` at all. `benchmark_calls` has no column for either. So the corpus
cannot distinguish a completed conversation from a misdial from a call the assistant
handed to a human.

**Measured — the real distribution across 100 calls:**

| `endedReason` | Count | What it is |
|---|---|---|
| `customer-ended-call` | 49 | Caller hung up — a normal completed call |
| `assistant-forwarded-call` | **39** | **Assistant handed off to a human** |
| `twilio-reported-customer-misdialed` | 4 | Misdial — no real conversation |
| `silence-timed-out` | 4 | Nobody spoke |
| `assistant-ended-call` | 2 | Assistant closed it |
| `assistant-said-end-call-phrase` | 1 | Assistant closed it, by phrase |
| `voicemail` | 1 | Machine, not a person |

Vapi also returns `analysis.successEvaluation` on **every** call (87 `true`,
4 `false`, 9 `null`) plus `analysis.summary` and `analysis.structuredData`.

**Why this matters more than it looks.** 39% of calls are
`assistant-forwarded-call` — the assistant gave up and passed the caller to a human.
Those are disproportionately the calls where the AI *misheard something*, which
makes them the **highest-signal calls in the corpus for an STT benchmark**, not
noise to filter out. Meanwhile `voicemail`, `silence-timed-out` and
`twilio-reported-customer-misdialed` contain little or no human speech and are close
to worthless for scoring — they inflate the corpus and every provider's cost with
nothing to learn from.

**Required.**

1. Add to `VapiCall`: `endedReason?: string` and
   `analysis?: { successEvaluation?: string | boolean | null; summary?: string }`.
   Read them at import. **Do not add fields Vapi doesn't actually return** — the
   list above is the verified set; anything beyond it needs its own live check
   first (this project has been burned by exactly that twice).
2. Add to `benchmark_calls`: `sourceEndedReason text`,
   `sourceSuccessEvaluation text` (store Vapi's raw value verbatim — it is
   `"true"`/`"false"` strings today, and normalising it now would destroy
   information if Vapi widens it later).
3. Add three selection filters, all optional, all off by default:
   `includeEndedReasons` / `excludeEndedReasons` / `successEvaluation`.
4. **Backfill.** Existing corpus calls have no `endedReason`. It is re-fetchable
   from Vapi *only within the 14-day window*; older calls will stay null forever.
   Backfill what's reachable, leave the rest null, and never let null silently mean
   "normal call".

**Suggested default preset — "worth benchmarking":**
`endedReason IN (customer-ended-call, assistant-forwarded-call, assistant-ended-call,
assistant-said-end-call-phrase)`, i.e. exclude misdials, silence timeouts, and
voicemail. On the measured sample that keeps 91 of 100 and drops 9 that contain
almost no speech.

**Done when:** the Corpus table shows an outcome column, a bulk can be built from
forwarded calls only, and one imported call read back from the API carries the same
`endedReason` string Vapi returned.

### V4-T12 (P1): Make the 14-day window a selection rule, not only an exclusion

**Today.** The retention filter (shipped, undeployed) *removes* calls older than 14
days at bulk-creation time — after the user has already picked a date range.

**Required.** Push it upstream so it is a stated rule rather than a late surprise:
the import date-range picker and the bulk criteria both default their lower bound to
**today − 14 days**, labelled with the reason. Selecting earlier is still allowed —
already-cached calls remain perfectly runnable and must not be blocked — but the
default should never invite a user to pick a range Vapi cannot serve.

---

## Part G — The agent: parallel, and legible

### V4-T13 (P0): Agent verification runs strictly one call at a time

**Today.** `runAutoAgentVerificationForRun` (`lib/agent-verify.ts:259`) is a plain
sequential loop:

```ts
for (const [callId, callRows] of byCallId) {
  await verifyCallWithAgent({ ... });   // one OpenAI round-trip, blocking
}
```

Every provider cell in the same run went through a bounded concurrency pool. The
agent pass then walks the same calls **serially**. On a 72-call bulk that is 72
sequential OpenAI round-trips — minutes of wall-clock for work that is embarrassingly
parallel and has no ordering constraint whatsoever.

**Required.** Reuse the existing bounded-concurrency helper the run executor already
exports (`lib/run-executor.ts:192` — written precisely to avoid unbounded
`Promise.all` blowups). Add `AGENT_CONCURRENCY` (default 4, clamped, same
`envInt` pattern as `CELL_MAX_ATTEMPTS`). Keep the existing per-call `try/catch` —
one call's failure must still never take the run down. Honour OpenAI 429s with the
same halve-and-back-off treatment providers get.

**Done when:** a bulk's agent pass wall-clock drops by roughly the concurrency
factor, no call is verified twice, and a forced failure on one call still leaves the
other results intact.

### V4-T14 (P1): State the verdict in percentages, with the winner and the margin on top

Abhishek's ask, verbatim in intent: *an average of how well each one does, the
percent very clear, and at the top whether it is better or worse and by exactly how
much.*

**Today.** Rankings shows raw averages — `avgPeerFlagCount` 0.84, `avgFlagCount`
2.10 — with no denominator. "0.84 flags" is meaningless without knowing 0.84 *out of
how many words*.

**Required — computed in the API, never in the component:**

1. **Normalise per 100 words.** `flagsPerHundredWords = avgPeerFlagCount /
   (avgWordCount / 100)`. A rate is comparable across calls of different lengths;
   a raw count is not.
2. **A clean-call percentage.** `% of this provider's calls with zero peer flags` —
   the single number a non-technical reader understands immediately.
3. **A headline verdict object** per ranking group:
   ```
   { winnerProviderId, runnerUpProviderId,
     marginPct,            // relative improvement in flags/100w over runner-up
     vsProductionPct,      // same, against the provider Vapi runs live today
     evidenceCalls,        // how many calls this rests on
     confidenceComparable  // how many providers reported confidence at all
   }
   ```
   Rendered as one sentence at the top of the page (U-12).
4. **Never state a margin without its evidence count.** A 12% margin over 3 calls is
   noise; over 70 it is a decision. The number and its denominator ship together or
   not at all.

---

## Part H — Memory: remember what each provider gets wrong

Abhishek's ask: the system should remember what a given model usually fails on, and
what our own agent usually fails to *detect*, so both can be improved — represented
as a **graph**, not a flat list.

This is the most genuinely new capability in v4 and it is also the easiest one to
get dangerously wrong. Read V4-T17 before building V4-T15.

### V4-T15 (P2): A failure-pattern graph

**The shape.** Every flag the hybrid pass produces already names: a call, a provider,
a span of words, a reason, and (often) an entity type. Today that is written once per
run and never looked at again. Turn it into a small graph in the Postgres already in
use:

```
node kinds:  provider · error_pattern · entity_type · phrase · vertical · call
edges:       (provider) --misheard-->  (phrase)        weight, n_observations
             (provider) --weak_on-->   (entity_type)   weight, n_observations
             (error_pattern) --seen_in--> (call)
             (phrase) --occurs_in-->  (vertical)
```

Two tables — `memory_nodes(id, kind, key, label, first_seen, last_seen)` and
`memory_edges(src, dst, kind, weight, n_observations, last_seen)` — plus a unique
index on `(kind, key)` and on `(src, dst, kind)`. Written incrementally at the end of
each run from flags that already exist. No new LLM calls, no new cost.

**Why a graph and not a table.** Abhishek's instinct here is right, and the reason is
specific: the useful questions are *multi-hop*. "Which providers are weak on the
entity types that matter in property-management calls?" is provider → entity_type →
vertical — two hops. A flat "errors" table answers one-hop questions only and needs a
new report for every new question. A graph answers questions you didn't pre-plan,
which is exactly what a growing corpus of verticals needs.

**Stay in Postgres.** Recursive CTEs handle two- and three-hop traversal
comfortably at this scale (thousands of nodes, not millions). **Do not add Neo4j** —
a second datastore to run, back up, and keep consistent, to serve a graph that fits
in a laptop's RAM. If similarity search over phrases is wanted later, `pgvector`
on Supabase is the next step, not a new database. *Verify pgvector is enabled on the
project before designing around it — do not assume.*

### V4-T16 (P2): Agent self-audit — what the judge itself misses

The second half of the ask, and the harder half. A judge that is never checked
accumulates blind spots silently.

**Source of truth:** the `approve`/`reject` audit trail that already exists on
`benchmark_agent_scans` and currently feeds nothing. Every rejection is a labelled
example of the agent being wrong.

**Required.** An `agent_blindspots` view over that trail: flag categories where
human rejection rate is high, entity types the judge consistently picks wrong on,
providers it appears to favour independent of evidence. Surface it as a page section
(U-14), and **feed the top patterns into the judge prompt as explicit
"known weaknesses, check these carefully" context** — which is precisely the kind of
prompt change BAML makes safe to version and test rather than hand-edit.

### V4-T17 (P1 — a guard rail, do this with V4-T15): memory must inform, never prejudge

**The risk, stated plainly.** A memory that says "Cartesia usually gets phone numbers
wrong" and is then fed to the judge has just put a thumb on the scale. The next time
Cartesia gets a phone number *right*, the judge has been primed to doubt it. That is
the same failure this project already has a standing rule against — *the draft
transcript must never become the gold standard* — wearing a new costume.

**Non-negotiable rules for anything built in Part H:**

- Memory may **surface evidence** ("this provider has been flagged on phone numbers
  in 14 of 62 calls — here they are"). It may **never adjust a score, a rank, or a
  weight**.
- The judge may receive memory as *context to check*, never as a *prior to apply*.
  The prompt says "verify these carefully", never "this provider is usually wrong".
- Every memory-derived claim shown in the UI carries its observation count and links
  to the underlying calls. An unfalsifiable claim is not evidence.
- A/B it: run one bulk with the memory-primed judge and one without, on the same
  calls, and compare. If the primed judge's picks correlate with the memory more than
  with the transcripts, the feature is harming the tool and must come out.

---

## Part I — Library decisions, and the ones deliberately not taken

Added 2026-08-28. Abhishek asked directly whether LangChain / LangGraph belong here.
**They do not.** This part records that call and every other library decision in one
place, so nobody re-litigates it in six weeks.

### I-1: Not LangChain, not LangGraph

**LangGraph is for agentic control flow** — an LLM deciding what happens next,
looping, branching on its own output, calling tools. This pipeline has none of that.
The flow is fixed and fully known before it starts:

```
fetch audio → run N providers → compute flags (deterministic, no LLM) → one LLM call → rank
```

**There is exactly one LLM call in the entire system**, and it decides nothing about
control flow. Wrapping a fixed five-step pipeline in an agent framework buys an
abstraction tax for a capability that is never used.

**LangChain** has the same problem one level down. `callOpenAi` is a plain `fetch`
(`lib/agent.ts`). Replacing it with LangChain swaps ~50 lines of directly-readable
code for a large dependency tree and a layer of indirection, and the cost-capture
work (V4-T1) still has to be written by hand afterwards.

**The name collision, stated explicitly, because it is the likely source of
confusion.** "Graph" means two unrelated things here:

| | What "graph" refers to |
|---|---|
| **LangGraph** | The *execution* graph — your program's steps, wired as nodes |
| **Part H memory** | The *data* graph — "Cartesia mishears phone numbers in this vertical" |

Adopting LangGraph would **not** provide the memory graph. That still has to be built
in a database either way. The two are unrelated despite the shared word.

**Revisit this decision if, and only if,** the system ever needs an LLM to choose its
own next step — e.g. an agent that decides *which* providers to re-run based on what
it found. Nothing in v4 requires that.

### I-2: The full library table

| Job | Decision | Phase | Why |
|---|---|---|---|
| Durability, retries, resume-after-crash | **`workflow` (Vercel DevKit)** | 5 | The only candidate that resumes mid-function after a crash. Runs in-process; no hosting change required. |
| Typed LLM output for the judge | **BAML** (runner-up: AI SDK `generateObject`) | 4 | Turns the pick into an enum, the prompt into a versioned file, and prompt edits into testable changes. |
| Graph memory storage | **No new library.** Drizzle + the existing Postgres | 6 | Two tables, a unique index, recursive CTEs. Scale is thousands of nodes. |
| Graph visualisation | **`react-force-graph-2d`** | 6 | Canvas-based node/edge view — the "dots" picture. `d3-force` + a hand-written Canvas renderer is the lighter alternative if the wrapper proves awkward. |
| Charts (rates, percentages, trend) | **`recharts` — already installed** | 3 | Present in `artifacts/stt-benchmark` today and unused by the pages this PRD touches. Use it before adding anything. |
| Bounded concurrency for the agent pass | **No new library.** The helper already exported from `run-executor.ts:192` | 2 | Written for exactly this; adding `p-limit` alongside it would be two implementations of one idea. |
| HTTP, DB, validation, UI | **Unchanged** — Express 5, Drizzle, Zod, Radix/Tailwind | — | No reason to touch any of them. |

### I-3: The point worth internalising

**Phases 1, 2 and 3 require zero new dependencies.** Fixing the discarded judgements,
the duration band, `endedReason` capture, the parallel agent pass and the percentage
verdict are all plain code in files that already exist.

Libraries enter at phase 4 and later. **Install nothing before then.** Every
dependency this repo has added under pressure has cost a day somewhere later —
`@esbuild/darwin-arm64` and `@rollup/rollup-darwin-arm64` both had to be pinned by
hand after a lockfile mismatch broke a fresh checkout (`81fbbb4`). Two rules follow
from that, and they apply to BAML and `workflow` equally:

1. **Pin any native binary in the same commit that adds the library.** Not later.
2. **Add one library per commit**, with a typecheck and a real run between them.


---

## Part D — Robustness backlog (P1, after Part A)

- **V4-T4: Cost precision everywhere.** Micro-cents for STT cells and judge calls;
  format at the edge, never in the DB. Blocks any credible cost comparison.
- **V4-T5: Idempotency key per cell.** `(runId, callId, providerId)` unique
  constraint. The in-memory guard protects one process; the DB protects everything.
  Prerequisite for Part B Phase 1.
- **V4-T6: Startup configuration report.** On boot, log which providers are
  configured, by **name only**. Would have surfaced "ElevenLabs is keyed but this
  binary predates it" instantly.
- **V4-T7: Judge contract tests.** Replay the 75 saved scans through
  `judgeCandidates`; assert every result yields a pick inside the candidate set and
  a non-empty reasoning. Run in CI. This is the regression test V4-T1 never had.
- **V4-T8: Retention-filter unit test.** `resolveCriteriaCallIds` must be proven to
  keep an old-but-cached call and drop an old-and-uncached one. The logic is
  correct today and completely untested.
- **V4-T9: Structured failure logging.** One log line per failed cell with
  `failureClass`, provider, callId, attempt — so root-causing the next "why did 45
  fail" takes a query, not a code read.

---

## Part E — Phasing

| Phase | Contents | Exit criteria |
|---|---|---|
| **0. Deploy what's already fixed** | Restart with `7313012` + ElevenLabs key | ElevenLabs appears in a run; Cartesia long calls pass; retention exclusion note visible on a new bulk |
| **1. Stop losing data** | V4-T1, V4-T2, V4-T3 | A bulk reports non-zero agent cost, judged == flagged, failures grouped by class |
| **2. Better corpus, faster agent** | V4-T10 duration band, V4-T11 `endedReason` capture + backfill, V4-T12 window default, V4-T13 agent concurrency | A bulk of 60–120s forwarded-only calls runs, and its agent pass finishes ~4x faster than serial |
| **3. Legible verdicts** | V4-T14 rates + percentages + headline verdict; U-12/U-13 | A non-technical reader gets the winner, the margin, and the evidence count from one sentence |
| **4. Typed LLM layer** | BAML for `judgeCandidates`, V4-T7 | Judge contract tests green in CI; a full bulk judged through BAML with zero null picks |
| **5. Durable execution** | Workflow DevKit in-process, V4-T5 | Kill the server mid-bulk; on restart it resumes and does **not** re-charge completed cells |
| **6. Memory** | V4-T15 graph, V4-T16 self-audit, V4-T17 guard rails | The A/B in V4-T17 shows the memory-primed judge tracking transcripts, not the memory |
| **7. Portable storage** | Audio cache → blob storage | Corpus runs from a second machine with no local `audio-cache/` |
| **8. Hosting (optional)** | Vercel | Only when someone other than Abhishek needs to open the tool |

**Phase 5's exit criterion is the whole point of Part B.** If killing the process
mid-bulk doesn't resume cleanly, the migration bought nothing.

---

## Verification rules for every item here

- `pnpm run typecheck` clean at the repo root — not optional, not "looks right".
- Backend changes need `node ./build.mjs` **and** a process restart. There is no
  watch mode. V4-T2 exists because this was forgotten.
- Schema changes: `drizzle-kit push` from `lib/db` with `DATABASE_URL` from
  `artifacts/api-server/.env`, then **read a row back through the API** before
  trusting writes. V4-T1 is what "typechecks fine, fails at the DB" looks like.
- Anything touching run execution or schema gets a worktree (standing project rule).
- Live-prove against real providers, not mocks — every provider assumption this
  project got wrong came from guessing instead of checking.

## Sources

- [Built-in durability: Introducing Workflow Development Kit — Vercel](https://vercel.com/blog/introducing-workflow)
- [Vercel Workflows documentation](https://vercel.com/docs/workflows)
- [Open source Workflow Development Kit is now in public beta — Vercel](https://vercel.com/changelog/open-source-workflow-dev-kit-is-now-in-public-beta)
- [BAML: the programming language for agents — BoundaryML](https://boundaryml.com/)
- [BoundaryML/baml — DeepWiki](https://deepwiki.com/BoundaryML/baml)
