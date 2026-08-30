import { describe, expect, it } from "vitest";
import { aggregateWordsToWatch, classifyWatchKind } from "./words-to-watch-aggregate";

const r = (providerId: string, text: string) => ({ providerId, text });

describe("aggregateWordsToWatch (T-87)", () => {
  it("groups spans by plurality text, counts distinct calls, lists alternatives with who said them", () => {
    const out = aggregateWordsToWatch([
      { callId: "c1", majorityText: "peterbilt", readings: [r("a", "peterbilt"), r("b", "peterbilt"), r("c", "peter built")] },
      { callId: "c1", majorityText: "peterbilt", readings: [r("a", "peterbilt"), r("b", "peter belt"), r("c", "peterbilt")] },
      { callId: "c2", majorityText: "peterbilt", readings: [r("a", "peterbilt"), r("b", "peterbilt"), r("c", "peter built")] },
      { callId: "c3", majorityText: "main street", readings: [r("a", "main street"), r("b", "maine street")] },
    ]);
    expect(out.map((w) => w.heardAs)).toEqual(["peterbilt", "main street"]);
    expect(out[0]).toMatchObject({ calls: 2, spans: 3, noMajority: false, kind: "word", exampleCallIds: ["c1", "c2"] });
    expect(out[0]!.alternatives).toEqual([
      { text: "peter built", count: 2, providerIds: ["c"] },
      { text: "peter belt", count: 1, providerIds: ["b"] },
    ]);
  });

  it("keys a tie on the alphabetically first reading and says so", () => {
    const out = aggregateWordsToWatch([{ callId: "c1", majorityText: null, readings: [r("a", "zeta"), r("b", "alpha")] }]);
    expect(out).toEqual([
      { heardAs: "alpha", kind: "word", noMajority: true, calls: 1, spans: 1, alternatives: [{ text: "zeta", count: 1, providerIds: ["a"] }], exampleCallIds: ["c1"] },
    ]);
  });

  it("orders by calls, then spans, and respects the limit", () => {
    const out = aggregateWordsToWatch(
      [
        { callId: "c1", majorityText: "one", readings: [r("a", "one"), r("b", "won")] },
        { callId: "c1", majorityText: "two", readings: [r("a", "two"), r("b", "too")] },
        { callId: "c2", majorityText: "two", readings: [r("a", "two"), r("b", "to")] },
        { callId: "c1", majorityText: "one", readings: [r("a", "one"), r("b", "wan")] },
      ],
      1,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.heardAs).toBe("two");
  });

  it("classifies numbers, fillers and words, and sinks fillers below everything", () => {
    expect(classifyWatchKind(["1 8 5 9", "1 0 8 5 0 9"])).toBe("number");
    expect(classifyWatchKind(["", "um", "uh yeah"])).toBe("filler");
    expect(classifyWatchKind(["peterbilt", "peter built"])).toBe("word");
    expect(classifyWatchKind(["", "0"])).toBe("number");
    const out = aggregateWordsToWatch([
      { callId: "c1", majorityText: "", readings: [r("a", ""), r("b", "um")] },
      { callId: "c2", majorityText: "", readings: [r("a", ""), r("b", "um")] },
      { callId: "c3", majorityText: "", readings: [r("a", ""), r("b", "uh")] },
      { callId: "c1", majorityText: "unit 4", readings: [r("a", "unit 4"), r("b", "unit for")] },
    ]);
    // "" spans split by what the odd provider heard ("um" x2 calls, "uh" x1), both filler, both last.
    expect(out.map((w) => [w.heardAs, w.kind, w.calls])).toEqual([["unit 4", "number", 1], ["", "filler", 2], ["", "filler", 1]]);
  });

  it("splits 'most heard nothing' spans by what the odd provider heard", () => {
    const out = aggregateWordsToWatch([
      { callId: "c1", majorityText: "", readings: [r("a", ""), r("b", ""), r("d", "0")] },
      { callId: "c2", majorityText: "", readings: [r("a", ""), r("b", ""), r("d", "0")] },
      { callId: "c1", majorityText: "", readings: [r("a", ""), r("b", ""), r("c", "sweet")] },
    ]);
    expect(out.map((w) => [w.heardAs, w.calls, w.alternatives[0]!.text])).toEqual([["", 2, "0"], ["", 1, "sweet"]]);
  });

  it("returns nothing from nothing -- never a made-up row", () => {
    expect(aggregateWordsToWatch([])).toEqual([]);
  });
});
