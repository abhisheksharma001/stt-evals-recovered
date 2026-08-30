import { describe, expect, it } from "vitest";
import { RETENTION_WARNING_DAYS, retentionState, VAPI_RETENTION_WINDOW_DAYS } from "./retention";

const NOW = new Date("2026-08-31T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("retentionState", () => {
  it("cached wins outright -- a saved call is safe at any age", () => {
    expect(retentionState(daysAgo(400), true, null, NOW)).toEqual({ kind: "saved" });
    expect(retentionState(null, true, null, NOW)).toEqual({ kind: "saved" });
  });

  it("a recorded source refusal beats age math -- even with no date, even young (T-131)", () => {
    expect(retentionState(null, false, "source_refused", NOW)).toEqual({ kind: "refused" })
    expect(retentionState(daysAgo(12), false, "source_refused", NOW)).toEqual({ kind: "refused" })
    // ...but bytes on disk beat everything, refusal included.
    expect(retentionState(daysAgo(12), true, "source_refused", NOW)).toEqual({ kind: "saved" })
  });

  it("no source date and not cached: null, never an invented state", () => {
    expect(retentionState(null, false, null, NOW)).toBeNull();
    expect(retentionState(undefined, undefined, null, NOW)).toBeNull();
  });

  it("young and uncached: quiet -- nothing to warn about yet", () => {
    expect(retentionState(daysAgo(RETENTION_WARNING_DAYS - 1), false, null, NOW)).toBeNull();
  });

  it("inside the warning band it counts down the days left", () => {
    expect(retentionState(daysAgo(RETENTION_WARNING_DAYS), false, null, NOW)).toEqual({
      kind: "expiring",
      age: RETENTION_WARNING_DAYS,
      daysLeft: VAPI_RETENTION_WINDOW_DAYS - RETENTION_WARNING_DAYS,
    });
    expect(retentionState(daysAgo(VAPI_RETENTION_WINDOW_DAYS - 1), false, null, NOW)).toEqual({
      kind: "expiring",
      age: VAPI_RETENTION_WINDOW_DAYS - 1,
      daysLeft: 1,
    });
  });

  it("past the window and uncached is gone -- a fact now, not a guess", () => {
    expect(retentionState(daysAgo(VAPI_RETENTION_WINDOW_DAYS), false, null, NOW)).toEqual({
      kind: "gone",
      age: VAPI_RETENTION_WINDOW_DAYS,
    });
    expect(retentionState(daysAgo(30), false, null, NOW)).toEqual({ kind: "gone", age: 30 });
  });

  it("audioCached absent (old API, write response) degrades to the age-only warning", () => {
    expect(retentionState(daysAgo(30), undefined, null, NOW)).toEqual({ kind: "gone", age: 30 });
  });
});
