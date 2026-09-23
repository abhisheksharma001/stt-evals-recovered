# PRD v8 — Watch: a daily sample of real calls, per org, per agent, and a way in from code

**Ask (Abhishek, 2026-09-14):** pull every direct Vapi call, every day; pick the ones whose
STT looks weak by a customizable rule; run the automated tests on them (10 a day,
customizable, ceiling 500), set per org and per agent; show it in a layered view that
says where STT went wrong and what else was going on; and let people drive it from code —
a Claude Code plugin, an SDK, a terminal. *"But we need to decide on USP first … otherwise
it is just another AI slop thing."* Also: *"not sure if there is standard benchmarking for
all the STT platforms and if we can do something with it."*

This document is the grill (`~/.claude/skills/mystandard/SKILL.md` §1) written down, then
the spec, then the steps. Everything under "true right now" was read from the running
system or the tree on 2026-09-14; nothing is from memory.

---

## 0. What is true right now — read live 2026-09-14

**Corpus and traffic.** 376 calls in the corpus (`GET /benchmark/dashboard`), 353 of them
from the Land And Apartment account, across **36 assistants** (top five hold 77 / 36 / 31 /
22 / 19 calls). Three Vapi accounts are configured, each behind its own env var
(`GET /benchmark/vapi/accounts` — names only): Default, Land And Apartment, Leasing Dev.
`scripts/daily-import.sh` measured **257 calls in one day** on Land And Apartment
(252 importable) — and that script is **not scheduled**: the runbook says *"No launchd
agent is installed"* and the go/no-go is still open (memo O-79, O-90).

**Production signals already stored per call** (`lib/db/src/schema/benchmark-calls.ts`):
`sourceEndedReason`, `sourceSuccessEvaluation`, `prodTranscriberLatencyMs`,
`prodEndpointingLatencyMs`, `prodAssistantInterruptions`, `prodToolCalls`. Live: 235 of
376 calls carry a transcriber latency, 121 carry an interruption count. The saved
`<callId>.artifact.json` also holds **per-turn** `turnLatencies` with `modelLatency`,
`voiceLatency`, `transcriberLatency`, `endpointingLatency` — read by nothing yet.

**Vapi exposes no per-call STT quality number.** The artifact carries `messages` (role,
text, seconds), `performanceMetrics`, `transcript`, `endedReason`, `analysis`, `costs`.
No word confidence, no STT score. The only STT-quality signal this system has is the one
it makes itself: disagreement between providers after re-transcription.

**Sampling, scheduling, money — what exists.** `bulk_templates` already hold unfrozen
criteria with a rolling `lastNDays` window, provider list and duration band, re-resolved on
every `POST /benchmark/bulk-templates/{templateId}/launch`. `POST /benchmark/bulks/preview`
dry-runs the same matcher and prices it. The FR-BLK-5 cost gate holds any bulk over
`BULK_COST_THRESHOLD_CENTS` (default $50) in `awaiting_confirmation`. Seven providers are
`ready` at $0.0022–$0.0102 per minute; the sum across all seven is **$0.0395 per audio
minute**. This month, live: STT $3.30 for 515 cells, judge $0.69 for 97 judgements
(the dashboard's micro-cent totals, 10,000 micro-cents to the cent).

**Nothing schedules a launch.** No cron, no interval, no scheduler in
`artifacts/api-server/src`. Templates launch when a person clicks.

**The verdict machinery is done.** `computeVerdict` (`lib/scoring/src/verdict.ts`) —
pooled peer flags per 100 words, 1,000-iteration bootstrap, `too_close` when the interval
holds zero. `GET /benchmark/trend` already returns one summed cell per (finished bulk,
account, assistant, provider) on the T-19 basis — the raw material for a per-agent line
over time. `GET /benchmark/words-to-watch` and `GET /benchmark/disagreement-spans` already
say **where** providers split inside a call.

**The code surface today.** `lib/api-spec/openapi.yaml` (55 paths) generates
`lib/api-client-react` (TanStack hooks over `custom-fetch.ts`) and `lib/api-zod`. One CLI
exists, `scripts/src/import-vapi-calls.ts`, a thin wrapper over the import routes. No
plain SDK, no MCP server, no plugin. **No auth** (B-1 open): the API is localhost plus a
CORS allowlist (`artifacts/api-server/src/lib/cors-origins.ts`).

**Vapi API facts, verified against docs 2026-09-14.** `GET /call` takes `limit`
(default 100; this repo caps at 1,000 per page and walks newest→oldest), `createdAtGe/Le`,
`assistantId` (observed unreliable — filtered client-side here). Only the **private** key
can list calls; a public key is scoped to web-call creation and cannot read data. REST
rate limits are undocumented; Vapi documents call concurrency, not requests per minute.
Recordings are deleted 14 days after the call.

**The block from PRD v7 Part E (2026-09-09, R-7).** A monitor path was grilled and
**rejected**: the hybrid pass flags 88–96 % of every call it looks at, so no stored
production signal could beat the base rate by the 10-point seed rule — four of five could
not be tested *by arithmetic*. Open question 5 of v7 is still open: **is a 95 % flag rate
what you expect?** This PRD does not get to build a "pick the bad calls" trigger until
that is answered. §3 says how it proceeds anyway.

---

## 1. USP — what this brings that is not easily had

### 1a. What was checked

- **This repo.** Comparison, verdict, per-bulk scoping, judge, trend, words-to-watch,
  disagreement spans, templates, cost gate, daily import script: **built**. Scheduler,
  per-agent policy, layered org→agent→call screen, attribution to non-STT layers, SDK /
  CLI / MCP / plugin, public calibration set: **not built**.
- **Installed skills** (`ls ~/.claude/skills`, 57): `voice-agents`,
  `voice-ai-development`, `multimodal-whisper` (Whisper via HF), `prd`. None does
  production sampling or STT comparison; none removes the need to build.
- **Public benchmarks.** Three exist and are all on public audio:
  - [Open ASR Leaderboard](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard)
    ([paper](https://arxiv.org/html/2510.06961v1)): AMI, Earnings-21/22, GigaSpeech,
    LibriSpeech, SPGISpeech, TED-LIUM, plus multilingual; Whisper-style normalisation;
    open models only; the authors themselves note it "overwhelmingly emphasize[s]
    English and short-form" and list far-field / domain audio as future work.
  - [Artificial Analysis](https://artificialanalysis.ai/speech-to-text/non-streaming):
    AA-WER v2 = AA-AgentTalk 50 % + VoxPopuli 25 % + Earnings22 25 %, ~8 hours; hosted
    vendors; top of table 1.7–3.6 % WER. Datasets and ground truth are proprietary.
  - [Pipecat stt-benchmark](https://github.com/pipecat-ai/stt-benchmark) (BSD-2, Daily):
    1,000 real user utterances at 16 kHz mono from `smart-turn-data-v3.1`, Gemini-drafted
    and human-reviewed ground truth, **semantic WER** judged by an LLM (ignores fillers,
    contractions, number format; counts meaning changes, hallucinations, wrong
    names/numbers), TTFS from end of speech. 22 services. Every service under 4.4 %.
    Stated limits: English only, single distribution, *"may not represent enterprise
    telephony or accented speech."*
  - The telephony classics — Switchboard, CallHome, Fisher — are 25–35 years old, 8 kHz
    landline, and the CallHome human reference itself differs 1.66× between two
    competent teams ([Kili 2026](https://kili-technology.com/blog/asr-models-guide-word-error-rate-benchmarks-and-failure-modes-2026)).
    Not a yardstick for a 2026 Vapi leasing line.
  - Vendors publish their own: [AssemblyAI](https://www.assemblyai.com/blog/word-error-rate-is-broken)
    argues WER is broken and proposes semantic WER + missed-entity rate + LLM judge, and
    reports 12.0 % missed-entity rate on medical terms vs competitors' 13 %+. Vendor
    numbers on vendor-chosen sets.
- **Competitors** (voice-agent QA, 2026):
  - [Roark](https://roark.ai/blog/how-to-test-vapi-voice-agents) — Vapi-native, API-key
    sync of 90 days of calls, 64+ metrics, audio-native (dead air, overlaps, stress),
    PSTN replay. **"Roark does not re-transcribe or compare STT providers. It works within
    Vapi's existing pipeline."**
  - [Coval](https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/)
    — runs *your* test set unchanged across Deepgram / AssemblyAI / OpenAI; **you bring the
    test set** with ground truth. Their own words: *"The honest answer to 'most accurate'
    is 'most accurate on your audio,' which requires measuring directly."*
  - Cekura, Hamming — simulation-first; Hamming audio-native; both monitor live calls,
    neither re-transcribes through alternative vendors.
  - Vapi's dashboard — transcript, logs, analysis, latency summary per call
    ([Mobbin screen](https://mobbin.com/screens/007a4823-5c3d-4016-b2d1-8637a49cb015));
    no transcriber comparison; fallback transcriber is a config, not a measurement.
  - Vapi ships its own [MCP server](https://github.com/VapiAI/mcp-server) (`list_calls`,
    `get_call`, assistants, tools) and a [Claude Code skills plugin](https://github.com/VapiAI/skills)
    (`/plugin marketplace add VapiAI/skills`). Coding agents already reach Vapi; nothing
    reaches an STT verdict.

### 1b. The USP, in one sentence

> **For each client org and each agent, on that org's own callers, every day, this tool
> says whether the STT they run is still the right one — with a noise floor, without a
> human transcript, at cents per day — and hands over the exact calls and words where it
> went wrong.**

What makes it hard to copy is not the dashboard. It is the combination the evidence says
nobody else has:

1. **Re-transcription of real production calls through N vendors** (Roark: explicitly no;
   Coval: bring your own set; public leaderboards: public audio).
2. **A verdict that refuses to name a winner it cannot support** — the bootstrap noise
   floor, `too_close`, `callsToSettle`. Every leaderboard above prints one number and
   ranks on it.
3. **No gold transcript needed** — consensus + entity mismatch + judge. Coval and every
   WER benchmark need ground truth, which is the single thing this client base will never
   produce (*"no by hand thing"*, 2026-09-09).
4. **The money is in the sentence** — $/min sits next to the flag rate; the verdict is
   "cleaner by X per 100 words, $Y/min cheaper, on N shared calls."

### 1c. What is *not* a USP, and must not be sold as one

- Another observability dashboard (Roark, Cekura, Vapi already have one).
- An LLM that reads a transcript and says it "looks fine" — retired 2026-08-27, stays
  retired (v7 Part E).
- Latency numbers — the repo measures file-return time, not end-of-speech (M-10a).
- "AI-powered insights." The insight here is arithmetic anyone can re-run.

### 1d. The anti-slop test

The claim in 1b is falsifiable, and §5 Part F builds the falsifier: run the same
adapters on the public Pipecat set where gold *does* exist and check that the no-gold
rank agrees with the gold-WER rank. ≈ $6.32 for all seven providers (159.9 audio
minutes, measured from the set's own `duration_seconds` column on 2026-09-14). If it does not agree,
the USP is not true yet and the tool must say so. That test, not a feature, is what
separates this from *"another AI slop thing."*

---

## 2. What the people who do this seriously say

- **Hamel Husain & Shreya Shankar**, *Building eval systems that improve your AI product*
  (Lenny's, 2025-09-09, https://www.lennysnewsletter.com/p/building-eval-systems-that-improve-your-ai-product):
  *"start with random sampling to develop your intuition"* — then *"sample interactions
  that are more likely to yield insights … negative user feedback, outliers in
  conversation length, number of tools, and high latency."* Production monitoring is *"a
  discovery engine for new failure modes"*; run the expensive evaluators
  *"asynchronously"* on *"a sample"*; a CI golden set is *"not a random sample of
  production data; it is a purpose-built stress test"*. → **Random first, signals
  second; and the daily sample and the golden set are two different things.**
- **Kiriti Badam** (podcast with Aishwarya Naresh Reganti, 2026-01-11): *"if you're a high
  throughput … customer, you cannot practically sit and evaluate all the traces. You
  need some indication … all of these other implicit signals and explicit signals … are
  going to communicate back to you what are the traces that you need to look at."* →
  **The trigger is implicit signals the system already has** — `endedReason`,
  interruptions, latency, success evaluation — not an opinion.
- **Anish Acharya** (a16z, 2026-09-06): *"moats are most often discovered, not
  designed"*; the classic moats are *"network effects, scaled advantages, brand effects,
  proprietary data or … a cornered resource."* → The cornered resource here is **a
  client's re-transcribed production corpus that grows every day** and nobody else holds.
- **Lenny's, *How to do AI analysis you can actually trust*** (2026-02-17): counting
  mentions is not evidence; say what a signal can and cannot tell you. → Every number on
  the new screen carries its denominator and its "cannot tell you" line.

---

## 3. Getting past v7 Part E

Part E's block is real and stays: a *binary* "this call was flagged" fires on ~95 % of
calls, so nothing can pick "the bad 10 of 250" on that bit. Three consequences shape this
PRD:

1. **Selection is not "STT threshold"; selection is criteria, then random.** Vapi gives no
   STT score before we transcribe, and our own flag bit is saturated. So the daily
   sample is drawn **at random within the criteria** (Hamel: random first), and the
   criteria are the implicit signals Kiriti names — all already columns: ended reason,
   success evaluation, duration band, customer-speech floor, and (new to the criteria)
   transcriber latency and interruption count. "Customizable" = the criteria JSON the
   templates already carry, plus those two fields.
2. **The daily number is the rate, not the bit.** `peerFlags / 100 words` on the shared
   denominator — already what `computeVerdict` and `/benchmark/trend` use — is
   continuous and does not saturate. A per-agent line of that rate over 30 days, with
   each day's shared-call count, is what "average is lower" turns into: **today vs the
   agent's own trailing baseline**, never an absolute threshold pulled from the air.
3. **The 95 % question got its cheap, permanent answer the same day (W-0, 2026-09-14).**
   `artifacts/api-server/src/mine-triage-signals.ts` re-run read-only on the 376-call
   corpus: base rate 92.5–96.7 %, headroom 3.3–7.5 points, **0 seeds, 5 of 5
   untestable** — the table is in v7 Part E. So the next step in *that* area is the
   disagreement threshold (`DISAGREEMENT_FLAG_THRESHOLD` = 0.15 in
   `lib/scoring/src/hybrid.ts`), and the daily watch runs on the rate meanwhile.

---

## 4. Grill questions, and the answers this PRD assumes

Where Abhishek has already answered elsewhere the answer is cited; the rest are in §9.

| Question | Assumed answer | Why |
|---|---|---|
| Who is it for, on which screen, at what moment? | Ellavox (Abhishek) first, opening the tool once a day to see every client org at a glance; the client's CEO second, shown one org. | Only one operator exists (`app_settings` is single-row); there is no login. |
| Does "per org" mean clients log in and set their own policy? | **No, not in v8.** Ellavox sets policies for each client org. | B-1 (no auth) is open; client self-serve is a separate PRD and a security boundary, not a feature. |
| What does it replace? | The manual "make a bulk on Tuesdays" habit and the unscheduled import. | Both exist as buttons/scripts today. |
| Smallest version worth having? | One org, one agent, 10 calls, one provider set, every day, one line per day on a screen. | Everything else is a filter on that. |
| What must it never do? | Spend without a cap; spend twice for the same day; touch a Vapi assistant; run a bulk on an org whose key is missing; build a leaderboard out of the hard calls only. | D-12, cost gate, v7 Part E's "a monitor path never feeds `benchmark_rankings`". |
| How will we know it worked? | *"I open it in the morning and every org shows yesterday's line, and when one agent's line moves I can click to the exact words."* | The acceptance sentence in §6. |
| "Limit of 500 calls" — per day, per policy? | **Per policy per day, hard ceiling on the sample size field.** | Cheapest reading; a monthly cap is the second knob (§5 Part A). |

---

## 5. The design

### Part A — A watch is a template with a clock and a wallet

A **watch policy** = existing `bulk_templates` row (criteria, providers, band) **+** a new
`watch_schedules` row:

| column | meaning | default |
|---|---|---|
| `templateId` | the criteria and providers to run | required |
| `accountId` | Vapi account (org) — its env var must be set | required |
| `assistantId` | one agent, or null = every agent on the account, sampled per agent | null |
| `sampleSize` | calls per agent per day, **1..500** | 10 |
| `dailyCapCents` | refuse the launch if the preview prices above this | 100 |
| `monthlyCapCents` | refuse if this month's spend for this policy would cross it | 3000 |
| `hourUtc` | when to run | 03:00 local, after the import |
| `enabled` | | true |

Sampling rule (one place, unit-tested): for each assistant in scope, take yesterday's
imported calls matching the criteria, **shuffle with a seeded RNG (seed = policy id +
day)**, take `sampleSize`. Seeded so a re-run picks the same calls and the ledger (Part B)
can prove it. Criteria gain two optional fields: `minProdTranscriberLatencyMs` and
`minProdAssistantInterruptions` (both "absent = no filter", same null rule as T-13).

Money at the defaults: 10 calls × ~2.5 min × $0.0395 = **≈ $1.00 per agent per day**
across all seven providers; the judge adds ≈ 0.7 ¢ per judged call. 36 agents, all seven
providers, every day would be ≈ $36/day — which is why `assistantId` defaults are set per
policy and the caps exist.

### Part B — The scheduler lives in the API, and every day has a ledger row

**n8n analogy:** this is a Schedule Trigger node feeding the existing "Launch template"
node — except the workflow keeps a written log of every day it ran, so it can never run
the same day twice.

- A one-minute tick inside `artifacts/api-server` (`setInterval`, started in
  `artifacts/api-server/src/index.ts` behind `WATCH_SCHEDULER=1` so tests and the
  integration suite never start it).
- For each enabled policy whose hour has passed and whose `(policyId, day)` ledger row
  does not exist: **insert the ledger row first** (unique index on `(policyId, day)`; a
  duplicate insert is the whole idempotency), then (1) import that account's last 24 h
  through the same preview/import routes `scripts/daily-import.sh` calls, (2) preview the
  bulk, (3) refuse if over either cap, (4) launch. Each of the four outcomes is written to
  the ledger row (`imported`, `previewed`, `refused:<reason>`, `launched:<bulkId>`).
- **Missed days are not backfilled.** A laptop asleep at 03:00 runs the *most recent* day
  when it wakes, once. Backfilling N days is N × the daily spend with no one watching.
- **Why not launchd for this too:** the import's launchd agent has been "held until
  Abhishek says" for five days (O-79); a second plist doubles the thing to forget, and a
  scheduler the UI can show ("next run 03:00 · last run launched bulk 2026-09-14") is one
  the person can see is alive. The import script stays as the manual/catch-up path.
- `benchmark_bulks` gains `watchScheduleId` and `watchDay` (nullable, unique together) so
  the bulk knows it was scheduled and Results can group by day.
- **The ledger is the history, the bulk is the workbench.** `MAX_LIVE_BULKS` is **10**
  (`artifacts/api-server/src/lib/bulks.ts`, raised from 3 by W-13, shipped 2026-09-15):
  FR-BLK-10 evicts the oldest bulk — runs, scores, rankings and all — when an eleventh is
  created, so a daily bulk per policy keeps ten days of call-level detail. The 30-day line
  therefore never reads bulks: when a launched bulk settles, the tick copies the day's
  four T-19 totals per (agent, provider) — `peerFlags`, `words`, `callsScored`,
  `cleanCalls` — onto the ledger row. The cap only says how far back Layer 3 can click;
  the 30-day line never depended on it.

### Part C — Three layers, no more

Evidence note (visual-and-research, 2026-09-14) is in §8. The shape it supports:

**Layer 1 — Orgs.** One row per account, expanding to one row per agent. Each agent row:
name, the production transcriber it runs (resolved **offline** from the stored
`source_transcriber_provider`, never by the live Vapi read behind
`GET /benchmark/assistants/{assistantId}/transcriber` — corrected 2026-09-17, W-6
grill), a **30-day tick bar** (one tick
per scheduled day: green = ran; amber = today, when the ledger's baseline verdict
(W-6a/W-6b) reads `moved` — ~~or `too_close`~~ (corrected 2026-09-23, W-6c grill:
`too_close` is a Layer 2 verdict and is not on the ledger, so Layer 1 never shows it);
grey = no run; red = refused/failed, with the reason on hover), today's
rate vs trailing-30-day baseline, and cost this month.

**Corrected 2026-09-23 (W-6b grill).** "Today's rate" is production's **M-8a
disagreement** — the Vapi draft's caller turns against the candidates' consensus,
with the best candidate on the same calls — not a `peerFlags / words` rate.
Production (Flux on 310 of 362 calls) is streaming-only and never has cells of its
own, so it never appears in `watch_runs.totals`. The measurement exists only on a
customer-channel bulk. W-5e settles it onto the ledger; W-5f makes a watch run on
the caller track. See `docs/backlog/good-to-have.md`, "Found 2026-09-23". Pattern from Better Stack /
incident.io status pages (§8) — a person reads 36 agents in one screen without a chart.

**Layer 2 — One agent, one day.** The existing verdict sentence for that day's bulk,
scoped to the agent (`GET /benchmark/bulks/{bulkId}/verdicts`), the head-to-head pair
(S-AB1–3), and a new **"what else happened" strip** that attributes the day's calls to
layers using data already stored — nothing new is collected:

| layer | signal | source |
|---|---|---|
| STT | peer flags per 100 words; entity mismatches; words that split | scores, `GET /benchmark/words-to-watch` |
| Turn-taking | endpointing latency; assistant interruptions | `prod_endpointing_latency_ms`, `prod_assistant_interruptions` |
| LLM | model latency per turn | `artifact.performanceMetrics.turnLatencies[].modelLatency` |
| Voice | TTS latency per turn | `…voiceLatency` |
| Outcome | ended reason; success evaluation | `source_ended_reason`, `source_success_evaluation` |

Each cell shows count + denominator ("interrupted on 3 of 10") and the "cannot tell you"
line where it applies ("latency measured on 7 of 10 calls; 3 not timed by Vapi").

**Layer 3 — One call.** The existing comparison view
(`GET /benchmark/bulks/{bulkId}/calls/{callId}/comparison`, disagreement spans, judge
pick) — **unchanged**. This is already where "where STT made mistakes" lives; the new
layers are the path to it.

### Part D — Alerts are a line on Layer 1, not a notification system

v8 ships no email, no Slack. "Alert" = the amber/red tick and a sortable "moved most vs
baseline" column. The baseline rule (one function, unit-tested): today's rate is *moved*
when it lies outside the trailing 30 days' 5th–95th percentile of that agent's daily
rates **and** today's shared-call count ≥ `MIN_SHARED_CALLS_FOR_VERDICT`. Fewer days than
7 → "baseline forming", never amber.

### Part E — The way in from code

The architecture rule stands: **MCP is never in the runtime path**
(`docs/integration-strategy.md`). Everything below is a *client* of the API.

1. **SDK** — a plain TypeScript client generated from `lib/api-spec/openapi.yaml`
   (the same generator that produces `lib/api-client-react`, fetch-only target) published
   as a workspace package. Zero hand-written surface; when the spec changes the SDK
   changes.
2. **CLI** — grow `scripts/src/import-vapi-calls.ts` into one entry point with
   subcommands: `orgs`, `agents <org>`, `watch list|create|run-now`, `verdict <bulk>`,
   `calls <bulk> --moved`. Same rule as today: the CLI never holds a Vapi or provider key;
   it talks to the local API.
3. **MCP server** — a small Node server over the SDK exposing **read tools** (list orgs,
   list agents, get verdict, get moved calls, get words to watch, get one call's
   disagreement) and **one write tool**, `watch_run_now`, which goes through the same
   cost gate and ledger as the scheduler. It is what makes *"ask your coding agent
   whether STT regressed for Org X this week"* real, and it is the piece Vapi's own MCP
   does not have.
4. **Claude Code plugin** — a marketplace repo (planned name, plain text:
   ellavox/stt-evals-plugin) with a plugin manifest (.claude-plugin/plugin.json), a `.mcp.json` pointing at
   the MCP server, and three skills: *read the verdict*, *find where STT failed*, *add a
   provider adapter* (the adapter template already exists in
   `lib/stt-providers/src/adapters/elevenlabs.ts`). Install path is Vapi's own:
   `/plugin marketplace add <owner/repo>` then `/plugin install`. The plugin's env carries
   only the API base URL; no key ever passes through it.

The order matters: SDK → CLI → MCP → plugin, each one PR, each usable alone.

### Part F — The public calibration set (the anti-slop step)

Import the Pipecat `stt-benchmark-data` set (1,000 utterances, BSD-2, human-reviewed
gold) as a synthetic org named plainly *"Public: Pipecat 1k"* with `goldTranscript` set
from the dataset — the one place gold is allowed to exist, because a human already wrote
it. Run one bulk through all seven ready providers — **159.9 audio minutes** (1,000 clips,
mean 9.59 s, measured 2026-09-14) ≈ **$6.32**; Cartesia's real-time adapter alone needs
≈ 2.7 h of wall-clock — then:

- compute gold WER per provider (the scorer still has it);
- compute the no-gold peer-flag rate per provider (what every client verdict uses);
- report **rank agreement** between the two (Spearman over 7 providers) on the Results
  page under a "Method check" line, with the date.

If the ranks agree, 1b is a claim with a receipt. If they do not, the flag threshold gets
tuned on this set before anything is sold. This also answers the "standard benchmark"
thought: we do not compete with the leaderboards; we **borrow one to check our method**
and say so.

Caveats stated on the screen: 16 kHz mic audio, not 8 kHz telephony; English; single
distribution. It calibrates the *method*, not the client's numbers.

**Licence and spend — decided 2026-09-14 (D-15), on Abhishek's delegation ("u decide").**
Checked at the source: neither `pipecat-ai/stt-benchmark-data` nor its parent
`pipecat-ai/smart-turn-data-v3.1-train` carries a licence field on the Hub; the
benchmark code is BSD-2 and its README publishes the set as "publicly available on
Hugging Face" for exactly this use. The decision, and the rule W-12 is written to:

- **Internal method check only.** The audio and the transcripts are never redistributed,
  never served to a client, never leave the gitignored audio cache; the calls carry
  `vertical: public_benchmark` and `sourceProvider: pipecat` and every client view
  excludes them. What gets published is aggregate arithmetic — per-provider WER, per-
  provider peer-flag rate, and the Spearman between them.
- **The spend is approved once, with a ceiling.** ≈ $6.32 at today's seven prices; the
  script refuses above **$7** and refuses unless it can print the exact minutes first. It
  runs only after W-13 (so it evicts no client bulk) and only once; a second run is a new
  decision.
- If either dataset gains a licence that forbids this, the calls are deleted and the
  "Method check" line says so with the date.

---

## 6. Acceptance

> **WHEN** a watch policy is enabled for an org **THEN** every day at its hour the system
> **SHALL** import that org's last 24 hours, draw exactly `sampleSize` matching calls per
> agent in scope by seeded shuffle, price them, refuse if either cap would be crossed, and
> otherwise launch one bulk; **AND** it **SHALL** write one ledger row per (policy, day)
> so that a second tick on the same day launches nothing; **AND WHEN** Abhishek opens
> Orgs **THEN** each agent **SHALL** show its 30-day ticks, today's rate against its own
> baseline with the shared-call count, and a click through to the day's verdict and to
> the calls and words that moved it.

---

## 7. Steps

The steps are register rows — `docs/step-register.md`, **Part W** — because a step that
lives in two places drifts. **Start here after compaction: W-1**, then the table's
order. Order and dependencies:

| step | one line | depends on | spends |
|---|---|---|---|
| W-0 | triage seeds re-run on 376 calls, table into v7 Part E — **done 2026-09-14, 0 seeds** | — | nothing |
| W-1 | transcriber latency and interruption floors become selection criteria | — | nothing |
| W-2 | `watch_schedules` table and CRUD | — | nothing |
| W-3 | the seeded sampler, pure | W-1 | nothing |
| W-4 | preview/import move from the route into a library function (no behaviour change) | — | nothing |
| W-13 | `MAX_LIVE_BULKS` 3 → 10 (decided 2026-09-14, shipped 2026-09-15) — before W-5 so daily bulks keep ten days of call detail | — | nothing |
| W-5a | the `watch_runs` ledger table: unique `(schedule_id, day)`, and `bulk_id` detaches on eviction | W-2 | nothing |
| W-5b | `decideTick`, pure: is this schedule due, and for which single day | W-5a | nothing |
| W-5c | the 60 s tick behind `WATCH_SCHEDULER=1`: import, sample, price, refuse or launch | W-5a, W-5b, W-3, W-4 | caps, in production only |
| W-5d | settle: the day's four T-19 totals move onto the ledger row | W-5c | nothing |
| W-6 | Orgs layer: overview endpoint, baseline rule, tick bar | W-5d | nothing |
| W-7 | agent-day layer: per-assistant verdict, "what else happened" strip | W-6, S-AB1 | nothing |
| W-8 | SDK generated from the spec | — | nothing |
| W-9 | CLI, plus the `run-now` route | W-8, W-2, W-5c | nothing by itself |
| W-10 | MCP server: six reads, one ledger-gated write | W-8, W-9 | nothing by itself |
| W-11 | Claude Code plugin (new repo) | W-10 | nothing |
| W-12 | public calibration set — the receipt for §1b | W-13 | **≈ $6.32 once, approved 2026-09-14 by delegation, ceiling $7** |

## 8. Evidence — daily watch, org → agent → call

**Pattern to use:** a grouped list where each row carries a 30/90-day bar of daily ticks
and one status badge, read in one glance without a chart ← [Better Stack status](https://mobbin.com/screens/76e5528e-4f41-4c85-8f66-7f51d081c061),
[incident.io status](https://mobbin.com/screens/9ac97757-ff30-4b0c-a3dd-ff3f17976053),
[AWS Health service history](https://mobbin.com/screens/2e83f4b0-7503-4d6e-b103-d61712d69cde)
(one row per service, one tick per day). Filter by agent and day granularity at the top
← [ElevenLabs agents dashboard](https://mobbin.com/screens/6949253a-92b3-4635-a06a-76521d744a4c).
**Patterns to avoid:** a header of five count tiles with no denominator or baseline
← [Sentry stats](https://mobbin.com/screens/52e1570b-582d-43e0-a697-a0400d15c337)
(the tiles say "4" and mean nothing without "of what"); a raw-JSON side panel as the
detail view ← [Adaline trace](https://mobbin.com/screens/67794230-da90-4eff-8233-51adf67771c1).
Also: do not rebuild what the client already sees in Vapi — transcript, logs, analysis,
latency tabs ← [Vapi call view](https://mobbin.com/screens/007a4823-5c3d-4016-b2d1-8637a49cb015);
Layer 3 must add *where providers split*, not repeat the transcript.
**What operators say:** random sample first, then signal-weighted; production monitoring
is the discovery engine and its evaluators run asynchronously on a sample; the golden set
is not the daily sample ← "Building eval systems that improve your AI product" (Hamel
Husain & Shreya Shankar, 2025-09-09)
https://www.lennysnewsletter.com/p/building-eval-systems-that-improve-your-ai-product.
Implicit signals tell you which traces to look at ← Kiriti Badam (podcast, 2026-01-11).
**Changes to the plan:** selection became "criteria, then seeded random" instead of a
threshold (§3); the daily view became a tick bar with the agent's own baseline instead
of tiles; Layer 3 reuses the comparison view unchanged.
**No evidence found for:** a screen that shows a bootstrap noise floor or "too close to
call" as a first-class state — no product in Mobbin's results does this. The wording from
S-AB1's spec stands and is not validated by a reference.

**Addendum 2026-09-23 (W-6c, visual-and-research).** Question: how do status pages word a
per-day tick's hover, and a "not enough history yet" state?
**Pattern to use:** hover = date, then the outcome, then the count with its denominator
← [OpenAI Platform service health](https://mobbin.com/screens/fd98bb68-c8c4-446c-a0fc-0e1089003e1c)
("Feb 26 · 7:00–7:59 AM · 100.00% uptime · (0 / 0 requests)"); the bar's two ends labelled
"30 days ago … today" ← [Better Stack status](https://mobbin.com/screens/0d34fbf2-e4c4-451c-ad5d-de3cdf409164).
**Patterns to avoid:** a tick bar with no legend in the page copy — every reference
carries one line saying what the colours mean.
**Changes to the plan:** hover text is `<day> · <outcome> · <rate> per 100 words · <n> calls`,
each part only when present; legend sentence under the page title.
**No evidence found for:** wording of a forming baseline — Lenny's search
(`baseline|anomaly|not enough data|insufficient data|collecting data`, 71 hits) returned
nothing about dashboards; "baseline forming · N of 7 days" is the register's own wording.

---

## 9. Open questions for Abhishek — and the assumption each step proceeds on

Abhishek asked for everything needed rather than answering these one by one
(2026-09-14), so each carries the assumption Part W is written against. Overriding one
changes the named step, nothing else.

1. **USP (the one you said to decide first):** is 1b the sentence? *Assumed yes* until
   said otherwise. Part F (≈ $6.32) is the first thing to spend on, because it is the
   receipt for it — W-12 waits only for "go spend".
2. **Cap semantics:** "limit of 500" = hard ceiling on `sampleSize` per policy per day.
   *Assumed.* A monthly ceiling exists separately (`monthlyCapCents`, W-2).
3. **Scheduler placement:** in the API process behind `WATCH_SCHEDULER=1`. *Assumed*
   (W-5c). launchd would need O-79 answered first and doubles the thing to forget.
4. **Client self-serve:** v8 is Ellavox-operated per org; a client login is a later PRD
   behind auth (B-1). *Assumed.*
5. **Default provider set per watch:** the org's production transcriber plus two
   challengers (≈ $0.35/agent/day). *Assumed*; all seven (≈ $1) is a per-template
   override, not the default.
6. **Still open from v7:** question 5 (95 % flag rate expected? — W-0 says it still
   holds: 0 seeds on 376 calls), O-79 (import schedule), O-97 (disagreement only,
   permanently — answered "yes" on 2026-09-09; Part F respects it: the only gold is the
   public set's).
7. **`MAX_LIVE_BULKS`:** **answered 2026-09-14: 10.** Step W-13.
8. **The Pipecat dataset licence and the W-12 spend:** **delegated 2026-09-14 ("u
decide") and decided as D-15** — see Part F. Internal method check only, aggregate
   numbers published, one run, ceiling $7, after W-13.

## 10. Deliberately not doing, or parked

- **Notifications** (email, Slack, SMS) — Layer 1's ticks are the alert until a person
  asks for a push.
- **Client login / multi-tenant auth** — B-1 first.
- **A monitor trigger on the flag bit** — blocked by v7 Part E until W-0 says otherwise.
- **Streaming adapters** — parked per v7; the watch runs batch adapters.
- **Webhooks from Vapi** (`end-of-call-report`) as the ingest path — polling the private
  key once a day already fits (257 calls/day, one page); a webhook needs a public URL the
  laptop does not have. Revisit when the API is hosted.
- **Vapi write-back of a chosen transcriber** — D-3's six conditions, unchanged; nothing
  here changes a Vapi assistant (D-12).
- **Telephony-grade public set** — none exists that is current and open; Part F says so
  on the screen instead of pretending.
