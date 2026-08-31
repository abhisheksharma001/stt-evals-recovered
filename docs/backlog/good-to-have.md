## Found 2026-08-31 (batch 21): the last routes

- **Probed first this time, and nothing was dead.** Before writing a line of
  T-172..T-175, all eight remaining untested read routes were called against
  the live server: `calls/disagreement`, both manifests, `verdicts`,
  `verdict.html`, `bulk-templates`, `vapi/assistants`, `providers/models`,
  `agent-models` — all 200. The T-136 case (spans 500ing unnoticed for a whole
  batch cycle) is why that probe is now the first step, not the last.

- **The reproducibility promise is testable, and now tested.** A run manifest
  pins gold-transcript hashes and provider config hashes at run creation. The
  test corrects the gold transcript AND renames the call afterwards, re-reads
  the manifest through the route, and asserts nothing moved. That is the
  property that makes an old run's numbers explainable; nothing was watching it
  before.

- **`APP_SETTINGS_ID` was guessed as a uuid; it is the string `"default"`.**
  The audit assertions came back empty and the guess was found in one grep.
  Same class as batch 20's `notes` / `entityNotes`: vitest transpiles without
  typechecking, so a name written from memory survives to the first red run.
  The constant is exported from `@workspace/db` and is imported now.

- **Audit rows written by a ROUTE have no FK and were never cleaned.** The
  fixtures only tracked rows they inserted themselves. Fixtures gained
  `actor` (`fixture-<suffix>`), the write suite sends it as `x-actor`, and
  cleanup deletes by that label. Verified: zero `fixture-%` audit rows after a
  full run.

- **The older `riskiest-endpoints.int.test.ts` suite leaves its audit rows
  behind** — 102 rows with actor "unknown" (launch / execute / archive /
  unarchive) accumulated across runs. Harmless in a throwaway database and not
  fixed here, but it is why a global audit-row count is not zero after a clean
  run; only the `fixture-%` count is a meaningful leftover check.

- **What stays untested, and why.** `providers/models` and `agent-models` call
  vendor list APIs on every request (a live call does not belong in CI, and
  their only offline story is a network failure); `vapi/preview` and
  `vapi/import` need a live Vapi; run `execute`, bulk `launch`, `retry-failed`
  and `analyze-failure` spend real provider or judge money.

## Found 2026-08-31 (batch 20): the last reads

- Integration suite 52 → 69 (provider-correlation 3, volume/accounts 3,
  runs+results 4, scans+audit 3, small reads 4); green twice, zero
  leftover fixture rows (the new audit rows included). Proved by breaking:
  the runs-list purpose filter and the T-41 `?? known?.diagnosis` fallback
  each fail exactly one test when removed.
- **Two self-caught fake assertions worth remembering.** A duplicate
  insert swallowed by `.catch` "asserted" the failed-cell rule while
  seeding nothing (the cell-key constraint refused it) — an assertion that
  cannot fail proves nothing. And a /key/i leak regex on the accounts row
  would trip on the env var NAME (`VAPI_API_KEY…`) wherever a key IS
  configured — leak checks must target values, and the row shape has no
  field that could carry one.
- `benchmark_calls` has no `notes` column — it is `entityNotes`; vitest
  transpiles without typechecking, so a wrong field name in a builder
  override survives to the first red run. The repo typecheck catches it,
  but only when it runs.
- Reads still untested: `GET /benchmark/calls/disagreement`, the run/bulk
  manifest routes, and the live-external lists (vapi/assistants,
  transcriber, providers/models, agent-models — refusals only, offline).

## Found 2026-08-31 (batch 19): the aggregate reads, swept

- **Transcript-only span candidates build nothing.** `buildDisagreementSpans`
  refuses without at least one timed candidate (`no_word_timings` — the
  reference is the clock), and `extractProviderTimedWords` is vendor-keyed
  (T-110), so an adapterless `fx-…` provider id can never carry timings.
  Any test or tool that wants spans must seed a vendor-prefixed provider id
  (`deepgram-…`) with a vendor-shaped rawOutput. Zero spend stays structural:
  an adapter only fires inside run execution, which no read route touches.
- **The batch-7 canonical rule now has a route-level proof**: seeding
  "four" vs "4" alongside a real split produces exactly one watch word, not
  two (`words-to-watch.int.test.ts`).
- Integration suite 34 → 52 (words-to-watch 4, assistant-signals 4, bulks
  list 3, bulk detail 5, trend 2), green twice in a row, zero leftover
  fixture rows. Two behaviors proved by breaking: the T-35 latest-scan
  dedupe in the bulk detail handler and the null-peer-flag filter in
  `lib/trend.ts` — each removal fails exactly one test.
- Reads still without route tests: `GET /benchmark/volume` (live
  Vapi-backed; a test needs a Vapi-shaped fake or asserts only the
  no-key/unknown-label refusals) and
  `GET /benchmark/bulks/{id}/provider-correlation`.

## Found 2026-08-31 (batch 18): the reads the compile check cannot hold

- **`benchmark_agent_scans.run_id` is a plain, no-cascade FK — a scan blocks its
  run's delete.** The schema graph is a cycle: results cascade from runs but hold
  plain references to calls; scans cascade from calls but hold a plain reference
  to runs. Found when the comparison suite's first cleanup crashed on it. Any
  future delete/archival code touching runs must delete (or null out) the calls'
  scans first — the integration fixtures (`fixtures.ts` cleanup) now do exactly
  that, scans first by callId.
- **A crashed cleanup poisons global-latest assertions.** That crash stranded two
  `complete` runs in the test database, and the dashboard T-134 test — which had
  seeded its run pair 60s apart — failed on the stray that slipped between them.
  Rule the suites carry now: a test of a global "latest" seeds its rows 1s apart
  (files run serially; nothing else writes inside that second), and everything
  else asserts deltas or containment on its own suffix-tagged rows only.
- Integration suite 20 → 34 tests; the two T-134 behaviors (dashboard latest-run,
  rankings snapshot retirement) are each proved by removing the filter and
  watching exactly one test fail.


## Found 2026-08-31 (batch 17): the response edge, made compile-checked

Batch 14 wrote it down and left it open: "a hand-written response mapping is
untyped in the one direction that matters ... the rest are still exposed."
This batch closed it. All 58 success-response sites now go through
`respondJson(res, schema, value, status?)`, which types the payload as the
schema's own input type -- so the T-136 class of bug (a required field
missing from a hand-built mapping, discovered as a production 500 a day
later) is a `tsc` error now. Proved by re-creating the exact T-136 omission:
deleting `majorityText` fails typecheck with "Property 'majorityText' is
missing ... but required", and `respond.test.ts` holds that omission behind
`@ts-expect-error` so the guarantee weakening is itself a build failure.
`scripts/check-response-edge.mjs` (CI) keeps future handlers on the helper.

What the compiler surfaced once it could see the payloads -- none of it
changing a byte on the wire:

- **Four hand-written mirrors of the contract** were living in `lib/`:
  the CallComparison family (call-comparison.ts), OverviewBulkRef and
  MonthSpend (overview.ts), ClientVolume (volume.ts). Each was one schema
  edit away from being T-136. All four are projections of the generated
  schema now (`ZodInput<typeof GetCallComparisonResponse>` and friends);
  the only drift that had actually accumulated was `judge.createdAt`
  (string vs Date). **Rule: a lib type that describes a response is derived
  from the contract, never restated.** scoring's TrendBulk is the deliberate
  exception -- that package is shared with the UI and takes no api-zod
  dependency, so the trend route rehydrates its `at` at the boundary.
- **Dates travel as Date.** The generated schemas are `zod.coerce.date()`,
  and `res.json` writes a Date as exactly the ISO string `toISOString`
  produced -- so 13 hand-rolled `?.toISOString() ?? null` dances are gone.
  Two rehydration points remain where jsonb stored the ISO string (run
  manifests, bulk criteria), each commented.
- **zod 3 types a coerce schema's input as its output.** `coerce.date()`
  accepts an ISO string at runtime but claims to want `Date` -- the one
  place the compiler and the runtime disagree, and why the jsonb criteria
  carry a commented cast instead of a conversion.
- **Rankings' `runId` column is nullable; the data never is.** Verified
  live before casting: 0 of 378 snapshot rows null, and the all-time branch
  inner-joins runs on that id. The cast carries the provenance; a null
  would still be refused loudly by the parse.
- The analyze-failure response now answers with the values the handler just
  wrote (non-null by construction) instead of reading back the nullable
  columns it wrote them to.

**Lesson, next to batch 16's:** `res.json(Schema.parse(value))` looks
defended and is not -- parse takes `unknown`, so the check runs a day too
late. The compile-time half costs one helper and a mechanical sweep; the
schema was the source of truth all along, the code just never asked it.

## Found 2026-08-31 (batch 16): the same defect class, on the routes the fix could not reach

Batch 15 swept the read endpoints and fixed malformed ids at the spec edge.
This batch swept the write ones the same way, plus the two directions of
spec/router drift. Five more live failures, every one of them the server
blaming itself for the caller's mistake:

    GET   /benchmark/calls/not-a-uuid/audio          500
    POST  /benchmark/runs/not-a-uuid/archive         500
    PATCH /benchmark/settings {"judgeModel":123}     500
    POST  /benchmark/agent/scans                     404, as an HTML page
    POST  /benchmark/bulks {"label":"x"}             400, as zod's issue array

Four causes, all now fixed:

- **A spec-level fix only binds a handler that parses its params.** T-141
  added `format: uuid` to 30 parameters; two handlers read `req.params`
  directly and so never saw it (T-146). The audio one matters most -- it is
  what a reviewer's `<audio>` element points at, and it was not in the spec
  at all, so no validator for it could have existed.
- **A spec entry with no route is a contract that lies.**
  `POST /benchmark/agent/scans` outlived its route by four days (T-147); orval
  kept generating a client function for it, and calling it returned Express's
  HTML 404, which the client cannot parse. Both directions of that drift are
  now a CI check (T-148, `scripts/check-api-routes.mjs`) -- proved by breaking
  it each way, not by reading it.
- **Express answers an unmatched path in HTML.** T-76 gave thrown errors a
  JSON body; a request that reaches no handler at all never got one (T-149).
- **Zod strips unknown keys, so a typo can leave nothing to do.** The settings
  PATCH then handed drizzle an empty `.set({})` and it threw (T-151). A body
  that changes nothing is now a 400 that names the fields that exist.

And the one that was not a crash: every route answered a rejected request with
`zodError.message`, zod's own `JSON.stringify` of its issues, which the
generated client renders verbatim onto the screen. All 43 sites now answer a
sentence -- "criteria is required; providerIds is required" (T-150).

**Lesson, next to T-141's:** a fix applied at the spec edge reaches exactly
the handlers that read the spec. Grep for the raw accessor (`req.params`,
`req.query`, `req.body`) after any such fix -- the handlers that never
adopted the generated schema are precisely the ones no generated schema can
protect. And check both directions of drift, not just the one that broke.

**Process note:** `pnpm run typecheck` must run after the test files are
written, not only after the source. Vitest strips types instead of checking
them, so a test file that passes can still fail `tsc` -- it did here, and the
typecheck caught it before the PR.

## Found 2026-08-31 (batch 15, T-141/T-142): every id parameter was unchecked

The register was drained, so recon started by hitting all 23 GET endpoints on
the running production server with real ids -- and then with bad ones. Five
answers were `500 Internal server error` for what is plainly a caller's
mistake:

    GET /benchmark/calls/not-a-uuid                     500
    GET /benchmark/bulks/zzz                            500
    GET /benchmark/rankings?bulkId=zzz                  500
    GET /benchmark/disagreement-spans (no callId)       500
    GET /benchmark/disagreement-spans?callId=a&callId=b 500

Two separate mistakes underneath, both now fixed and both worth remembering:

- **Nothing checked an id's shape before the query.** Every id in the spec was
  a bare `type: string`, so a malformed one went straight into
  `where id = $1` against a uuid column and Postgres threw
  `invalid input syntax for type uuid`. Our log filled with what looked like
  our bug. Fixed by `format: uuid` on the 30 parameters backed by a uuid
  column (T-141) -- and deliberately not on the ones backed by text:
  `providerId` (`deepgram-nova-3`), `assistantId` (Vapi's own id),
  `accountLabel`, the audit log's `entityId`.
- **`zod.coerce.string()` says yes to nothing.** Coercion runs `String(value)`
  before any check, so a parameter that was never sent became the literal
  nine-character string `"undefined"` and passed `.min(1)`. `GET
  /benchmark/volume` with no label answered `404 No Vapi account configured
  with label "undefined"` -- an answer about a client that cannot exist. A
  repeated parameter arrives as an array and was joined into `"a,b"`.
  Coercion is now `number` only (T-142); `z.coerce.boolean()` would have been
  worse still, since `Boolean("false")` is true.

Not yet bitten in normal use -- the UI only ever sends ids it got from the API,
and the five 500s in the log are the probes that found this. It bites the first
time someone edits a URL, follows a stale link, or writes a script.

**General lesson, next to T-136's:** a generated validator is only as strict as
the spec it was generated from, and a permissive coercion is worse than none --
it converts "the caller sent nothing" into a value that passes every rule.
Sweeping every endpoint with a bad input takes ten minutes and is now the way
each batch's recon starts.

Adding the first `format:` to the spec also exposed that orval's zod output was
never pinned: its `auto` default inferred Zod 4 from a Zod 3.25 install and
emitted `zod.uuid()`, a v4-only form. It failed the build immediately because
the codegen script typechecks what it generates -- the good kind of failure.
Pinned to `version: 3`.

## Found 2026-08-31 (batch 14, T-136): the listening panel had been dead for a day

`GET /benchmark/disagreement-spans` answered **500 for every call** from the
T-86 route rewrite (batch 4, PR #52, 2026-08-30) until batch 14. The handler
builds its response by copying span fields one at a time, and that copy never
gained `majorityText` after T-47 made it required -- so the response failed
its own `ListDisagreementSpansResponse.parse()`, and Corpus showed "Couldn't
load disagreement spans for this call." for the whole day. Reproduced against
the running production server before touching anything.

Two lessons, both now acted on:

- **A hand-written response mapping is untyped in the one direction that
  matters.** `res.json(Schema.parse({...}))` type-checks the *input* against
  nothing: a missing field is a runtime failure only. Every such handler is
  one schema change away from this. T-139 covers the three newest with route
  tests; the rest are still exposed.
- **Nothing was watching.** The panel is deep inside an expanded call row, so
  a browser pass that does not open that exact section never sees it. The
  regression test now fails with "expected 500 to be 200" if the mapping loses
  a field again.

Found by accident, while reading the same route to add T-137's word starts --
not by any check we own. That is the honest provenance.

## Verified 2026-08-31 (batch 14, T-140): what the "retry could fix" 15 actually are

The Overview's "transcripts a retry could fix" has read 15 for days with no
way to tell what they were. Against the live DB: **all 15 are
`cartesia-ink-whisper` `provider_timeout` cells dated 2026-08-27** (the other
failed cells in stopped bulks -- 30 `retention_expired`, 15
`audio_url_forbidden` -- are permanent and correctly excluded). So the figure
was honest, just mute: those 15 can be retried, and retrying them re-calls a
paid provider. The number now carries its own breakdown (T-140).

Open, deliberately not fixed here (no drive-by scope): the page logs a React
"Select is changing from uncontrolled to controlled" warning. Pre-existing,
unrelated to batch 14's changes, harmless today -- but it is a real
controlled/uncontrolled mistake and will bite whoever next changes that picker.

**Corrected 2026-08-31 (batch 15, T-145).** The note above was wrong twice, and
wrong in the way worth remembering: it was written off a console buffer that
still held the *previous* page's logs, so it blamed the page that happened to
be open (Corpus, two filter Selects) rather than the page that emitted it. With
the console cleared before each load and each page loaded on its own: **Corpus
0 warnings, Results 1** -- the bulk picker in
`artifacts/stt-benchmark/src/pages/Rankings.tsx`, which passed
`value={selectedBulkId ?? undefined}`. Corpus's two filter Selects start at
`"all"` and were never uncontrolled. Fixed and measured 1 -> 0.
**Lesson: clear the console before you attribute a warning to a page.**

## Verified 2026-08-31 (batch 13, T-132): the refused calls, identified call-by-call

Closes the open identity question below. Against the live DB + cache dir:
the 5 uncached calls dated 2026-08-19 (vapi-1f63f6dc, -8bdde2b1, -98ae047b,
-b6268aa6, -ce529415) are **exactly** the 5 calls with historical
`audio_url_forbidden` (Supabase `archive`-bucket 403) failures -- the other
2 calls of that date are cached and have no forbidden history. The other 9
refusals are the 9 uncached null-date calls (14 null-date exist, 5 cached).
The "refused at day 12" anomaly therefore dissolves: those 5 were never
fetchable at any age; Vapi wraps the unsigned-bucket failure in its
retention message. T-131 persists `source_refused` per call so these 14
stop counting as saveable; its classifier cites this check as evidence.

## Found 2026-08-31 (batch 12, T-126): what the audio rescue could and could not save

First full rescue over the corpus (121 calls, 57 uncached): 43 saved, 0
expired-by-our-count, 14 refused by Vapi with HTTP 400 "Your subscription
plan only covers the last 14 days of call history". The 14: nine calls with
no `sourceStartedAt` at all (pre-labeling era, genuinely old), and the five
dated 2026-08-19 — refused at day 12, i.e. before day 14. Whether those five
are the same five calls as the known storage-bucket failure set was not
verified at the time; **batch 13 (T-132) verified it call-by-call -- they
are the same five, see the section above.**

Residue, deferred (not silently ignored): neither the rescue endpoint nor
import-time caching persists a per-call attempt outcome, so the Overview's
"audio not saved" figure and the "Save audio now (N)" button keep counting
the 14 calls Vapi has already refused. Follow-up when it matters: store the
last attempt outcome per call and split "never tried" from "Vapi refused",
so the figure can reach a true zero. **Done in batch 13 (T-131).**

## Mined 2026-08-31 (batch 13, T-133): what the equivalence rules still do not fold

The mining tool is committed now (`artifacts/api-server/src/mine-reading-pairs.ts` --
the batch-7 script was deleted before it was ever committed; the section below
kept asking for a re-run nothing could perform). Run against the live DB:
63 calls (latest batch run each), 738 spans, **1,060 distinct unfolded pairs**
-- every one a disagreement the current `canonicalTranscript()` does NOT fold,
because since T-101 spans are built on the canonical form.

Top of the list (count, reference ||| other):

```
 155  0 |||                       (Deepgram's inserted 0 -- known, real, stays)
  22  0 am ||| 0 a m              ┐
  16  am 0 ||| a m                │ "am"/"pm" vs letter-spaced "a m"/"p m":
  13  0 pm ||| 0 p m              │ ~80 span hits across variants -- the
  12  1 pm ||| 1 p m              │ strongest NEW fold candidate
   9  a m ||| am                  ┘
  11  apartment ||| apartments    (meaning-adjacent -- stays a disagreement)
   8  with villaroma ||| with villa roma   ┐ client-name spacing, 15 hits --
   7  the villaroma ||| the villa roma     ┘ fold candidate (a name, not meaning)
   7  hill's ||| hills            (possessive -- deliberately not folded)
   5  booked ||| book             (tense -- deliberately not folded)
```

Deliberately NOT folded here: folding "am ||| a m" or "villaroma ||| villa
roma" is an equivalence-rule change (`lib/scoring/src/equivalence.ts`) with
score-shifting consequences -- flag counts drop for whoever letter-spaces --
so it needs its own deliberate task, not a drive-by in the batch that built
the tool. Re-run after the next paid bulk; the command is in the script header.

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
(the script lived in src/_mine-pairs.ts -- deleted, never committed -- for one session) after the next few bulks to see what rises next.
**Batch 13 (T-133) recreated it as a committed tool and re-ran it -- see the
section above.**

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
- ~~Play-from-caret (click text, hear that moment) instead of only a global
  transport bar.~~ **Done 2026-08-31 (batch 14, T-137)** -- every word in the
  reading plays the call from itself.
- ~~Loop-selection / spot-audition for a flagged span (names, IDs).~~
  **Done 2026-08-31 (batch 14, T-138)** -- Loop toggle, `L` / `Esc`.
- ~~Variable playback speed.~~ **Done 2026-08-31 (batch 13, T-135).**
- Utterance-level "verified" marks as the real progress signal, replacing
  "does the WER number look stable" as an implicit (bad) stopping cue.

## 6. Gold-transcript integrity, not just anchoring
- Blind transcription option: occasionally correct straight from audio with
  no seeded draft at all, as a periodic audit against the seeded workflow.
- ~~Explicit written policy for disfluencies, number formatting, punctuation --
  applied identically to gold and provider output before scoring, so WER
  measures recognition, not formatting taste.~~ **Done 2026-08-31 (batch 15,
  T-144)** -- `docs/scoring-policy.md`, every rule read out of the code and
  then run to check it. Gold and provider output go through the same function
  in the same call, so formatting can never favour a provider.
- Explicit policy for unintelligible-audio segments (how a `[inaudible]`
  marker is scored against a provider's guess). **Still open, and now
  measured** (T-144): brackets are punctuation, so a `[inaudible]` in gold
  leaves the literal word `inaudible` in the reference and the provider takes
  a deletion for not saying it -- gold `the unit is [inaudible] four` vs a
  provider's `the unit is 4` scores WER 0.2. Until this is decided, reviewers
  are told in the policy doc not to type the marker at all.
- **Entity matching is a substring match** (T-144, measured): a provider that
  heard `44712` is credited with the entity `4471` -- `entityAccuracy` 1.0 on
  a transcript whose WER shows that very word wrong. Over-credits, never
  under-credits. Tightening it to a token-boundary match is a scoring change
  and shifts stored numbers, so it needs a version bump and Abhishek's go.
- **`normalizationVersion` is hard-coded `"v1"`** on every stored score
  (`lib/scoring/src/index.ts`) and never moved when normalization changed under
  `SCORING_VERSION` v2. Either maintain it or drop it; today it is decoration
  and `scoringVersion` is the field that means anything.

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
