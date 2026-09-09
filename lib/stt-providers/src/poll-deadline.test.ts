// R-48: `timeoutMs` used to be advisory. `pollUntil` read the deadline only
// after `fn()` resolved, so one stalled poll GET held the worker slot, the
// vendor concurrency slot and the run's advisory-lock client for as long as
// undici was willing to wait -- minutes past a budget of seconds. There is no
// AbortSignal anywhere in this package, so nothing else bounded it.
//
// These use real timers and single-digit millisecond budgets: the thing under
// test is elapsed time, and a fake clock would prove only that the fake clock
// advances.
import { describe, expect, it } from "vitest";
import { PollTimeoutError, pollUntil } from "./poll";

const never = () => new Promise<string | null>(() => {});

describe("pollUntil enforces its budget while fn is still running", () => {
  it("gives up on a poll that never resolves", async () => {
    const startedAt = Date.now();
    await expect(pollUntil(never, { intervalMs: 1, timeoutMs: 20 })).rejects.toBeInstanceOf(
      PollTimeoutError,
    );
    // The regression: before R-48 this awaited `never()` forever.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("does not sleep past the deadline to issue one more request", async () => {
    let calls = 0;
    const startedAt = Date.now();
    await expect(
      pollUntil(
        async () => {
          calls += 1;
          return null;
        },
        // An interval far longer than the budget: the old loop slept the whole
        // interval and then polled once more, spending 500ms of a 20ms budget.
        { intervalMs: 500, timeoutMs: 20 },
      ),
    ).rejects.toBeInstanceOf(PollTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(calls).toBeGreaterThan(0);
  });

  // A poll abandoned by the race can still reject later. Without a catch of its
  // own that is an unhandled rejection, which is its own way to kill the
  // process -- the same shape as R-45.
  it("leaves no unhandled rejection behind when the abandoned poll fails later", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        pollUntil(
          () =>
            new Promise<string | null>((_resolve, reject) => {
              setTimeout(() => reject(new Error("poll GET failed after we stopped waiting")), 40);
            }),
          { intervalMs: 1, timeoutMs: 5 },
        ),
      ).rejects.toBeInstanceOf(PollTimeoutError);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("still returns the moment a poll succeeds inside the budget", async () => {
    let calls = 0;
    const result = await pollUntil(
      async () => {
        calls += 1;
        return calls === 3 ? "done" : null;
      },
      { intervalMs: 1, timeoutMs: 5_000 },
    );
    expect(result).toBe("done");
    expect(calls).toBe(3);
  });

  it("propagates a poll's own error unchanged instead of turning it into a timeout", async () => {
    await expect(
      pollUntil(
        async () => {
          throw new Error("provider said 500");
        },
        { intervalMs: 1, timeoutMs: 5_000 },
      ),
    ).rejects.toThrow("provider said 500");
  });
});
