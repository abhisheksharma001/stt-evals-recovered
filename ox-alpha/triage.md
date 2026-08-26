# Opportunity triage — STT Benchmark Command Center

Method: [opportunity-triage](https://github.com/maxmcfadden88/opportunity-triage)
(provenance labels on every claim, cheapest-lethal-test-first, kill criteria
before more building). Applied 2026-08-25 to branch
`provider-adapters-run-executor`.

## The thesis under test

> "This benchmark yields **decision-grade** evidence for choosing a default
> transcriber per vertical."

Decision-grade = a ranking you would bet real contract volume on. The thesis
dies if any ranked metric is systematically wrong, or if the evidence behind it
cannot be reproduced.

## Load-bearing claims, labeled and ordered by p(fatal) ÷ cost-to-check

Checks already executed this session are marked ✅; the rest are ordered for the
next operator with keys.

| # | Claim (where it lives) | Provenance today | Fatal if wrong? | Cost to check | Status |
|---|---|---|---|---|---|
| 1 | Provider **prices** drive the cost metric (`defaultProviders`, benchmark.ts:72-150) | planning placeholders per provider-matrix.md | **YES** — wrong prices reorder winners | ~1 h of web checks | ✅ **Checked 2026-08-25**: Deepgram Nova-3 batch $0.0043/min exact ([Dynalord](https://dynalord.com/blog/deepgram-pricing)); Gladia async $0.61/hr ≈ seeded $0.0102/min exact ([Gladia](https://www.gladia.io/blog/best-speech-to-text-apis)); Cartesia Ink-Whisper $0.13/hr Scale plan exact ([Coval](https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/), [Cartesia blog](https://www.cartesia.ai/blog/introducing-ink-speech-to-text)); Speechmatics Pro $0.24/hr matches seed ([PulseSignal](https://getpulsesignal.com/pricing/speechmatics)) but public price pages end Aug 2026 ([Speechmatics docs](https://docs.speechmatics.com/administration/plans)); ElevenLabs Scribe ≈ $0.40/hr ≈ $0.0067/min vs seeded $0.0065 — **~3% drift, correct before first paid run** |
| 2 | Provider model names are current (`nova-3`, `scribe`, `Realtime`, `Solaria`, `Universal`) | vendor-claimed, frozen at build time | YES — benchmarking a superseded model makes rankings irrelevant to any real decision | web + one live call each | ⚠️ Partial: **Scribe v2 Realtime shipped July 2026** ([Quasa](https://quasa.io/media/elevenlabs-launches-scribe-v2-realtime-a-breakthrough-in-ultra-low-latency-speech-to-text), [Signal](https://opentranscription.io/blog/scribe-v2-realtime-by-elevenlabs.html)) and Speechmatics' accuracy leader is now **Melia-1**, not Realtime/Ursa-2 ([novascribe July-2026 bench](https://novascribe.ai/compare/best-transcription-api-for-developers)). The matrix's streaming "?" for ElevenLabs is resolvable NOW. Model refresh needed before Phase-3 decisions |
| 3 | The 7 adapters' response **parsers match live output shapes** (fixtures only) | fixture-only (parsers.test.ts passes offline); only Deepgram's network path has ever been hit live (401 probe, fake key) — see ox-alpha/e2e-report.md | **YES** — a mis-parsed transcript silently scores garbage WER | medium: one real call per provider (~$0.01 total audio cost) | ❌ Blocked: needs 6 real API keys. Cheapest lethal test remaining |
| 4 | Cartesia finalize/close WebSocket handshake is right (`adapters/cartesia.ts` header) | inferred from docs, self-flagged UNVERIFIED in code | YES for that provider's cells only (premature close → truncated transcripts scored as real) | low-medium: one long call with a key | ❌ Blocked: needs CARTESIA_API_KEY. Mitigation shipped: uncommitted fix marks truncated streams "safe to retry" instead of scoring them |
| 5 | Gold transcripts are human-quality references (GOLD-01) | asserted by process design, not audited | **YES** — WER against bad gold ranks everyone wrong equally | audit sample of corpus rows | ❌ Not yet run: needs corpus owner time. Kill-criteria trigger below |
| 6 | Vapi import never fabricates recordings / duplicate-safe | verified-live this session (preview listed 5 real calls, dup-protection schema + fallback label logic unit-exercised previously) | no (correctness guard) | done | ✅ Verified-live |
| 7 | Executor concurrency/retry/lock mechanics | verified-live via offline rehearsal (1050 cells, advisory-lock race test) — ox-alpha/e2e-report.md | no (infra) | done | ✅ Verified (stub-level; vendor rate-limit behavior still assumed) |
| 8 | Composite ranking weights (RANKING_WEIGHTS) are defensible (PRD OD-1 "open decision") | documented-unverified by design | medium — weights can flip rank 1 vs 2 | analysis + sensitivity sweep | ❌ Open decision; cheap to analyze, do before externalizing results |
| 9 | "Nobody benchmarks Vapi-call-realistic audio across these 7 providers" (implicit project motivation) | positioning, not insight — by the skill's five-test definition this is copyable positioning | no (doesn't break the tool) | competitive scan | ⚠️ Unchecked; note novascribe/Coval publish general STT benches, none Vapi-corpus-specific found in this session's searches |

## Contradiction scan (never assert here what's flagged unverified there)

provider-matrix.md carries 60 verify/unverified flags and correctly labels all
prices as UNVERIFIED PLACEHOLDERS; HANDOFF.md honestly lists live-verification
gaps. No doc asserts as settled fact what another doc flags unverified — the
one near-miss is `costPerMinute` being written into the DB as a plain number,
which downstream code treats as fact. Fix: the Providers page should render
planning prices with an "unverified" badge until claim #1 corrections land.

## Kill criteria (written before further building)

1. **Parser kill**: when adapters first run against live keys, if ≥2 providers'
   outputs deviate structurally from their parser fixtures, all existing scores
   are voided — re-score from stored rawOutput before trusting any ranking.
2. **Gold kill**: if a 10-call gold audit finds >1 material transcription error
   per transcript on average, halt all ranking-based decisions until gold is
   re-curated (the thesis dies without trustworthy gold).
3. **Price kill**: if contracted/volume pricing differs >20% from seeds for any
   top-2 provider, rerun rankings with corrected prices before deciding.
4. **Model kill**: if any provider ships a successor to the benchmarked model
   (as Scribe v2 / Melia-1 already have), mark that column "historical" —
   never present it as a current default recommendation.

## Verdict

The core mechanic survives its cheapest lethal tests: prices check out (one
small correction pending), the pipeline mechanics are proven, provenance
discipline inside the repo is unusually good. What stands between the project
and "decision-grade" is exactly what was always going to: **real keys against
the six unverified adapters (#3), a Cartesia live handshake (#4), and a gold
audit (#5)**. Those are blocked-with-evidence above; nothing else should ship
as a recommendation until they clear.

---

## Re-check 2 (2026-08-25): the customer-experience dimension

The first triage tested whether the benchmark's EVIDENCE is decision-grade.
The second test, per the method's "manual version of the product" and
insight-vs-positioning criteria: can the one internal operator actually reach
that decision through the UI without being misled, blocked, or billed twice?
A benchmark whose numbers are right but whose surface lies is not
decision-grade either.

Method: 24 parallel read-only review agents, one lens each (8 pages ×
first-run/trust + states/density, plus 8 cross-cutting: IA, copy, state
coverage, a11y, responsive, theme, thresholds, performance perception).
~130 grounded findings; full text in the session log. Convergence pattern
(multiple agents independently flagging the same defect) treated as the
strongest evidence, same as corroborating sources in competitive research.

### What the re-check killed or confirmed

| CX claim | Verdict |
|---|---|
| "The operator never spends money by accident" | **Was FALSE** — Queue Run showed a call count but no cost, ignored in-flight runs (duplicate paid launches), and the import wizard could submit the wrong account's call ids. Fixed this pass: live `providers × calls = N · ≈$X` estimate, irreversibility copy, in-flight-run CTA branch, stale-preview binding gate, 200-batch clamp. |
| "Failures explain themselves" | **Was FALSE** — executor notes ("N cells failed transiently, retry by re-executing") were written to the DB and never rendered; the Review page showed a lying "Nothing to review" during outages; 3 of 8 pages dead-ended on API errors with no retry. Fixed: notes surfaced under status, error+retry states everywhere, results dialog polls while open. |
| "Numbers mean the same thing everywhere" | **Was FALSE** — same WER displayed as 0.123 (Runs) and 12.3% (Results); diarization % implied attribution accuracy; "No key" label covered deliberately-disabled providers. Fixed: unified percent format, honest labels, null "— = not measured" titles. |
| "The decision bar is enforced" | **Was PARTIALLY FALSE** — the low-confidence caveat keyed on rank 1 only with a <10 cutoff while the PRD bar is ≥12/vertical; concurrency env knobs accepted any positive int. Fixed: per-provider ≥12 caveat, env clamps (64/16/16/5). |
| "Safe to use at 500–1000 calls" | **STRONGER NOW** — the semaphore cap-erosion bug (found in code review, fixed + proven with a 5000-op contention test) would have silently dissolved vendor rate limits exactly at that scale; import pagination no longer truncates at 1000 calls; per-call cap mismatch (500 preview vs 200 import) clamped client-side. Remaining at-scale debt recorded below. |

### Remaining CX/UX debt (ordered, not blocking the thesis)

1. Corpus renders all rows — needs a client-side pager by ~500 rows (agent-4 P1).
2. Review queue re-sorts under the cursor after each save (agent-25 P2) — disorienting mid-session.
3. No edit path for provider cost/configNote (agent-15 P1) — wrong price is currently permanent.
4. Unbounded list payloads at very large corpora (agent-24 P1) — server-side caps eventually required.
5. Sidebar cannot collapse below 1024px; Review panels crush (agent-22) — known, panels hidden via classes is the cheap first step.
6. Approve-flow still shows no incumbent-transcript panel or candidate diff highlighting (agent-13) — trust work, medium effort.

### Revised verdict (opportunity-triage format)

The thesis survives both triages: prices verified, pipeline mechanics proven,
and — after this pass — the surface no longer contradicts the backend's
honesty. What stands between the project and "decision-grade" is unchanged and
external: real keys against six unverified adapters, a Cartesia live
handshake, and a gold audit. The CX re-check adds one new kill criterion:

> **CX kill**: if a surfaced number can contradict the same number on another
> page, or a paid action can be triggered twice from one intent, the UI is
> not shipping. Both classes found and fixed this pass; the pattern belongs
> on the checklist for every future screen.

> Rerun note: the post-fix executor rehearsal is still pending — this
> machine's Docker Desktop cannot start containers at all right now
> (`docker info` responds; `docker run hello-world` hangs; backend/CLI
> mismatch suspected). The changed executor code is covered by: the
> 5000-op semaphore contention proof (exit 0, peak=cap), workspace
> typecheck, and the fact that the confidenceNote/envInt changes are pure
> functions. Run `pnpm --filter @workspace/api-server scale:rehearsal`
> once Docker Desktop is healthy.
