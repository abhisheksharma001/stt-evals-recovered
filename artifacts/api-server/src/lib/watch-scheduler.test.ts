// W-5b: the tick's decision, proved without a clock and without a database.
//
// Every date below is built with the local-time constructor
// `new Date(y, m, d, h)` and never from an ISO string. An ISO string is UTC,
// so `new Date("2026-09-15T04:00:00Z")` is 09:30 on this machine and 04:00 on
// CI -- the same assertion would pass in one place and fail in the other.
// Built local-side, "09:00" means 09:00 everywhere, which is what
// `hour_local` means too. Same rule as T-168: an assertion that depends on
// the environment is not an assertion.
import { describe, expect, it } from "vitest";
import { decideTick, localDay } from "./watch-scheduler";

const AT_3AM = { enabled: true, hourLocal: 3 };

/** 2026-09-15, local, at the given hour. */
const on15th = (hour: number, minute = 0) => new Date(2026, 8, 15, hour, minute);

describe("localDay", () => {
  it("is the local calendar day, not the UTC one", () => {
    // 00:30 local on the 15th is still the 14th in UTC anywhere east of
    // Greenwich. The ledger's day column and `hour_local` are both local, so
    // this must answer the 15th. `toISOString().slice(0, 10)` would not.
    expect(localDay(new Date(2026, 8, 15, 0, 30))).toBe("2026-09-15");
    expect(localDay(new Date(2026, 8, 15, 23, 30))).toBe("2026-09-15");
  });

  it("pads month and day to two digits", () => {
    expect(localDay(new Date(2026, 0, 5, 12))).toBe("2026-01-05");
  });
});

describe("decideTick (W-5b)", () => {
  it("runs today once the hour has passed and the ledger is empty", () => {
    expect(decideTick({ schedule: AT_3AM, now: on15th(9), ledgerDays: [] })).toEqual({
      action: "run",
      day: "2026-09-15",
    });
  });

  it("runs at exactly the hour, not an hour later", () => {
    // `hour_local` 3 means "from 03:00". A `>` would silently move every
    // schedule one hour later than the row says.
    expect(decideTick({ schedule: AT_3AM, now: on15th(3, 0), ledgerDays: [] }).action).toBe("run");
  });

  it("returns exactly one day after three days down, and never a backfill", () => {
    // The ledger's last row is the 11th; the machine slept through the 12th,
    // 13th and 14th and wakes at 09:00 on the 15th.
    const decision = decideTick({
      schedule: AT_3AM,
      now: on15th(9),
      ledgerDays: ["2026-09-11"],
    });
    expect(decision).toEqual({ action: "run", day: "2026-09-15" });
    // The missed days are gone on purpose: four launches at four times the
    // money, with nobody awake, is the thing this refuses (PRD v8 Part B).
    expect(["2026-09-12", "2026-09-13", "2026-09-14"]).not.toContain(decision.day);
  });

  it("skips below the hour, and carries no day when it does", () => {
    const decision = decideTick({ schedule: AT_3AM, now: on15th(2, 59), ledgerDays: [] });
    expect(decision).toEqual({ action: "skip", day: null });
  });

  it("skips when the ledger already holds today -- the tick runs every minute", () => {
    // The 60-second tick asks this ~1,260 times between 03:00 and midnight.
    // Exactly one of them may answer `run`.
    const ledgerDays = ["2026-09-15"];
    expect(decideTick({ schedule: AT_3AM, now: on15th(3), ledgerDays }).action).toBe("skip");
    expect(decideTick({ schedule: AT_3AM, now: on15th(9), ledgerDays }).action).toBe("skip");
    expect(decideTick({ schedule: AT_3AM, now: on15th(23, 59), ledgerDays }).action).toBe("skip");
  });

  it("skips a disabled schedule whose hour has long passed", () => {
    // The break test's target: delete the `enabled` clause and this is the
    // one case that fails.
    expect(
      decideTick({ schedule: { enabled: false, hourLocal: 3 }, now: on15th(9), ledgerDays: [] }),
    ).toEqual({ action: "skip", day: null });
  });

  it("reads only this schedule's ledger days", () => {
    // Another policy having run today must not silence this one. W-5c has to
    // query the ledger scoped by schedule id; passing the whole table in
    // would look like this and must still run.
    const decision = decideTick({
      schedule: AT_3AM,
      now: on15th(9),
      ledgerDays: ["2026-09-14", "2026-09-13"],
    });
    expect(decision).toEqual({ action: "run", day: "2026-09-15" });
  });

  it("honours an hour of 0 as midnight, not as 'unset'", () => {
    // 0 is falsy. A `if (!hourLocal)` anywhere in the chain would turn a
    // midnight schedule into an always-on one.
    const atMidnight = { enabled: true, hourLocal: 0 };
    expect(decideTick({ schedule: atMidnight, now: on15th(0, 1), ledgerDays: [] })).toEqual({
      action: "run",
      day: "2026-09-15",
    });
  });
});
