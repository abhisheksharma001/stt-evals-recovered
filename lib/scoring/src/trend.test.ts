import { describe, expect, it } from "vitest";
import { buildTrend, TREND_MIN_CALLS_FOR_DIRECTION, type TrendBulk, type TrendCell } from "./trend";

const bulks: TrendBulk[] = [
  { id: "b2", name: "second", at: "2026-08-20T00:00:00Z", status: "complete" },
  { id: "b1", name: "first", at: "2026-08-10T00:00:00Z", status: "complete" },
  { id: "b3", name: "third", at: "2026-08-28T00:00:00Z", status: "partial" },
];

const cell = (over: Partial<TrendCell>): TrendCell => ({
  bulkId: "b1",
  accountLabel: "Rush",
  assistantId: "asst-a",
  providerId: "p1",
  providerName: "Prov One",
  peerFlags: 0,
  words: 0,
  callsScored: 0,
  cleanCalls: 0,
  ...over,
});

describe("buildTrend", () => {
  it("orders bulks by time and gives every provider one point per bulk", () => {
    const cells = [
      cell({ bulkId: "b1", peerFlags: 10, words: 1000, callsScored: 10, cleanCalls: 4 }),
      cell({ bulkId: "b3", peerFlags: 30, words: 1000, callsScored: 10, cleanCalls: 1 }),
    ];
    const t = buildTrend(cells, bulks);
    expect(t.bulks.map((b) => b.id)).toEqual(["b1", "b2", "b3"]);
    expect(t.series).toHaveLength(1);
    const pts = t.series[0]!.points;
    expect(pts.map((p) => p.bulkId)).toEqual(["b1", "b2", "b3"]);
    expect(pts[0]!.peerFlagsPer100Words).toBeCloseTo(1.0);
    expect(pts[0]!.cleanCallRate).toBeCloseTo(0.4);
    // b2 was never scored by this provider: null, not 0.
    expect(pts[1]).toEqual({ bulkId: "b2", peerFlagsPer100Words: null, cleanCallRate: null, callsScored: 0 });
    expect(pts[2]!.peerFlagsPer100Words).toBeCloseTo(3.0);
  });

  it("calls a regression when the last two evidenced bulks move by more than the flat band", () => {
    const cells = [
      cell({ bulkId: "b1", peerFlags: 10, words: 1000, callsScored: 10, cleanCalls: 4 }),
      cell({ bulkId: "b3", peerFlags: 30, words: 1000, callsScored: 10, cleanCalls: 1 }),
    ];
    const s = buildTrend(cells, bulks).series[0]!;
    expect(s.latest?.bulkId).toBe("b3");
    expect(s.previous?.bulkId).toBe("b1"); // skips the unscored b2
    expect(s.deltaPer100Words).toBeCloseTo(2.0);
    expect(s.direction).toBe("worse");
  });

  it("reads a tiny move as flat and an improvement as better", () => {
    const flat = buildTrend(
      [
        cell({ bulkId: "b1", peerFlags: 100, words: 10000, callsScored: 10, cleanCalls: 1 }),
        cell({ bulkId: "b2", peerFlags: 102, words: 10000, callsScored: 10, cleanCalls: 1 }),
      ],
      bulks,
    ).series[0]!;
    expect(flat.direction).toBe("flat");
    const better = buildTrend(
      [
        cell({ bulkId: "b1", peerFlags: 100, words: 1000, callsScored: 10, cleanCalls: 1 }),
        cell({ bulkId: "b2", peerFlags: 50, words: 1000, callsScored: 10, cleanCalls: 5 }),
      ],
      bulks,
    ).series[0]!;
    expect(better.deltaPer100Words).toBeCloseTo(-5);
    expect(better.direction).toBe("better");
  });

  it("refuses a direction on thin evidence but still reports the delta", () => {
    const s = buildTrend(
      [
        cell({ bulkId: "b1", peerFlags: 1, words: 100, callsScored: TREND_MIN_CALLS_FOR_DIRECTION, cleanCalls: 0 }),
        cell({ bulkId: "b2", peerFlags: 5, words: 100, callsScored: 2, cleanCalls: 0 }),
      ],
      bulks,
    ).series[0]!;
    expect(s.deltaPer100Words).toBeCloseTo(4);
    expect(s.direction).toBe("unknown");
  });

  it("pools assistants into a client exactly (sums, not averaged rates) and scopes both ways", () => {
    const cells = [
      cell({ bulkId: "b1", assistantId: "asst-a", peerFlags: 1, words: 100, callsScored: 5, cleanCalls: 4 }),
      cell({ bulkId: "b1", assistantId: "asst-b", peerFlags: 9, words: 900, callsScored: 5, cleanCalls: 0 }),
      cell({ bulkId: "b1", accountLabel: "Other Co", assistantId: "asst-z", peerFlags: 50, words: 100, callsScored: 5, cleanCalls: 0 }),
    ];
    const client = buildTrend(cells, bulks, { accountLabel: "Rush" }).series[0]!.points[0]!;
    // (1+9)/(100+900)*100 = 1.0 -- an average of the two rates would be 1.0 too here,
    // so use the clean rate to prove pooling: (4+0)/(5+5) = 0.4.
    expect(client.peerFlagsPer100Words).toBeCloseTo(1.0);
    expect(client.cleanCallRate).toBeCloseTo(0.4);
    expect(client.callsScored).toBe(10);

    const one = buildTrend(cells, bulks, { assistantId: "asst-a" }).series[0]!.points[0]!;
    expect(one.cleanCallRate).toBeCloseTo(0.8);

    const all = buildTrend(cells, bulks).series[0]!.points[0]!;
    expect(all.callsScored).toBe(15);
    expect(all.peerFlagsPer100Words).toBeCloseTo((60 / 1100) * 100);
  });

  it("matches a null account label only when asked for null explicitly", () => {
    const cells = [
      cell({ bulkId: "b1", accountLabel: null, peerFlags: 1, words: 100, callsScored: 1, cleanCalls: 0 }),
      cell({ bulkId: "b1", accountLabel: "Rush", peerFlags: 1, words: 100, callsScored: 1, cleanCalls: 0 }),
    ];
    expect(buildTrend(cells, bulks, { accountLabel: null }).series[0]!.points[0]!.callsScored).toBe(1);
    expect(buildTrend(cells, bulks, { accountLabel: "Rush" }).series[0]!.points[0]!.callsScored).toBe(1);
    expect(buildTrend(cells, bulks).series[0]!.points[0]!.callsScored).toBe(2);
  });

  it("ignores cells for bulks not in the list and returns no series when nothing is in scope", () => {
    const t = buildTrend([cell({ bulkId: "ghost", peerFlags: 1, words: 10, callsScored: 1, cleanCalls: 0 })], bulks);
    expect(t.series).toEqual([]);
    expect(buildTrend([], bulks, { accountLabel: "nobody" }).series).toEqual([]);
  });
});
