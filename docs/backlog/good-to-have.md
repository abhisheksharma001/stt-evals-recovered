
## Found 2026-09-10 (R-42): the Vapi import route cannot be tested offline at all

`POST /benchmark/calls/import-vapi` calls Vapi directly, so nothing in the integration
suite drives it -- there is no test file for it. Three separate register entries land on
that route and none of their fixes can be covered: B-98 (the duration floor, fixed in R-42
with only its input contract pinned), B-33 (duplicate ids in one request) and B-77 (the
label-fallback duplicate check).

The shape that would fix it is the one `executeBenchmarkRun` already uses: an injected
seam. That function takes `opts.audioResolver` *"purely so tests/rehearsals can substitute
a deterministic resolver"*, and R-27 added `opts.connect` for the same reason. An
equivalent `opts.fetchCalls` on the import path would make all three testable without a
Vapi key and without spending anything.

Not urgent, and deliberately not done inside a bug fix: adding a seam to a route is a
change to that route's contract, and doing it as a side effect of fixing something else is
how a small PR stops being reviewable.

## Found 2026-09-10 (R-33): three runs have been stuck `running` for a day

Three `benchmark_runs` rows on the dev database have had status `running` since
2026-09-09T19:15:19Z. Nothing finishes them, nothing reports them, and the Overview's
"latest run" reads the newest non-archived row -- so the dashboard has been showing a run
in flight for a day.

This is the symptom `ox-alpha/bug-register-waves.md` predicts twice: a transient failure
after the spend, with no guarded catch to mark the run failed, leaves it `running`
forever. Finding them in the database makes it evidence rather than a claim.

Two things worth separating before anyone fixes it: (a) the rows that are already stuck
need a decision -- mark failed, or leave them as the record; (b) the executor needs a
guarded finalize so the next one does not join them. B-38 (`fetchAudioBytes` has no
timeout) is the most likely way in, since a hung fetch pins the worker slot, the provider
semaphore and the advisory lock until the process restarts.

## Found 2026-09-10 (R-32): B-13 -- a failed refetch throws away rows that are still good

`artifacts/stt-benchmark/src/pages/Corpus.tsx:441` renders the error row whenever `isError`
is true. react-query keeps `data` populated when a *background refetch* fails, so a
still-good list is discarded and replaced by an error over a transient blip.

The minimal fix is a trap: gating on `isError && !calls` keeps the rows and makes a failed
refresh completely silent -- a loud wrong behaviour traded for a quiet one. The honest fix
is rows plus a non-blocking "couldn't refresh" affordance, and that affordance is copy.

Queued for the `visual-and-research` pass together with R-28's Provider Name help text.
Not urgent: nothing is lost but the view, and the gold editor this entry originally worried
about is gone.

## Found 2026-09-10 (R-28): the Provider Name help text asks for something the API refuses

`artifacts/stt-benchmark/src/pages/Providers.tsx` tells the operator the Provider Name
field *"Must match a registered adapter id exactly (e.g. deepgram-nova-3,
elevenlabs-scribe)."* The route joins that name to the Model ID to form the provider id,
so following the instruction literally produced `deepgram-nova-3-nova-3-<hex>`. After
R-28 the API refuses it with a 400 that explains the shape, which is better than a dead
row but still means the field's own guidance is wrong.

What it should say is that the field takes the **vendor** (Deepgram, AssemblyAI,
ElevenLabs, OpenAI, Gladia, Speechmatics, Cartesia) and the model goes in Model ID.

Left for its own step because it is UI copy, and the standing rule is that
`visual-and-research` runs before UI copy and label work. Not urgent: the API now refuses
the bad shape loudly, so the worst outcome is a confusing error rather than a dead row.

## Found 2026-09-10 (R-25): `rawOutput` is double-encoded, and 24 rows do not parse

Measured while probing Cartesia results for B-21: of 186 `benchmark_provider_call_results`
rows for Cartesia, **178 store `rawOutput` as a JSON string inside the jsonb column**
rather than as an object, and **24 do not parse as JSON at all**. Anything reading that
column has to `JSON.parse` a value the schema types as an object, and a reader that does
not will silently see no fields — which is exactly what the first pass of the R-25 probe
did, and it reported "no events recorded" for every row before the shape was checked.

Worth: find the write site, store the object, and decide what to do about the 24. Not
urgent — nothing in the product reads this column today; the cost is paid by whoever
next tries to answer a question from it.

## Found 2026-09-09 (R-21): drizzle's `.set()` drops a key that is not a column, silently
R-21's break test mutated the route to spread `body.data` -- including the request-only
`confirmClearGold` flag -- straight into `db.update(...).set(...)`, expecting a failure.
All 170 integration tests passed. Probed it directly against `stt_evals_test` rather than
inferring: `.set({ label: "probe-updated", notAColumnAtAll: "xyz" })` throws nothing, and
`label` still updates. So a **typo'd column name in any `.set()` call in this repo is a
silent no-op** -- the write reports success, the field never moves, and no test that reads
the response can tell, because every response is built by a `serialize*` function from the
row rather than from what was sent. Nothing found by this, yet; the point is that nothing
would find it. A check worth having: a script that reads every `.set({...})` literal's keys
and asserts each one is a column on the table being updated. Not part of R-21 -- it is a
repo-wide scan, and R-21's own guard is proved by four other mutations.

## Found 2026-09-09 (U-1b): the page render tests never assert nothing went unstubbed
`stubApi` in artifacts/stt-benchmark/src/pages/__render__/harness.tsx builds an `unmatched`
list precisely so a page quietly depending on an endpoint nobody planned for shows up as a
failure -- and its own doc comment says "a page test should assert this stays empty". No
page test asserts it. Counted 2026-09-09: `unmatched` appears zero times in
`results.test.tsx`, and U-1b's new marks query 500'd behind all 34 of its assertions
without one of them noticing. One line in each page suite
(`expect(api.unmatched).toEqual([])`) closes it; the reason it is a backlog entry and not
part of U-1b is that turning it on will very likely fail several existing suites at once,
and each of those is its own question about what the page is really asking for.

## Found 2026-09-09 (writing Part U): nothing checks the register's own formatting
`docs/step-register.md` follows a convention every block obeys -- each `### ` block and
each `## Part` heading sits after a `---` with a blank line either side -- and the only
thing enforcing it is whoever is editing at the time. CI runs check-doc-paths over the
register (which does catch a backticked path that does not exist -- proved this session:
re-backticking one planned path printed one `MISSING` line and exited 1), but no check
looks at the structure. A one-screen scripts/check-register-shape.mjs would assert the
separator rule and that every `### ` block carries a `**Status:**` line; 82 blocks in,
the cost of finding a malformed one by eye is already higher than writing it.

## Found 2026-09-09 (R-20, measuring O-104 option b): this corpus argues for `numerals`, not keyterms
Mined the 110 calls that carry three or more `ok` transcripts for vocabulary the providers
actually split on. After folding conventions and near-variants, 155 tokens are disputed in
three or more calls, and the top of the list is `whatever` 28/28, `that` 19/67, `help`
17/104, `hello` 16/33 — ordinary English, where a boost changes nothing. What *is* disputed
on nearly every appearance is the spelled digits: `zero` 7/7, `three` 14/14, `four` 17/17,
`five` 12/12, `seven` 12/12, `eight` 10/10, `nine` 9/9. That is Deepgram's `numerals`
parameter, read live 2026-09-08 as unset on all 14 of the largest assistants — a free,
one-parameter experiment on the corpus we already have, and a better first move than the
keyterm plumbing M-19b is blocked on. Not stepped: `numerals` changes how every number in
every transcript is written, so it needs its own before/after, not a drive-by flag.
**Reproduce:** the script in R-20's register block. Free — local API only.

## Found 2026-09-09 (R-20): 68 of the 315 agent scans are archaeology, not a live fault
`GET /benchmark/agent/scans` returns 315 rows, 68 with `status: error`. **62 of the 68 are
one failure, all dated 2026-08-27**, and the message names `judge_cost_cents` — the integer
column T-01 replaced with `judge_cost_microcents` the next day. They are the wreckage T-01
already diagnosed and fixed, not a fault still happening. A further 169 flagged rows dated
2026-08-28 carry no judge verdict at all; the judged rows in the table begin 2026-09-04.
Recording it so the next person reading that error rate does not re-diagnose a closed bug —
and so nobody averages a cost or a coverage number across rows written under three
different pipelines.
**Reproduce:** `curl -s localhost:8177/api/benchmark/agent/scans`, group by `status`,
`errorMessage` prefix and `createdAt` date. Free.

## Found 2026-09-09 (R-19, triaging ox-alpha): the second bug file nobody has opened
`ox-alpha/bug-register-waves.md` holds **330** `[P0..P3]` findings and is cited by no
live doc at all — four times the file everyone has been calling "the bug register".
Memo O-100 said "80 unread entries"; measured, the pile is 80 in `bug-register.md` plus
330 here, so roughly **410**. Nothing is claimed about their quality: they have not been
read. Recording the count so the next estimate starts from the real number.

**Reproduce:** `grep -c "^\[P[0-3]\]" ox-alpha/bug-register-waves.md`, and the citation
scan in the R-19 register block.

## Found 2026-09-09 (R-19): three P1 bugs went moot because the code they name was deleted
B-9 (in-flight scan overwrites a human decision) died with `POST /agent/scans` when the
Agent page was folded into bulk. B-10's gold half died when approve stopped touching
`benchmark_calls` at all (`routes/agent.ts:153-156`). B-8's compliance impact died when
the two-approver de-ID gate was removed by decision (`routes/benchmark.ts:589-591`).

Kept here rather than crossed out, because in two of the three the **mechanism** outlived
the impact: B-8's blind `where(eq(id))` updates and locale `toLowerCase` are still on the
attest route, and B-10's approve/reject TOCTOU is still on the scan row. If either route
ever decides something again, the bug is waiting where it always was. **Mark a finding
moot by its mechanism, never by its blast radius** — the blast radius is the half that
changes when a product decision changes.

## Found 2026-09-09 (building R-17): a test fixture whose two counts were equal hid a wrong-variable bug for a day — FIXED same day (R-17)

R-14 shipped `needs 20 calls written out by a person; {data.n} exist`. The words name
`labelledCalls`; `n` is the subset of labelled calls that could be ranked two ways, and
the doc comment ten lines above that JSX already said so in as many words. The line
printed the right digit because the live corpus had `labelledCalls == n == 2`.

The render case could not have caught it: its fixture was `agreement(2, 2, …)`, so the
two variables were interchangeable and the assertion `toContain("2 exist")` tested one of
them twice. Reconstructing R-14's exact state as a break test — component printing `n`,
fixture equalised, no singular case — leaves the suite **157/157 green on the bug**.

Worth keeping as a rule: **a fixture that gives two different variables the same value is
testing one variable twice.** When a sentence names one count and the code could plausibly
read another, the fixture has to make them differ or the test proves nothing about which
one was read. Cheap to check: grep a test's stub arguments for repeated literals.

## Found 2026-09-09: `pnpm run build` has been red on main, and CI cannot see it — FIXED same day (R-15)

`artifacts/mockup-sandbox/vite.config.ts` still throws `PORT environment variable is
required but was not provided.` before it loads -- the Replit-shaped hard requirement
that `artifacts/stt-benchmark/vite.config.ts` softened to a `5173` default and never
got copied across. So the repo-root `pnpm run build` exits 1 on a clean checkout of
main.

CI does not build that package: `.github/workflows/ci.yml` runs `pnpm run typecheck`
then builds exactly two, `@workspace/stt-benchmark` and `@workspace/api-server` (lines
113 and 116). The green check is therefore telling the truth about what it ran and
nothing about the root script a person types.

Verified by stashing an unrelated change and building main untouched -- the failure is
pre-existing, not caused by the replit-config removal that found it. Two things worth
separating when this is stepped: giving mockup-sandbox the same optional-PORT default,
and deciding whether that package is still alive at all (nothing outside it references
it, and it carries its own copy of the Replit vite plugins).

**Fixed 2026-09-09 as R-15.** CI now runs `pnpm -r --if-present run build` instead of
naming two packages, and `mockup-sandbox`'s config takes `PORT` (default 5174) and
`BASE_PATH` (default `/`) optionally, with the invalid-`PORT` error kept. The second
question above is deliberately still open: measured while fixing this,
`artifacts/mockup-sandbox/src/.generated/mockup-components.ts` exports an **empty** module
map and there is no `src/components/mockups/` directory, so the package is a preview
harness with nothing to preview. Deleting it is 68 tracked files and a lockfile move, and
it is Abhishek's call.

## Found 2026-09-09: 80 of the 100 ox-alpha bug-register entries have never been read

Counted, not estimated: `ox-alpha/bug-register.md` holds 100 entries (P0x3, P1x19,
P2x27, P3x51). Grepping every tracked file outside `ox-alpha/` for `B-<n>` finds 20 of
them cited anywhere -- B-1, B-2, B-14, B-15, B-16, B-30, B-31, B-34, B-37, B-52, B-53,
B-54, B-81, B-82, B-88, B-89, B-91, B-92, B-96, B-100. The other **80 have never been
cited in a doc, a comment, a test, or the register.**

This is the measured version of what R-13 wrote down as a lesson ("a bug register
nobody reads is not a bug register" -- B-34 sat found-and-unfixed for two weeks). The
folder is not dead weight and must not be deleted: it is cited from live source
(`artifacts/api-server/src/lib/run-executor.ts`, `lib/db/src/index.ts`,
`artifacts/api-server/src/lib/vapi.ts`), from `docs/PRD.md`, and from
`.github/workflows/deploy-web.yml`. It is an unmined seam, and the harvest rate is 20%.

Sampling says the 80 are a mix, so triage is the step, not a fix: B-2 (Speechmatics
posting `fetch_url` instead of `fetch_data`) was already fixed on 2026-08-27; B-1
(unauthenticated API) is a documented accepted risk for a local single-operator tool
(PRD-v2 OD-11, resolved a third time as "no auth needed right now"); B-34 was a real
open bug that took two weeks to reach code.

## Removed 2026-09-09: the dead Replit platform config -- and what was deliberately left

The project moved off Replit on 2026-08-26 (web to Vercel, API to a long-running host;
`docs/PRD-v2-bulk-scale.md` R10 and `ox-alpha/deployment.md`). Deploy today is
`scripts/deploy-api.sh` on port 8177. Seven files describing the old platform were
still tracked and had **zero consumers** -- no workflow, script, doc or source
referenced any of them: `.replit`, `.replitignore`, `replit.md`, the three
`artifacts/*/.replit-artifact/artifact.toml`, and `post-merge.sh` (removed from `scripts/`; whose only
caller was `.replit`'s `[postMerge]` hook, and which `ox-alpha/bug-register-waves.md`
had already flagged twice as broken -- it filtered on `db`, a name no package has, so
it exited 0 without pushing anything).

`replit.md` was the one with teeth. It was an agent-instruction file outside
`check:doc-paths`' live-docs list, so its rot was never caught: it named port 5000 for
an API that listens on 8177, and its "User preferences" section still said *"Stop at
architecture and handoff documentation for this phase; do not autonomously build the
full Vapi/provider integration"* -- an instruction the whole project has since
disproved. Nothing unique died with it: the API-key rule lives in `.claude/CLAUDE.md`
and `.claude/REQUIREMENTS.md`, the MCP-is-not-runtime rule in
`docs/integration-strategy.md`, and every document it pointed at still exists.

**Left in place on purpose, each its own step later.** Items 2 and 3 were removed on
2026-09-09 as R-16, along with the `@replit/*` blanket entry in item 4's
`minimumReleaseAgeExclude`; item 1 was **kept on purpose** after reading its source (its
`apply()` is `serve`-only, it forwards `window.onerror` to the dev server's terminal, and
that works off Replit), and item 4's esbuild `overrides` block is still open because
proving a change to it needs a clean reinstall on two platforms. Original text follows.


1. `@replit/vite-plugin-runtime-error-modal` is imported unconditionally by both
   `artifacts/stt-benchmark/vite.config.ts` and
   `artifacts/mockup-sandbox/vite.config.ts`. It is a live, working dev overlay off
   Replit -- removing it is a behaviour change, not a cleanup.
2. `@replit/vite-plugin-cartographer` and `@replit/vite-plugin-dev-banner` are gated on
   `process.env.REPL_ID !== undefined`, so they are provably dead here -- but they sit
   in the same plugins array, the same `package.json` blocks and the same
   `pnpm-workspace.yaml` catalog as the live one, so all three should go together or
   not at all.
3. `@replit/connectors-sdk` in the root `package.json` has zero imports anywhere in the
   repo. Free to drop, but it moves `pnpm-lock.yaml`, so it belongs with the item above.
4. `pnpm-workspace.yaml` still carries Replit-shaped `overrides` that delete every
   non-linux esbuild binary ("replit uses linux-x64 only") and a
   `minimumReleaseAgeExclude` that trusts `@replit/*` and `stripe-replit-sync`. Builds
   pass on this darwin machine today, so this is wrong-headed rather than broken --
   and any change to it moves the lockfile.

## Decided 2026-09-09 (Abhishek, "no by hand thing"): no human gold transcripts, ever

PRD v7 C2 asked for 20 hand-written golds (~2 hours). The answer is no. Not a deferral --
the question is closed, and the labelled set is frozen at what is in the database today:
`64d8f463` (978 characters, real) and `3559ea45` (137 characters, the fragment O-76 is
about). Effectively **one** usable labelled call.

What that decides, rather than what it postpones:

1. **The tool measures disagreement, never accuracy.** No surface may say or imply
   otherwise. "Least disagreement" is honest; "most accurate" is not, and never becomes
   available.
2. **M-18 and M-20 are permanently dark.** Both shipped correctly and both sit under a
   floor of 20 that nothing will ever lift. Their below-floor wording ("...to measure
   this **yet**", "not measured (1 of 20)") reads as a progress bar over a frozen
   counter -- R-14.
3. **The judge's accuracy is unknown for the life of the project.** The one measurable
   pick on file is a disagreement: it chose openai at WER 0.436 when deepgram was at
   0.365. One call proves nothing; it is also all the evidence there will be.
4. **O-76 collapses to one branch.** "Finish or clear the fragment" -- finishing is by
   hand, so: clear it.

The one automatic substitute was put to him the same day and declined: pay a model that
listens to the audio (a multimodal pass, independent of the five text hypotheses being
compared) and use its output as the reference -- automatic, cost never measured, and
**not a gold**, a sixth opinion with better ears. Abhishek: **disagreement only,
permanently.**

Both roads to a reference are therefore closed, deliberately. This is the design now, not
a gap waiting to be filled: **a disagreement ranking with nothing to be accurate
against.** Written here so it is not rediscovered later as a new idea.

## Found 2026-09-09 (grilling the next step, after R-12): the disabled switch guarded one door out of four

`POST /benchmark/runs` refuses to create a run naming a provider whose status is not
`ready`. That is the whole of the enforcement, and it was being quoted -- by me, in R-12
and in M-11d's correction -- as "a disabled row cannot be streamed to at all". It could:

- `createBulkFromCriteria` (`artifacts/api-server/src/lib/bulks.ts`, the provider read
  near line 619) selects only `{ id }` and checks that the ids EXIST. Nothing reads
  `status` or `manuallyDisabled` anywhere in that 1,011-line module.
- `launchBulk` (same file) inserts each shard run with `status: "queued"` directly and
  hands it to `executeBenchmarkRun`.
- `POST /benchmark/runs/:runId/execute` re-enters the executor on an existing run and
  checks only that the run exists.
- `runCell` gates on the adapter, never on the row.
- The Bulks create dialog (`artifacts/stt-benchmark/src/pages/Bulks.tsx`, near line 483)
  renders a live checkbox for every provider, disabled ones included, with a grey
  `DISABLED` label beside the tick.

So "tick the row marked DISABLED, press Create, press Launch" transcribed with it, for
every call in the bulk. A `not_configured` provider survived that gap by accident and
not by a gate -- no key, so the adapter throws before the network -- but a disabled row
has its key present, which is the only reason `syncProviderReadiness` has to override it.
Both Deepgram socket rows are in exactly that state.

ox-alpha's 100-agent sweep found the narrow version of this on 2026-08-25 (B-34, "disabled
provider still transcribes via run re-execute", confidence medium-high) and named the same
fix; it sat unfixed for two weeks because nothing in the loop was reading that register.
Its line numbers are dead now; the finding was not.

**Fixed as R-13**, in `executeBenchmarkRun` rather than at any one door, because every
door leads there. The doors themselves are still open: the bulk create dialog still offers
the checkbox and `POST /benchmark/bulks` still accepts it, so the refusal is only visible
after launch, as failed cells. Refusing at create time with a named reason is the better
message and is its own step.

**Reproduce (after R-13, this is what you now get instead):**
`artifacts/api-server/src/routes/__integration__/run-executor-disabled.int.test.ts`.

## Found 2026-09-09 (building R-12): the money gate is proven for one status value, not the one that now guards a socket

`POST /benchmark/runs` refuses any run whose selected providers are not `status:
"ready"` -- and when nothing blocks, it fires `executeBenchmarkRun` immediately,
fire-and-forget, which is real provider money. That gate was the only thing standing
between "someone ticks `deepgram-nova-3-streaming` on the Runs page" and a live call to
a Deepgram socket this repo has never opened.

**Corrected 2026-09-09 (R-13):** "on the Runs page" is load-bearing in that sentence and
I did not know it when I wrote it. This gate never covered the Bulks page at all -- see
the entry above. Since R-13 the executor refuses a disabled provider itself, so this
coverage gap is now about a second gate rather than the only one.

`run-create.int.test.ts` proves the gate end-to-end -- blocked run, named reason, frozen
manifest, zero cells, executor never started -- but only for a provider that derives to
`not_configured` (its fixture ids match no adapter, deliberately: "Never seed a 'ready'
provider in this suite"). The status R-12 relies on is `disabled`, derived from
`manuallyDisabled` with an adapter AND a key present. It is the same branch --
`provider.status !== "ready"` is one expression -- so this is a coverage gap, not a bug.
But it is a second status value reaching a money gate, and the suite reads only the first.

Cheap fix: a second case in the same file with `manuallyDisabled: true` on a fixture
provider, asserting the same blocked shape. The safety note at the top of that file
already explains why the fixture must never be `ready`, and this case keeps that rule.

**Reproduce:** `artifacts/api-server/src/routes/__integration__/run-create.int.test.ts`,
first case; `artifacts/api-server/src/routes/benchmark.ts`, the `blockers` list and the
`if (blockers.length === 0)` branch below it.

## Found 2026-09-09 (building R-11): the sibling guard's test would pass without the guard's point

`parsers.test.ts`'s `deepgramStreamingAdapter socket wiring (M-11e)` case stubs
`globalThis.WebSocket` with a class that throws `new Error("stub refused the
connection")`, then asserts `result.errorMessage` does not contain the key. The stub's
message never contained the key, so that assertion holds whether or not the adapter
scrubs anything. What the test really proves is that the constructor throw is *caught*
(without the guard the promise rejects and `result.status` is never read) -- which is
worth proving, but is not what the assertion says it is.

R-11's Cartesia case throws the URL itself, so its identical assertion reads the guard
rather than the stub. Cheap to bring the Deepgram case up to the same standard: throw
`` `connect failed for ${url}` `` there too. Not done inside R-11 -- Deepgram's URL has
carried no key since M-11e, so the case is about a message-scrubbing rule rather than a
live secret, and it is a different adapter than the step names.

**Reproduce:** `parsers.test.ts`, the `ThrowingWebSocket` class in the M-11e block; delete
the `catch` in `deepgram-streaming.ts` and watch which assertion fails (the status one,
never the key one).

**Worth having:** one shared throwing-socket stub that always throws its own URL, used by
all three adapters' wiring tests, so "the message is a constant" is the thing under test
everywhere.

## Found 2026-09-09 (shipping M-17): a break test ran the thing it was proving must not run

The M-17 break test mutated `scripts/daily-import.sh` by deleting its `jq`
requirement, then ran the script with `PATH=/usr/bin:/bin` to see whether the guard was
the only thing that reported a missing `jq`. `jq` lives at `/usr/bin/jq`. So the guard
was gone AND `jq` was present: the script sailed past every check and executed the import
it was written to hold -- **200 calls into the dev corpus at 2026-09-09T06 UTC**,
`benchmark_calls` 176 -> 376, audio cache 1.9 GB. All 200 are `ready_to_run` with no
provider result rows, so nothing scored moved; they are eligible for any future bulk that
sweeps ready calls.

**The rule this breaks, stated so it is not relearned:** a break test removes a guard, so
it must be run somewhere the guard was the ONLY thing preventing the effect. Deleting a
`jq` check and then supplying `jq` proves nothing and executes everything. For a script
whose success path writes, the mutation has to be run against a sandbox -- a throwaway
database or a stub API -- or not at all. *A sandbox is every path the code under test can
reach, including its default arguments*: `STT_API` defaulted to the live API, and nothing
in the harness overrode it.

**Two gaps this exposed, neither fixed here:**
1. **No shell script in this repo has any automated coverage.** `deploy-api.sh`,
   `backup-db.sh` and `daily-import.sh` are all untested by CI, and the only way anyone
   has ever exercised them is by running them for real. A stub-API harness would let the
   import path be proved without writing; there is nowhere to put one today.
2. **`daily-import.sh` has no dry-run.** `--dry-run` was rejected while writing it as
   speculative, on the grounds that `/benchmark/vapi/preview` already is one. That is
   true for a person and false for a test: there is no way to exercise the script's own
   control flow to the edge of the import without crossing it.

**Also noticed while measuring the damage:** `lib/api-spec/openapi.yaml` summarises
`POST /benchmark/vapi/import` as importing calls "as needs_review". They land
`ready_to_run`, deliberately (`artifacts/api-server/src/routes/benchmark.ts` line 856
says why). The summary is stale, not the behaviour.

## Found 2026-09-09 (shipping R-6): one screen now counts differences two ways

R-6 hides conventions in the two diff *views*, and deliberately leaves `wordsDiffer`
alone -- WER is WER. The side-by-side header was moved with the view, so its column reads
"1 of 5 words differ - 3 conventions hidden". The **Rows** view above it was not: its
"Differ / ref" column still prints `wordsDiffer/referenceWords` straight off the wire, so
the same provider on the same call reads `4/5` in the table and "1 word differ ... 3 more
are the same words written differently, hidden." in the row you expand under it. Both
numbers are right and they add up, but nothing on screen says they are the same
measurement counted twice.

Not fixed here on purpose: the column is outside R-6's named files, and which number a
*table* should carry is a decision, not a bug -- the table is the closest thing this page
has to a ranking, and R-2 (blocked on Abhishek) is already the open question about
ranking on one quantity. Worth folding into R-2 rather than answering twice.

**Where:** the column is `artifacts/stt-benchmark/src/components/provider-comparison-section.tsx`
(the `Differ / ref` header and the `${diff.wordsDiffer}/${diff.referenceWords}` cell); the
expanded row is `WordDiffView`.

**Also, for the entry below:** `lib/scoring` has carried an import cycle the whole time --
`index.ts` re-exports `./equivalence` while `equivalence.ts` imports `normalizeTranscript`
from `./index`. Harmless (nothing is used at module top level) and R-6 added only a
type-only import to it, but it is a live example of what the guard cannot see.

**Corrected 2026-09-09, when the guard was finally pointed at it (O-88):** it was not one
cycle, it was **six**. `hybrid.ts`, `spans.ts` and `provider-correlation.ts` import
`diffWords` / `digitizeSpokenDigits` / `normalizeTranscript` back through the barrel too,
and `index.ts` re-exports all three. "Harmless" was the right read of the risk and the
wrong read of the size.

**And "harmless" for a narrower reason than first written here.** The first draft of this
correction said the cycle survived because every symbol pulled back through the barrel is
a hoisted `export function`. That is true but is not the load-bearing fact, and running it
showed why: a cycle only bites when a module **reads** a cycle-imported binding while that
binding's module is still evaluating. lib/scoring's siblings only ever *call* through the
barrel later, at runtime, by which point `index.ts` has finished -- so even a `const`
would have been fine there. What was one line away from breaking is a top-level read.
Reproduced on node with a three-file copy of the exact shape: the hoisted function
returns normally, `const RANKING_WEIGHTS` read at sibling module top level throws
`ReferenceError: Cannot access 'RANKING_WEIGHTS' before initialization`.

Fixed by moving the primitives out of the barrel into `lib/scoring/src/core.ts`;
`index.ts` is now barrel-only.

## Found 2026-09-09 (building M-19a): the import-cycle guard never looks at `lib/`

`scripts/check-import-cycles.mjs` takes its root as an argument and defaults to
`artifacts/api-server/src`, but both callers pass that path explicitly -- `package.json`
(`check:cycles`) and `.github/workflows/ci.yml` line 58. So `lib/scoring`,
`lib/stt-providers` and `lib/db` have never been cycle-checked, and they do import across
files: `deepgram-streaming.ts` already imports two helpers from `cartesia.ts`, and M-19a
added an import from `deepgram.ts` on top of it. Nothing is cyclic today -- `tsc --build`
would fail differently if it were -- but the guard that is supposed to notice is pointed
somewhere else.

**Reproduce:** `node scripts/check-import-cycles.mjs lib/stt-providers/src` runs and
passes; nothing in CI ever runs it.

**Worth having:** one more line in the workflow, or a loop over the four roots. Small, and
it earns its keep the first time a lib package grows a second cross-file helper.

**Done 2026-09-09.** The script now carries the four roots as its default and both callers
pass no path, so they cannot drift apart again. It earned its keep immediately, not on some
later refactor: `lib/scoring` had **six** cycles waiting the first time it was pointed
there. Correcting this entry's own words -- *"Nothing is cyclic today -- `tsc --build`
would fail differently if it were"* is **wrong**, and was the reason nobody looked. TypeScript
compiles circular ES modules without complaint; `pnpm run typecheck` was green across all
six. A type checker is not a cycle checker.

**Still not covered, deliberately -- and the first reason written here was the wrong one.**
The draft said `artifacts/stt-benchmark/src` is out because it is 87 `.tsx` to 14 `.ts` and
the walker matches `/\.ts$/`, so widening the filter was "its own step, once the UI's cycles
are counted". They have now been counted, and the filter is not the blocker: **the UI
imports through the `"@/*"` tsconfig alias, 202 alias specifiers to 1 relative one.** This
walker only follows relative specifiers. Widen the filter and it traverses one edge out of
203 across 101 files and prints `no import cycles among 101 files` -- a green pass that has
checked essentially nothing, which is precisely the failure this entry is about. The `.tsx`
widening alone would make it worse, not better, by making the lie look thorough. Resolving
`@/*` against `artifacts/stt-benchmark/tsconfig.json` `compilerOptions.paths` is the actual
step. (Both UI roots do come back clean under a filter-widened copy of the script -- but on
1 edge, so that result carries no weight and is not a reason to skip the alias work.)

`lib/api-zod` and `lib/api-client-react` stay out for a different reason: they are orval
output, so a cycle there is not a thing a person fixes by editing the file.

## Found 2026-09-09 (building R-4): "N calls scored" is printed twice, and means two things
Results prints the phrase in two places. The page-top bulk banner
(`artifacts/stt-benchmark/src/components/verdict-headline.tsx` near line 303) says
`{groups.length} group(s) - {totalCalls} call(s) scored`, where `totalCalls` is the SUM of
every group's `evidenceCalls` across the whole bulk. The org box (same file, near line
419) says `{verdict.evidenceCalls} call(s) scored` for that one org. On every bulk the
tool has ever run -- all of them hold exactly one org -- the two are the same number in
the same words, so the phrase reads as repetition. On a two-org bulk they would differ,
correctly, and a reader who learned the phrase from the one-org case would read the
banner's number as one org's.

Neither is wrong; R-4's acceptance ("the org banner carries the evidence count exactly
once") is met by the org box, and R-4's render test is scoped to it for that reason.
Left alone because the fix is a naming decision, not a bug fix: the bulk banner's number
wants a word that says *across the bulk* (`{n} calls scored in this bulk`), and choosing
it is copy work for whichever step next touches that banner.

Same family as R-3's finding, one rung down: **two places printing the same words for two
different sums must say which sum, even while the corpus makes them equal.** The corpus
is what will change first.

## Found 2026-09-09 (building R-3): two "per 100 words" numbers, one page, 6x apart
On bulk `42769f26` the org box printed *"production ... 6.6 of every 100 compared
words, against 2.6 for AssemblyAI, the closest candidate"* while the table under it
printed AssemblyAI at **0.40 disagreements / 100 words**. Same provider, same 17 calls,
same three words of unit -- and a factor of 6.5 between them. Nothing was wrong with
either figure: production's is raw mismatched words over the aligned CALLER words a
plurality existed at (`computeCrossProviderDisagreement`, caller turns only, production
non-voting); the table's is peer FLAGS -- a filtered subset -- over the whole call's word
basis (`callWordBasis`, R-1). The page just never said which was which.

It had been buried in a secondary line since M-8b. R-3 promotes that line to the FIRST
sentence a reader meets, which is what turned a quiet hazard into one that had to be
fixed before shipping: the loudest number on the page would have contradicted the table
directly beneath it. Fixed inside R-3 -- the shared `productionLead` sentence names the
units and carries the clause *"a word-by-word count on the caller's turns, not the
per-100-words flag count the ranking uses"*, and `docs/scoring-policy.md` now carries the
two-rate table.

**Worth keeping as a rule:** two numbers on one page that share a unit must either be the
same measurement or say, in their own words, that they are not. Same shape as R-2's rule
for two rankings; this is the same failure one level down, at the unit rather than the
order.

## Found 2026-09-08 (research for PRD v7): the honest bulk's winner is decided by filler words
On bulk `42769f26` -- the only bulk ever run on the customer channel, 17 calls × 5
providers -- the org verdict reads *"ElevenLabs has the least disagreement: 0.4 per 100
words, 4% fewer than AssemblyAI"*, decision `winner`, bootstrap interval
[0.0037, 0.0361], outside noise. Read per call: ElevenLabs and AssemblyAI carry
**identical peer flags on all 17 calls** (flagged on the same 4). ElevenLabs is named
because its transcripts total 1,047 words to AssemblyAI's 1,003, and the rate is
flags ÷ *the provider's own word count* (`artifacts/api-server/src/lib/verdict.ts`
near line 304; the T-19 rate in `artifacts/api-server/src/lib/run-executor.ts`).
Counted with a filler regex (um, uh, hmm, mm, mhm, uh-huh, yeah, okay, ok): ElevenLabs
**61** tokens, AssemblyAI **37**. The flags were computed on `canonicalTranscript`, which
folds those out; the denominator is `normalizeTranscript`, which keeps them in.

The bootstrap is right to say "outside noise" -- ElevenLabs is *consistently* wordier,
call after call -- which is exactly why a correct statistic on the wrong quantity is
worse than no statistic: it certifies the bias. The tool's own WER rule (`docs/PRD.md`
FR-S1) divides by the reference length for this reason. **Fix is R-1:** one denominator
per call, shared by every provider on it. The claim is corrected where it was made,
`docs/PRD-v4-technical.md` V4-T14 item 1.

**Reproduce:** `curl -s localhost:8177/api/benchmark/bulks/42769f26-4d4a-4be0-bf04-c7b69f6b4b8f/verdicts | jq '.groups[0].verdict.rates'`
then the per-cell `peer_flag_count` for the two providers on that bulk's runs.

## Found 2026-09-08 (research for PRD v7): the same page names two winners for the same 17 calls
On the same bulk the assistant cards rank on `flagBadness` (per-cell count + severity,
averaged, 85 %) with cost (15 %): every provider ties on flags in all 13 groups, the
recommendation says "Price decided this order, not accuracy" 13 times, and Cartesia is
rank 1 in 12 of 13. The org banner above the cards ranks on flags per 100 own words and
names ElevenLabs. Two quantities, one page, two winners, neither for accuracy. M-18's
proxy agreement compares the human-checked order against the *cards'* quantity, so
today it certifies the order the banner does not show. **Fix is R-2** (one quantity for
both, M-18 following it), blocked on Abhishek choosing the quantity -- PRD v7 open
question 1.

Worth keeping as a rule: **when two surfaces on one page rank the same things, they must
read one number, and any check that certifies "the ranking" must name which one.**

## Found 2026-09-08 (research for PRD v7): the boost-parity question has no subject on this corpus
PRD v6 Part F and M-19 were written from the Rush assistant's 120 keyterms. Read live
through `GET /benchmark/assistants/{id}/transcriber` on the 14 assistants with the most
calls (124 of 176): **0 keyterms on every one**, `numerals` unset on every one, 11 of 14
with a fallback transcriber. Production runs naked on the property-management corpus,
so `boosts: production` (M-19) would carry an empty list for 124 of 176 calls, and v5
E4's keep / add on top / replace has nothing to keep. M-19 is split: the parameter fix
(`keywords` → `keyterm` for nova-3, a real silent bug) ships as M-19a; the plumbing
waits for Tune mode to produce a list (M-19b). The good news inside it: Tune mode is
greenfield for the whole main client, and Deepgram documents `keyterm` on Flux
(`Configure` mid-stream), so the production model can take what Tune finds. **Corrected
2026-09-09:** the "up to 100 terms" this sentence carried is not in Deepgram's docs -- the
documented limit is 500 tokens per request. See M-19a.

**Reproduce:** the fourteen `assistantId`s from
`select source_assistant_id, count(*) from benchmark_calls group by 1 order by 2 desc limit 14`,
each through the transcriber endpoint; read `keytermCount` and `numerals`. Free -- Vapi
reads only.

## Found 2026-09-07 (grilling M-11c): the Flux provider row advertises diarization Deepgram does not offer

`artifacts/api-server/src/routes/benchmark.ts` seeds `deepgram-flux-general-en` with
`supportsDiarization: true`. Deepgram's Flux (v2 `/listen`) reference documents no
`diarize` parameter at all -- its query parameters are model, encoding, sample_rate,
eager_eot_threshold, eot_threshold, eot_timeout_ms, keyterm, language_hint,
profanity_filter, numerals, redact, mip_opt_out, tag. The row was seeded by copying the
nova-3 row's flags.

**Consequence:** the Providers page tells a reader this row can separate speakers, and
the M-11c adapter correctly reports a null diarization score for it -- so once the row is
enabled the screen and the score disagree, with no explanation on either.

**Not fixed in M-11c**, deliberately: the seed only applies on insert and the row already
exists in the database (`disabled`, `manually_disabled = t`), so editing the seed alone
would change nothing live. Fixing it properly means correcting the seed AND the existing
row, which belongs with M-11d, the step that touches `defaultProviders` and enables the
rows anyway.

**Reproduce:** `select id, supports_diarization from benchmark_providers where id =
'deepgram-flux-general-en';` returns `t`.

## Found 2026-09-07 (building M-11c): two Deepgram streaming adapters duplicate ~180 lines of socket machinery

`lib/stt-providers/src/adapters/deepgram-streaming.ts` and
lib/stt-providers/src/adapters/deepgram-flux.ts (plain: written in M-11c) carry the same
real-time chunking loop, connect timeout, response timeout, idle-close ladder and close
handler. Only the URL, the client message names and the message reduction differ.

**Why it was duplicated rather than shared:** at the time M-11c was built, neither
adapter had ever opened a socket against the live service. Extracting a shared runner
would have edited the v1 adapter too, so a failure in M-11d could no longer be attributed
to the authentication, the Flux mapping, or the refactor itself.

**When to do it:** after M-11d proves both adapters live. Then a shared runner has two
known-good callers to be measured against, and any behaviour change it causes shows up
as a difference from a recorded baseline instead of a mystery.

## Found 2026-09-07 (grilling M-11b): the Deepgram streaming adapter authenticates by a method Deepgram does not document

`lib/stt-providers/src/adapters/deepgram-streaming.ts` (shipped in M-11a, PR #110) puts
the raw API key in the socket URL as `token=<key>`, under a comment asserting that
"Deepgram documents the query parameter for Listen v1/v2 for exactly that case." It does
not. Read on 2026-09-07:

- The v1 `/listen` reference lists every query parameter the endpoint accepts --
  callback, callback_method, channels, detect_entities, diarize, diarize_model,
  dictation, encoding, endpointing, extra, interim_results, keyterm, keywords, language,
  mip_opt_out, model, multichannel, numerals, profanity_filter, punctuate, redact,
  replace, sample_rate, search, smart_format, tag, utterance_end_ms, vad_events,
  version. `token` is not among them; authentication is the `Authorization` header.
- The Flux v2 reference documents an `Authorization` header only.
- What Deepgram documents for a client that cannot set request headers is the
  subprotocol pair `Sec-WebSocket-Protocol: token, <API_KEY>`, for `/listen` and
  `/speak`. The only query-string credential that turns up anywhere is `access_token=`
  carrying a short-lived JWT from `/auth/grant` -- not a raw API key, and only in a
  community thread, not the reference.

Two consequences. The handshake may simply 401 on the first live call (M-11d), and a
live credential sits in a URL for no reason the vendor asked for -- which is the whole
reason M-11a had to guard the `new WebSocket` throw path against writing that URL into
`benchmark_provider_call_results.error_message`. Node 22's global `WebSocket` accepts a
protocols array, so the documented method was available all along.

**Reproduce:** the parameter list at developers.deepgram.com/reference/listen-live
against the `URLSearchParams` block in `deepgram-streaming.ts`.

**Fixed by:** M-11e. The claim is also corrected in the M-11a block of
`docs/step-register.md`, where it was made, rather than only here.

## Found 2026-09-07 (shipping M-11a): the Cartesia adapter streams faster than real time, and wrongly at any rate but 16 kHz

`lib/stt-providers/src/adapters/cartesia.ts` sends a hardcoded `CHUNK_BYTES = 6400`
every `SEND_INTERVAL_MS = 190`. 6400 bytes is 200 ms of 16 kHz 16-bit mono audio, so
even on the format it was written for the stream runs ~5% ahead of real time. On any
other format it is simply wrong: 8 kHz audio streams at 2x real time, 44.1 kHz at about
0.36x. A streamed provider's `latencyFinalMs` is roughly call length (M-10d), so a file
streamed at 2x reports roughly half the call length under a column labelled Speed.

M-11a's `deepgramStreamChunkBytes()` derives the size from the WAV header instead
(`sampleRate x bytesPerSample x 200 ms`, sent on a 200 ms interval) and is tested to
carry 200 ms at 8/16/24/44.1/48 kHz. Cartesia was deliberately not touched -- M-11a's
Must-not forbids it.

**Reproduce:** read the two constants at the top of `cartesia.ts` against
`parseWavPcm()`'s reported `sampleRate` for a non-16 kHz recording.

**Worth having:** the same derivation in `cartesia.ts`, and a check that no adapter
sends audio faster than the audio's own duration.

## Found 2026-09-07 (shipping M-11a): a thrown WebSocket error can put an API key in the database

Neither streaming adapter can send an `Authorization` header -- the global Node
`WebSocket` cannot set request headers -- so both carry the key in the URL:
`cartesia.ts` as `access_token`, M-11a's adapter as `token`. A throw out of
`new WebSocket(url)` propagates out of `transcribe()` into `run-executor.ts`'s
`if (!result)` branch, which writes `err.message` **verbatim** into
`benchmark_provider_call_results.error_message` -- a field that is persisted and
rendered. Any constructor message quoting the URL would put the key in the database and
on screen.

Likelihood is low: `URLSearchParams` builds a well-formed URL and undici delivers
connect failures through the `error` event rather than a throw. The rule it would break
is not: a key is never logged and never persisted.

M-11a wraps its own constructor and reports a constant. **`cartesia.ts` is still
unguarded.**

**Reproduce:** read `cartesia.ts`'s `const ws = new WebSocket(url)` against
`artifacts/api-server/src/lib/run-executor.ts`'s `if (!result)` branch.

**Worth having:** the same wrap in `cartesia.ts`, and a rule that no adapter's thrown
message is ever persisted unfiltered.

**Corrected 2026-09-09 by measuring it (R-11).** This entry was written by reading the
two files against each other; nobody had made the constructor throw. Run on node 22.22.2,
it does not leak and cannot: four throwing inputs (`ftp:` scheme, a URL fragment, a
malformed host, an empty string) all produce a `DOMException` whose message is a
**constant** -- `Expected a ws: or wss: protocol, got ftp:`, `Got fragment`,
`TypeError: Invalid URL` -- with no `cause`, `stack` as its only own property, and no key
in a full `JSON.stringify` over its own property names. The inner `TypeError` from
`new URL()` *does* carry the whole URL on `.input`, but undici stringifies it into the
message and drops the object, so nothing downstream can reach it. There has never been a
leak here, and the "worth having" was therefore not the fix it looked like.

The asymmetry it found is real, though, and is why R-11 shipped the wrap anyway: of the
three socket adapters, **`cartesia.ts` is the only one whose URL still carries a secret**
(M-11e moved Deepgram's onto the subprotocol) and it was the only one without the guard.
Both facts point the same way and both were backwards. What the guard buys is that the
safety no longer rests on an undocumented property of undici's error construction.

**Also corrected:** "Any constructor message quoting the URL would put the key in the
database" is the honest form and is what this entry says. The memo's O-48 said the message
"would carry `access_token`" flatly, as though it did. It does not. Fixed there too.

## Found 2026-09-07 (shipping M-11a): shared helpers live in one vendor's file and speak in its name

`parseWavPcm()` and `endOfAudioLatencyMs()` are exported from
`lib/stt-providers/src/adapters/cartesia.ts` and are entirely vendor-neutral -- one
reads a RIFF header, the other is the single definition of the M-10b measurement. M-11a
imports both rather than re-deriving them, which is right (two definitions of one
measurement is the M-10a failure). But `parseWavPcm()`'s errors are written in
Cartesia's name, so a Deepgram cell handed a stereo file fails with
"Cartesia adapter only supports mono WAV input, got 2 channel(s)" -- a message that
names an adapter that was never involved, stored in `error_message` and shown to a
reader.

**Worth having:** move both into a shared module (lib/stt-providers/src/audio.ts or
similar -- plain: does not exist yet) and make the messages name the format problem, not a vendor.

## Found 2026-09-08 (shipping M-18): one of the two human gold transcripts is a fragment, not a gold
`benchmark_calls.gold_transcript` on call `3559ea45` is **137 characters** -- two
lines -- while the hypotheses it is scored against are full call transcripts. That
is why its WER runs to **3.56**: 356% error is not a bad transcription, it is a
reference that is not a reference for that audio. The other gold (`64d8f463`, 978
characters) looks like real work; its WERs sit between 0.02 and 0.89.

M-18 deliberately did **not** invent a threshold to filter this. Any cutoff --
"drop the call when the best WER exceeds 1.0", say -- is a guess dressed as a rule,
and the best WER on this very call is 0.40, so that particular guess would not even
have caught it. The honest fix is upstream and it is Abhishek's call: either finish
the gold, or clear it so the call stops counting as labelled. Two of two labelled
calls is a small enough set that one bad one is half the evidence.

Until then the floor does the protecting: at `n = 2` nothing renders but a progress
line, so the fragment cannot reach a reader as a percentage.

## Found 2026-09-08 (shipping M-18): two sibling steps set different floors on the same set
M-18 said render the agreement figure whenever `n > 0`. M-20, four rows below it,
sets a floor of **20 labelled calls** before rendering the judge's accuracy -- on
the same labelled set, on the same page. Both were written in the same sitting.
Shipping M-18 as written would have put "agreed 50% of the time" and "not measured
(2 of 20)" side by side, both true, both about the same two calls.

Adopted M-20's floor, and added a line to M-20 saying the floor is now shared so the
next person does not re-derive it. **The general shape: when two steps touch one
surface, the second one written is where the contradiction hides, and neither step's
own text will mention it.** Grilling a step against its own neighbours catches this;
grilling it against the code does not.

## Found 2026-09-08 (shipping M-18): the S-1 trap again -- a break test threw away an uncommitted fix
The break-test harness restores each mutated file with `git checkout -- <path>`,
which restores the **committed** file. M-18 was committed before the break test, as
the rule requires. Then the self-review found a copy bug, it was fixed **without
committing**, and the break test was re-run to check the four UI mutations against
the new copy. The first mutation's restore silently reverted the fix; the third
mutation then reported `SKIP -- anchor matched 0 times`, which is the only reason it
was noticed at all.

The rule as written ("commit first, then prove it by breaking it") reads as a
one-time gate. It is not: **it holds for every re-run.** Anything the break test can
restore must be committed before the break test runs again, not just before it runs
the first time. Nothing was lost -- the fix was reapplied from the same script -- but
the failure mode is silent unless a later anchor happens to miss.

## Found 2026-09-07 (shipping M-11a): `providersConfigured` lists things that cannot be run

`GET /api/healthz` now reports `deepgram-nova-3-streaming` in `providersConfigured`,
because that field lists registry adapters whose API key env var is set. There is no
`benchmark_providers` row for it, so no run can select it and nothing on any screen
offers it. The field reads like "providers you can run" and means "adapters with a key".

Names only, so nothing sensitive is exposed -- but a health endpoint that overstates
what is available is a claim the system makes about itself that is not quite true, which
is the class of thing M-10c had to fix on the rankings page.

**Reproduce:** `curl -s localhost:8177/api/healthz` against
`select id from benchmark_providers where id like 'deepgram%'`.

## Found 2026-09-07 (shipping M-11a): both Deepgram adapters send `keywords`, which nova-3 does not use

`deepgram.ts` and M-11a's `deepgram-streaming.ts` both forward `input.keywordBoosts` as
repeated `keywords` parameters. Deepgram's keyword boosting for nova-3 is `keyterm`;
`keywords` belongs to nova-2 and earlier. So any keyword boost sent to a nova-3 row would
have had no effect, silently -- and the benchmark's "keyword boosting" column on
`benchmark_providers` says `true` for it.

**Corrected and fixed 2026-09-09 (M-19a, PR #121).** This entry used to read "every
keyword boost the tool has ever sent to a nova-3 row has had no effect". None was ever
sent: `run-executor.ts` passes `callId`, `audioBytes`, `diarize`, `model` and
`audioDurationSeconds`, and has never set `keywordBoosts` on any adapter. The bug was
real and latent, not live -- no transcript this tool has produced was affected. Both
adapters now pick the parameter from the model through one shared helper.

M-11a mirrored the batch adapter deliberately, so that the two nova-3 rows differ only
in how the audio arrives. Fixing one without the other would make the comparison a
comparison of settings.

**Reproduce:** the `params.append("keywords", term)` loop in both adapters, against
Deepgram's nova-3 parameter reference.

**Worth having:** this is the concrete half of the register's F2 (the Deepgram
keyterm-cap test, blocked on Abhishek). F2 asks how many keyterms nova-3 accepts; this
says the parameter is not being sent at all.

## Found 2026-09-07 (shipping M-10f): a step's Files list pointed at the wrong file, and nothing could catch it

M-10f's register entry said to change `artifacts/api-server/src/routes/benchmark.ts`
"near `latencyFinalMs: score.latencyFinalMs`". That line exists. It is also the wrong
one -- it serialises `ScoreDetail` for the run-results endpoint, which no comparison
view reads. The per-call comparison is built in
`artifacts/api-server/src/lib/call-comparison.ts`, whose corresponding line reads
`latencyFinalMs: score?.latencyFinalMs ?? null`.

Nothing in the toolchain distinguishes them. Typecheck passes whichever you edit; the
four guards pass; CI passes. Both files are plausible on a grep for the field name. The
only check that works is following the route handler to the function that builds the
response body.

**Reproduce:** `grep -rn "latencyFinalMs" artifacts/api-server/src` returns hits in two
files that look interchangeable and are not.

**Worth having:** when a step names a serialisation site, it should name the *endpoint*
(`GET /benchmark/calls/:callId/comparison`) as well as the file, so the file can be
checked against something. `check:api-routes` already walks routes; it could plausibly
be extended to map each response schema to the single function that constructs it.

---

## Found 2026-09-07 (shipping M-10f): a break test that never applied its mutation reports as a pass

Break G edited a TSX template literal (`` `${Math.round(x)}ms` ``) from inside a shell
heredoc. The backticks were mangled, the script's `assert s.count(old) == 1` fired, and
**nothing was written to the file**. The test suite then ran against unmodified code and
printed `Tests 128 passed (128)`.

Read quickly, that is indistinguishable from a break test whose guard held -- which is
the opposite of what a break test means. The traceback sat above it in the same output
and was easy to scroll past.

This is the second consecutive step where the break *harness*, not the code, was the
defective part (M-10e: an assertion satisfied by a phrase's second occurrence).

**Worth having:** a break run should print a diff (or a byte count) proving the mutation
landed before its test result is allowed to mean anything. "Nothing changed, tests pass"
must never render the same as "guard removed, tests pass".

---

## Found 2026-09-07 (shipping M-10f): ComparisonRow now has two nulls that mean different things

`latencyEndOfAudioMs` is null on a `"missing"` row (the run promised that provider and
no cell was ever written -- nothing ran) and null on a scored batch cell (it ran fine;
a batch API is handed a finished file, so there was no moment the audio ended).

Today the UI cannot confuse them, because a non-`ok` row renders `""` rather than a dash.
That is incidental, not designed: any change making the missing row show a dash would put
two unrelated facts under one glyph. The integration test asserts each null separately
with its own reason, which is the only thing currently holding them apart.

Related to the open item from M-10e about a permanent null and a this-run null looking
identical -- this is a third kind.

---

## Found 2026-09-07 (shipping M-10f): the comparison table's explanations are hover-only

Every column on `provider-comparison-section.tsx` explains itself through a `title=`
attribute. That means: invisible until hover, unavailable on touch, and not reachable by
keyboard. The end-of-audio column added by M-10f leans on that copy harder than its
neighbours do -- its dash is meaningless without the sentence.

The evidence gathered for M-10f (Toggl Track, Webflow, Uxcel, Squarespace plan-comparison
tables) all put a **visible `ⓘ`** next to the column label instead, precisely so the
explanation announces that it exists.

**Worth having:** a small info affordance on the labels of the columns that carry real
explanation (Differ / ref, Speed, After audio ends). Not urgent, not this step's scope.

---

## Found 2026-09-07 (shipping M-10e): a break test caught a bug in the test, not the code

M-10e added a Results legend guard asserting the new column appears in the
"Lower is better ... (↓)" list. Break-tested by removing the column from that
list -- and **the test passed**. The legend names the column twice: once in the
direction list, once in the sentence explaining why it compares when Speed does
not. `expect(legend.textContent).toMatch(/wait after audio ends/i)` was
satisfied by the second mention alone.

Asserting that a string is *present* is the wrong shape whenever that string has
more than one role in the same block of text -- the assertion has to be scoped to
the clause that makes the claim (`/Lower is better[^↓]*\(↓\)/` here). This is
the second time in three steps that a presence-count assertion has been wrong in
this exact way; M-10d's "expect 0 occurrences" was the same mistake pointing the
other direction.

Fixed in `d55ef9a` and re-broken to confirm it now fails. The general lesson is
worth applying to the other legend/tooltip guards, which have not been re-checked
under this lens.

## Found 2026-09-07 (shipping M-10e): `supportsStreaming` answers a different question than it looks like

`benchmark_providers.supports_streaming` is `true` on **10 of the 11 rows** (every
provider except `openai-gpt-4o-transcribe`). It records that the **vendor's API**
offers a streaming mode, not that our adapter uses one -- only
`lib/stt-providers/src/adapters/cartesia.ts` opens a WebSocket; every other
adapter posts a file.

This matters now that a column exists whose empty cell means "this provider is a
batch adapter": the obvious way to explain that dash per-provider is to read
`supportsStreaming`, and it would produce the wrong explanation for 5 of the 6
batch providers. M-10e therefore explains the dash generically and names no
provider.

There is no column that answers "does our adapter stream this provider". Adding
one is not urgent (there is exactly one streaming adapter today), but the flag
that looks like it should not be trusted for it, and the field name invites
exactly that mistake.

## Found 2026-09-07 (shipping M-10e): the ranking order comparator is guarded by one test

Break test F replaced `providerAggregates.sort((a, b) => (b.composite ?? -1) -
(a.composite ?? -1))` in `aggregateRankingRows` with a sort on the new latency
field. Across the whole integration suite that broke **one** test -- the one
written in the same step.

The composite decides every rank the product shows, and a change to how it
orders is caught almost nowhere. Most ranking tests assert the contents of a row
rather than which row came first, or use fixtures where the orders coincide.
Worth a small set of tests that pin the order itself against deliberately
conflicting signals (cleanest-but-dearest, cheapest-but-flaggiest, tied).

## Found 2026-09-07 (shipping M-10e): a permanent null and a this-run null look identical

Every "—" in the Results table means "not measured on this run; a later run may
fill it in". The end-of-audio column's dash means something else: a batch adapter
is handed a finished file, so there is no moment the audio ended, and the cell is
empty **forever**. Same glyph, different promise, and sorting by the column puts
six of them under one number where they read as six providers losing a race they
never entered.

M-10e handles it by making that cell's title say so, but the table now has two
kinds of dash distinguished only by hover text. If a third arrives, the pattern
needs a real treatment (a distinct glyph, or a "not applicable" style) rather
than a third bespoke tooltip.

## Found 2026-09-07 (shipping M-10d): "expect 0 occurrences" is the wrong shape for a copy fix

M-10d's Verify line said to grep the built bundle for "Lower is better" and **expect 0**.
Ten occurrences in the shipped bundle are correct: disagreements, unsure words, flags and
cost really are lower-is-better. Only the ones attached to `latencyFinalMs` were false.

An acceptance written as a count of a phrase pressures the executor into deleting true
statements to go green, and it is not a hypothetical: stripping every "Lower is better."
from the component **satisfies the step as written**, and was run as a break test -- it
fails only because a separate test guards the true copy.

The check that replaced it asserts three things instead of one: the false forms are
absent, the new honest wording is present, and the total count of the phrase is **greater
than zero**. Any future copy step that names a phrase should assert what the phrase is
attached to, never how many times it appears.

## Found 2026-09-07 (shipping M-10d): a page-wide sweep cannot see a page with no render test

`artifacts/stt-benchmark/src/pages/__render__/` holds render tests for Bulks, Calls,
Overview, Results and Setup. There is **no Corpus render test**, and there was none for
the component it renders -- so M-10a's page-wide `[title]` sweep, built precisely to stop
this class of miss, could never have reached the copy M-10d fixed.

Two gaps, both worth generalising:

1. The sweep read `[title]` only. The surviving claim was in an `aria-label` on the sort
   arrow and in visible legend text.
2. Two of the app's pages (Corpus, and the `/review` Listen page) have no render test at
   all, so no page-level guard covers them.

Worth a step: a render test per page, or a build-output check that scans the whole bundle
for a direction claim attached to a metric name, which would cover pages nobody has
written a test for yet.

## Found 2026-09-07 (shipping M-10c): a provider with no price ranks as if it were free

`hybridCompositeScore` (`lib/scoring/src/hybrid.ts:490`) scores a null `costPerMinute` as
`costComponent = 1` -- the *best possible* value, identical to a provider that costs
nothing. So a provider whose price we have never recorded outranks one whose price we
know, on a term worth 0.15 of the composite. Not reachable on today's corpus (0 of 355
ranking rows have a null `cost_per_minute`), which is why it has never been seen, but a
newly added provider before its first priced cell is exactly that state.

The same line already treats `maxCostPerMinute <= 0` as `1` for everyone, which is
correct -- that is "nothing costs anything", not "this one is unknown". The two cases
need separating.

M-10c's *sentence* deliberately does not mirror this: it calls an unknown price unknown
and reports the order as arbitrary. So the text and the ordering now disagree on purpose,
and the ordering is the one that is wrong. Not fixed there because M-10c is forbidden
from changing ordering.

Reproduce:

    select count(*) from benchmark_rankings where cost_per_minute is null;  -- 0 today

## Found 2026-09-07 (shipping M-10c): a text fix cannot reach the rows already written

`benchmark_rankings.recommendation` is stored, and rows are written only by
`computeRankingsForBulk` / `computeRankingsForRun` -- both of which run at the end of an
execution. There is no recompute route. So M-10c corrected the generator and **63 rows
still read "fewest/least-severe" after deploy**, verified against the live DB. The
Results page shows the old sentence until somebody spends money re-running a bulk.

This is a shape, not a one-off: any step that fixes generated-and-stored text is
invisible until the generator runs again. Either such steps say so at registration time,
or the project needs a recompute-from-stored-scores route (no provider calls, reads
`benchmark_scores` which is already there). The second is worth its own step -- it would
also let M-10a's weight change apply to the 33 tied groups, where rank 1 is currently
`deepgram-nova-3` on a composite that no longer exists.

## Found 2026-09-07 (shipping M-10c): fresh sighting of the S-8 integration flake

One run of the api-server integration suite failed on:

    FAIL src/routes/__integration__/run-create.int.test.ts
      > POST /api/benchmark/runs > blocks on unconfigured providers, ...
    AssertionError: expected {} to have property 'length'
      at src/routes/__integration__/run-create.int.test.ts:59:24
        expect(audit.body).toHaveLength(1);

`GET /api/benchmark/audit-log` returned an object where the test expects an array. The
identical commit passed 126/126 immediately before and immediately after, so it is
nondeterministic, and the assertion is on the audit-log read rather than on the run
creation. Adds a concrete line number and a concrete symptom to **S-8** (`blocked`), which
until now had no reproducer. Still must not be silenced with a retry, a timeout or
`.skip`.

## Found 2026-09-07 (shipping M-10b): a step named an anchor that measures our own timer

M-10b said to store the derived `end-of-audio -> final` figure. `finalAt` is stamped
when the Cartesia socket settles, which is *after* the adapter's own
`IDLE_CLOSE_MS = 2000` wait. Measured across the 207 live Cartesia score rows, the gap
between end-of-audio and `finalAt` is p25 2,580 ms / median 2,983 ms / p75 3,358 ms --
clustered around our 2-second timer, not around anything Cartesia did. Built as written,
the new column would have read ~3,000 ms for a vendor tail of roughly 600-1,400 ms.

Reproduce:

    select round(percentile_cont(0.5) within group (order by
             s.latency_final_ms - c.duration_seconds*1000*0.95))
    from benchmark_scores s
    join benchmark_provider_call_results r on r.id = s.result_id
    join benchmark_calls c on c.id = r.call_id
    where r.provider_id = 'cartesia-ink-whisper' and s.latency_final_ms is not null;

Fixed in M-10b by anchoring on the last final transcript segment that carried text.
The general lesson, which is not specific to latency: reviewing a step for *whether its
claims are true* is not enough. A claim can be true and still produce a number that does
not mean what its name promises. Ask what the number would come out as, then check that
against data, before writing it down.

## Found 2026-09-07 (shipping M-10b): M-11 planned to give `latencyFinalMs` a third meaning

M-11 (Deepgram streaming rows) said "`latencyFinalMs` is measured from the moment the
last audio chunk was sent (end of speech), not from the first", and its acceptance
required "a `latencyFinalMs` under 2,000 ms". That would have put two different
definitions of one column inside one sorted table -- exactly the defect M-10a had to
remove from the ranking composite, reintroduced two steps later by a step written before
M-10a existed. Its `Depends on` also named `M-10 (mode)`, a step that no longer exists.

Corrected in the register where the claim was made, not patched elsewhere. Worth noting
as a pattern: **splitting or retiring a step does not update the steps that depend on
it.** After M-10 became M-10a/b/c, nothing swept the register for references to M-10.
A cheap guard would be a check that every `Depends on:` names a step id that exists.

## Found 2026-09-07 (shipping M-10b): 11% of live Cartesia rows are truncated streams

Of the 207 Cartesia score rows, 23 have a `latency_final_ms` shorter than the audio they
were given -- the premature-server-close shape `cartesia.ts` already documents from
2026-08-24. They are recorded as scored cells. The adapter fails loudly on a close before
`finalize` is sent, so these are presumably closes *after* finalize with a short
transcript, but that has not been confirmed. Worth a look: if a truncated transcript is
being scored as recognition error, it penalises Cartesia for a network event.

## Found 2026-09-07 (shipping M-10b): the 207 existing Cartesia rows can never be backfilled

`rawOutput` stores `events.map((e) => e.message)` -- the messages without their
`receivedAtMs`. Every timing anchor except `firstPartialAt` and `finalAt` is therefore
gone for every Cartesia cell ever run. Nothing derived from message arrival times can be
computed retroactively. Consider storing arrival timestamps alongside the messages.

## Found 2026-09-06 (shipping M-10a): a guard scoped to an element cannot see the page

M-10a took latency out of the ranking composite and corrected the two table-header
tooltips that named it. It missed a third site, and the loudest one: every group card on
Results carries **visible text** reading

> Ranked by **disagreements, price, speed**

plus a title, "Rank = disagreements, then price and speed." For one deploy the page
contradicted itself out loud.

Everything in the loop was green while it was wrong: typecheck 4/4, four guards, 403 unit
tests, 123 integration tests, both CI checks. The render guard asserted on
`getAllByRole("columnheader")` and this line is in the card header, so it could not see
it. **The only thing that caught it was the post-deploy grep of the built bundle** —
`grep -ro 'price and speed' artifacts/stt-benchmark/dist/public` came back `1`, not `0`.

Two rules out of it:

1. A copy guard should sweep, not point. The replacement asserts over **every** `[title]`
   in the document and **every** element whose text starts with `Ranked by`, so it catches
   the site nobody thought to name. It still allows a tooltip to mention speed in order to
   disclaim it — it bans the ranking-basis phrasings, not the word.
2. The post-deploy bundle grep is load-bearing, not ceremony. It has now caught something
   the entire test suite could not.

This is also the seventh time a step's Files list has undercounted its own blast radius
(M-8a, M-9, M-9b, S-9, and now M-10a twice over) — and the first time in a step written
in the same session as the grill meant to prevent it. The pattern is not "inherited steps
are sloppy". It is that a Files list is written from what you searched for, and you cannot
search for the phrasing you did not imagine.

## Found 2026-09-06 (verifying M-10a): Corpus shows the same incomparable Speed number

`artifacts/stt-benchmark/src/pages/Corpus.tsx` has its own per-call Speed column, titled
"Time to the final transcript. Lower is better." It is the same `latencyFinalMs` M-10a
just stopped ranking on: file turnaround for the six batch adapters, and the length of
the call for Cartesia, which our adapter streams at real time. "Lower is better" is
therefore misleading on a Cartesia row in exactly the way Results was.

Not fixed as a drive-by. Assigned to **M-10b**, the step that makes the number mean
something, because a wording fix that lands before the measurement would have to be
written twice.

> **Corrected 2026-09-07 while shipping M-10d.** `Corpus.tsx` does **not** have its own
> Speed column -- it has no `Speed` and no `latencyFinal` reference at all. The column and
> its tooltip are in `artifacts/stt-benchmark/src/components/provider-comparison-section.tsx`,
> which Corpus is the only page to import. `Corpus.tsx` line 373 *does* contain the phrase
> "Lower is better", on **disagreements**, where it is true -- so this entry sent a reader
> to a file whose only match was a correct one. Two further false claims were live and
> unrecorded: `Rankings.tsx`'s `DIRECTION.latencyFinalMs = "↓"` (aria-label "lower is
> better", in the same cell as M-10a's disclaiming tooltip) and the page legend "Lower is
> better for disagreements, flags, **speed** and price". All three fixed in M-10d.

## Found 2026-09-06 (grilling M-10): rank 1 claims it had the fewest flags when every provider tied

`run-executor.ts:1409` writes rank 1's stored recommendation as:

> Leading candidate for this assistant's calls -- fewest/least-severe hybrid flags among
> ready providers.

Read off the live DB the same day: of the **62** assistant groups in `benchmark_rankings`
with a `bulk_id`, **33 have every provider tied** on flag badness (`avg_peer_flag_count +
avg_peer_flag_severity_score` identical across all five). Nobody had the fewest. The
sentence is false on 53 % of the groups on screen, and it is the sentence a reader is
most likely to quote.

> **Corrected 2026-09-07 while shipping M-10c.** The 53 % above is wrong -- it measures
> the wrong predicate. "Every provider tied" is not what the sentence claims; the
> sentence claims rank 1 beat *everyone*, so the test is whether rank 1 tied with
> *anyone*. Re-measured: rank 1 had strictly the fewest flags in **1 of 62** groups. In
> 26 it tied for fewest with some of the others, in 33 with all of them, and in **2 it
> had more flags than the provider directly below it** (deepgram-nova-3 at 4.5 above
> cartesia-ink-whisper at 4.0, which is also half the price). The sentence was false on
> **61 of 62 groups -- 98 %, not 53 %.** The undercount came from reusing this entry's
> `count(distinct flag_badness) = 1` query as the definition of the bug instead of as
> one symptom of it.

In those 33 groups the flag term cancels out of the composite, so the ordering came from
latency and cost. Rank 1 is `deepgram-nova-3` in all 33 -- not the cheapest ($0.0043
against Cartesia's $0.0022), so it won on batch file-turnaround time.

Reproduce:

```sql
with g as (
  select bulk_id, assistant_id,
         count(distinct (coalesce(avg_peer_flag_count,0)+coalesce(avg_peer_flag_severity_score,0))) db
  from benchmark_rankings where bulk_id is not null group by bulk_id, assistant_id)
select count(*) groups, count(*) filter (where db = 1) flags_all_tied from g;
```

Queued as **M-10c**, after M-10a (which changes how often the tie decides the order, so
fixing the sentence first would need re-verifying anyway).

## Found 2026-09-06 (grilling M-10): the number that orders every ranking table had no test

`hybridCompositeScore` (`lib/scoring/src/hybrid.ts`) produces `composite`, and
`run-executor.ts:1350` sorts every ranking group by it. `lib/scoring/src/hybrid.test.ts`
has 136 passing tests and **not one of them calls it** -- the single mention of the word
`composite` in that file is a comment about a different function.

Its weights could have been changed to anything, in either direction, and the whole suite
would have stayed green. The three signals that feed it are each well covered; the
function that turns them into the rank a person reads is not. Covered from M-10a onward.
Worth checking for the same shape elsewhere: a well-tested set of inputs feeding an
untested combiner.

## Found 2026-09-06 (grilling M-10): `supportsStreaming` reads like a mode and is not one

`benchmark_providers.supports_streaming` is `true` on **10 of the 11 live rows** --
everything except OpenAI. It records that the *vendor* offers a streaming API, not that
*this tool* streams to it, and in this tool exactly one adapter streams (Cartesia, over a
WebSocket; every other adapter posts a file). The fact is already written down in prose at
`lib/stt-providers/src/types.ts:57` and nowhere in a field.

Anything reaching for a "is this row streaming" flag will find `supportsStreaming`, get
`true` for ten rows, and be wrong about nine of them. If that distinction is ever needed
it belongs on `ProviderAdapter` (code, resolved through `getProviderAdapter()`), not on
the row: a DB column is operator-editable and can disagree with what the adapter actually
does, with nothing to catch it. M-10a was rewritten to avoid needing it at all.

## Found 2026-09-06 (shipping S-9): `| tee` swallows the exit status, so a failed suite reads as success

```
pnpm --filter @workspace/api-server run test:integration 2>&1 | tee "$LOG" >/dev/null; echo "exit=$?"
→ exit=0
```

The suite had failed: `1 failed | 122 passed (123)`. `$?` after a pipeline is the exit
status of its **last** command, and the last command is `tee`, which succeeded at
writing the file. The failure was found only by reading the log, which is why the
standing rule exists — but the printed `exit=0` was actively misleading while doing it.

This is the twin of the M-9b finding one entry above. There, a wrong `--filter` ran
nothing and returned 0; here, a real run failed and returned 0. Two different ways for
the same command shape to report success it did not earn.

Fix in every future Verify block and every ad-hoc run: `set -o pipefail` before the
pipeline, **and** grep the counts out of the log rather than trusting any exit code.
The count is falsifiable; the exit code has now lied twice in two steps.

## Found 2026-09-06 (shipping S-9): the integration flake has a third class — a hard timeout

First run of the S-9 suite: `run-create.int.test.ts > POST /api/benchmark/runs >
"refuses a run with no calls or no providers"` failed with
`Test timed out in 30000ms` after **30010ms**. The immediate re-run passed the same
test in **103ms**, whole suite 123/123, and a second full run was green too.

This is a new failure class for the flake tracked in F-49. The two known classes were a
status assertion getting a different status, and `Error: socket hang up` — both are the
response coming back wrong or not at all. This one is the request never completing
inside 30s on a route that answers in ~100ms when it works, on a test that posts an
empty body and expects a 400. Three classes now, one cause still unknown.

Evidence kept: the tee'd log of the failing run, with the passing re-run beside it.

Not fixed here, and deliberately not silenced: no retry, no raised `testTimeout`, no
`.skip`. Belongs to **S-8** (O-27), which is the step that owns the flake. What S-9 adds
to that step is that the fix must explain a 30-second hang, not only a wrong status —
any theory that only accounts for leftover rows or assertion timing is now incomplete.

## Found 2026-09-06 (shipping M-9b): a wrong pnpm filter exits 0, and the suite silently never runs

`TEST_DATABASE_URL=... pnpm --filter @stt/api-server run test:integration` printed
`No projects matched the filters in "/Users/abhisheksharma/gh-projects/stt-evals-recovered"`
and returned **exit 0**. The package is `@workspace/api-server`; `@stt/api-server` is a
name this project never used. Nothing ran, and every automated read of that command --
`&& next-step`, a CI step, an agent checking `$?` -- would have called it a pass.

Caught only because the standing rule is to `tee` the run into a file and read the file.
That rule was written for a different reason (a short `tail` hiding a failure); this is
the second thing it catches, and the stronger one: a `tail` of an empty run shows the
"No projects matched" line, but an exit-code check shows success.

Worth a guard: a wrapper that fails when a filtered pnpm run reports zero matched
projects. Until then, every step's Verify block should carry the **expected test count**
next to the command -- "27 files, 122 tests" is falsifiable, "it passed" is not.

## Found 2026-09-06 (grilling M-9b): the undercount is a class, not an accident — and a `Must not` can make a step's own acceptance unreachable

Third time in three steps. M-8a named the wrong file. M-9 named two of five render
sites. M-9b said "eight places"; a case-sensitive scan of every package found **22
rendered strings**.

What makes M-9b worse than M-9 is where the miss was. The most-rendered "wins" in the
whole product is built in `lib/scoring/src/verdict.ts` (~line 348) as the verdict
`sentence`, and printed in three places —
`artifacts/stt-benchmark/src/components/verdict-headline.tsx` twice and
`artifacts/api-server/src/lib/verdict-artefact.ts` once — before reaching
`artifacts/stt-benchmark/src/pages/Dashboard.tsx`, which renders it at 2xl as the
Overview headline. The step's Files list did not name that file at all. Its **`Must
not` did**, as "touch `decision: "winner"` in `lib/scoring/src/verdict.ts`".

So a weaker model executing the step faithfully reads the only mention of that file as a
prohibition, skips it, and ships a PR whose acceptance ("no rendered string contains
'winner' or 'wins'") is false on the largest text on the Overview — while every guard
passes, because guards check that named paths exist, never that unnamed ones were
missed. **A `Must not` that names a file without naming a line is read as "leave the
file alone."** Both M-9b's Files list and its `Must not` have been rewritten to say
which line is code and which line is copy.

The M-9 entry below says this one "probably can be a script". It can, and the scan that
found all 22 is the script: walk `artifacts/*/src` and `lib/*/src` for `.ts`/`.tsx`,
regex the rendered phrase case-insensitively, and compare the file set found against the
file set the step names. It caught the scoring lib in one run. Worth wiring into
`check:doc-paths` as a second mode — *the paths named exist* is only half the check;
*the paths that match are named* is the half that keeps failing.

## Found 2026-09-06 (grilling M-9): a step's Files list can be right about every path it names and still be missing most of them

M-8b's step named a real component at the wrong data grain. M-9's step named real
components at the right grain — but only **two of five**. It named the chip in
`Rankings.tsx` and the label in `verdict-artefact.ts`, and missed
`verdict-headline.tsx`'s `DECISION_META.winner.label` (the verdict chip itself, the
biggest "Winner" on the page), that file's legend paragraph, and both of `Landing.tsx`'s
(a static example captioned "what a client sees").

Every path it named exists, so `check:doc-paths` passes. Every symbol it named exists,
so a symbol resolver would pass. The acceptance sentence — "the word Winner SHALL NOT
appear anywhere in the rendered output" — would have been **false on the page the step
is about**, and nothing in the step would have said so.

Reproduce, before writing any code:

```
grep -rn "Winner" artifacts/stt-benchmark/src artifacts/api-server/src lib | grep -v test
```

Five render sites, one integration assertion, four comments. Twenty seconds.

**And the Verify was red on arrival.**
`artifacts/api-server/src/routes/__integration__/riskiest-endpoints.int.test.ts:185`
asserted `expect(html.text).toContain("Winner")` on the artefact HTML. M-9's Verify
listed the two unit suites and a grep — never the integration suite. A weaker model
executing the step faithfully would have opened a red PR with no instruction pointing at
the cause.

**The rule that comes out of it, for every future step that changes rendered copy:**
grep the literal string across every package *before* trusting the Files list, and put
the integration suite in Verify, because the artefact is asserted end-to-end there. This
one probably *can* be a script: a step whose Change quotes a string in double quotes
could have that string grepped, and the count compared to the number of files in its
Files list. Unlike M-8b's grain error, this one is countable.

---

## Found 2026-09-06 (running M-9's Verify): an integration test that passes or fails depending on what runs beside it

The full integration suite failed once with:

```
FAIL src/routes/__integration__/provider-correlation.int.test.ts
  > with no third provider there is no baseline, so excess is null, not a number
AssertionError: expected 404 to be 200
  at provider-correlation.int.test.ts:68
```

The next run, on the identical tree with no changes, passed **122/122**. The 404 means
the bulk the test seeded was already gone when the request ran — another file's cleanup,
or parallel workers sharing one `TEST_DATABASE_URL`.

It is unrelated to M-9 (which changes only copy), and it is dangerous for exactly that
reason: a flake in the suite that gates every PR teaches everyone to re-run instead of
read. Queued as S-8, with an explicit "must not" against silencing it with a retry, a
timeout bump or `.skip`.

---

## Found 2026-09-06 (grilling M-8b): a step can name a real component at the wrong data grain, and nothing catches it

**Not queued — logged as a class of problem, not a defect to fix.** The sharper
version of the entry below. M-8b's Files list sent the implementer to
`ProductionBaselineNote` in `artifacts/stt-benchmark/src/pages/Rankings.tsx`. The
path exists, the component exists, and it really is the page's production line —
so `scripts/check-doc-paths.sh` passes and so would any check that resolved the
symbol. It was still the wrong place: that component renders once per
**assistant**, and `productionDisagreement` is a property of the verdict
**group**, which is an **org**.

How it was caught: reading the live payload instead of the page.
`GET /benchmark/bulks/340400b2-42a0-41bc-a5a8-154f5dff8072/verdicts` returns one
group, `Land And Apartment`, carrying **22 assistant ids**. Following the step
would have printed one org-level number 22 times on a single page, each copy
reading as that assistant's own — and `Rankings.tsx` already carries a comment
saying the verdict sits at org level "once -- not repeated under every
assistant" (T-55/T-88), which the step contradicted.

Reproduce: `curl -s localhost:8177/api/benchmark/bulks/<id>/verdicts | python3 -c
"import sys,json;[print(g['clientLabel'], len(g['assistantIds'])) for g in
json.load(sys.stdin)['groups']]"`.

**The check that would catch it does not exist and probably cannot be a script:**
a grain error is a mismatch between where data lives and where a component
renders, which no path or symbol resolver can see. The cheap human version is
the one that worked — before writing a line, ask what the payload's grain is and
count it on real data. Written down here so the next step's grill starts with
that question.

## Found 2026-09-06 (grilling M-8): a step's Files list can name the wrong file and every guard still passes

**Not queued — logged as a class of problem, not a defect to fix.** M-8's Files
list sent the implementer to
`artifacts/api-server/src/lib/run-executor.ts` for `computeHybridFlagsForRun`.
That function lives in `artifacts/api-server/src/lib/hybrid-flagging.ts`;
run-executor only calls it. `scripts/check-doc-paths.sh` passed, correctly — the
backticked path exists. What is wrong is the CLAIM about what is inside it, and
no guard checks claims.

Same shape as M-8's "Today" sentence, which named the wrong reason
`vsProductionPct` is null (it said Flux has no cells; in fact
`resolveProductionProviderId` is only handed the providers that RAN, so Flux is
never even searched). Both were caught by reading the code before writing any,
which is what the standard's grill step is for — but a weaker model following
the step alone would have opened the wrong file and believed the wrong cause.

Reproduce: `git show 4ff1e18:docs/step-register.md`, read M-8's Files list, then
`git grep -n "export async function computeHybridFlagsForRun"`.

Worth considering, not proposed: a check that a backticked `path.ts` (`symbol`)
pair in the register actually resolves. Cheap to write, and it would have caught
this one. Not written — it is speculative until a second instance shows up.

## Found 2026-09-06 (shipping M-6e): the test suite writes fixture files into the LIVE audio cache directory

**Not queued yet — logged, not fixed.** Three test files compute their cache
directory the same way the server does, from `process.cwd()`, which under vitest
is the api-server package root — so it is not a copy of the cache directory,
it IS the cache directory holding 456 real caller recordings:

- `artifacts/api-server/src/lib/audio-cache.test.ts`
- `artifacts/api-server/src/routes/__integration__/calls-list.int.test.ts`
- `artifacts/api-server/src/routes/__integration__/customer-channel.int.test.ts`

What they write is dummy (`"mono-bytes"`, `"customer-bytes"`, `"RIFF"`) under
uuids no corpus call uses, and each deletes its own files in `afterAll`, so
nothing real has ever been exposed and nothing real is ever overwritten. Two
things are still true and neither is nice:

1. **They write with no `mode`**, so each fixture file is born 0644 — measured
   directly: a plain `printf > file` in that directory produces `-rw-r--r--`.
   Since M-6e the directory is 0700, so a 0644 file inside it is no longer
   reachable by another local user; before M-6e it was, for the length of a
   test run. This is why M-6d's sweep kept finding 456 files at 0600 despite
   many test runs: the fixtures are deleted before anyone counts.
2. **`afterAll` only runs on a clean exit.** A killed or crashed run leaves
   `00000000-0000-4000-8000-…` files sitting in the cache directory, and
   `listCachedCallIds()` matches anything of the shape `<uuid>.audio` — so the
   orphans would be counted as cached calls. They join to no call row, so
   nothing renders wrong today; the count is simply not the truth.

**How to reproduce:** `cd artifacts/api-server && npx vitest run
src/lib/audio-cache.test.ts` and `ls artifacts/api-server/audio-cache | grep
'^00000000'` while it is mid-run.

**The general shape:** a module-level constant derived from `process.cwd()` has
no test seam at all — vitest runs from the same cwd as the server, so "the test
directory" and "the production directory" are the same string. `ensureAudioCacheDir(dir)`
(M-6e) took the first parameter of this kind; the fix here is the same move
applied to the paths, or a `CACHE_DIR` override read once from the environment.

---

## Found 2026-09-06 (shipping M-6d): the audio cache directory is world-listable

**Fixed by M-6e** (2026-09-06, PR #97): the directory is `drwx------`. Was: M-6d brought all 456 files under
`artifacts/api-server/audio-cache/` to 0600 -- measured after the sweep, the mode
histogram is `456 -rw-------` with nothing else in it. The directory holding them is
still `drwxr-xr-x`.

So the contents are safe and the index is not. No other local user can read a byte of
caller audio, but any of them can `ls` that directory and come away with 456 call ids
and the byte size of each recording. A call id is the join key to a real caller's
record, and a size is a rough call length, so this is a smaller leak than the audio but
it is not zero.

Both M-6b and M-6d reasoned entirely about files. Neither looked at the container they
sit in, which is a general shape worth remembering: a permission fix that only ever
names files leaves the directory at whatever the process's umask produced, and 0755 is
what that produces by default.

Reproduce: `stat -f '%Sp' artifacts/api-server/audio-cache` → `drwxr-xr-x`, then
`ls artifacts/api-server/audio-cache | head` as any user on the machine.

---

## Found 2026-09-06 (shipping M-7b): a silent card and a loud card look the same

**Closed 2026-09-06 by M-7c (PR #94, deployed `681483c03902`)** -- for the first half.
The second half (a one-sample median carrying the same weight as a 19-sample one) is
still open. Two things below were corrected in shipping it, and are struck through
rather than rewritten: the coverage line counts the groups the **page renders** (29
all-time, 17 on the newest bulk), not the corpus's 32, and the silence has **two**
causes, not one -- group `60522198` has three saved artifacts, all reporting no turn
latencies.

The Results production line drops its latency clause when no call in the group
carries `prodTranscriberLatencyMs` -- correct, and what M-7b's Must-not
requires. But live, **8 of the corpus's 32 assistant groups render no clause at
all**, including the 22-call `Default` group. A reader scrolling Results sees a
card with "495 ms transcriber latency" and a card with nothing, and has no way
to tell "production is being measured and this is the number" from "nobody ever
measured this group". The absence is honest per card and invisible in
aggregate.

What closed it: one page-level line stating the coverage once. As shipped it reads
"Production latency is measured on **22 of 29** assistant groups below. The other 7
carry no call with one: either no Vapi artifact was saved before the 14-day window
closed, or the artifact that was saved reported no turn timings." ~~their calls aged
out of Vapi's 14-day window before an artifact was saved~~ was one cause of two. No
placeholder appears on any card, which is the thing M-7b forbids on purpose.

Second, smaller: the largest per-group median in the corpus is **3,093 ms, from
a single measured call**. The line does say "median of 1 measured call", which
is the whole defence, but a one-sample median next to a 19-sample one carries
the same visual weight. Worth revisiting if a client ever reads these cards
unaccompanied.

Evidence, 2026-09-06, `GET /api/benchmark/calls` on the live build
`3af08f2cfbbb`: 176 calls, 32 assistant groups, per-group medians spanning
63 ms to 3,093 ms; 8 groups with no measured latency on any call. Of those 8,
`GET /api/benchmark/rankings` renders 7 (the eighth, `60522198`, is in no bulk) --
which is why the shipped line counts 29, not 32.

## Found 2026-09-04: "microcents" everywhere actually holds microdollars

`benchmark_scores.cost_microcents`, `benchmark_agent_scans.judge_cost_microcents`,
the API's `actualCost.sttCostMicrocents` / `agentCostMicrocents`, and the UI's
`formatMicrocents()` all carry **microdollars**, not microcents. Verified on a
single cell: a 44s call at Deepgram's configured $0.0043/min costs
`44/60 x 0.0043 = $0.0031533`, and the stored value is `3153`.

**Nothing on screen is wrong.** `formatMicrocents()` divides by 1,000,000 and
formats the result as dollars, which is right for microdollars, and the
finished bulk reconciles: estimated $1.36 STT / $0.30 agent against actual
$1.36 / $0.39. The defect is purely the name, and it is consistent from the
column through the API contract to the helper -- which is exactly why it has
survived.

It is not harmless, though: reading the table directly, the name led to a
100x misreading of a real bulk's spend in this session. Renaming touches a
database column and a published API field, so it is a deliberate step, not a
drive-by.

## Found 2026-09-04: no bulk could be launched at all — two no-cascade FKs

Reported from the UI as `Launch failed — HTTP 400 Bad Request: selection
criteria matched no corpus calls`. Three separate problems sat behind that one
toast, and only the first was the one on screen.

1. **The 400 was correct and useless.** The saved template `weekly lindenwood
   heights chek` carries `{"lastNDays": 7, "minDurationSeconds": 20}`; the
   newest corpus call started 2026-08-26 and the window opened 2026-08-28.
   `POST /benchmark/bulks/preview` had the answer all along — 121 in scope,
   107 `outside the date window`, 14 `no start date on record` — but
   `createBulk` went through `resolveCriteriaCallIds`, which narrows the
   result and drops the buckets. Fixed by **M-3b**: the refusal now names them.

2. **Behind that, every launch was answering 500.** FR-BLK-10 evicts the
   oldest bulk once `MAX_LIVE_BULKS` (3) is reached — this instance had
   exactly 3 — and `benchmark_agent_scans.run_id` has no `ON DELETE`, so the
   scan row blocked the cascade into `benchmark_runs` and the transaction
   rolled back. The eviction code already handled `benchmark_rankings`
   explicitly for the same reason; scans were folded into the run executor
   afterwards (`e0399cc`) and nobody came back. `fixtures.ts`'s cleanup
   comment has described the trap since batch 18 — the tests knew, the
   production path never did. Fixed by **M-3c**.

3. **M-3c fixed half of it.** The next live launch failed on
   `agent_pick_result_id`, the same table's other plain reference, into a
   result cell that cascades from the run. M-3c's test set only `runId` on its
   scan, so a fixture thinner than a production row passed a half fix. Fixed
   by **M-3d**, after asking `pg_constraint` for every non-cascading key into
   the `bulks -> runs -> results -> scores` path rather than fixing the one
   named in the error: there are exactly two, both on `benchmark_agent_scans`.

Scans are **detached** (`run_id` / `agent_pick_result_id` set to null), never
deleted — a scan is keyed by `call_id`, eviction never touches the corpus, and
the judge verdict on it cost real OpenAI money.

**Rules this leaves.** A vague refusal usually means a caller computed the
answer and dropped it — look one function up before adding a query. After a
foreign-key failure, ask the catalog for every non-cascading key into the
whole delete path, not the one in the message. And a fixture that omits a
column cannot fail on that column.

**Still open (not fixed here):** both columns should carry `ON DELETE SET
NULL` so the class cannot recur. That is a schema change (`drizzle-kit push`,
worktree) and was not worth doing under a live blocker; the code fix mirrors
the pattern already used for rankings two lines above.

## Found 2026-09-04 (verifying M-3): the Vite dev server walks around the loopback bind

M-3 bound the API to `127.0.0.1`, and that part holds — `lsof` reads `127.0.0.1:8177`
and the LAN address is refused. It does **not** close the network path, because the UI is
a second process. `artifacts/stt-benchmark/vite.config.ts` sets `host: '0.0.0.0'` and
`allowedHosts: true` on both `server` and `preview`, and proxies `/api` to
`API_PROXY_TARGET` **server-side** — so the proxy dials the API from the laptop, where
loopback is allowed. Evidence, live on 2026-09-04 straight after the M-3 deploy:

```
curl http://192.168.1.9:8177/api/healthz   -> refused        (M-3 working)
curl http://192.168.1.9:5173/              -> 200            (whole UI)
curl http://192.168.1.9:5173/api/healthz   -> 200 {"status":"ok","commitSha":"78449739a880",…}
```

Anyone on the same WiFi can still open the tool and press Launch, which spends real
provider money. Queued as M-3a. **Rule this leaves: when a service is split across two
processes, binding one of them proves nothing about reachability — test the address a
person actually types.**

**Fixed 2026-09-05 (M-3a, PR #84, `b3aa91fbd994`).** `server.host` and `preview.host`
read `UI_HOST ?? '127.0.0.1'`; both ports now refuse the LAN address. One thing the
step's own spec had missed: `artifacts/stt-benchmark/package.json` also passed
`--host 0.0.0.0` on the command line for `dev` and `serve`, and a Vite CLI flag beats
the config, so the config edit alone would have changed nothing. Verified by putting the
flag back with the config fixed — bind stayed `*:5173`, LAN `/api/healthz` stayed 200.
**Second rule this leaves: a config value is not the setting until nothing on the command
line overrides it.**

## Found 2026-09-04 (verifying M-3): two docs said the API serves the UI; it never has

`docs/runbooks/deploy-and-rollback.md` opened with "the API runs on `:8177` and the UI
bundle is served by the same process", and the M-3 register row repeated it ("The UI is
served by the same process, so `http://localhost:8177` keeps working"), which made it
into M-3's acceptance sentence. Both were false. `artifacts/api-server/src/app.ts` mounts
only `app.use("/api", router)` and its own comment says "This server serves nothing but
the API"; `curl localhost:8177/` answers `{"error":"No such endpoint: GET /"}`. The UI is
served by Vite on `:5173`. `scripts/deploy-api.sh` does build the UI bundle
(`vite build` → `artifacts/stt-benchmark/dist/public`), which is probably where the belief
came from — nothing serves that directory. Both claims corrected 2026-09-04; M-3's
acceptance is recorded as met on its first clause only, with the second struck as never
having been true of this architecture.

## Found 2026-09-04 (running M-1): the T-62 flux reprice fires on every `--apply`

`backfill-t65-t66.ts` guards its price write with `cost_per_minute <> 0.0077`, but
`benchmark_providers.cost_per_minute` is a Postgres `real` (float4). Comparing it to the
numeric literal promotes the stored value to `0.007699999958276749`, which is never equal
to `0.0077`, so the `update` matches every time. Evidence, live on 2026-09-04 after
T-111 had already applied it on 2026-08-30: the run printed `flux repriced 1 (now
0.007699999958276749)`, and `audit_log` holds two `backfill-t65-t66` rows, one per apply.

Effect is harmless — the same value is written back — but two claims are wrong because of
it: `docs/runbooks/pending-backfills.md` says both scripts are idempotent and that after
`--apply` "every count should read 0 and the flux price 0.0077", and the script's own
header says re-running finds nothing to change. Reproduce:
`docker exec stt-evals-pg psql -U postgres -d stt_evals -c "select (cost_per_minute <>
0.0077) from benchmark_providers where id='deepgram-flux-general-en';"` → `t`.
**Fixed by M-1a, 2026-09-04**: the guard is `abs(cost_per_minute - 0.0077) > 1e-9`, and
the audit row is only inserted when at least one of the three writes actually changed a
row — an `--apply` with nothing to do now writes nothing at all. Proved by putting the
old `<> 0.0077` guard back on a copy of the live database: `flux repriced 1` and a new
`backfill-t65-t66` audit row; with the tolerance, `flux repriced 0` and no row.

## Found 2026-09-04: every WER ever shown measured agreement with Vapi, not accuracy

Found by a full audit of the product against `docs/PRD.md`, read from the live system
(API on `:8177`, the audit log, the cache on disk) — not from the docs, which turned out
to be wrong on three claims. Full reasoning and the plan: `docs/PRD-v6-measure.md`;
the work: `docs/step-register.md` Part M.

- **19 of the 21 "gold" transcripts are byte-identical to Vapi's draft.** The audit log
  shows who wrote them: 20 `call:update` rows by actor `claude-pipeline-test` on
  2026-08-24 and 1 by `review-ui-test`; a person has never produced a gold transcript
  from audio in this tool. The project's own first rule — *draft ≠ gold, ever* — was
  broken by a test script and nothing noticed for eleven days. Evidence: the rush set
  shows mean WER 0.62–0.71 for every provider; the draft reads "Rust Truck Center" and so
  does the gold, so a provider hearing "Rush" is penalised. Cleared by M-1.

- **The gold carried `AI:` / `User:` speaker labels as words.** `normalizeTranscript()`
  strips punctuation and keeps the tokens, so every line cost a provider one deletion.
  Measured on the real function: `AI: Hey. Thanks…` normalises to `ai hey thanks…`.
  The call comparison uses the draft as its reference when no gold exists, so its diff
  carried the same noise on every call. Fixed by M-2 (scoring version v3).

- **71 % of the words the benchmark scores are the assistant's TTS voice.** Counted
  across every draft: 10,347 assistant words, 4,154 customer words. Every cell is
  transcribed from the mono mix; production STT only ever hears the customer channel.
  Verified against a real call on 2026-09-04 that Vapi returns `presignedCustomerUrl`,
  `presignedAssistantUrl` and `presignedStereoUrl` (customer = channel 0) — none of
  which the import knew about. The 99 Land And Apartment calls' customer files were
  saved by hand the same day (`scripts/rescue-customer-audio.mjs`), five days before
  their 14-day cliff; the 22 Default-account calls are past it and keep mono only.
  Runs switch to the customer file in M-5.

- **Batch APIs were benchmarked; the client runs streaming.** Every adapter but
  Cartesia calls a prerecorded endpoint. Production's model on 86 of 121 calls (Deepgram
  Flux) is streaming-only and cannot be run by the tool at all. "Speed" on Results is
  file turnaround — meaningless to a voice agent — and 15 % of the rank. Streaming rows
  arrive in M-11 … M-14; latency is redefined in M-10.

- **The headline verdict never touched a reference.** 70 % peer-consensus flags, 15 %
  batch turnaround, 15 % list price. Consensus is a legitimate gold-free proxy but it was
  never calibrated on a labelled set, and it flags the lone provider that hears a hard
  word right as the outlier. The chip says "Winner". M-9 renames it "Least disagreement"
  and says on screen that it is relative; M-18 measures agreement on whatever a person
  does label; M-8 puts the production transcript (the draft's `User:` lines) into the
  consensus so "vs production" is a real number.

- **Keyword boosts were never sent.** `keywordBoosts` is on the adapter input type and
  the run executor never sets it; the Rush assistant runs 120 Deepgram keyterms in
  production. The Deepgram adapter also sends `keywords`, the Nova-2 parameter, where
  Nova-3 and Flux take `keyterm`. M-19.

- **Nothing protects the data.** No database backup exists (M-4); the API listens on
  every interface with no auth (M-3); no scheduled import, so audio crosses Vapi's
  14-day cliff whenever nobody clicks (M-17). Six calls are already gone.

- **Two claims in the docs were false and are corrected where made:** `.claude/CLAUDE.md`
  said scores are "against a human-corrected gold"; `.claude/STANDARDS.md` ticked
  "WER against a human-corrected gold transcript" and "two-person de-identification
  attestation" — the 21 attestations were by `claude-pipeline-test-pass-1` / `-pass-2`.
  `docs/data-governance.md` §4's vendor-handling gate has every box unticked while six
  vendors have received audio (open question, v6 E4).

- **What was found sound, so it is not touched:** resumable runs, raw output stored, run
  manifests (gold hash pinned), the paired bootstrap and its "provisional" honesty, cost
  as what was paid, the audio cache and the free rescue, the scoring-form /
  comparison-form split, words-to-watch mining, 85 UI + 110 API tests with proof by
  breaking.

## Found 2026-09-02: the working copy was swept out of `/tmp`

- **The repo lived in a Claude Code scratchpad under `/private/tmp`, and something
  on the Mac sweeps that tree nightly** (every file whose atime, mtime and ctime were
  all older than ~3 days). Found by a routine from-the-system status check: `git status`
  showed 166 ` D` lines nobody made — `.gitignore`, `.claude/VISION.md`, 13 docs,
  `artifacts/api-server/tsconfig.json`, source under `artifacts/` and `lib/` — plus
  209 missing objects in `.git` (`git fsck --connectivity-only`), 64 of 107 cached
  audio files, and enough of `node_modules` that `pnpm run typecheck` failed at a
  commit CI had passed. The reflog showed no git operation; nothing committed was lost
  (`HEAD` = remote = `91c2405b0ec8`). Runbook: `docs/runbooks/working-copy-location.md`.

- **Security side effect, no damage done:** with `.gitignore` deleted,
  `artifacts/api-server/.env` (real keys) was an ordinary untracked file. No `git add`
  ran. `git restore .` brought `.gitignore` back before anything else was touched.
  **Rule: when `.gitignore` is missing, nothing gets staged until it is back.**

- **Lost for good: audio for 6 calls.** The free rescue
  (`POST /benchmark/calls/cache-audio`) re-fetched 58 of the 64 deleted files; the
  other 6 had crossed Vapi's 14-day window while deleted. `vapi-c1a15ed9` (Rush,
  2026-08-17) is nameable; the other 5 are among the 14 date-unknown property-management
  and trucking calls now marked `source_refused`, indistinguishable from the 9 refused
  before because every uncached call was re-attempted the same day. All 6 have gold; their
  existing scores stand, and no new provider can ever be run on them. Cached audio is now
  101 of 121 (was 107).

- **Fix in progress (S-0.1):** fresh clone at `~/gh-projects/stt-evals-recovered`
  (fsck clean, typecheck clean), audio copied across; `.env` is Abhishek's to copy, then
  the API is deployed from there and Claude Code restarted there.

- **2026-09-04, follow-up: the sweep took `.env` before it was copied.** Two more
  nights → 174 deletions in the old tree, the keys file among them. The only copy left
  was the running API process; recovered through Node's `SIGUSR1` inspector
  (`process.env` minus the exec-time environment = the 12 names `.env` held), written
  with mode 600, values never printed. Recipe in `docs/runbooks/working-copy-location.md`.
  **Rule: when relocating, the keys file moves first, the same day.** Verified after:
  every keyed vendor `ready`, three Vapi accounts (Default, Land And Apartment, Leasing
  Dev), 101 cached audio files — and two stale CLAUDE.md claims corrected (ElevenLabs
  and OpenAI keys exist; the third Vapi account already exists).

- **Seen once, not explained:** the first `pnpm install` into the empty clone failed at
  the root `preinstall` guard with `Use pnpm instead` though pnpm was the runner; an
  `--ignore-scripts` install then a plain one passed, and every install since passes.

## Found 2026-08-31 (batch 23): the pages, rendered for the first time

- **No page had ever been rendered by a test.** The UI package's 39 tests
  were all pure functions in `src/lib`. Every page — Overview, Results,
  Calls, Bulks, Setup — was covered only by someone opening a browser.
  Five suites now render them against a stubbed API (84 tests, 13 files).
  **Nothing was found broken**: every page degrades honestly when a
  dependency is missing. That is worth stating plainly rather than
  implying the sweep found bugs.

- **A `status` field is not an envelope.** The harness first spotted a
  non-200 answer by duck-typing — an object with a `status` key. Two of
  this API's own payloads carry one (`HealthStatus.status: "ok"`,
  `BulkDetail.status: "running"`), so those fixtures were turned into
  `new Response(null, { status: "ok" })`, which throws a RangeError, and
  the page under test simply showed its error state. It looked like an
  app bug for several minutes. Non-200 answers are branded now
  (`reply(status, body)`). **Rule: never infer a wrapper from a field
  name that the payload could legitimately own.**

- **An assertion that survives the behaviour's removal is not an
  assertion.** The Bulks nesting test asserted that no shard run appears
  in the ad-hoc list. Deleting `onlyAdhoc` from the embedded Runs list
  broke nothing — run ids render truncated to their first 8 characters,
  and the fixture ids (`run-shard-1`, `run-adhoc-9`) were identical
  within those 8, so the check could never match either way. Found only
  because every task in this batch is proved by breaking. Fixture ids are
  distinct within the truncation now.

- **The template Launch button has no confirm — flagged for Abhishek,
  not changed.** Clicking Launch on a saved template posts immediately.
  The gate is server-side and deliberate (FR-BLK-5): an estimate over
  `BULK_COST_THRESHOLD_CENTS` (**$50** default, env-tunable) lands the
  bulk in `awaiting_confirmation` instead of running it. So anything
  estimated **under $50 spends on a single click**, with no second step
  in the UI. Whether the UI should ask anyway is a product decision.

- **What these tests are not.** jsdom is not a browser: no layout, no
  real fonts, no real network, no real money. They catch a page that
  breaks on a shape of data or loses a rule; they do not catch a page
  that renders unreadably. The live browser pass still matters.

## Found 2026-08-31 (batch 22): the writes, and a claim that was wrong

- **Batch 21's closing line overclaimed.** It said every route without a
  network call or provider spend had tests. The read surface had been swept;
  eight write routes had nothing. Corrected in the register rather than
  quietly fixed: bulk-template CRUD, manual call create, de-id attestation,
  run create, provider create/edit, model enable, bulk preview, bulk cancel.
  Lesson: a sweep of GET routes is not a sweep of routes.

- **`POST /benchmark/runs` executes what it creates.** Fire-and-forget, the
  moment nothing blocks it. Any test of that route must be blocked by
  construction — fixture provider ids match no adapter, so readiness derives
  to not_configured and the handler refuses to start. The suite's header says
  so; never seed a "ready" provider there.

- **An operator-disabled provider reads `disabled`, not `not_configured`.**
  The manual flag outranks key presence in the FR-P3 derivation, so the reason
  a provider will not run stays visible. Found by a first-draft assertion that
  expected the wrong one.

- **A hand-picked call skips the duration band, the date window and the
  outcome filters** — only the retention pass still applies. By design (a
  person named it), but it defeated a first draft that scoped a preview test
  with explicit call ids and then could not see the band at all. Scope a
  filter test by account label instead.

- **Response field names are not request field names.** The template body
  takes `criteria`; the row and the response answer `selectionCriteria`.
  Third slip of this class in three batches (`notes`/`entityNotes`,
  `APP_SETTINGS_ID`), and the same fix each time: read the schema.

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
- **`listCachedCallIds` counted channel files as calls** (found 2026-09-05
  during M-5, **fixed in the same PR** because it is the same function's
  handling of the same filenames the step introduces). It matched on the
  `.audio` suffix, and the 2026-09-04 customer-audio rescue wrote
  `<callId>.customer.audio` and `<callId>.assistant.audio` beside every mono
  file -- so the set came back with 353 entries (155 real ids plus 198 shaped
  `<uuid>.customer` / `<uuid>.assistant`) instead of 155. Nothing rendered
  wrong, because a junk id matches no call, so no screen was visibly broken;
  every caller's "how many calls are cached" number was simply inflated, in
  `lib/overview.ts`, `lib/audio-rescue.ts` and the calls-list route. Now
  matched on the call-id shape (`artifacts/api-server/src/lib/audio-cache.ts`),
  with a case in `artifacts/api-server/src/lib/audio-cache.test.ts`. **The
  lesson is the one to keep: a suffix match on a filename is a guess about
  what else will ever be written to that directory.**

- **The integration suite fails about once every ten runs, on `main` as well**
  (measured 2026-09-05 while shipping M-6 and M-6a). Five failures in roughly
  fifty runs, never twice the same test. The four whose detail was captured,
  each in a different file:
  `small-reads.int.test.ts`'s "answers 404 for an unknown call",
  `rankings.int.test.ts`'s "all-time picks each group's newest batch run",
  `riskiest-endpoints.int.test.ts`'s "answers 400 for a malformed id in the
  query string" -- that one on an unmodified `main`, 1 failure in 12 runs --
  and, while shipping M-6a itself, `bulk-preview-cancel.int.test.ts`'s
  "answers 404 for an unknown bulk and a sentence for a malformed id".
  **It is not caused by any one branch**; the first two were seen on the M-6
  branch, the third on `main` with nothing of M-6 in it, and the fourth on a
  branch that had touched none of the four files -- which is the only reason
  M-6 could be called green at all.
  The fourth occurrence corrects the inference written here first. Two of the
  four assert a 4xx status and got something else, so this entry said the cause
  pointed at the response rather than at leftover rows. The fourth did not
  assert anything at all: it failed with `Error: socket hang up`, meaning the
  request never got an answer, and the three runs immediately after it were
  clean. **So there may be two faults here, or one that shows up two ways, and
  neither is diagnosed.**
  The fifth fired minutes later and its detail was lost: the command was piped
  through `tail -4`, so the exit code was seen and the failing test was not.
  **Making the assertion talk is only half of it -- whoever runs the suite has
  to keep the output.** Run it as `... pnpm run test:integration 2>&1 | tee
  /tmp/int.log` and read the log, never a short tail.
  What else is known: `fileParallelism: false` is set in
  `artifacts/api-server/vitest.integration.config.ts`, so files do not race
  each other; the suite shares one database, whose header comment already
  says "the corpus is shared state"; and each file calls `pool.end()` in its
  own `afterAll`. Reproduce by running `TEST_DATABASE_URL=... pnpm run
  test:integration` from `artifacts/api-server` in a loop of a dozen.
  **The lesson to keep: a suite that is green only most of the time is not
  evidence, and an assertion that says "expected 200 to be 404" without
  printing the body it got costs an hour every time it fires.** Stepped as
  M-6a, whose first job is to make the next occurrence diagnosable rather
  than to guess at a cause -- and M-6a covers only the status half: a socket
  that hangs up has no body to print, so that half is stepped separately.
  **What the hang-up half prints, measured 2026-09-05 while shipping M-6c:
  nothing.** A response socket destroyed by the server reaches supertest as
  `Error: socket hang up` with no stack, no method and no URL -- node's http
  client builds that error after the fact and its stack carries no frame from
  the test. Two deliberately different failures, one where the server had sent
  headers and one where it had sent none, printed the same single line, and
  vitest showed that line's body once for both: the request that died was not
  even identifiable. M-6c asks the other end of the socket instead. The
  integration config now loads
  `artifacts/api-server/src/routes/__integration__/setup.ts`, which wraps
  `http.createServer` for this suite only and prints, for any response whose
  socket closes before it finished, the method, the URL, whether headers had
  gone out and with which status, and how many milliseconds in.
  **The correction to keep: M-6c had prescribed `process.on` handlers for
  unhandled rejections and uncaught exceptions, and both are redundant --
  vitest 3.2.7 already prints those with a full stack, the source frame and the
  name of the running test.** Measuring what the tool already does came before
  writing the file, as on M-6a, and it is the second step in a row whose
  prescribed change did not survive being run.
  **It fired again on 2026-09-06 during M-6b, and the evidence was thrown
  away.** One test of 119 failed; the run had been piped through `tail -8`, so
  the failing file, the failing case and any `[integration]` line the M-6c
  setup file printed all went with it. Two re-runs immediately after were
  119/119 with zero `[integration]` lines, and the change under test cannot be
  involved -- it touches `getOrCacheAudioBytes`, which the two integration
  files that use the audio cache never call; both write their own fixtures.
  So the occurrence is spent and the cause is still unknown. **The rule, now
  written down instead of remembered: run the integration suite through
  `tee <file>` and read the file. Never a short `tail`, and never a re-run
  before the log has been read** -- a re-run that passes destroys the only
  evidence the previous failure produced. This is the whole point of M-6a and
  M-6c, discarded on the first occurrence after shipping them.
  **Diagnosed and fixed 2026-09-08 (S-8). It was never in this repository.**
  Three failures in 33 runs that day, in three files, two of which had never
  been implicated: a 401 whose body was an Anthropic API error envelope
  (`authentication_error` / `request_id` -- a string that appears nowhere in
  this repository, and BAML's clients here are `provider openai`); a 400 whose
  body was `WebSockets request was expected` with `content-type: text/html`;
  and `audit.body.map is not a function` from a route whose only 200 shape is
  an array. The M-6c setup file was extended for the run to stamp every
  response the app under test sends with a header; the answer that failed
  carried no stamp. **The app never saw the request.**
  The mechanism, reproduced in isolation and printing the same body:
  `supertest` stands up a fresh server per request -- 178 call sites, several
  inside loops -- with `app.listen(0)`, and `listen` with no host binds the
  wildcard address. **That bind succeeds even when another process already
  holds `127.0.0.1` on the same port**, and a connection to `127.0.0.1:P` then
  goes to the more specific binding: the stranger. This machine holds around
  twenty loopback-only listeners inside the ephemeral range 49152-65535 --
  editor helpers, a bundler, local agent servers. Binding `127.0.0.1` instead
  fails with `EADDRINUSE`, so the kernel hands out a genuinely free port and
  the collision cannot happen. The suite now takes one pre-bound loopback
  server per file (`artifacts/api-server/src/routes/__integration__/server.ts`)
  and passes it to supertest, instead of handing supertest the app and letting
  it stand up 178 of them. **Patching `listen` in the setup file was tried
  first and broke all 27 files at once**: `listen(port, host)` resolves the
  host through `dns.lookup`, which defers even for an IP literal, so
  `server.address()` is still null on the next line and supertest -- which
  reads it synchronously -- dies with `Cannot read properties of null (reading
  'port')`. **Adding a host argument turns a synchronous bind into an
  asynchronous one.** Awaiting the bind once at module load is the only way to
  hand supertest an address that is already there.
  **The lesson to keep, and it invalidates every theory written above:
  each of them looked for shared state inside the process --
  the pool, the fixture cleanup order, `pool.end()` landing mid-request -- and
  the shared state was the machine's port space.** Two of the recorded
  failures were on routes that answer before touching the database at all
  (`POST /benchmark/bulks` and `POST /benchmark/runs` both fail zod and return
  400 with no query), which ruled the database out on its own and was the
  thread worth pulling. **When a response cannot have come from your code, stop
  reading your code.**
- **The mono file is the only one of the four written world-readable**
  (found 2026-09-05 by looking at the first M-6 import on disk). The three
  files M-6 writes are 0600; the mono mix beside them, written by
  `getOrCacheAudioBytes` since 2026-08-27, is 0644 -- `fs.writeFile` with no
  mode, so 0666 minus the umask. The mono mix contains the caller's voice
  exactly as the customer channel does, so locking down three of four files
  and leaving the fourth open protects nothing. It is one argument to fix,
  but M-6's own "must not" forbade touching the mono path, so it is stepped
  rather than smuggled in: **M-6b**. Low severity today -- the directory is a
  local, gitignored folder on a single-user laptop -- and it stops being low
  the moment this moves to a shared box or real object storage.
  **Fixed forward 2026-09-06 (M-6b, PR #91): new mono files are written 0600.**
  Every production writer into that directory now agrees -- `getOrCacheAudioBytes`,
  `cacheCallSidecars` and `scripts/rescue-customer-audio.mjs`. **The 156 mono
  files already on disk are still 0644**, because `mode` applies at creation and
  because a chmod sweep over a directory of caller audio is its own decision, not
  a side effect of a one-line change. Until that sweep is stepped and run, the
  directory is still only as protected as its weakest file, and the "stops being
  low the moment this moves to a shared box" sentence above still stands for the
  old files.

- **A fresh checkout cannot run a single pnpm script on this laptop.**
  **Closed 2026-09-06 by S-0.2 (PR #95).** Found 2026-09-06 while making a
  worktree for M-7a. The root `preinstall` guard rejected anything whose
  `npm_config_user_agent` did not start with `pnpm/`, so `pnpm install` failed
  its own "use pnpm" check while being pnpm. pnpm 11 also re-verifies
  dependencies before every `run`, so after the failure `pnpm run typecheck`
  failed too -- with an install error, not a type error
  (`runDepsStatusCheck` re-runs the same install). CI never saw it:
  `pnpm/action-setup@v4` installs a real binary. Workaround, no longer needed:
  `pnpm install --frozen-lockfile --ignore-scripts` once, then
  `npm_config_verify_deps_before_run=false` on each command.

  **This entry blamed the wrong thing, corrected here.** It said corepack "does
  not set that variable for lifecycle scripts". Corepack is not the cause: a
  plain single-package `pnpm install` through the same shim
  (`~/.cache/node/corepack/v1/pnpm/11.1.2`) sets it to
  `pnpm/11.1.2 npm/? node/v22.22.2 darwin arm64`. The variable is empty only for
  a **workspace root's** own lifecycle scripts, which pnpm 11 runs in a separate
  phase *after* linking -- which is also why the failed install still left all
  579 packages linked in `node_modules`, looking installed while every later
  command re-ran the install. The fix guards on the basename of `$npm_execpath`,
  which is set in both phases: `pnpm.mjs` (corepack) and `pnpm.cjs`
  (`pnpm/action-setup`) pass; `npm-cli.js`, `yarn-*.cjs` and an unset value are
  rejected. Basename rather than whole path, because npm installed under pnpm's
  own global directory (`~/Library/pnpm/...`) carries "pnpm" in its execpath.
  Separately noted while verifying: `npm install` never reaches the guard in
  this repo anyway -- npm dies first on the pnpm workspace with
  `Cannot read properties of null (reading 'isDescendantOf')`.

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
