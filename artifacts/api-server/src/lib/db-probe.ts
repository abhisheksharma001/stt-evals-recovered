/**
 * R-56: whether the database answers, for /healthz.
 *
 * /healthz is a liveness probe and must answer even when the database is the
 * thing that is down (routes/health.ts). So this never throws and never waits
 * long: a `select 1` raced against a short cap, reported as a word. Found
 * 2026-09-28: the Postgres container had been stopped for hours while
 * /healthz kept saying "ok" and nothing on screen said otherwise.
 */
export type DatabaseState = "ok" | "unreachable";

export const DB_PROBE_TIMEOUT_MS = 1_000;

export async function probeDatabase(
  query: () => Promise<unknown>,
  timeoutMs: number = DB_PROBE_TIMEOUT_MS,
): Promise<DatabaseState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DatabaseState>((resolve) => {
    timer = setTimeout(() => resolve("unreachable"), timeoutMs);
  });
  const answered = query().then(
    (): DatabaseState => "ok",
    (): DatabaseState => "unreachable",
  );
  try {
    return await Promise.race([answered, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
