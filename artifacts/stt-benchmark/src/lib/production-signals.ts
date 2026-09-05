/**
 * M-7b: turning M-7a's per-call `prod_*` columns into something a page can
 * say. Every function here returns null for "nobody measured this" and
 * never a 0 standing in for it -- the column is nullable precisely because
 * 23 of the 100 saved artifacts report a latency of 0 with an empty
 * `turnLatencies` array, meaning nothing was timed. Counting those as
 * instant is what dropped the corpus median from 378.3 ms to 274 ms in the
 * PRD, a third of the real number.
 *
 * A count is different from a latency: a reported 0 interruptions is a real
 * observation and is kept. So the denominator here is always "calls that
 * carry a number", never the group's call count.
 *
 * Drizzle stores the latencies as float4, so 378.3 comes back as
 * 378.29998779296875 -- everything is rounded to whole ms before display.
 */

/** Whole ms, or null when no call in the group carries a latency. */
export function medianMs(values: (number | null | undefined)[]): number | null {
  const measured = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  if (measured.length === 0) return null;
  const mid = measured.length / 2;
  const median =
    measured.length % 2 === 1 ? measured[Math.floor(mid)] : (measured[mid - 1] + measured[mid]) / 2;
  return Math.round(median);
}

/** How many calls carry a latency at all -- the median's real denominator. */
export function countMeasured(values: (number | null | undefined)[]): number {
  return values.filter((v) => typeof v === "number").length;
}

/**
 * Calls where the assistant interrupted, over calls Vapi gave a count for.
 * Null when it gave none: silence, not "0 of 0 interrupted".
 */
export function interruptedShare(
  values: (number | null | undefined)[],
): { interrupted: number; measured: number } | null {
  const counts = values.filter((v): v is number => typeof v === "number");
  if (counts.length === 0) return null;
  return { interrupted: counts.filter((c) => c > 0).length, measured: counts.length };
}

/** One call's latency for display. Null stays absent, never a 0 or a dash. */
export function roundMs(value: number | null | undefined): number | null {
  return typeof value === "number" ? Math.round(value) : null;
}
