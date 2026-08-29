// Shared concurrency primitives. Lives in its own dependency-free module so
// run-executor.ts, agent-verify.ts, bulks.ts and the routes can all import
// it without importing each other (T-75: run-executor <-> agent-verify used
// to form an import cycle purely for these two helpers).
import { logger } from "./logger";

// Env-tunable integer knob with a safe default and a hard ceiling. Vendor
// rate limits -- not our CPU -- are the real ceiling on parallelism, so a
// typo like PROVIDER_CONCURRENCY=400 would guarantee 429 storms and poison
// latency rankings; the clamp is applied silently but logged once.
export function envInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const clamped = Math.min(parsed, max);
  if (clamped !== parsed) {
    logger.warn({ name, requested: parsed, applied: clamped }, "concurrency env clamped to ceiling");
  }
  return clamped;
}

// Fixed-size worker pool over a materialized item list: exactly `limit`
// workers pull from a shared cursor until exhausted. No dependencies, no
// unbounded Promise.all blowups.
export async function drainWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}
