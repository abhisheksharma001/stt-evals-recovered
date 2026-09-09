import { describe, expect, it } from "vitest";
import { cellFailureMessage } from "./cell-failure-message";

// R-40 (ox-alpha B-71). The message used to interpolate CELL_MAX_ATTEMPTS
// unconditionally, so a cell that broke on its first attempt was recorded as
// having failed "after 3 attempt(s)".
describe("cellFailureMessage", () => {
  it("says nothing about attempts when only one was made", () => {
    // A 401 breaks the loop immediately. Claiming three attempts sends an
    // operator hunting a flaky provider that was refused exactly once.
    expect(cellFailureMessage("Deepgram returned HTTP 401", 1, true)).toBe(
      "Deepgram returned HTTP 401",
    );
  });

  it("reports the attempts actually made, not the ceiling", () => {
    expect(cellFailureMessage("timed out", 2, true)).toBe("timed out (after 2 attempts)");
    expect(cellFailureMessage("timed out", 3, true)).toBe("timed out (after 3 attempts)");
  });

  it("says nothing when there was no recorded outcome to count", () => {
    expect(cellFailureMessage("provider failed after all retry attempts", 3, false)).toBe(
      "provider failed after all retry attempts",
    );
  });

  it("is a no-op on a zero count, which means the loop never ran", () => {
    expect(cellFailureMessage("x", 0, true)).toBe("x");
  });

  it("leaves the underlying message untouched", () => {
    const m = "AssemblyAI upload returned HTTP 500: {}";
    expect(cellFailureMessage(m, 3, true).startsWith(m)).toBe(true);
  });

  // The phrase isRetryableOutcome greps for must not be introduced here.
  it("never adds the words that would make a dead cell look retryable", () => {
    expect(cellFailureMessage("x", 3, true)).not.toContain("safe to retry");
  });
});
