# Research log

One entry per open question (mystandard section 9). Find the code markers with
`grep -rn "RESEARCH R-" .`

### R-1 — What Spearman ρ counts as "the no-gold rank agrees with gold WER" for 7 providers?

**Where:** W-12b · `docs/step-register.md` W-12b row, `docs/PRD-v8-watch.md` Part F · the verdict word on the Results "Method check" line.
**Find out:** the cutoff between "agrees" and "weak". A fixed number vs a computed p-value changes the code.
**Confidence:** high -- computed here and matches a published table.
**Review:** none.
**Status:** answered 2026-09-26.
**Answer:** for n = 7 with no ties, exactly 222 of the 5,040 orderings give ρ ≥ 5/7 (0.714), one-sided p = 0.0440; ρ ≥ 11/14 (0.786) gives p = 0.024 (python enumeration over itertools.permutations, 2026-09-26). Published critical values agree: n = 7, one-tailed α 0.05 = 0.714, two-tailed α 0.05 = 0.786 (Zar 2010, via https://statisticsfundamentals.com/tables/spearman-correlation-table, read 2026-09-26; https://metricgate.com/docs/spearman-critical-values gives 0.7857 two-sided, read 2026-09-26). Direction is predicted in advance (fewer flags should mean lower WER), so one-sided is correct. Ties are the normal case in this corpus and shift the distribution, so W-12b computes the exact permutation p on the real mid-ranks instead of comparing to 0.714.

### R-2 — Does a failed cell count against a provider's reliability?

**Where:** R-2b follow-up · `lib/scoring/src/verdict.ts` `VerdictCell` and `artifacts/api-server/src/lib/run-executor.ts` ranking loop · the flagged-call rate.
**Find out:** whether a provider that times out or errors on a call is penalised anywhere in the verdict or the card rank. Abhishek's goal (2026-09-28) is "the most reliable STT"; if a failed cell is simply left out, a provider that fails often can read cleaner than one that always answers. Yes = nothing to build; no = a step that folds failures into the ranking quantity.
**Confidence:** medium -- `VerdictCell` only carries scored cells and the ranking loop reads score rows, which a failed cell has none of (R-25b); the path from the route into both was not traced end to end.
**Review:** none.
**Status:** open.
**Answer:** --

