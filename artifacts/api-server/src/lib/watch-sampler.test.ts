import { describe, expect, it } from "vitest";
import { sampleForDay, type SampleCandidate } from "./watch-sampler";

const SCHEDULE = "11111111-2222-3333-4444-555555555555";

/** n calls for one agent, ids `<agent>-0` .. `<agent>-(n-1)`. */
const callsFor = (assistantId: string | null, n: number): SampleCandidate[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${assistantId ?? "none"}-${i}`, assistantId }));

const only = (assistantId: string | null, out: ReturnType<typeof sampleForDay>) =>
  out.picks.find((p) => p.assistantId === assistantId)!;

describe("sampleForDay (W-3)", () => {
  it("draws the same ids in the same order for the same schedule and day", () => {
    const calls = callsFor("agent-a", 12);
    const first = sampleForDay({ scheduleId: SCHEDULE, day: "2026-09-14", sampleSize: 5, calls });
    const second = sampleForDay({ scheduleId: SCHEDULE, day: "2026-09-14", sampleSize: 5, calls });
    expect(second).toEqual(first);
    // Not a fluke of a short list: five distinct ids, all from the input.
    expect(new Set(first.picks[0]!.callIds).size).toBe(5);
    expect(calls.map((c) => c.id)).toEqual(expect.arrayContaining(first.picks[0]!.callIds));
  });

  it("changes the order when the day changes", () => {
    const calls = callsFor("agent-a", 12);
    const mon = sampleForDay({ scheduleId: SCHEDULE, day: "2026-09-14", sampleSize: 12, calls });
    const tue = sampleForDay({ scheduleId: SCHEDULE, day: "2026-09-15", sampleSize: 12, calls });
    expect(tue.picks[0]!.callIds).not.toEqual(mon.picks[0]!.callIds);
    // A different order, not a different set -- the whole day was drawn both times.
    expect([...tue.picks[0]!.callIds].sort()).toEqual([...mon.picks[0]!.callIds].sort());
  });

  it("changes the draw when the schedule changes, on the same day", () => {
    const calls = callsFor("agent-a", 12);
    const mine = sampleForDay({ scheduleId: SCHEDULE, day: "2026-09-14", sampleSize: 12, calls });
    const theirs = sampleForDay({ scheduleId: "99999999-8888-7777-6666-555555555555", day: "2026-09-14", sampleSize: 12, calls });
    expect(theirs.picks[0]!.callIds).not.toEqual(mine.picks[0]!.callIds);
  });

  it("returns everything it has and reports the shortfall when the agent was quiet", () => {
    const out = sampleForDay({
      scheduleId: SCHEDULE,
      day: "2026-09-14",
      sampleSize: 10,
      calls: callsFor("agent-quiet", 3),
    });
    const pick = only("agent-quiet", out);
    expect(pick.callIds).toHaveLength(3);
    expect([...pick.callIds].sort()).toEqual(["agent-quiet-0", "agent-quiet-1", "agent-quiet-2"]);
    expect(pick.matched).toBe(3);
    expect(pick.shortfall).toBe(7);
  });

  it("reports no shortfall when the agent had enough", () => {
    const out = sampleForDay({ scheduleId: SCHEDULE, day: "2026-09-14", sampleSize: 4, calls: callsFor("agent-busy", 40) });
    expect(only("agent-busy", out)).toMatchObject({ matched: 40, shortfall: 0 });
    expect(only("agent-busy", out).callIds).toHaveLength(4);
  });

  it("samples per agent, not from one pool, and never lets one agent move another's draw", () => {
    const a = callsFor("agent-a", 12);
    const b = callsFor("agent-b", 12);
    const both = sampleForDay({ scheduleId: SCHEDULE, day: "2026-09-14", sampleSize: 5, calls: [...a, ...b] });
    // Per agent: five each, not five between them.
    expect(both.picks.map((p) => p.callIds.length)).toEqual([5, 5]);
    expect(only("agent-a", both).callIds.every((id) => id.startsWith("agent-a-"))).toBe(true);

    // agent-b goes quiet tomorrow-that-is-still-today: agent-a's draw must not move.
    const aloneA = sampleForDay({ scheduleId: SCHEDULE, day: "2026-09-14", sampleSize: 5, calls: a });
    expect(only("agent-a", both).callIds).toEqual(only("agent-a", aloneA).callIds);
    // Nor may the order the calls arrived in change anything.
    const reversed = sampleForDay({ scheduleId: SCHEDULE, day: "2026-09-14", sampleSize: 5, calls: [...b, ...a] });
    expect(reversed).toEqual(both);
  });

  it("keeps calls with no assistant on file as their own bucket, listed last", () => {
    const out = sampleForDay({
      scheduleId: SCHEDULE,
      day: "2026-09-14",
      sampleSize: 2,
      calls: [...callsFor(null, 3), ...callsFor("agent-z", 3), ...callsFor("agent-a", 3)],
    });
    expect(out.picks.map((p) => p.assistantId)).toEqual(["agent-a", "agent-z", null]);
    expect(only(null, out)).toMatchObject({ matched: 3, shortfall: 0 });
  });

  it("leaves the caller's array alone", () => {
    const calls = callsFor("agent-a", 8);
    const before = calls.map((c) => c.id);
    sampleForDay({ scheduleId: SCHEDULE, day: "2026-09-14", sampleSize: 3, calls });
    expect(calls.map((c) => c.id)).toEqual(before);
  });

  it("has nothing to say about a day with no calls", () => {
    expect(sampleForDay({ scheduleId: SCHEDULE, day: "2026-09-14", sampleSize: 10, calls: [] })).toEqual({ picks: [] });
  });
});
