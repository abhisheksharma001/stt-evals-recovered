# PRD v6 — Measure the thing the client actually runs

**Version:** 1.0
**Date:** 2026-09-04
**Source:** Abhishek, 2026-09-04 — asked for a deep look at the whole project against
the PRD, with outside evidence, and for "the final PRD on those parts". Decisions taken
the same day, in his words: *clear the 19 draft copies; yes, streaming, spend $3–5;
recommended order plus find all the gaps; no human gold gate — a manual place, optional;
the bulk path is the recommended one.*
**Companion docs:** `docs/PRD.md` (goals G1–G7 this is measured against),
`docs/PRD-v5-optimize.md` (Setup polish and Tune mode — still valid, now sequenced after
this), `docs/scoring-policy.md`, `docs/step-register.md` (the work).
**Scope rule:** nothing here adds a page. Every part either fixes what a number means
or protects the data the numbers come from.
**Implementer:** written for a Sonnet-class model. Every step in the register names the
file, what is there today, what to change, and how to check it.

---

## 0. What is true right now — read from the live system on 2026-09-04

Not from memory. Each row was queried against the API on `:8177`, the audit log, the
audio cache on disk, or the code, and the command is in the session that produced this.

| Fact | Value |
|---|---|
| Calls | 121, all `ready_to_run` — 105 property management (99 Land And Apartment), 8 rush, 8 trucking |
| Calls with a gold transcript | 21 |
| Gold byte-identical to Vapi's own draft transcript | **19 of 21** |
| Gold ever written by a person from audio | **0** — audit log: 20 rows by actor `claude-pipeline-test` on 2026-08-24, 1 by `review-ui-test`, 1 by `unknown` |
| Speaker labels (`AI:` / `User:`) inside those gold texts | yes — nothing in `normalizeTranscript()` strips them, so each label is a "word" the provider is charged for deleting |
| Mean WER shown for the rush set, every provider | 0.62–0.71 (English phone STT is normally 0.05–0.15) |
| Share of transcribed words that are the assistant's TTS voice | **71 %** (10,347 assistant words vs 4,154 customer words across the drafts) |
| Customer words per call — median / p25 | 12 / 4 |
| Calls with hand-made entity annotations | 0 (14 carry auto-extracted references) |
| Two-person de-identification attestation | 21 by `claude-pipeline-test-pass-1` / `-pass-2`, 1 by Abhishek |
| Audio sent to providers | the mono mix, both speakers |
| Production STT hears | the customer channel only (Vapi transcribes inbound audio; the assistant's words are LLM text) |
| Provider APIs used | batch / prerecorded for every vendor except Cartesia; production runs streaming; **Flux, production on 86 of 121 calls, is streaming-only and cannot be run by this tool at all** |
| Headline verdict formula | 70 % peer-consensus flags · 15 % batch turnaround time · 15 % list price — no reference anywhere |
| Keyword boosts sent to candidates | none — `keywordBoosts` exists on the adapter input type and the run executor never sets it; the Rush assistant runs 120 Deepgram keyterms in production |
| Deepgram adapter boost parameter | `keywords` (the Nova-2 parameter); Nova-3 and Flux use `keyterm` per Deepgram's docs |
| API bind address | `*:8177` — every interface, no auth |
| Database backups | none exist; the corpus, every paid raw provider output and every score live in one local Docker volume |
| Scheduled import | none; Vapi deletes audio after 14 days; 6 calls' audio is already gone for good |
| Vendor data-handling record (`docs/data-governance.md` §4, the gate that says "no audio is sent until documented") | every checkbox unticked; audio has been sent to six vendors |

### What this means, in one paragraph

Every WER the tool has ever shown measured agreement with Vapi's own live transcriber,
not accuracy — and 71 % of that agreement was on robot speech. The harness around it
(resumable runs, stored raw output, manifests, the paired bootstrap, 195 tests) is
sound and stays. The reference, the audio, and the product under test were wrong.
Fixing those three is cheaper than most of what was built on top of them.

### The three decisions taken 2026-09-04

1. **No human gold gate.** Gold stays a manual option on a call; nothing requires it.
   The bulk path — gold-free consensus, automatic on every run — is the recommended one.
   This PRD makes that path honest instead of replacing it.
2. **The 19 draft-copied gold texts are cleared.** They were never gold. WER becomes
   absent on those calls, which is the truthful value.
3. **Streaming, yes.** ~$3–5 of provider spend to run the corpus through each vendor's
   streaming product, the one production actually uses.

---

## 1. What the people who do this seriously do

Evidence note, per the visual-and-research skill. Looked for: how voice-agent STT is
benchmarked when it is done for a buying decision, not a marketing chart.

**Pattern to use.**
- A separate **streaming** benchmark, audio paced at real time, latency defined as
  *end of speech → first partial / final transcript* — never file turnaround.
  ← Artificial Analysis, [AA-WER Streaming](https://artificialanalysis.ai/articles/new-streaming-speech-to-text-benchmark-aa-wer-streaming)
  and their [methodology](https://artificialanalysis.ai/speech-to-text/methodology)
  (AA-AgentTalk: 469 voice-agent samples, ~250 min; streams "in real time in 20 ms
  chunks"; latency "from end of speech to that final-denoted transcript").
- **Your own production audio**, sliced by condition, with entity preservation as a
  first-class metric: "accuracy on alphanumeric IDs … drops to 50–70 %" while general
  WER looks fine. ← [Coval, 2026](https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/)
- **Slot / entity error rate** alongside WER, because three slots at 85 % each is 61 %
  of transactions correct. ← [Deepgram, Slot Error Rate](https://deepgram.com/learn/slot-error-rate-developer-guide-asr-accuracy);
  [Hamming, ASR evaluation for voice agents](https://hamming.ai/resources/asr-accuracy-evaluation-for-voice-agents)
  (drift alert when WER moves > 2 points from baseline on a fixed set).
- **Paired bootstrap** for "is the difference real" — already built here — and
  **blockwise** resampling when calls share a speaker or assistant.
  ← [Bisani & Ney 2004](http://www-i6.informatik.rwth-aachen.de/PostScript/InterneArbeiten/Bisani_BootstrapEstimatesForConfidenceIntervalsInASRPerformanceEvaluation_ICASSP_2004.pdf);
  [blockwise bootstrap](https://www.researchgate.net/publication/338115886_Statistical_Testing_on_ASR_Performance_via_Blockwise_Bootstrap)
- A **normaliser everyone can read**: the Open ASR Leaderboard publishes its Whisper-based
  normaliser and its code. ← [Open ASR Leaderboard paper](https://arxiv.org/abs/2510.06961v1).
  Ours is written down in `docs/scoring-policy.md`; that stays.

**Patterns to avoid.**
- Judging a judge by accuracy on an imbalanced set; measure TPR and TNR against a
  human-labelled set, and "Can't the AI just eval it? It doesn't work."
  ← Hamel Husain & Shreya Shankar, ["Building eval systems that improve your AI product"](https://www.lennysnewsletter.com/p/building-eval-systems-that-improve-your-ai-product)
  (Lenny's Newsletter, 2025-09-09) and the [podcast](https://www.youtube.com/watch?v=BsWxPI9UM4c) (2025-09-25).
- Giving an audio-capable model the audio **and** candidate transcripts and asking it to
  pick: it follows the text 10–26× more often than it should. If audio ever joins the
  judge, it transcribes the disputed span blind. ← ["When Audio-LLMs Don't Listen"](https://arxiv.org/abs/2602.11488) (2026).
- Reference-free ranking without a calibration set: it works ("high correlation with
  WER ranks") only after the semi-supervised step that uses a referenced dataset.
  ← [NoRefER](https://arxiv.org/abs/2306.12577).

**What operators say.**
- "Evals or production monitoring" is a false dichotomy — implicit production signals
  tell you which traces to look at; the eval set is built from what they surface.
  ← Kiriti Badam, Lenny's Podcast, 2026-01-11. For this tool the production signals
  already exist per call in Vapi (transcriber latency, endpointing latency,
  interruptions, tool-call outcomes, `successEvaluation`) and were never read.
- One trusted domain expert beats a committee; 10–100 human-labelled examples is the
  starting bar. ← Hamel & Shreya (above); Aman Khan, ["Beyond vibe checks"](https://www.lennysnewsletter.com/p/beyond-vibe-checks-a-pms-complete-guide-to-evals)
  (2025-04-08). Abhishek chose no gate; the manual place still counts every example
  anyone does label (Part D4).

**Changes to the plan this evidence forced:** streaming as a first-class mode (Part C);
end-of-speech latency replaces file turnaround (C6); entity references from confirmed
tool calls (D2); production monitoring signals stored per call (D3); the verdict says
"least disagreement", not "winner" (D1); a drift canary on a fixed set (E6).

**No evidence found for:** a public method that turns a voice agent's tool-call
arguments into an entity reference (D2). It is derived here from the slot-error-rate
literature and must be verified on real calls before it is trusted.

---

## Part A — Truth first

**A1 — the bug log and the claims.** Findings above go into
`docs/backlog/good-to-have.md` with their evidence. The claims that are now false are
corrected where they were made: `.claude/CLAUDE.md` ("scores each one against a
human-corrected gold"), `.claude/STANDARDS.md` (✅ on "WER against a human-corrected
gold transcript" and on "two-person de-identification attestation"),
`docs/scoring-policy.md` (two new known gaps: speaker labels, mixed audio).
Done in the PR that carries this document.

**A2 — clear the 19.** A backfill script in the same shape as the existing ones
(`artifacts/api-server/src/backfill-t65-t66.ts`, run through
`scripts/apply-backfills.sh`): for every call whose `goldTranscript` equals its
`draftTranscript`, set `goldTranscript` to null and write an audit row (`call:update`,
actor `backfill-m2-clear-draft-gold`, before/after). Status stays `ready_to_run` —
gold is optional now. The two calls whose gold differs from the draft (`3559ea45`,
`64d8f463`) are left alone; the audit log says a person touched them. Existing score
rows keep their stored WER (they are history, and the manifest still explains them);
Results already shows WER as absent when no gold exists.
**Check:** `GET /benchmark/calls` returns exactly 2 calls with a non-empty
`goldTranscript`, both different from their draft.

**A3 — speaker labels never count as words.** `lib/scoring/src/index.ts`
`normalizeTranscript()` gains one rule, before lower-casing: a line-leading `AI:` or
`User:` (the two labels Vapi writes) is removed. Documented as rule 0 in
`docs/scoring-policy.md`; `SCORING_VERSION` bumps. This protects the manual path: a
person who pastes a draft to start from and edits it must not inherit the labels as
deletions. It also fixes the call comparison, which uses the draft as the reference
when no gold exists (`artifacts/api-server/src/lib/call-comparison.ts`).
**Check:** unit test — gold `AI: hello there\nUser: hi` vs hypothesis `hello there hi`
scores WER 0.

**A4 — the API listens on localhost only.** `artifacts/api-server/src/index.ts`
`app.listen(port, …)` binds every interface today. The UI is served by the same
process on the same laptop; nothing needs another interface. Bind `127.0.0.1`
unless `HOST` is set. **Check:** `lsof -nP -iTCP:8177 -sTCP:LISTEN` shows
`127.0.0.1:8177`; the UI still loads at `http://localhost:8177`.

---

## Part B — Score the customer, not the robot

**What Vapi actually returns.** Probed against a real Land And Apartment call on
2026-09-04 (`GET /call/{id}`): `artifact` carries `presignedCustomerUrl`,
`presignedAssistantUrl`, `presignedStereoUrl` (2 ch, 16 kHz, 16-bit; channel 0 is
silent during the greeting, so channel 0 = customer, channel 1 = assistant),
`presignedMonoUrl`, `messages` (each `user` turn with `time`, `endTime`, `duration`,
`secondsFromStart`; `tool_calls` and `tool_call_result` messages), and
`performanceMetrics` (`transcriberLatencyAverage`, `endpointingLatencyAverage`,
`numAssistantInterrupted`, per-turn `turnLatencies`). The customer file has the same
duration as the mono file — it is the mono recording with the assistant silenced,
so timings line up. None of this was known when the import was written; it is now in
`docs/provider-data-samples.md`.

**Rescue, done 2026-09-04.** The 99 Land And Apartment calls were recorded 2026-08-25
and 2026-08-26, i.e. their audio expired on 2026-09-08/09. All 99 customer files, 99
assistant files and 99 artifact JSONs were saved into the gitignored
`artifacts/api-server/audio-cache/` the same day (`<callId>.customer.audio`,
`<callId>.assistant.audio`, `<callId>.artifact.json`; 586 MB total), by
`scripts/rescue-customer-audio.mjs` — a Vapi download, no provider spend. The 22
Default-account calls answer 400 (past retention, expected); they keep mono only.

**B1 — the run uses the customer channel when it exists.** `readCellAudio` in
`artifacts/api-server/src/lib/run-executor.ts` prefers `<callId>.customer.audio` and
falls back to the mono file; the result row records which
(`audioSource: "customer" | "mono"`, new text column on `benchmark_results`, in the
manifest too). A bulk never mixes: the preview (`artifacts/api-server/src/lib/bulks.ts`)
excludes calls without customer audio when the criterion `requireCustomerAudio` is
true, and it is true by default. Rankings and the verdict read only cells whose
`audioSource` matches the bulk's. **Check:** a bulk launched today on Land And
Apartment shows "99 matched"; every result row of it says `customer`; a run that
includes a Default-account call says `mono` on that row.

**B2 — import saves the customer channel from now on.** The Vapi import
(`artifacts/api-server/src/routes/benchmark.ts`, the `vapi/import` handler) already
caches mono at import time; it now also saves the customer file, the assistant file
and the artifact JSON, through `artifacts/api-server/src/lib/audio-cache.ts`. The
rescue script becomes unnecessary for new calls. **Check:** import one new call;
three new files appear in the cache; the Calls chip reads "customer audio saved".

**B3 — the production transcript joins the comparison.** The draft's `User:` lines
are exactly what production (Flux) produced for the customer channel. They become a
participant in every consensus computation, labelled *production (as recorded)*,
never a candidate you could pick — it is the baseline. This gives the number the
tool could not give before: **production's own disagreement rate against the pack,
on the same calls**, without running Flux. `lib/scoring/src/hybrid.ts`
`computeCrossProviderDisagreement()` takes it as one more candidate; the verdict
(`lib/scoring/src/verdict.ts`) reports `vsProductionPct` from it instead of from a
provider row that has no cells. **Check:** Results' production line reads a real
number on the Land And Apartment bulk; `deepgram-flux-general-en` no longer needs to
resolve to a row.

---

## Part C — Streaming: the product the client runs

Each vendor's streaming product becomes its own provider row, `<vendor>-<model>-streaming`,
priced from the vendor's page on the day it is added, with `supportsStreaming` meaning
*this row streams*. Audio is paced at real time in 20 ms chunks (AA's convention) from
the customer file. Latency per cell is **end of audio → final transcript**
(`latencyFinalMs`) and **end of audio → first partial** (`latencyFirstPartialMs`); the
executor already stores both.

| Row | Product / endpoint | Price seen 2026-09-04 |
|---|---|---|
| C1 `deepgram-nova-3-streaming` | `wss://api.deepgram.com/v1/listen` | $0.0043/min (list) |
| C1 `deepgram-flux-general-en-streaming` | `wss://api.deepgram.com/v2/listen` (Flux requires v2) | $0.0065/min ([Deepgram pricing](https://deepgram.com/pricing)) |
| C2 `assemblyai-universal-streaming` | Universal-Streaming WebSocket | $0.15/hr ([AssemblyAI](https://www.assemblyai.com/pricing)) |
| C3 `elevenlabs-scribe-v2-realtime` | Scribe v2 Realtime WebSocket | $0.39/hr ([ElevenLabs](https://elevenlabs.io/pricing/api)) |
| C4 `gladia-solaria-live` | live v2 WebSocket ([docs](https://docs.gladia.io/chapters/speech-to-text-api/pages/live-speech-recognition)) | $0.75/hr self-serve |
| — | Cartesia `ink-whisper` already streams (`lib/stt-providers/src/adapters/cartesia.ts`) | unchanged |

Corpus is 123 audio minutes; customer-channel bytes are the same length, so the first
full pass is under $5 across all five. **Each streaming row is one register step**
(C1 first: it is the production vendor and Flux is the production model), each with the
same acceptance: WHEN one cached customer file is streamed at real time THEN the cell
SHALL store a final transcript, `latencyFinalMs` measured from the last audio byte
sent, and the raw message log — and the adapter SHALL never send faster than real time
(the Cartesia lesson: vendors behave differently when fed faster).

**C6 — latency means end-of-speech latency, or nothing.** `latencyFinalMs` on a batch
row stops feeding the composite (`lib/scoring/src/hybrid.ts` `HYBRID_RANKING_WEIGHTS`:
latency weight to 0 for rows with `audioSource`-agnostic batch mode; the weight returns
for streaming rows only). Results' "Speed" column
(`artifacts/stt-benchmark/src/pages/Rankings.tsx`, label at the `latencyFinalMs`
entry) reads "—" for batch rows and "end of speech → final, median" for streaming rows,
next to production's own `transcriberLatencyAverage` from D3. **Check:** re-rank the
Land And Apartment bulk; Cartesia's rank no longer moves when the latency weight
changes.

---

## Part D — Say what the verdict is, and anchor it without a human

**D1 — "least disagreement", not "winner".** `lib/scoring/src/verdict.ts` keeps its
decision logic; the words change. `artifacts/stt-benchmark/src/pages/Rankings.tsx`
(the chip that reads "Winner") and `artifacts/api-server/src/lib/verdict-artefact.ts`
(the `winner: "Winner"` label and the explanatory paragraph) say **"Least
disagreement"**, and one permanent line under the verdict reads: *"Relative: how often
each provider disagreed with the others on the same customer audio. Not a measured
accuracy — no transcript here was checked by a person."* When D4's count is above zero
the line adds: *"On N calls a person did check, this ranking agreed with the
transcript-checked ranking X % of the time."* **Check:** grep the UI package and the
artefact for the word "Winner" — only test names and comments remain.

**D2 — entity references from confirmed tool calls.** 74 of the 99 rescued calls made
tool calls; the entity-bearing ones (`fly-APPFOLIO_FIND_TENANT`, `CREATE_SHOWING`,
`FIND_SHOWING`, `AVAILABILITY`, `CREATE_WORK_ORDER`, `SEND_SMS`, `dynamic_send_email`)
carry arguments — a phone number, an email, a name, a date — that the customer said
and the tool then acted on. Where the tool result reports success **and** the value
appears in the customer's own turns of the draft, the value is a confirmed entity:
written to `entityReferences` with `source: "tool_call_confirmed"` and the tool name.
Entity matching becomes exact-token (fixing the substring gap in
`docs/scoring-policy.md`). **Grill first, on real data:** a script counts how many
confirmed values exist and how many appear verbatim in the customer turns; below 10
the step is not worth building yet.

**D3 — production monitoring signals, stored per call.** From the artifact:
`transcriberLatencyAverage`, `endpointingLatencyAverage`, `numAssistantInterrupted`,
tool-call count and success, `endedReason` (already stored), `successEvaluation`
(already stored). Read 2026-09-04 across the 99: transcriber latency median **272 ms**,
endpointing median 102 ms, 25 calls with at least one interruption, 74 true / 13 false /
12 absent on `successEvaluation`. Columns on `benchmark_calls`, filled at import (B2)
and by a one-time backfill from the saved artifact JSONs. Shown on the Calls row and as
the "production today" line on Results beside C6's streaming latency. **Check:** the
Land And Apartment card on Results reads "production: 272 ms transcriber latency,
25/99 calls interrupted".

**D4 — the manual place stays, and counts.** The call page's gold editor is untouched;
no status gate depends on it. New: `GET /benchmark/proxy-agreement` — for every call
with a human-written gold (never a draft copy: `goldTranscript !== draftTranscript`),
rank providers by WER and by consensus disagreement, report Kendall τ and top-1
agreement, with N. Shown in D1's line. Zero labelled calls shows "0 checked" — never
a number. **Check:** with N = 0 the endpoint returns `{ n: 0, agreement: null }`.

**D5 — the judge gets a scorecard only when it can be measured.** Same source as D4:
where a human gold exists, the judge's pick either is or is not the lowest-WER
provider. Below 20 labelled calls the Results chip says "judge accuracy: not measured
(N of 20)". No new prompt work.

---

## Part E — Keep the corpus alive, safe and representative

**E1 — a nightly database backup.** There is none. A new script, scripts/backup-db.sh (plain: not written yet), runs
`pg_dump` (custom format) of the `:5433` database into `~/gh-projects/stt-evals-backups/`
with the date in the name, keeps 30, and prints size; a `launchd` agent runs it at
02:00; `docs/runbooks/deploy-and-rollback.md` gains a restore recipe **that has been
exercised once** into a scratch database. **Check:** a restore into `stt_evals_restore`
lists the same call count as live.

**E2 — a daily import so nothing crosses the 14-day cliff again.** A `launchd` agent
calls the existing import for each account with the last 2 days, then the free audio
cache (B2 saves customer + assistant + artifact). No STT, no spend. **Check:** the
agent runs once by hand; the audit log shows `call:import_vapi` with actor `scheduler`.

**E3 — the selection band counts customer words, not seconds.** `lib/bulks.ts`'s
`minDurationSeconds` stays; a new `minCustomerWords` (default 30, from the draft's
`User:` lines) excludes the calls that cannot carry a signal — 60 of 121 today are
under 30 s and half have ≤ 12 customer words. The preview names the bucket
("excluded: fewer than 30 customer words — 61"). **Check:** the default preview on Land
And Apartment matches fewer calls and every matched one has ≥ 30 customer words.

**E4 — the data-handling record.** `docs/data-governance.md` §4 gets one filled-in
block per vendor already sent audio (AssemblyAI, Cartesia, Gladia, Deepgram, ElevenLabs,
OpenAI): training opt-out, retention, DPA availability, with the vendor page linked and
the date read. A vendor that fails the doc's own gate (V3/V4) is disabled in Setup
until resolved. No code. Abhishek signs the DPAs; the doc records the state.

**E5 — a drift canary.** A saved bulk template "canary — 20 fixed calls" on customer
audio, run monthly on every ready row (about $0.50). The trend chart already exists;
a provider whose disagreement rate moves more than 2 points from its own median gets a
"changed since last month" chip on Setup. ← Hamming's 2-point threshold.

---

## Part F — Boost parity: the Rush question

Production Rush runs 120 Deepgram keyterms; candidates run naked. Not comparable.

**F1 — candidates get the assistant's own boosts.** The bulk preview already reads the
assistant's live transcriber config (`artifacts/api-server/src/lib/assistant-transcriber.ts`).
Its `keyterm` list is mapped per vendor — Deepgram `keyterm` (not `keywords`: fix
`lib/stt-providers/src/adapters/deepgram.ts` for nova-3 and Flux), AssemblyAI
`keyterms_prompt`, Gladia `custom_vocabulary`, ElevenLabs keyterms, Speechmatics
`additional_vocab` — passed as `keywordBoosts`, and hashed into the manifest
(FR-P2, R6). A bulk carries `boosts: "production" | "none"`; two bulks on the same calls
are the paired experiment OD-8 asked for. **Check:** the manifest of a boosted bulk
lists the terms' hash; the same call scored with and without boosts differs on Results
and both rows say which they are.

**F2 — the keyterm cap.** Deepgram accepts at most 100 keyterms / 500 tokens and
recommends 20–50 ([docs](https://developers.deepgram.com/docs/keyterm)); Flux boosts
differently. Rush sends 120. One test call with 120 terms, then 100, then 50, on the
same audio, transcripts diffed. Report the finding on the Rush assistant's Setup line.
Costs three transcriptions.

---

## Deliberately not doing

- A human gold gate, a review queue, or annotator tooling — decided 2026-09-04.
- An audio-listening LLM judge — the modality-arbitration result says it would follow
  the text; revisit only as blind span transcription, and only after D5 can measure it.
- Speechmatics streaming — no key.
- Diarization scoring (PRD G4, FR-S4) — the customer channel makes it moot for this
  corpus.
- Real PII redaction of audio — E4 records what each vendor does with it instead.

## Open questions for Abhishek

1. **E1 backup destination:** local folder only, or also a cloud bucket / iCloud Drive?
   Local-only still dies with the laptop.
2. **E4:** who signs vendor DPAs — Ellavox as processor for the client's callers? This
   is a legal question the tool can only record.
3. **F2:** three paid Deepgram calls to test the keyterm cap — pre-approved as cents,
   or a "go spend" each time?
4. **E3 threshold:** 30 customer words as the default floor, or lower for the transfer-
   heavy Land And Apartment assistants (median 2 customer turns per call)?

## Proposed register rows

Written as full steps in `docs/step-register.md` (Part M). Order agreed 2026-09-04:
truth → bind → backup → customer channel → verdict wording → streaming → anchors →
scheduler and band → boosts → Setup polish (S-2 … S-7 from v5).

| ID | Row |
|---|---|
| M-1 | A2 clear the 19 draft-copied gold (backfill + audit) |
| M-2 | A3 speaker labels never count as words |
| M-3 | A4 bind the API to localhost |
| M-4 | E1 nightly `pg_dump` + exercised restore |
| M-5 | B1 run on the customer channel; `audioSource` on results and manifest |
| M-6 | B2 import saves customer + assistant + artifact |
| M-7 | D3 production signals stored and shown |
| M-8 | B3 production transcript joins the consensus |
| M-9 | D1 "least disagreement" + the relative line |
| M-10 | C6 latency = end of speech or nothing |
| M-11 | C1 Deepgram streaming rows (nova-3, Flux) |
| M-12 | C2 AssemblyAI Universal-Streaming row |
| M-13 | C3 ElevenLabs Scribe v2 Realtime row |
| M-14 | C4 Gladia live row |
| M-15 | D2 confirmed-entity references (grill script first) |
| M-16 | E3 band by customer words |
| M-17 | E2 daily scheduled import + cache |
| M-18 | D4 proxy-agreement endpoint + line |
| M-19 | F1 boosts from the assistant's config, Deepgram `keyterm` |
| M-20 | D5 judge scorecard when measurable |
| M-21 | E5 drift canary template + chip |
| — | E4 vendor record, F2 keyterm cap: not stepped until the questions above are answered |
