import { describe, expect, it } from "vitest";
import { durationSecondsOf } from "./vapi";
import { scaledPollTimeoutMs } from "@workspace/stt-providers";

// R-42 (ox-alpha B-98). The import route used to store
// `Math.max(1, durationSecondsOf(call))`, which made "we do not know how long
// this call was" indistinguishable from "this call was one second" -- at
// import time, permanently, and disagreeing with the preview route two above
// it, which shows the true 0.
const call = (over: Record<string, unknown> = {}) =>
  ({ id: "c1", ...over }) as never;

describe("durationSecondsOf", () => {
  it("is 0 when the call never started", () => {
    expect(durationSecondsOf(call({ endedAt: "2026-09-01T00:01:00Z" }))).toBe(0);
  });

  it("is 0 when the call never ended -- the crashed-call case", () => {
    expect(durationSecondsOf(call({ startedAt: "2026-09-01T00:00:00Z" }))).toBe(0);
  });

  it("is 0 for a non-positive delta rather than a negative number", () => {
    expect(
      durationSecondsOf(
        call({ startedAt: "2026-09-01T00:01:00Z", endedAt: "2026-09-01T00:00:00Z" }),
      ),
    ).toBe(0);
  });

  it("is 0 for an unparseable timestamp, not NaN", () => {
    expect(durationSecondsOf(call({ startedAt: "not-a-date", endedAt: "also-not" }))).toBe(0);
  });

  it("rounds a real duration to whole seconds", () => {
    expect(
      durationSecondsOf(
        call({ startedAt: "2026-09-01T00:00:00Z", endedAt: "2026-09-01T00:01:40Z" }),
      ),
    ).toBe(100);
  });
});

// The reason 0 is not merely "more honest" but also safer: duration steers one
// piece of behaviour, and the fabricated 1 steered it worse than 0 does.
describe("what the fabricated 1 did to the poll timeout", () => {
  it("gives an unknown-length call the default budget, not a one-second one", () => {
    expect(scaledPollTimeoutMs(0)).toBe(120_000);
    expect(scaledPollTimeoutMs(1)).toBe(60_000);
    expect(scaledPollTimeoutMs(0)).toBeGreaterThan(scaledPollTimeoutMs(1));
  });
});
