# STT Benchmark — Reproducibility Specification

> **Historical document (banner added 2026-08-30, T-120).** Written while the
> tool was being planned; file paths, task statuses and module names in here
> describe that plan, not today's tree. `scripts/check-doc-paths.sh` does not
> check this file. Current state: `.claude/CLAUDE.md` → `docs/PRD-v4-*.md` →
> `docs/v4-task-register.md`.

**Goal:** Given a run ID and the scoring codebase at a pinned commit, any engineer can reproduce bit-identical scores without re-calling any provider.

**Guarantee scope:** Score reproducibility is guaranteed. Raw provider output reproducibility is not guaranteed (providers may change their models) — which is why raw outputs are stored immutably at run time.

---

## 1. Corpus Manifest

**What it is:** A point-in-time snapshot of the corpus calls included in a run, with content hashes that detect any subsequent modification.

**When generated:** At the moment `POST /benchmark/runs` is called, before any provider submissions begin.

**Schema:**
```json
{
  "manifest_version": "1",
  "created_at": "ISO-8601 timestamp",
  "created_by": "user UUID",
  "run_id": "UUID",
  "calls": [
    {
      "call_id": "UUID",
      "label": "non-PII label",
      "vertical": "rush | property_management | trucking",
      "duration_seconds": 142.3,
      "audio_object_path": "path/in/object/store",
      "audio_sha256": "sha256:...",
      "gold_transcript_sha256": "sha256:...",
      "entity_annotations_sha256": "sha256:...",
      "entity_annotations_schema_version": "1.0",
      "hard_cases": ["vin_accuracy", "cross_talk"],
      "status_at_run_time": "ready_to_run"
    }
  ]
}
```

**Hash computation:**
- `audio_sha256`: SHA-256 of the raw audio bytes in the object store at run creation time
- `gold_transcript_sha256`: SHA-256 of the UTF-8 encoded gold transcript string
- `entity_annotations_sha256`: SHA-256 of the canonical JSON serialization of entity_notes (keys sorted, no whitespace)

**Staleness detection:** At any time, current hashes can be compared against the manifest. A mismatch means results from this run are based on data that no longer matches the corpus — the UI must surface this as a warning (see execution-plan P2-T5).

---

## 2. Provider Config Snapshot

**What it is:** A point-in-time snapshot of every provider config used in a run.

**When generated:** At the same moment as the corpus manifest.

**Schema:**
```json
{
  "providers": [
    {
      "provider_id": "UUID",
      "name": "Deepgram",
      "model": "nova-3",
      "config_hash": "sha256:...",
      "config_snapshot": {
        "model": "nova-3",
        "supports_streaming": true,
        "supports_diarization": true,
        "keyword_boosting": true,
        "boosting_vocabulary": ["RO12345", "VIN prefix list..."],
        "boosting_vocabulary_hash": "sha256:...",
        "diarization_enabled_for_run": true,
        "streaming_mode": "batch",
        "api_endpoint": "https://api.deepgram.com/v1/listen",
        "request_parameters": { "punctuate": true, "model": "nova-3" }
      },
      "rate_verified": false,
      "cost_per_minute_at_run_time": 0.0,
      "cost_per_minute_source": "operator-entered, unverified"
    }
  ]
}
```

**Config hash:** SHA-256 of the canonical JSON serialization of `config_snapshot` (keys sorted, no whitespace). The hash changes if any config field changes, ensuring that a config change is always detectable.

**API key handling:** The API key secret **name** (e.g., `DEEPGRAM_API_KEY`) is stored in the config snapshot. The actual key value is never stored in the manifest or DB.

---

## 3. Run Manifest

**What it is:** The top-level immutable record of everything needed to reproduce a run. Stored as `corpus_snapshot` and `provider_snapshot` JSONB on the `BenchmarkRun` row, and also exportable as a standalone JSON file.

**Schema:**
```json
{
  "run_manifest_version": "1",
  "run_id": "UUID",
  "created_at": "ISO-8601",
  "created_by": "user UUID",
  "scoring_version": "git-sha:abc1234 or semver:1.2.0",
  "harness_version": "git-sha:abc1234",
  "network_location": "documented location where harness ran",
  "corpus_manifest": { ... },
  "provider_manifest": { ... },
  "run_parameters": {
    "cost_threshold_usd": 50.0,
    "estimated_cost_usd": 12.40,
    "confirmed_at": "ISO-8601",
    "confirmed_by": "user UUID"
  }
}
```

**Immutability:** Once created, the run manifest is never modified. All fields are frozen. The `run_manifest_version` field allows format evolution without breaking older manifests.

---

## 4. Raw Output Storage

**What it is:** The verbatim provider API response for every provider × call cell in a run.

**Storage:** `provider_call_results.raw_output` (text field in DB) + `raw_output_hash` (SHA-256 of the raw output string).

**Retention:** Indefinite (soft-delete only, Data Governor override required — see data-governance.md §5).

**Format:** Provider responses are stored exactly as received from the API, including all provider-specific fields, not just the transcript. This ensures that if the scoring pipeline is extended later (e.g., to use word-level confidence scores that are already in the response), re-scoring is possible without re-calling providers.

**Integrity check:** `raw_output_hash` is computed at storage time. A re-score must verify the hash before using the raw output, to detect accidental corruption.

---

## 5. Normalized Output Storage

**What it is:** The normalized transcript produced from `raw_output` by the normalization pipeline, used as input to WER and entity scoring.

**Storage:** Stored in `scores.detail` JSONB alongside the metrics:
```json
{
  "normalized_hypothesis": "the normalized transcript string",
  "normalized_gold": "the normalized gold string",
  "normalization_version": "1.0",
  "entity_extractions": {
    "vin": ["1HGBH41JXMN109186"],
    "ro_number": ["RO12345"],
    "phone": ["+15550001234"]
  }
}
```

**Purpose:** Storing normalized output allows debugging (compare normalized strings side-by-side without re-running normalization) and verifying that normalization was applied correctly.

---

## 6. Scoring Version

**What it is:** A version identifier for the scoring codebase, stored in every `Score` record and in the run manifest.

**Format:** Git commit SHA of the scoring module files at the time of scoring, or a semver tag if releases are tagged.

**Policy:**
- If the scoring code changes in any way (normalization rules, WER formula, entity matching), the scoring version must be incremented
- Score records from different scoring versions are not aggregated together
- The scoring version is displayed in all reports so readers know which algorithm was applied
- When a new scoring version is deployed, existing runs can be re-scored using the new version (see execution-plan P2-T2) — the re-score produces new Score records, preserving the old ones

**Versioned components:**
- Normalization pipeline (`lib/scoring/normalize.ts`)
- WER computation (`lib/scoring/wer.ts`)
- Entity extraction patterns (`lib/scoring/entity-extract.ts` + per-vertical config files)
- Entity accuracy scorer (`lib/scoring/entity-score.ts`)
- Diarization scorer (`lib/scoring/diarization.ts`)
- Composite ranking weights (stored in config, but changes trigger a version bump)
- Significance calculator (`lib/scoring/significance.ts`)

---

## 7. Export Format

**Purpose:** Allow the benchmark corpus, run manifests, raw outputs, and scores to be exported in a self-contained format that can be analyzed offline or migrated to a different platform.

**Export trigger:** Data Governor or Benchmark Operator initiates an export via API or CLI.

**Export package structure:**
```
benchmark-export-{run_id}-{date}/
  manifest.json              # Run manifest (§3)
  corpus/
    corpus-manifest.json     # Corpus manifest (§1)
    calls/
      {call_id}.json         # Call metadata + gold transcript + entity annotations
  providers/
    provider-manifest.json   # Provider config snapshot (§2)
    {provider_id}.json       # Full provider config snapshot
  raw_outputs/
    {provider_id}/
      {call_id}.json         # Raw provider API response
      {call_id}.hash         # SHA-256 of raw output
  scores/
    {provider_id}/
      {call_id}.json         # Score record with detail
  rankings.json              # Rankings output for this run
  audit_log_excerpt.json     # Audit log entries related to this run
```

**Format:** All files are UTF-8 JSON with 2-space indentation. No binary formats except audio (audio is not exported — only the path reference is exported).

**Audio note:** Audio files are not included in the export for size and security reasons. The export includes `audio_object_path` and `audio_sha256` sufficient to locate and verify the audio in the object store.

---

## 8. Rerun Procedure

**When to rerun:** (a) A score is disputed, (b) a new scoring version is deployed and historical runs need updating, (c) a provider integration bug is fixed and affected cells need re-scoring.

### 8.1 Re-score (from stored raw outputs — no provider calls)

1. Identify the run ID and the target scoring version
2. Verify integrity: for each `ProviderCallResult`, recompute SHA-256 of `raw_output` and compare to `raw_output_hash` — abort if any mismatch
3. Run the scoring pipeline on stored `raw_output` using the target scoring version
4. Write new `Score` records with the new `scoring_version`; do not overwrite or delete existing Score records
5. The `BenchmarkRun` record is not modified — it retains its original scoring version
6. Rankings can now be queried with a `scoring_version` filter to compare old vs. new scores

### 8.2 Full Re-run (re-submit to providers)

This is rarely needed and expensive. Justified only when:
- A provider integration bug caused incorrect audio to be submitted
- A provider has updated their model and a head-to-head comparison is desired (this creates a new run, not a re-run)

Procedure:
1. Create a new `BenchmarkRun` with the same call IDs and provider IDs
2. New manifest is generated (new timestamp; audio hashes are verified to match the original if corpus is unchanged)
3. Run executes from scratch; original run and its data are preserved
4. Compare new run to old run using the staleness/hash comparison tooling

### 8.3 Partial Re-run (resume from failure)

See execution-plan P2-T3. Only cells with missing or failed results are re-submitted. Successfully completed cells are not re-submitted.

---

## 9. Reproducibility Self-Test

Before the full benchmark run (Phase 3), the following self-test must be performed and pass:

1. Take the MVP run (Phase 1 results)
2. Re-score using the same scoring version — all scores must be bit-identical (float equality)
3. Re-score using a modified normalization rule — confirm that scores differ and the diff is explainable
4. Verify that the run manifest matches all current corpus hashes (no staleness)
5. Verify that the exported package can be loaded and scores can be independently computed from it

This self-test is acceptance criterion AC-FULL-7 (PRD §9).

---

*This document defines the reproducibility contract. Any change to the scoring pipeline that cannot satisfy the §8.1 re-score procedure (bit-identical output given same inputs and same scoring version) is a breaking change and requires a scoring version bump and full disclosure in run reports.*
