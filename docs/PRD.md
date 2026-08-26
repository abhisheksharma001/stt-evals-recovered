# STT Benchmark Platform — Product Requirements Document

**Version:** 0.1 — Draft  
**Status:** Working document; open decisions tracked in §11  
**Verticals in scope:** Rush, Property Management, Trucking  
**Providers in scope:** Deepgram Nova-3, AssemblyAI Universal, OpenAI gpt-4o-transcribe, OpenAI Whisper, ElevenLabs Scribe, Gladia, Speechmatics, Cartesia Ink-Whisper (added on direct request, outside the original written ticket's candidate list -- see docs/HANDOFF.md)

---

## 1. Problem Statement

Operational voice calls in Rush, property-management, and trucking workflows contain high-value structured entities — work-order/RO numbers, unit/property identifiers, VINs, phone numbers, names, addresses — that downstream systems ingest. Different STT providers handle domain vocabulary, number accuracy, background noise, and multi-speaker calls differently. No objective, reproducible comparison exists for these three verticals on our actual call audio. The result is selection risk: picking the wrong provider costs either accuracy (missed entities, wrong VINs) or money (overpaying for marginal gains).

## 2. Goals

| # | Goal |
|---|------|
| G1 | Produce a reproducible, vendor-neutral accuracy ranking of the seven providers across the three verticals |
| G2 | Quantify entity-specific accuracy (RO, unit, VIN, phone, name, address) separately from raw WER |
| G3 | Measure latency (time-to-first-partial, time-to-final) and cost/minute under realistic usage assumptions |
| G4 | Produce a diarization quality score for multi-speaker calls |
| G5 | Deliver a go/no-go recommendation per vertical with supporting evidence a non-technical stakeholder can read |
| G6 | Keep the corpus legally clean: de-identified, access-controlled, audit-logged, with documented vendor data-handling positions |
| G7 | Make every benchmark run reproducible to bit-level output by freezing configs, corpus, and scoring code at run time |

## 3. Non-Goals

| # | Non-Goal |
|---|----------|
| NG1 | Real-time production integration — this is an evaluation harness only |
| NG2 | Full conversational AI or LLM post-processing evaluation |
| NG3 | Languages other than English (accent variation within English is in scope) |
| NG4 | Telephony-infrastructure benchmark (codec/PSTN quality is treated as a fixed input) |
| NG5 | Automated corpus growth without manual approval gate |
| NG6 | Provider SLA / uptime benchmarking |
| NG7 | Mobile or browser-based recording — all audio is pre-existing operational call recordings |

## 4. Users

| Role | Who | Primary Need |
|------|-----|--------------|
| **Benchmark Operator** | Internal engineer running the harness | Queue runs, inspect raw outputs, debug failures |
| **Corpus Curator** | QA analyst approving gold transcripts | Upload calls, annotate entities, approve gold |
| **Decision Maker** | Engineering lead or product owner | Read vertical ranking, trust the recommendation |
| **Compliance Officer** | Legal/security reviewer | Audit de-identification, vendor data flow, retention |
| **Data Governor** | Senior engineer owning the dataset | Manage versions, access control, deletion requests |

## 5. Workflows

### 5.1 Corpus Intake & Gold-Reference Creation (Corpus Curator)
1. Curator selects a call recording from operational storage.
2. Curator confirms the call meets de-identification criteria (§8.2).
3. Curator registers the call via `POST /benchmark/calls` with metadata.
4. Call status moves to `needs_review`.
5. A second reviewer listens, verifies de-identification, and edits the gold transcript.
6. Gold transcript is approved (`gold_in_review` → `ready_to_run`).

### 5.2 Benchmark Execution (Benchmark Operator)
1. Operator confirms ≥1 call in `ready_to_run` status and ≥1 provider in `ready` status.
2. Operator queues a run via `POST /benchmark/runs` specifying provider IDs and call IDs.
3. Harness sends each call to each provider with the frozen config for that provider-version.
4. Raw outputs (transcripts, word-level timestamps if available, confidence scores) are stored immutably.
5. Scoring pipeline normalizes both gold and hypothesis transcripts and computes all metrics.
6. Run status advances to `complete`; rankings surface via `GET /benchmark/rankings`.

### 5.3 Decision Review (Decision Maker)
1. Decision Maker opens dashboard (`GET /benchmark/dashboard`) to see corpus readiness and run status.
2. Reviews `GET /benchmark/rankings` by vertical with score breakdown and recommendation text.
3. Drills into entity-level and per-call breakdowns to validate edge cases.
4. Signs off on provider selection per vertical.

### 5.4 Compliance Audit (Compliance Officer)
1. Reviews `docs/data-governance.md` and the audit log.
2. Verifies each call in the corpus has a de-identification attestation record.
3. Verifies vendor data-handling acknowledgments are on file.
4. Confirms retention schedule is being followed.

## 6. Functional Requirements

### 6.1 Corpus Management
- **FR-C1:** System SHALL store call metadata (vertical, duration, hard-case tags, status, gold transcript, entity notes, audio object path).
- **FR-C2:** System SHALL enforce a five-state status machine: `needs_review → ready_for_gold → gold_in_review → ready_to_run → archived`.
- **FR-C3:** System SHALL require at least two distinct approvers before a call reaches `ready_to_run`.
- **FR-C4:** System SHALL record who approved each status transition and when.
- **FR-C5:** Audio files SHALL be stored in an access-controlled object store (path reference stored in DB, not the blob).

### 6.2 Provider Configuration
- **FR-P1:** Each provider record SHALL capture: name, model/version string, API key reference (secret name, not value), streaming support flag, diarization support flag, keyword-boosting config, cost-per-minute (verified at implementation time), and a config note.
- **FR-P2:** Keyword/phrase boosting lists SHALL be version-controlled alongside provider configs.
- **FR-P3:** Providers SHALL be individually enable/disable-able without deleting historical results.

### 6.3 Benchmark Execution
- **FR-E1:** Each run SHALL be associated with an immutable snapshot of: corpus call IDs + their gold hashes, provider IDs + their config hashes, and scoring code version.
- **FR-E2:** Harness SHALL submit identical audio (same file, same format) to all providers in a run.
- **FR-E3:** Harness SHALL record: submission timestamp, first-partial-received timestamp (if streaming), final-received timestamp, HTTP status, raw response body.
- **FR-E4:** Runs SHALL be resumable: a partially-failed run can re-run only the failed cells (provider × call) without re-running successful ones.
- **FR-E5:** System SHALL support running a subset of providers or a subset of calls (e.g., for regression testing after a config change).

### 6.4 Scoring
- **FR-S1:** System SHALL compute WER (substitutions + insertions + deletions / reference word count) after transcript normalization.
- **FR-S2:** System SHALL compute exact-match entity accuracy per entity type (RO/work-order, unit/property-ID, VIN, phone, name, address) using the entity annotations on the gold transcript.
- **FR-S3:** System SHALL compute number/alphanumeric accuracy as a distinct sub-metric.
- **FR-S4:** System SHALL compute diarization score (DER or JER) for calls that have speaker-segment gold annotations.
- **FR-S5:** System SHALL compute time-to-first-partial and time-to-final in milliseconds.
- **FR-S6:** System SHALL compute estimated cost per minute based on provider-configured rate × call duration.
- **FR-S7:** All scoring functions SHALL be versioned; score records SHALL reference the scoring version used.
- **FR-S8:** System SHALL produce a composite ranking score per provider per vertical (weights are a logic gate — see `docs/logic-register.md`).

### 6.5 Reporting
- **FR-R1:** Rankings SHALL be filterable by vertical and sortable by any metric.
- **FR-R2:** Dashboard SHALL show corpus readiness, run status, and a one-line decision status.
- **FR-R3:** System SHALL export per-run results as a structured JSON artifact (for offline analysis and reproducibility records).

### 6.6 Reproducibility
- **FR-REP1:** Every run SHALL produce a run manifest (see `docs/reproducibility.md`) that allows bit-exact replay.
- **FR-REP2:** Raw provider outputs SHALL be stored indefinitely (soft-delete only, with data-governor override).
- **FR-REP3:** The platform SHALL detect and flag if a call's gold transcript or a provider's config has changed since a run was executed.

## 7. Non-Functional Requirements

| ID | Category | Requirement |
|----|----------|-------------|
| NFR-1 | Latency | Dashboard and rankings reads < 500 ms p95 |
| NFR-2 | Correctness | Scoring pipeline SHALL have unit tests covering all normalization and metric edge cases |
| NFR-3 | Security | All API keys stored as environment secrets, never in DB or logs |
| NFR-4 | Access Control | Corpus audio accessible only to authorized roles; read access logged |
| NFR-5 | Auditability | All state transitions on calls and runs are append-only audit records |
| NFR-6 | Reproducibility | Re-scoring from stored raw outputs SHALL produce identical scores (given same scoring version) |
| NFR-7 | Portability | Corpus manifest and raw outputs SHALL be exportable in a format that allows migration to a different platform |
| NFR-8 | Cost Control | Benchmark harness SHALL estimate run cost before execution and require confirmation if > configurable threshold |
| NFR-9 | Observability | Each provider API call SHALL be traced with latency, status code, and byte count |

## 8. Data Model (Conceptual)

```
BenchmarkCall
  id                UUID PK
  label             text                    -- human-readable, no PII
  vertical          enum(rush, property_management, trucking)
  duration_seconds  float
  status            enum(needs_review, ready_for_gold, gold_in_review, ready_to_run, archived)
  hard_cases        text[]                  -- e.g. ["vin_accuracy", "cross_talk"]
  gold_transcript   text                    -- normalized reference
  entity_notes      jsonb                   -- annotated entity spans
  audio_object_path text                    -- path in access-controlled store
  de_id_attested_by uuid FK → users
  de_id_attested_at timestamptz
  created_at        timestamptz
  created_by        uuid FK → users

Provider
  id                UUID PK
  name              text
  model             text                    -- e.g. "nova-3", "universal-2"
  status            enum(not_configured, ready, disabled)
  supports_streaming bool
  supports_diarization bool
  cost_per_minute   float                   -- MUST be verified at implementation time
  keyword_boosting  bool
  config_hash       text                    -- SHA-256 of serialized config
  config_note       text
  created_at        timestamptz

BenchmarkRun
  id                UUID PK
  status            enum(queued, running, complete, blocked, failed)
  corpus_snapshot   jsonb                   -- {call_id: gold_hash} map
  provider_snapshot jsonb                   -- {provider_id: config_hash} map
  scoring_version   text
  created_at        timestamptz
  completed_at      timestamptz
  notes             text

ProviderCallResult
  id                UUID PK
  run_id            UUID FK → BenchmarkRun
  provider_id       UUID FK → Provider
  call_id           UUID FK → BenchmarkCall
  submitted_at      timestamptz
  first_partial_at  timestamptz
  final_at          timestamptz
  http_status       int
  raw_output        text                    -- provider JSON verbatim
  raw_output_hash   text
  error_message     text

Score
  id                UUID PK
  result_id         UUID FK → ProviderCallResult
  scoring_version   text
  wer               float
  entity_accuracy   float
  alphanumeric_accuracy float
  latency_first_partial_ms int
  latency_final_ms  int
  cost_per_minute   float
  diarization_score float
  detail            jsonb                   -- per-entity-type breakdown
  scored_at         timestamptz

AuditLog
  id                UUID PK
  entity_type       text                    -- "call", "run", "provider", "score"
  entity_id         UUID
  actor_id          UUID FK → users
  action            text
  before_state      jsonb
  after_state       jsonb
  occurred_at       timestamptz
```

## 9. Acceptance Criteria

### MVP (10–15 calls, harness trusted)
- [ ] **AC-MVP-1:** ≥ 10 calls registered, de-identified, and in `ready_to_run` state with gold transcripts and entity annotations
- [ ] **AC-MVP-2:** ≥ 4 providers fully configured and responding to test pings
- [ ] **AC-MVP-3:** A full run completes across all MVP calls × all configured providers without operator intervention
- [ ] **AC-MVP-4:** WER and entity accuracy scores are produced and match manual spot-check on ≥ 3 calls
- [ ] **AC-MVP-5:** Scoring pipeline has unit tests for WER, normalization, and entity matching covering ≥ 10 documented edge cases
- [ ] **AC-MVP-6:** All corpus calls have a de-identification attestation record
- [ ] **AC-MVP-7:** Run manifest is produced and a re-score from raw outputs matches original scores

### Full Benchmark (50–100 calls)
- [ ] **AC-FULL-1:** ≥ 50 calls across all three verticals (≥ 12 per vertical), covering documented hard cases
- [ ] **AC-FULL-2:** All 6 providers configured and returning results
- [ ] **AC-FULL-3:** Diarization scores computed for all multi-speaker calls where providers support it
- [ ] **AC-FULL-4:** Cost model validated against at least one actual provider invoice
- [ ] **AC-FULL-5:** Statistical significance threshold applied to rankings (see `docs/logic-register.md` §11)
- [ ] **AC-FULL-6:** Decision-ready report exported and reviewed by Decision Maker
- [ ] **AC-FULL-7:** Reproducibility: independent re-run of any prior run from manifest produces identical scores

## 10. Rollout Plan

### Phase 0 — Foundation (Weeks 1–2)
- DB schema, API server, corpus intake UI
- De-identification checklist and approval workflow
- Object storage integration

### Phase 1 — MVP Corpus & Harness (Weeks 3–5)
- Curate 10–15 calls with gold transcripts and entity annotations
- Integrate ≥ 4 providers
- Scoring pipeline: WER, entity accuracy, latency, cost
- Unit test suite for scoring
- Run first MVP benchmark

### Phase 2 — Harness Hardening (Week 6)
- Reproducibility verification
- Resume-on-failure
- Cost pre-flight estimate
- Audit log review

### Phase 3 — Full Benchmark (Weeks 7–10)
- Scale to 50–100 calls
- Integrate remaining providers
- Add diarization scoring
- Statistical significance analysis
- Custom vocabulary / keyword-boosting experiments

### Phase 4 — Decision & Handoff (Week 11)
- Export decision report
- Archive corpus snapshot
- Document winning config per vertical
- Retention and deletion schedule activated

## 11. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|------------|
| R1 | Provider API changes model or pricing mid-benchmark | Medium | High | Pin model version in config; verify pricing before run |
| R2 | Corpus audio is not sufficiently de-identified | Medium | Critical | Two-person attestation gate; legal review checklist |
| R3 | Gold transcript quality is inconsistent across curators | Medium | High | Style guide, inter-annotator agreement check on 10% overlap |
| R4 | Small corpus (10–15 calls) leads to unreliable ranking | High | Medium | Report confidence intervals; defer hard decisions to full benchmark |
| R5 | Provider sends training data opt-out noncompliance | Low | Critical | Verify DPA / zero-retention terms before any audio is sent |
| R6 | Keyword-boosting lists differ across runs | Medium | Medium | Boost lists are versioned and hashed into run manifest |
| R7 | Latency measurements confounded by network/test-time | Medium | Medium | Run from a stable network location; report p50/p95 not just mean |
| R8 | Cost/minute published rates differ from actual billing | High | Low | Flag all rates as "unverified until invoiced"; see provider-matrix |

## 12. Open Decisions

| ID | Question | Owner | Target Date |
|----|----------|-------|-------------|
| OD-1 | Composite ranking weights (WER vs entity vs latency vs cost) | Engineering Lead | Phase 1 end |
| OD-2 | Exact WER normalization rules (punctuation, case, numerals, filler words) | Corpus Curator + Eng | Phase 1 start |
| OD-3 | Entity extraction method for hypothesis transcripts (regex vs LLM) | Engineering | Phase 1 |
| OD-4 | Diarization gold format (RTTM vs custom JSON) | Engineering | Phase 2 |
| OD-5 | Statistical significance threshold and method (bootstrap vs permutation) | Engineering | Phase 3 |
| OD-6 | Minimum corpus size per vertical for a defensible ranking | Decision Maker | Phase 1 |
| OD-7 | DER vs JER for diarization metric | Engineering | Phase 2 |
| OD-8 | Custom vocabulary experiment design (paired vs separate run) | Engineering | Phase 3 |
| OD-9 | Tie-breaking rule when two providers are within confidence interval | Decision Maker | Phase 3 |
| OD-10 | Retention period for raw provider outputs | Compliance Officer | Phase 0 |

---

*This document is the source of truth for product scope. All task decomposition in `docs/execution-plan.md` traces back to requirements in §6–§9.*


---

## 14. Known defect register (living)

All post-implementation defects found by audit (code review, 100-agent bug
hunt, UX/CX swarm) are tracked — with severity, file:line, trigger, impact,
fix sketch, and per-bug status — in the living register at
[`ox-alpha/bug-register.md`](../ox-alpha/bug-register.md) (100 curated entries as of 2026-08-25 — wave 1 code-hunt B-1..B-81 plus
wave-2 verified P1s B-82..B-100 — with a 391-line verbatim confirmed-findings
appendix; P0 items and their owners are listed there).
Claim-level triage (pricing provenance, adapter verification state, kill
criteria) lives in [`ox-alpha/triage.md`](../ox-alpha/triage.md). This PRD
section is a pointer only — the register is the source of truth, and each fix
flips its status line in place.
