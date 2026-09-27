import { describe, expect, it } from "vitest";
import { bootstrapNoiseFloor, callWordBasis, computeVerdict, pooledRate, productionLead, type VerdictCell } from "./verdict";

function cellsFor(providerId: string, flags: number[], words = 100): VerdictCell[] {
  return flags.map((f, i) => ({ callId: `c${i}`, providerId, peerFlagCount: f, words }));
}

/** R-2a: `n` calls, flagged (one flag) on exactly the calls `flaggedOn` picks. */
function flaggedCalls(providerId: string, n: number, flaggedOn: (i: number) => boolean): VerdictCell[] {
  return cellsFor(providerId, Array.from({ length: n }, (_, i) => (flaggedOn(i) ? 1 : 0)));
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
    // Flagged on 5, 10 and 15 of 25 calls; b's flagged calls include all of a's.
    const cells = [
      ...flaggedCalls("a", 25, (i) => i < 5),
      ...flaggedCalls("b", 25, (i) => i < 10),
      ...flaggedCalls("c", 25, (i) => i < 15),
    ];
    const v = computeVerdict(cells, { providerNames: { a: "A", b: "B", c: "C" } });
    expect(v.decision).toBe("winner");
    expect(v.winnerProviderId).toBe("a");
    expect(v.runnerUpProviderId).toBe("b");
    expect(v.marginPct).toBe(50);
    expect(v.evidenceCalls).toBe(25);
    expect(v.provisional).toBe(false);
    expect(v.sentence).toContain("A has the least disagreement: flagged on 5 of 25 calls");
    expect(v.sentence).toContain("50% fewer flagged calls than B (flagged on 10 of 25 calls)");
    expect(v.sentence).toContain("25 calls.");
  });

  it("refuses to name a winner inside the noise floor and estimates what would settle it", () => {
    // a flagged on 8 of 24, b on 12 -- but on largely different calls, so the
    // per-call differences point both ways.
    const cells = [...flaggedCalls("a", 24, (i) => i < 8), ...flaggedCalls("b", 24, (i) => i >= 4 && i < 16)];
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
    // 14 of 30 against 15 of 30, on opposite calls: a one-call lead.
    const cells = [...flaggedCalls("a", 30, (i) => i % 2 === 1 && i !== 1), ...flaggedCalls("b", 30, (i) => i % 2 === 0)];
    const v = computeVerdict(cells);
    expect(v.decision).toBe("too_close");
    expect(v.callsToSettle).toBeNull();
    expect(v.sentence).toContain("Effectively tied");
  });

  it("compares against production when it was benchmarked and isn't the leader", () => {
    const cells = [
      ...flaggedCalls("a", 25, (i) => i < 5),
      ...flaggedCalls("b", 25, (i) => i < 10),
      ...flaggedCalls("prod", 25, (i) => i < 20),
    ];
    const v = computeVerdict(cells, { productionProviderId: "prod" });
    expect(v.vsProductionPct).toBeCloseTo(75, 10);
    expect(v.productionIsLeader).toBe(false);
    expect(v.sentence).toContain("75% fewer than prod (in production today)");
  });

  it("says so when production is already the leader", () => {
    const cells = [...flaggedCalls("prod", 25, (i) => i < 5), ...flaggedCalls("b", 25, (i) => i < 15)];
    const v = computeVerdict(cells, { productionProviderId: "prod" });
    expect(v.productionIsLeader).toBe(true);
    expect(v.vsProductionPct).toBeNull();
    expect(v.sentence).toContain("also in production today");
  });

  // R-2a: the ranking quantity is the flagged-call rate, not flags per 100
  // words. "few" is flagged on 3 calls with 6 flags each; "many" on 12 calls
  // with one flag each. Per 100 words "few" is worse (18 vs 12 flags) -- the
  // old order -- but it was flagged on a quarter of the calls, so it leads.
  it("ranks by the share of calls flagged, and breaks a tie on flags per 100 words", () => {
    const v = computeVerdict([
      ...cellsFor("few", Array.from({ length: 24 }, (_, i) => (i < 3 ? 6 : 0))),
      ...cellsFor("many", Array.from({ length: 24 }, (_, i) => (i < 12 ? 1 : 0))),
    ]);
    expect(v.leaderProviderId).toBe("few");
    const few = v.rates.find((r) => r.providerId === "few")!;
    const many = v.rates.find((r) => r.providerId === "many")!;
    expect([few.flaggedCalls, few.calls, few.flaggedCallRate]).toEqual([3, 24, 0.125]);
    expect(few.flagsPer100Words).toBeGreaterThan(many.flagsPer100Words);

    // Same flagged calls, different flag totals: the per-100-words rate decides.
    const tie = computeVerdict([
      ...cellsFor("light", Array.from({ length: 10 }, (_, i) => (i < 4 ? 1 : 0))),
      ...cellsFor("heavy", Array.from({ length: 10 }, (_, i) => (i < 4 ? 3 : 0))),
    ]);
    expect(tie.rates.map((r) => r.providerId)).toEqual(["light", "heavy"]);
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
  // winner for writing 4% more words. R-1 fixed it with a shared word basis.
  // R-2a (2026-09-28): the ranking counts flagged CALLS, so word counts can no
  // longer make a WINNER. They can still pick the LEADER of an undecided pair
  // through the per-100-words tiebreak -- which is where R-1 still earns its
  // keep, and what the leader assertions below hold.
  it("names no winner when the only difference between two providers is verbosity", () => {
    const flags = [0, 1, 2, 0, 3, 1, 0, 2];
    const leanWords = [80, 120, 200, 60, 300, 140, 90, 160];
    const ownWords: VerdictCell[] = flags.flatMap((f, i) => [
      { callId: `c${i}`, providerId: "lean", peerFlagCount: f, words: leanWords[i]! },
      { callId: `c${i}`, providerId: "wordy", peerFlagCount: f, words: leanWords[i]! * 1.1 },
    ]);
    const names = { lean: "Lean", wordy: "Wordy" };

    const before = computeVerdict(ownWords, { providerNames: names });
    expect(before.decision).toBe("too_close");
    expect(before.winnerProviderId).toBeNull();
    // R-1 still matters to the TIEBREAK: on own words the wordier provider
    // reads lower per 100 words and leads the undecided pair ("Ahead, but not
    // decided: Wordy") -- exactly R-1's bug, one level down.
    expect(before.leaderProviderId).toBe("wordy");
    expect(before.rates[0]!.flaggedCallRate).toBe(before.rates[1]!.flaggedCallRate);
    expect(before.rates.find((r) => r.providerId === "wordy")!.flagsPer100Words).toBeLessThan(
      before.rates.find((r) => r.providerId === "lean")!.flagsPer100Words,
    );

    const basis = callWordBasis(ownWords.map((c) => ({ callId: c.callId, words: c.words })));
    const after = computeVerdict(
      ownWords.map((c) => ({ ...c, words: basis.get(c.callId)! })),
      { providerNames: names },
    );
    expect(after.decision).toBe("too_close");
    expect(after.winnerProviderId).toBeNull();
    // On the shared basis the per-100 rates are equal, so id decides.
    expect(after.leaderProviderId).toBe("lean");
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

// R-3: the sentence three surfaces say. It is tested here, once, because
// that is the whole reason it lives in scoring rather than in a renderer.
describe("productionLead", () => {
  const live = {
    productionLabel: "deepgram / flux-general-en",
    rate: 0.0657,
    leaderName: "AssemblyAI",
    leaderRate: 0.0261,
    calls: 17,
    totalCalls: 17,
  };

  it("names production, its rate, the closest candidate and the calls behind both", () => {
    const { lead } = productionLead(live);
    expect(lead).toContain("Production today (deepgram / flux-general-en)");
    expect(lead).toContain("6.6 of every 100 caller words");
    expect(lead).toContain("over 17 of 17 calls");
    expect(lead).toContain("The closest candidate on those same words, AssemblyAI, sat at 2.6.");
  });

  it("says which count this is, so 2.6 here is never read as the 0.40 in the table", () => {
    const { caveat } = productionLead(live);
    // The units differ on purpose: word-by-word on the caller's turns here,
    // filtered flags over the whole call's word basis in the ranking. On bulk
    // 42769f26 the same provider reads 2.6 and 0.40. Saying so is the whole
    // job of this line.
    expect(caveat).toContain("word-by-word count on the caller's turns");
    expect(caveat).toContain("not the flagged-call count the verdict ranks by");
    // The two caveats R-3 must not drop.
    expect(caveat).toContain("ran live during the call");
    expect(caveat).toContain("never ranked with them");
  });

  it("drops the candidate clause rather than printing a zero for it", () => {
    const { lead } = productionLead({ ...live, leaderName: null, leaderRate: null });
    expect(lead).not.toContain("closest candidate");
    expect(lead).not.toContain("0.0");
    expect(lead).toContain("6.6 of every 100 caller words");
  });

  it("says who it is even when no call recorded the live transcriber", () => {
    const { lead } = productionLead({ ...live, productionLabel: null });
    expect(lead).toContain("The transcriber in production today");
    expect(lead).not.toContain("(null)");
  });

  it("carries the org's name only when it is given one", () => {
    expect(productionLead(live).lead.startsWith("Production today")).toBe(true);
    expect(productionLead({ ...live, orgLabel: "Land And Apartment" }).lead).toContain("Land And Apartment: Production today");
  });

  it("keeps one call singular", () => {
    expect(productionLead({ ...live, calls: 1, totalCalls: 1 }).lead).toContain("over 1 of 1 call.");
  });
});
