import app from "./app";
import { logger } from "./lib/logger";
import { recoverInterruptedRuns } from "./lib/run-executor";
import { warmClientVolumes } from "./lib/volume";

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
});
