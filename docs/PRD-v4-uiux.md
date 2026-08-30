# UI/UX PRD v4 — Stop the screen from stating confident falsehoods

> **2026-08-30:** Part E added (hierarchy, warm light theme, overview rewrite, per-call provider comparison, missing outputs) — five asks from Abhishek after T-32. Register rows T-70–T-74.

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

## Non-goals — **partially superseded 2026-08-28, see Part D**

The first three parts of this document deliberately avoided redesign, on the
grounds that a working app should not be rebuilt while it is still telling lies.
That still holds for Parts A–C: **do those first, they need no redesign at all.**

Abhishek then asked explicitly for a rethink of the design and for the tool to go
past market standard. **Part D is that rethink**, and it overrides the first two
bullets below. The third bullet stands unchanged.

- ~~No new pages. Seven routes is the right number.~~ → Part D argues for four.
- ~~No visual restyle.~~ → Part D, section D.5.
- **No change to the ranking maths** — that is v3's territory
  (`PRD-v3-technical.md`). If the peer-flag composite is wrong, fix it there, not
  by re-labelling it here. This is still true and still not negotiable.

---

# Part D — The rethink: past market standard

Added 2026-08-28, at Abhishek's explicit request. Parts A–C fix what the app says.
This part questions what the app *is*.

## D.0 The honest read of what exists today

The current UI is a competent shadcn/Radix + Tailwind admin dashboard: a left
sidebar, seven routes, cards, tables, dialogs. It is clean, it is consistent, and it
works.

It is also **exactly what every internal tool built in the last three years looks
like.** That is the definition of market standard, not a criticism of the execution —
the execution is good. But "beyond market standard" cannot be reached by tightening
this. It requires questioning the shape.

## D.1 The one structural problem

**The navigation mirrors the database schema, not the user's question.**

Corpus, Runs, Bulks, Results, Providers, Sources are the *tables*. A person opens
this tool with exactly one question:

> *Which speech-to-text provider should we use for this client?*

and the app answers it by making them assemble the answer out of six screens. The
Results page — the only page that contains the answer — is fifth in the sidebar, and
opens on a picker rather than on a verdict.

Every move below follows from inverting that.

## D.2 What to keep — explicitly

A rethink that discards working work is just churn. These stay:

- **The provider comparison panel.** It is the best thing in the app and the hardest
  part to have got right. It gets *more* prominent, not replaced.
- **The bulk cost gate.** A confirmation step before spending real money is correct
  and rare. Keep it exactly as it is.
- **The trophy guard** — the AI-pick badge rendering only for a genuine pick. That
  rule caught a live bug. It is a principle, not a detail.
- **Radix + Tailwind.** The component layer is fine. D.5 changes the *tokens*, not
  the toolkit. Do not migrate component libraries; that is pure cost.

## D.3 Five moves that actually go past standard

### D.3.1 Open on the answer, not on a dashboard

**Standard:** land on a dashboard of counts — calls imported, runs completed, cells
ok. Numbers about the *tool's activity*, not about the *decision*.

**Beyond:** the landing page is the verdict, per client, in a sentence a
non-technical person can read aloud:

```
Land & Apartment  ·  72 calls  ·  last checked 27 Aug

    Use Deepgram Nova-3.

    1.4 flags per 100 words — 38% cleaner than the runner-up,
    22% cleaner than what's running in production today.
    Switching costs $0.0011/min more: about $18/month at your volume.

    [ see the evidence ]   [ share this verdict ]
```

Counts still exist — one line beneath, not the headline. **The tool's job is to end
an argument, and it should lead with the thing that ends it.**

### D.3.2 Audio-anchored evidence — the actual differentiator

This is the move no comparable tool makes, and this codebase is unusually ready for it.

**Standard:** show transcripts side by side. The reader compares six blocks of text
and takes the winner on faith.

**Beyond:** *a disagreement is a play button.* Where providers disagree, show the
span and let the reader hear those three seconds and decide for themselves:

```
  ▸ 0:47   "…ending in three six six eight"
           AssemblyAI  3668              Deepgram  3668
           Gladia      36 68   ⚠ 0%      Cartesia  thirty-six sixty-eight
```

Click the timestamp, hear 0:45–0:50, done in two seconds. No scrubbing, no reading.

**Why this is buildable now, not someday:** the audio is already cached on disk
permanently (`audio-cache/`), and most providers already return **word-level
timings** — the same data the confidence spans are built from. The pieces exist and
are currently used only for flagging. This is assembly, not research.

**Why it matters more than it sounds:** every other number in this tool is a claim
that the reader must trust. This is the one place where the reader can *verify*
without trusting anything. A benchmark whose evidence you can check with your own
ears is categorically more credible than one you can only read.

### D.3.3 Show the uncertainty, don't hide it

**Standard:** a leaderboard. Confident numbers, ranked, no error bars. It looks
authoritative and it is sometimes wrong.

**Beyond:** the noise floor is drawn. When two providers are within it, the page says
so and refuses to pick:

```
  Deepgram    ▇▇▇▇▇▇▇▇▇▇▇▇▏  1.4  ├──┤
  AssemblyAI  ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▏1.9  ├───┤
  Gladia      ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▏2.0  ├─────┤   ← overlaps AssemblyAI

  Deepgram wins clearly. 2nd place is too close to call on 72 calls.
```

Evidence count sits next to every claim. Below ~20 calls the whole verdict renders as
provisional, with the number of calls that would settle it. **A tool that admits what
it doesn't know is trusted more, not less** — and this one is being used to spend a
client's money.

### D.3.4 Trend, because these are monthly checks

Bulks are named "monthly check". There is no view of change over time, so the tool
answers "who is best today" and never "who is getting worse for us".

**Beyond:** a per-client sparkline strip — flags per 100 words, per provider, per
bulk, over time. A provider that regressed 30% since last month is a more urgent
finding than one that is 2% better today, and right now that finding is invisible.
`recharts` is already installed.

### D.3.5 Cost as a decision axis, not a footnote

**Standard:** a cost column in a table.

**Beyond:** the switch decision, in money, at this client's actual volume: *"Deepgram
is 38% cleaner and $0.0011/min more — about $18/month at your call volume."* That is
the sentence someone repeats in a meeting. A per-minute rate is not.

## D.4 Navigation: seven routes → four

Reshaped around what a person is doing, not which table they are reading:

| New | Absorbs | The question it answers |
|---|---|---|
| **Verdict** (`/`) | Results, Dashboard | *Which provider, and why?* |
| **Evidence** (`/evidence`) | Corpus | *Show me the calls and let me hear them* |
| **Work** (`/work`) | Runs + Bulks | *What has run, what is running, what did it cost?* |
| **Setup** (`/setup`) | Providers + Sources | *Keys, accounts, imports* |

**Runs and Bulks are one concept at two zoom levels** — a bulk *is* a group of runs.
Two sidebar entries for that is schema leaking into navigation. Merge, with bulks as
the default grouping and individual runs expandable inside.

**Do this last** (D.7). It is the highest-risk item here and the lowest-value one
until the content underneath is right.

## D.5 The visual system

Not a restyle for its own sake — four specific changes, each with a reason:

1. **Density.** Default shadcn spacing is tuned for comfortable reading. This is a
   tool for *scanning* tables of numbers. Tighten row height and vertical rhythm on
   data tables specifically; leave prose and dialogs alone.
2. **Tabular numerals everywhere digits align.** `font-variant-numeric: tabular-nums`
   on every metric cell. Without it, columns of numbers do not line up and cannot be
   compared by eye — which is the single most common thing anyone does on this page.
3. **Semantic colour separate from accent colour.** Good / caution / critical must
   be their own scale, not tints of the brand hue. Severity is information here, and
   it currently competes with decoration.
4. **Stop wrapping everything in a card.** When every block is a card, no block is
   emphasised. Reserve elevation for the one thing that matters on each screen — the
   verdict, the failure warning — and let the rest sit flat on the ground.

Type: one characterful face for headings and metrics, one workhorse for body, one
mono for data and identifiers. The current stack is the framework default; choosing
deliberately costs nothing and reads as considered.

## D.6 The shareable verdict

The CEO does not need the app. They need one screen, and today the only way to give
it to them is a screenshot.

**Required:** a read-only verdict view, print-clean, carrying the winner, the margin,
the evidence count, the cost delta, the confidence caveat, and the build SHA and date
it was produced. Not a live dashboard — **a dated artefact you can attach to an
email**, that still says something true when read a month later.

## D.7 How to do this without breaking a working app

The risk here is real: a big-bang redesign of the only working tool the team has, in
the same window as five behavioural changes. Sequence it so nothing is ever half-done:

| Step | Contents | Risk |
|---|---|---|
| **1** | Parts A–C (truthfulness). No redesign at all. | None — these are strictly corrections |
| **2** | D.5 visual tokens: density, tabular numerals, semantic colour, less card-soup | Low — token-level, reversible |
| **3** | D.3.1 verdict headline + D.3.3 uncertainty, added **on top of** the existing Results page | Low — additive; the table stays |
| **4** | D.3.2 audio-anchored evidence inside the existing comparison panel | Medium — the highest-value item here |
| **5** | D.3.4 trend + D.3.5 cost framing | Low |
| **6** | D.4 navigation merge | **Highest.** Do it only once 1–5 have proven out |
| **7** | D.6 shareable verdict | Low |

**Steps 3 and 4 are where the value is.** If time runs out, do those two and stop —
they change what the tool *is* without touching what it *is built from*.

## D.8 What "beyond market standard" does not mean

Worth writing down, because it is the easy way to waste the effort:

- **Not more animation.** Motion on a data tool is noise. The one place it earns its
  place is audio playback position.
- **Not an AI chat box.** The system already has an LLM doing the one job an LLM is
  good for here. A chat interface bolted on top would be a worse way to reach answers
  the page can state directly.
- **Not more charts.** One well-chosen chart beats six. The bar-with-noise-floor
  (D.3.3) and the trend sparkline (D.3.4) are the two that carry information; anything
  beyond those needs to justify itself.
- **Not a dark-mode toggle as a feature.** Support the viewer's preference properly
  and say nothing about it.

**The bar is this:** someone who evaluates speech-to-text providers for a living
opens this tool and sees a claim they would normally have to build a spreadsheet to
verify — and then finds they can check it, by ear, in two clicks. Nothing on the
market does that. Everything else in this part is in service of that sentence.


---

# Part E — Added 2026-08-30, per Abhishek: hierarchy, warm light theme, overview, comparison, missing outputs

Five asks, given in one message after T-32 shipped, recorded verbatim in intent so
none of them lives only in chat. Each maps to one register row (T-70 … T-74). The
earlier plan file "Fold agent into bulk + redesign Results + merge Corpus/Listen"
(2026-08-29) is absorbed here: its Workstream A (auto agent judge in bulks, Agent page
removed) and the Listen removal already shipped; what remains of it is folded into E.1
and E.4 below so it does not exist in two places.

**State verified 2026-08-30 before writing this:** sidebar has seven entries —
Overview `/`, Corpus `/corpus`, Runs `/runs`, Bulks `/bulks`, Results `/results`,
Providers `/providers`, Call sources `/sources`. Theme is a single dark warm-clay
surface (`index.css` `:root`, `--background: 30 21% 7%`), with an unused `.dark`
block. Overview (`Dashboard.tsx`, 254 lines) still renders the pre-bulk layout:
corpus-by-vertical, providers, recent runs — nothing about bulks, verdicts, judge
accuracy, or what needs a human.

## E.1 View hierarchy — every page answers one question, top to bottom (T-74)

"Fix all the view hierarchy, in the current one, and on the PRD which we need to do."

Two layers, done in this order:

1. **Inside each existing page** (low risk, no route changes): the order of sections
   is the order of the reader's questions. Rule: *answer → evidence → controls →
   raw table*. Concretely —
   - Results: verdict banner → cost line → judge-accuracy → correlation → group
     cards. (Today judge-accuracy sits above the bulk picker; a reader meets a
     trust metric before they know which bulk it is about.)
   - Bulks: the running/most recent bulk's status and cost first; creation form and
     templates below, collapsed when a bulk is running.
   - Corpus: what needs a human (unreviewed, hard cases, adjudication queue) first;
     full table second.
   - Providers: configured-and-live first, unconfigured second; the active-provider
     setting next to the list it affects, not in a separate settings block.
2. **Across pages** — D.4's seven → four merge (Verdict, Evidence, Work, Setup).
   This is T-31, previously gated on "phases 1–3 proven". Abhishek un-gated it
   2026-08-30. It is still done **last** in this Part, after E.2–E.5, because the
   content underneath must be right before the doors are moved.

**Open decision (Abhishek):** do layer 2 as the full D.4 merge, or stop at layer 1
and keep seven routes? Default if unanswered: layer 1 only, layer 2 stays T-31.

## E.2 Theme — warm light (T-70)

"Change the whole theme to light warm colour."

Replace the single dark clay surface with a single **light, warm** one: cream/sand
ground, warm near-black ink, warm greys with a hue bias toward the accent (never a
pure mid-grey), one accent kept from today's coral or shifted to a deeper terracotta
that holds contrast on cream; jade for good and rose for wrong stay but are re-tuned
for a light ground (D.5's rule: semantic colour is not the accent). Token-level only
— change `:root` in `index.css`, nothing per-component. Tabular numerals and density
rules from D.5 unchanged.

Constraints: every text/ground pair ≥ 4.5:1 (WCAG AA) — check the muted-foreground
and the chips especially, those are what usually fail on cream. The T-32 verdict
artefact already renders light; make the app and the artefact agree on the palette so
a screenshot of one is not visibly a different product from the other.

**Open decision (Abhishek):** keep a dark mode behind a toggle, or drop it? Default
if unanswered: drop it — one surface, as D.5 argued, just light instead of dark.

## E.3 Overview page — drop the old stuff, show what matters now (T-71)

"The overview page still has all the old stuff."

Rewrite `Dashboard.tsx` around four blocks, in this order:
1. **Latest verdict** — the newest completed bulk's headline sentence and decision
   chip (from `GET /benchmark/bulks/{id}/verdicts`, the same source as Results),
   with a link to Results and to its T-32 artefact. "No bulk has completed yet" when
   none has; never blank.
2. **What needs a human** — counts with links: calls awaiting review, hard cases,
   disagreement spans not yet adjudicated (T-67's gap made visible), failed cells
   that are retryable.
3. **Running now** — any bulk in `running`, with its progress counts and estimated
   vs actual cost so far; hidden when nothing is running.
4. **This month** — STT spend and agent spend, separately (the standing rule from
   2026-08-27), plus build SHA / provider health from `/api/healthz`.

Removed: corpus-by-vertical chart, provider list, recent-runs list — they belong to
Corpus, Providers and Bulks respectively and are reachable in one click.

## E.4 Per-call provider comparison — one section, gold on top, every provider under it (T-72)

"The comparison of all the provider output in a particular section, and also putting
the main transcript there as well."

One section, reachable from Corpus (per call) and from a Results group card (per
call in that group), showing for one call:

- **Top: the reference transcript.** Gold (human-corrected) when the call is
  reviewed; otherwise the Vapi draft, **labelled as draft, never as gold** (the
  project's standing rule — the draft is Vapi's own live provider and must not read
  as the standard). Audio player anchored to it.
- **Below: every provider's output for that call**, one row each, word-diff against
  the reference (the existing diff view reused, not rewritten), with the cell's
  metrics (WER, peer flags, latency, cost) on the row and the agent judge's pick
  marked if a scan exists.
- Providers ordered by the bulk's verdict rate when in a bulk context, alphabetically
  otherwise.

This subsumes the old plan's "merge Corpus + Listen" intent: the comparison section
*is* the listen surface.

**Open decision (Abhishek):** when a call has a gold transcript, show the Vapi draft
as well (as one more row, marked "production / draft")? Default if unanswered: yes,
as a row, so the production baseline is always visible next to the candidates.

## E.5 Show what we did not get (T-73)

"Also showing what we didn't get from what provider, if something fails."

In the E.4 section and in every per-call/provider grid (Runs cell view, Bulks
failure groups), a provider with no output for a call renders an explicit row:
**"<Provider>: no output — <failure class in plain words>"**, with the T-41 known
diagnosis when there is one, the retryable/permanent state from T-43, and a retry
action when retryable. Never an empty cell, never a missing row, never a dash. The
count of missing outputs per provider is shown at the section header ("Cartesia:
3 of 22 calls missing") so a provider that fails often is visible before you scroll.

Depends on T-69 (T-40 backfill) having run on the live DB, otherwise every legacy
failure shows as "unknown / permanent".

## E.6 Order and risk

| Step | Item | Risk | Why this position |
|---|---|---|---|
| 1 | E.2 warm light theme (T-70) | Low — tokens only | Reversible in one file; everything after is seen in the final palette |
| 2 | E.3 overview rewrite (T-71) | Low — one page, read-only | No shared components change |
| 3 | E.4 + E.5 comparison section with missing outputs (T-72, T-73) | Medium | New surface, reuses diff view; the highest-value item here |
| 4 | E.1 layer 1, in-page ordering (T-74) | Low | Moves sections, no logic |
| 5 | E.1 layer 2 = D.4 nav merge (T-31) | **Highest** | Only after 1–4 are live and used |

Each step is one register row, one PR, one deploy, per the loop. Big rewrites (E.3,
E.4, T-31) go through a worktree per the project rule.

## E.7 Vocabulary for the Part E work — which terms apply here, and how

Abhishek supplied a glossary (2026-08-30) and asked which of it this project needs.
Checked against the actual codebase (React + wouter + Tailwind v4 tokens in
`index.css`, shadcn/ui primitives in `components/ui/`, Radix for dialogs/dropdowns).

| Term | Needed? | Where it bites in this project |
|---|---|---|
| **View hierarchy / component tree** | Yes — core of E.1 | `Rankings.tsx` (38 KB) and `Bulks.tsx` (55 KB) are single files where page, sections and rows are one flat function. E.1 layer 1 = re-nesting them: page → section → card → row. |
| **Nesting / parent-child** | Yes | Same as above. Rule for the agent: a section never renders a sibling's data; if a row needs the bulk id, it gets it from its parent, not a second fetch. |
| **Information architecture (IA)** | Yes — E.1 layer 2 / D.4 | The seven → four route merge *is* the IA decision. Decided and shipped as T-31 (batch 1, PR #49): Overview, Results, Calls, Bulks, Setup. |
| **Atomic design** | Partly | shadcn primitives already are the atoms (`Button`, `Card`, `Badge`). Missing layer is **molecules/organisms**: `DecisionChip`, `GroupVerdictHeadline`, `MonthlyCostCell` exist; the "provider output row with diff + metrics + failure state" (E.4/E.5) must be built as one organism used by Corpus, Results and Runs — not three copies. |
| **Stacking context / z-index / overlay** | Only as a check | Radix handles modals/popovers. One known risk: the sticky table header in Corpus vs. the `DisagreementSpans` list (was `SpanAdjudicator`, T-86). Verify after T-70, no new work. |
| **Elevation** | No | Single light surface (E.2); depth comes from borders and ground tint, not shadows. |
| **Visual hierarchy / contrast / scale** | Yes — E.2 + E.1 | Answer → evidence → controls → table is a *visual* order too: headline 20 px, evidence 13 px mono, table 13 px. Contrast ≥ 4.5:1 is T-70's acceptance. |
| **Proximity** | Yes | The active-provider setting sits away from the provider list it affects (E.1 Providers item). Cost estimate sits away from the launch button in Bulks. |
| **Repetition** | Yes | Same chip, same evidence line, same "no output — reason" row everywhere (E.5). |
| **Design tokens** | Yes — T-70 is *only* tokens | Every colour lives in `index.css` `:root` as `--background`, `--primary`, … consumed via Tailwind `bg-background`. Rule: no hex/hsl literal in a `.tsx` file. `grep -rn "hsl(\|#[0-9a-f]\{6\}" src/pages src/components` must return nothing after T-70. |
| **Container / wrapper** | Yes | Page shell in `layout.tsx` sets max width and padding once; pages must not set their own. |
| **Breakpoint** | Minimal | Desktop tool. **Correction 2026-08-30 (audit E.8):** there is no sidebar breakpoint — `layout.tsx:206` is a fixed `w-[232px]`, and no `lg:`/`md:` class touches it. Pages use `sm:` 48×, `md:` 23×, `lg:` 7× for grids only. Add one breakpoint (sidebar → icon rail < 1024 px) in T-74; tables get `overflow-x: auto`; nothing else responsive. |

**How the agent should use this vocabulary in the loop:** each Part E PR names,
in its description, which of these it touches — "tokens only" (T-70), "organism:
ProviderOutputRow, used in 3 places" (T-72/73), "re-nesting Results into
page → section → card" (T-74). A PR that changes tokens *and* nesting is two PRs.

## E.8 Audit against the vocabulary — what the code actually shows (2026-08-30)

Grep-and-read pass over `artifacts/stt-benchmark/src`, so Part E starts from
measured facts, not impressions. Each finding names the term it belongs to and the
register row that fixes it.

### Hierarchy / nesting (E.1, T-74)

| File | Lines | Functions | Finding |
|---|---|---|---|
| `pages/Bulks.tsx` | 1,301 | 17 | Create form, template table, detail dialog, failure groups, launch confirm, all in one file. **17 data hooks** at page level — every child re-renders on any fetch. |
| `pages/Corpus.tsx` | 878 | 11 | Table + adjudicator + details dialog + agent-scan panel in one file. |
| `pages/Rankings.tsx` | 724 | 9 | **11 data hooks.** Section order today: title → `JudgeAccuracyCard` (`:352`) → view toggle + bulk picker (`:362`) → verdict banner (`:409`) → cost card → correlation (`:469`) → client cost line (`:479`) → group cards. The trust metric comes *before* the reader knows which bulk it is about; the answer (banner) is fourth. Target order: picker → banner → cost → correlation → judge accuracy → cards. |
| `pages/Runs.tsx` | 592 | 7 | Owns `WordDiffView` (`:206`) and the failure panel (`:305–:344`) that E.4/E.5 need everywhere — they must move to `components/` as organisms. |
| `pages/Providers.tsx` | 419 | 5 | "System settings" card with the active-provider `Select` (`:219–:229`) is a separate card *below* the provider list it acts on — proximity fault. |

Every page sets its own top-level rhythm (`space-y-6` ×5, `space-y-4` Rankings,
`space-y-0.5` Bulks) — the wrapper in `layout.tsx:264` (`max-w-[1400px] p-7`) is the
only shared container, and pages disagree with each other below it. T-74 sets one
page-section gap token and removes the per-page values.

### Design tokens (E.2, T-70)

- Token set in `index.css:85–180`: ground/ink/border, card, sidebar (8 tokens),
  popover, primary, secondary, muted, accent, destructive, input/ring, **success,
  warning**, 8 `--entity-*` colours (de-identification highlights), 5 `--chart-*`,
  fonts, radius, 3 shadows. Good base — T-70 changes values, not names.
- `.dark {}` at `index.css:180` is an empty `color-scheme` stub. Delete in T-70 unless
  the toggle is kept.
- **Literal palette classes outside `components/ui/` (must be zero after T-70):**
  `judge-accuracy-card.tsx:129,131` (`emerald-500/15`, `red-500/15`, with `dark:`
  variants that will never fire) → `bg-success/15 text-success`, `bg-destructive/15`.
  `Bulks.tsx:207` (`text-amber-700 dark:text-amber-400`) → `text-warning`.
- **Inline `hsl(...)` in TSX:** `trend-strip.tsx:29,31,121,123,127` and
  `provider-correlation-card.tsx:101` — all go through `var(--…)` except
  `trend-strip.tsx:31`, which generates `hsl(${index*67} 45% 55%)` per provider at
  runtime. On a cream ground that saturation/lightness will fail contrast; T-70 maps
  provider series to the 5 `--chart-*` tokens instead.
- **Copied input styling:** `Import.tsx:34`, `Corpus.tsx:671`, `Corpus.tsx:859` each
  paste the full `<Input>` class string instead of using the `Input` atom. Fix in
  T-74 (atomic design: use the atom).

### Elevation / stacking (no task — verify only)

- `shadow-*` outside `ui/`: `Dashboard.tsx:35` (custom ring on the "current" step),
  `Rankings.tsx:530` (`shadow-sm` on the group card), `trend-strip.tsx:132`
  (tooltip). All others are inside shadcn primitives (43 uses). On a light ground
  E.2 keeps `--shadow-sm` for popovers/tooltips only; cards use border + tint.
- No hand-written `z-index`, `sticky`, or `fixed` anywhere outside `ui/`. Stacking is
  entirely Radix-managed. The Corpus-header/adjudicator risk named in E.7 does not
  exist as code today (`SpanAdjudicator` is inline at `Corpus.tsx:548`, not a
  popover) — remove that worry.

### Repetition / organisms (E.4, E.5 — T-72, T-73)

- One word-diff renderer: `Runs.tsx:206 WordDiffView` (+ its gold-free sibling at
  `:240`). Used in exactly one place (`:474`). T-72 lifts it to
  `components/provider-output-row.tsx` and uses it from Corpus, Results, Runs.
- Failure text is rendered four different ways: `Runs.tsx:461` ("Diagnosis
  available" **or raw error or `—`** — the dash E.5 forbids), `Runs.tsx:305–344`
  (diagnosis panel), `Bulks.tsx:857` (`FAILURE_CLASS_COPY` per failure group — the
  only class-driven one), `Corpus.tsx:380` (agent-scan error). T-73 makes
  `FAILURE_CLASS_COPY` the single source (move to `components/`) and the row
  organism the single renderer.

### Proximity (E.1, T-74)

- Providers: active-provider setting in a second card below the list (above).
- Bulks: cost estimate is shown in the detail dialog header (`:952–:956`) and the
  "Confirm & launch" button at `:1078`, ~120 lines and one scroll apart in the same
  dialog; the over-threshold guard (`:591–:594`) fires as a toast, elsewhere again.
  T-74 puts estimate, threshold state and the button in one row.

### Breakpoints

- Sidebar is a fixed `w-[232px]` (`layout.tsx:206`); the app shell is
  `h-screen overflow-hidden` (`:261`). Below ~1100 px content is clipped, not
  reflowed. One breakpoint (icon rail < 1024 px) in T-74; no mobile layout — this
  is a desktop tool.

### Not found (good)

- No hex colours in any `.tsx`. No `!important`. No inline `style={{ color }}`
  except the token-driven `provider-correlation-card.tsx:101`.

---

## Verification

- Every item above is checkable against bulk `7d2585da` (72 calls, 315/360 ok,
  45 failed, 63 errored scans). It is a good adversarial fixture precisely because
  it is not a clean run — use it, not a happy path.
- `pnpm run typecheck` clean at repo root.
- The frontend dev server needs `API_PROXY_TARGET=http://localhost:8177` set, or
  `/api/*` silently returns the SPA HTML shell and pages crash with confusing type
  errors instead of a network error. This has bitten twice.

---

# Part F — Copy, evidence and the batch loop (added 2026-08-30)

## F.1 Copy audit (T-81)

Abhishek's brief (2026-08-30): "UI copy audit, not a redesign … speak the user's
language, not the internal one … one label answers one question … the same word for
the same concept everywhere … cut every word that doesn't help someone decide."

**Vocabulary — one word per concept.** Applies to every screen, the share page and
the verdict sentences in `lib/scoring/src/verdict.ts`:

| Concept | Was (variants) | Now |
|---|---|---|
| The section | verdict / decision / Decision Logic / recommendation | **Verdict** |
| Provider that won | winner / Recommended / Clear winner / best fit | **Winner** |
| Rank 1 without a win | Leading, not decided / leader / top candidate | **Ahead, not a winner** |
| Statistical gap | noise floor / 95% CI / inside the noise / survived 1,000 reshuffles | **margin of error** |
| Calls the verdict used | evidence calls / scored calls | **calls scored** |
| Calls the top two both ran | shared calls / shared by top two | **calls both ran** |
| Under 20 calls | provisional | **early read (under 20 calls)** |
| The quality metric | peer flags / cross-provider flags / Avg Flags / flags per 100 words | **disagreements per 100 words** (↓ better) |
| Production provider | production / active / live / production transcriber | **in production today** |
| Decision chips | Clear winner / Too close to call / Too few calls / Not enough providers | **Winner / Too close to call / Not enough calls / Only one provider** |

Rules: plain label on screen, exact mechanism in the tooltip (engineers lose
nothing); every numeric column carries ↓ better / ↑ better and each page with a
rating carries one legend line at the top; no ticket ids, spec ids or dates in
user-facing text; the T-57 rule stands (only the verdict's winner gets the badge) —
its wording changes to the vocabulary above. The full 50-row decision table is in
the session log of 2026-08-30 and was applied in full by T-81 (PR #50, 2026-08-30 —
no exceptions named).

**Evidence:** Hamel Husain & Shreya Shankar, "Building eval systems that improve your
AI product" (Lenny's, 2025-09-09) — binary labels over 1–5 scales, nuance in the
critique; don't put a score on a dashboard, sort examples and look at them (→ T-82,
T-85; drop the 0–3 severity column from the client table). Codecademy benchmark
results on Mobbin — plain per-row states.

## F.2 Landing page (T-83)

Abhishek chose **B: a public marketing page** for the tool (2026-08-30). Not the
Overview (a) and not the share page (c). Static, outside the app shell, same design
tokens. Reference pass via the `visual-and-research` skill before building.

Built as `/welcome` (T-83, PR #50). Structure, top to bottom: the question the tool
answers as the headline; one sentence; one primary button (latest verdict) and one
secondary (run a comparison); an example verdict rendered with the app's own chip,
sentence and legend, labelled as placeholder names; four numbered steps (pull real
calls → run every provider on the same audio → count where they disagree → verdict
with its margin of error); three honesty points ("too close to call" is a real
answer; never a number without its call count; compared against what runs today);
closing CTA; footer. No claim on the page that the tool does not compute.

Evidence: 1Password Developer and Frontify heroes (headline + sentence + button +
product view), Railway and Grammarly Business numbered steps (Mobbin); Lenny's
"Craft your pitch" (2022-07-19), Gina Gotthilf (2023-10-19: message and button above
the fold), Zoelle Egner (2023-01-29: the customer is the hero).

## F.3 The batch loop and the evidence habit

Five register tasks per iteration, one PR with one commit per task, one deploy at
the end. Before any UI or product decision, the global `visual-and-research` skill
runs: 1–3 Mobbin screen searches (visual pattern) and 1–3 Lenny's searches (operator
insight), producing an evidence note that names what changed in the plan. Batch 1
(2026-08-30, PR #49) used it for T-31 (page names), T-82 (Semrush pattern) and T-84
(Midday pattern). Batch 2 (PR #50) used it for T-83 (landing page) and T-85 (worst-first
ordering, from Hamel & Shreya).

# Part G — Batch 4 (added 2026-08-30, per Abhishek): no human judge, org hierarchy, words to watch

## G.1 What Abhishek asked for, and what it changed

- **"There will be no human judge."** The T-08/T-09 loop (a person rules on
  spans, the AI judge is measured against them, T-17 would rank on it) is removed,
  not hidden. A person can still flag a call — hard case, notes — in Corpus; that is
  the only human input the product keeps. The judge contract keeps its shape floors
  (a real pick from the candidate set, every time) and loses its agreement floor.
- **"For each assistant flag which words might need some work."** Words to watch
  (T-87): the words the providers keep splitting on, per assistant, counted in
  calls, with every alternative reading and who said it. Tagged number / word /
  filler because a phone number heard three ways is a different problem from
  "um" vs nothing. The tool does not say who was right — it says where to listen.
- **"Instead of client, divide into orgs."** The grouping unit is the org — the
  Vapi account. Results is org → assistant. The word on screen is "org" (T-89);
  the API keeps `clientLabel` so nothing changes on the wire.
- **"Check if that graph is really necessary."** Per-assistant trend charts inside
  every card: removed (three bulks per line, 22 cards). The page-level trend: kept
  once, folded under "More evidence" with the correlation grid. The answer and the
  words come first; charts are for the reader who wants more.
- **"Give the option of adding call providers."** Import page step 0 (T-90): Vapi
  connected with its orgs, how to add one (env var, never the database), and an
  "Other call providers — not supported yet" row. Which providers come next is in
  `docs/backlog/good-to-have.md` and nowhere else, per Abhishek.

## G.2 Results page order (T-88)

1. Which bulk (picker, one-bulk / all-time, share link)
2. The verdict for the bulk — one sentence
3. Four tiles: STT cost, AI check cost, checked by AI, orgs (or agent errors)
4. Per org: header (name, assistants, calls) → the org's verdict, once → the
   org's monthly cost at full volume → per assistant: ranked table, why this
   order, production baseline, **words to watch**, per-call links
5. More evidence, folded: provider correlation, the trend chart

## G.3 Evidence — batch 4

**Pattern to use:** headline → strip of tiles → ranked list, charts secondary ←
[Peec AI overview](https://mobbin.com/screens/ea726eca-9ea2-423c-be52-181b642a04f1),
[Maze results](https://mobbin.com/screens/28bfc8bf-418e-4f54-81ae-a0a3fe73ef2b).
Words list as a plain frequency table, term first, count beside it ←
[Profound similar keywords](https://mobbin.com/screens/e3b23214-75c6-4803-b235-062f3e397e15),
[Fiverr keyword research](https://mobbin.com/screens/c6d07c18-bcda-4eda-bf3b-c15dd4964017).
Call providers as connected card with a status chip, inactive rows with a disabled
action ← [incident.io integrations](https://mobbin.com/screens/c24ec995-b467-42a5-97fa-92310162c211),
[Uvodo integrations](https://mobbin.com/screens/6d011763-9979-4d55-9e96-ef747ee36894).
**Patterns to avoid:** a stacked-area chart as the first thing on a results page
([Vercel leaderboards](https://mobbin.com/screens/684fc9a5-8990-4f93-8fc3-28e1e0750078)) —
it answers "how much" before "which"; word clouds for term frequency
([Hootsuite listening](https://mobbin.com/screens/57e6c76c-e7a4-4a5d-aac6-a090fdae6c5d)) —
size is not a count a reader can act on.
**What operators say:** error analysis starts from the data, not from a metric —
"look at your data" and sort by worst; a list of concrete failure modes beats a
score on a dashboard ← "Building eval systems that improve your AI product" (Hamel
Husain & Shreya Shankar, 2025-09-09)
https://www.lennysnewsletter.com/p/building-eval-systems-that-improve-your-ai-product.
Words to watch is that list for STT: the failure modes, named, counted.
**Changes to the plan:** cost card became four tiles; per-card charts removed;
words list gets a number / filler split (the first live result put "um" vs nothing
on top of a list meant for phone numbers).
**No evidence found for:** a product that groups a benchmark by customer org and
then by agent — the org → assistant nesting is this project's own.
