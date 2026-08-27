# Technical Fixing PRD — making the base solid

**Version:** 0.1 — Draft
**Status:** Findings from a full end-to-end review, 2026-08-27. No new features here —
every item below is either a real bug, a real data-durability risk, or a piece of
already-shipped work that is silently disconnected from the rest of the app.
**Companion doc:** `docs/PRD-ux-fixes.md` covers the UI/UX side of the same review.

## Method

Not a code-reading pass alone. Verified against the live dev DB (`stt_evals`,
121 corpus calls, 12 runs, 1,139 provider-call-result cells) and the live API
server (`localhost:8177`), plus a fresh `pnpm run typecheck` and both unit suites.

**Current baseline, confirmed live:**
- `pnpm run typecheck` — clean across all 4 packages (api-server, stt-benchmark,
  mockup-sandbox, scripts).
- `lib/scoring` (24 tests) and `lib/stt-providers` (21 tests) — both green.
- Cell-status breakdown across the whole corpus: **751 `skipped_pending_review`,
  201 `ok`, 187 `failed`.**

The 751/201/187 split is not itself a bug — see FIX-1 below for why so many are
skipped, and FIX-2 through FIX-5 for what's actually broken inside the 187.

---

## FIX-1 (P0): Every STT adapter's HTTP-error path throws away the provider's real error text

**What's broken:** Six of seven adapters (`assemblyai`, `deepgram`, `elevenlabs`,
`gladia`, `speechmatics`, `openai` — Cartesia is WS-based and separate) handle a
non-2xx submit response the same way:

```ts
errorMessage: `Gladia submit returned HTTP ${submitRes.status}`,
```

Every one of these already parses the response body into `rawOutput` (for audit/
debug storage) but never folds any of it into `errorMessage`. Confirmed live: of
23 `gladia-solaria` failures, every single one reads exactly `"Gladia submit
returned HTTP 400"` — zero information about *why* Gladia rejected the request
(bad `audio_url`? unsupported `diarization` param? auth?).

**Why it matters now, not just in principle:** this directly undercuts the
failure-analysis feature shipped this week (`analyzeFailure` in `lib/agent.ts`).
That feature's whole job is to turn `errorMessage` + `httpStatus` into a plain-
English diagnosis — but for 6 of 7 providers, `errorMessage` carries no signal
beyond the status code, so the AI analysis is guessing from a status code alone
on every one of these. It also means a human reading the raw error in the Runs
page gets nothing actionable either.

**Fix:** in each adapter's error branch, append whatever the parsed body's own
error/message field says, e.g.:
```ts
const body = await submitRes.json().catch(() => null);
errorMessage: `Gladia submit returned HTTP ${submitRes.status}: ${body?.message ?? body?.error ?? JSON.stringify(body) ?? "no body"}`,
```
Same pattern for AssemblyAI, Deepgram, ElevenLabs, Speechmatics, OpenAI's submit-
error branches. Small, mechanical, same shape in all six files
(`lib/stt-providers/src/adapters/*.ts`).

---

## FIX-2 (P0): Vapi's 14-day retention window is a permanent, growing data-loss clock — not fixed by retrying

**What's broken:** `resolveFreshRecordingUrl()` (`lib/vapi.ts`) deliberately never
caches a recording URL — it re-asks Vapi's live API for a fresh signed link on
*every* run, for every call, including calls that already ran successfully
before. Confirmed live, the exact Vapi response for 8 distinct corpus calls
across every one of 5 providers (40 failed cells, same root cause):

```
Vapi API returned HTTP 400: {"message":"Your subscription plan only covers
the last 14 days of call history. This call exceeds your retention window.",
"error":"Bad Request","statusCode":400}
```

This is **not transient and not retryable** — once a call's original recording
crosses 14 days old on the current Vapi plan, Vapi itself refuses to issue any
fresh URL for it, forever. Any corpus call that hasn't been run by day 14
becomes permanently unscoreable by every provider, including re-runs of a call
that *already scored fine* the first time (the executor has no memory that it
once had a working URL for that call).

This is a clock, not a one-time bug: right now it's 8 of 121 calls (7%), but it
grows every day corpus calls sit unreviewed or unrun, and it will silently start
eating the 21 currently-`ready_to_run` calls too as they age past day 14.

**Fix, in order of effort:**
1. **Cheapest, do first:** when `resolveFreshRecordingUrl` succeeds, persist that
   URL (or better, download and store the raw audio bytes) somewhere durable —
   not the live Vapi API — so a call is never re-dependent on Vapi's retention
   window after its first successful fetch. A local/R2-backed audio cache keyed
   by call id.
2. **Decide and document:** is a 14-day-expired call permanently excluded from
   the corpus, or does someone need to upgrade the Vapi plan's retention window?
   Either is a legitimate answer, but right now there's no decision recorded and
   no UI signal that a call is on this clock (see the paired UX-fixes doc,
   UX-9).
3. Regardless of (1)/(2): the run-executor should distinguish "no live URL
   because of the 14-day wall" (permanent, provider-independent) from "no live
   URL because of a transient Vapi/network hiccup" (worth retrying) in the
   stored `errorMessage`, so retry logic and the UI don't keep treating this as
   a retryable failure.

---

## FIX-3 (P1): Storage-bucket 403s — already diagnosed, still unfixed, needs an explicit decision

Restating the existing, already-diagnosed finding from `docs/backlog/good-to-have.md`
because it's still live and unresolved: calls whose recording lives in the older
Supabase `archive` bucket (not the R2 `hipaa-recordings` bucket) get back a URL
Vapi never actually signed, and every provider gets an HTTP 403 straight from
`storage.supabase.co`. Confirmed still present live (`cartesia-ink-whisper`: 23
failures, `openai-gpt-4o-transcribe`: 16, matching the known bucket split).

Not something this app can fix from its own code — needs either Vapi support to
resolve the signing bug, or direct read access to that Supabase bucket as a
workaround. Flagging again here because it's ~15% of all current failures and
worth a real decision rather than sitting open indefinitely.

---

## FIX-4 (P1): `activeProviderId` is a setting nothing reads

**What's broken:** the system-settings feature (Providers page, shipped this
week) stores `activeProviderId` and correctly round-trips it through
`GET`/`PATCH /benchmark/settings`. Grepped the entire codebase: **no route, no
run-executor logic, and no other UI page ever reads it.** It is a value the
operator can set and see reflected back, and that is the entire extent of its
effect. (`agentModel`, its sibling setting, *is* fully wired — `routes/agent.ts`
reads it and passes it into `judgeCandidates()` — so this isn't a systemic
pattern, just this one field.)

This is scoped deliberately, not accidentally: the Providers page's own copy
says "a recorded designation... it does not itself reconfigure any live Vapi
assistant" — correct, and the right call (flipping a live assistant's
transcriber is a separate, higher-risk, outward-facing action nobody's asked
for). But right now the designation doesn't feed *anything* in this app either
— not a comparison baseline in Rankings, not a default pre-selection in the
Runs/Bulks launch dialogs, nothing. An operator who sets it has no way to tell
it did anything at all beyond the settings card itself.

**Fix (pick one, both are legitimate scope — not deciding here):**
- (a) Minimal: Rankings shows, per group, "vs. your active provider (Deepgram)"
  and highlights the delta — turns the setting into the actual decision-support
  tool it's named for.
- (b) Minimal: the Runs/Bulks provider-picker pre-checks the active provider by
  default.
- Either is a small, contained change once decided; flagging the decision here
  rather than picking for you, per this project's "don't assume" rule.

---

## FIX-5 (P2): Known, deterministic failure reasons still cost a paid OpenAI call to explain

`analyzeFailure()` is a real, working, on-demand feature — but it calls OpenAI
for every failed cell a human clicks "AI analysis" on, including the ~55% of
current failures (FIX-2 + FIX-3 combined: 40 + 39 of 187) that are **already
fully diagnosed, deterministic, known causes** with fixed, unchanging text.
Paying an LLM call to re-discover "this call exceeds your Vapi retention
window" every time someone clicks the button on one of these is real, avoidable
cost.

**Fix:** before calling `analyzeFailure`, pattern-match `errorMessage` against
the known cases (retention-window text, the Supabase-403 bucket signature) and
return the existing hard-coded diagnosis for free, instantly, no API call.
Fall through to the real AI analysis only for errors that don't match a known
signature — which is also where it's actually earning its cost, since those are
the genuinely novel failures (Deepgram/Gladia's unexplained 400s, once FIX-1
gives them real bodies to look at).

---

## FIX-6 (P2): Two independent, inconsistent "launch a run" code paths

`Runs.tsx`'s own `QueueRunDialog` and the entire `Bulks.tsx` flow both create
and execute `benchmark_runs`, but with materially different capabilities:

| | Runs → Queue Run | Bulks → New bulk |
|---|---|---|
| Call selection | *all* `ready_to_run` calls, unconditionally | assistant / date / duration filters, frozen at launch |
| Cost gate | pre-flight estimate shown, no hard threshold | hard `awaiting_confirmation` gate above a $ threshold |
| Sharding | none — one run, however many calls | configurable shard size |
| Skip-vs-review handling | N/A (only ever selects ready calls) | pulls in non-ready calls too, records them `skipped_pending_review` (FIX at UX layer, see paired doc) |

Both are real, both work, but a new user has no way to know which one to reach
for, and `Queue Run` silently has no assistant-scoping at all — the exact
"should not be divided by vertical" complaint that motivated the Bulks
assistant-picker doesn't apply to this second entry point at all. Today, with
21 ready calls, the blast radius of picking the wrong one is small; it won't
stay small as the ready-to-run pool grows.

**Fix:** not deciding the UX here (see paired doc's corresponding entry) but
flagging the underlying technical duplication — two independent call-selection
and run-creation code paths is real drift risk (a future bug fix applied to one
won't apply to the other, as already nearly happened with the run-status-
formula bug this session). Worth consolidating onto one shared
selection/execution path before adding anything else to either.

---

## Verified NOT broken (re-checked this pass, no regression)

- `computeRankingsForRun`'s "latest run per group" de-dup: confirmed live that
  rankings correctly key off `assistantId` post-migration, no stale
  vertical-keyed rows leaking through after the backfill script.
- The run-status formula bug (attempted-vs-skipped) from earlier this session:
  confirmed the fix holds — all 12 live runs currently read `complete`, no
  mislabeled `failed` runs from zero real attempts.
- `MAX_LIVE_BULKS` eviction (FR-BLK-10): the "max 3 live bulks" header copy and
  the dialog's "4th bulk evicts the oldest" copy are the same fact stated two
  ways, not a contradiction — confirmed against `MAX_LIVE_BULKS = 3` and the
  `existing.length >= MAX_LIVE_BULKS` eviction condition.

## Still open, not re-litigated here (already tracked in `docs/backlog/good-to-have.md`)

Cartesia's intermittent server-side truncation, the lack of a durable
cross-process job queue, no run delete/archive endpoint, confidence-score
extraction, statistical significance on rankings. Nothing new to add to these
this pass — restated in the backlog doc, not duplicated here.
