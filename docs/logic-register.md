# STT Benchmark — Logic Register

> **Historical document (banner added 2026-08-30, T-120).** Written while the
> tool was being planned; file paths, task statuses and module names in here
> describe that plan, not today's tree. `scripts/check-doc-paths.sh` does not
> check this file. Current state: `.claude/CLAUDE.md` → `docs/PRD-v4-*.md` →
> `docs/v4-task-register.md`.

This document catalogs every algorithmic decision in the scoring and evaluation pipeline. Each entry states the **proposed default**, **alternatives**, **tradeoffs**, and the **exact build-time decision gate** that must be resolved before the corresponding task is coded.

---

## §1 — Transcript Normalization (pre-WER)

**Purpose:** Make gold and hypothesis transcripts comparable by removing differences that are not meaningful errors (formatting, punctuation, capitalization).

**Proposed Default:**
1. Lowercase all tokens
2. Strip all punctuation except apostrophes in contractions
3. Expand common abbreviations: `dr` → `doctor`, `st` → `street` (domain-specific list, per vertical)
4. Normalize numbers: convert digit strings to word form for WER; preserve digit form for entity accuracy scoring (separate pass)
5. Remove filler words (`uh`, `um`, `hmm`) — **decision gate on this item**
6. Collapse multiple spaces to single space; strip leading/trailing whitespace
7. For gold transcripts: apply normalization identically to how it was applied at annotation time

**Alternatives:**
- **No filler-word removal:** Count filler-word insertions as STT errors (penalizes verbose providers fairly)
- **Number normalization to digits:** Easier for entity matching; harder for WER since providers vary in digit vs. word output
- **Minimal normalization (lowercase + punctuation only):** Faster to implement; less fair to providers with different capitalization styles
- **Heavy normalization (all numerals expanded, abbreviations expanded, filler removed):** Most lenient; risks masking real errors

**Tradeoffs:**
- Removing filler words benefits providers that faithfully transcribe filler (arguably correct behavior) and harms no one — but it means the gold transcript must also have fillers annotated if the curator included them
- Number normalization direction (word vs. digit) must match the gold annotation convention chosen in P1-T1 — do not choose independently

**Build-time decision gate (P1-T1 / P1-T8):**
> Before writing a single line of normalization code, resolve: (a) Are filler words stripped or kept? (b) Are numbers in gold written as words or digits? (c) Are abbreviations expanded, and if so, which list governs per vertical? Document the answers in `docs/gold-style-guide.md`. The normalization code must implement exactly that spec, no more.

---

## §2 — Word Error Rate (WER) Computation

**Purpose:** Measure how many word-level substitutions, insertions, and deletions a provider makes relative to the gold reference.

**Proposed Default:**
```
WER = (S + I + D) / N_ref
```
where `S` = substitutions, `I` = insertions, `D` = deletions, `N_ref` = reference word count (after normalization).

Algorithm: Dynamic programming (Wagner-Fischer) on word token sequences.

**Alternatives:**
- **MER (Match Error Rate):** `(S + I + D) / max(N_ref, N_hyp)` — penalizes both over- and under-generation symmetrically; WER can exceed 1.0, MER cannot
- **WIL (Word Information Lost):** `1 - (N_ref - D) / N_ref × (N_hyp - I) / N_hyp` — accounts for informativeness
- **CharWER:** Character-level edit distance — useful for catching near-miss alphanumeric errors but less interpretable

**Tradeoffs:**
- WER > 1.0 is possible with many insertions — acceptable, must be reported as-is, not capped
- WER with reference denominator is the industry standard and allows cross-study comparison
- MER is fairer when providers over-generate (verbose transcription)
- For our verticals, WER is the right primary metric; CharWER can be a secondary diagnostic

**Build-time decision gate (P1-T9):**
> Confirm denominator = reference word count. If a provider returns zero words (empty transcript), WER = 1.0 (not undefined). If reference is zero words (empty gold), the result is undefined — log a warning and exclude that call from WER aggregation. Document these edge cases in unit tests.

---

## §3 — Entity Extraction from Hypothesis Transcripts

**Purpose:** Extract entity candidates from the provider's raw transcript text to compare against gold entity annotations.

**Proposed Default (Regex):**

| Entity Type | Pattern Approach |
|-------------|-----------------|
| VIN | 17-char alphanumeric `[A-HJ-NPR-Z0-9]{17}` (excludes I, O, Q); case-insensitive |
| RO / Work-Order Number | Vertical-specific pattern; e.g., Rush: 5–8 digits optionally prefixed with `RO` or `WO` |
| Unit / Property ID | Property mgmt: alphanumeric 2–6 chars with optional hyphen; must be configured per property |
| Phone Number | 10-digit US number; normalize to E.164 before matching |
| Person Name | **Cannot be regex** — use NLP NER or gold-span alignment (see alternatives) |
| Address | Heuristic: number + street name + street type; or gold-span alignment |

**Alternatives:**
- **LLM-assisted extraction:** Send hypothesis transcript to a small LLM with an extraction prompt; more flexible but introduces a non-deterministic variable, adds cost, and makes the scoring pipeline dependent on another external API
- **Gold-span alignment:** Project gold entity character offsets onto the hypothesis using word-level alignment (Needleman-Wunsch on word sequences); deterministic and requires no pattern design, but relies on word alignment quality
- **spaCy NER:** Open-source, fast, deterministic; handles names and addresses reasonably; requires model download and version pinning

**Tradeoffs:**
- Regex is deterministic and auditable but requires per-vertical pattern design and will miss spoken-form VINs (e.g., "one hotel kilo five...") — spoken VINs may need a phonetic normalization pre-pass
- LLM extraction creates a dependency that could drift; if the LLM's behavior changes, historical scores cannot be reproduced from raw outputs
- spaCy NER is a good middle ground for name/address; version-pin the model in `reproducibility.md`

**Build-time decision gate (P1-T10):**
> (a) Confirm regex patterns per entity type per vertical before writing extraction code — patterns must be reviewed by a domain SME who handles Rush, property mgmt, and trucking calls. (b) Decide name/address extraction method: spaCy NER (default) vs. gold-span alignment. (c) Decide how to handle spoken-form VINs — are they in scope for MVP?

---

## §4 — Number and Alphanumeric Accuracy

**Purpose:** Separate metric for numeric and alphanumeric entity accuracy, since these are the highest-value and most error-prone category.

**Proposed Default:**
- After entity extraction (§3), compute a separate accuracy score only on entities with types: `vin`, `ro_number`, `unit_id`, `phone`
- Matching: exact match after normalization (remove hyphens, spaces; uppercase; E.164 for phones)
- Report: `alphanumeric_accuracy = correct_matches / total_gold_entities_of_these_types`

**Alternatives:**
- **Edit distance tolerance:** Accept a match if Levenshtein distance ≤ 1 — catches single OCR/homophones (zero vs O) but risks masking real errors
- **Phonetic normalization pre-pass:** Convert digit-word sequences ("one eight hundred five five five...") to digits before matching — needed for spoken phone numbers
- **Per-entity-type accuracy reported separately:** More diagnostic but more complex to surface in rankings

**Tradeoffs:**
- Edit distance tolerance inflates accuracy scores — do not use by default without explicit approval
- Phonetic normalization for phone numbers is almost certainly needed in practice (spoken phone numbers are rarely all-digit in the transcript)

**Build-time decision gate (P1-T11):**
> (a) Is edit distance tolerance allowed, and at what threshold? Default: no tolerance (exact match). Any change requires explicit sign-off. (b) Implement phonetic digit normalization ("one" → "1", "zero" → "0", etc.) as a pre-processing step before entity comparison. (c) Document which entity types count toward `alphanumericAccuracy` vs. `entityAccuracy`.

---

## §5 — Latency Instrumentation

**Purpose:** Measure time-to-first-partial (TTFP) and time-to-final (TTF) per provider per call.

**Proposed Default:**
- **Clock source:** `Date.now()` on the harness server (not provider-reported timestamps)
- **`submitted_at`:** Immediately before the HTTP request is sent
- **`first_partial_at`:** Timestamp of first partial result received over the streaming connection (null for batch-only providers)
- **`final_at`:** Timestamp when the HTTP response is fully closed / final JSON is received
- **TTFP** = `first_partial_at - submitted_at` (null if provider is batch-only)
- **TTF** = `final_at - submitted_at`
- **Reporting:** p50 and p95 across all calls in a run, not just mean

**Missing-capability policy:** If a provider does not support streaming, `first_partial_at` and `latencyFirstPartialMs` are stored as `null`, not 0. The provider is not penalized in ranking for a metric it cannot produce — it is simply reported as N/A (see §8 Missing-Capability Policy).

**Alternatives:**
- **Provider-reported timestamps:** More precise for streaming but not comparable across providers; subject to clock skew
- **Audio duration-normalized latency:** `TTF / audio_duration` — normalizes for call length; useful secondary metric

**Tradeoffs:**
- Network round-trip from the harness server is a confound. Mitigate by running all benchmarks from the same network location and same time window. Document this in the run manifest.
- Single-measurement per call is noisy; p50/p95 across the full corpus is more reliable than per-call comparisons

**Build-time decision gate (P1-T12):**
> Confirm: (a) all provider adapters use `Date.now()` at the same code location before/after HTTP calls; (b) no provider adapter uses provider-reported timestamps; (c) streaming vs. batch mode is documented per provider in their config note; (d) latency measurement is always from the harness perspective — document as "harness-measured latency, not end-to-end customer latency."

---

## §6 — Diarization Scoring

**Purpose:** Measure how accurately providers identify and separate speakers in multi-speaker calls.

**Proposed Default: DER (Diarization Error Rate)**

```
DER = (missed_speech + false_alarm + speaker_confusion) / total_reference_speech_time
```

- **Collar tolerance:** 0.25 seconds (standard NIST collar)
- **Gold format:** RTTM (Rich Transcription Time Mark) — one line per segment: `SPEAKER file 1 start dur <NA> <NA> speaker_id <NA> <NA>`
- **Speaker mapping:** Optimal Hungarian-algorithm mapping between gold and hypothesis speaker labels before scoring

**Alternatives:**
- **JER (Jaccard Error Rate):** Per-speaker Jaccard similarity, averaged — more symmetric, not dominated by the majority speaker; better when speaker count is large
- **Custom JSON gold format:** Easier to hand-annotate but requires a converter to standard tooling
- **CPWER (Concatenated minimum-Permutation WER):** Combines diarization and WER — more holistic but harder to interpret independently

**Tradeoffs:**
- DER is the established standard (NIST, CHiME challenges) — use it for cross-benchmark comparability
- JER is better when speakers have very unequal speaking time (common in customer-service calls where one speaker dominates) — consider reporting both
- Collar of 0.25s is standard; reduce to 0.0s for a stricter evaluation

**Build-time decision gate (P3-T3):**
> (a) Confirm gold annotation format = RTTM. (b) Confirm DER as primary metric with JER as secondary. (c) Confirm collar tolerance = 0.25s. (d) For providers that return no speaker labels, `diarization_score` is null — do not impute a value. (e) Verify tool: use `pyannote.metrics` or equivalent pinned version.

---

## §7 — Composite Ranking Score

**Purpose:** Produce a single ranking per provider per vertical that integrates all metrics for decision-making.

**Proposed Default Weights (PENDING OD-1 approval):**

| Metric | Proposed Weight | Notes |
|--------|----------------|-------|
| WER | 35% | Primary quality signal |
| Entity Accuracy | 35% | Most business-critical for downstream systems |
| Latency (TTF) | 10% | Normalized: lower is better |
| Cost/Minute | 10% | Normalized: lower is better |
| Diarization | 10% | Null-handled: excluded if not supported |

**Normalization within each metric:**
- WER and latency: `1 - (value / max_value_in_cohort)` — inverted so higher is better
- Entity accuracy and diarization: already in [0, 1] range; higher is better
- Cost: `1 - (cost / max_cost_in_cohort)`

**Null-handling for missing capabilities:**
- If a provider has `diarization_score = null`, its composite weight is redistributed proportionally among available metrics — it is not scored as 0 on diarization

**Alternatives:**
- **Equal weights (1/N per metric):** Simpler; no judgment call; but treats WER and cost equally, which likely isn't the intent
- **No composite score:** Report raw metrics only, let Decision Maker apply judgment — avoids false precision
- **Separate rankings per use case:** e.g., for latency-critical use cases, weight latency 40% — support multiple weight presets

**Build-time decision gate (P3-T4):**
> OD-1 must be resolved. Weight vector must be approved by Decision Maker in writing before composite scores are computed. Store the weight vector in the run manifest so rankings are reproducible. Changing weights creates a new scoring version, not a re-run.

---

## §8 — Missing-Capability Policy

**Purpose:** Define how to handle providers that lack a capability (e.g., no streaming, no diarization, no keyword boosting).

**Policy:**
1. **Do not impute a score of 0 for a missing capability.** A provider that does not support diarization is not worse at diarization than one that produces poor diarization output — they are simply incomparable.
2. **Store as `null`**, not 0, in Score records.
3. **Exclude from aggregate calculations** that average across providers for that metric.
4. **Surface clearly in UI and report:** "Provider X does not support diarization. Diarization score: N/A."
5. **Composite score redistribution:** Redistribute the missing-capability weight proportionally among remaining metrics for that provider only.
6. **Do not change rankings based on missing-capability redistribution alone** — a provider with 4 metrics vs. 5 metrics is compared fairly if the composite is redistributed.

**Alternatives:**
- **Score as 0:** Simple but unfair — punishes providers for not attempting rather than for attempting and failing
- **Exclude from vertical ranking entirely:** Too aggressive — a provider may be excellent on all other metrics
- **Report two ranking tables:** With-diarization and without-diarization — avoids apples-to-oranges comparison

**Build-time decision gate (P1-T4 through P1-T7, P3-T3):**
> For each provider, document in their config note: which capabilities are confirmed supported (with API doc reference), which are confirmed unsupported, and which are unknown. "Unknown" is treated as unsupported until confirmed. Verify before running.

---

## §9 — Custom Vocabulary / Keyword-Boosting Experiment Design

**Purpose:** Test whether provider-specific keyword boosting lists improve entity accuracy for domain terms.

**Proposed Default (Paired Design):**
- For each provider that supports keyword boosting, create two config variants: `boosted` and `baseline`
- Run the same corpus calls through both variants in the same benchmark run
- Compute entity accuracy delta: `delta = entity_accuracy_boosted - entity_accuracy_baseline`
- Report per entity type and per vertical

**Vocabulary list construction:**
- Curate per vertical: Rush (RO numbers, vehicle makes/models), property management (unit ID formats, property names), trucking (VIN prefixes, carrier names)
- List is versioned in the repo alongside provider config
- List is hashed and included in the provider config hash

**Alternatives:**
- **Separate corpus subsets:** Boosted tested on subset A, baseline on subset B — weaker causal inference due to corpus confound
- **No boosting experiment:** Evaluate providers with their defaults only — simpler but misses an important optimization lever

**Build-time decision gate (P3-T6):**
> (a) Confirm paired design. (b) Confirm vocabulary list per vertical (requires SME review). (c) For providers that do not support keyword boosting, document as N/A — do not attempt a baseline-only "experiment." (d) Confirm boosting parameter name/syntax per provider from current API docs before building.

---

## §10 — Cost Model

**Purpose:** Estimate and record per-minute cost for each provider per run.

**Proposed Default:**
```
estimated_cost_usd = cost_per_minute_config × (duration_seconds / 60)
```

- `cost_per_minute_config` comes from the Provider record, entered by the operator
- A `rate_verified` boolean on Provider indicates whether the rate has been confirmed against an actual invoice
- If `rate_verified = false`, all cost outputs are labeled "estimated (unverified rate)"
- Cost projection at volume: `projected_monthly_cost = cost_per_minute_config × avg_monthly_minutes`

**IMPORTANT — Do not treat any published prices as fact:**
All provider pricing in this system is operator-entered. Published pricing pages are frequently updated, have tier structures, volume discounts, and enterprise agreements that differ from list price. Every cost figure in reports must be footnoted: *"Rate entered by operator on [date]. Verify against current provider pricing page and any applicable contract before using for financial decisions."*

**Alternatives:**
- **Actual cost from provider invoice API:** Some providers expose spend APIs — could be used to verify estimates post-run
- **No cost metric:** Simplify scope; let procurement handle cost separately — loses important decision context

**Build-time decision gate (P1-T13):**
> (a) Add `rate_verified` boolean to Provider schema. (b) All cost outputs must display "unverified" label until `rate_verified = true`. (c) Never hardcode any provider's cost per minute in application code — always read from provider config at run time. (d) Implement cost threshold pre-flight check per NFR-8.

---

## §11 — Confidence Intervals and Statistical Significance

**Purpose:** Prevent rankings from overstating precision when the corpus is small or provider differences are within noise.

**Proposed Default (Bootstrap Percentile CI):**
- Method: Non-parametric bootstrap with B = 1,000 iterations
- Statistic: WER mean and entity accuracy mean per provider per vertical
- CI: 95% (α = 0.05) using percentile method
- Tie threshold: If two providers' 95% CIs overlap, they are flagged as "effectively tied" — no ranking claim is made between them
- Report: All CI bounds stored in ranking output alongside point estimate

**Corpus size warning:** At N < 20 calls per vertical, CIs will be wide. The system SHALL surface a warning when corpus is below this threshold: "Rankings based on N={n} calls. CIs are wide; treat as directional only."

**Alternatives:**
- **Paired permutation test:** More statistically rigorous (directly tests the null that two providers have equal performance); computationally heavier; harder to explain to stakeholders
- **t-test:** Assumes normality — WER distributions are non-normal; not recommended
- **No significance testing:** Report point estimates only — risks overconfident recommendations

**Build-time decision gate (P3-T5):**
> (a) Confirm bootstrap as the method. (b) Confirm B = 1,000 (increase to 10,000 for final report). (c) Confirm α = 0.05 and tie definition (overlapping CIs). (d) Confirm the corpus-size warning threshold = 20 calls per vertical. (e) If the Decision Maker wants a harder statistical test, add paired permutation test as an optional secondary output.

---

## §12 — Tie-Breaking and Final Recommendation

**Purpose:** When two providers are statistically tied (overlapping CIs), define a deterministic tiebreaker.

**Proposed Default Tie-Breaking Order (OD-9):**
1. Higher entity accuracy (RO/VIN/unit — the most operationally critical)
2. Lower estimated cost per minute
3. Lower time-to-final (p95)
4. Provider with confirmed keyword-boosting support
5. If still tied: flag as "equivalent — choose based on existing vendor relationship or contract terms"

**Alternatives:**
- **Always prefer lower cost when tied on accuracy:** Maximizes cost efficiency; may feel unfair to accuracy-first stakeholders
- **No deterministic tiebreaker:** Flag as tied and require human decision — avoids false precision but delays decision

**Build-time decision gate (P4-T1):**
> OD-9 must be resolved by Decision Maker before the final report is written. The tie-breaking order must be documented in the report and traceable to a decision record. The system records the tiebreaker applied in the ranking output's `recommendation` field.

---

*All entries in this register are proposed defaults. No default is implemented until the corresponding build-time decision gate is explicitly resolved and recorded. Gate resolutions should be committed to `docs/` as decision records.*
