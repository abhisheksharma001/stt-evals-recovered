# UI/UX PRD v4 — Stop the screen from stating confident falsehoods

**Version:** 1.0
**Date:** 2026-08-28
**Companion doc:** `docs/PRD-v4-technical.md` (same review, technical side —
cross-referenced inline as V4-Tn)
**Scope rule:** this is not a redesign. The v3 redesign shipped and it works. Every
item here either (a) removes a place where the UI asserts something false, or
(b) surfaces a number the system already computes. Nothing here invents a new page.
**Implementer:** written for a Sonnet-class model. Each item names the file, what a
user sees today, what they must see instead, and how to check it.

---

## 0. The headline finding

**The Results page currently tells the CEO that the AI checked 63 calls, found
problems in all 63, judged none of them, and cost $0.00.**

Every part of that sentence is wrong. The AI judged all 63 successfully, spent about
31 cents doing it, and its answers were destroyed by a database write error
(V4-T1). The UI didn't lie on purpose — it faithfully rendered numbers that were
themselves wrong, and it had **no way to express "this number is broken" as distinct
from "this number is zero".**

That is the theme of this whole document. A benchmarking tool's entire value is that
its numbers are trustworthy. A confident `$0.00` is worse than a blank, and a blank
is worse than "not recorded — 63 judge results failed to save".

Everything else here is smaller than that.

---

## 1. Current surface (verified)

| Route | Page file | State |
|---|---|---|
| `/` | `Dashboard.tsx` | Overview |
| `/corpus` | `Corpus.tsx` | Merged Corpus+Listen, expandable rows, provider comparison panel |
| `/runs` | `Runs.tsx` | Individual runs |
| `/bulks` | `Bulks.tsx` | Bulk create / cost gate / progress / retry |
| `/results` | `Rankings.tsx` | Per-bulk + all-time rankings, cost card |
| `/providers` | `Providers.tsx` | Provider config |
| `/sources` | `Import.tsx` | Vapi import |

No dead routes. `/agent` and `/review` are gone and nothing links to them. The v3
findings ("the app never shows a transcript") are closed.

---

## Part A — P0. The screen is currently stating things that are not true.

### U-1 (P0): "Flagged" and "the AI crashed" are rendered as the same thing

**Today.** `Rankings.tsx:338` and `Bulks.tsx:624` render:

> `63 checked · 63 flagged, 0 judged` · **Agent cost $0.00**

**Why it's wrong.** The API's `agentCallsFlagged` counts
`status === "flagged" || status === "error"` (`routes/bulks.ts:260`). In this bulk
*all 63 were errors*. The UI showed the healthiest possible reading of a total
failure.

**Required.**

1. Consume the split counts from V4-T1 (`agentCallsFlagged`, `agentCallsErrored`)
   and render them separately. Never sum them.
2. When `agentCallsErrored > 0`, show a **destructive-toned strip**, not a stat:
   > ⚠ AI verification failed on 63 of 63 calls. Their results were not saved.
   > *(reason)* — this bulk's flag counts are still valid; the AI's opinion is not.
3. When `agentCostCents` is `null` **or** `agentCallsErrored > 0`, render
   **"not recorded"** — never `$0.00`. A zero must only ever mean a measured zero.
4. When `agentCallsJudged < agentCallsFlagged` with no errors, say so plainly
   ("12 of 40 judged — the rest are still running") rather than showing two numbers
   and leaving the reader to subtract.

**Check:** force one scan to error, reload `/results` — the strip appears, cost reads
"not recorded", and the ranking table is visibly unaffected (the flags are still
real; only the LLM opinion is missing).

### U-2 (P0): "45 cells failed" reads as "the tool is broken" when 93% of it is a known, unfixable, external cause

**Today.** `Bulks.tsx:658` renders a bare `["Cells failed", 45]`, and offers a
**"Retry failed cells"** button (`Bulks.tsx:707`) directly underneath.

**Why it's wrong, twice.** First, the 45 are three unrelated causes (V4-T3): a
Cartesia timeout (fixed), Vapi's 14-day retention having permanently deleted the
audio (unfixable by anyone), and a Supabase bucket 403 (unfixable from this app).
Second — and worse — **the retry button invites the user to spend money retrying
failures that can never succeed.** Retrying a retention-expired call is guaranteed
to fail and guaranteed to cost time.

**Required.** Once `failureClass` exists (V4-T3), replace the single number with a
grouped breakdown, ordered by what the user can act on:

```
45 cells failed
  ├─ 42  Recording no longer exists (Vapi's 14-day window)   — cannot be retried
  ├─  2  Recording URL rejected by storage (403)             — cannot be retried
  └─  1  Provider timed out                                  — retry will likely fix
                                                    [ Retry 1 retryable cell ]
```

- The retry button's label carries the **retryable** count, not the total.
- The button is **disabled** when the retryable count is zero, with the reason on
  hover — not hidden (hiding a control teaches nothing).
- Each class gets one plain-English line. No error strings in the primary view; keep
  raw messages behind a disclosure.

**Check:** the last bulk (`7d2585da`) renders 42/2/1 with a button reading
"Retry 1 retryable cell". Cross-check the totals against the API.

### U-3 (P0): A stale backend is invisible

**Today.** Nothing on screen indicates which build is serving. The running process
has been four commits behind all evening — including a fix the user was told had
shipped — and there was no way to see it without `ps`.

**Required.** Footer in `layout.tsx`, quiet and monospaced:
`build 7313012 · started 22:40`, from the extended `/api/healthz` (V4-T2). Turn
**amber** when the tab has been open long enough that `startedAt` predates the
newest known build, if that's cheap; otherwise just show it. **Never** show a
key, a partial key, or a provider secret here — provider *names* only.

**Check:** rebuild + restart, reload — the SHA changes.

---

## Part B — P1. Make the verdict explain itself.

### U-4: "Why is this ranked first?" needs an answer on the page, not in a tooltip

**Today.** The Rank column header has a tooltip (shipped this session), and the row
shows Avg Flags plus a smaller "peer: X" line. That fixed the immediate confusion —
a provider with *more* displayed flags outranking one with fewer — but only for
someone who reads tooltips and already knows what "peer" means.

**Why it still matters.** This is the number the recommendation rests on. If the CEO
asks "why Deepgram?", the answer must be on screen in one click, in words.

**Required.** Clicking a rank cell opens a small panel showing the composite for
*that row*, with its own real numbers and one plain sentence each:

```
Rank score for Deepgram Nova-3 — this bulk

  Peer flags (what Rank sorts by)      0.84   ← disagreements with other providers
                                              + entity mismatches. Fair across all
                                              providers.
  Confidence-inclusive flags            2.10   ← also counts a provider doubting
                                              itself. Only 3 of 6 providers report
                                              confidence, so this is NOT comparable
                                              across all of them — shown for context.
  Median latency                       1.4 s
  Cost per minute                    $0.0043

  → Ranked 1st of 5 on peer flags.
```

The sentence "only 3 of 6 providers report confidence at all" is the single most
important piece of context in the whole ranking and currently appears nowhere.

### U-5: The bulk selection note must lead with what was excluded

**Today.** `resolveCriteriaCallIds` now excludes retention-expired uncached calls and
writes it into the bulk's multi-line `notes` (rendered with `whitespace-pre-line`).
Correct, but it's a paragraph in a details pane.

**Required.** In the create-bulk dialog, **before** the cost gate:
> Selecting 72 calls. **12 skipped** — older than Vapi's 14-day recording window and
> not already cached, so their audio no longer exists.

Placement matters: a user who reads "72 of 84" *after* launching learns it too late
to choose differently.

### U-6: Surface the judge's reasoning where the transcripts are

`ProviderComparisonPanel` (`Corpus.tsx`) already shows every provider's transcript,
the winner callout, and low-confidence chips, and correctly withholds the trophy when
`agentPickProviderId` is null. Once V4-T1 lands there will be real reasoning to show.

**Required.** Under the winner callout: the judge's reasoning paragraph, the model
name, and the cost of *that* judgement. Keep the existing rule absolutely intact —
**the trophy renders only when there is a genuine AI pick**; a fewest-flags fallback
must never be dressed as an AI decision. That guard already caught one live bug; do
not weaken it.

### U-7: Provider coverage on the Providers page

With ElevenLabs keyed, six of seven adapters have keys and Speechmatics has none.
Nothing on `/providers` distinguishes *adapter exists* / *key configured* /
*proven live in a real run*.

**Required.** Three-state badge per provider: `no key` · `configured, never run` ·
`live · last ok <date>`. Sourced from `providersConfigured` in `/api/healthz`
(V4-T2) plus the most recent `ok` result row. **Names only — never any part of a
key.**

---

## Part B-2 — Added 2026-08-28: selection, comparison, verdict, memory

Five items from Abhishek's second pass. Each maps to a technical item in
`PRD-v4-technical.md` and adds nothing the backend won't already have.

### U-11 (P1): Show the size of the corpus a filter will actually produce, before launch

**Why.** The new 60–120 second duration band (V4-T10) is the right *quality* of call
and a small *quantity* of them: measured against 100 recent live calls, only **11
fall in that band** — 42 are under 20 seconds. A user who sets the band expecting 70
calls and gets 9 will assume the tool is broken.

**Required.** In the create-bulk dialog, above the cost gate, a live count that
updates as filters change:

```
Duration 60–120s · last 14 days · outcome: completed or forwarded
   → 11 calls match     (of 84 in range)
     42 excluded: shorter than 60s
      9 excluded: no speech (voicemail, silence, misdial)
     22 excluded: longer than 120s
```

Every excluded bucket is named and counted. Nothing is silently dropped. **The count
appears before the cost estimate**, because it is the number that makes the cost
estimate mean anything.

### U-12 (P0): One sentence at the top that states the verdict

**Why.** The whole tool exists to answer one question, and the answer is currently
something the reader has to assemble from a table.

**Required.** Above the rankings table, from the V4-T14 headline object:

> **Deepgram Nova-3 is the best fit for this bulk.**
> 1.4 flags per 100 words — **38% cleaner** than the runner-up (AssemblyAI), and
> **22% cleaner** than the provider running in production today.
> Based on **72 calls**. 3 of 6 providers report confidence, so the
> confidence-inclusive column is not comparable across all of them.

Rules, all of them load-bearing:

- **Never a margin without its evidence count.** They render in the same sentence or
  neither renders. A 38% margin over 4 calls must read as provisional, and the page
  should say so outright below ~20 calls.
- **Percentages, not raw averages**, as the primary number. "0.84" needs a
  denominator the reader doesn't have; "1.4 per 100 words, 38% cleaner" does not.
- **Direction in words.** "cleaner", "worse", "the same within noise" — not a signed
  delta the reader has to interpret.
- When the top two are within the noise floor, say **"too close to call on this
  evidence"** and name what would settle it (more calls). A benchmark that refuses to
  pick a winner it can't justify is more trustworthy than one that always picks.

### U-13 (P1): Per-call comparison — what differs, and why one is best

**Why.** Abhishek's ask: for each call, see every provider's output, what the
differences actually are, and why the chosen one is right — so the verdict can be
trusted rather than taken on faith.

**Today.** `ProviderComparisonPanel` in `Corpus.tsx` shows each provider's transcript
side by side with low-confidence chips and a winner callout. Good foundation, missing
the reasoning layer.

**Required, inside the existing panel:**

1. **The disagreements, extracted.** Not six transcripts to read in full — a compact
   list of the spans where providers actually differ, each showing what each provider
   heard:
   ```
   "…ending in three six six eight"
     AssemblyAI  3668        Deepgram  3668
     Gladia      36 68  ⚠ 0% confidence
     Cartesia    thirty-six sixty-eight
   ```
   Agreement is not interesting; disagreement is the entire signal. Show the diffs,
   collapse the rest.
2. **The judge's reasoning**, its model, and that judgement's cost (available once
   V4-T1 lands).
3. **A per-call outcome chip** from V4-T11 — `forwarded to human`, `caller hung up`,
   `voicemail`. On a forwarded call, say so prominently: the assistant gave up on
   this call, which makes it one of the more informative calls in the set.
4. **The existing trophy rule stays exactly as it is** — the AI-pick badge renders
   only for a genuine pick, never for a fewest-flags fallback. That guard already
   caught one live mislabelling bug.

### U-14 (P2): The memory view — what each provider keeps getting wrong

**Why.** V4-T15 builds a failure-pattern graph. It is worthless if nobody can look
at it.

**Required.** A section (on Results, not a new page) with two readings of the same
data:

- **Per provider:** "Cartesia has been flagged on phone numbers in 14 of 62 calls
  (23%)" — every claim carrying its observation count and linking to the calls behind
  it.
- **The graph itself:** nodes for providers, entity types and recurring phrases;
  edges weighted by how often the pattern recurs. Clicking a node filters the list
  below it. Render it on **Canvas**, not hand-authored SVG, and make sure the list
  view is complete on its own — the graph is a way in, never the only way to the
  information.

**The hard rule, from V4-T17.** Memory claims are **evidence, never a verdict**. The
UI may never show a memory-derived statement next to a score in a way that implies it
adjusted the score, because it did not and must not. Keep them visually separate and
label the section for what it is: *observed history*, not *this bulk's result*.

### U-15 (P2): Agent progress should look parallel, because it now is

Once V4-T13 lands, the agent pass runs several calls at once. The current UI shows a
single blocking phase with no detail. Show `n / total verified · k in flight`, and
keep it visibly distinct from the STT phase — they cost different money to different
vendors, and conflating them is what made the $0.00 bug (U-1) hard to spot.


---

## Part C — P2. Polish, once the truthfulness items are done.

- **U-8: Empty and error states.** Every table needs three distinguishable states:
  loading, genuinely empty ("no bulks yet — create one"), and failed to load
  (with a retry). Several currently collapse empty and failed into one blank.
- **U-9: One-screen verdict view.** A print-friendly `/results` mode: the winner,
  the evidence count, the cost delta vs. what's in production today, the confidence
  caveat, and the build SHA. This is the artefact that gets shown in a meeting; it
  should not require live-driving the app.
- **U-10: Consistent cost formatting.** Once micro-cents land (V4-T4), one
  `formatCost()` helper used everywhere. Sub-cent values render as `$0.0049`, never
  rounded to `$0.00`.

---

## Non-goals

- No new pages. Seven routes is the right number.
- No visual restyle. The v3 layout is good; this is about what it *says*.
- No change to the ranking maths — that is v3's territory (`PRD-v3-technical.md`).
  If the peer-flag composite is wrong, fix it there, not by re-labelling it here.

---

## Verification

- Every item above is checkable against bulk `7d2585da` (72 calls, 315/360 ok,
  45 failed, 63 errored scans). It is a good adversarial fixture precisely because
  it is not a clean run — use it, not a happy path.
- `pnpm run typecheck` clean at repo root.
- The frontend dev server needs `API_PROXY_TARGET=http://localhost:8177` set, or
  `/api/*` silently returns the SPA HTML shell and pages crash with confusing type
  errors instead of a network error. This has bitten twice.
