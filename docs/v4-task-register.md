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
| T-03 | **Stop conflating "flagged" with "the AI crashed."** `agentCallsFlagged` counts `flagged \|\| error`. Split into `agentCallsFlagged` and `agentCallsErrored`, expose both, and render a destructive strip when errored > 0. Cost renders "not recorded", never `$0.00`, when null or when errors exist. | `routes/bulks.ts`, `openapi.yaml`, `Rankings.tsx`, `Bulks.tsx` | Forcing one scan to error shows the strip; the ranking table is visibly unaffected |
| T-04 | **Build identity in `/api/healthz`.** Return `commitSha`, `builtAt`, `startedAt`, and `providersConfigured` (**names only — never a key or part of one**), injected at build time via esbuild `define`. | `build.mjs`, `routes/health.ts`, `api-zod`, `openapi.yaml` | `curl /api/healthz` shows the SHA of the running build |
| T-05 | **Build badge in the UI footer.** Quiet, monospaced, from T-04. | `components/layout.tsx` | Rebuild + restart changes the SHA on screen |
| T-06 | **Classify cell failures.** Add `failureClass` enum (`retention_expired \| audio_url_forbidden \| provider_timeout \| provider_5xx \| rate_limited \| audio_decode \| unknown`), set at the throw site — never by regexing a message afterwards. | `lib/db/src/schema/benchmark-results.ts`, `lib/run-executor.ts`, `openapi.yaml` | Last bulk's 45 failures classify as 42/2/1; `unknown` stays visible |
| T-07 | **Group failures in the UI; retry only what's retryable.** Replace the bare count with a grouped breakdown. The retry button carries the *retryable* count and is disabled (with a reason) at zero. | `Bulks.tsx` | Bulk `7d2585da` renders 42/2/1 and a button reading "Retry 1 retryable cell" |

---

## Phase 1.5 — validate the judge before anything trusts it

**Added 2026-08-28 from the adversarial architecture review, and promoted ahead of
Phase 2.** No measurement exists of whether the judge's picks correlate with truth.
Feeding an unvalidated judge into rankings (T-17) and memory (T-30) compounds
whatever it gets wrong. This is the cheapest high-value work in the whole register.

| ID | Task | Done when |
|---|---|---|
| T-08 | **Span adjudication UI.** For a disagreement span, play the 3–5 seconds of cached audio and let a human pick which provider heard it correctly (or "none of them"). Store as `adjudications(callId, spanStart, spanEnd, correctProviderId \| null, adjudicatedBy, at)`. This is the same component as the audio-anchored evidence view (UX D.3.2) — **build it once, it serves both.** | A human can adjudicate 20 spans in one sitting without leaving the page |
| T-09 | **Judge accuracy report.** Replay the adjudicated spans through `judgeCandidates` and report agreement rate. | A single number exists for "how often the judge agrees with a human", with its sample size |

**Why this ordering matters:** if the judge scores near chance, T-17 (rank on
adjudicated win rate) and T-30 (memory) must not be built on it. Find that out for
the price of one afternoon, not one quarter.

---

## Phase 2 — better corpus, faster agent

| ID | Task | Done when |
|---|---|---|
| T-10 | `maxDurationSeconds` through schema, criteria, OpenAPI and the create dialog. Default band 60–120s, overridable. | A bulk with `min=60,max=120` contains only calls in that range |
| T-11 | Capture `endedReason` and `analysis.successEvaluation` at import. Add `sourceEndedReason`, `sourceSuccessEvaluation` to `benchmark_calls`. **Only the verified field set** — see `docs/PRD-v4-technical.md` V4-T11. | An imported call reads back with the same `endedReason` Vapi returned |
| T-12 | Backfill `endedReason` for existing corpus calls still inside the 14-day window. Older ones stay null; **null must never silently mean "normal call."** | Backfill script run once, count reported |
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

## Findings log

Append anything learned mid-task here rather than losing it to a compaction.

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

- **2026-08-28:** measured per-provider latency (bulk `7d2585da`): Cartesia 128.8s,
  Gladia 15.3s, AssemblyAI 13.0s, Deepgram 3.5s, OpenAI 3.1s. **Cartesia is 79% of
  all vendor wait.** Own code is ~0.1% of runtime — which is why no language rewrite
  is on this register.
