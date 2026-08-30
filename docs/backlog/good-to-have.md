## Found 2026-08-31 (batch 12, T-126): what the audio rescue could and could not save

First full rescue over the corpus (121 calls, 57 uncached): 43 saved, 0
expired-by-our-count, 14 refused by Vapi with HTTP 400 "Your subscription
plan only covers the last 14 days of call history". The 14: nine calls with
no `sourceStartedAt` at all (pre-labeling era, genuinely old), and the five
dated 2026-08-19 — refused at day 12, i.e. before day 14. Whether those five
are the same five calls as the known storage-bucket failure set was not
verified; the counts match, the identity was not checked call-by-call.

Residue, deferred (not silently ignored): neither the rescue endpoint nor
import-time caching persists a per-call attempt outcome, so the Overview's
"audio not saved" figure and the "Save audio now (N)" button keep counting
the 14 calls Vapi has already refused. Follow-up when it matters: store the
last attempt outcome per call and split "never tried" from "Vapi refused",
so the figure can reach a true zero.

## Mined 2026-08-30 (batch 7, T-101): the real reading pairs behind the equivalence rules

72 calls, latest batch run each, 873 disagreement spans, 2,390 distinct reading
pairs. The top of the list (count, reading A ||| reading B):

```
 22  ||| 0                      (Deepgram inserts a 0 between spoken digits -- real, kept)
 17 1 bedroom ||| 1-bedroom
 16 1 bedroom ||| one-bedroom
 15 1-bedroom ||| one-bedroom
 12  ||| um
 10 2 bedroom ||| 2-bedroom
  9 2 bedroom ||| two-bedroom
  6 1 -bedroom ||| 1 bedroom
  5  ||| uh
  4 all right ||| alright
  4 tour 2 4 ||| tour24
  4 saint ||| st
  4 2 6 at 10am ||| 26th at 1 0 a m
  3 after -hours ||| after hours     3 follow up ||| follow-up
  3 4 ||| forty                      (NOT equal -- stays a disagreement)
  3 hill's ||| hills                 3 apartment ||| apartments   (kept as disagreements)
  2 i'm going to ||| i'm gonna       2 yeah ||| yes     2 ok ||| okay
  2 high priority ||| high-priority  2 in -person ||| in person
  2 non-refundable ||| nonrefundable 2 his wi fi ||| his wi-fi
```

Everything folded by `lib/scoring/src/equivalence.ts` is on this list or was named by
Abhishek ("fortyc / 40c", "highpriority / high-priority", slang like "sweet").
Deliberately **not** folded: plural / possessive ("hills" / "hill's"), tense ("had" /
"have"), and "4" / "forty" — those change meaning or could. Re-run the mining
(the script lived in src/_mine-pairs.ts -- deleted, never committed -- for one session; recreate from
`buildSpansForCallRun`) after the next few bulks to see what rises next.

## Deferred 2026-08-30 (batch 4): more call providers

Only Vapi is a call source today (`lib/vapi.ts`, one `VAPI_API_KEY*` env var per
org). Abhishek named the ones that will come later, in this order of mention:
**Retell, ElevenLabs (conversational), LiveKit, Bland.ai, Telnyx.** Per his
instruction they live here and nowhere else -- not in the PRD, not on the
screen (the Import page's "Other call providers" row says "not supported yet"
and names nobody).

What adding one takes, from the Vapi adapter's shape: a `list/preview calls`
call with paging on the oldest `createdAt` (T-60's lesson), a working
recording URL (Vapi's `presignedMonoUrl`, not `recordingUrl` -- verify against
the real API, `docs/provider-data-samples.md`), the draft transcript and the
transcriber the provider used live (`sourceTranscriberProvider/Model`, for the
production-baseline line), assistant id + name, and an `accountLabel` per key so
the org grouping (T-88/T-89) works without change. `sourceProvider` on
`benchmark_calls` is already a column, defaulting to `"vapi"`, so the schema
needs nothing new for the first extra provider.

## Fixed 2026-08-25, full end-to-end launch-readiness pass

Ran the whole system for real: typecheck, both unit suites, a production UI
build, then live traffic against the real DB/providers through both the raw
API and the actual run-executor code path (not a bypass script). Found and
fixed four real bugs, all verified live afterward, not just typechecked:

- **The race condition below is now closed** (in-process only -- see its
  entry for what's still not covered). `executeBenchmarkRun` now guards
  itself with an in-memory `Set<runId>`: a second invocation for a runId
  already in flight logs a warning and returns immediately instead of
  re-scoring every cell. Reproduced the exact race on purpose after the fix
  (create a run, then immediately call `.../execute`, the same trap this
  file warned about) and confirmed the guard catches it -- one `ok` row per
  cell, one clean warning log line, not a double provider charge.
- **Every retry left permanently-broken cells' old `failed` rows behind
  instead of replacing them.** A run retried twice (chasing the
  storage-bucket issue below, which never resolves from retrying) had grown
  from 63 possible cells to 109 result rows. Root cause: the retry loop only
  ever *inserted*, it never cleared a stale attempt before writing a new
  one. Fixed by deleting all non-`"ok"` result rows for a run before
  re-attempting them -- safe because those rows are guaranteed to be
  re-attempted in the same pass, and `ON DELETE CASCADE` on
  `benchmark_scores.result_id` means a real score can never be orphaned by
  it (only `"ok"` rows have scores, and `"ok"` rows are never touched).
  Cleaned up the ~46 stale rows this had already produced live.
- **A run's `notes` field accumulated one line per retry forever**, instead
  of describing the current attempt. A run retried 3 times showed 4 near-
  identical "N cell(s) failed transiently..." lines. Fixed to write only the
  current pass's notes -- the full history is still in `audit_log`, which is
  where a retry history actually belongs, not a user-facing status field.
  **Side effect worth knowing:** the old accumulated notes made corpus
  health look worse than it is -- after cleanup, the real number is **5 of
  21 calls fail per provider (24%), not 15 (71%)** as the stale notes text
  implied; the "15" was inflated by counting the same handful of
  permanently-broken cells across multiple retries. All 5 genuine failures
  are the storage-bucket issue below, confirmed identical across all 3
  providers on every affected call (bucket-level, not provider-level).
- **A provider's live `configNote` (the one `GET /benchmark/providers`
  actually returns to the UI) named a specific person** -- seeded once into
  the DB by `ensureDefaultProviders()`'s `onConflictDoNothing()`, so fixing
  only the source code would not have fixed the already-seeded row. Fixed
  both the source default and the live DB row; verified the fix by
  re-fetching the real endpoint afterward, not just editing code.

Also fixed, smaller: the Runs page never auto-refreshed -- a run left
"running" needed a manual page reload to ever show as finished, since runs
execute fire-and-forget in the background with no progress signal otherwise.
Now polls the runs list every 3s while anything is `queued`/`running`, and
stops polling the moment nothing is.

Verified still solid under this fresh live traffic (no regression): the
word-diff view (including on Deepgram, exercised through the real pipeline
for the first time this pass -- previously only smoke-tested via a raw
script bypass), the null-vs-zero ranking fix, the de-id case-fold fix, the
Cartesia truncation-catch fix, and the rankings latest-run-per-vertical
filter (including that it correctly ignores a deleted run's orphaned
ranking row via its join, with no extra code needed).

**Not fixed, noted for later:** there is no delete/archive endpoint for a
run at all -- cleaning up a bad or test run currently means a direct DB
delete, which is fine for us during testing but not something to hand to a
non-technical stakeholder later.

## Found during the 2026-08-24 live end-to-end test (real Vapi key, real run)

Not deferred -- these two were fixed the same session (stale audioObjectPath
in the run executor; a "complete" run being permanently unretryable). Noted
here for what's still open:

- **No lock/idempotency guard on run execution.** ~~`POST /benchmark/runs`
  auto-fires execution in the background; a second call to `.../execute`
  (or a UI double-click) races it~~ -- **fixed 2026-08-25, in-process only,
  see the section above.** Still genuinely open: this guard is a single
  `Set` in one Node process's memory, so it does nothing across multiple
  server instances or a process restart mid-run. A real fix for that case
  still needs either a DB advisory lock, a compare-and-swap on entry, or an
  actual job queue (BullMQ, per `docs/execution-plan.md` Phase 2) -- not
  attempted here since a multi-instance deployment isn't this MVP's shape
  yet, and doing it properly is a genuine design decision, not a quick patch.
- **Vapi's presigned recording URL failure correlates with storage bucket,
  confirmed on a 21-call/63-cell sample.** Not transient/eventually-
  consistent (a smaller 5-call sample first suggested that; didn't hold up).
  Clean split: 47/48 cells against calls stored in the R2 `hipaa-recordings`
  bucket succeeded; 0/15 cells against calls stored in the older Supabase
  `archive` bucket failed, every one with an HTTP 403 "Forbidden" straight
  from `storage.supabase.co` -- Vapi is hand ing back a link for those that
  was never actually signed. Looks like a hard split by which storage
  backend Vapi originally wrote the recording to, not flakiness. Can't fix
  from this app; needs Vapi support or direct bucket access.
- **Cartesia: a second, more serious bug found on re-test (2026-08-24, later
  same day).** The idle-close fix above was real and necessary but not
  sufficient. Root cause of what's left: on a re-run of the 21-call set with
  that fix deployed, 14 of 15 Cartesia cells against calls longer than ~15s
  came back "ok" but severely truncated (e.g. a 105s call scored against
  only its first 5.2s; a 90s call against its first 4.9s) -- only one long
  call (93s) transcribed in full. That means the *previous* fix's own "ok"
  results were still silently corrupt: a badly truncated transcript was
  being scored as if it were real recognition error, which is exactly what
  made Cartesia look artificially far worse than the other two providers.
  Fixed what's fixable: the adapter now tracks whether "finalize" was
  actually sent before the socket closed; if it closes early, that's now
  reported as `"failed"` (retryable) instead of `"ok"` with a corrupted
  transcript -- stops the silent data corruption. The premature-close cause
  itself is still open: a standalone reproduction script against the exact
  same audio file, run manually right after, transcribed perfectly in one
  shot (11 segments, full 82s) -- so it isn't a deterministic code bug we
  can point at, and isn't reproducible on demand outside the real pipeline
  run. Current best guess is an intermittent Cartesia-server-side drop, not
  confirmed. Needs either sustained instrumented re-runs (more paid Cartesia
  calls) or a response from Cartesia support to actually root-cause; flagged
  to product rather than spending unlimited API budget chasing it
  unsupervised.

## Fixed 2026-08-24, second pass (all 4 flagged bugs)

- **Case-sensitive de-id approver comparison**: now case-folds both sides
  before comparing (`benchmark.ts` attest-deid route).
- **Label collisions in `vapiLabelFor()`**: root cause was worse than
  "bad luck" -- Vapi call ids are UUIDv7, whose first bytes are a
  millisecond timestamp, so truncating the raw id to 8 hex chars truncates
  the timestamp, not random bits, guaranteeing collisions between calls
  placed close together in time. Fixed by hashing the id first
  (`sha256(id).slice(0,8)`) so the truncated output is uniformly
  distributed again. Also backfilled `sourceCallId` on all 22 existing
  corpus rows (was NULL on every one -- they predate that column and were
  only ever matched by label, which is exactly the collision-prone path);
  recovered the real Vapi call id from the recording filename via the
  already-existing `guessVapiCallId()` regex, verified no two calls
  actually share a real id (22 total, 22 distinct `sourceCallId`s) before
  writing anything.
- **`GET /benchmark/rankings` returned every run's rankings stacked
  together.** `computeRankingsForRun` inserts a fresh snapshot per run and
  never deletes old ones, so a reviewer saw the same vertical/provider pair
  2+ times with different numbers, no way to tell which was current. Fixed:
  the route now keeps only the latest run per vertical (each vertical can
  have a different "latest run that scored it"), and the response now
  includes `runId` so the UI/reviewer can always tell which run a ranking
  row came from.
- **`alphanumericAccuracy` (and every other ranking metric) showed `0`
  instead of "not measured."** Root cause: `computeRankingsForRun` averaged
  the per-cell scores with `avg() ?? 0` at insert time -- when a metric had
  no data at all (e.g. no entity in the whole corpus is currently both
  letters and digits after normalization, so `alphanumericAccuracy` is
  always `null` per-cell), the aggregate got silently written as a real
  `0`, indistinguishable from "provider scored zero percent." Fixed at
  three layers: `benchmark_rankings` columns are now nullable (migration
  applied), the aggregation no longer coalesces to 0, and the `Score` API
  schema + both frontend pages (`Rankings.tsx`, `Runs.tsx`) now render `—`
  for a genuinely absent metric instead of a misleading `0.0%`. Confirmed
  live: `alphanumericAccuracy` now correctly reads `null` on every current
  ranking row (real state: the corpus has no true alphanumeric entity yet,
  not that providers are failing one).

- **Case-sensitive de-id approver comparison** (`benchmark.ts`, attest-deid
  route): `current.deIdAttestedByLabel === approver` is an exact string
  match. "Bob" then "bob" would count as two distinct approvers, weakening
  the two-distinct-person compliance gate. Cheap fix (case-fold both sides)
  whenever this file is next touched.
- **Label collisions in `vapiLabelFor()`**: truncates to `vapi-<first 8 hex
  chars>` of the Vapi call ID. Confirmed 3 real collisions in the 22-call
  corpus (`vapi-019fedaf`, `vapi-019fedc5`, `vapi-019ffbbc`, each shared by
  2 calls) -- SELECT label, count(*) ... HAVING count(*) > 1 against
  `benchmark_calls`. Not currently causing a correctness bug (calls are
  still keyed by real UUID `id` everywhere it matters), but the label is
  shown to reviewers as if it were unique, which it demonstrably isn't.
  Fix is widening the truncation length or hashing the full ID.

## Shipped this pass, not deferred

- **Word-level diff view.** The WER edit-distance calculation always
  computed a full word-by-word alignment internally and threw it away,
  keeping only counts. Exposed it (`diffWords()` in `lib/scoring`, stored on
  `benchmark_scores.detail.wordDiff`, rendered as an expandable row in the
  Runs page's per-cell results dialog) so a reviewer can see exactly which
  words a provider substituted, dropped, or added -- not just a WER number.
  Existing scores from before this change don't have it (no backfill run);
  it applies going forward.

## Deferred: confidence scores / distorted-audio flagging

Scoped 2026-08-24, not built. Confirmed directly against each provider's
*real* response (not just docs) what's actually available -- full samples
in `docs/provider-data-samples.md`.

| Provider | Confidence available? | Where |
|---|---|---|
| AssemblyAI | Yes | `confidence` (transcript-level) and `words[].confidence` (word-level), 0.0-1.0 |
| Deepgram | Yes | `results.channels[0].alternatives[0].confidence` (transcript) and `words[].confidence` (word); also a separate `words[].speaker_confidence` |
| Gladia | Yes | `result.transcription.utterances[].confidence` (per utterance) and `utterances[].words[].confidence` (per word) |
| Cartesia | **No** | Confirmed absent from real captured WS messages (`type`, `is_final`, `text`, `duration`, `words[]` with only `word`/`start`/`end` -- no confidence field). Also not in Cartesia's public docs. Real gap -- Cartesia can't participate in a confidence-based flag the same way the other 3 can. |

None of the 4 adapters currently extract this even though 3 of them return
it -- real follow-on work, not a quick patch:
- Add `confidence` (and, for Deepgram, `speakerConfidence`) extraction to
  the AssemblyAI/Deepgram/Gladia adapters, stored per word so it survives
  down to the `raw_output`/scoring layer.
- Decide a per-provider or unified representation -- word-level exists for
  all 3, but Gladia's "utterance" grouping doesn't map 1:1 to the other
  two's flat word list.
- Decide what "flag as distorted audio" means concretely: single low word
  vs. a *run* of consecutive low-confidence words (a much stronger signal
  of an actual audio problem, vs. one unusual name). AssemblyAI's own docs
  suggest 0.4-0.5 as a starting point for flagging a single word -- that's
  a documentation suggestion, not yet validated against our own calls.
  Cartesia's absence means whatever UI surfaces this needs an explicit
  "not available for this provider" state, not a fake 0.
- Decide where it surfaces (Review page flag? Results column?) and to
  whom.
- A short per-provider "how to configure the threshold" note, once the
  above is decided.

# Good to have (deferred past MVP)

Everything here came out of the 2026-08-24 research pass (Perplexity, ChatGPT,
Gemini-style deep report, DeepSeek architecture critique) plus the PRD gap
review. None of it blocks a first real benchmark run. Shipped now instead:
hiding live WER during transcript editing (anchoring risk) and capturing
Vapi's transcriber metadata on import (draft-provider bias detection) --
both in `Review.tsx` / `vapi.ts` / `benchmark-calls` schema.

Sequence this list once there's a real run to look at, not before.

## 1. Run-level reproducibility manifest (FR-E1 / FR-REP1 / FR-REP3)
Content-hash (sha256) audio, gold transcript version, provider config, and
raw provider output per run. Store a manifest hash on `benchmark_runs` so a
re-score months later can prove bit-identical results, and so a run can
detect "the gold transcript this pointed at has since changed." Requires:
immutable/versioned `goldTranscript` (new table or version column, not an
in-place update), a `run_manifest` concept, and separating "recompute from
stored raw output" (reproducible) from "re-call the provider" (a fresh run,
not a revalidation). Design already sketched in `docs/reproducibility.md`;
this is the actual implementation.

## 2. Metric stack beyond raw WER
- **Entity Error Rate (EER)**: score against the entity tags we already
  collect in Review, instead of only having them sit there unused. Perplexity
  research + the architecture critique both flag this as the metric that
  actually predicts downstream tool-call failures; raw WER treats "yep" vs
  "yes" the same as a wrong load number.
- **Semantic WER (LLM-as-judge)**: normalize disfluencies/contractions/number
  format, then have a model score meaning-preservation, not string match.
  Needs a small human-labeled calibration set to check judge-vs-human
  agreement before trusting it (Cohen's Kappa per the HF discussion cited in
  research).
- **cpWER for diarization**: better fit than strict DER given our reference
  transcripts aren't professionally diarized -- word-level permutation
  matching tolerates speaker-label noise that DER's time-boundary scoring
  doesn't.

## 3. Statistical significance on rankings (AC-FULL-5)
22 calls is a variance-estimation pilot, not a decision-grade sample. Before
anyone acts on "Provider A beats Provider B," need paired per-call bootstrap
or permutation testing (same calls, paired difference, not two independent
averages) -- or a mixed-effects model (`WER ~ provider + (1|call_id) +
(1|vertical)`). Also decide up front: mean vs. median vs. pooled WER as the
primary aggregate, before looking at results, not after.

## 4. Per-run decision export (FR-R3)
A structured JSON (or PDF) export of a completed run: per-vertical winner,
WER/EER/cost/latency side by side, confidence caveat given sample size. This
is the concrete shape of the "decision artifact for a non-technical
stakeholder" the research kept circling back to.

## 5. Review workspace polish
- Play-from-caret (click text, hear that moment) instead of only a global
  transport bar.
- Loop-selection / spot-audition for a flagged span (names, IDs).
- Variable playback speed.
- Utterance-level "verified" marks as the real progress signal, replacing
  "does the WER number look stable" as an implicit (bad) stopping cue.

## 6. Gold-transcript integrity, not just anchoring
- Blind transcription option: occasionally correct straight from audio with
  no seeded draft at all, as a periodic audit against the seeded workflow.
- Explicit written policy for disfluencies, number formatting, punctuation --
  applied identically to gold and provider output before scoring, so WER
  measures recognition, not formatting taste.
- Explicit policy for unintelligible-audio segments (how a `[inaudible]`
  marker is scored against a provider's guess).

## Explicitly not doing, at this team size (2-3 reviewers)
Workflow builder, consensus/duplicate-annotation engine, annotator leaderboards,
fine-grained RBAC, real-time collaborative editing, threaded comments/mentions,
configurable entity ontology builder. All sensible at Labelbox/Scale's scale,
pure overhead at ours -- flagged explicitly in the ChatGPT UX critique and
worth keeping as a standing "don't build this" list, not just an omission.

## Out of scope for this tool entirely
Live voice-agent latency budgets, TOPSIS-style composite provider scoring,
MLOps drift-detection triggers -- all real, all aimed at *production*
STT selection for a live agent. This tool does offline backtesting against
recorded calls, a different problem. Revisit only if the tool's job changes.
