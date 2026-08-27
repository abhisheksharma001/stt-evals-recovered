# UI/UX Fixing PRD — clearing up confusion, no new features

**Version:** 0.1 — Draft
**Status:** Findings from a full end-to-end review, 2026-08-27.
**Companion doc:** `docs/PRD-technical-fixes.md` covers the technical/data side
of the same review — several items here have a technical root cause documented
there (cross-referenced inline).

## Why this doc exists

Per Abhishek directly: "I still feel few things are confusing in the whole app."
This is that list — concrete, each one traced to an actual screen and an actual
cause, not a general redesign. Nothing here is a new feature; every item either
clarifies something already built or fixes a label/flow that misleads.

---

## UX-1 (P0): The "skipped" wall — the single biggest source of the confusion reported

**The complaint, verbatim, from earlier this session:** "a lot of them are
getting failed and skipped, need to review those." Root-caused this pass:
across the live corpus, **751 of 1,139 total cells (66%) are
`skipped_pending_review`** — a call matched a bulk's assistant/date/duration
filter but hadn't cleared review yet, so the executor correctly recorded it as
skipped rather than silently dropping it (this is intentional, FR-BLK-11 — see
`docs/PRD-technical-fixes.md` FIX-6 for the mechanism). The *intent* is good
(visibility into what still needs review); the *presentation* is the problem —
every skipped cell renders as a full table row with the same visual weight as a
real failure, in the exact same list, with no separation and no plain-English
explanation.

**Fix:**
- Split the per-run results view into two things, not one flat list: cells that
  were actually **attempted** (`ok`/`failed`) shown first and expanded by
  default, and cells that were **skipped pending review** collapsed under a
  single line — "260 cells skipped — matching calls haven't cleared review yet"
  — that expands on click instead of pre-rendering 260+ rows.
- The bulk-detail dialog already gets this right (`Bulks.tsx`'s stat grid
  clearly separates "Skipped pending review" from "Cells failed" as distinct
  numbers) — bring the same clarity to the per-run `ResultsDialog` in
  `Runs.tsx`, which currently doesn't.

---

## UX-2 (P1): Raw status enums leak into badges as ugly, confusing text

`Runs.tsx`'s `ResultsDialog` renders `{r.status}` directly inside an
`uppercase`-styled badge with no label translation — confirmed in code
(`Runs.tsx` around the results table): a skipped cell literally reads
**`SKIPPED_PENDING_REVIEW`** as one solid all-caps word with underscores, not
"Skipped — pending review." Every other status badge in the app (Corpus's
`StatusBadge`, Bulks's `BulkStatusBadge`) already does `.replace(/_/g, ' ')`
before display — this one spot was missed.

**Fix:** apply the same `.replaceAll("_", " ")` (or a small label map) this
component's siblings already use. Five-minute fix, but it's the exact kind of
rough edge that reads as "the app is confusing" even though the underlying data
is fine.

---

## UX-3 (P1): Two different screens both called "Results," doing different jobs

The Rankings page is titled **"Rankings & Results"**. Independently, every run
row on the Runs page has a button labeled **"Results"** that opens a per-cell
drill-down dialog. These are genuinely different things (aggregate
recommendation vs. raw per-cell status), and the app already tries to
disambiguate — the drill-down dialog's own footer says "Rankings and the
keep/switch recommendation live in Results" — but that only works if the reader
already knows the drill-down *isn't* "Results," which is exactly what its own
button label claims it is.

**Fix:** rename one of the two. Cheapest: rename the per-run button/dialog
title from "Results" to something scoped to what it actually shows — e.g. "Cell
detail" or "Run detail" — and reserve "Results" for the Rankings page alone,
matching its nav label.

---

## UX-4 (P1): Two ways to launch a run, presented with no relationship to each other

Restating the technical finding from the companion doc (FIX-6) from the UX
side: `Runs` page has its own "Queue Run" button and dialog; `Bulks` page has
its own, more capable "New bulk" flow. Both create real, billed runs. Nothing
on either page tells an operator when to use which, and they look enough alike
(similar dialog shape, similar "select providers" step) that the difference —
Queue Run always targets the *entire* ready-to-run corpus with no filter, Bulks
lets you scope by assistant/date/duration and shards/gates the cost — isn't
visible until you're already inside one or the other.

**Fix (pick one; not deciding here, flagging the decision):**
- (a) Fold Queue Run into Bulks entirely — one launch surface, Bulks' filters
  simply default to "whole corpus" when left empty, which they already support.
- (b) Keep both, but label them for their actual difference: "Quick run (whole
  ready corpus)" vs. "Bulk run (scoped, sharded, cost-gated)" — and cross-link
  from one dialog to the other.

---

## UX-5 (P2): Stale copy referencing the retired vertical-first grouping

Two spots still describe the app's old vertical-based mental model after the
2026-08-27 shift to assistant-based grouping:
- `Dashboard.tsx`'s stage-5 "Decide" card detail text still reads "keep,
  switch, or split by vertical" — should read "by assistant" (or just "per
  group") to match what Rankings actually shows now.
- `Rankings.tsx`'s page description literally embeds a changelog note in
  user-facing copy: *"(2026-08-27 -- was by vertical; vertical still shows as a
  tag per card)"* — useful as a dev comment, not as something an operator
  reads on the page. Move that context into a code comment (it's fine there)
  and give the on-page copy a normal, permanent sentence.

---

## UX-6 (P2): The "active provider" setting has no visible effect anywhere

Companion to FIX-4 in the technical doc. From the UX side: an operator who sets
"Active production provider" in Providers → System settings has no way to
confirm it did anything, because nothing downstream — Rankings, Dashboard, the
run-launch dialogs — ever references it. The setting's own on-page copy is
honest about its limited scope ("does not itself reconfigure any live Vapi
assistant"), which is good, but doesn't fix the fact that it also doesn't
visibly do the *in-app* thing it looks like it should do. Once the technical
decision in FIX-4 is made, the visible half of the fix is: show it somewhere a
decision is actually being made (most naturally, as a labeled baseline row or
"vs. active" delta in Rankings).

---

## UX-7 (P2): Failure info requires a click-per-cell even for common, known causes

Every failed cell needs an individual "AI analysis" click to get an
explanation, including the ~55% of current failures that are one of two known,
deterministic causes (see companion doc FIX-2, FIX-5). For an operator scanning
a run with a dozen failed cells from the same root cause (e.g. all 8 calls
hitting the Vapi retention window, across 5 providers = 40 cells), that's up to
40 individual clicks to learn the same fact 40 times.

**Fix:** once FIX-5 (technical doc) ships the free pattern-matched diagnosis for
known causes, surface it **inline, automatically, no click required** — the
"AI analysis" button should only ever appear for the genuinely-unclassified
remainder. This is the single change that turns "lots of things are failing and
I don't know why" into "8 calls hit Vapi's retention window, here's which
ones" at a glance.

---

## UX-8 (P3): Minor UI-kit inconsistency on Corpus

`Corpus.tsx`'s status/vertical filters use plain native `<select>` elements,
while the equivalent pickers everywhere else in the app (Providers, Bulks'
provider checklist styling, the System Settings card) use the shared Radix
`Select` component. Cosmetic only — flagged because it's a small, easy
consistency fix, not because it's causing confusion on its own.

---

## UX-9 (P3): No visible warning that a call is approaching or past Vapi's 14-day wall

Companion to FIX-2 in the technical doc. Right now a reviewer has no way to
tell, from the Corpus or Review page, that spending time getting a call's gold
transcript ready is about to be wasted because its recording will become
permanently unfetchable in a few days. Once FIX-2's caching mitigation is
decided, the paired UI signal (a small "expires in Nd" badge on aging,
not-yet-run corpus rows) closes the loop so review effort isn't spent on calls
that can't be scored.

---

## Explicitly not changed by this pass

Per the standing "no extra features" instruction for this review: nothing above
adds a capability that doesn't already exist in some form. Every item is a
label fix, a grouping/collapse fix, a copy fix, or a "make an existing setting
actually do something" fix. New capability ideas that came up during this
review but aren't part of "making the base solid" (e.g. a bulk "analyze all
failed cells" action, a decision-export enhancement) belong in
`docs/backlog/good-to-have.md`, not here.
