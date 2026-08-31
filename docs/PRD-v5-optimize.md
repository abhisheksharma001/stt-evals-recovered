# PRD v5 — Tune the provider you already run, and stop the setup page from needing a translator

**Version:** 1.0
**Date:** 2026-08-31
**Source:** Abhishek, 2026-08-31, after looking at the Setup page and asking
"what are all these?" — thirteen asks in one message, transcribed and answered
below.
**Companion docs:** `docs/PRD-v4-uiux.md` (hierarchy pattern this extends),
`docs/PRD-v4-technical.md`, `docs/scoring-policy.md`.
**Scope rule:** same as v4 — nothing here invents a page for its own sake. Two
asks get a genuinely new capability (single-provider tuning; writing a winner
back to Vapi). Everything else is layering, density, or naming.
**Implementer:** written for a Sonnet-class model. Every item names the file,
what is on screen today, what must be on screen instead, and how to check it.

---

## 0. The headline finding: three of the thirteen asks are already built

Checked against the running system on 2026-08-31, not from memory. Stating this
first because building them again would be waste, and because the reason they
*look* missing is itself a real UI defect.

| Ask | Reality | Evidence |
|---|---|---|
| "sending call to providers parallelly rather than one by one" | **Already parallel.** 16 cells in flight at once overall, capped per vendor: Deepgram 8, AssemblyAI 6, OpenAI/ElevenLabs/Gladia/Speechmatics 4, Cartesia 2. | `RUN_CONCURRENCY` / `VENDOR_CONCURRENCY_OVERRIDES` in `artifacts/api-server/src/lib/run-executor.ts` |
| "once all needed we got, then the agent can run instantly" | **Already instant.** The AI check stopped being a button on 2026-08-27 (`e0399cc`); it is a stage of the run executor and fires the moment a call's cells finish. | `artifacts/api-server/src/lib/run-executor.ts`, `lib/agent-verify.ts` |
| "can we find a way to get solved the cartesia timed out reason" | **Already root-caused and fixed on 2026-08-27.** The old code gave the whole WebSocket lifetime a flat 120-second budget while streaming audio at real-time pace, so any call longer than roughly 100 seconds timed out no matter how healthy Cartesia was. Now scaled 3×-realtime, 60s floor, 15min cap. | comment + `responseTimeoutMs` in `lib/stt-providers/src/adapters/cartesia.ts` |

**So why do they look missing?** Because the only evidence on screen is 15 stale
failures. Every one of those 15 Cartesia `provider_timeout` cells is dated
**2026-08-27** — the day of the fix — and **none has ever been retried**. Overview
counts them under "transcripts a retry could fix", which is true, and says nothing
about the fact that the cause is gone. A fixed bug that still shows its old
wreckage reads exactly like an unfixed bug.

**V5-0 — retire fixed failures.** A failure class carries the date its cause was
fixed. Cells older than that date are shown as "fixed since — retry to clear",
not as open problems. Not a silent delete: the count stays visible, its label
changes. See V5-D3.

There is a real Cartesia problem left, and it is not correctness — it is speed.
Measured on bulk `7d2585da`: Cartesia 128.8s per call, Gladia 15.3s, AssemblyAI
13.0s, Deepgram 3.5s, OpenAI 3.1s. **Cartesia alone is 79% of all vendor wait.**
That is inherent to how we call it: the adapter streams audio to a WebSocket at
190ms per 200ms chunk, i.e. marginally faster than real time, so a 7-minute call
takes about 7 minutes. See V5-D2.

---

## 1. What was checked, and what is true right now

Every number below was read live on 2026-08-31.

- **11 provider rows.** 9 ready, `deepgram-nova-2` disabled by hand,
  `speechmatics` has no key.
- **Deepgram's live catalog: 19 models.** Not 19 engines — 3 base engines
  (`nova-3`, `nova-2`, `nova`) plus domain-tuned variants of each
  (`-phonecall`, `-drivethru`, `-medical`, `-finance`, `-meeting`, `-atc`,
  `-automotive`, `-conversationalai`, `-voicemail`, `-video`, `-ea`).
  3 are enabled here.
- **`deepgram-flux-general-en` is not in that list of 19.** It exists as a
  provider row (disabled, $0.0077/min) and it is what the Rush assistant runs in
  production, but Deepgram's model-list API never returns it, so the "Newest"
  line structurally cannot see it.
- **Three model rows point at provider ids that do not exist:**
  `assemblyai-universal-3-5-pro`, `elevenlabs-scribe-v2`, `gladia-solaria-1`.
  The real rows are `assemblyai-universal`, `elevenlabs-scribe`,
  `gladia-solaria`. Nothing follows that id today, so nothing is broken — it is
  a trap for the next consumer.
- **Three Vapi accounts now**, not two: Default, Land And Apartment, and
  **Leasing Dev** (`VAPI_API_KEY_LEASING_DEV`), 219 assistants across them.
  The standing warning in `.claude/CLAUDE.md` about adding a third account was
  checked: **all 121 calls carry an account label** (99 Land And Apartment, 22
  Default), so nothing is ambiguous and no backfill is needed. Recorded here so
  the check is not repeated blind.

---

## Part A — Setup: say what these things are without being asked

The page stacks two different kinds of thing with no visual distinction, which is
what produced the question. From the top of a vendor block:

1. **The vendor's catalog** — what the vendor sells. A menu. Costs nothing,
   runs nothing.
2. **Provider rows** — what this tool can actually run in a bulk. Has a price,
   capability flags, an on/off switch.

**V5-A1 — three layers, stated (PRD-v4 E.1 hierarchy applied to Setup).**
`artifacts/stt-benchmark/src/pages/Providers.tsx`.

Vendor (key status, catalog freshness) → catalog (collapsed; the menu) →
provider rows (what runs). Each layer gets a one-line explanation in plain words,
permanently visible, not a tooltip:

- catalog strip: *"Deepgram's own list — 19 models they sell. Enabling one adds
  it below; nothing here costs money until you run a bulk with it."*
- rows heading: *"What this tool can run. Each has its own price and results."*

Domain variants group under their base engine (`nova-2` and its 11 tuned
variants collapse into one line reading "nova-2 · 11 domain variants") instead
of 19 flat rows. **Check:** open Setup cold and answer "what is the difference
between the grey list and the cards below" without asking anyone.

**V5-A2 — enable and disable, symmetric.** In the catalog list an unenabled
model shows a clickable `enable`; an enabled one shows the word `enabled` as
dead text. So the list can create a provider row but never switch one off — the
only off switch is on the card further down.

*Assumption to confirm:* this is what "give me open for disable as well" means.
Every enabled row gets a `disable` action in the same column, and it disables
the underlying row (leaving results intact, FR-P3) rather than deleting it.
**Check:** disable `nova-2` from the catalog list; its card reads DISABLED and
its historical results are still on Results.

**V5-A3 — a provider that has no catalog entry says so.** Flux is production for
Rush and is invisible in the catalog. The vendor block gains a line: *"1 provider
row is not in this vendor's list API (flux-general-en) — a separate product, not
a missing model."* **Check:** the Deepgram block names Flux without calling it
stale or missing.

**V5-A4 — the phantom provider ids.** `routes/benchmark.ts` builds
`providerId` as `<vendor>-<apiModel>` unconditionally, while "is it enabled" can
match an older row id. When the legacy path matches, report the id that actually
exists. **Check:** every `providerId` in `GET /benchmark/providers/models` with
`enabled: true` appears in `GET /benchmark/providers`. Add that as a route test.

**V5-A5 — "pick a source" does not belong in Setup. My answer to your question:
half of it belongs, half does not.**

- **Belongs:** which Vapi accounts exist, whether each key is present, which
  assistants they own. That is configuration, it is read-only, it changes rarely.
- **Does not belong:** *importing calls*. Picking an account, picking assistants,
  choosing a date window and pulling calls is not setup — it is how the corpus
  gets built, it is done repeatedly, and its result appears on the Calls page.
  Filing it under Setup is why it feels wrong.

**Move the import action to Calls** as its primary top-right action ("Import from
Vapi"), and leave account/key status on Setup as a read-only panel that links to
it. **Check:** a person told "add last week's Rush calls" goes to Calls and never
opens Setup.

---

## Part B — Creating a bulk, in layers instead of one wall

Today the create form shows, all at once: assistant multi-select, account
selector, window in days, min duration, max duration, calls per run, outcome
filter, provider checkboxes, name, and a live cost preview. Eleven decisions
before the first one is made.

**V5-B1 — four steps, one question each.**
`artifacts/stt-benchmark/src/pages/Bulks.tsx`.

1. **What are you trying to learn?** — *Compare providers* or *Improve the one
   we already run* (Part E). This choice changes step 3.
2. **Whose calls?** — org, then assistants. Nothing else.
3. **Which providers?** — in compare mode, the candidates; in improve mode,
   pre-filled with the assistant's production provider and not asked at all.
4. **Check the cost, then launch.** — matched count, excluded buckets by name,
   the split estimate, the confirm.

**V5-B2 — everything else lives under Advanced.** One toggle, closed by default,
holding: window in days, min/max duration, calls per run, outcome filter, custom
name. Each keeps its current default, and the closed toggle **states the
defaults in one line** so hiding them never hides what will happen: *"Last 14
days · 30s and longer · 50 calls per run · all outcomes."* **Check:** a bulk can
be launched end to end without opening Advanced, and the summary line matches
what actually ran.

**V5-B3 — the cost preview follows you down.** It is the number that matters and
it currently sits at the bottom of the wall. It becomes a persistent footer on
every step, updating as the selection narrows.

---

## Part C — Naming and density

**V5-C1 — org replaces vertical on screen.** `vertical` is an internal tag
(`rush`, `property_management`, `trucking`); the org (the Vapi account, plus the
assistant under it) is what a human recognises. The Calls table's **Vertical**
column and its "All verticals" filter become **Org**; the assistant name is
already the row's context. `vertical` stays in the CSV export and in the data —
it is only leaving the screen. `artifacts/stt-benchmark/src/pages/Corpus.tsx`.
**Check:** grep the pages for the word "vertical"; what remains is code, not
copy.

**V5-C2 — table density.** Rows are cramped and column groups are not visually
separated. Applies to Calls, Results, Bulks, Setup: a defined row height, a
consistent cell padding scale, and a visible gap between column groups
(identity | measurements | money | actions). One shared table style, not
per-page overrides. **Check:** the same table on the same screen at 1440px, side
by side before and after.

---

## Part D — Time, and where it goes

**V5-D1 — how long will this take?** The cost estimate answers "what will this
cost" and nothing answers "when will it finish". The data to answer it exists:
per-provider latency per call is recorded on every score row.

Estimate = for each selected provider, its median seconds per audio-minute from
its own history × the selected audio minutes, divided by that vendor's
concurrency cap, taking the **slowest** provider (they run in parallel, so the
longest pole is the answer, not the sum). Shown on the confirm step and as a
live "about N minutes left" on the running card. Providers with no history say
"no history yet", never a made-up number. **Check:** launch a bulk, compare
estimate to actual, record both.

**V5-D2 — Cartesia's 79%.** Not a bug, a shape: the adapter streams at roughly
real time by design (`SEND_INTERVAL_MS = 190` per 200ms chunk). Two questions to
answer before changing anything, in this order:
1. Does Cartesia accept audio faster than real time on this endpoint without
   dropping or degrading? Test on one call at 4×, 8×, and as fast as the socket
   drains; compare transcripts word-for-word against the current output.
2. Does Cartesia offer a batch endpoint? If yes, it is likely the right adapter
   for a benchmark, which is not a live call.

Only if (1) is clean does the send rate change, and the concurrency cap of 2 is
re-checked at the same time. **Check:** same call, old path vs fast path,
transcripts identical and wall-clock materially lower.

**V5-D3 — a fixed cause stops looking open.** Per V5-0. `failureClass` gains an
optional "fixed on" date; cells whose failure predates the fix are labelled
"cause fixed 2026-08-27 — retry to clear" wherever the retryable figure appears.
**Check:** Overview's retryable figure explains itself without anyone reading
this document.

---

## Part E — The big one: tune the provider you already run

**The situation this is for.** A client runs Deepgram. They are not switching.
Comparing seven vendors tells them nothing they can act on. What they want is:
*where does Deepgram get our calls wrong, and what do we change?*

Everything needed already exists and is pointed the wrong way — words-to-watch,
the flag kinds (number / word / filler / format), entity references, the word
diff, and the live read of the assistant's Deepgram `keyterm` list and `numerals`
setting.

**V5-E1 — where it lives. My decision: not a separate section.** It is a *mode*,
for one reason: a separate page would duplicate selection, running, scoring, and
words-to-watch, and the two would drift. It appears as:
- a goal chosen in step 1 of bulk creation (V5-B1);
- a third view on Results beside "One bulk" and "All-time combined", called
  **Tune**;
- and nothing else new.

**V5-E2 — the tuning report**, per assistant, for one provider:
1. **What it gets wrong.** The words this provider splits on, grouped by kind,
   each linking to the call to listen. Words-to-watch, scoped to one provider
   instead of compared across providers.
2. **What it hears instead.** For each word, the variants actually produced
   ("villa roma" for "villaroma", "a m" for "am"), with counts. This is the
   mining already committed in `artifacts/api-server/src/mine-reading-pairs.ts`
   (63 calls → 1,060 pairs), surfaced rather than run by hand.
3. **The terms that recur.** Part numbers, property names, street names — the
   vocabulary this client's calls are actually made of, ranked by frequency,
   marked with whether each is already in the assistant's boost list.
4. **What to change, as steps.** Provider-specific and concrete. For Deepgram:
   which words to add to `keyterm`, whether `numerals` should be on, whether a
   domain variant (`nova-2-phonecall`) is a better base than the general model.
   Each step says what it should fix and what it cannot.

**Check:** for the Rush assistant, the report names words that are genuinely
mis-heard in the audio, and its keyterm suggestions are not already in the
assistant's 120-term list.

**V5-E3 — auto-optimisation, marked "coming soon" and built behind it.**
The mechanism, stated now so E2 is built to feed it:
- input: the tuning report as JSON plus the assistant's current transcriber
  config, read live;
- an AI step with one narrow job — propose a new transcriber config
  (`keyterm` additions, `numerals`, model choice) with a reason per change;
- output: **a diff, never a write.** Current config on the left, proposed on the
  right, every change justified by a word and a call you can listen to.

**V5-E4 — when a tuned config already exists.** Three explicit choices, never a
silent merge: **Keep** (change nothing), **Add on top** (union of the existing
list and the proposal, conflicts shown), **Replace** (proposal only; what is
being dropped is listed first). The previous config is stored before any write,
so undo is one click.

---

## Part F — Push the winner back to Vapi

**V5-F1 — write the chosen transcriber to the assistant.** Today the assistant's
transcriber is read-only (`GET /benchmark/assistants/{id}/transcriber`); the loop
ends with a recommendation nobody can apply from here. This closes it: from
Results, apply the winning provider — or a tuned config from Part E — to the
assistant's Vapi transcriber.

**This changes how a live client's phone calls are transcribed.** Non-negotiable
conditions, all of them:

1. **Diff first.** Current vs proposed, field by field. No blind apply.
2. **Explicit confirm**, naming the org, the assistant, and what changes.
3. **Previous config stored** before the write; one-click revert.
4. **Audited** with actor, timestamp, before and after.
5. **One assistant at a time.** No bulk apply across 219 assistants.
6. **Off by default**, behind an env flag, so an accidental click cannot reach a
   client's production agent.

**Check:** apply to a Leasing Dev assistant first (a dev account exists —
`VAPI_API_KEY_LEASING_DEV`), confirm on Vapi, revert, confirm again.

---

## Open questions for Abhishek

1. **V5-A2:** does "give me open for disable as well" mean a disable action in
   the catalog list, as read above? If it means something else, say which screen.
2. **V5-F1:** should writing to Vapi be allowed on production accounts at all, or
   dev accounts only until it has been used a few times?
3. **V5-E3:** the auto-optimiser needs a paid AI call per report. Same "go spend"
   rule as a bulk, or pre-approved because it is cents?
4. **V5-D2:** testing Cartesia's tolerance for faster-than-real-time audio costs
   a handful of real transcription calls. Approve?
5. **Order.** Part E is the most valuable and the largest. Parts A and C are the
   cheapest and remove today's confusion. Recommended sequence: A → C → B →
   D → E → F.

---

## Proposed register rows

| ID | Row |
|---|---|
| T-187 | V5-A1 Setup three-layer hierarchy + plain-language layer captions |
| T-188 | V5-A2 disable from the catalog list; V5-A4 phantom provider ids + route test |
| T-189 | V5-A3 name providers absent from a vendor's list API (Flux) |
| T-190 | V5-A5 move import to Calls; Setup keeps read-only account status |
| T-191 | V5-C1 org replaces vertical on screen; V5-C2 shared table density |
| T-192 | V5-B1/B2/B3 bulk creation in four steps, Advanced toggle, sticky cost |
| T-193 | V5-D1 completion-time estimate from recorded latency |
| T-194 | V5-D3 fixed-cause failures stop reading as open |
| T-195 | V5-D2 Cartesia ingest-rate investigation (measurement first, no change) |
| T-196 | V5-E1/E2 Tune mode + the tuning report |
| T-197 | V5-E3/E4 auto-optimisation diff, keep / add on top / replace |
| T-198 | V5-F1 write a transcriber back to Vapi, gated |
