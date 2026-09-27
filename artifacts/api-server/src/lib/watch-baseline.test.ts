// W-6a: the baseline band, proved against fixtures rather than against the
// corpus. Every case here is a series of days a real schedule could produce.
import { describe, expect, it } from "vitest";
import { MIN_BASELINE_DAYS, watchBaseline, type BaselineDay } from "./watch-baseline";

/** n days at one rate, ids `d0`..`d(n-1)`, each scored on 10 calls. */
const flat = (n: number, rate: number): BaselineDay[] =>
  Array.from({ length: n }, (_, i) => ({
    day: `2026-09-${String(i + 1).padStart(2, "0")}`,
    flagsPer100Words: rate,
    callsScored: 10,
  }));

/** One day per rate, in order, each scored on 10 calls. */
const days = (rates: number[]): BaselineDay[] =>
  rates.map((r, i) => ({
    day: `2026-09-${String(i + 1).padStart(2, "0")}`,
    flagsPer100Words: r,
    callsScored: 10,
  }));

const today = (rate: number, callsScored = 10): BaselineDay => ({
  day: "2026-09-30",
  flagsPer100Words: rate,
  callsScored,
});

describe("watchBaseline", () => {
  it("reads forming below seven settled days, and is never moved there", () => {
    // Six days flat at 2.0 and a day at 40 -- as far outside as it gets. Still
    // forming: the band does not exist yet, so nothing can fall outside it.
    const out = watchBaseline({ today: today(40), prior: flat(MIN_BASELINE_DAYS - 1, 2) });
    expect(out.state).toBe("forming");
    expect(out.priorDays).toBe(6);
    // No band, no numbers. An unknown is never rendered as a confident 0.
    expect(out.low).toBeNull();
    expect(out.high).toBeNull();
  });

  it("counts only the days it was given, so a refused day is not a day", () => {
    // The caller drops refused and unsettled days before calling. Seven
    // measured days spanning three calendar weeks still make a band.
    const sparse: BaselineDay[] = [
      { day: "2026-09-01", flagsPer100Words: 2.0, callsScored: 10 },
      { day: "2026-09-04", flagsPer100Words: 2.1, callsScored: 10 },
      { day: "2026-09-09", flagsPer100Words: 1.9, callsScored: 10 },
      { day: "2026-09-11", flagsPer100Words: 2.2, callsScored: 10 },
      { day: "2026-09-15", flagsPer100Words: 2.0, callsScored: 10 },
      { day: "2026-09-19", flagsPer100Words: 2.3, callsScored: 10 },
      { day: "2026-09-26", flagsPer100Words: 1.8, callsScored: 10 },
    ];
    const out = watchBaseline({ today: today(2.05), prior: sparse });
    expect(out.state).toBe("steady");
    expect(out.priorDays).toBe(MIN_BASELINE_DAYS);
  });

  it("is steady when today sits inside its own trailing band", () => {
    const out = watchBaseline({ today: today(2.2), prior: days([1.8, 2.0, 2.1, 2.3, 2.5, 1.9, 2.4]) });
    expect(out.state).toBe("steady");
    expect(out.low).toBe(1.8);
    expect(out.high).toBe(2.5);
  });

  it("is moved when today runs hotter than every day behind it", () => {
    const out = watchBaseline({ today: today(6.4), prior: days([1.8, 2.0, 2.1, 2.3, 2.5, 1.9, 2.4]) });
    expect(out.state).toBe("moved");
  });

  it("is moved when today runs colder too -- a drop is a change", () => {
    // Not only a regression: a transcriber that suddenly agrees with its peers
    // far more than it ever has is also something changing underneath.
    const out = watchBaseline({ today: today(0.2), prior: days([1.8, 2.0, 2.1, 2.3, 2.5, 1.9, 2.4]) });
    expect(out.state).toBe("moved");
  });

  it("is steady on an outlying day that scored fewer than five calls", () => {
    // The register's break test. 6.4 is far outside the band and would be
    // `moved` on a full day -- on four calls it is a thin day, not a change.
    const out = watchBaseline({
      today: today(6.4, 4),
      prior: days([1.8, 2.0, 2.1, 2.3, 2.5, 1.9, 2.4]),
    });
    expect(out.state).toBe("steady");
  });

  it("is steady with the band still reported when nothing was measured today", () => {
    const out = watchBaseline({ today: null, prior: days([1.8, 2.0, 2.1, 2.3, 2.5, 1.9, 2.4]) });
    expect(out.state).toBe("steady");
    expect(out.low).toBe(1.8);
    expect(out.high).toBe(2.5);
  });

  it("is steady exactly on the edge -- outside means strictly outside", () => {
    const prior = days([1.8, 2.0, 2.1, 2.3, 2.5, 1.9, 2.4]);
    expect(watchBaseline({ today: today(2.5), prior }).state).toBe("steady");
    expect(watchBaseline({ today: today(1.8), prior }).state).toBe("steady");
  });

  it("trims the extremes once there are enough days, so one freak day stops widening the band", () => {
    // Nearest-rank at n = 7 makes the band exactly min..max; it starts
    // trimming at n = 11 (low) and n = 12 (high). Thirty days at 2.0 with a
    // single 50 in them:
    // the band's top is 2.0, not 50, so a 3.0 today still reads moved.
    const prior = [...flat(29, 2), { day: "2026-09-30", flagsPer100Words: 50, callsScored: 10 }];
    const out = watchBaseline({ today: today(3), prior });
    expect(out.priorDays).toBe(30);
    expect(out.high).toBe(2);
    expect(out.state).toBe("moved");
  });
});
