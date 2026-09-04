// M-3b: the sentence a refused launch answers with. It exists because
// "selection criteria matched no corpus calls" told a person nothing -- the
// buckets were computed and thrown away one function earlier.
import { describe, expect, it } from "vitest";
import { describeEmptySelection } from "./empty-selection";

describe("describeEmptySelection", () => {
  it("names every bucket with its count against the in-scope total", () => {
    // The real 2026-09-04 case: a template asking for the last 7 days against
    // a corpus whose newest call is nine days old.
    expect(
      describeEmptySelection(121, [
        { bucket: "outside the date window", count: 107 },
        { bucket: "no start date on record", count: 14 },
      ]),
    ).toBe(
      "no corpus calls matched: 0 of 121 in scope (outside the date window 107, no start date on record 14)",
    );
  });

  it("keeps the order it was given", () => {
    // resolveCriteriaSelection already sorts (biggest first, ties
    // alphabetical). Re-sorting here would let the refusal and the preview
    // list the same buckets in different orders.
    expect(
      describeEmptySelection(9, [
        { bucket: "shorter than 60s", count: 5 },
        { bucket: "longer than 120s", count: 4 },
      ]),
    ).toBe("no corpus calls matched: 0 of 9 in scope (shorter than 60s 5, longer than 120s 4)");
  });

  it("says the in-scope total even when there is nothing to blame", () => {
    // An empty scope has no buckets -- the filters matched no call at all,
    // rather than matching some and excluding them.
    expect(describeEmptySelection(0, [])).toBe("no corpus calls matched: 0 of 0 in scope");
  });
});
