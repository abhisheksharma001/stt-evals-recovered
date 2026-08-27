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
| **2. Typed LLM layer** | BAML for `judgeCandidates`, V4-T7 | Judge contract tests green in CI; a full bulk judged through BAML with zero null picks |
| **3. Durable execution** | Workflow DevKit in-process, V4-T5 | Kill the server mid-bulk; on restart it resumes and does **not** re-charge completed cells |
| **4. Portable storage** | Audio cache → blob storage | Corpus runs from a second machine with no local `audio-cache/` |
| **5. Hosting (optional)** | Vercel | Only when someone other than Abhishek needs to open the tool |

**Phase 3's exit criterion is the whole point of Part B.** If killing the process
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
