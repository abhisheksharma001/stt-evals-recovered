# PRD v7 — One verdict the corpus can carry

**Version:** 1.0
**Date:** 2026-09-08
**Source:** Abhishek, 2026-09-08 — after M-18 shipped: *"what do u think about the
existing prd things which are remaining, and what do u think we can do to improve the
whole thing (do ur agentic research)"*, then *"update the prd accordingly"*. Same day,
two product asks in his words: the AI should come *first* — *"first the agent will
understand which transcript need to be checked"* — and the comparison must stop showing
*"changes which is like separated with dash (-) or space or just the basic stuff"*.
**Companion docs:** `docs/PRD-v6-measure.md` (measurement; Parts A–F, rows M-1 … M-21),
`docs/PRD-v5-optimize.md` (Tune mode, write-back — still valid, re-sequenced here),
`docs/PRD.md` (goals G1–G7), `docs/scoring-policy.md`, `docs/step-register.md` (the work).
**Scope rule:** nothing here adds a page or a provider. Every part either makes the one
verdict on file true, or removes something that keeps it from being true.
**Implementer:** written for a Sonnet-class model. Every step in the register names the
file, what is there today, what to change, and how to check it.

---

## 0. What is true right now — read from the live system on 2026-09-08

Not from memory. Every row was queried against the API on `:8177`, the dev database on
`:5433`, or the code, in the session that produced this document.

| Fact | Value |
|---|---|
| Calls | **176** — 160 property management, 8 rush, 8 trucking; **31 distinct assistants** |
| Production transcriber on those calls | Deepgram Flux **130**, nova-3 19, nova-2 5, unknown 22 — **154 of 176 run Deepgram** |
| Calls with a human gold | 2, one of them a 137-character fragment (O-76) |
| Bulks | 3, all complete. `340400b2` (2026-08-28, 280 cells) and `f5324fd4` (2026-09-04, 270 cells) ran on the **mono** mix v6 disowned. `42769f26` (2026-09-08, 17 calls × 5 providers = 85 cells) is the **only bulk on the customer channel** — the only honest evidence on file |
| Customer words per call on that bulk | median 45, min 25, max 140 |
| Streaming cells, ever | **0**. Flux — production on 130 calls — cannot be run by this tool (M-11d waits on a 2-cent go-spend) |
| Money spent, all time | STT $5.49 · judge $1.72 · **$7.21** |
| Judge scans | 239 flagged, 6 clean, 68 error (62 are the T-01 integer-column bug, historical), 1 approved, 1 rejected |
| Assistant ranking groups at the decision bar (≥ 12 calls) | **0 of 29, all-time.** Every card on Results carries "Do not treat as decision-grade" |
| Honest-bulk assistant cards | 13 groups, **13 tied on flags**, "price decided this order, not accuracy" on every one; Cartesia rank 1 in 12 |
| Honest-bulk org verdict | *"ElevenLabs has the least disagreement: 0.4 per 100 words, 4% fewer than AssemblyAI. 17 calls (early read, under 20)."* — decision `winner`, bootstrap says outside noise |
| Keyterms on the 14 largest assistants (124 of 176 calls) | **0 on all 14**; `numerals` unset on all 14; 11 of 14 carry a fallback transcriber |
| Vapi `successEvaluation` stored per call | 118 true · **23 false** · 35 null — read by nothing in the UI |
| Judge inputs | `originalTranscript`, `flaggedSpans`, `candidates`. The domain is a hardcoded sentence in `artifacts/api-server/baml_src/judge.baml` ("truck-parts service desks, apartment leasing, trucking dispatch") for every assistant |
| Comparison view | conventions ("1-bedroom" / "1 bedroom", "gonna" / "going to", "um") are shown as differences by design — `lib/scoring/src/equivalence.ts` line 23 |

### What this means, in one paragraph

The harness is sound and the measurement is honest now (v6 did its job). What it
measures is too small to decide anything: one bulk of 17 calls, no group of calls that
reaches the bar the tool itself sets, and a headline winner that — see §2 — is decided by
how many "um"s a provider writes down. The next work is not more measurement surface. It
is: make the one verdict true, let the corpus grow on its own, and point the judge at the
question the client actually has.

---

## 1. What the people who do this seriously say

Evidence note, per the visual-and-research skill. Read with the session's web tools
(keenable.ai is configured and connected but its tools were not loaded in this session;
the built-in search does the same job).

**On which calls to look at.** *"If you're a high-throughput customer, you cannot
practically sit and evaluate all the traces. You need some indication to understand what
are the things that I should look at … all of these implicit signals and explicit signals
are going to communicate back to you what are the traces that you need to look at."*
← Kiriti Badam, Lenny's Podcast, 2026-01-11. This is Abhishek's "the agent understands
which transcript needs to be checked", stated by an operator — and the signals he means
are *implicit* production signals, not an LLM reading the transcript.

**On what the implicit signal is here.** Vapi's `successEvaluation` is an LLM verdict on
**goal completion**, produced from the assistant's own system prompt — default prompt:
*"Determine if the call was successful based on the objectives inferred from the system
prompt"* — with a configurable rubric (PassFail, NumericScale, …). It says nothing about
the transcript directly; a failed call may or may not be a transcription failure. That is
exactly what makes it a triage seed rather than a label.
← [Vapi call analysis](https://docs.vapi.ai/assistants/call-analysis), read 2026-09-08.

**On the judge.** *"Can't the AI just eval it? It doesn't work."* Measure the judge
against a human-labelled set; 10–100 examples is the starting bar; sort by score and read
the best and the worst rather than putting a score on a dashboard.
← Hamel Husain & Shreya Shankar, ["Building eval systems that improve your AI product"](https://www.lennysnewsletter.com/p/building-eval-systems-that-improve-your-ai-product)
(Lenny's Newsletter, 2025-09-09). M-18 and M-20 both sit dark until 20 golds exist (C2).
**Corrected 2026-09-09:** "until" was wrong -- C2 was answered *no*, so both sit dark
permanently. The bar in that quote is the bar this tool has decided not to clear; what it
publishes is a disagreement ranking, and it has to say so rather than imply a pending
human check.

**On the denominator.** The tool's own rule for WER, `docs/PRD.md` FR-S1: *"substitutions
+ insertions + deletions / **reference** word count."* The reference length, never the
hypothesis length, precisely so that a wordier hypothesis cannot lower its own rate. The
flag rate (§2, finding 1) broke that rule.

**On boosts for the production model.** Keyterm prompting is supported on nova-3 *and
Flux*, one `keyterm` parameter per term, and on Flux the list can be updated mid-stream
with a `Configure` message. **Corrected 2026-09-09 (building M-19a):** this paragraph
used to read "up to 100 plain terms". Deepgram's page states no maximum number of terms
at all -- the documented limit is *"Key Terms are limited to 500 tokens per request;
anything beyond that will return an error"*, with a recommendation to "focus on the most
important 20-50 terms". A term budget and a token budget are not the same guard: 100
short terms pass, 60 long ones may not. Keyterm prompting also covers **multilingual**
nova-3, not only monolingual.
← [Deepgram, Keyterm Prompting](https://developers.deepgram.com/docs/keyterm), read
2026-09-08 and re-read 2026-09-09. So Tune mode (Part F) has a real target on the
production model.

**On sample size.** AA-AgentTalk benchmarks streaming STT on 469 voice-agent samples,
about 250 minutes (v6 §1). This corpus holds 123 audio minutes of which about 29 % is the
customer — roughly 36 minutes of speech that can carry a signal, spread over 31
assistants. **No evidence found** in Lenny's archive for a benchmark sample-size floor
(the search returned growth-experiment material); the AA figure stands as the reference.

**Changes to the plan this evidence forced:** the monitor path is grilled with stored
implicit signals, not an LLM read of the transcript (Part E); the judge is measured
before it is trusted, so golds are a person's task on the list (C2); the rate's
denominator follows FR-S1 (A1).

---

## 2. Three things found on 2026-09-08 that nobody had seen

**Finding 1 — the honest bulk's winner is decided by filler words.** On `42769f26` the
top two providers, ElevenLabs and AssemblyAI, were flagged on **the same 4 of 17 calls**
— per-call peer flags identical on every one of the 17. ElevenLabs "wins" by 4.2 %
because its transcripts total 1,047 words to AssemblyAI's 1,003, and the rate is flags ÷
*the provider's own word count*. Counted: ElevenLabs writes **61** filler tokens (um, uh,
hmm, yeah, okay …) to AssemblyAI's **37**. The flags themselves are computed on
`canonicalTranscript`, which folds fillers *out*; the denominator is `normalizeTranscript`,
which keeps them in (`artifacts/api-server/src/lib/verdict.ts` line 304;
`artifacts/api-server/src/lib/run-executor.ts` T-19 rate). The paired bootstrap says
"outside noise" — correctly, because ElevenLabs is *consistently* wordier. The statistics
are right; the quantity is wrong. The judge's own rule 4 ("shorter is not worse") is
contradicted by the verdict that sits above it.

**Finding 2 — the same page names two winners for the same 17 calls.** The assistant
cards rank on `flagBadness` (a per-cell count plus severity, averaged) → every provider
ties → the 15 % cost term decides → **Cartesia** in 12 of 13 groups. The org banner ranks
on flags per 100 own words → **ElevenLabs**. Neither for accuracy. M-18 compares the
human-checked order against the *cards'* quantity, so it currently certifies a ranking the
banner does not show.

**Finding 3 — the boost-parity question has no subject on this corpus.** PRD v6 Part F
("Rush sends 120 keyterms; candidates run naked — not comparable") was written from the
Rush assistant. Read live 2026-09-08 through `GET /benchmark/assistants/{id}/transcriber`
on the 14 assistants with the most calls (124 of 176): **every one carries 0 keyterms and
no `numerals` setting.** Production runs naked there too. M-19's paired experiment has
one subject — Rush, 8 calls, all below the selection floors — and Tune mode (Part F) is
greenfield for 14 of 14: there is nothing to "keep / add on top / replace" (v5 E4) yet.

Bug-log entries for all three are in `docs/backlog/good-to-have.md` under 2026-09-08;
the claims they contradict are corrected where they were made (`docs/PRD-v4-technical.md`
V4-T14, `docs/PRD-v6-measure.md` D1 and F1, `docs/PRD-v5-optimize.md` Part E).

---

## Part A — One verdict, one quantity

**A1 — the denominator belongs to the call, not the provider.** In
`artifacts/api-server/src/lib/verdict.ts` every cell's `words` becomes one number per
call: the **median normalised word count over that call's `ok` cells in scope**. The same
number feeds the T-19 `peerFlagsPer100Words` in `artifacts/api-server/src/lib/run-executor.ts`.
`lib/scoring/src/verdict.ts` is unchanged in shape — `pooledRate` and the paired
bootstrap already take `{ flags, words }` per cell; they just receive the call's words
instead of the provider's. Considered and not chosen: the alignment length from
`computeCrossProviderDisagreement` (`positionCount`) is the more principled denominator
but needs a new score column; the median needs nothing and cannot be moved by one
verbose provider. **Check:** two providers with identical flags on every shared call and
one 10 % wordier → `too_close`, never `winner`; the live verdict for `42769f26`, which is
computed on read, stops naming ElevenLabs over AssemblyAI. The stored
`peer_flags_per_100_words` on `benchmark_rankings` follows on the next bulk (there is no
recompute route — O-36).

**A2 — one quantity ranks both surfaces.** The banner and the cards must read the same
number, and M-18's proxy agreement must read it too, or it certifies a ranking nobody
sees. Two candidates, one to be confirmed by Abhishek (open question 1):

- *(recommended)* **flagged-call rate** — calls on which this provider was flagged ÷
  calls scored, i.e. `1 − cleanCallRate`, which T-19 already computes and v4 called "the
  single number a non-technical reader understands immediately". Severity-weighted
  `flagBadness` breaks ties; cost breaks the rest. No denominator to argue about; the
  paired bootstrap runs on per-call 0/1 differences.
- flags per 100 words on the shared denominator from A1, everywhere.

Either way the composite weights (85 / 15) stay; only the flag component's definition
changes. **Check:** the honest bulk's cards and banner name the same order; the
`data-testid="proxy-agreement"` line's figure is recomputed on the same quantity.

**A3 — production against the pack is the headline sentence.** M-8a computes it and it
reads a real number on the customer bulk: **Flux, live on the same 17 calls, disagreed
with the consensus on 6.6 of every 100 words; the best candidate on the same audio, 2.6.**
That is the sentence a client pays for, and today it is the third line. It becomes the
first sentence of the banner and of the exported artefact, followed by the
least-disagreement sentence, with one caveat that never leaves it: production was a live
stream, the candidates ran batch on the same recording. Run visual-and-research for the
copy before building; write the evidence note beside R-3. **Check:** on `42769f26` the
first sentence names Flux, 6.6 and 2.6; on a bulk where `productionDisagreement` is null
the banner is unchanged. **Shipped 2026-09-09 (PR #119)** — and it took one correction the
check above did not ask for: 2.6 in that sentence and 0.40 in the table beneath it are not
the same measurement, so the sentence now names its own units. See `docs/scoring-policy.md`,
"Two rates on one page, and how to tell them apart".

---

## Part B — The org decides; the assistant explains

**B1 — the assistant card stops claiming a decision.** 31 assistants over 176 calls means
no assistant group will reach 12 scored calls for months, and the "Leading candidate …
Do not treat as decision-grade" sentence on every card says two things at once. The org
verdict (`clientLabel` = the Vapi account, e.g. Land And Apartment, 17 calls) already
carries the evidence rules — `PROVISIONAL_EVIDENCE_CALLS = 20`,
`MIN_SHARED_CALLS_FOR_VERDICT = 5` — and is the only surface that should say "decision".
The card's `recommendation` (built in `run-executor.ts`'s ranking aggregation) becomes
descriptive: which provider had the fewest flags and which was cheapest *on this
assistant's N calls*, and where the decision is made. The grouping key of
`benchmark_rankings` does not change; the CSV keeps every column. Visual-and-research
before the copy. **Check:** no card contains "Leading candidate"; every card names the
org verdict; the banner carries the evidence count once. **Shipped 2026-09-09 (PR
#120)** — and it needed one thing the check above did not ask for: the sentence takes two
places to write, because the aggregation cannot see the org, and All-time combined has no
verdict box for a card to point at. The check is met by the code and by every new
computation, but **not yet by the live page**: the card reads the stored `recommendation`
column, and all 29 rank-1 rows still carry the old sentence until O-84's free recompute
runs.

---

## Part C — The corpus has to grow before anything else can be measured

**C1 — the daily import is the fix for B1, not just a safety net.** M-17 stays exactly
as written. Restated here because its value changed: calls per assistant only grow with
time, and the import is the only thing that grows them without a person. Needs one
sentence from Abhishek: a `launchd` agent on his machine is acceptable.

**C2 — twenty golds, by hand. ANSWERED 2026-09-09, and the answer is no.** Abhishek:
*"no by hand thing"*. The paragraph below is kept as written so the cost of the decision
is readable, but it is not a plan any more.

> ~~A person's task, not a step: transcribe 20 customer channels from audio in the gold
> editor (about two hours). M-18 (proxy agreement) and M-20 (judge scorecard) both render
> "not measured (N of 20)" until then; every claim that the disagreement ranking tracks a
> human is unproven until then. Finish or clear the 137-character fragment on `3559ea45`
> first (O-76).~~

**What the answer costs, stated plainly rather than filed away.** The labelled set is
**2 calls** and will stay 2 (`64d8f463` at 978 characters, `3559ea45` at 137 — and the
second is the fragment O-76 is about, so the honest count is 1). Twenty is the floor both
M-18 and M-20 render against, so:

1. **This tool will never report accuracy. It reports disagreement.** Every provider's
   number on every surface is "how far this provider sits from the other providers",
   never "how far it sits from what was said". That is a real, defensible measurement —
   it is not the same measurement, and nothing may call it accuracy.
2. **The judge's pick stays unverified for the life of the project.** M-20 shipped its
   scorecard specifically so the judge could not be trusted on assertion; with no growing
   labelled set the scorecard is now permanently "not measured (1 of 20)".
3. **Two shipped lines now promise a measurement that is not coming.** `Not enough
   human-checked calls to measure this **yet** -- 2 of 20` and `Judge accuracy: not
   measured (1 of 20)` both read as a progress bar. They are not: the count is frozen.
   Fixing that wording is a register step (R-14), not a copy nit — the current wording
   tells a reader to wait for something nobody is going to do.
4. **O-76 loses its first branch.** "Finish or clear the 137-character fragment" is now
   "clear it": finishing means transcribing by hand.

**The only remaining way to get a reference without a person** is to pay a model that
listens to the audio itself (a multimodal transcription pass, independent of the five
text hypotheses being compared) and treat its output as the reference. It is automatic;
its cost has not been measured here and must not be called cheap until it is. It is also
**not a gold** — it is a sixth opinion with better ears, and any
number computed against it must be labelled as such, never as WER-against-truth. Not
proposed as a step here; it needs Abhishek's word and a go-spend, and it is written down
so the option is not rediscovered later as if it were new.

**C3 — two cents.** M-11d — the first Deepgram socket this repo has ever opened — costs
about $0.02 and unblocks M-11b, M-12, M-19b, M-21 and the streaming half of M-19. It has
been waiting on an explicit go-spend since 2026-09-07; the project's whole-life spend is
$7.21. The go-spend rule is right; it is also, today, the single bottleneck of the
streaming track.

---

## Part D — The judge knows whose call it is

**D1 — the judge reads the assistant's own prompt and vocabulary.** `judge.baml` gets
the same one-sentence domain guess for every assistant. `fetchVapiAssistantTranscriber`
already fetches the assistant object and types only `transcriber`; the system prompt
(`model.messages`, role `system`) and the `keyterm` list itself are on the same response,
unread. The judge gets an *assistant context* block — name, system prompt, keyterms —
and rule 5 ("judge from context") gets a real context. Rules, all of them: read one real
assistant object first and record the **field names** in `docs/provider-data-samples.md`
(never the prompt text — it is the client's); the prompt is read live and cached in
memory as T-97 does, never stored in the database, never logged, never sent to any vendor
but the judge; the pick stays a typed enum; the prompt hash changes, so
`pnpm run judge:contract:record` runs (cents). Record judge cost per call before and after
on one bulk; if it more than doubles, stop and report rather than ship. **Check:** the
"truck-parts / leasing / dispatch" sentence is gone from `judge.baml`; a judged scan's
prompt tokens rose by the length of the assistant's prompt and no more.

**D2 — conventions never show as differences unless asked.** Abhishek, 2026-09-08. The
diff in `artifacts/api-server/src/lib/call-comparison.ts` runs on `normalizeTranscript`
tokens, so "1-bedroom" / "1 bedroom" and "gonna" / "going to" render as substitutions.
Each **run** of consecutive non-`ok` ops whose two sides are equal under
`sameOnceCanonical` is marked `convention: true` (one boolean on `WordDiffOp`, through
`lib/api-spec/openapi.yaml`) — this sentence read "each non-`ok` op" until 2026-09-09,
which marks nothing on the two commonest pairs in the corpus, because `1 bedroom`
against `1-bedroom` aligns as a substitution plus a deletion and neither op alone is
equal to anything (R-6);
the view hides those by default — rendered as agreement, with a count "12 convention
differences hidden" and a toggle "show conventions" that renders them as today. WER and
`wordsDiffer` keep counting them: WER is WER (`docs/scoring-policy.md`), and a person
writing a gold still needs the raw diff. Nothing on screen rewrites a provider's words.
Visual-and-research first (the pattern is a code review's "hide whitespace changes").
**Check:** a hypothesis that differs from the reference by conventions only shows zero
highlighted words and the hidden count; the toggle restores today's view; WER unchanged.

---

## Part E — Which calls need checking: count the seeds before building a monitor

Abhishek's ask, 2026-09-08: *the agent should first understand which transcripts need
to be checked … we can look at only the conversations which need it.* Two things are
true at once. **The blind read was built and retired**: `flagTranscript` in
`artifacts/api-server/src/lib/agent.ts` read one transcript and guessed what sounded
wrong, and it could not know — the draft *is* a provider's output, and "unit 26" heard
as "unit 20" reads perfectly. Disagreement between providers is the signal; one
transcript read alone is not. **And the ask is right about the product**: a monitor over
production calls is a different thing from a benchmark over a fixed corpus, it is what a
client would pay for, and — per Kiriti Badam above — its trigger is implicit signals the
system already has, not an LLM opinion.

Stored per call today and read by nothing for this purpose: `source_success_evaluation`
(23 false), `prod_assistant_interruptions`, `prod_transcriber_latency_ms`,
`prod_tool_calls`, `source_ended_reason`. 239 flagged scans say which calls the free
hybrid pass flagged.

**E1 — the grill script (R-7), spends nothing.** For each signal, the 2×2 against
"latest scan for this call was flagged": calls selected, flagged among them, precision
and recall, against the base rate. Same shape as M-15's `mine-confirmed-entities.ts`,
which answered v6 D2 with a number (8) and stopped it from being built. The table and
the build / don't-build decision go back into this section. **A monitor path, if built,
never feeds `benchmark_rankings` or a verdict** — a benchmark on the hard calls only
would make the leaderboard lie and kill M-21's canary.

**What is not the answer:** an LLM reading the production transcript alone and deciding
it "makes sense". That is the retired pass under a new name.

### E1 answered — 2026-09-09, R-7 (PR #123)

`artifacts/api-server/src/mine-triage-signals.ts` (its 2×2 arithmetic in
`artifacts/api-server/src/lib/triage-signals.ts`, unit-tested against synthetic cells so
these numbers are provable without re-reading the corpus), run read-only against the dev
database `stt_evals`. 176 calls, 315 scans, 124 with a latest scan. **The corpus changed
the same day** — an accidental run of M-17's importer added 200 unscored calls, taking it
to 376 — so a re-run of the script will report different denominators. The table below is
as of the 176-call corpus; the flag rate it turns on is unaffected, because the 200 new
calls carry no scan. A scan that errored
(5) or was rejected (1) is dropped from every population: it is not a verdict, and
counting it as "not flagged" would invent one. A `null` column is dropped the same way —
"not measured" is never "no".

`sel` = the signal picked it; `prec` = flagged among selected; `rec` = of all flagged,
the share selected; `base` = the flagged share of that signal's population; `lift` =
`prec - base`; `head` = the most lift arithmetic allows, `1 - base`.

| signal | pop | sel | sel+flag | sel+ok | prec | rec | base | lift | head | seed? |
|---|---|---|---|---|---|---|---|---|---|---|
| success evaluation is false | 94 | 18 | 15 | 3 | 83.3 % | 16.7 % | 95.7 % | −12.4 pt | 4.3 pt | **untestable** |
| assistant was interrupted ≥ 1 | 26 | 25 | 22 | 3 | 88.0 % | 95.7 % | 88.5 % | −0.5 pt | 11.5 pt | no |
| transcriber latency above corpus median | 54 | 28 | 24 | 4 | 85.7 % | 49.0 % | 90.7 % | −5.0 pt | 9.3 pt | **untestable** |
| ended reason is not the customer hanging up | 113 | 68 | 64 | 4 | 94.1 % | 59.8 % | 94.7 % | −0.6 pt | 5.3 pt | **untestable** |
| no tool call was made | 56 | 13 | 12 | 1 | 92.3 % | 23.5 % | 91.1 % | +1.2 pt | 8.9 pt | **untestable** |

Seed rule, stated before the table was read: a signal is a seed when it selects at most
80 % of its population **and** its precision beats the base rate by at least 10 points.

**DECISION: do not build the monitor path on this corpus — and the table is not the
reason.** Read the `base` column: **112 of the 118 calls that carry a verdict are
flagged.** The hybrid pass flags 88–96 % of everything it looks at, so the ceiling on any
signal's lift is 4.3 to 11.5 points and the 10-point margin is unreachable **by
arithmetic** on four of the five. Those four were not tested and beaten; they could not
be tested at all. The one that had headroom (interruptions, 11.5 pt) came in at −0.5 pt
on a population of 26.

So "which calls need checking" has no useful answer here, because the answer is *nearly
all of them*. **The thing to decide first is the flag rate itself, not the trigger.** A
pass that flags 95 % of calls is either finding real disagreement everywhere — in which
case triage is pointless and the fix is provider selection, which is what this tool
already does — or its threshold is too loose, and no monitor built on top of it can be
better than it is. Both readings point away from building a trigger next.

**Open question 5 (new, for Abhishek):** is a 95 % flag rate what you expect? If yes, the
monitor idea is answered and Part E closes. If not, the next step in this area is a look
at the hybrid thresholds, not a monitor.

The script is permanent and free. Re-run it when the corpus grows or the flag rate moves:

```
pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/mine-triage-signals.ts
```

**What R-7 did not do:** touch the thresholds, build any trigger, or write anything to
the database. It only decided whether to build, and the answer is no.

---

## Part F — Tune, then write back (v5 Parts E and F, re-sequenced)

v5 Part E's premise — *"A client runs Deepgram. They are not switching."* — is now a
measured fact: 154 of 176 calls, and the honest bulk puts all five candidates within one
flag of each other. The question a client can act on is *where does Flux get our calls
wrong and what do we change*, and finding 3 says the change is greenfield: 14 of 14
assistants send Deepgram no vocabulary at all.

**F1 — Tune mode is grilled before it becomes rows** (register: "Not yet stepped", Part
E). New inputs to that grill from this document: the target is Flux (`keyterm`, up to 100
terms, `Configure` mid-stream); the seed vocabulary is the existing words-to-watch list
and the reading-pairs miner (`artifacts/api-server/src/mine-reading-pairs.ts`); the first
subject is the Land And Apartment account, whose assistants have 39, 18 and 15 calls.
**F2 — M-19 splits.** The Deepgram parameter fix (`keywords` → `keyterm` for nova-3;
Flux already sends `keyterm`) is a real bug with a unit test and no spend — M-19a.
**Shipped 2026-09-09 (PR #121).** Two things the plan here did not have right, both
corrected where they were written: no boost had ever been *sent* (the executor has never
set `keywordBoosts`), so this was a latent bug and not a repair of past results; and the
"100 terms" cap this document and five others carried is not Deepgram's — the documented
limit is 500 tokens per request. The token-budget guard therefore moves to M-19b, and F2's
question becomes how many of Rush's 120 terms fit in 500 tokens.
The boost plumbing on a bulk (M-19b) waits until Tune mode has produced a list for an
assistant that has none, because until then `boosts: production` carries an empty list for
124 of 176 calls. **F3 — write-back (v5 Part F)** stays parked behind F1 and open
question O-2 (dev accounts only, or production too).

---

## Deliberately not doing, or parked

- **M-13 (ElevenLabs realtime) and M-14 (Gladia live): parked.** Production is Deepgram
  on 154 of 176 calls; a third and fourth streaming adapter before the first socket has
  been opened (M-11d) copies an unproven pattern twice more (O-62). Built when a client
  names the vendor. M-12 (AssemblyAI streaming — the fallback transcriber on 11 of 14
  assistants) stays, after M-11d and after the socket machinery is shared.
- **M-21 (drift canary)** waits on the streaming rows it is meant to watch. Unchanged.
- **An LLM that reads one transcript and decides if it makes sense** — retired 2026-08-27,
  and Part E says why it stays retired.
- **New measurement surface of any kind** until C1–C3 have moved. The corpus cannot carry
  more numbers than it has.

## Open questions for Abhishek

1. **A2 — the one quantity:** flagged-call rate (recommended) or flags per 100 words on
   the shared denominator? Both are honest; the first is the one a CEO can repeat.
2. **C1 — M-17:** a `launchd` agent on your Mac, running the import at 03:00, is fine?
3. **C3 — M-11d:** "go spend" for about $0.02.
4. **D1 — R-5:** "go spend" for the judge-contract record plus one judged bulk (cents),
   after the token delta has been read.
5. ~~**C2:** will you transcribe 20 customer channels by hand, and when?~~ **Answered
   2026-09-09: no.** See C2 for what that costs. Replacement question, open: do you want
   a paid audio-listening model as an automatic reference instead, or does this tool
   report disagreement only, permanently?
6. Still open from v5/v6: O-1 (S-3), O-2 (write-back scope), O-8 (backup destination),
   O-9 (who signs DPAs), O-10 (F2 keyterm cap). **O-76 (the fragment gold) came off this
   list on 2026-09-09:** with hand transcription ruled out its only remaining branch is
   "clear it", which needs no decision from you and is mine to do.

## Proposed register rows

Written as full steps in `docs/step-register.md` (Part R). Order as of 2026-09-08:
**R-1 → R-3 → R-4 → M-11d (2¢) → M-17 → R-6 → R-7 → M-20 → M-19a → R-5 (cents) → M-12 →
R-2 (once question 1 is answered) → M-19b and M-21 (after streaming and Tune)**;
M-13 and M-14 parked.

| ID | Row | Spend |
|---|---|---|
| R-1 | A1 the denominator belongs to the call | none — **shipped 2026-09-08, PR #118**; the customer bulk now reads `too_close`, no winner |
| R-2 | A2 one quantity ranks both surfaces (blocked on question 1) | none |
| R-3 | A3 production against the pack is the headline sentence | none — **shipped 2026-09-09, PR #119**; the artefact and both pages now open on Flux, 6.6 vs 2.6 |
| R-4 | B1 the assistant card stops claiming a decision | none — **shipped 2026-09-09, PR #120**; live acceptance waits on O-84's recompute |
| R-5 | D1 the judge reads the assistant's prompt and vocabulary | cents (go-spend) |
| R-6 | D2 conventions hidden in the comparison view, toggle to show | none — **shipped 2026-09-09, PR #122**; 12 % of differing ops on the corpus are conventions, and the per-op rule this row specified marked none of the hyphen pairs — corrected to per-run above |
| R-7 | E1 count the triage seeds (grill script) | none |
| M-19a / M-19b | F2 the split of M-19 | **M-19a shipped 2026-09-09, PR #121** / M-19b later |
| — | C2 twenty golds: a person's task, not a step | time |
| — | F1 Tune mode: grill first, in "Not yet stepped" | — |
