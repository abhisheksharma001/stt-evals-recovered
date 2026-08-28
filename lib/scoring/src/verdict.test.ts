import { describe, expect, it } from "vitest";
import { bootstrapNoiseFloor, computeVerdict, pooledRate, type VerdictCell } from "./verdict";

function cellsFor(providerId: string, flags: number[], words = 100): VerdictCell[] {
  return flags.map((f, i) => ({ callId: `c${i}`, providerId, peerFlagCount: f, words }));
}

describe("pooledRate", () => {
  it("pools flags over words, not a mean of per-call rates", () => {
    expect(pooledRate([{ flags: 1, words: 10 }, { flags: 0, words: 90 }])).toBe(1);
  });
  it("is null with no words", () => {
    expect(pooledRate([{ flags: 0, words: 0 }])).toBeNull();
  });
});

describe("bootstrapNoiseFloor", () => {
  it("is reproducible for the same input", () => {
    const pairs = Array.from({ length: 30 }, (_, i) => ({
      leader: { flags: i % 3, words: 100 },
      runnerUp: { flags: (i % 3) + 2, words: 100 },
    }));
    const a = bootstrapNoiseFloor(pairs);
    const b = bootstrapNoiseFloor(pairs);
    expect(a).toEqual(b);
    expect(a!.withinNoise).toBe(false);
    expect(a!.difference).toBe(2);
  });
  it("calls a consistent gap outside noise and a mixed gap inside it", () => {
    const clear = Array.from({ length: 30 }, () => ({ leader: { flags: 0, words: 100 }, runnerUp: { flags: 3, words: 100 } }));
    expect(bootstrapNoiseFloor(clear)!.withinNoise).toBe(false);
    // Winner alternates: half the calls the "leader" is worse.
    const mixed = Array.from({ length: 30 }, (_, i) => ({
      leader: { flags: i % 2 === 0 ? 0 : 4, words: 100 },
      runnerUp: { flags: i % 2 === 0 ? 4 : 1, words: 100 },
    }));
    expect(bootstrapNoiseFloor(mixed)!.withinNoise).toBe(true);
  });
  it("is null when no pair has words on both sides", () => {
    expect(bootstrapNoiseFloor([{ leader: { flags: 0, words: 0 }, runnerUp: { flags: 1, words: 5 } }])).toBeNull();
  });
});

describe("computeVerdict", () => {
  it("names a winner with margin and evidence when the gap is outside noise", () => {
    const cells = [
      ...cellsFor("a", Array.from({ length: 25 }, () => 1)),
      ...cellsFor("b", Array.from({ length: 25 }, () => 2)),
      ...cellsFor("c", Array.from({ length: 25 }, () => 3)),
    ];
    const v = computeVerdict(cells, { providerNames: { a: "A", b: "B", c: "C" } });
    expect(v.decision).toBe("winner");
    expect(v.winnerProviderId).toBe("a");
    expect(v.runnerUpProviderId).toBe("b");
    expect(v.marginPct).toBe(50);
    expect(v.evidenceCalls).toBe(25);
    expect(v.provisional).toBe(false);
    expect(v.sentence).toContain("A is the best fit");
    expect(v.sentence).toContain("50% cleaner than the runner-up (B)");
    expect(v.sentence).toContain("Based on 25 calls");
  });

  it("refuses to name a winner inside the noise floor and estimates what would settle it", () => {
    const cells = [
      ...cellsFor("a", Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? 0 : 4))),
      ...cellsFor("b", Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? 4 : 1))),
    ];
    const v = computeVerdict(cells);
    expect(v.decision).toBe("too_close");
    expect(v.winnerProviderId).toBeNull();
    expect(v.marginPct).toBeNull();
    expect(v.leaderProviderId).toBe("a");
    expect(v.runnerUpProviderId).toBe("b");
    expect(v.noiseFloor?.withinNoise).toBe(true);
    expect(v.callsToSettle).toBeGreaterThan(24);
    expect(v.sentence).toMatch(/^Too close to call on this evidence/);
    expect(v.sentence).toContain("Based on 24 calls");
  });

  it("marks the verdict provisional below 20 calls and still attaches the count", () => {
    const cells = [...cellsFor("a", [0, 0, 0, 0, 0, 0]), ...cellsFor("b", [5, 5, 5, 5, 5, 5])];
    const v = computeVerdict(cells);
    expect(v.decision).toBe("winner");
    expect(v.evidenceCalls).toBe(6);
    expect(v.provisional).toBe(true);
    expect(v.sentence).toContain("Based on 6 calls -- provisional");
  });

  it("names no winner when the top two share fewer than 5 calls, however big the gap", () => {
    const cells = [...cellsFor("a", [0, 0, 0, 0]), ...cellsFor("b", [5, 5, 5, 5])];
    const v = computeVerdict(cells);
    expect(v.decision).toBe("too_few_calls");
    expect(v.winnerProviderId).toBeNull();
    expect(v.marginPct).toBeNull();
    expect(v.noiseFloor).toBeNull();
    expect(v.leaderProviderId).toBe("a");
    expect(v.sentence).toMatch(/^No winner on this evidence/);
    expect(v.sentence).toContain("share only 4 calls");
  });

  it("calls a near-zero gap effectively tied instead of quoting thousands of calls", () => {
    const cells = [
      ...cellsFor("a", Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 1 : 2))),
      ...cellsFor("b", Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 2 : 1))),
    ].map((c, i) => (i === 0 ? { ...c, peerFlagCount: 0 } : c)); // tiny lead for a
    const v = computeVerdict(cells);
    expect(v.decision).toBe("too_close");
    expect(v.callsToSettle).toBeNull();
    expect(v.sentence).toContain("effectively tied");
  });

  it("compares against production when it was benchmarked and isn't the leader", () => {
    const cells = [
      ...cellsFor("a", Array.from({ length: 25 }, () => 1)),
      ...cellsFor("b", Array.from({ length: 25 }, () => 2)),
      ...cellsFor("prod", Array.from({ length: 25 }, () => 4)),
    ];
    const v = computeVerdict(cells, { productionProviderId: "prod" });
    expect(v.vsProductionPct).toBe(75);
    expect(v.productionIsLeader).toBe(false);
    expect(v.sentence).toContain("75% cleaner than the provider running in production today (prod)");
  });

  it("says so when production is already the leader", () => {
    const cells = [...cellsFor("prod", Array.from({ length: 25 }, () => 1)), ...cellsFor("b", Array.from({ length: 25 }, () => 3))];
    const v = computeVerdict(cells, { productionProviderId: "prod" });
    expect(v.productionIsLeader).toBe(true);
    expect(v.vsProductionPct).toBeNull();
    expect(v.sentence).toContain("also the provider running in production today");
  });

  it("reports insufficient with one provider and excludes never-flagged cells", () => {
    const cells: VerdictCell[] = [
      ...cellsFor("a", [0, 1, 0]),
      { callId: "x", providerId: "b", peerFlagCount: null, words: 50 },
    ];
    const v = computeVerdict(cells);
    expect(v.decision).toBe("insufficient");
    expect(v.rates.map((r) => r.providerId)).toEqual(["a"]);
    expect(v.evidenceCalls).toBe(3);
  });

  it("counts confidence-reporting providers for the comparability note", () => {
    const cells = [...cellsFor("a", Array.from({ length: 25 }, () => 0)), ...cellsFor("b", Array.from({ length: 25 }, () => 3))];
    const v = computeVerdict(cells, { confidenceReportingProviderIds: ["a", "zzz-not-in-group"] });
    expect(v.confidenceComparable).toEqual({ reporting: 1, total: 2 });
    expect(v.sentence).toContain("1 of 2 providers report confidence");
  });
});
