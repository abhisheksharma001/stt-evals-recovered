/**
 * W-5b (PRD v8 Part B): "is this policy due right now, and for which day" --
 * and nothing else. No database, no provider, no clock of its own.
 *
 * W-5c's tick wakes every 60 seconds and will call this once per enabled
 * schedule. Everything expensive happens after it answers `run`: the import,
 * the preview, the cost gate, the launch. So this file is where the question
 * that decides whether money moves is asked, and it is deliberately the one
 * part of the tick that can be proved on a laptop with no database and no
 * network.
 *
 * It reads no clock. `now` is an argument, which is the only reason the
 * "process was down for three days" case is testable at all -- a function
 * that called `Date.now()` could only be tested by waiting.
 *
 * ## Which day is "today"
 *
 * `watch_schedules.hour_local` is an hour of the LOCAL day, and there is no
 * timezone column on the row -- local means the API process's own timezone,
 * the same one `watch_runs.day` is written in. That is a real limitation, not
 * an oversight: one operator, one machine (OD-11). The day a schedule is
 * hosted in a different region than the org it watches, this file is where
 * the timezone goes, and the ledger's day column will need a migration to
 * match. Until then, both ends agree, which is what matters.
 *
 * Every date here is read with the local getters (`getHours`, `getFullYear`)
 * and never through `toISOString`, which is UTC. That difference is not
 * academic: this machine runs at UTC+5:30, so a bulk created at 02:00 local
 * and named with `toISOString().slice(0, 10)` carries YESTERDAY's date
 * (found 2026-09-15, see `docs/backlog/good-to-have.md`).
 */

import type { WatchScheduleRow } from "@workspace/db";

/** The two columns the decision reads. Narrowed from `WatchScheduleRow` on
 *  purpose rather than taking the row: a full row would let this function
 *  quietly start reading `sampleSize` or `accountId`, and then "is it due"
 *  and "what should it run" would be one tangled question instead of two. A
 *  real row still satisfies it structurally, so the caller passes the row. */
export type TickSchedule = Pick<WatchScheduleRow, "enabled" | "hourLocal">;

/** `day` is null on a skip, not the candidate day, so `decision.day` cannot
 *  be written to `watch_runs.day` without narrowing on `action` first -- tsc
 *  refuses it. A skip that recorded a day would be a ledger row claiming a
 *  run that never happened. */
export type TickDecision =
  | { action: "skip"; day: null }
  | { action: "run"; day: string };

/** `YYYY-MM-DD` for the LOCAL calendar day of `now`. Exported because W-5c
 *  writes this exact string to `watch_runs.day` and passes it to
 *  `sampleForDay` as the seed -- two places that must agree with this one or
 *  the ledger stops matching the draw. */
export function localDay(now: Date): string {
  const y = now.getFullYear();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const d = `${now.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The most recent due day, or nothing to do.
 *
 * Due means: the policy is on, `now`'s local hour has reached `hourLocal`,
 * and today is not already in the ledger.
 *
 * **Missed days are never backfilled.** A machine asleep from the 12th to the
 * 15th wakes up and runs the 15th, once -- not four days at four times the
 * money with nobody watching (PRD v8 Part B). That is why this returns a
 * single day and not a list: the shape itself refuses the backfill, so no
 * caller can choose it.
 *
 * Below the hour is `skip`, not "yesterday". At 02:00 with `hourLocal` 3 the
 * day is an hour away, and the ledger row for a day should hold calls sampled
 * on that day.
 *
 * @param ledgerDays the `watch_runs.day` values already on file FOR THIS
 *        SCHEDULE. Another policy's days must not be in here -- the whole
 *        idempotency turns on it.
 */
export function decideTick(input: {
  schedule: TickSchedule;
  now: Date;
  ledgerDays: readonly string[];
}): TickDecision {
  const { schedule, now, ledgerDays } = input;
  if (!schedule.enabled) return { action: "skip", day: null };
  // `>=`, not `>`: an hour of 3 means "from 03:00", so the 03:00 tick is the
  // first one that runs, not the 04:00 one.
  if (now.getHours() < schedule.hourLocal) return { action: "skip", day: null };
  const day = localDay(now);
  if (ledgerDays.includes(day)) return { action: "skip", day: null };
  return { action: "run", day };
}
