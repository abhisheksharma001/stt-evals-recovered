# Technical PRD v3 — Stabilise the base, then make the verdicts trustworthy

**Version:** 1.0
**Date:** 2026-08-27
**Author of findings:** end-to-end code + data review, this session
**Companion doc:** `docs/PRD-v3-uiux.md` (same review, UI/UX side)
**Implementer:** written for a Sonnet-class model. Every item states the exact
file, the current behaviour, the required behaviour, and how to prove it's done.
Do not infer scope beyond what an item says.
**Baseline confirmed at review time:** `pnpm run typecheck` clean across all 4
packages. HEAD = `fd53d0c` ("Retire gold transcript; hybrid gold-free flagging
replaces WER/entity-accuracy").

---

## 0. Read this first — the one-paragraph mental model

The tool is a pipeline: **import calls → de-id sign-off → run every provider
over the same audio → flag what looks wrong → rank providers → recommend one.**
Since `fd53d0c` there is no human "gold" transcript any more. That means the
whole verdict now rests on **providers disagreeing with each other**
(`lib/scoring/src/hybrid.ts`). That's a reasonable design, but it is currently
**biased in three separate directions that all push the same way**: they reward
a provider for saying *less*, for *not reporting its own uncertainty*, and for
*writing numbers in digits*. Sections T-2 → T-5 are those biases. Until they're
fixed, the ranking answers a different question than the one being asked.

Everything else in this doc is either a bug found in the same pass or an
architecture decision the growth path forces (parallelism, result scope).

---

## Part A — Ranking correctness (P0). These make the recommendation wrong today.

### T-1 (P0): A bulk's rankings are computed per shard, so 95% of the evidence is silently thrown away

**Where:** `artifacts/api-server/src/lib/run-executor.ts` `computeRankingsForRun()`
(called at line ~424); `artifacts/api-server/src/routes/benchmark.ts:1381`
(`GET /benchmark/rankings`).

**Current behaviour:**
1. `launchBulk()` (`lib/bulks.ts:311`) splits the frozen call set into shards of
   `shardSize` (default 50) and creates **one run per shard**.
2. Every run, on finishing, calls `computeRankingsForRun(runId, ...)` which
   writes ranking rows **keyed by that run's id**, aggregated over **only that
   shard's calls**.
3. `GET /benchmark/rankings` then picks, per assistant group, the ranking rows
   belonging to **the single run with the newest `createdAt`**.

**The failure:** a 1,000-call bulk = 20 shards = 20 competing ranking sets for
the same assistant. The Rankings page shows exactly one of them — 50 calls of
evidence — and there is no indication the other 950 exist. Worse, all 20 shards
are created within milliseconds of each other, so "newest run" is effectively
arbitrary ordering, not a meaningful choice.

**Required behaviour — introduce an explicit ranking scope:**
- Rankings must be computed at **bulk scope**, not run scope, for any run that
  has a `bulkId`.
- Add `bulkId` (nullable uuid) to `benchmark_rankings` alongside the existing
  `runId`. `runId` stays populated for ad-hoc (non-bulk) runs.
- New function `computeRankingsForBulk(bulkId)` in `run-executor.ts`: same
  aggregation logic as `computeRankingsForRun` but the result set is selected by
  `benchmark_runs.bulkId = $bulkId` instead of `runId = $runId`, and the
  clear-and-rewrite transaction at the bottom deletes `WHERE bulkId = $bulkId`.
- `executeBenchmarkRunInner` calls `computeRankingsForBulk(run.bulkId)` when
  `run.bulkId` is set, and `computeRankingsForRun` otherwise. Racing shards are
  fine: the function is a full recompute inside one transaction, so the last
  shard to finish writes the complete picture. (Serialise it with the same
  `pg_try_advisory_lock(hashtext(bulkId))` pattern already used for runs, so two
  shards finishing simultaneously don't interleave the delete/insert.)
- `GET /benchmark/rankings` selects, per assistant group, the rows from the
  **most recent bulk** that scored that group (ordered by `benchmark_bulks.createdAt`),
  falling back to the most recent ad-hoc run only when no bulk covers the group.
- Response gains `scope: "bulk" | "run"`, `scopeId`, `scopeLabel` (bulk name or
  run id prefix), and `callsScored` (distinct call count behind the row).

**Acceptance:**
- Launch a bulk of ≥120 calls with shardSize 50 → Rankings shows ONE row set per
  assistant, and `sampleSize` for the top provider equals the number of that
  assistant's calls that scored ok across **all** shards, not ≤50.
- Ad-hoc run rankings still work unchanged.

---

### T-2 (P0): Providers that report their own confidence are punished for it

**Where:** `lib/scoring/src/hybrid.ts:260` (`flagCount += params.confidenceSpans.length`),
`artifacts/api-server/src/lib/hybrid-flagging.ts` `extractProviderConfidenceWords()`.

**Current behaviour:** only AssemblyAI, Deepgram and Gladia expose per-word
confidence. Every low-confidence span they report adds `+1` to their
`flagCount`. Cartesia, OpenAI, ElevenLabs and Speechmatics expose nothing, so
they contribute **exactly 0 confidence flags, always**. `flagCount` is 70% of the
ranking composite (`HYBRID_RANKING_WEIGHTS.flags`).

**The failure:** a provider is ranked worse **because it is honest about its own
uncertainty**. This is not a small skew — on a noisy call, Deepgram can pick up
dozens of low-confidence spans while Cartesia mathematically cannot pick up one.

**Required behaviour:**
- Split `flagCount` into **two independently-tracked numbers** on
  `benchmark_scores`: `peerFlagCount` (cross-provider disagreement + entity
  mismatch — available for every provider) and `selfConfidenceFlagCount`
  (confidence spans — available only where the provider reports them).
- The **ranking composite may only use `peerFlagCount`.** Confidence flags stay
  as a per-cell review signal (they're genuinely useful to a human reading one
  call) but never feed a cross-provider score.
- Add `confidenceAvailable: boolean` to the per-cell hybrid detail so the UI can
  say "not reported by this provider" instead of showing a clean 0.
- If confidence is later wanted in the ranking, it must be normalised
  *within the set of providers that report it* and compared only against those —
  not against a structural zero. Do not implement that now; note it as future.

**Acceptance:** run the same call through Deepgram + Cartesia. Deepgram's
composite must not drop relative to Cartesia purely because Deepgram returned
low-confidence spans. Unit test in `lib/scoring/src/hybrid.test.ts` asserting
composite is unchanged when `confidenceSpans` grows.

---

### T-3 (P0): A provider that *drops* an entity is never flagged for it

**Where:** `lib/scoring/src/hybrid.ts:215` (`if (perProvider.size < 2) continue`)
and `computeEntityMismatches()` generally.

**Current behaviour:** entity mismatches are only raised between providers that
**both mentioned an entity of that type**. A provider whose transcript contains
no phone number at all simply doesn't appear in that type's map, so it is never
listed in `valuesByProvider` and never gets the `+1` flag / `high` severity.

**The failure:** for a tool whose stated purpose is "did it get the RO number
right", **omitting the RO number entirely scores better than getting it slightly
wrong.** Two providers that both heard "4471" vs "4671" are both flagged high;
the third that heard nothing is clean.

**Required behaviour:**
- Change the mismatch model from "values disagree" to "**consensus vs. this
  provider**", per entity type, per call:
  - Build the set of entity values seen by *any* provider for that call.
  - For each value, count how many providers produced it. A value produced by
    ≥50% of the providers that produced *any* entity of that type is a
    **consensus entity**.
  - For each provider: `missing` = consensus entities it did not produce;
    `conflicting` = entities it produced that differ from a consensus entity of
    the same type; `extra` = entities no one else produced.
- Flag weights: `conflicting` → high (unchanged), `missing` → high (new),
  `extra` → medium (new; a hallucinated phone number is also a real failure).
- Emit these three counts separately in the stored detail so the UI can say
  *which* kind of entity failure it was.
- Guard: only run this when ≥3 providers succeeded on the call (with 2 there is
  no consensus, only a disagreement — record it as `conflicting` on both, as
  today, and mark the call `consensusAvailable: false`).

**Acceptance:** unit test — 3 candidates, two say "unit 4471", one says nothing
→ the silent one is flagged `missing`, severity high. Today it is flagged 0.

---

### T-4 (P1): Cross-provider disagreement blames both sides equally, and its thresholds shift with how many providers ran

**Where:** `lib/scoring/src/hybrid.ts` `computeCrossProviderDisagreement()`,
thresholds at lines 241–242.

**Current behaviour:** every unordered pair is diffed and **both members of the
pair are charged the full mismatch count**. A provider's `disagreementRate` is
therefore its mismatches averaged across all its pairings.

**The failure, concretely:** 4 providers, 3 agree perfectly, 1 is garbage.
- Garbage provider: 3 bad pairs → rate ≈ high. Correct.
- Each good provider: 2 clean pairs + 1 bad pair → rate ≈ high/3. So a
  *perfect* provider still accrues a third of the outlier's badness, and with a
  fixed `DISAGREEMENT_FLAG_THRESHOLD = 0.15` it can cross into flagged territory
  purely because someone else in the run was bad. Add a 5th bad provider and the
  good ones' rates rise again — **the same provider on the same audio scores
  differently depending on who else was in the run.** That breaks comparability
  between bulks with different provider sets.

**Required behaviour — consensus-relative, not pairwise:**
- Compute a **reference consensus token sequence** per call: align all
  candidates and take, per position, the token produced by the plurality of
  providers (simple ROVER-style vote over the existing `diffWords` alignment; a
  pairwise-alignment-to-the-longest-candidate baseline is acceptable and much
  simpler — document whichever is chosen).
- `disagreementRate` = that provider's mismatch rate **against the consensus**,
  not against each peer.
- Ties (no plurality at a position) are excluded from both numerator and
  denominator rather than counted as everyone being wrong.
- Store `consensusProviderCount` alongside so the UI can caveat a 2-provider run.
- Keep the existing 0.15 / 0.35 thresholds but re-state them in the code comment
  as "against consensus", and record that they remain **uncalibrated** (see A-5).

**Acceptance:** unit test — 3 identical transcripts + 1 wildly different →
the three identical providers all score `disagreementRate === 0` and zero flags.
Today they don't.

---

### T-5 (P1): Number formatting differences between providers are scored as transcription errors

**Where:** `lib/scoring/src/index.ts` `normalizeTranscript()`;
`lib/stt-providers/src/adapters/deepgram.ts:60` (`smart_format: "true"`);
`lib/scoring/src/hybrid.ts` `PHONE_RE` / `REFERENCE_RE`.

**Current behaviour:** Deepgram runs with `smart_format=true`, which applies
inverse text normalisation — "five five five one two one two" becomes
"555-1212". Other adapters are left on their vendor defaults, several of which
spell numbers as words. `normalizeTranscript()` folds quotes, dashes, case and
punctuation, but **does nothing about number words vs digits**.

**Two compounding failures:**
1. **Word diff:** the same spoken digits count as ~7 substitutions between a
   spelling provider and a formatting provider. That's pure format noise
   inflating `disagreementRate` for both.
2. **Entity extraction:** `PHONE_RE` requires literal digits. A provider that
   spells numbers out **can never match a phone number**, so it never produces
   an entity, so (per T-3 today) it is never flagged — the two bugs stack into
   "spell your numbers out and you win".

**Required behaviour:**
- Add `normalizeNumbers()` to `lib/scoring/src/index.ts`: convert English number
  words (zero–nine, ten–twenty, tens, "hundred", "oh"→0, "double X"→XX) into
  digits **before** tokenisation, applied identically to every candidate.
  Keep it deliberately narrow — spoken digit strings, not full cardinal parsing.
- Apply it inside `normalizeTranscript()` and again inside `extractEntities()`.
- Bump `SCORING_VERSION` to `"v2"` (the version column exists precisely for
  this — `NFR-6/FR-S7`). Do not backfill old rows; they keep `v1`.
- Explicitly document in the adapter files which formatting flags each provider
  runs with, and add a follow-up note: formatting flags should eventually be
  **uniform across adapters** (see T-12).

**Acceptance:** unit test — "call five five five one two one two" and
"call 555-1212" normalise to the same token stream and produce the same
extracted phone entity.

---

## Part B — Scale & parallelism (P0/P1). This is the "how many workflows at once" answer.

### T-6 (P0): Shard runs are fired with no cap, so the per-provider rate gate does nothing

**Where:** `artifacts/api-server/src/lib/bulks.ts:342` (launch) and `:396`
(retry); `artifacts/api-server/src/lib/run-executor.ts:75-76, 374`.

**Current behaviour:**
```
RUN_CONCURRENCY      = 16   // cells in flight, PER RUN
PROVIDER_CONCURRENCY = 4    // cells in flight per vendor, PER RUN
```
`providerSlots` (line 374) is a `Map` created **inside** `executeBenchmarkRunInner`,
so each shard run gets **its own fresh set of semaphores**. `launchBulk` then
fires every shard at once in a plain `for` loop with `void executeBenchmarkRun(...)`.

**The failure, with real numbers:** 1,000 calls / shardSize 50 = **20 concurrent
shard runs**. Ceiling becomes 20 × 16 = **320 cells in flight**, and 20 × 4 =
**80 concurrent requests to a single vendor** — against a gate whose own comment
says it exists to stop "a 429 storm [that] helps nobody's latency ranking".
Since latency is 15% of the composite, a self-inflicted 429 storm doesn't just
slow the bulk down, **it corrupts the ranking it's producing**.

**Required behaviour:**
1. **Make the per-provider semaphore a module-level singleton** in
   `run-executor.ts` — one `Map<providerId, Semaphore>` shared by every run in
   the process, created once at module scope, not per-run. This is the
   single most important line-level change in this document.
2. **Cap concurrent shard runs.** New env knob `BULK_SHARD_CONCURRENCY`
   (default **3**, max 8, same `envInt` clamp pattern). `launchBulk` and
   `retryBulkFailedCells` must drain their shard list through the existing
   `drainWithConcurrency()` helper instead of firing all of them.
3. **Per-vendor limits, not one global number.** Replace the single
   `PROVIDER_CONCURRENCY` with a per-provider map, seeded from a new
   `benchmark_providers.maxConcurrency` column (nullable int; falls back to the
   env default). Recommended starting values, to be tuned against real 429s:

   | Provider | Shape | Suggested max concurrency |
   |---|---|---|
   | deepgram-nova-3 | sync REST, fast | 8 |
   | openai-gpt-4o-transcribe | sync REST | 4 |
   | elevenlabs-scribe | sync multipart | 4 |
   | assemblyai-universal | async poll | 6 |
   | gladia-solaria | async poll | 4 |
   | speechmatics | async poll | 4 |
   | cartesia-ink-whisper | WebSocket stream | 2 |

4. **Back-pressure on 429.** When a cell fails with HTTP 429, halve that
   provider's live semaphore capacity for 60s (floor 1), then restore. Log the
   change once per transition, not per cell.

**Acceptance:** launch a 200-call / 7-provider bulk. Log a per-second histogram
of in-flight requests per provider; no provider ever exceeds its configured max,
across all shards combined. Total in-flight never exceeds
`BULK_SHARD_CONCURRENCY × RUN_CONCURRENCY`.

---

### T-7 (P1): Whole-shard audio is held in RAM simultaneously

**Where:** `run-executor.ts` — `audioByCallId` map built at ~line 325 holds a
`Buffer` per call for the **entire** shard, and every cell for that call holds a
reference until the shard drains.

**The failure:** shardSize 50 × ~4 MB/call ≈ 200 MB per shard. With T-6's fix at
3 concurrent shards that's ~600 MB; without it (20 shards) it's ~4 GB and the
process OOMs. The bytes are already durably on local disk in
`artifacts/api-server/audio-cache/` — keeping them in memory buys nothing.

**Required behaviour:** stop materialising `audioByCallId`. Resolve/cache each
call's audio (which is what puts it on disk) as a **pre-pass that returns only
`{callId, ok, error}`**, then have each cell read its bytes from the cache file
at the moment it runs, inside the provider semaphore. Add
`readCachedAudioBytes(callId)` to `lib/audio-cache.ts`.

**Acceptance:** RSS during a 50-call shard stays under ~150 MB above baseline.

---

### T-8 (P1): Polling providers get billed 3× for any call longer than the fixed 120s timeout

**Where:** `lib/stt-providers/src/poll.ts:14` — `timeoutMs = 120_000`, fixed for
every call regardless of audio length. Used by AssemblyAI, Gladia, Speechmatics.

**The failure:** a long call whose job legitimately takes >120s throws
`Polling timed out`. `isRetryableError()` (run-executor) treats a generic
`Error` as retryable → the whole cell retries → the adapter **re-uploads the
audio and submits a brand-new job**. Three attempts = three paid transcriptions,
all of which time out, and the cell still lands `failed`. Silent triple-billing
on exactly the long calls that matter most.

**Required behaviour:**
- `pollUntil` takes the audio duration and computes
  `timeoutMs = clamp(60_000, durationSeconds * 1000 * 3, 900_000)` —
  3× realtime, floor 1 min, ceiling 15 min. Thread `durationSeconds` through
  `ProviderTranscribeInput`.
- A polling timeout must be **non-retryable at the cell level**: mark it with a
  distinguishable error (`PollTimeoutError`) and have `isRetryableError()`
  return `false` for it. A timed-out job is a submitted job — retrying it pays
  twice for the same work.
- Stretch (do only if straightforward): persist the provider job id on the
  result row so a future retry can *resume polling the existing job* rather
  than resubmitting. If not done now, record it here as the follow-up.

**Acceptance:** a 12-minute call through AssemblyAI completes rather than
timing out, and a forced timeout produces exactly one submitted job, not three.

---

## Part C — Data & pipeline bugs (P1)

### T-9 (P1): Audio playback ignores the local cache and still dies on Vapi's 14-day window

**Where:** `routes/benchmark.ts:518` (`GET /benchmark/calls/:callId/audio`) —
calls `resolveFreshRecordingUrl()` and 302-redirects. `lib/audio-cache.ts` is
never consulted.

**The failure:** `FIX-2` moved *the executor* off Vapi's retention clock by
caching bytes to disk, but the **player didn't move with it**. A call whose
audio is sitting on disk, already successfully transcribed, cannot be played
back by a reviewer once it's 15 days old — the exact call they most need to
listen to when checking a flagged span.

**Required behaviour:** serve cached bytes when present (`Content-Type: audio/*`,
`Accept-Ranges: bytes`, honour `Range` so the `<audio>` scrubber works). Only
fall through to the Vapi redirect on a cache miss, and on a successful live
fetch, write it to the cache so the next play is local.

**Acceptance:** disconnect the Vapi key; a cached call still plays and seeks.

---

### T-10 (P1): Every scored cell writes a garbage word-diff of its entire transcript

**Where:** `run-executor.ts:659` — `goldTranscript: call.goldTranscript ?? ""`,
and `:678` — `detail: { edits, entityResults, wordDiff }`.

**The failure:** with gold retired, `goldTranscript` is empty for every call.
`alignWords([], hypothesis)` therefore returns **one `"ins"` op per word of the
transcript**, `edits.referenceWords === 0`, `wer === null`. So each `ok` cell
stores a JSON array with one object per spoken word — a second, bulkier copy of
the transcript, for data that is meaningless by construction. On a 1,000-call ×
7-provider bulk that is millions of useless JSON objects. It also drives a
visibly wrong UI panel (see `docs/PRD-v3-uiux.md` U-2).

**Required behaviour:**
- In `run-executor.ts`, skip the gold-dependent work entirely when
  `call.goldTranscript` is empty: do not call `alignWords`, write
  `wer: null, entityAccuracy: null, alphanumericAccuracy: null`, and write
  `detail: { entityResults: [] }` with **no** `wordDiff` and no `edits` key.
- Keep `score()` itself unchanged (historical runs and any future gold-based
  re-score still need it). Gate at the call site.

**Acceptance:** after a fresh run, `SELECT detail FROM benchmark_scores` on a new
row contains no `wordDiff` key, and row size drops by roughly the transcript's
own size.

---

### T-11 (P1): The cost metric is mislabelled — the column named `costPerMinute` holds cost *per call*

**Where:** `run-executor.ts:664` —
`costPerMinute: (provider.costPerMinute * call.durationSeconds) / 60`.

**The failure:** that expression is the **total cost of transcribing this call**,
not a rate. It is stored in `benchmark_scores.costPerMinute`, averaged into
`benchmark_rankings.costPerMinute`, exported to CSV as `cost_per_minute`, and
shown in the Rankings UI under a "Cost/Min" header. Anyone reading that column
as a rate — which is what it says it is — is reading it wrong, and a group of
long calls looks more expensive per minute than a group of short ones.

**Required behaviour:**
- Rename the stored value to what it is: add `costCents` (cost of this cell) and
  keep the vendor's actual rate available as `provider.costPerMinute` for
  display. Migration: new column, backfill from existing values, drop the old
  one only after the UI is updated.
- Rankings aggregate BOTH: `avgCostPerCall` and the flat `ratePerMinute` from
  the provider row. The composite's cost component should use
  `avgCostPerCall` (it's what actually gets spent).
- CSV header and UI label updated to match (`docs/PRD-v3-uiux.md` U-9).

**Acceptance:** for a provider at $0.0043/min over a 120s call, the stored cell
cost is 0.86¢ and the UI shows "$0.0086 / call" and "$0.0043 / min" as two
distinct, correctly-labelled numbers.

---

### T-12 (P1): Provider request settings are inconsistent, undocumented, and not configurable

**Where:** all of `lib/stt-providers/src/adapters/*.ts`.

**Current state, as actually written:**

| Provider | language | formatting | diarize | keyword boosts |
|---|---|---|---|---|
| deepgram-nova-3 | vendor default | `smart_format=true` | yes | `keywords` |
| assemblyai-universal | vendor default | vendor default | `speaker_labels` | `word_boost` |
| gladia-solaria | vendor default (auto-detect) | vendor default | yes | `custom_vocabulary` |
| speechmatics | **`"en"` (only one pinned)** | vendor default | `speaker` | `additional_vocab` |
| openai-gpt-4o-transcribe | vendor default (auto-detect) | n/a | n/a | none |
| elevenlabs-scribe | vendor default | vendor default | yes | none |
| cartesia-ink-whisper | vendor default | n/a | n/a | none |

**Two failures:**
1. **Fairness.** Auto-detect languages occasionally mis-detect on short/noisy
   English calls, producing a catastrophic transcript that is scored as a
   quality failure when it's actually a config difference. Only Speechmatics is
   protected. Pin `language: "en"` (or the run's configured language) on every
   adapter that supports it.
2. **`keywordBoosts` is dead code.** `ProviderTranscribeInput.keywordBoosts`
   exists, four adapters map it to their vendor's vocabulary parameter — and
   **the executor never passes it**. `runCell()` calls
   `adapter.transcribe({ callId, audioBytes, diarize: true })`, full stop.
   This is the single biggest missing customisation lever: Rush truck-parts
   calls are full of part numbers, property management is full of unit numbers,
   and none of that domain vocabulary ever reaches the providers.

**Required behaviour:**
- New table `benchmark_vocabularies`: `id`, `name`, `assistantId` (nullable),
  `vertical` (nullable), `terms text[]`, `createdAt`. A vocabulary applies to a
  call if its `assistantId` matches, else if its `vertical` matches, else not
  at all. Most-specific wins; at most one applies.
- `run-executor` resolves the applicable vocabulary per call and passes
  `keywordBoosts` into `transcribe()`.
- The resolved vocabulary is **recorded in the run manifest**
  (`lib/manifest.ts`) — it changes results, so reproducibility requires it
  (`docs/reproducibility.md`).
- New `RunOptions` on the run/bulk row: `{ language: string; diarize: boolean;
  vocabularyId: string | null }`, frozen into the manifest at creation.
- Every adapter documents its formatting flags in a header comment, and any
  adapter that can turn ITN/smart-formatting off should do so **only** if T-5's
  normalisation is not enough — prefer normalising at scoring time over
  disabling vendor features, because the goal is to compare providers *as they'd
  actually be deployed*.

**Acceptance:** a Rush vocabulary of 20 part-number prefixes measurably changes
the transcripts for Deepgram/AssemblyAI/Gladia/Speechmatics, and the manifest for
that run lists the exact term set used.

---

### T-13 (P2): `diarizationScore` is a 1/0 "did it return any speaker label" proxy, and it is ranked and exported as if it were a quality score

**Where:** `parseDeepgramResponse` (`deepgram.ts:43`), and the equivalent in
gladia/elevenlabs; surfaced in `benchmark_rankings.diarizationScore`, sortable in
the Rankings UI, present in the CSV.

**The failure:** it measures *capability*, not *accuracy* — it is 1.0 for any
provider that emitted at least one speaker label, regardless of whether the
diarisation was right. Sorting a decision table by it is meaningless, and it is
the kind of number that ends up in a client-facing recommendation.

**Required behaviour:** rename the concept to `diarizationSupported: boolean`
throughout (schema, API, UI, CSV), remove it from the sortable metric list, and
render it as a capability tick, not a score. Real diarisation accuracy (DER)
requires reference speaker segments and stays out of scope — record it in
`docs/backlog/good-to-have.md`.

---

### T-14 (P2): `isAudioCached()` is exported and never called; the corpus retention warning is date-only and therefore wrong

**Where:** `lib/audio-cache.ts:71` — zero call sites (verified across
`artifacts/*/src` and `lib/*/src`). `Corpus.tsx:187-204` warns purely on
`sourceStartedAt` age.

**The failure:** the warning fires on every call over 14 days old, including the
many whose audio is safely cached and permanently runnable — and stays silent
about the genuinely urgent case (a call at day 12 that has never been cached).
It trains the operator to ignore the warning.

**Required behaviour:** include `audioCached: boolean` in the
`GET /benchmark/calls` serialisation (batch the `fs.access` checks; at corpus
scale this is cheap, but cap it — if the corpus exceeds 500 calls, read the
cache directory listing once instead of stat-ing per call). UI treatment in
`docs/PRD-v3-uiux.md` U-6.

---

### T-15 (P2): `GET /benchmark/runs/:runId/results` returns every cell, unpaginated, with full transcripts

**Where:** `routes/benchmark.ts:1198`.

**The failure:** one shard = 50 calls × 7 providers = 350 rows, each carrying a
full `hypothesisTranscript` plus (today) a per-word `wordDiff`. That's a
multi-megabyte JSON response behind a dialog that polls. T-10 removes the
`wordDiff` half of it; the rest still needs bounding.

**Required behaviour:** add `?limit` (default 100, max 500) + `?cursor`
(createdAt+id keyset), and `?status=` / `?callId=` / `?providerId=` filters.
Omit `hypothesisTranscript` from the list response entirely — add
`GET /benchmark/results/:resultId` returning the full transcript for the one row
being read (which is also what U-1 needs).

---

### T-16 (P2): The agent scan runs a full provider re-run inside one synchronous HTTP request

**Where:** `routes/agent.ts:172` — `await executeBenchmarkRun(run.id, actorLabel)`
inside the POST handler.

**The failure:** when a call has <2 existing candidates, the request blocks on
transcribing that call across every configured provider — polling providers alone
can take minutes. Any proxy/load-balancer idle timeout kills the request while
the work continues server-side, and the client has no way to reattach. The
`errorMessage` path also returns **HTTP 201** for a failed scan, so the client
must inspect the body to tell success from failure.

**Required behaviour:** return `202` immediately with the scan row in
`status: "scanning"`, let the existing `GET /benchmark/agent/scans` polling
(already implemented in `Agent.tsx:397`) drive the UI, and do the work in the
background. Failed scans return the scan row with `status: "error"` — keep the
row, but the HTTP status for a *created* scan is 202, not 201.

---

## Part D — The review agent: which model, and how the verdict is produced

This section answers "which agent will be best for reviewing the calls and
giving the final verdicts". Today: `lib/agent.ts` uses **`gpt-4o-mini`** for
failure analysis and **`gpt-4o`** as the transcript judge (overridable via
`app_settings.agentModel`). That works, but the *architecture* around it is
where the accuracy is lost, not the model choice.

### A-1 (P1): Three tiers, with the expensive tier used once per decision, not once per cell

| Tier | Runs | What it does | Model |
|---|---|---|---|
| 0 — deterministic | every cell, free | consensus disagreement, confidence spans, entity consensus (`hybrid.ts`) | none |
| 1 — per-call judge | only calls with tier-0 flags | "which candidate reads most sensibly, and why" | **Claude Sonnet 5** (`claude-sonnet-5`) |
| 2 — final verdict | **once per assistant per bulk** | reads the aggregated tier-0/tier-1 evidence for that assistant and writes the recommendation a human acts on | **Claude Opus 5** (`claude-opus-5`) |

Rationale: tier 1 is a bounded text-comparison task over a handful of
transcripts, run many times — Sonnet 5 is the right cost/quality point and
replaces `gpt-4o`. Tier 2 runs a handful of times per bulk and is the output an
Ellavox client decision rests on — it is worth Opus 5. Tier 0 stays free and
must never be replaced by an LLM call; it is what makes tiers 1–2 affordable.

Keep `app_settings.agentModel` as the override, but store it **per tier**
(`agentJudgeModel`, `agentVerdictModel`, `agentAnalysisModel`) and default them
to the table above. The provider abstraction in `lib/agent.ts` is a raw `fetch`
against OpenAI's chat-completions endpoint; adding Anthropic means a second
small client function in the same file (Messages API, `x-api-key` +
`anthropic-version` headers, `ANTHROPIC_API_KEY` env var, same ephemeral-key
rule as every other key in this repo).

**Tier 2 output — this is currently missing entirely.** There is no
per-assistant verdict anywhere in the system; Rankings shows a sorted table and
a per-row `recommendation` string generated by a template in
`computeRankingsForRun`. Tier 2 must produce, per assistant: the recommended
provider, the runner-up, what specifically separates them (citing flagged spans
and entity failures from real calls), the confidence level given sample size,
and what would change the answer. Store on a new `benchmark_verdicts` table
keyed by `(bulkId, assistantId)`.

### A-2 (P0 for trust): The judge currently rewards fluent hallucination

`judgeCandidates()` asks the model to pick whichever transcript "reads most
sensibly", from **text alone, with no audio**. A provider that smooths an
unclear passage into a confident, plausible sentence reads more sensibly than
one that transcribes the messy truth. Combined with T-2 (confidence honesty is
punished) and T-3 (omission is unpunished), **the entire gold-free stack has a
consistent bias toward providers that sound good rather than providers that are
right.** This is a methodology issue, not a bug in any one line, and it must be
stated plainly in the UI wherever a verdict is shown.

Mitigations, in order of value:
1. **Ground the judge in audio for flagged spans only.** Cut the audio around
   each flagged span (timestamps are available in the providers' raw output) and
   send those seconds to an audio-capable model, asking what was actually said.
   Claude models do not accept audio input, so this arbiter tier needs a
   separate audio-capable model — keep it behind the same pluggable interface
   and treat the choice as an open decision, not a settled one.
2. **Human spot-check as the calibration anchor** — see A-5. Cheaper than (1)
   and strictly more trustworthy.
3. Until either exists, the judge's pick must be labelled in the UI as
   "reads most sensibly (text only — not verified against the audio)".

### A-3 (P1): Blind the judge — it currently sees provider brand names

`judgeCandidates()` passes `providerName` for every candidate into the prompt,
and the candidates are always in the same order. Both are known LLM biases: a
model has priors about "Deepgram" vs "Gladia", and position in the list affects
selection.

**Required:** replace names with anonymous labels (`A`, `B`, `C`) inside the
prompt, shuffle candidate order per call with a seed derived from the call id
(so it's deterministic and reproducible), and map back to real provider ids only
after the model responds. Keep the mapping in the stored scan record so a human
can audit it.

### A-4 (P2): Self-consistency on close calls

When tier 1's flags are high-severity and the candidates are close, run the
judge 3× (shuffled differently each time) and take the majority; disagreement
across the three runs is itself the signal that the call needs human ears.
Record `judgeAgreement: 3/3 | 2/3 | 1/3` on the scan.

### A-5 (P0 for trust): Build a small calibration set — nothing above can be validated without one

Every threshold in `hybrid.ts` is explicitly documented as a guess
(`0.15`, `0.35`, `0.5`, `0.6`, `MIN_RUN_LENGTH = 2`), and every bias in T-2→T-5
was found by reading code, not by measurement. **Hand-correct 20 calls** —
they are not "gold transcripts" for scoring, they are a *test set for the
scorer*. With them you can answer, with a number: does a high `flagCount`
actually correlate with real errors? Does the judge pick the provider a human
would? Which threshold value maximises agreement with the human?

This is the highest-leverage item in the whole document and it costs a day of
listening, not a sprint of engineering. Store as `benchmark_calibration_calls`,
excluded from ordinary rankings, with a `scripts/` command that reports
precision/recall of the flagging stack against them.

---

## Part E — Result scope: one verdict or many?

The user's question — "do we need one single result or multiple results per
assistant or call id" — has a concrete answer this codebase should encode
explicitly. **Three levels, each with one owner:**

| Level | Grain | Question it answers | Where it lives |
|---|---|---|---|
| **Cell** | call × provider | "what did this provider do on this call?" | `benchmark_provider_call_results` + `benchmark_scores` |
| **Assistant verdict** | assistant × bulk | **"which provider should this assistant use?"** ← the decision | `benchmark_rankings` (T-1) + `benchmark_verdicts` (A-1) |
| **Bulk** | one launch | "what evidence produced that answer, and is it enough?" | `benchmark_bulks` |

The **assistant verdict is the single result**. Per-call results are evidence,
never a verdict — a provider winning one call means nothing at n=1, and the code
already knows this (`confidenceNoteFor`, `sampleSize < 12` per
`PRD.md AC-FULL-1`). Per-provider-across-all-assistants is *not* a useful level:
the whole premise of the tool is that the right provider differs by vertical and
by call content, so a global "best provider" number would flatten exactly the
signal being bought.

Consequences to implement: T-1 (rankings at bulk scope), A-1 tier 2 (one written
verdict per assistant), and the UI change in `docs/PRD-v3-uiux.md` U-3 (Rankings
becomes a per-assistant decision page, not a table of rows).

---

## Part F — Smaller correctness notes (P2/P3)

- **F-1** `run-executor.ts:478` — a run is `"complete"` whenever `okCells > 0`,
  even if 349 of 350 cells failed. Add a distinct `"partial"` status (`okCells >
  0 && failedCells > 0`) so "complete" means what it says. UI: U-7.
- **F-2** `routes/benchmark.ts:1075` — `POST /benchmark/runs` still blocks with
  *"every selected call must have an approved gold transcript"*. Gold is
  retired; the actual gate is de-id. Fix the message to
  "every selected call needs two de-identification approvals first".
- **F-3** `Corpus.tsx:173-174` — `ready_for_gold` / `gold_in_review` statuses are
  vestigial. Remove from the enum and the badge map, migrating any surviving row
  to `needs_review`.
- **F-4** `cancelBulk()` (`bulks.ts`) flips `queued` runs to `cancelled`, but
  `launchBulk` fires every shard immediately, so a shard can already be inside
  `executeBenchmarkRunInner` while its row still reads `queued` — it then runs to
  completion despite the cancel. Once T-6 caps shard concurrency, un-started
  shards genuinely sit queued and the flip works. Verify after T-6; add
  `cancelRequestedRuns` registration for queued-but-firing runs as a belt.
- **F-5** `computeCrossProviderDisagreement` and the entity pass both operate
  only on cells within **one run**. After T-1, confirm they still see all of a
  call's providers (they do — a call lives in exactly one shard — but the
  invariant should be asserted, not assumed).
- **F-6** No unit test script is configured for `artifacts/api-server`. Add one
  (`vitest`) and cover: `matchKnownFailure`, `resolveCriteriaCallIds`,
  `extractProviderConfidenceWords`, and the new consensus functions.

---

## Suggested execution order

1. **T-6 + T-7** — stop the bleeding at scale before running any more big bulks.
2. **T-2, T-3, T-4, T-5** — the ranking is wrong until these land; everything
   downstream is built on them.
3. **T-1** — then the rankings that are now correct are also complete.
4. **T-10, T-11, T-9, F-1, F-2, F-3** — cheap, visible, mostly mechanical.
5. **A-5 (calibration set)** in parallel with all of the above — it is human
   work, not engineering work, and it gates whether any of this is trusted.
6. **A-1 → A-4** — the agent rework, once the deterministic layer it reads is
   sound.
7. **T-12** — vocabulary/customisation, the first genuinely new capability.
8. **T-8, T-13, T-14, T-15, T-16, F-4, F-6** — hardening.

**Definition of done for every item:** `pnpm run typecheck` clean at repo root,
the relevant package's tests green, and — for anything touching run execution or
scoring — one real bulk executed against live provider APIs with the outcome
recorded in `docs/backlog/good-to-have.md`.
