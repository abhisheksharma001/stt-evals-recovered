// R-46 (ox-alpha B-96). The bug is not that the wrong provider wins a tie --
// nothing here knows which one deserves to. It is that the winner used to
// depend on row order from a SELECT with no ORDER BY, so the same data could
// rank differently on a re-execute.
import { describe, expect, it } from "vitest";
import { compareRankedProviders, type RankableAggregate } from "./ranking-order";

const p = (
  providerId: string,
  flaggedCallRate: number | null,
  peerFlagsPer100Words: number | null = 0,
): RankableAggregate => ({ providerId, flaggedCallRate, peerFlagsPer100Words });

const order = (rows: RankableAggregate[]) => [...rows].sort(compareRankedProviders).map((x) => x.providerId);

describe("compareRankedProviders", () => {
  it("puts the lower flagged-call rate first", () => {
    expect(order([p("a", 0.5), p("b", 0.25)])).toEqual(["b", "a"]);
  });

  // R-2b: the per-100-words rate breaks a flagged-call tie, as it does in the
  // org verdict (lib/scoring/src/verdict.ts).
  it("breaks a flagged-call tie on peer flags per 100 words", () => {
    expect(order([p("a", 0.5, 3.1), p("b", 0.5, 1.2)])).toEqual(["b", "a"]);
  });

  it("ranks the flagged-call rate above peer flags per 100 words", () => {
    expect(order([p("a", 0.5, 0.1), p("b", 0.25, 9)])).toEqual(["b", "a"]);
  });

  it("sorts a provider with no flagged-call rate last", () => {
    expect(order([p("a", null), p("b", 1)])).toEqual(["b", "a"]);
  });

  it("sorts a missing per-100-words rate after a present one", () => {
    expect(order([p("a", 0.5, null), p("b", 0.5, 4)])).toEqual(["b", "a"]);
  });

  // The regression. Two orderings of the same tied set must rank identically:
  // that is exactly what an ORDER-BY-less SELECT can hand over on two reads.
  it("ranks tied providers the same whichever order they arrive in", () => {
    const one = [p("deepgram-nova-3", 0.5), p("assemblyai-universal", 0.5)];
    expect(order(one)).toEqual(order([...one].reverse()));
  });

  it("ranks three-way ties the same whichever order they arrive in", () => {
    expect(order([p("c", 0.5), p("a", 0.5), p("b", 0.5)])).toEqual(["a", "b", "c"]);
    expect(order([p("b", 0.5), p("c", 0.5), p("a", 0.5)])).toEqual(["a", "b", "c"]);
  });

  it("orders two providers with no evidence deterministically", () => {
    expect(order([p("z", null), p("a", null)])).toEqual(["a", "z"]);
    expect(order([p("a", null), p("z", null)])).toEqual(["a", "z"]);
  });
});
