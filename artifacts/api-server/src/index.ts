import app from "./app";
import { logger } from "./lib/logger";
import { recoverInterruptedRuns } from "./lib/run-executor";
import { warmClientVolumes } from "./lib/volume";
import { runWatchTick } from "./lib/watch-tick";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Loopback only unless HOST says otherwise (M-3). There is no auth on this
// API and a bulk spends real provider money, so binding every interface put
// that button on the local network. Set HOST=0.0.0.0 deliberately, never by
// default.
const host = process.env["HOST"] ?? "127.0.0.1";

// W-5c3: how often the watch tick wakes. Most wakes decide nothing -- a
// schedule whose hour has not arrived, or whose day is already in the ledger,
// is skipped by decideTick (W-5b) before any query. A minute is fine-grained
// enough that a schedule set to hour 3 fires within a minute of 03:00 local.
//
// Deliberately not env-tunable: the only reason to shorten it is to make the
// system spend faster, and the caps are per DAY, not per tick.
const WATCH_TICK_INTERVAL_MS = 60_000;

app.listen(port, host, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, host }, "Server listening");

  // Re-enter runs stranded as queued/running by a previous process death
  // (safe: execution is resumable/idempotent) and recompute mid-flight bulk
  // statuses. Fire-and-forget -- must not block the listener.
  void recoverInterruptedRuns().catch((err) => {
    logger.error({ err }, "boot recovery of interrupted runs failed");
  });

  // T-24: pre-fetch each Vapi account's 14-day call volume (~40s per
  // 1,000 calls, minutes for a busy account) so Results' $/month figures
  // don't make the first visitor wait. Fire-and-forget; a failure only
  // means the first read pays the cold fetch itself.
  void warmClientVolumes().then((results) => {
    for (const r of results) {
      if (r.status === "rejected") logger.warn({ err: r.reason }, "client volume warm-up failed for one account");
    }
    logger.info({ accounts: results.length }, "client volume warm-up finished");
  });

  // W-5c3: THE ARMING. This is the only place in the repo that puts
  // runWatchTick on a clock, and the only place that reads WATCH_SCHEDULER --
  // a second reader would mean two answers to "is the scheduler on".
  //
  // Off unless the value is exactly "1". Not `!== undefined`, not truthiness:
  // WATCH_SCHEDULER=0 and WATCH_SCHEDULER=false must both leave it off, and
  // both are truthy strings. Either way the decision is logged once at
  // startup, so the log answers the question without anyone reading the env.
  if (process.env["WATCH_SCHEDULER"] === "1") {
    logger.info(
      { intervalMs: WATCH_TICK_INTERVAL_MS },
      "watch scheduler ARMED -- runWatchTick will create and launch bulks on its own",
    );
    setInterval(() => {
      // `new Date()` per tick, never one captured at boot: the tick derives
      // its local day from this, so a boot-time Date would keep a long-lived
      // process ticking for the day it started on.
      //
      // Wrapped in an arrow rather than passed as `setInterval(runWatchTick,
      // ...)`: setInterval calls its callback with no arguments, and
      // runWatchTick takes a required `{ now }`, so the bare form throws on
      // the first tick instead of running.
      //
      // The .catch is not optional -- an unhandled rejection ends the process
      // on Node >= 15, so one bad tick would take the API down with it.
      void runWatchTick({ now: new Date() }).catch((err) => {
        logger.error({ err }, "watch tick failed");
      });
    }, WATCH_TICK_INTERVAL_MS);
  } else {
    logger.info("watch scheduler off (set WATCH_SCHEDULER=1 to arm it)");
  }
});
