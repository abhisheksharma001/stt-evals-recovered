/**
 * T-04 (2026-08-28): who am I, and when was I built?
 *
 * This server has no watch mode. A source change only reaches the running
 * process after `node ./build.mjs` AND a manual restart, and nothing on
 * screen ever said which of those two had actually happened -- so behaviour
 * has more than once been checked against a process still running older
 * code. These three values make the running build answer for itself.
 *
 * `__BUILD_COMMIT_SHA__` and `__BUILD_AT__` are replaced literally by
 * esbuild's `define` (see build.mjs). They therefore describe the BUNDLE,
 * not the working tree at start time -- which is exactly the point. Running
 * from source instead (tsx, tests) leaves them undefined, so the fallbacks
 * below say "dev" rather than inventing a commit that was never built.
 */
declare const __BUILD_COMMIT_SHA__: string | undefined;
declare const __BUILD_AT__: string | undefined;

/** Commit the running bundle was built from, or "dev" when run from source. */
export const buildCommitSha: string =
  typeof __BUILD_COMMIT_SHA__ === "string" ? __BUILD_COMMIT_SHA__ : "dev";

/** When the running bundle was built, or null when run from source. */
export const buildAt: string | null =
  typeof __BUILD_AT__ === "string" ? __BUILD_AT__ : null;

/** When THIS process started. Captured once, at module load. */
export const startedAt: string = new Date().toISOString();
