import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

const REDACT = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
];

/** The levels pino accepts. `silent` is valid and disables output entirely. */
const LOG_LEVELS = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
]);

/** R-49 (ox-alpha waves, logger.ts): `process.env.LOG_LEVEL ?? "info"` only
 *  falls back when the variable is absent. `LOG_LEVEL=` -- an empty value, what
 *  a blank entry in a `.env` produces -- is a string, so it reached pino
 *  verbatim and pino threw `default level: must be included in custom levels`
 *  at module load, before any route or handler existed. A typo (`verbose`) did
 *  the same, and so did a stray space. A logging preference must not be able to
 *  stop the API from booting.
 *
 *  Case is not significant to pino, which lowercases the level itself, so
 *  `LOG_LEVEL=INFO` keeps working. Surrounding whitespace is significant to
 *  pino (it throws), which is why it is trimmed here. */
export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): string {
  const requested = (env.LOG_LEVEL ?? "").trim().toLowerCase();
  if (requested.length === 0) return "info";
  if (!LOG_LEVELS.has(requested)) {
    console.error(`LOG_LEVEL "${requested}" is not a pino level; using "info".`);
    return "info";
  }
  return requested;
}

/** R-49: pino's `transport` option runs pino-pretty on a worker thread, and
 *  thread-stream's `ThreadStream` is an EventEmitter. When that worker dies --
 *  an unhandled throw inside pino-pretty, an OOM, a terminate -- thread-stream
 *  calls `emit("error", ...)`. Nothing listened, and nothing in this process
 *  installs an `uncaughtException` handler, so Node turned a dead log formatter
 *  into a dead API: `Error: the worker thread exited`, exit code 1, every
 *  in-flight run stranded at `running` mid-spend. Same shape as R-45's pg pool,
 *  and the second such event source found in this process.
 *
 *  Not dev-only. `isProduction` is false whenever NODE_ENV is unset, and
 *  neither the package `start` script nor scripts/deploy-api.sh sets it -- the
 *  deployed API is running the pretty transport right now (verified: ANSI
 *  escapes in its log file). Whether production should be logging JSON instead
 *  is a separate question, deliberately not answered here.
 *
 *  Reported once. After the worker is gone every subsequent write emits again,
 *  and a stderr line per log call would bury the one line that mattered.
 *  `console.error`, not `logger`: the logger's own output stream is what just
 *  died. */
export function guardTransport<T extends NodeJS.EventEmitter>(stream: T): T {
  let reported = false;
  stream.on("error", (err: Error) => {
    if (reported) return;
    reported = true;
    console.error(
      `pino transport: the log formatter worker died, log output stops here (${err.message}). The API keeps serving.`,
    );
  });
  return stream;
}

export const logger = isProduction
  ? pino({ level: resolveLogLevel(), redact: REDACT })
  : pino(
      { level: resolveLogLevel(), redact: REDACT },
      guardTransport(
        pino.transport({ target: "pino-pretty", options: { colorize: true } }),
      ),
    );
