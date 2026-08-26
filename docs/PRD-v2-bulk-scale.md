# STT Benchmark Platform v2 — PRD: Bulk Scale (1000s of Calls), Multi-Org, Comparison View & Multilingual

**Version:** 2.0 — Draft for review
**Status:** Working document; supersedes the scope sections (not the defect register) of [PRD.md](PRD.md) where they conflict
**Date:** 2026-08-25, revised 2026-08-26 (four times)
**Depends on:** PRD v0.1 (`docs/PRD.md`), current implementation state in `docs/HANDOFF.md`
**2026-08-26 revision:** critique pass against real code (not assumption) closed 6 gaps — OD-11 resolved (§7.1), Tier-A-vs-ST-4 arithmetic worked through (§11.1, new), R10/R11 platform-fit risks added (§12), migration rollback plan added (§8.1, new), phasing revised to solo+AI pace (§15), OD-17 added (§16), and a stale broken cross-reference (§5 → §8.3, which didn't exist) fixed to point at §7.4.
**2026-08-26 correction (same day, later):** the OD-11 resolution above (Replit Auth) was wrong — the project moved off Replit (web → Vercel, API → Fly.io/Railway/VPS, per `ox-alpha/deployment.md`), confirmed after M1 slice 1 (organizations + org_id backfill, §7.1/§8) was already built and verified against an isolated DB copy. OD-11 re-opened (§7.1, §16); R10 resolved favorably by the same platform move (§12). The org_id schema work itself is platform-independent and unaffected. OD-11 then resolved a 3rd time, correctly: no auth needed at all right now (local, single-operator project) — M1 slice 1 unblocked on that basis and verified live.
**2026-08-26 hardening pass (same day, later still):** went through every §7 functional-requirement subsection against real market practice and this project's own actual corpus/architecture, one at a time. Found and closed 6 real gaps: FR-ORG-2 (env-var-per-connection doesn't scale past a few orgs → encrypted DB storage), FR-SEL-7/8 (no minimum-duration or call-outcome filter → near-empty calls could dominate a "1,000-call" bulk), FR-BLK-9 (no reusable/recurring bulk template, despite the market scan citing exactly this practice), FR-RES-5 (no fleet-level agents directory, only one-at-a-time), FR-CMP-5 (comparisons weren't shareable links), FR-MOD-6 (adding a model of an already-integrated vendor still required a deploy), FR-LNG-8 (language rollout prioritized by real corpus evidence — en+es first — rather than breadth-first). AC-1.2 corrected to match the FR-ORG-2 change (it had contradicted it). New ACs added for every new FR (§14); DDL (§8) and API surface (§9) updated to match.
**2026-08-26 bundle design pass (same day, later still):** worked through Abhishek's own bundle spec (date/count/name filters, agent-and-manual runnable, max-3 auto-delete, 20k result cap) end to end, closing on four new FR-BLK requirements (§7.3) plus one real redesign of existing v1 behavior, called out explicitly rather than silently changed: FR-BLK-11 makes bulk-triggered runs execute their `ready_to_run` subset instead of all-or-nothing-blocking on any unreviewed call — v1's plain Runs-page flow keeps its strict block unchanged. FR-BLK-10 (max-3-bulk eviction) is scoped as a thin-wrapper delete that never touches `benchmark_calls` — added as R12 in §12, the first destructive automated path in this PRD, with AC-2.8 as its actual safety mechanism, not just a nice-to-have test. FR-EXC-8 sets the 20k result-row cap — Abhishek's own call, kept as an explicit backstop even though the real math (measured live: 238 rows = 1MB) put 20k nowhere near an actual disk risk on any host this runs on. FR-BLK-12/13 cover agent-vs-manual bulk execution and structured (not notes-string) reporting. DDL (§8) and API surface (§9) updated; 5 new M2 acceptance criteria (§14).

---

## 1. Problem Statement

The v1 platform proves the loop end-to-end: import Vapi calls, transcribe through candidate STT providers, score WER / Entity Accuracy / Alphanumeric Accuracy, rank per vertical, and recommend a winner. A live 20-call × 5-provider run completes in ~3.3 minutes with honest low-confidence caveats.

But the tool was built for *proof*, not *operations*. Five structural gaps prevent it from being used continuously and across teams:

| # | Gap | Evidence in code |
|---|-----|------------------|
| GAP-1 | **No scale path.** Runs are fire-and-forget (`void executeBenchmarkRun(...)` at `artifacts/api-server/src/routes/benchmark.ts:946` region), single-process, no queue, no rate-limit handling beyond ad-hoc polling. At 1,000 calls × 7 providers = 7,000 cells this collapses. | `run-executor.ts`; offline rehearsal harness `rehearsal-scale.ts` only proves 1,050 stub cells |
| GAP-2 | **Single tenant.** No organization concept. Vapi accounts are env-var conventions (`VAPI_API_KEY_<LABEL>` in `lib/vapi.ts`). Two customers cannot share one deployment safely. | `artifacts/api-server/src/lib/vapi.ts` |
| GAP-3 | **Models are welded shut.** Model strings are hardcoded in three places (adapter constants, seed data, provider PK ids — e.g. `"nova-3"` inside `deepgram-nova-3`). Adding or A/B-ing a model of the same vendor requires code changes plus a new identity. | `lib/stt-providers/src/deepgram.ts:53`, seed `defaultProviders` in `routes/benchmark.ts:85-163` |
| GAP-4 | **Results don't answer "what should THIS agent use?"** Rankings are per-vertical averages. There is no per-assistant (per-agent) headline view, no side-by-side comparison view, no trend across runs. The `< 12 calls ⇒ Confidence: low` rule is a hardcoded string, not statistics. | `run-executor.ts:674-685`, `run-executor.ts:722-725` |
| GAP-5 | **English-only by decree.** Transcript normalization forces `toLocaleLowerCase("en-US")` and word-based WER; there is no language field anywhere in the pipeline. Real call volumes are multilingual. | `lib/scoring/src/index.ts:87`; NG3 in PRD v1 |

Additionally, one **known gap** is pre-existing and flagged (not new): no provider counts as production-ready until a live smoke call passes — see §12, R9. (The OpenAI adapter itself was verified against live audio 2026-08-25 — real key, real `POST /benchmark/runs` cell, `status: ok` — so it is no longer an unverified-adapter case; FR-MOD-4's structural gate is still the right requirement going forward, for OpenAI and every other variant.)

## 2. Goals

| # | Goal |
|---|------|
| G1 | Run evaluations over **1,000–10,000 calls** reliably: queued, rate-limited, retrying, resumable, observable, with pre-flight cost estimates and budget gates |
| G2 | Make Vapi integration **organization-scoped**: each org connects its own Vapi account(s); all data is isolated per org |
| G3 | Give operators **selection controls**: how many calls, which date range, which assistants/agents, which verticals — previewable before launch |
| G4 | Introduce **Bulks**: a named, reusable evaluation batch (name defaults to the launch date) that groups runs, preserves selection criteria, and supports re-execution of failed cells |
| G5 | Make results **clear per agent**: a headline recommendation card per Vapi assistant, with confidence derived from real statistics (confidence intervals, minimum-sample gating), not hardcoded thresholds |
| G6 | Ship a **comparison view**: pick any set of provider/model variants and compare them head-to-head on any slice (bulk, vertical, agent, language), including per-call diffs and CSV export |
| G7 | Introduce a **provider model catalog** with per-provider model toggles in the UI; supporting multiple variants of the same vendor simultaneously without code changes |
| G8 | Support **multilingual conversations end-to-end**: language tagging, script-aware scoring (WER vs CER), per-language leaderboards and filters, and a provider language-support matrix |
| G9 | Bring scoring rigor to market standard: Wilson/bootstrap confidence intervals, paired significance testing between the top-2 providers, explicit sample-size gating |

## 3. Non-Goals

Carried from PRD v1 (§3): no real-time production integration, no telephony-infrastructure benchmarking, no provider SLA/uptime benchmarking. New non-goals:

| # | Non-Goal | Reason |
|---|----------|--------|
| NG-8 | Fully automated gold transcripts with zero human review | Gold quality is the measurement instrument; automating it invalidates the ruler (see §11 for the tiered compromise) |
| NG-9 | Speech translation / subtitle alignment quality metrics | Out of scope; STT accuracy only |
| NG-10 | Streaming (real-time) transcription latency benchmarks at scale | Only batch + Cartesia-style first-partial latency, as in v1 |
| NG-11 | Billing-grade cost accounting | Estimates remain estimates until invoices verify them (R8 in PRD v1 stands) |

## 4. Metrics — Definitions (authoritative)

These definitions go verbatim into product UI tooltips and docs.

### 4.1 WER (Word Error Rate)

> **WER = (Substitutions + Deletions + Insertions) / Total words in the reference (gold) transcript**

Computed after normalization (NFKC fold, punctuation strip, case fold, whitespace collapse) using Levenshtein DP alignment with operation backtracking (`lib/scoring/src/index.ts`, `alignWords()` / `score()`). Lower is better; can exceed 100% when insertions outnumber reference words.

Known, deliberate caveats surfaced in UI copy (market consensus — see AssemblyAI, ["Word error rate is broken"](https://www.assemblyai.com/blog/word-error-rate-is-broken)):

1. **WER is blind to word importance** — mishearing "the" costs the same as mishearing a VIN. This is why Entity Accuracy exists as a first-class metric.
2. **Small samples swing WER violently** — one bad call wrecks a 5-call average. Hence §10 confidence gating.
3. **Normalization choices move WER by points** — normalization rules are versioned (`SCORING_VERSION`) and hashed into every run manifest.

### 4.2 Companion metrics (unchanged from v1, restated)

- **Entity Accuracy** — exact-match rate of gold-annotated entities (RO number, unit, VIN, phone, name, address, load number, city) found in the hypothesis via normalized containment. Weighted highest in the composite (0.40).
- **Alphanumeric Accuracy** — same, restricted to entities mixing letters and digits (VINs, load numbers, phone digits).
- **Composite Score** — `entity 0.40 + alnum 0.25 + wer 0.20 + latency 0.10 + cost 0.05`; returns "insufficient evidence" rather than a number when WER or entity data is missing.
- **Latency** — time-to-first-partial and time-to-final (Cartesia is currently the only true streaming source).
- **Estimated cost/min** — provider-configured rate × duration; always labeled "unverified until invoiced".

### 4.3 Script-aware primary error metric (new, v2)

For non-whitespace-scripted languages, word-level WER is ill-defined. Standard practice ([ASR Leaderboard: Towards Reproducible and Transparent Multilingual ASR Evaluation](https://arxiv.org/html/2510.06961v4); common convention across multilingual ASR literature, e.g. [romanization-encoding studies](https://arxiv.org/html/2407.04368v2)):

| Language class | Primary metric |
|---|---|
| Whitespace-delimited scripts (en, es, fr, de, hi, ru, ar, …) | WER |
| Chinese (zh, yue) | CER (character error rate — same S/D/I formula, characters instead of words) |
| Japanese (ja) | CER (character-level; mixed-script caveat noted) |
| Korean (ko) | WER on eojeol units, CER reported alongside |
| Thai (th) | CER |
| Code-switched calls | CER on the full sequence + flag |

Every leaderboard cell shows its metric type; cross-language aggregation is forbidden except via normalized "accuracy" (= 1 − error rate) clearly labeled as such.

## 5. Market Scan — What "latest market standards" look like

Research summary informing the feature set below (sources in Appendix A):

| Platform / reference | What they do that we adopt |
|---|---|
| **Hugging Face Open ASR Leaderboard** | Reproducibility-first: frozen configs, published manifests, standardized WER + RTFx. We already have run manifests; v2 makes bulk-level manifests first-class. |
| **Artificial Analysis speech-to-text board** | Per-model rows (not per-vendor), price/speed/accuracy side by side. Drives FR-CMP (comparison view) and the vendor/model split. |
| **Coval** (voice-AI testing) | Scenario-based regression suites, probabilistic pass/fail framing, metrics incl. TTFB/WER/resolution; simulation-driven testing. We adopt: named reusable suites (= Bulks) + statistical gating instead of point estimates. |
| **Hamming AI** (voice QA) | Production-call replay, audio-native evaluation, review queues. We adopt: replay-from-Vapi provenance (already partially present) + human review queue for gold at volume (§11). |
| **Cekura / Hamming load testing** | Concurrent-load performance testing. We adopt concurrency ceilings per provider in the execution engine (§7.4, FR-EXC-2). |
| **Academic practice (Bisani & Ney 2004; blockwise bootstrap)** | Significance analysis on WER via bootstrap resampling; MAPSSWE-style paired tests. Adopted wholesale in §10. |
| **Multilingual ASR literature** | CER for CJK/thai, WER elsewhere; aggregate-WER insufficiency warnings (slice by speaker/domain/language). Adopted in §4.3, §7.8. |

Explicit anti-patterns observed in the market that we will avoid: vendor-published WER claims on their own chosen corpora; aggregating scores across languages; point-estimate leaderboards with no sample-size disclosure.

## 6. Users

All v1 personas remain. Added:

| Role | Who | Primary Need |
|---|---|---|
| **Org Admin** | Ops lead per customer org | Connect own Vapi account(s), see only own data, launch bulks within budget |
| **Agent Owner** | Person accountable for one Vapi assistant | "What transcriber should MY agent use?" — answered in one screen |

## 7. Functional Requirements

### 7.1 Multi-org & Vapi connections (G2)

- **FR-ORG-1:** System SHALL support multiple organizations; every domain row (calls, bulks, runs, results, providers, rankings) SHALL carry `org_id`.
- **FR-ORG-2:** Org Admin SHALL register one or more Vapi connections per org **through the UI, without a server restart.** (Real gap found on this pass: the env-var convention this originally extended — `VAPI_API_KEY_<LABEL>` — means every new org's key requires an operator editing environment variables and restarting the server. That directly contradicts "Org Admin SHALL register" self-serve, and doesn't scale past a handful of orgs someone manually provisions.) Instead: a connection's key is application-level encrypted (AES-256-GCM, one `SECRETS_ENCRYPTION_KEY` env var as the master key — never the Vapi key itself in an env var) and stored in `vapi_connections.encrypted_secret`; decrypted only in-process at request time, never logged, never returned by any API response. A connection stores: label, encrypted secret, key fingerprint (first 8 hex of SHA-256, as today), status, last-verified-at. This is the same pattern most self-serve platforms use for customer-supplied API keys (Zapier, n8n's own credential store, Vercel integrations) — not a novel design, and it's what "register through the UI" actually requires once you mean it.
- **FR-ORG-3:** Connection verification SHALL perform a read-only `GET /call?limit=1` against Vapi and record success/failure without storing call data.
- **FR-ORG-4:** All list/read/write endpoints SHALL be org-scoped; cross-org access attempts SHALL be audited. AuthN mechanism: see OD-11 — **no login system exists or is needed yet (local, single-operator project)**, so org-scoping is enforced and tested at the query layer (every endpoint filters by `orgId`; AC-1.1 seeds two orgs directly in the DB to prove isolation), not behind an auth session.
- **FR-ORG-5:** Migration SHALL create a single default org owning all existing rows.

#### OD-11: AuthN — resolved 2026-08-26 (third pass): none needed right now

Two earlier passes both guessed at a real login system (Replit Auth, then a
platform-agnostic OAuth shortlist) before asking. Abhishek's actual answer
made both unnecessary: **this is a local project right now — single
operator, no hosted multi-user deployment exists yet.** Building a login
system (Google OAuth, Auth0, magic-link, any of it) for a tool nobody but
one person can currently reach would be real, non-trivial work solving a
problem that doesn't exist yet.

**Resolution:** no AuthN for now. `actorFromRequest()` keeps its `x-actor`
header stopgap exactly as documented in its own comment
(`artifacts/api-server/src/lib/audit.ts:6-7`) — that comment was already
correct and did not need fixing. FR-ORG-4's "cross-org access attempts
SHALL be audited" is retargeted: enforced at the query layer (every
list/read/write scoped by `orgId`, verified by tests seeding two orgs
directly in the DB) rather than gated behind a login session, since there
is no session to gate behind yet. This makes AC-1.1 ("zero cross-org
leakage") testable today, without inventing users.

**What this unblocks immediately:** the M1 slice-1 schema work (§8,
organizations + org_id backfill, already built and DB-verified) can now be
wired through the application layer — every insert/query that currently
fails typecheck for a missing `orgId` (`routes/benchmark.ts`,
`routes/agent.ts`, `rehearsal-scale.ts`, `lib/audit.ts`) resolves it from a
**single local default org** (the one FR-ORG-5's backfill already created),
via a request-scoped resolver function, not a hardcoded literal scattered
across call sites — so swapping in real multi-org routing later is a
one-function change, not a re-grep of the codebase.

**Deferred, not deleted:** OD-11 stays open as a real future decision —
*when* this tool is actually deployed for more than one operator or one
org, not before. At that point the Google OAuth / Auth0 / magic-link
tradeoffs from the retracted pass above are the right menu to revisit, this
time against whatever host is actually chosen.

### 7.2 Call selection & sampling (G3)

- **FR-SEL-1:** Launch UI SHALL expose: Vapi connection picker, assistant multi-select, **date range (from/to)** on `startedAt`, **max call count**, vertical assignment, and optional language filter. **Confirmed 2026-08-26 with Abhishek: every one of these is optional except max call count** — a bulk can be "the most recent N calls, no other filter," and adding a date range / assistant / vertical narrows that N, it never becomes a second required field.
- **FR-SEL-2:** System SHALL fetch matching calls from Vapi with server-side filters (`createdAtGe`/`createdAtLe`) + cursor pagination, lifting the current 50-page cap to a configurable limit sized for ≥ 10k calls, with progress feedback during discovery.
- **FR-SEL-3:** Sampling strategies SHALL be offered: `most_recent`, `random`, and `stratified` (by assistant × duration bucket × language). Default: `stratified`.
- **FR-SEL-4:** Before launch, system SHALL show a **preview**: matched count, total audio minutes, per-provider estimated cost, and estimated wall-clock time at configured concurrency.
- **FR-SEL-5:** Calls whose recordings are expired/unavailable SHALL be skipped-and-reported, not fatal (extends existing fresh-URL logic in `resolveFreshRecordingUrl()`).
- **FR-SEL-6:** Dedupe SHALL be enforced by the existing unique index `(sourceProvider, sourceCallId)`; already-imported calls SHALL be reused, not duplicated.
- **FR-SEL-7 (new, this pass):** Launch UI SHALL expose a **minimum call duration** filter (default 5s). Real gap: without one, a bulk of "1,000 calls" can be quietly dominated by near-zero-length noise (voicemail beeps, immediate hangups, misdials) that have almost no speech to score — they don't fail outright, they just inflate the call count while contributing near-meaningless WER data and eating into the Tier-A gold budget (§11) for calls not worth gold-annotating in the first place.
- **FR-SEL-8 (new, this pass):** Launch UI SHALL expose a **call outcome filter** (Vapi's own `endedReason`: completed calls only by default, with an explicit opt-in to include voicemail/no-answer/customer-did-not-answer). Same failure mode as FR-SEL-7 from a different angle — an "ended" status alone doesn't mean anyone spoke.

### 7.3 Bulks (G4)

- **FR-BLK-1:** A **Bulk** is a named evaluation batch: `{org_id, name, selection_criteria (frozen jsonb snapshot), provider_variant_ids[], shard_size, status, cost_estimate_cents, launched_by}`. It is the parent of one or more runs.
- **FR-BLK-2:** Name defaults to `YYYY-MM-DD` (launch date, local time); user MAY override at creation. Names are unique per org.
- **FR-BLK-3:** Launch fans the selected calls into **shards** (default 50 calls/shard); each shard × selected providers = one run reusing the entire existing run/result/score machinery unchanged.
- **FR-BLK-4:** Bulk statuses: `draft → estimating → awaiting_confirmation → running → complete | partial | failed | cancelled`. `partial` when ≥1 cell failed after retries.
- **FR-BLK-5:** Cost gate: if estimate exceeds the org's configurable threshold, launch requires explicit confirmation (extends NFR-8 to bulk level).
- **FR-BLK-6:** `POST /bulks/:id/retry-failed` SHALL re-enqueue only failed/pending cells (honoring v1 FR-E4 resumability) into new shard-runs under the same bulk.
- **FR-BLK-7:** Cancelling a running bulk SHALL stop un-started cells and mark them `cancelled`; in-flight provider requests complete and are recorded.
- **FR-BLK-8:** Every bulk produces a manifest (bulk-level composition of run manifests) satisfying v1 FR-REP1 bit-exact-replay requirements.
- **FR-BLK-9 (new, this pass):** A bulk's `selection_criteria` MAY be saved as a **named template**, independent of any specific launch — real gap: without this, evaluating "the same slice, run weekly" (§5's market scan already cites Coval's "named reusable suites" as the practice to adopt) means re-entering every filter by hand each time. A template stores the criteria only, not a frozen snapshot; launching from it re-resolves the date range relative to launch time (e.g. "last 7 days" as a rolling window, not a fixed date), which a frozen bulk's own `selection_criteria` deliberately does not do (FR-BLK-1's snapshot is fixed on purpose, for replay — a template is the opposite case, meant to shift).

**Confirmed with Abhishek 2026-08-26 — four more requirements, one of which is a real redesign of existing v1 behavior (called out explicitly, not silently changed):**

- **FR-BLK-10 (new): max 3 bulks per org; creating a 4th auto-evicts the oldest.** Eviction is a *thin-wrapper* delete, never a corpus delete: it removes the bulk row and cascade-deletes only **that bulk's own runs, results, scores, and rankings** (all regenerable — re-run the bulk later and pay providers again if you want the numbers back). It never touches `benchmark_calls` — gold transcripts and de-id attestations are irreplaceable human work, shared across bulks and the plain Review/Runs flow, and stay in the corpus forever regardless of which bulk (if any) last referenced them. Enforced synchronously in `POST /bulks`: if the org already has 3, delete the oldest (by `created_at`) in the same transaction before inserting the new one.

- **FR-BLK-11 (new, REDESIGN — v1's run-creation validation changes for bulks specifically): a bulk's calls don't all have to be reviewed before the bulk can run.** Today (v1, still true in the running app as of this PRD), `POST /benchmark/runs`'s validation is all-or-nothing: *every* selected call must already be `ready_to_run` or the entire run is blocked (`routes/benchmark.ts`, the `blockers` array). For a bulk of 50–1,000 calls pulled by date range, waiting for 100% review before anything can run defeats the point of pulling that many calls in the first place — real gold-transcript throughput is the known bottleneck (§11, R4). **New behavior, bulk-triggered runs only:** partition the bulk's calls into `ready_to_run` vs not; execute providers only on the ready subset; report the rest as `skipped_pending_review` (a new outcome class, not a failure) with a count, not an error. **Deliberately NOT changed for non-bulk runs:** the existing Runs-page flow, where a human explicitly ticks specific calls by hand, keeps today's strict all-or-nothing block — that's a deliberate, small, explicit selection where "some of what you picked isn't ready" is worth surfacing as a hard stop, not silently partial-running. The redesign is scoped to bulks, where partial execution is the whole point of dealing with hundreds of calls at once.

- **FR-BLK-12 (new): a bulk is runnable through both the Agent (quality-check) path and the normal manual/batch run path** — the same named bulk, either lens. **Real cost consequence, not hidden:** agent-scanning a bulk means running `flagTranscript` + (conditionally) `judgeCandidates` + a full provider re-transcription pass on *every call in the bulk*, not one call like today's on-demand single-call scan. A 50-call bulk agent-scan is ~50× today's per-scan OpenAI + provider cost. The launch UI SHALL show this estimate before firing, same pattern as FR-SEL-4's preview for a normal run — no bulk-wide agent scan fires without the operator seeing the cost first.

- **FR-BLK-13 (new): every run and every agent-scan spawned from a bulk carries and displays the bulk's name**, on the Runs page, the Results page, and the Agent page — not just an internal `bulk_id` FK. Each also reports, plainly, not buried in a notes string: **calls in the bulk (total)**, **calls actually run** (the `ready_to_run` subset, per FR-BLK-11), **calls skipped pending review**, and **total provider-cells executed** (calls-run × providers-selected). This was the explicit ask ("the bundle name will mention the same... number of call runs were made, total number of provider run made") and matches data the executor already tracks (`callCount`, `providerIds.length`, `okCells`/`totalCells`) — the redesign here is surfacing it as structured fields the UI can render directly, not parsing it back out of the free-text `notes` string the executor writes today.

### 7.4 Execution engine at scale (G1)

- **FR-EXC-1:** Execution SHALL move to a persistent job queue backed by the existing Postgres (**pg-boss** — no new infrastructure on Replit postgresql-16); workers run as a separate process/replica from the API server.
- **FR-EXC-2:** Per-provider concurrency ceilings and token-bucket rate limits SHALL be configurable (e.g., Deepgram concurrent-request caps); 429/5xx responses SHALL retry with exponential backoff + jitter, max 3 attempts, then mark the cell failed with a classified error (`rate_limited | auth | timeout | bad_audio | provider_error | unknown`).
- **FR-EXC-3:** Cells SHALL be idempotent per `(run, provider, call)`; re-execution never duplicates results.
- **FR-EXC-4:** Progress SHALL be observable: bulk-level counters (done/running/failed/total, ETA, per-provider failure breakdown) served from indexed aggregate queries, polled by the UI (~2s) — no websocket requirement in v2.
- **FR-EXC-5:** Audio fetches within a bulk SHALL be cached content-addressed (sha256 → object path) so N providers reuse one download; cached blobs expire per retention policy (§13).
- **FR-EXC-6:** Worker crash recovery SHALL be automatic: queued/running jobs older than a lease timeout are reclaimed; partial runs surface as `partial`, never silently stuck.
- **FR-EXC-7:** Raw provider outputs SHALL be stored gzip-compressed (they dominate storage at 7,000+ cells); hash verification retained.
- **FR-EXC-8 (new, this pass): a 20,000-row hard ceiling on `benchmark_provider_call_results`, org-wide.** Real numbers checked before picking a mechanism, not assumed: at the actual current row size (measured live, 2026-08-26: 238 rows = 1MB table, ~3.4KB average row including raw provider output), 20,000 rows is ≈86MB — nowhere close to a real disk risk on any host this app runs on. **The number is Abhishek's explicit call, kept as a hard backstop regardless of the math** — the primary, and normally sufficient, cleanup mechanism is FR-BLK-10's bulk eviction (results only pile up from bulk runs and ad-hoc manual runs; capping bulks at 3 already bounds the bulk side). FR-EXC-8 exists for the ad-hoc side, which FR-BLK-10 doesn't reach: if the org-wide row count would exceed 20,000 on insert, delete the oldest results **not currently referenced by one of the 3 live bulks** until back under the cap, oldest-first by `created_at`. A result belonging to a live bulk is never evicted by this path even if it's the oldest row overall — only FR-BLK-10's own bulk-eviction touches those.

### 7.5 Per-agent results (G5)

- **FR-RES-1:** New **Agent view** scoped to org → Vapi assistant (calls already carry `sourceAssistantId`): headline card shows **the recommendation** — winning provider variant, composite score, WER, Entity Accuracy — followed by the confidence badge and evidence links.
- **FR-RES-2:** Below the headline: full ranked table of all evaluated provider variants for that agent, sortable by any metric, each row linking to per-call drill-down (word diff, entity hits/misses — existing `detail` jsonb).
- **FR-RES-3:** Recommendation text SHALL be generated from data with explicit evidence: sample size, 95% CI on the deciding metric, margin over runner-up, and whether that margin is statistically significant (§10). Insufficient evidence renders "no defensible recommendation yet" — never a fake winner.
- **FR-RES-4:** Agent view SHALL be reachable from the bulk detail page and standalone (aggregating across bulks).
- **FR-RES-5 (new, this pass):** An **Agents directory** view lists every Vapi assistant an org has evaluated, one row each, showing at a glance: current recommended provider, composite score, confidence badge, last-evaluated date. Real gap without it: FR-RES-1..4 only describe looking at *one* agent at a time — there was no way to scan "which of our 12 agents actually have a confident recommendation vs. which are still low-confidence" without opening each individually. This is the fleet-level view the per-agent card was missing a home in.

### 7.6 Comparison view (G6)

- **FR-CMP-1:** User SHALL select any ≥2 provider **variants** (including two models of the same vendor) and a slice: bulk, agent, vertical, language, or arbitrary intersection.
- **FR-CMP-2:** Output SHALL include: side-by-side metric table with delta column vs. selected baseline, distribution views (per-call WER scatter/box), entity-type breakdown matrix, latency/cost columns, and per-call diff explorer.
- **FR-CMP-3:** Comparison SHALL support spanning multiple bulks (trend: did Deepgram regress between July and August bulks?) via bulk-date x-axis sparklines.
- **FR-CMP-4:** Export: CSV + JSON, matching v1 FR-R3 artifact conventions.
- **FR-CMP-5 (new, this pass):** Comparison state (selected variants + slice) SHALL be encoded in the URL (query params, not client-only state) so a specific comparison is a shareable/bookmarkable link. Real gap: without this, "here's the comparison that justified switching to Deepgram" is a screenshot or a re-click-through, not a link someone can open and get the same live view — matches the market scan's own citation of Artificial Analysis's per-model comparison pages, which are all linkable.

### 7.7 Provider model catalog & toggles (G7)

- **FR-MOD-1:** Registry refactored from fixed adapter-per-id to `createAdapter(vendor, model, options)`. Hardcoded constants (`model: "nova-3"` at `deepgram.ts:53`, `"ink-whisper"` at `cartesia.ts:224`) become parameters. Vendor catalog declares supported models + capabilities + pricing metadata.
- **FR-MOD-2:** DB: `benchmark_providers` gains `vendor` and `model` columns; id becomes `{vendor}-{model-slug}` generated at insert. Historical ids preserved (migration maps old ids onto vendor+model pairs).
- **FR-MOD-3:** UI: Providers page gains per-vendor sections; each vendor section lists enabled model variants with enable/disable toggles (preserving v1 FR-P3 semantics) and an "add variant" action fed by the catalog. Seeded catalog at launch: Deepgram (nova-2, nova-3), ElevenLabs (scribe-v1), OpenAI (gpt-4o-transcribe, whisper-1), AssemblyAI (universal, universal-2), Gladia, Speechmatics, Cartesia (ink-whisper) — exact availability verified live per FR-MOD-4.
- **FR-MOD-4:** A variant SHALL NOT enter `ready` state until a **live smoke transcription passes** (fixes the flagged OpenAI-adapter-never-verified-limited gap; mock-only adapters are structurally blocked from production ranking).
- **FR-MOD-5:** Config hash continues to cover model string + params; changing a variant's model forks a new variant id rather than mutating history.
- **FR-MOD-6 (new, this pass):** Adding a **new model of an already-integrated vendor** (e.g. Deepgram ships nova-4) SHALL be a catalog-data change (an admin-facing form: model slug, display name, cost/min, capability flags), not a code change or deploy — FR-MOD-3's "add variant action fed by the catalog" only works this way if the catalog is genuinely data, not a hardcoded list read by that UI. **Explicitly still out of scope:** a brand-new *vendor* (one with no adapter at all) still requires real adapter code — this only removes the deploy step for a vendor already integrated, it does not turn the app into a no-code STT-integration platform.

### 7.8 Multilingual support (G8)

- **FR-LNG-1:** `benchmark_calls` gains `language` (BCP-47) with provenance (`vapi_metadata | detected | manual`) and confidence. Detection: provider-reported language when available, else fastText-class LID on the draft transcript; curator override in review flow (v1 §5.1 step 5 extended).
- **FR-LNG-2:** Scoring selects primary metric per §4.3 (WER vs CER by script); `normalizeTranscript()` becomes locale-aware (parameterized case folding; removes hardcoded `en-US`).
- **FR-LNG-3:** Entity matching becomes locale-aware: per-language entity patterns (phone/address/name formats differ); English-only patterns degrade gracefully and are flagged in `detail`.
- **FR-LNG-4:** Rankings/leaderboards gain a language dimension: filter by language; per-vertical×language boards; cross-language rollups only as labeled "accuracy" with per-language sample sizes shown.
- **FR-LNG-5:** Provider catalog carries a language-support matrix (from vendor docs, marked unverified-until-tested); selecting calls in language X warns when a selected provider lacks declared support.
- **FR-LNG-6:** Code-switched calls (detected >1 language above threshold) SHALL be scored with CER and flagged; they never silently inflate a monolingual average.
- **FR-LNG-7:** v1 NG3 (English-only) is hereby revoked; accent variation remains in scope per v1.
- **FR-LNG-8 (new, this pass):** Language rollout is **prioritized by evidence from the real corpus, not built breadth-first.** The verticals this tool actually benchmarks today (Rush truck parts, property management, trucking dispatch — real calls seen include US property-management assistants like "Falcon Point Apartments," "Waterside Apartments") are US industries with a materially Spanish-speaking caller population; that is the realistic near-term second language, not an arbitrary pick from §4.3's full language-class table. **This is a hypothesis to verify against real language-detection numbers on the actual corpus once FR-LNG-1 ships, not a decision to ship blind** — but it means M4 should launch detecting/scoring en + es first and prove out the §11.1 Tier-A math (already worked through for a 3-language case) against real es call volume, before spending engineering time on CJK/Thai support nothing in the current corpus has demonstrated a need for yet.

## 8. Data Model Changes (conceptual DDL)

```text
organizations        NEW   id, name, slug, cost_threshold_cents, settings jsonb, timestamps
vapi_connections     NEW   id, org_id FK, label, encrypted_secret, key_fingerprint,
                           status(active|invalid|disabled), last_verified_at, created_by, timestamps
benchmark_bulks      NEW   id, org_id FK, name, status, selection_criteria jsonb (frozen),
                           provider_variant_ids text[], shard_size int DEFAULT 50,
                           min_duration_seconds int DEFAULT 5, allowed_ended_reasons text[],
                           estimated_cost_cents, actual_cost_cents, launched_by, timestamps
bulk_templates       NEW   id, org_id FK, name, selection_criteria jsonb (unfrozen -- FR-BLK-9;
                           date range stored relative, e.g. "last 7 days", re-resolved per launch),
                           provider_variant_ids text[], created_by, timestamps
benchmark_runs       ALTER + org_id FK NULLABLE→NOT NULL, + bulk_id FK NULLABLE (ad-hoc runs stay
                           bulk-less; FR-BLK-11's skipped_pending_review is a per-call result
                           outcome, not a run-level status -- a bulk run can be "complete" overall
                           while individual calls in it show that outcome)
benchmark_agent_scans ALTER + bulk_id FK NULLABLE (FR-BLK-12 -- a bulk-triggered agent scan is
                           traceable to its bulk exactly like a bulk-triggered run; a lone
                           on-demand scan from the Agent page, as today, stays bulk-less)
benchmark_calls      ALTER + org_id, + language text, + language_source enum(vapi_metadata|detected|manual),
                           + language_confidence float, + assistant_id text (promoted from sourceAssistantId)
benchmark_providers  ALTER + vendor text, + model text (id stays PK; migration backfills)
benchmark_provider_call_results ALTER + status enum gains `skipped_pending_review` (FR-BLK-11) --
                           distinct from `failed`: nothing was attempted, no cost was spent, and it
                           is not an error to retry, only a call waiting on human review
benchmark_scores     ALTER + metric_primary enum(wer|cer), + cer float NULLABLE
benchmark_rankings   ALTER + language dimension (rankings keyed vertical×language×provider)
audit_log            ALTER + org_id
```

Indexes added: `(org_id, status)` on bulks/runs; `(bulk_id)` on runs; `(org_id, sourceProvider, sourceCallId)` unique preserved semantically; `(language)` partial on calls; aggregate-friendly covering index on results `(run_id, status)`.

### 8.1 Migration safety (M1 touches live data — no rollback plan existed before this)

M1 runs two structural migrations concurrently on real, non-reproducible
data: 71 real calls plus their full run/result/score/audit history (not
synthetic — human-reviewed gold transcripts and de-id attestations that
cannot be regenerated if lost). Backfilling `org_id` everywhere *and*
reshaping every `benchmark_providers` id to `{vendor}-{model-slug}` in the
same phase, with no rollback step specified anywhere in this document,
is the actual risk — not the migrations' logic, which is reasonable.

Required before M1's migration runs, not after:
1. **`pg_dump` the full database immediately before migration**, verified
   restorable to a scratch database first (a backup nobody has test-restored
   is not a backup).
2. **Two migrations, two commits, run in sequence, not as one script**:
   `org_id` backfill (FR-ORG-5) lands and is verified first (row counts,
   spot-checked FKs) before the separate `benchmark_providers` id-reshape
   (FR-MOD-2) starts. If the second one needs to be rolled back, the first
   one's already-verified state isn't dragged down with it.
3. **Dry run against a copy of production data first** — per this project's
   own standing worktree rule (`.claude/CLAUDE.md`: "Use a worktree for...
   any database schema changes"), run both migrations against a restored
   copy in an isolated worktree/DB, diff row counts and a sample of FK
   integrity before touching the real `stt-evals-pg` database.
4. **`benchmark_providers` id reshape is a foreign-key-bearing rename**
   (`benchmark_provider_call_results.provider_id` FK references it) — the
   migration must update the FK'd column in the same transaction as the
   rename, not as a follow-up step, or every existing result row silently
   orphans.

## 9. API Surface (additions)

```text
POST   /orgs                                  GET /orgs
POST   /orgs/:orgId/vapi-connections          GET/DELETE /orgs/:orgId/vapi-connections/:id
POST   /orgs/:orgId/vapi-connections/:id/verify
GET    /vapi/calls?connectionId&assistantIds&startedAtFrom&startedAtTo&limit   (preview/discovery)
POST   /bulks                                 {name?, criteria{...}, providerVariantIds, shardSize?}
GET    /bulks?status                          GET /bulks/:id            (progress aggregates)
POST   /bulks/:id/retry-failed                POST /bulks/:id/cancel
GET    /bulks/:id/results?groupBy=assistant|vertical|language   (FR-BLK-13: includes callsTotal,
                                               callsRun, callsSkippedPendingReview, totalCellsRun)
POST   /bulks/:id/agent-scan                  (FR-BLK-12: batch-scan every call in the bulk; response
                                               includes the cost estimate up front, same as FR-SEL-4)
POST   /bulk-templates                        GET /bulk-templates       (FR-BLK-9)
POST   /bulk-templates/:id/launch             (re-resolves the template's relative date window, creates a bulk)
GET    /agents                                (FR-RES-5 directory: every assistant, recommendation + confidence, one row each)
GET    /agents/:assistantId/summary           (headline recommendation + CI)
POST   /compare                               {providerVariantIds[], slice{...}} → comparison payload
GET    /catalog/stt                            (vendors, models, capabilities, language matrix, pricing)
```

All request/response schemas enter `openapi.yaml` and regenerate zod + React-query clients via the existing orval pipeline — no hand-written client drift.

## 10. Statistics at Scale (G9)

Replacing `run-executor.ts:722-725`'s hardcoded "<12 ⇒ low confidence" string:

- **ST-1:** Proportion metrics (entity, alphanumeric) report **Wilson 95% score intervals** — correct behavior at small n.
- **ST-2:** WER/CER distributions report **bootstrap percentile CIs** (1,000 resamples over cells), following standard ASR significance practice (Bisani & Ney, ICASSP 2004; blockwise variant where segment correlation matters).
- **ST-3:** Headline recommendations require the winner to beat the runner-up by a **paired bootstrap test** (p < 0.05) on the deciding metric; otherwise UI states statistical tie and surfaces tie-breaking factors (cost, latency) per org policy (resolves v1 OD-9 mechanically).
- **ST-4:** Decision-readiness gate: a slice is "decision-ready" when the 95% CI half-width on Entity Accuracy ≤ 3pp **and** n ≥ 30 scored calls; otherwise the confidence badge computes honestly (low/medium/high) from CI width — no magic constant 12.
- **ST-5:** Stratified sampling (FR-SEL-3) prevents bulk launches from being dominated by one assistant's call profile.

## 11. Corpus Strategy at 1,000+ Calls (honest constraint)

Human double-attested gold does not scale linearly. Tiered corpus policy:

| Tier | Definition | Share (target) | Use |
|---|---|---|---|
| **A — Verified gold** | Current pipeline: draft → human edit → second attestation | ~10–15%, stratified | All headline metrics, recommendations, significance tests |
| **B — Assisted gold** | Strong-model transcript + human spot-check (sampled audit of 10%) | ~35% | Secondary metrics, drift monitoring |
| **C — Coverage only** | Imported, transcribed, no gold | remainder | Coverage/latency/cost/failure-rate reporting only; excluded from accuracy leaderboards |

Leaderboards SHALL label which tiers contribute to each displayed number. Tier-B audit failures above threshold demote the assisting model's future eligibility (configurable).

### 11.1 Does the Tier-A target actually clear the ST-4 gate? (worked, not assumed)

§10's ST-4 requires **n ≥ 30 scored calls** per decision-ready cell. Every
scored Tier-A call is transcribed by *every* selected provider variant (that
is how a benchmark run works — one call, N providers), so `n` for a
(provider, vertical) pair equals the count of Tier-A calls in that vertical,
not that count divided by the number of providers. Worth showing the actual
numbers rather than asserting the tier split is enough:

**Pre-multilingual (M1–M3, 3 verticals, no language dimension yet):**
1,000-call bulk × 15% Tier-A = 150 gold calls ÷ 3 verticals ≈ **50 per
vertical** (assuming roughly even stratified sampling, FR-SEL-3). 50 ≥ 30 —
clears ST-4 with real margin. Pre-multilingual, the 10–15% target is fine.

**Once M4 lands (language becomes a dimension of ST-4, per §4.3/FR-LNG-4):**
the same 150 Tier-A calls now split by vertical **×** language. At just 3
active languages, evenly stratified: 150 ÷ (3 verticals × 3 languages) ≈
**16.7 per cell — below 30.** Real call volume is never evenly stratified
across vertical×language either, so some cells (e.g. a low-volume
vertical/language pair) will be worse than the average, not better.

**Conclusion:** the fixed 10–15% Tier-A share is sized for the pre-M4 world
and silently stops being sufficient the moment M4 ships, unless one of these
is also true — pick explicitly, don't let it default:
- Tier-A share scales with active language count: target ≈ `30 × (verticals
  × active languages) / bulk size`, recomputed whenever a language is added
  to the "actively scored" set, not fixed at 10–15% forever; or
- M4 launches with decision-readiness scoped to English only at first
  (matches G8's "multilingual conversations end-to-end" ambition less, but
  keeps ST-4 honest on day one), expanding language-by-language only once
  each new language's Tier-A volume is confirmed ≥30/vertical; or
- Bulk size itself scales with the number of active languages, not held at
  the "1,000–10,000" range in G1 regardless of language count.
No preference stated here — this needs a product decision before M4 starts,
not an assumption baked into §10 and §11 quietly disagreeing with each other.

## 12. Risks

| ID | Risk | L | I | Mitigation |
|----|------|---|---|------------|
| R1 | Vapi pagination/list instability at 10k+ calls (server-side `assistantId` filter already observed broken) | High | High | Cursor pagination on createdAt with seen-ID termination (existing pattern), client-side filtering, discovery progress + resumable import |
| R2 | Provider rate limits/concurrency caps hit mid-bulk | High | Med | Per-provider limiters, backoff+jitter, classified failures, retry-failed |
| R3 | Cost blowup on mis-scoped bulk | Med | High | Preview estimate + hard confirmation gate + org budget ceiling (FR-BLK-5) |
| R4 | Gold bottleneck stalls accuracy work at volume | High | Med | Tiered corpus (§11); Tier-A sampling targets per language×vertical |
| R5 | Queue/worker infra bugs strand bulks | Med | Med | pg-boss lease/reclaim (FR-EXC-6), bulk-level watchdog alert, cancel path |
| R6 | Multilingual scoring subtly wrong (normalization, entity locales) | Med | High | Golden-unit tests per language family; metric type always displayed; code-switch flags (FR-LNG-6) |
| R7 | Same-vendor variant explosion clutters rankings | Med | Low | Variant enable/disable defaults; comparison view requires explicit selection |
| R8 | Published provider prices diverge from invoices at 100× volume | High | Low | Rates stay "unverified until invoiced"; actual-cost reconciliation column (FR-BLK-1) |
| R9 | Adapters never verified live (historically: OpenAI mocked-only; LiteLLM proxy secret missing) — **OpenAI closed 2026-08-25**, verified live end-to-end (real key, real cell, `status: ok`); ElevenLabs and Speechmatics remain in this state (no key yet) | Known | High | FR-MOD-4 live smoke gate — structurally prevents mock-only providers from ranking |
| R10 | ~~pg-boss workers vs. Replit autoscale~~ — **resolved favorably, not by luck: the project moved off Replit** (`ox-alpha/deployment.md`, confirmed 2026-08-26). API server now targets "any long-running host (Fly.io/Railway/VPS)" — long-running by definition, which is exactly the shape FR-EXC-1's worker process needs. New, smaller risk in its place: which of those three hosts, and whether the worker runs as a second process/service on it or inside the API process — still an open call (see OD-13-adjacent decision, not yet numbered), but no longer a platform mismatch. | Low | Med | Decide worker topology (separate process vs. in-process) when the API host is chosen (§ ox-alpha/deployment.md, still undecided); no longer needs resolving *before* M2 design since any of the three candidate hosts supports it |
| R11 | **Postgres connection-pool contention.** The run-executor already opens a dedicated `pool.connect()` per run just to hold `pg_try_advisory_lock` (`run-executor.ts:162`) for the run's full duration. Layering pg-boss's own polling connections on the same instance, on top of the API server's own pool, stacks three independent consumers against one connection ceiling — never sized or tested. | Med | High | Load-test connection count at target worker concurrency (FR-EXC-2's ceilings) against Replit Postgres's actual max-connections *before* committing to pg-boss; have a fallback (e.g. a single shared advisory-lock connection instead of one per run) ready if it's tight |
| R12 (new, this pass) | **FR-BLK-10's cascade-delete is the first destructive automated path in this whole PRD** (everything else is additive or human-triggered one row at a time). A bug in its scope check — e.g. the eviction query drifting to also match rows by `call_id` instead of strictly `run_id`/`bulk_id` — would silently delete real corpus data, not regenerable results. Every other write in this system is either append-only or gated behind an explicit human action; this is neither. | Low | Critical | AC-2.8 exists specifically to catch this (asserts `benchmark_calls` rows are byte-identical before/after eviction) — that test is not optional polish, it is the actual safety mechanism for R12 and must be green before FR-BLK-10 ships, not added after |

## 13. Governance Additions

- Per-org data isolation inherits v1 §8 posture (de-id attestations, access logging, append-only audit).
- Retention: cached audio blobs TTL-configurable per org (default 30 days); raw outputs retained indefinitely soft-delete per v1 FR-REP2.
- Cross-border note: sending EU-caller audio to US-hosted STT vendors requires per-org vendor allowlist — recorded in `vapi_connections.settings` and enforced at launch validation.

## 14. Acceptance Criteria

### M1 — Foundation (multi-org + catalog)
- [ ] AC-1.1: Default-org migration completes; zero cross-org leakage in integration tests
- [ ] AC-1.2: ≥2 Vapi connections registrable via the UI (no server restart) and verifiable; secrets stored **encrypted at rest** (AES-256-GCM), never in plaintext, never returned by any API response (verified by DB inspection + audit) — corrected this pass: the original wording ("never stored in DB") contradicted FR-ORG-2's own encrypted-storage design once that stopped meaning raw env vars
- [ ] AC-1.3: Registry accepts `(vendor, model)` params; seeded variants listed in FR-MOD-3 respond to smoke pings where keys exist
- [ ] AC-1.4: A provider variant cannot reach `ready` without passing a live smoke transcription (test proves the gate)
- [ ] AC-1.5 (new): Adding a new model of an already-integrated vendor (FR-MOD-6) requires zero code changes and zero deploy — proven by adding one via the admin form in a test and confirming it's immediately selectable

### M2 — Bulk engine
- [ ] AC-2.1: A 1,000-call bulk × 5 provider variants (5,000 cells) drains to terminal state with ≤ 0.5% unclassified failures on the rehearsal harness (extending `rehearsal-scale.ts`)
- [ ] AC-2.2: Kill a worker mid-bulk → lease reclaim resumes without duplicate cells (idempotency proven by test)
- [ ] AC-2.3: Injected 429 storm → classified `rate_limited` failures, backoff visible, retry-failed clears ≥ 95%
- [ ] AC-2.4: Cost estimate within ±25% of actual on rehearsal; confirmation gate fires above threshold
- [ ] AC-2.5: Bulk named by default with launch date; custom names enforced unique per org
- [ ] AC-2.6 (new): A bulk excludes calls below the configured minimum duration (FR-SEL-7) and non-"completed" outcomes (FR-SEL-8) by default; preview count reflects the filter before launch, not after
- [ ] AC-2.7 (new): A saved bulk template (FR-BLK-9) launched twice on different days resolves a *different* concrete date range each time (rolling window), while a regular bulk's frozen `selection_criteria` never changes on re-view
- [ ] AC-2.8 (new): Creating a 4th bulk in an org auto-evicts the oldest (FR-BLK-10); its runs/results/scores/rankings are gone, but every `benchmark_calls` row it referenced — gold transcript, de-id attestations, everything — is provably untouched (test asserts the call rows are byte-identical before/after eviction)
- [ ] AC-2.9 (new): A bulk with a mix of `ready_to_run` and `needs_review` calls, when run, executes providers on the ready subset only; the not-ready calls surface as `skipped_pending_review` (a real, unambiguous status, not folded into `failed`); a plain (non-bulk) run with the same mix still hard-blocks entirely, unchanged from v1 (FR-BLK-11)
- [ ] AC-2.10 (new): `GET /bulks/:id/results` returns `callsTotal`, `callsRun`, `callsSkippedPendingReview`, and `totalCellsRun` as real fields the UI reads directly — not values parsed back out of a free-text `notes` string (FR-BLK-13)
- [ ] AC-2.11 (new): Triggering `POST /bulks/:id/agent-scan` on a bulk shows its cost estimate before firing (FR-BLK-12); after it runs, every resulting `benchmark_agent_scans` row carries the bulk's `bulk_id` and the bulk's name renders next to it in the Agent page
- [ ] AC-2.12 (new): Org-wide `benchmark_provider_call_results` row count never exceeds 20,000 (FR-EXC-8); a synthetic test that inserts past the cap confirms the oldest non-live-bulk rows are evicted first, and that rows belonging to one of the 3 live bulks are never evicted by this path

### M3 — Results & comparison UX
- [ ] AC-3.1: Agent view renders headline recommendation + CI badge + full variant table from real data
- [ ] AC-3.2: Comparison of two same-vendor variants (e.g., nova-2 vs nova-3) possible with delta table, per-call diffs, CSV export
- [ ] AC-3.3: Trend view spans ≥2 bulks
- [ ] AC-3.4: All rankings pages display sample size + metric type per row
- [ ] AC-3.5 (new): `/agents` directory (FR-RES-5) lists every evaluated assistant with recommendation + confidence in one screen, no per-agent click-through required to see it
- [ ] AC-3.6 (new): A comparison's URL, opened fresh (new tab, no client state), reproduces the exact same selected variants + slice (FR-CMP-5)

### M4 — Multilingual
- [ ] AC-4.1: Calls taggable with language from Vapi metadata / detection / manual override; provenance stored
- [ ] AC-4.2: A zh or ja call scores with CER and displays "CER" labeling end-to-end; en unaffected (regression suite green)
- [ ] AC-4.3: Language filter + per-vertical×language leaderboard live; cross-language rollup shows per-language n
- [ ] AC-4.4: Locale-aware normalization unit tests cover ≥6 language families incl. code-switch flag case
- [ ] AC-4.5 (new): Real language-detection numbers run against the live corpus (FR-LNG-8) confirm or refute the en+es priority *before* any language-specific scoring work beyond en/es begins — this AC is a checkpoint that can send the plan back to re-prioritize, not a rubber stamp

### M5 — Statistical rigor
- [ ] AC-5.1: Wilson CIs on proportion metrics; bootstrap CIs on WER — validated against known fixtures
- [ ] AC-5.2: Paired-bootstrap significance drives the recommendation/tie verdict; hardcoded "<12" heuristic removed
- [ ] AC-5.3: Decision-ready gate (ST-4) demonstrably flips on synthetic small-n data

## 15. Phasing

The original wk1–11 estimates below assumed team-of-engineers pacing. This
is one person directing an AI coding assistant, part-time alongside other
Ellavox/freelance work (`.claude/CLAUDE.md`) — a different, slower rate that
should be stated honestly rather than carried over from a template. Revised
estimates below also account for R10/R11 (§12) needing a spike *inside* M2,
not after it, and OD-11 needing to close *before* M1 starts, not during it.

| Phase | Scope | Exit | Original est. | Revised est. |
|---|---|---|---|---|
| M1 | Orgs (query-layer scoping, no auth needed yet — OD-11 §7.1), connections, catalog refactor, smoke gate | AC-1.* | wk 1–2 | 1–2 wks (auth-wiring days from the earlier estimate no longer apply) |
| M2 | pg-boss workers, sharding, rate limits, retry/cancel, cost gate, bulk UX, **+ R10/R11 hosting-topology and connection-pool spike** | AC-2.* | wk 3–6 | 5–8 wks |
| M3 | Agent view, comparison view, trends, exports | AC-3.* | wk 6–8 | 2–3 wks |
| M4 | Language tagging, CER path, locale-aware scoring, language boards, **+ resolve §11.1's Tier-A-share-vs-ST-4 decision before scoring any language beyond English** | AC-4.* | wk 8–10 | 3–4 wks |
| M5 | Stats rigor, decision gates, tiered-corpus labeling | AC-5.* | wk 10–11 | 2 wks |

**Revised total: ~15–20 weeks**, not 11 — roughly double, driven mostly by
M2 (real distributed-systems work: a job queue, worker hosting, rate
limiting, and now a connection-budget spike, done by one person) and M4
picking up a real product decision (§11.1) it didn't have costed in before.
M2 is still the critical path and still de-risks everything else; M4/M5 are
still parallelizable after M2 once §11.1 is decided. Treat these as
directional, not committed — the honest move once M1 is actually underway
is to re-estimate M2 from real velocity on M1, not keep either number as
fixed.

## 16. Open Decisions

| ID | Question | Owner | Due |
|----|----------|-------|-----|
| OD-11 | ~~AuthN/AuthZ mechanism for org scoping~~ — **resolved 2026-08-26 (3rd pass): none needed now.** Local, single-operator project; a login system would solve a problem that doesn't exist yet. Org-scoping enforced at the query layer instead (§7.1). Real decision (Google OAuth / Auth0 / Clerk / magic-link, per the retracted 2nd pass) deferred to whenever this is actually deployed for >1 operator or org. | Abhishek | Resolved (deferred) |
| OD-12 | Tier-B assisting model choice + audit sampling rate | Eng + Curator | M3 |
| OD-13 | Default shard size (50) vs provider-optimal batching | Eng | M2 |
| OD-14 | ja scoring: character-level vs word-segmenter-assisted | Eng | M4 |
| OD-15 | Whether agent-level recommendations may override vertical-level ones in UI hierarchy | Product | M3 |
| OD-16 | Budget ceiling defaults per org | Product | M2 |
| OD-17 | **New:** which of §11.1's three Tier-A-scaling options (share scales with active languages / English-only decision-readiness at M4 launch / bulk size scales with language count) — must close before M4 scores any non-English language | Product | Before M4 |

---

## Appendix A — Research Sources

- AssemblyAI — ["Word error rate is broken: How to actually evaluate speech-to-text in 2026"](https://www.assemblyai.com/blog/word-error-rate-is-broken) — WER limitations, importance-weighted alternatives.
- [ASR Leaderboard: Towards Reproducible and Transparent Multilingual and Long-Form Speech Recognition Evaluation](https://arxiv.org/html/2510.06961v4) — standardized WER/RTFx methodology, reproducibility framing.
- Hugging Face [Open ASR Leaderboard](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard) (context via [Modulate announcement](https://www.modulate.ai/press-releases/modulate-earns-1-spot-on-hugging-faces-transcription-benchmark)) — transparency/reproducibility norms.
- [Artificial Analysis — Speech to Text leaderboard](https://artificialanalysis.ai/speech-to-text/non-streaming) — per-model WER/speed/price comparison pattern.
- Coval — ["Best STT Providers 2026: Independent Benchmarks"](https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/) and voice-agent evaluation guides — scenario suites, probabilistic testing, TTFB/WER metric sets.
- Hamming AI — ["How to Evaluate Voice Agents (2026)"](https://hamming.ai/resources/how-to-evaluate-voice-agents-2026) and [Coval-vs-Hamming comparison](https://www.coval.ai/blog/coval-vs-hamming) — production call replay, review queues, audio-native eval.
- Gladia — ["Best speech-to-text APIs in 2026"](https://www.gladia.io/blog/best-speech-to-text-apis) — provider language-support figures (AssemblyAI ~99 langs, etc.; treated unverified per R8).
- Bisani & Ney, ["Bootstrap estimates for confidence intervals in ASR performance evaluation"](http://congres.cran.univ-lorraine.fr/2004/ICASSP_2004/pdfs/0100409.pdf), ICASSP 2004; companion implementation [ogunlao/asr_stat_significance](https://github.com/ogunlao/asr_stat_significance) (bootstrap & blockwise bootstrap WER significance).
- Multilingual metric conventions: [Romanization Encoding for Multilingual ASR](https://arxiv.org/html/2407.04368v2) (CER for Mandarin, WER for English), [ATC code-switching CER practice](https://arxiv.org/pdf/2305.00170), [aggregate-WER insufficiency analysis](https://arxiv.org/html/2607.18912v1).
