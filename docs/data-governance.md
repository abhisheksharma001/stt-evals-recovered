# STT Benchmark Platform — Data Governance

**Scope:** All audio recordings, transcripts, entity annotations, and provider outputs handled by this benchmark platform.  
**Owner:** Data Governor role (see PRD §4).  
**Review cycle:** This document must be reviewed when: (a) a new vertical is added, (b) a new vendor is added, (c) retention periods are changed, or (d) an incident occurs.

---

## 1. Principles

1. **Minimum necessary data:** Only audio that is required for the benchmark is registered in the corpus. No speculative collection.
2. **De-identification before storage:** Audio is de-identified before it is registered. The de-identification step is a hard gate, not a best-effort.
3. **Two-person approval:** No call enters the benchmark without two distinct approvers (creator and de-id attester are different people).
4. **Access control by role:** Audio is not accessible through the web application. It is accessed only by authorized roles via pre-signed URLs, with every access logged.
5. **Vendor data-handling verification:** No audio is sent to a vendor until that vendor's data-handling position has been verified and documented.
6. **Retention by design:** A defined retention schedule exists before any audio is collected. Data that has passed its retention date is deleted on schedule.
7. **Auditability:** Every state change on every corpus record is logged with actor, timestamp, before state, and after state in an append-only audit log.

---

## 2. De-identification Checklist

Every call must pass all checklist items before a de-id attestor can approve it. The attestor personally verifies each item by listening to or reviewing the recording and transcript.

### 2.1 Audio-Level Checks
- [ ] **DI-A1:** Full name of customer or caller is not audible (or has been replaced with a synthetic name or bleep)
- [ ] **DI-A2:** No social security number, date of birth, or government-issued ID number is spoken
- [ ] **DI-A3:** No credit card or bank account number is spoken
- [ ] **DI-A4:** Phone number, if spoken, belongs to a business (not a personal number) — OR has been replaced with a synthetic number in the gold transcript
- [ ] **DI-A5:** Address, if spoken, is a service address (property or vehicle location), not a home address of an individual — OR has been replaced
- [ ] **DI-A6:** No medical or health information about an individual is spoken
- [ ] **DI-A7:** Employee names, if spoken, are internal operations staff (not customer PII) — confirm with the vertical's data owner whether employee names require pseudonymization

### 2.2 Transcript-Level Checks
- [ ] **DI-T1:** Gold transcript does not contain any PII that was not present in the audio (no curator-added PII)
- [ ] **DI-T2:** Entity annotations use normalized/pseudonymized values for any PII entity types (e.g., phone numbers are in the gold as placeholders like `+15550001234`, not real customer numbers)
- [ ] **DI-T3:** `label` field on the corpus call does not contain PII (use a non-identifying call ID or timestamp)

### 2.3 Metadata Checks
- [ ] **DI-M1:** `audioObjectPath` does not encode any PII (use a UUID-based path, not caller ID or name)
- [ ] **DI-M2:** `entityNotes` does not contain real PII values in free-text fields

### 2.4 Attestation Record
The attestor records in the audit log:
- Date of review
- Checklist items verified
- Any items where de-identification action was taken (e.g., bleep applied, transcript value replaced)
- Confirmation that a second person (the attestor) is different from the uploader

---

## 3. Access Control

### 3.1 Roles and Permissions

| Resource | Corpus Curator | Benchmark Operator | Decision Maker | Compliance Officer | Data Governor |
|----------|---------------|-------------------|----------------|-------------------|---------------|
| Register call (`POST /calls`) | ✓ | — | — | — | ✓ |
| Approve gold / advance status (`PATCH /calls`) | ✓ | — | — | — | ✓ |
| Attest de-identification | ✓ (if not uploader) | — | — | ✓ | ✓ |
| Read call metadata | ✓ | ✓ | ✓ (summary) | ✓ | ✓ |
| Generate audio pre-signed URL | ✓ | ✓ (read only) | — | — | ✓ |
| Queue/manage runs | — | ✓ | — | — | ✓ |
| Read scores and rankings | ✓ | ✓ | ✓ | ✓ | ✓ |
| Read audit log | — | — | — | ✓ | ✓ |
| Archive / delete records | — | — | — | — | ✓ |
| Manage provider configs | — | ✓ | — | — | ✓ |

### 3.2 Audio Access Logging
Every pre-signed URL generation for an audio file MUST be logged with:
- `actor_id` (who generated the URL)
- `call_id` (which recording)
- `generated_at` timestamp
- `url_expires_at` timestamp (URLs must have a maximum TTL of 1 hour)
- `purpose` (free text, e.g., "de-id review", "benchmark run submission")

Pre-signed URLs are generated only for:
1. Corpus Curator performing de-id review
2. Benchmark Operator triggering a provider submission (URL is passed to the harness, not to a human)
3. Data Governor performing an access review

### 3.3 Provider Submission
When audio is submitted to a provider API:
- The harness downloads the audio using a pre-signed URL and submits it via HTTPS to the provider
- The audio is not cached on any intermediary server
- The submission is logged in `provider_call_results` with `submitted_at` and `http_status`
- The raw provider response is stored in `provider_call_results.raw_output`

---

## 4. Vendor Data-Handling Verification

Before any audio is sent to a provider, the following must be confirmed and documented.

### 4.1 Vendor Verification Checklist

For each provider (Deepgram, AssemblyAI, OpenAI, ElevenLabs, Gladia, Speechmatics):

- [ ] **V1:** Does the provider's standard terms of service permit sending third-party audio (operational call recordings)?
- [ ] **V2:** Does the provider claim to use customer data for model training by default?
- [ ] **V3:** Is there an opt-out from training data use, and has it been activated on our account?
- [ ] **V4:** Is there a Data Processing Agreement (DPA) available? Has it been reviewed and signed?
- [ ] **V5:** Does the provider store submitted audio after transcription? For how long?
- [ ] **V6:** Is there a zero-retention or enterprise tier that ensures audio is not stored?
- [ ] **V7:** Does the provider have SOC 2 Type II or equivalent certification?
- [ ] **V8:** What is the provider's breach notification policy?

**Gate:** Items V3 and V4 are **blockers**. If a provider does not offer a training opt-out and a DPA cannot be signed, audio MUST NOT be sent to that provider. Document the result for each provider before integration begins.

### 4.2 Vendor Verification Record Template

```
Provider: [name]
Model: [model string]
Date verified: [YYYY-MM-DD]
Verified by: [name, role]

V1 — Third-party audio permitted: [YES / NO / CONDITIONAL: ...]
V2 — Training use by default: [YES / NO / UNKNOWN]
V3 — Training opt-out available and activated: [YES / NO / N/A if V2=NO]
    Opt-out mechanism: [account setting / API flag / contractual]
    Confirmation: [screenshot, email, contract reference]
V4 — DPA signed: [YES / NO / IN PROGRESS]
    DPA reference: [document ID or link]
V5 — Audio retention post-transcription: [duration or NONE]
V6 — Zero-retention tier available: [YES / NO]
V7 — SOC 2 or equivalent: [YES / NO / certification reference]
V8 — Breach notification: [policy reference or URL]

Status: [CLEARED TO USE / BLOCKED / PENDING]
Blocker reason (if blocked): [...]
```

This record must be stored in the project's secure documentation and referenced from the provider's `config_note` field.

---

## 5. Retention Schedule

| Data Category | Retention Period | Deletion Trigger | Notes |
|---------------|-----------------|------------------|-------|
| Original audio (object store) | [TBD — OD-10] | Call archived + retention period elapsed | Data Governor executes deletion; logged |
| Gold transcripts (DB) | Duration of platform + 90 days | Platform decommission | Cannot be deleted independently while calls are in `ready_to_run` |
| Entity annotations (DB) | Same as gold transcripts | Same | |
| Provider raw outputs | Indefinite (soft-delete only) | Data Governor override only | Required for reproducibility |
| Provider call result metadata | Indefinite | Data Governor override only | Required for audit |
| Score records | Indefinite | Data Governor override only | Required for reproducibility |
| Audit log records | 7 years | Compliance Officer approval | Immutable; not subject to normal deletion |
| Pre-signed URL access log | 2 years | Automatic | Rotated by access logging infrastructure |

**OD-10 gate:** The retention period for original audio is an open decision (PRD §12 OD-10). Until it is resolved, all audio is retained indefinitely. The Compliance Officer must resolve OD-10 before Phase 4.

### 5.1 Deletion Process
1. Data Governor identifies records past retention date
2. Data Governor creates a deletion request record in the audit log
3. Compliance Officer approves the deletion request
4. Deletion is executed; the `deleted_at` timestamp and `deleted_by` are recorded in the audit log
5. Deleted audio paths are scrubbed from the object store; DB records are soft-deleted (status → `archived`, `audio_object_path` → null)

---

## 6. Dataset Versioning

### 6.1 Corpus Manifest
A corpus manifest is generated at the start of every benchmark run (see `docs/reproducibility.md`). It contains:
- List of call IDs included in the run
- SHA-256 hash of each call's gold transcript at time of run creation
- SHA-256 hash of each call's entity annotations at time of run creation

Manifests are immutable after creation. They are stored as `corpus_snapshot` JSONB in the `BenchmarkRun` record.

### 6.2 Gold Transcript Versioning
Gold transcripts are stored as text in the DB. A change history is maintained via the audit log (`before_state` / `after_state` on PATCH operations). The scoring pipeline always uses the gold transcript as it existed at run creation time (from the manifest hash), not the current value.

### 6.3 Entity Annotation Versioning
Entity annotations follow the same versioning mechanism as gold transcripts. The annotation schema version is recorded alongside the annotation JSON.

### 6.4 Named Corpus Snapshots
At key milestones (MVP completion, full benchmark), the Data Governor SHALL export a named corpus snapshot:
```
corpus-snapshot-{version}-{YYYY-MM-DD}.json
{
  "version": "1.0",
  "created_at": "...",
  "created_by": "...",
  "calls": [
    {
      "id": "...",
      "label": "...",
      "vertical": "...",
      "duration_seconds": ...,
      "gold_hash": "sha256:...",
      "entity_annotations_hash": "sha256:...",
      "hard_cases": [...]
    }
  ]
}
```

---

## 7. Leakage Prevention

**Definition:** Leakage occurs when the benchmark corpus (or knowledge of its contents) influences provider behavior in a way that is not representative of production performance.

### 7.1 Audio Leakage
- Audio files are never shared publicly or with vendors as part of integration/sales discussions
- Pre-signed URLs expire within 1 hour
- Audio is submitted to providers only during a benchmark run, not for "testing" or "demo" purposes

### 7.2 Transcript Leakage
- Gold transcripts are not shared with vendors
- Corpus curators do not share call content in vendor support tickets or community forums

### 7.3 Training Data Opt-Out (Vendor Side)
- Training opt-out (V3 in vendor checklist) prevents the provider from using submitted audio to improve their models — which would invalidate future benchmark comparisons
- Verification of opt-out status is re-confirmed before each new full benchmark run (providers may change their policies)

### 7.4 Benchmark Design Leakage
- The specific hard-case tags used to select corpus calls are not shared with vendors
- Keyword-boosting vocabulary lists are constructed from domain SME knowledge, not from provider recommendations — to avoid a vendor advising on the test they will be evaluated on

---

## 8. Incident Response

If a data incident occurs (unauthorized access, accidental audio exposure, vendor breach notification):

1. **Immediate:** Data Governor is notified within 1 hour
2. **Within 24 hours:** Compliance Officer is notified; affected calls are moved to `archived` status; pre-signed URL generation is disabled for affected calls
3. **Assessment:** Determine scope — which calls, which data categories, which vendor(s)
4. **Notification:** If PII was exposed despite de-identification (e.g., de-id was incomplete), follow applicable breach notification regulations
5. **Remediation:** Re-de-identify or remove affected calls; document root cause; update de-identification checklist if a gap was found
6. **Post-incident review:** Update this governance document with any changes to prevent recurrence

---

*This document is the authoritative governance reference. Any deviation from these policies requires written approval from the Compliance Officer and Data Governor, recorded in the audit log.*
