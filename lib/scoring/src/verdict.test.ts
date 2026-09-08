import { describe, expect, it } from "vitest";
import { bootstrapNoiseFloor, callWordBasis, computeVerdict, pooledRate, type VerdictCell } from "./verdict";

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

describe("callWordBasis", () => {
  it("gives every provider on a call the same number: the median of what they wrote", () => {
    const basis = callWordBasis([
      { callId: "c1", words: 100 },
      { callId: "c1", words: 110 },
      { callId: "c1", words: 300 },
      { callId: "c2", words: 40 },
    ]);
    // 110, not the 170 a mean would hand back after one runaway cell.
    expect(basis.get("c1")).toBe(110);
    expect(basis.get("c2")).toBe(40);
  });

  it("takes the midpoint of an even count, rounded to a whole word", () => {
    // The live pair: AssemblyAI 1,003 words, ElevenLabs 1,047.
    expect(callWordBasis([{ callId: "c", words: 1003 }, { callId: "c", words: 1047 }]).get("c")).toBe(1025);
    // A half word rounds up, so the basis is always a whole word.
    expect(callWordBasis([{ callId: "c", words: 1 }, { callId: "c", words: 2 }]).get("c")).toBe(2);
  });

  it("has no entry for a call it never saw", () => {
    expect(callWordBasis([]).get("c")).toBeUndefined();
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
    expect(v.sentence).toContain("A has the least disagreement: ");
    expect(v.sentence).toContain("50% fewer than B");
    expect(v.sentence).toContain("25 calls.");
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
    expect(v.sentence).toMatch(/^Too close to call: /);
    expect(v.sentence).toContain("24 calls.");
  });

  it("marks the verdict provisional below 20 calls and still attaches the count", () => {
    const cells = [...cellsFor("a", [0, 0, 0, 0, 0, 0]), ...cellsFor("b", [5, 5, 5, 5, 5, 5])];
    const v = computeVerdict(cells);
    expect(v.decision).toBe("winner");
    expect(v.evidenceCalls).toBe(6);
    expect(v.provisional).toBe(true);
    expect(v.sentence).toContain("6 calls (early read, under 20)");
  });

  it("names no winner when the top two share fewer than 5 calls, however big the gap", () => {
    const cells = [...cellsFor("a", [0, 0, 0, 0]), ...cellsFor("b", [5, 5, 5, 5])];
    const v = computeVerdict(cells);
    expect(v.decision).toBe("too_few_calls");
    expect(v.winnerProviderId).toBeNull();
    expect(v.marginPct).toBeNull();
    expect(v.noiseFloor).toBeNull();
    expect(v.leaderProviderId).toBe("a");
    expect(v.sentence).toMatch(/^Not enough calls: /);
    expect(v.sentence).toContain("only 4 calls ran on both");
  });

  it("calls a near-zero gap effectively tied instead of quoting thousands of calls", () => {
    const cells = [
      ...cellsFor("a", Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 1 : 2))),
      ...cellsFor("b", Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 2 : 1))),
    ].map((c, i) => (i === 0 ? { ...c, peerFlagCount: 0 } : c)); // tiny lead for a
    const v = computeVerdict(cells);
    expect(v.decision).toBe("too_close");
    expect(v.callsToSettle).toBeNull();
    expect(v.sentence).toContain("Effectively tied");
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
    expect(v.sentence).toContain("75% fewer than prod (in production today)");
  });

  it("says so when production is already the leader", () => {
    const cells = [...cellsFor("prod", Array.from({ length: 25 }, () => 1)), ...cellsFor("b", Array.from({ length: 25 }, () => 3))];
    const v = computeVerdict(cells, { productionProviderId: "prod" });
    expect(v.productionIsLeader).toBe(true);
    expect(v.vsProductionPct).toBeNull();
    expect(v.sentence).toContain("also in production today");
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

  // R-1 (2026-09-08): live on bulk 42769f26, ElevenLabs and AssemblyAI
  // carried identical peer flags on all 17 calls and ElevenLabs was named
  // winner for writing 4% more words -- filler the flags were never scored
  // on, because flags come off canonicalTranscript and the denominator did
  // not. Both halves are held here: under the old inputs (each provider's
  // own word count) the wordier one MUST win, under the shared basis it
  // must not, or this test is not proving what it claims.
  it("names no winner when the only difference between two providers is verbosity", () => {
    const flags = [0, 1, 2, 0, 3, 1, 0, 2];
    const leanWords = [80, 120, 200, 60, 300, 140, 90, 160];
    const ownWords: VerdictCell[] = flags.flatMap((f, i) => [
      { callId: `c${i}`, providerId: "lean", peerFlagCount: f, words: leanWords[i]! },
      { callId: `c${i}`, providerId: "wordy", peerFlagCount: f, words: leanWords[i]! * 1.1 },
    ]);
    const names = { lean: "Lean", wordy: "Wordy" };

    const before = computeVerdict(ownWords, { providerNames: names });
    expect(before.decision).toBe("winner");
    expect(before.winnerProviderId).toBe("wordy");

    const basis = callWordBasis(ownWords.map((c) => ({ callId: c.callId, words: c.words })));
    const after = computeVerdict(
      ownWords.map((c) => ({ ...c, words: basis.get(c.callId)! })),
      { providerNames: names },
    );
    expect(after.decision).toBe("too_close");
    expect(after.winnerProviderId).toBeNull();
    const [lean, wordy] = after.rates;
    expect(lean!.totalWords).toBe(wordy!.totalWords);
    expect(lean!.flagsPer100Words).toBe(wordy!.flagsPer100Words);
  });

  it("counts confidence-reporting providers for the comparability note", () => {
    const cells = [...cellsFor("a", Array.from({ length: 25 }, () => 0)), ...cellsFor("b", Array.from({ length: 25 }, () => 3))];
    const v = computeVerdict(cells, { confidenceReportingProviderIds: ["a", "zzz-not-in-group"] });
    expect(v.confidenceComparable).toEqual({ reporting: 1, total: 2 });
    expect(v.sentence).not.toContain("report confidence");
  });
});
