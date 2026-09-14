# Feature — A against B, on the same calls

**Source:** Abhishek, 2026-09-13: *"if some new stt launched ... it should have the
functionality to compare ... mainly it will be used if new stt came or if we want to
test it, how it works"*. Grilled the same day; he chose **a focused 2-up A/B screen**
over a new-vendor adapter and over a new agent.

**Scope rule:** this adds no page, no provider, and no new statistic. It narrows a view
the repo already computes correctly to the two providers a person is actually deciding
between.

---

## What is true today — read from the live system 2026-09-13

- `GET /benchmark/rankings?bulkId=` already scopes to one bulk. Live: 80 / 65 / 85 rows
  across the three complete bulks, 5 providers each, 16 / 13 / 17 assistant groups.
- `computeVerdict(cells, options)` (`lib/scoring/src/verdict.ts:284`) is **pure** and
  already does the A/B statistic: pooled peer flags per 100 words, a 95% bootstrap
  percentile interval (`BOOTSTRAP_ITERATIONS = 1000`) on the difference between the top
  two, and `withinNoise` when that interval contains zero. `MIN_SHARED_CALLS_FOR_VERDICT
  = 5`; `PROVISIONAL_EVIDENCE_CALLS = 20`; `callsToSettle` already answers "how many more
  calls would decide it".
- `GET /benchmark/bulks/{bulkId}/verdicts` returns that verdict per org. Live on bulk
  `3f134973`: `too_close`, 31 shared calls, no winner named.
- `GET /benchmark/bulks/{bulkId}/provider-correlation` already returns **pairwise** rows
  (`providerAId`, `providerBId`, `sharedCalls`, `agreement`, `excessAgreement`) — 10
  pairs for a 5-provider bulk.
- The judge runs automatically per run (`artifacts/api-server/src/lib/agent-verify.ts`, called from
  `artifacts/api-server/src/lib/run-executor.ts:45`). Live: 347 scans, **97 carry a pick**, 277 carry reasoning, 266
  carry token counts and cost. Picks spread over 7 providers.

## What a person sees today

Results, "One bulk" mode: a bulk picker, a verdict banner, then one table per assistant
group with **all five providers at once**, sorted by rank. To judge a challenger against
the incumbent you read two rows out of five and do the subtraction yourself. There is no
provider filter anywhere on the page — `Rankings.tsx` holds `viewMode`, `selectedBulkId`,
`sortKey`, `asc` and `evidenceOpen`, and nothing else.

The one affordance that exists for this is inert: `settings.activeProviderId` drives the
"delta vs production" line at `Rankings.tsx:544`, and it is **null on the live system**,
so that line renders for nobody.

## What they must see instead

Pick two providers. Get one sentence about those two and nothing else: who is cleaner, by
how much, on how many calls they both ran, and whether the gap survives the noise floor.

## Acceptance

> **WHEN** a person selects two providers on a bulk **THEN** Results **SHALL** show a
> verdict computed over only those two providers' cells, naming the shared-call count it
> rests on; **AND WHEN** their interval contains zero **THEN** it **SHALL** say the
> evidence cannot separate them rather than naming a winner.

## The default pair

Three options were on the table:

- **(a) Challenger vs `settings.activeProviderId`.** The "compare against what we run
  today" framing. Rejected as the *default*: the setting is null live, so the screen
  would open empty.
- **(b) Rank 1 vs rank 2.** Recommended, and adopted. It is already the pair
  `computeVerdict` draws its noise floor from, so the default pair and the existing
  verdict agree by construction instead of by coincidence.
- **(c) Always ask.** Kept as the override — both pickers are editable.

## Steps

`S-AB1` … `S-AB3` in `docs/step-register.md`. S-AB1 is the only one that changes a
contract.

## Deliberately not doing

- **No new page.** This is a control on Results.
- **No new statistic.** If `computeVerdict` cannot separate two providers, this screen
  says so; it does not reach for a softer number that can.
- **No client-side verdict.** Filtering ranking rows in the browser would show a pair
  with no noise floor behind it — a comparison the evidence does not support. The pair is
  recomputed server-side or it is not shown.
- **No new vendor adapter.** A brand-new STT company still needs one file in
  `lib/stt-providers/src/adapters/`. Abhishek expects the next one to be streaming
  (~460-520 lines), and PRD-v7 parks streaming adapters until a client names the vendor.
  Unchanged by this feature.
- **No change to the judge.** It already runs per bulk and already writes picks.
