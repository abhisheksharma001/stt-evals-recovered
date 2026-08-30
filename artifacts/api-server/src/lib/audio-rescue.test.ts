import { describe, expect, it } from "vitest";
import { planAudioRescue } from "./audio-rescue-plan";
import { isPastVapiRetention } from "./vapi-retention";

const NOW = new Date("2026-08-31T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("isPastVapiRetention", () => {
  it("a call with no start date is never 'past retention' -- unknown age is unknown, not expired", () => {
    expect(isPastVapiRetention(null, NOW)).toBe(false);
  });

  it("day 13 is inside the window, day 15 is past it", () => {
    expect(isPastVapiRetention(daysAgo(13), NOW)).toBe(false);
    expect(isPastVapiRetention(daysAgo(15), NOW)).toBe(true);
  });
});

describe("planAudioRescue", () => {
  const call = (id: string, ageDays: number | null) => ({
    id,
    label: `vapi-${id}`,
    sourceStartedAt: ageDays === null ? null : daysAgo(ageDays),
  });

  it("splits calls into already-cached / attempt / expired", () => {
    const plan = planAudioRescue(
      [call("a", 2), call("b", 20), call("c", null), call("d", 5)],
      new Set(["d"]),
      NOW,
    );
    expect(plan.attempt.map((c) => c.id)).toEqual(["a", "c"]);
    expect(plan.expired.map((c) => c.id)).toEqual(["b"]);
    expect(plan.alreadyCachedCount).toBe(1);
  });

  it("a cached call is never attempted, even when past retention -- cached audio outlives the window", () => {
    const plan = planAudioRescue([call("old", 30)], new Set(["old"]), NOW);
    expect(plan.attempt).toEqual([]);
    expect(plan.expired).toEqual([]);
    expect(plan.alreadyCachedCount).toBe(1);
  });

  it("an empty corpus plans nothing", () => {
    expect(planAudioRescue([], new Set(), NOW)).toEqual({
      attempt: [],
      expired: [],
      alreadyCachedCount: 0,
    });
  });
});
