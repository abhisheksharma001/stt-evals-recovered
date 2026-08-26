import app from "./app";
import { logger } from "./lib/logger";
import { recoverInterruptedRuns } from "./lib/run-executor";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Re-enter runs stranded as queued/running by a previous process death
  // (safe: execution is resumable/idempotent) and recompute mid-flight bulk
  // statuses. Fire-and-forget -- must not block the listener.
  void recoverInterruptedRuns().catch((err) => {
    logger.error({ err }, "boot recovery of interrupted runs failed");
  });
});
