// R-7. These numbers go into PRD v7 Part E as a build / don't-build decision,
// so the arithmetic is proved here against synthetic cells rather than by
// re-reading the corpus -- the same reason M-15 put its rules in a lib.
import { describe, expect, it } from "vitest";
import { signalStats, type SignalCell } from "./triage-signals";

const RULE = { liftMarginPoints: 10, maxSelectedShare: 0.8 };

/** `sf` selected+flagged, `sc` selected+clean, `rf` rest+flagged, `rc` rest+clean. */
const cells = (sf: number, sc: number, rf: number, rc: number): SignalCell[] => [
  ...Array.from({ length: sf }, () => ({ selected: true, flagged: true })),
  ...Array.from({ length: sc }, () => ({ selected: true, flagged: false })),
  ...Array.from({ length: rf }, () => ({ selected: false, flagged: true })),
  ...Array.from({ length: rc }, () => ({ selected: false, flagged: false })),
];

describe("signalStats (R-7)", () => {
  it("counts a plain 2x2 and derives every rate from it", () => {
    const s = signalStats(cells(15, 5, 10, 70), RULE);
    expect([s.selectedFlagged, s.selectedClean, s.restFlagged, s.restClean]).toEqual([15, 5, 10, 70]);
    expect(s.population).toBe(100);
    expect(s.selected).toBe(20);
    expect(s.precision).toBeCloseTo(0.75);
    expect(s.recall).toBeCloseTo(0.6);
    expect(s.base).toBeCloseTo(0.25);
    expect(s.lift).toBeCloseTo(0.5);
    expect(s.headroom).toBeCloseTo(75);
    expect(s.verdict).toBe("seed");
  });

  it("calls a high base rate untestable rather than failed", () => {
    // 95 of 100 flagged: the ceiling on lift is 5 points, so a 10-point margin
    // cannot be met by ANY signal. This is the live corpus's shape, and the
    // distinction is the whole finding -- "no" here would claim the signal was
    // measured against a fair bar.
    const s = signalStats(cells(19, 1, 76, 4), RULE);
    expect(s.base).toBeCloseTo(0.95);
    expect(s.headroom).toBeCloseTo(5);
    expect(s.headroom).toBeLessThan(RULE.liftMarginPoints);
    expect(s.verdict).toBe("untestable");
  });

  it("says plain no when the signal had room and missed anyway", () => {
    // Base 50%, so 50 points of headroom -- the bar was reachable and this
    // signal did not clear it.
    const s = signalStats(cells(11, 9, 39, 41), RULE);
    expect(s.headroom).toBeGreaterThan(RULE.liftMarginPoints);
    expect(s.lift * 100).toBeLessThan(RULE.liftMarginPoints);
    expect(s.verdict).toBe("no");
  });

  it("refuses a signal that selects nearly everything, however precise", () => {
    // Precision 1.0 and lift ~10 points, but it picks 90 of 100 calls: a
    // trigger that fires on everything is not a trigger.
    //
    // The margin is 5 here, not the usual 10, on purpose. At a 90 % selected
    // share the arithmetic caps lift at exactly 10 points, so against a
    // 10-point margin this signal fails on the margin anyway (and floating
    // point puts it at 9.999...): the share ceiling would never be the clause
    // doing the work, and deleting it would break nothing. A break test found
    // exactly that. With the margin at 5 the ceiling is the only thing
    // standing between this signal and "seed".
    const s = signalStats(cells(90, 0, 0, 10), { liftMarginPoints: 5, maxSelectedShare: 0.8 });
    expect(s.precision).toBe(1);
    expect(s.lift * 100).toBeGreaterThan(5);
    expect(s.selected / s.population).toBeCloseTo(0.9);
    expect(s.verdict).not.toBe("seed");
  });

  it("keeps the seed when it clears the bar on tight headroom", () => {
    // Base 88%, headroom 12 points, lift 12 points: tight, but measured and
    // passed. "untestable" must never overwrite a real pass.
    const s = signalStats(cells(50, 0, 38, 12), RULE);
    expect(s.headroom).toBeCloseTo(12);
    expect(s.lift * 100).toBeGreaterThanOrEqual(RULE.liftMarginPoints);
    expect(s.verdict).toBe("seed");
  });

  it("never returns untestable when the rule was actually met", () => {
    // Guards the branch order in signalStats: a seed must survive the
    // untestable check. Cannot be reached by a high base rate -- lift can
    // never exceed headroom -- so it is asserted directly instead.
    const s = signalStats(cells(50, 0, 38, 12), RULE);
    expect(s.verdict).toBe("seed");
    expect(["untestable", "no"]).not.toContain(s.verdict);
  });

  it("invents nothing on an empty population", () => {
    const s = signalStats([], RULE);
    expect([s.population, s.selected, s.precision, s.recall, s.base]).toEqual([0, 0, 0, 0, 0]);
    // Headroom is 100 with no data, so this must not read as "untestable" --
    // there is simply nothing to test.
    expect(s.verdict).toBe("no");
  });
});
