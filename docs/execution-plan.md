# STT Benchmark — Execution Plan

**Traceability:** Every task ID maps to one or more PRD requirements (§6–§9).  
**Logic gates:** Tasks marked `LOGIC: YES` have a decision embedded. The decision question is stated explicitly — do not build until resolved.  
**Status field** in `tasks.yaml` is the machine-readable counterpart.

---

## Phase 0 — Foundation

Goal: database schema, API skeleton, object storage, governance workflow, and dev environment are all working before any audio is touched.

---

### P0-T1 · DB Schema — Core Tables

| Field | Value |
|-------|-------|
| **ID** | P0-T1 |
| **Phase** | 0 — Foundation |
| **Title** | Define and migrate core database schema |
| **Deliverable** | Drizzle ORM schema file with all tables from PRD §8; migration applied to dev DB |
| **Dependencies** | None |
| **Inputs** | PRD §8 data model; `DATABASE_URL` env |
| **Outputs** | `artifacts/api-server/src/db/schema.ts`; applied migration |
| **Acceptance** | `pnpm --filter @workspace/db run push` succeeds; all tables and enum types present in DB |
| **Logic** | NO |

**Tables:** `benchmark_calls`, `providers`, `benchmark_runs`, `provider_call_results`, `scores`, `audit_log`, `users` (minimal: id, email, role).

---

### P0-T2 · Object Storage Integration

| Field | Value |
|-------|-------|
| **ID** | P0-T2 |
| **Phase** | 0 — Foundation |
| **Title** | Wire audio object-store path handling |
| **Deliverable** | Utility that validates `audioObjectPath` format; pre-signed URL generation for authorized reads; no audio served through the API server directly |
| **Dependencies** | P0-T1 |
| **Inputs** | Storage provider choice (S3-compatible or equivalent); IAM/access-key env secrets |
| **Outputs** | `lib/storage.ts`; env-var references documented |
| **Acceptance** | Upload a test WAV; authorized role can generate a read URL; unauthorized role gets 403; URL access is logged |
| **Logic** | NO |

---

### P0-T3 · API Skeleton — All Routes Wired

| Field | Value |
|-------|-------|
| **ID** | P0-T3 |
| **Phase** | 0 — Foundation |
| **Title** | Implement all OpenAPI endpoints with stub handlers |
| **Deliverable** | Express route handlers for all 10 paths in `openapi.yaml`; Zod request/response validation; all return 200/201 with empty/mock shapes |
| **Dependencies** | P0-T1 |
| **Inputs** | `lib/api-spec/openapi.yaml`; generated Zod schemas |
| **Outputs** | `artifacts/api-server/src/routes/`; passing `GET /healthz` |
| **Acceptance** | All routes respond to valid requests; invalid request bodies return 400 with field errors |
| **Logic** | NO |

---

### P0-T4 · Audit Log Middleware

| Field | Value |
|-------|-------|
| **ID** | P0-T4 |
| **Phase** | 0 — Foundation |
| **Title** | Append-only audit log for all state mutations |
| **Deliverable** | Express middleware that writes to `audit_log` on every mutating request (POST/PATCH); records actor, entity type/ID, before/after state |
| **Dependencies** | P0-T1, P0-T3 |
| **Inputs** | DB schema; authenticated user context |
| **Outputs** | Middleware module; `audit_log` populated in integration test |
| **Acceptance** | Every PATCH on a call produces a row in `audit_log` with correct before/after state; rows are never deleted by application code |
| **Logic** | NO |

---

### P0-T5 · De-identification Checklist & Approval Workflow

| Field | Value |
|-------|-------|
| **ID** | P0-T5 |
| **Phase** | 0 — Foundation |
| **Title** | Implement two-person de-id attestation gate |
| **Deliverable** | `PATCH /benchmark/calls/:id` enforces that `status` cannot advance past `ready_for_gold` without `de_id_attested_by` being set by a different user than `created_by`; attestation recorded in audit log |
| **Dependencies** | P0-T1, P0-T3, P0-T4 |
| **Inputs** | PRD FR-C2, FR-C3, FR-C4; `docs/data-governance.md` §2 checklist |
| **Outputs** | Route validation logic; integration test covering attempted self-attestation |
| **Acceptance** | Self-attestation returns 422; cross-user attestation succeeds; audit record created |
| **Logic** | NO |

---

### P0-T6 · Provider Config CRUD with Secret Reference

| Field | Value |
|-------|-------|
| **ID** | P0-T6 |
| **Phase** | 0 — Foundation |
| **Title** | Provider creation/update with secret-name (not value) storage |
| **Deliverable** | `POST /benchmark/providers` and update logic; API key stored as env-secret name (e.g. `DEEPGRAM_API_KEY`), never the raw value; config hash computed on write |
| **Dependencies** | P0-T1, P0-T3 |
| **Inputs** | PRD FR-P1, FR-P2 |
| **Outputs** | Provider records in DB with `config_hash` |
| **Acceptance** | Creating a provider with `apiKeySecretName: "DEEPGRAM_API_KEY"` stores only the name; config hash changes when any field changes |
| **Logic** | NO |

---

## Phase 1 — MVP Corpus & Harness

Goal: 10–15 approved calls, 4+ providers integrated, scoring pipeline producing validated numbers.

---

### P1-T1 · Gold Transcript Style Guide

| Field | Value |
|-------|-------|
| **ID** | P1-T1 |
| **Phase** | 1 — MVP Corpus |
| **Title** | Write gold transcript annotation style guide |
| **Deliverable** | `docs/gold-style-guide.md`: rules for capitalization, punctuation, numbers (digit vs. word), filler words, overlapping speech, entity tagging syntax |
| **Dependencies** | P0-T5 |
| **Inputs** | PRD OD-2; sample calls from each vertical |
| **Outputs** | Style guide document; annotated example from each vertical |
| **Acceptance** | Two independent curators annotate the same 2-minute segment and achieve ≥ 90% token-level agreement (measured manually) |
| **Logic** | **YES — OD-2:** Decide normalization rules before any gold transcripts are created. Key questions: (a) Are filler words ("uh", "um") included or stripped? (b) Are numbers written as digits or words in gold? (c) Is punctuation included or excluded from WER computation? Resolve before P1-T3. |

---

### P1-T2 · Entity Annotation Format

| Field | Value |
|-------|-------|
| **ID** | P1-T2 |
| **Phase** | 1 — MVP Corpus |
| **Title** | Define entity annotation schema for gold transcripts |
| **Deliverable** | JSON schema for `entity_notes` field; types: `ro_number`, `unit_id`, `vin`, `phone`, `person_name`, `address`; each annotation has span (start/end char offset), type, normalized value |
| **Dependencies** | P1-T1 |
| **Inputs** | PRD FR-S2; sample calls |
| **Outputs** | JSON schema file; updated `BenchmarkCallUpdate` validation |
| **Acceptance** | Schema validated with at least 2 calls from each vertical; round-trip parse/serialize works |
| **Logic** | **YES — OD-3:** Decide entity extraction method for *hypothesis* transcripts: (a) regex patterns per entity type, (b) LLM-assisted extraction, (c) span alignment from gold positions. Regex is deterministic and auditable but brittle; LLM adds another variable. Resolve before P1-T5. |

---

### P1-T3 · Corpus Curation — 10–15 Calls

| Field | Value |
|-------|-------|
| **ID** | P1-T3 |
| **Phase** | 1 — MVP Corpus |
| **Title** | Curate and approve MVP corpus (10–15 calls) |
| **Deliverable** | ≥ 10 calls in `ready_to_run` status with gold transcripts and entity annotations; ≥ 3 calls per vertical; hard-case tags applied |
| **Dependencies** | P0-T5, P1-T1, P1-T2 |
| **Inputs** | Operational call recordings; de-identification checklist; style guide |
| **Outputs** | DB records; corpus manifest v0.1 |
| **Acceptance** | PRD AC-MVP-1; all calls have `de_id_attested_by` ≠ `created_by`; all gold transcripts pass style-guide review |
| **Logic** | NO (curation is human judgment following documented rules) |

**Hard-case tag taxonomy (minimum):**
- `vin_accuracy` — call contains VIN read-out
- `ro_number` — repair-order number spoken
- `unit_id` — property/unit ID spoken
- `cross_talk` — two speakers simultaneously
- `background_noise` — HVAC, traffic, machinery
- `phone_number` — phone digits spoken
- `address_dictation` — address spelled or spoken
- `accent_variation` — non-standard accent
- `low_audio_quality` — compressed or clipped

---

### P1-T4 · Provider Integration — Deepgram Nova-3

| Field | Value |
|-------|-------|
| **ID** | P1-T4 |
| **Phase** | 1 — MVP Harness |
| **Title** | Integrate Deepgram Nova-3 |
| **Deliverable** | Provider adapter: submits audio, captures raw JSON response, records timestamps; smoke-test against 1 corpus call |
| **Dependencies** | P0-T6 |
| **Inputs** | Deepgram API docs; `DEEPGRAM_API_KEY` secret; provider config record |
| **Outputs** | `artifacts/api-server/src/providers/deepgram.ts`; `ProviderCallResult` row in DB |
| **Acceptance** | Test call returns a transcript; `first_partial_at` populated if streaming; `raw_output` stored verbatim; latency fields populated |
| **Logic** | **YES:** Decide streaming vs. batch mode for latency measurement. If batch only, `first_partial_at` is null — document as missing capability per logic-register policy. Confirm keyword-boosting parameter name and syntax from current API docs. |

---

### P1-T5 · Provider Integration — AssemblyAI Universal

| Field | Value |
|-------|-------|
| **ID** | P1-T5 |
| **Phase** | 1 — MVP Harness |
| **Title** | Integrate AssemblyAI Universal |
| **Deliverable** | Provider adapter; smoke-test; result record |
| **Dependencies** | P0-T6 |
| **Inputs** | AssemblyAI API docs; `ASSEMBLYAI_API_KEY` secret |
| **Outputs** | `artifacts/api-server/src/providers/assemblyai.ts`; DB record |
| **Acceptance** | Same as P1-T4 |
| **Logic** | **YES:** Confirm whether AssemblyAI Universal requires audio upload before transcription (async two-step) vs. single call; affects latency instrumentation design. Confirm diarization parameter. |

---

### P1-T6 · Provider Integration — OpenAI (gpt-4o-transcribe + Whisper)

| Field | Value |
|-------|-------|
| **ID** | P1-T6 |
| **Phase** | 1 — MVP Harness |
| **Title** | Integrate OpenAI gpt-4o-transcribe and Whisper |
| **Deliverable** | Single adapter supporting both model variants via config; smoke-test both |
| **Dependencies** | P0-T6 |
| **Inputs** | OpenAI API docs; `OPENAI_API_KEY` secret |
| **Outputs** | `artifacts/api-server/src/providers/openai.ts`; 2 provider records in DB |
| **Acceptance** | Both models return transcripts; model is captured in provider record |
| **Logic** | **YES:** gpt-4o-transcribe is a newer model — confirm current API endpoint name, whether it shares the `/audio/transcriptions` endpoint or is separate, and current per-minute pricing. Do not hard-code any price; fetch from provider config at run time. |

---

### P1-T7 · Provider Integration — ElevenLabs Scribe

| Field | Value |
|-------|-------|
| **ID** | P1-T7 |
| **Phase** | 1 — MVP Harness |
| **Title** | Integrate ElevenLabs Scribe |
| **Deliverable** | Provider adapter; smoke-test |
| **Dependencies** | P0-T6 |
| **Inputs** | ElevenLabs API docs; `ELEVENLABS_API_KEY` secret |
| **Outputs** | `artifacts/api-server/src/providers/elevenlabs.ts`; DB record |
| **Acceptance** | Same as P1-T4 |
| **Logic** | **YES:** Confirm whether Scribe supports diarization and keyword boosting. If diarization is unsupported, document as missing capability — do not impute a score. |

---

### P1-T8 · Transcript Normalization Pipeline

| Field | Value |
|-------|-------|
| **ID** | P1-T8 |
| **Phase** | 1 — MVP Harness |
| **Title** | Implement transcript normalization (pre-WER) |
| **Deliverable** | `lib/scoring/normalize.ts`: lowercasing, punctuation stripping (configurable), numeral expansion or contraction (per OD-2 decision), filler-word handling |
| **Dependencies** | P1-T1 (OD-2 resolved) |
| **Inputs** | Gold style guide; logic-register §1 |
| **Outputs** | Normalization module; unit tests ≥ 15 cases |
| **Acceptance** | Unit tests pass; normalization is deterministic (same input → same output always); applied identically to gold and hypothesis |
| **Logic** | **YES — OD-2 implementation:** Normalization rules must be frozen before scoring any call. See `docs/logic-register.md` §1 for alternatives and decision gate. |

---

### P1-T9 · WER Computation

| Field | Value |
|-------|-------|
| **ID** | P1-T9 |
| **Phase** | 1 — MVP Harness |
| **Title** | Implement WER metric |
| **Deliverable** | `lib/scoring/wer.ts`: word-level edit distance (dynamic programming), returns WER + substitution/insertion/deletion counts |
| **Dependencies** | P1-T8 |
| **Inputs** | Normalized gold and hypothesis strings; logic-register §2 |
| **Outputs** | WER module; unit tests ≥ 10 cases including empty hypothesis, all-wrong hypothesis, identical transcripts |
| **Acceptance** | Output matches manual calculation on 3 spot-check pairs; WER ≥ 0 and handles edge cases without crash |
| **Logic** | **YES:** Decide WER denominator: reference length vs max(ref, hyp). Standard is reference length — confirm and document. |

---

### P1-T10 · Entity Extraction from Hypothesis Transcripts

| Field | Value |
|-------|-------|
| **ID** | P1-T10 |
| **Phase** | 1 — MVP Harness |
| **Title** | Implement entity extraction for hypothesis transcripts |
| **Deliverable** | `lib/scoring/entity-extract.ts`: extracts entity candidates from raw hypothesis text using method chosen at OD-3 |
| **Dependencies** | P1-T2 (OD-3 resolved), P1-T8 |
| **Inputs** | Entity annotation schema; logic-register §3 |
| **Outputs** | Extraction module; unit tests per entity type |
| **Acceptance** | Correctly extracts ≥ 90% of entities from 3 manually annotated test transcripts; handles common OCR-style confusions (zero vs O, one vs I) |
| **Logic** | **YES — OD-3:** Regex approach is default. For VINs, use 17-character alphanumeric pattern. For RO/unit IDs, pattern must be configured per vertical (they have no universal format). For phone numbers, E.164 normalization. Decision gate: agree on per-entity regex patterns before this task is built. |

---

### P1-T11 · Entity Accuracy Scorer

| Field | Value |
|-------|-------|
| **ID** | P1-T11 |
| **Phase** | 1 — MVP Harness |
| **Title** | Implement entity accuracy metric |
| **Deliverable** | `lib/scoring/entity-score.ts`: compares extracted hypothesis entities against gold annotations; returns per-type exact-match accuracy and aggregate |
| **Dependencies** | P1-T10, P1-T2 |
| **Inputs** | Gold entity annotations; hypothesis entity extractions; logic-register §3, §4 |
| **Outputs** | Scoring module; unit tests |
| **Acceptance** | Correctly scores 5 manually constructed gold/hypothesis pairs; tie-breaking and normalization-before-match are tested |
| **Logic** | **YES:** Decide matching strategy: (a) exact string match after normalization, (b) normalized Levenshtein distance ≤ 1. Default is exact match after normalization. Any tolerance is a logic gate requiring explicit approval. |

---

### P1-T12 · Latency Instrumentation

| Field | Value |
|-------|-------|
| **ID** | P1-T12 |
| **Phase** | 1 — MVP Harness |
| **Title** | Instrument and record provider latency |
| **Deliverable** | All provider adapters record `submitted_at`, `first_partial_at` (null if batch-only), `final_at`; latency computed in milliseconds and stored in `Score` |
| **Dependencies** | P1-T4, P1-T5, P1-T6, P1-T7 |
| **Inputs** | Logic-register §5; PRD FR-S5 |
| **Outputs** | Updated adapter code; latency fields in Score |
| **Acceptance** | For a streaming provider, `first_partial_at` is within 5 seconds of `submitted_at` on a real call; `final_at` > `first_partial_at`; no provider shows negative latency |
| **Logic** | **YES:** Decide clock source — use `Date.now()` on the harness server, not provider-reported timestamps, for comparability. Document network round-trip as a confound. |

---

### P1-T13 · Cost Model

| Field | Value |
|-------|-------|
| **ID** | P1-T13 |
| **Phase** | 1 — MVP Harness |
| **Title** | Implement cost estimation and recording |
| **Deliverable** | `lib/scoring/cost.ts`: computes `estimated_cost = cost_per_minute_from_config × duration_seconds / 60`; pre-flight estimate for a run; actual cost recorded in Score |
| **Dependencies** | P0-T6, P1-T3 |
| **Inputs** | Provider `cost_per_minute` (from config, not hard-coded); call `duration_seconds` |
| **Outputs** | Cost module; pre-flight API endpoint or run-creation warning |
| **Acceptance** | Pre-flight estimate within 1% of post-run computed cost; if `cost_per_minute` is 0 or null, cost is reported as "unverified" not 0 |
| **Logic** | **YES:** All cost/minute values in provider configs are operator-entered and MUST be flagged as unverified until compared to an actual invoice. Build a `rate_verified` boolean on the Provider table. |

---

### P1-T14 · Scoring Orchestrator

| Field | Value |
|-------|-------|
| **ID** | P1-T14 |
| **Phase** | 1 — MVP Harness |
| **Title** | Wire scoring pipeline into run execution |
| **Deliverable** | After a `ProviderCallResult` is saved, scoring pipeline runs and writes a `Score` row; orchestrator handles failures (partial score) without crashing the run |
| **Dependencies** | P1-T9, P1-T11, P1-T12, P1-T13 |
| **Inputs** | `ProviderCallResult.raw_output`; gold transcript; entity annotations |
| **Outputs** | `Score` record; `detail` JSONB with per-entity breakdown |
| **Acceptance** | Full run on 3 calls × 2 providers produces 6 Score rows; detail field includes per-entity-type breakdown; failed scoring records error without deleting the raw output |
| **Logic** | NO (orchestration logic is structural, not algorithmic) |

---

### P1-T15 · Run Execution Engine

| Field | Value |
|-------|-------|
| **ID** | P1-T15 |
| **Phase** | 1 — MVP Harness |
| **Title** | Implement run queue, execution, and status machine |
| **Deliverable** | `POST /benchmark/runs` queues a run; worker processes each provider × call cell; status transitions: `queued → running → complete/failed`; partial failure → `blocked` |
| **Dependencies** | P1-T4, P1-T5, P1-T6, P1-T7, P1-T14, P0-T4 |
| **Inputs** | PRD FR-E1–FR-E5 |
| **Outputs** | Run record with status; all ProviderCallResult rows; all Score rows |
| **Acceptance** | PRD AC-MVP-3; a run with 1 intentionally failing provider cell completes remaining cells and reaches `blocked` status, not `failed` |
| **Logic** | **YES:** Decide execution model: (a) in-process sequential, (b) job queue (BullMQ/pg-boss), (c) serverless. For MVP, in-process sequential is acceptable. For scale, a job queue avoids timeout issues. Decide before building. |

---

### P1-T16 · MVP Integration Test — End-to-End

| Field | Value |
|-------|-------|
| **ID** | P1-T16 |
| **Phase** | 1 — MVP Harness |
| **Title** | End-to-end integration test: corpus → run → scores |
| **Deliverable** | Automated test that creates 3 test calls with synthetic gold transcripts, runs against a mock provider adapter, asserts Score rows are correct |
| **Dependencies** | P1-T15, P1-T14, P1-T3 |
| **Inputs** | All scoring modules; mock provider returning known transcripts |
| **Outputs** | Passing test suite; test coverage report |
| **Acceptance** | Test suite passes in CI; WER computed from mock output matches pre-calculated expected value to 4 decimal places |
| **Logic** | NO |

---

## Phase 2 — Harness Hardening

Goal: Reproducibility, resume-on-failure, cost pre-flight, audit hardening, run manifests.

---

### P2-T1 · Run Manifest Generation

| Field | Value |
|-------|-------|
| **ID** | P2-T1 |
| **Phase** | 2 — Hardening |
| **Title** | Generate and store immutable run manifest |
| **Deliverable** | At run creation, snapshot: corpus call IDs + gold hashes, provider IDs + config hashes, scoring version string; store as `corpus_snapshot` and `provider_snapshot` JSONB on the run |
| **Dependencies** | P1-T15 |
| **Inputs** | PRD FR-E1; `docs/reproducibility.md` §3 |
| **Outputs** | Run manifest fields populated; manifest exportable as JSON |
| **Acceptance** | Modifying a call's gold transcript after a run is created does NOT change the run manifest; manifest export includes all fields per `docs/reproducibility.md` spec |
| **Logic** | NO |

---

### P2-T2 · Re-score from Raw Output

| Field | Value |
|-------|-------|
| **ID** | P2-T2 |
| **Phase** | 2 — Hardening |
| **Title** | Implement re-score command from stored raw outputs |
| **Deliverable** | CLI or API endpoint that takes a run ID and a scoring version, re-runs scoring on stored `raw_output` without re-calling providers; writes new Score rows tagged with new scoring version |
| **Dependencies** | P2-T1, P1-T14 |
| **Inputs** | `ProviderCallResult.raw_output`; scoring version |
| **Outputs** | New Score rows; diff report if scores changed |
| **Acceptance** | PRD AC-MVP-7; re-scoring with same scoring version produces bit-identical scores; re-scoring with a new normalization rule produces a documented diff |
| **Logic** | NO |

---

### P2-T3 · Resume-on-Failure

| Field | Value |
|-------|-------|
| **ID** | P2-T3 |
| **Phase** | 2 — Hardening |
| **Title** | Run resume: re-run only failed cells |
| **Deliverable** | PATCH or POST endpoint to resume a `blocked` or `failed` run; re-runs only cells where `ProviderCallResult.http_status` is not 2xx or where result is missing |
| **Dependencies** | P1-T15, P2-T1 |
| **Inputs** | PRD FR-E4 |
| **Outputs** | Resumed run reaching `complete` status |
| **Acceptance** | A run with 2 of 12 cells failed can be resumed; previously successful cells are not re-submitted; final run status is `complete` after all cells succeed |
| **Logic** | NO |

---

### P2-T4 · Cost Pre-flight Estimate

| Field | Value |
|-------|-------|
| **ID** | P2-T4 |
| **Phase** | 2 — Hardening |
| **Title** | Pre-flight cost estimate before run creation |
| **Deliverable** | `POST /benchmark/runs` returns a 402-style warning (or dedicated `GET /benchmark/runs/estimate`) when estimated cost exceeds configurable threshold; operator must confirm |
| **Dependencies** | P1-T13, P1-T15 |
| **Inputs** | PRD NFR-8 |
| **Outputs** | Pre-flight estimate in run creation response; threshold configurable via env var |
| **Acceptance** | A 100-call × 6-provider run with $0.01/min rates and 2-min avg calls shows $12 estimate; run requires explicit `confirm: true` flag to proceed |
| **Logic** | NO |

---

### P2-T5 · Staleness Detection

| Field | Value |
|-------|-------|
| **ID** | P2-T5 |
| **Phase** | 2 — Hardening |
| **Title** | Detect and flag stale run results |
| **Deliverable** | When viewing rankings or a run, system checks if any call's gold transcript hash or provider config hash differs from the run manifest; surfaces a warning |
| **Dependencies** | P2-T1 |
| **Inputs** | PRD FR-REP3 |
| **Outputs** | Staleness flag on ranking/run response |
| **Acceptance** | Modifying a call after a run produces a staleness warning on that run's rankings; unmodified runs show no warning |
| **Logic** | NO |

---

## Phase 3 — Full Benchmark

Goal: 50–100 calls, all 6 providers, diarization, statistical significance, keyword boosting experiments.

---

### P3-T1 · Corpus Scale to 50–100 Calls

| Field | Value |
|-------|-------|
| **ID** | P3-T1 |
| **Phase** | 3 — Full Benchmark |
| **Title** | Scale corpus to 50–100 approved calls |
| **Deliverable** | ≥ 50 calls in `ready_to_run`, ≥ 12 per vertical, hard-case distribution documented |
| **Dependencies** | P2-T1, P1-T3 |
| **Inputs** | PRD AC-FULL-1 |
| **Outputs** | Corpus manifest v1.0 |
| **Acceptance** | Each vertical has ≥ 3 hard-case categories represented by ≥ 2 calls each |
| **Logic** | NO |

---

### P3-T2 · Remaining Providers — Gladia & Speechmatics

| Field | Value |
|-------|-------|
| **ID** | P3-T2 |
| **Phase** | 3 — Full Benchmark |
| **Title** | Integrate Gladia and Speechmatics |
| **Deliverable** | Two provider adapters; smoke-tests; provider records |
| **Dependencies** | P0-T6, P1-T12 |
| **Inputs** | Gladia and Speechmatics API docs; `GLADIA_API_KEY`, `SPEECHMATICS_API_KEY` secrets |
| **Outputs** | `providers/gladia.ts`, `providers/speechmatics.ts` |
| **Acceptance** | Same as P1-T4; diarization and keyword-boosting flags verified against current API docs |
| **Logic** | **YES:** Confirm Speechmatics batch vs. real-time API choice — real-time has lower latency but different pricing. Confirm Gladia's transcription-only vs. audio-intelligence tier for cost. |

---

### P3-T3 · Diarization Scoring

| Field | Value |
|-------|-------|
| **ID** | P3-T3 |
| **Phase** | 3 — Full Benchmark |
| **Title** | Implement diarization evaluation |
| **Deliverable** | `lib/scoring/diarization.ts`: computes DER or JER against gold speaker-segment annotations; handles providers that do not support diarization per missing-capability policy |
| **Dependencies** | P1-T2 (entity format extended for speaker segments), P1-T8 |
| **Inputs** | Logic-register §6; PRD FR-S4; OD-4 resolved (gold format), OD-7 resolved (DER vs JER) |
| **Outputs** | Diarization module; unit tests; updated Score schema |
| **Acceptance** | PRD AC-FULL-3; DER computed correctly on 2 manually constructed RTTM-like examples; providers without diarization output `diarization_score: null` |
| **Logic** | **YES — OD-4, OD-7:** (a) Choose gold annotation format (RTTM vs custom JSON — recommend RTTM for tooling compatibility); (b) Choose DER vs JER (DER penalizes both missed and false speakers; JER is symmetric). Resolve before building. |

---

### P3-T4 · Composite Ranking Score

| Field | Value |
|-------|-------|
| **ID** | P3-T4 |
| **Phase** | 3 — Full Benchmark |
| **Title** | Implement composite ranking and `GET /benchmark/rankings` |
| **Deliverable** | `lib/scoring/composite.ts`: weighted combination of WER, entity accuracy, latency, cost, diarization per weights from OD-1; `GET /benchmark/rankings` returns ranked list per vertical |
| **Dependencies** | P1-T11, P1-T9, P1-T12, P1-T13, P3-T3 |
| **Inputs** | Logic-register §7; OD-1 resolved |
| **Outputs** | Composite scoring module; rankings endpoint |
| **Acceptance** | Rankings are reproducible from stored Score rows; changing weights reruns ranking without re-calling providers; null diarization_score providers are ranked only on available metrics |
| **Logic** | **YES — OD-1:** Weight vector must be agreed by Decision Maker. Proposed default (before decision): WER 35%, entity accuracy 35%, latency 10%, cost 10%, diarization 10%. Alternatives in logic-register §7. |

---

### P3-T5 · Statistical Significance Analysis

| Field | Value |
|-------|-------|
| **ID** | P3-T5 |
| **Phase** | 3 — Full Benchmark |
| **Title** | Compute confidence intervals and significance flags on rankings |
| **Deliverable** | `lib/scoring/significance.ts`: bootstrap confidence intervals on WER and entity accuracy per provider; flags pairs within CI as "effectively tied" |
| **Dependencies** | P3-T4 |
| **Inputs** | Logic-register §11; PRD AC-FULL-5; OD-5 resolved |
| **Outputs** | CI bounds stored in ranking output; tie flags surfaced in UI |
| **Acceptance** | Bootstrap with B=1000 iterations produces stable CIs on a fixed dataset; tied pairs correctly flagged |
| **Logic** | **YES — OD-5:** Choose significance method: (a) bootstrap percentile CI (implementation-simple), (b) paired permutation test (more statistically rigorous). Also choose α threshold (0.05 or 0.10). Resolve before building. |

---

### P3-T6 · Keyword-Boosting Experiment

| Field | Value |
|-------|-------|
| **ID** | P3-T6 |
| **Phase** | 3 — Full Benchmark |
| **Title** | Design and run keyword-boosting experiment |
| **Deliverable** | Separate provider config variants with boosting enabled/disabled; runs comparing boosted vs unboosted; delta report on entity accuracy |
| **Dependencies** | P3-T1, P3-T2, P0-T6 |
| **Inputs** | Logic-register §9; PRD FR-P2; OD-8 resolved |
| **Outputs** | Experiment report; entity accuracy delta by provider |
| **Acceptance** | PRD AC-FULL-2; boosted and unboosted configs have distinct `config_hash`; delta report shows per-entity-type improvement |
| **Logic** | **YES — OD-8:** Decide experiment design: (a) paired (same call, same provider, boosted vs. not — cleaner causal inference) vs. (b) separate corpus subsets. Paired is default. Also: which vocabulary list — curated per vertical or generic? |

---

### P3-T7 · Full Benchmark Run

| Field | Value |
|-------|-------|
| **ID** | P3-T7 |
| **Phase** | 3 — Full Benchmark |
| **Title** | Execute full benchmark run (50–100 calls × 6 providers) |
| **Deliverable** | Completed run record; all Score rows; staleness check passes |
| **Dependencies** | P3-T1, P3-T2, P3-T3, P3-T4, P2-T4, P2-T3 |
| **Inputs** | Full corpus; all provider configs |
| **Outputs** | Run manifest; complete Score table; rankings |
| **Acceptance** | PRD AC-FULL-2; run completes or reaches `complete` after resume; cost within 10% of pre-flight estimate |
| **Logic** | NO |

---

## Phase 4 — Decision & Handoff

---

### P4-T1 · Decision Report Export

| Field | Value |
|-------|-------|
| **ID** | P4-T1 |
| **Phase** | 4 — Decision |
| **Title** | Export decision-ready report |
| **Deliverable** | JSON + human-readable Markdown export: per-vertical rankings, score breakdowns, CI bounds, recommendation text, cost projection at volume |
| **Dependencies** | P3-T5, P3-T6, P3-T7 |
| **Inputs** | PRD AC-FULL-6; logic-register §12 |
| **Outputs** | `benchmark-report-v{N}.json`; `benchmark-report-v{N}.md` |
| **Acceptance** | Report reviewed and signed off by Decision Maker; recommendation per vertical is actionable (names a provider + config) |
| **Logic** | **YES — OD-9:** Tie-breaking rule must be agreed before the report is written. See logic-register §12. |

---

### P4-T2 · Corpus Archive & Retention Activation

| Field | Value |
|-------|-------|
| **ID** | P4-T2 |
| **Phase** | 4 — Decision |
| **Title** | Archive corpus and activate retention schedule |
| **Deliverable** | Corpus snapshot archived; retention policy enforced (calls move to `archived` per schedule); deletion log active |
| **Dependencies** | P4-T1, P0-T5 |
| **Inputs** | `docs/data-governance.md` §5; OD-10 resolved |
| **Outputs** | Archived corpus record; retention schedule documented |
| **Acceptance** | PRD AC-FULL-7; archived calls cannot be used in new runs without explicit un-archive action |
| **Logic** | NO |

---

## Critical Path

```
P0-T1 → P0-T3 → P0-T5 → P1-T1 → P1-T8 → P1-T9
                        ↓
                     P1-T3 → P1-T14 → P1-T15 → P1-T16
                        ↓
                     P1-T2 → P1-T10 → P1-T11 ↗
```

**Longest dependency chain (Phase 0→4):**  
`P0-T1 → P0-T5 → P1-T1 → P1-T3 → P1-T14 → P1-T15 → P2-T1 → P3-T1 → P3-T7 → P4-T1`

**Critical bottleneck:** P1-T1 (style guide / OD-2 resolution) blocks P1-T8 (normalization), which blocks P1-T9 (WER) and P1-T3 (corpus curation). Resolve OD-2 in Week 3 Day 1.

---

## Parallel Tracks (can run simultaneously)

| Track A | Track B | Track C |
|---------|---------|---------|
| P0-T1, P0-T2 | P0-T3, P0-T4 | P0-T6 |
| P1-T4, P1-T5 | P1-T6, P1-T7 | P1-T1, P1-T2 |
| P1-T9, P1-T10 | P1-T12, P1-T13 | P1-T3 (human work) |
| P3-T2 | P3-T3 | P3-T5 |
