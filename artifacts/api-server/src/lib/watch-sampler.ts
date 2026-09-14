/**
 * W-3 (PRD v8 Part A): "draw N calls for this agent, for this day", and
 * nothing else. No database, no clock, no provider. Given the same schedule,
 * the same day and the same calls it returns the same ids in the same order,
 * forever.
 *
 * That determinism is the whole point, not a convenience. W-5's tick re-runs
 * this every time it wakes up; if the draw wandered, a retry after a crash
 * would pick a different set of calls and pay to transcribe them a second
 * time. The ledger can only prove "this day was already drawn" because the
 * draw is reproducible.
 *
 * Reads nothing and writes nothing -- same split as `triage-signals.ts`, so
 * the arithmetic can be proved against fixtures instead of against a corpus
 * of real callers.
 */

/** One candidate call. The sampler needs nothing else about it -- the
 *  criteria matching already happened (W-1), and the provider list belongs to
 *  the template, not to the call. `assistantId` is
 *  `benchmark_calls.source_assistant_id`, which is nullable: a call imported
 *  without an assistant on file is its own bucket, never silently dropped. */
export type SampleCandidate = { id: string; assistantId: string | null };

export type SamplePick = {
  assistantId: string | null;
  /** The drawn ids, in drawn order. Order is part of the contract: the ledger
   *  stores it and a re-run has to match it. */
  callIds: string[];
  /** How many calls this agent had to offer before the draw. */
  matched: number;
  /** How many were asked for and did not exist. Zero when the agent had
   *  enough. A quiet agent reports a shortfall rather than looking like a
   *  full sample of a smaller size -- absent is not zero. */
  shortfall: number;
};

/** 32-bit FNV-1a. Turns the seed sentence into the number the PRNG needs. */
function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32.
 *
 *  `lib/scoring/src/verdict.ts` carries the same ten lines privately for its
 *  bootstrap, and they are deliberately NOT shared. That one exists so a
 *  statistic is reproducible; this one decides which calls money is spent on.
 *  Wiring them together would let a change made to tune the bootstrap quietly
 *  re-draw every schedule's sample. Two callers, two reasons, two copies. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, drawing from the end, on a copy. The input array is never
 *  reordered -- the caller's list outlives this call. */
function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function sampleForDay(input: {
  scheduleId: string;
  /** The local day being drawn, as `YYYY-MM-DD`. A string, not a Date: the
   *  seed has to survive being written to the ledger and read back. */
  day: string;
  sampleSize: number;
  calls: readonly SampleCandidate[];
}): { picks: SamplePick[] } {
  const groups = new Map<string | null, SampleCandidate[]>();
  for (const call of input.calls) {
    const bucket = groups.get(call.assistantId);
    if (bucket) bucket.push(call);
    else groups.set(call.assistantId, [call]);
  }

  const picks: SamplePick[] = [];
  for (const [assistantId, candidates] of groups) {
    // The agent's id is part of the seed, not just the schedule's and the
    // day's. Without it every group would replay one stream, so a busy agent
    // appearing or disappearing would move a DIFFERENT agent's picks -- the
    // sample would be reproducible only as long as the roster never changed,
    // which is the one thing a daily watch cannot promise.
    const rand = seededRandom(hashSeed(`${input.scheduleId}:${input.day}:${assistantId ?? ""}`));
    const drawn = shuffled(candidates, rand).slice(0, input.sampleSize);
    picks.push({
      assistantId,
      callIds: drawn.map((c) => c.id),
      matched: candidates.length,
      shortfall: Math.max(0, input.sampleSize - candidates.length),
    });
  }

  // Sorted by agent, unassigned calls last, so two runs of the same day
  // produce byte-identical output whatever order the calls arrived in.
  picks.sort((a, b) => {
    if (a.assistantId === b.assistantId) return 0;
    if (a.assistantId === null) return 1;
    if (b.assistantId === null) return -1;
    return a.assistantId < b.assistantId ? -1 : 1;
  });
  return { picks };
}
