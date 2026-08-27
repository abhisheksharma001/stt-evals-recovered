import { describe, expect, it } from "vitest";
import { PollTimeoutError, pollUntil, scaledPollTimeoutMs } from "./poll";

// T-8 (base-solidity fix): a fixed 120s poll timeout meant any call whose
// async job legitimately ran longer threw prematurely. scaledPollTimeoutMs
// is the pure function deciding the new bound -- covered directly since the
// adapters themselves need real network calls to exercise end to end.
describe("scaledPollTimeoutMs", () => {
  it("falls back to 120s when duration is unknown", () => {
    expect(scaledPollTimeoutMs(null)).toBe(120_000);
    expect(scaledPollTimeoutMs(undefined)).toBe(120_000);
    expect(scaledPollTimeoutMs(0)).toBe(120_000);
  });

  it("scales to 3x realtime for a normal call", () => {
    expect(scaledPollTimeoutMs(60)).toBe(180_000); // 60s call -> 180s
  });

  it("floors at 60s even for a very short call", () => {
    expect(scaledPollTimeoutMs(5)).toBe(60_000);
  });

  it("caps at 15 minutes even for a very long call", () => {
    expect(scaledPollTimeoutMs(3600)).toBe(900_000); // 1hr call would be 3hr uncapped
  });
});

describe("pollUntil", () => {
  it("resolves as soon as fn returns non-null", async () => {
    let calls = 0;
    const result = await pollUntil(async () => {
      calls += 1;
      return calls === 2 ? "done" : null;
    }, { intervalMs: 1 });
    expect(result).toBe("done");
    expect(calls).toBe(2);
  });

  it("throws a checkable PollTimeoutError, not a generic Error, once the deadline passes", async () => {
    await expect(
      pollUntil(async () => null, { intervalMs: 1, timeoutMs: 5 }),
    ).rejects.toBeInstanceOf(PollTimeoutError);
  });
});
