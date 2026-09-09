// R-46 (ox-alpha B-96). The bug is not that the wrong provider wins a tie --
// nothing here knows which one deserves to. It is that the winner used to
// depend on row order from a SELECT with no ORDER BY, so the same data could
// rank differently on a re-execute.
import { describe, expect, it } from "vitest";
import { compareRankedProviders, type RankableAggregate } from "./ranking-order";

const p = (providerId: string, composite: number | null): RankableAggregate => ({
  providerId,
  composite,
});

describe("compareRankedProviders", () => {
  it("puts the higher composite first", () => {
    const sorted = [p("a", 0.4), p("b", 0.9)].sort(compareRankedProviders);
    expect(sorted.map((x) => x.providerId)).toEqual(["b", "a"]);
  });

  it("sorts a provider with no composite last", () => {
    const sorted = [p("a", null), p("b", 0.1)].sort(compareRankedProviders);
    expect(sorted.map((x) => x.providerId)).toEqual(["b", "a"]);
  });

  // The regression. Two orderings of the same tied set must rank identically:
  // that is exactly what an ORDER-BY-less SELECT can hand over on two reads.
  it("ranks tied providers the same whichever order they arrive in", () => {
    const one = [p("deepgram-nova-3", 0.82), p("assemblyai-universal", 0.82)];
    const other = [...one].reverse();
    expect(one.sort(compareRankedProviders).map((x) => x.providerId)).toEqual(
      other.sort(compareRankedProviders).map((x) => x.providerId),
    );
  });

  it("ranks three-way ties the same whichever order they arrive in", () => {
    const tied = [p("c", 0.5), p("a", 0.5), p("b", 0.5)];
    const shuffled = [p("b", 0.5), p("c", 0.5), p("a", 0.5)];
    expect(tied.sort(compareRankedProviders).map((x) => x.providerId)).toEqual(["a", "b", "c"]);
    expect(shuffled.sort(compareRankedProviders).map((x) => x.providerId)).toEqual(["a", "b", "c"]);
  });

  // Two providers that both failed everything tie at null, and that is the
  // common case, not a corner: 0 of 275 stored rows had every metric null,
  // but the composite is null whenever the flag inputs are missing.
  it("orders two null composites deterministically", () => {
    const one = [p("z", null), p("a", null)];
    const other = [p("a", null), p("z", null)];
    expect(one.sort(compareRankedProviders).map((x) => x.providerId)).toEqual(["a", "z"]);
    expect(other.sort(compareRankedProviders).map((x) => x.providerId)).toEqual(["a", "z"]);
  });
});
