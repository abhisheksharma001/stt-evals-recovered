import { describe, expect, it } from "vitest";
import { aggregateDisagreement } from "./call-disagreement-aggregate";

describe("aggregateDisagreement (T-85)", () => {
  it("sums peer flags per call, most disagreement first, and drops unscored cells", () => {
    const out = aggregateDisagreement([
      { callId: "quiet", providerId: "a", peerFlagCount: 0 },
      { callId: "quiet", providerId: "b", peerFlagCount: 1 },
      { callId: "ugly", providerId: "a", peerFlagCount: 4 },
      { callId: "ugly", providerId: "b", peerFlagCount: 3 },
      { callId: "ugly", providerId: "c", peerFlagCount: null },
      { callId: "unscored", providerId: "a", peerFlagCount: null },
    ]);
    expect(out).toEqual([
      { callId: "ugly", disagreements: 7, providers: 2 },
      { callId: "quiet", disagreements: 1, providers: 2 },
    ]);
  });

  it("breaks ties by callId so the order is stable", () => {
    const out = aggregateDisagreement([
      { callId: "b", providerId: "x", peerFlagCount: 2 },
      { callId: "a", providerId: "x", peerFlagCount: 2 },
    ]);
    expect(out.map((c) => c.callId)).toEqual(["a", "b"]);
  });
});
