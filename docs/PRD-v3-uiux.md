# UI/UX PRD v3 — Make the tool show its evidence

**Version:** 1.0
**Date:** 2026-08-27
**Companion doc:** `docs/PRD-v3-technical.md` (same review, technical side —
cross-referenced inline as T-n / A-n / F-n)
**Implementer:** written for a Sonnet-class model. Each item names the exact
file, what a user sees today, what they must see instead, and how to check it.
**Scope rule:** nothing here is a redesign. Every item either surfaces data the
system already has, or removes a screen that now lies about how the tool works.

---

## 0. The headline finding

**The app never shows a transcript.**

`hypothesisTranscript` is fetched from seven providers, stored on every result
row, serialised by the API — and rendered nowhere in the entire frontend
(verified: zero references to `hypothesisTranscript` across
`artifacts/stt-benchmark/src`). A tool built to answer *"which speech-to-text
provider should we use"* currently cannot show you what any provider actually
transcribed.

Everything else in this document is smaller than that.

The second finding is that the app is mid-migration and says so out loud in
several places: the gold transcript was retired in commit `fd53d0c`, but the
Import page still instructs the user to write one, the Corpus still carries
gold-era statuses, and the Runs dialog still renders a "differs from gold" panel
that is now 100% wrong on every clean cell. Those contradictions are most of the
"the app is confusing" feeling.

---

## U-1 (P0): Add a transcript reader, and a side-by-side compare

**Where:** `pages/Runs.tsx` — `ResultsDialog` / `renderRow` (~line 425).

**Today:** expanding a result row shows a hybrid-flag summary, or a broken word
diff, or a failure panel. There is no way to read the text.

**Build:**
1. **Single transcript view.** Expanding an `ok` cell shows that provider's
   transcript in a scrollable, monospace-ish panel with flagged spans
   highlighted inline (the spans are already in
   `score.hybridFlags.lowConfidenceSpans` and the entity mismatches carry their
   raw values). Fetch it from the new `GET /benchmark/results/:resultId`
   (T-15) rather than bloating the list response.
2. **Compare mode — the primary view for a call.** A "Compare providers" button
   on each call group header opens a full-width panel: one column per provider
   that succeeded on that call, transcripts aligned by the consensus sequence
   (T-4), with each cell's differences from consensus tinted. Above the columns,
   a row of per-provider chips: flag count, severity, latency, cost.
3. **Audio, right there.** An `<audio>` element pinned to the top of the compare
   panel, sourced from `/api/benchmark/calls/:callId/audio` (which T-9 makes
   work for cached calls). Clicking a flagged span seeks the player to that
   span's timestamp. This is the moment the whole product exists for — a human
   hearing the audio while looking at what each provider claimed it said.

**Check:** open any completed run, pick a call, read all seven transcripts side
by side, and play the audio, without leaving the page or opening the database.

---

## U-2 (P0): Delete the "differs from gold" panel — it currently reports 100% error on perfect transcripts

**Where:** `pages/Runs.tsx:199-238` (`WordDiffView`), used at `:471`, gated by
`hasDiff` at `:426`.

**Today:** gold transcripts are retired, so `score.wordDiff` is computed against
an empty string and comes back as *one `"ins"` op per word*. `hasDiff` is
therefore true for **every successful cell**, and expanding a flawless,
zero-flag result renders:

> *1,842 words differ from gold, out of 1,842.*

A provider that did everything right is shown as having got everything wrong.

**Do:** delete `WordDiffView`, its call site, and the `hasDiff` branch. Rows
expand into the hybrid-flag view (kept) and the new transcript view (U-1).
Pair with T-10, which stops writing the data.

**Check:** expand a clean cell — no diff panel, no gold wording anywhere.

---

## U-3 (P0): Rankings becomes a decision page, not a table

**Where:** `pages/Rankings.tsx`.

**Today:** per assistant, a sorted table of providers with `avgFlagCount`,
severity, latency, cost, and a templated one-line `recommendation` per row. Two
problems: (a) it silently shows **one shard's** numbers out of a whole bulk
(T-1), with nothing on screen saying so; (b) a table of six near-identical
numeric rows is not a recommendation — the user has to derive the decision
themselves, which is the job they came here to outsource.

**Build, per assistant group:**
1. **A verdict card at the top** — recommended provider, one-line reason, the
   runner-up, and an explicit confidence line: *"Based on 137 scored calls
   across 3 providers. Above the 12-call decision bar."* When A-1 tier 2 ships,
   this card renders the written verdict; until then, render the existing
   composite winner with the same layout so the shape doesn't change later.
2. **Provenance, always visible:** *"From bulk `Rush · Aug 27` — 137 calls,
   7 providers, finished 2h ago."* Never show a ranking without saying what
   evidence produced it.
3. **The table stays, below the card**, as the "show me the numbers" layer —
   sortable exactly as today.
4. **A "what would change this" line** — e.g. *"Cartesia is 40ms faster but
   flagged 3× more entity mismatches"* — sourced from the same aggregates.
5. **The trust caveat, permanently, not as a tooltip:** *"Ranked by how much
   each provider disagreed with the others — no human-verified transcript is
   involved. A provider that guesses fluently can score well. Spot-check the
   flagged calls before deciding."* (See A-2 — this is a real methodology limit,
   and hiding it would be the actual UX failure.)

**Check:** a non-technical reader lands on Rankings and can state the
recommendation, the sample size behind it, and one reason to doubt it, without
clicking anything.

---

## U-4 (P0): Purge the gold-transcript instructions from Import

**Where:** `pages/Import.tsx` lines 180, 438, 509, 512, 523.

**Today, verbatim:**
- *"They are in the corpus as needs_review — gold transcript and de-id are still required."*
- *"It still needs a human gold transcript and two de-id approvals before it can be run."*
- Button: *"Go to Corpus & Gold Data"*
- *"Next step: correct each draft into a gold transcript and get two de-id approvals."*
- *"Import → gold transcript & de-id (Corpus) → queue a run (Runs) → …"*

None of this is true any more. A new user follows these instructions, goes
looking for a gold-transcript editor, and doesn't find one — because `Review.tsx`
removed it in the same commit. This is a direct, self-inflicted source of "the
app is confusing".

**Do:** replace every one with the real flow —
*"Imported calls land in `needs_review`. They need two de-identification
approvals before they can be included in a bundle. No transcript work is
required."* Button becomes "Go to Corpus". The footer flow becomes
**Import → de-id (Corpus) → bundle (Bulks) → verdict (Rankings)** — note it says
Bulks, not Runs; see U-5.

**Check:** grep `artifacts/stt-benchmark/src` for `gold` — the only hits left
should be code comments explaining the retirement.

---

## U-5 (P1): Runs vs Bulks — two pages for one concept

**Where:** `pages/Runs.tsx`, `pages/Bulks.tsx`, `components/layout.tsx`,
`pages/Dashboard.tsx:132`.

**Today:** "Bulks" is the real pipeline (select calls by criteria → shard →
execute), and "Runs" lists the shards those bulks produce plus ad-hoc runs. The
Dashboard's single next-action already points at `/bulks`, and `GET /benchmark/runs`
filters to `purpose: "batch"`. But the nav presents Runs and Bulks as peers, so
a user has to learn the internal sharding model to know which one they want. The
naming compounds it: a "bulk" contains "runs", and both are "runs" in English.

**Do — rename and nest, don't rebuild:**
- Nav: **"Benchmarks"** (was Bulks) as the primary entry. **"Runs"** becomes a
  sub-view reachable from a benchmark's detail dialog ("20 shards — view
  execution detail") plus a filter for ad-hoc runs.
- In UI copy, standardise on one word for the thing a user launches:
  **benchmark**. A shard is "part 3 of 20", never a separate noun.
- Keep every route working; this is labels and navigation, not data model.

**Check:** a new user asked to "test five providers on the Rush assistant's last
50 calls" finds the right page on the first try.

---

## U-6 (P1): The retention warning cries wolf

**Where:** `pages/Corpus.tsx:187-204`.

**Today:** a warning fires on any call whose `sourceStartedAt` is more than 14
days old — including calls whose audio is already cached locally and therefore
permanently safe. It stays silent on the actually-urgent case: a call at day 12
that has never been cached and is about to become unrunnable forever.

**Do (needs T-14's `audioCached` field):**
- `audioCached === true` → small neutral tick: *"Audio saved locally — safe to
  run any time."* No warning, regardless of age.
- `audioCached === false && age > 10 days` → **amber, urgent**: *"Not saved yet
  — Vapi deletes this recording in N days. Run it or it's gone."* with a
  one-click "Cache now" action.
- `audioCached === false && age > 14 days` → red, factual: *"Recording expired
  at the source and was never saved. This call can't be benchmarked."*
- A corpus-level banner counting at-risk calls, with "Cache all at-risk now".

**Check:** the warning count on a healthy corpus is 0, not "most of the list".

---

## U-7 (P1): "Complete" doesn't mean complete

**Where:** run status badges in `pages/Runs.tsx` / `pages/Bulks.tsx`; source is
`run-executor.ts:478` (F-1).

**Today:** a run is `complete` if **even one** cell succeeded. A run where 349
of 350 cells failed shows a green "COMPLETE" badge, with the real story buried
in the `notes` text underneath.

**Do:** once F-1 adds `partial`, render three distinct states —
`complete` (green, all attempted cells ok), `partial` (amber, *"312 of 350 cells
ok — 38 failed"*), `failed` (red, nothing succeeded). Put the cell counts in the
badge row itself, not only in notes.

---

## U-8 (P1): Show what was actually spent, not only what was estimated

**Where:** `pages/Bulks.tsx` (cost gate + stat grid), `pages/Rankings.tsx`
(Cost/Min column).

**Today:** the cost gate shows a pre-flight estimate (`estimateBulkCostCents`)
and nothing ever shows actual spend. Separately, the "Cost/Min" column is
mislabelled — the underlying value is cost *per call*, not per minute (T-11).

**Do:**
- Bulk detail grid gains **"Spent so far"** — sum of `costCents` over `ok`
  cells — next to the estimate, with the delta. Operators approving a $50 gate
  need to see whether the estimate was honest.
- Rankings shows two correctly-labelled columns: **"$ / call (avg)"** and
  **"$ / min (rate)"**. CSV headers updated to match.
- The estimate dialog states its assumption explicitly: *"Estimate assumes every
  selected call runs on every selected provider. Skipped and failed cells aren't
  billed."*

---

## U-9 (P1): Make the skipped/failed distinction impossible to misread

**Where:** `pages/Runs.tsx` `ResultsDialog` — already partially fixed (skipped
cells collapse into their own group, statuses use `.replaceAll('_',' ')`).

**Remaining:** the collapsed skipped group still doesn't say *why* in plain
English, and "skipped" reads like a failure to anyone who hasn't read the FR
numbers.

**Do:** the group header reads *"38 cells not run — these calls haven't cleared
de-identification yet. Nothing was attempted and nothing was billed."* with a
"Review these calls" link straight to Corpus filtered to that set. Same wording
in the Bulks stat grid so the two pages agree word for word.

---

## U-10 (P2): The Agent page needs to say what it can and cannot know

**Where:** `pages/Agent.tsx` (`:114`, `:412`).

**Today:** the page presents the LLM's pick with reasoning. The reasoning is
persuasive by construction, and there is nothing on screen stating the pick was
made **from text alone, with no audio**, or that a fluent guess can beat an
accurate transcript (A-2).

**Do:**
- Under the pick: *"Chosen by reading the transcripts only — the model did not
  hear the call. Play the audio before approving."* with the player inline.
- Show the tier-0 flags that triggered the scan **above** the pick, so the
  human sees the evidence before the conclusion.
- When A-4 ships, show `judgeAgreement` (3/3, 2/3, 1/3) as a confidence chip;
  anything below 3/3 gets *"the model changed its answer between runs — this one
  needs human ears."*
- Approve/reject buttons keep the existing two-person de-id gate wording.

---

## U-11 (P2): Remove dead controls and vestigial states

- `pages/Corpus.tsx:173-174` — `ready_for_gold` / `gold_in_review` badge styles
  for statuses nothing can reach any more (F-3). Remove.
- `pages/Rankings.tsx` — `diarizationScore` is sortable and exported, but it's a
  capability flag, not a score (T-13). Render as a tick/dash in a "Diarisation"
  column, remove from `SortKey`.
- `pages/Review.tsx` — the nav guard (`lib/nav-guard.ts`) still exists to protect
  "Review's gold editor" (`layout.tsx:33` comment) which no longer exists.
  Confirm whether anything on Review still holds unsaved state; if not, remove
  the guard rather than leaving a no-op interception on every nav click.

---

## U-12 (P2): Where customisation belongs in the UI

T-12 adds per-assistant/vertical keyword vocabularies and per-run language and
diarisation options — the customisation the tool currently has no surface for.
Put them where the decision is made, not in a settings dungeon:

- **Providers → System settings** gains a **Vocabularies** section: create a
  named term list, attach it to an assistant or a vertical, paste terms one per
  line. Show which providers actually honour it (Deepgram, AssemblyAI, Gladia,
  Speechmatics — OpenAI, ElevenLabs and Cartesia ignore it) so nobody expects
  it to apply everywhere.
- **Bulk creation dialog** shows the resolved vocabulary read-only —
  *"Rush part numbers (24 terms) will be applied — matched on assistant"* —
  because it changes results and is frozen into the manifest.
- **Run detail** shows the frozen options exactly as executed. Reproducibility
  means the UI can answer "what settings produced this number" without a DB
  query.

---

## Suggested order

1. **U-4, U-2** — half an hour each, and they stop the app contradicting itself.
2. **U-1** — the transcript reader and compare view. This is the product.
3. **U-3** — Rankings as a decision page (lands with T-1).
4. **U-6, U-7, U-9** — clarity fixes on states the user misreads today.
5. **U-5** — the Runs/Bulks rename, once nothing else is in flight in those files.
6. **U-8, U-10, U-11, U-12** — the rest.

**Definition of done:** `pnpm run typecheck` clean, a production UI build, and
one pass through the whole flow (import → de-id → benchmark → verdict) by
someone who has not read this document, with their questions written down.
