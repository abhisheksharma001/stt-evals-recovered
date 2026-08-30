// T-20: the headline verdict. One object per ranking group that says who
// won, by how much, against what evidence -- and refuses to name a winner
// when the evidence can't separate the top two. Pure arithmetic over
// per-cell peer flag counts and word counts; no DB, no LLM.
//
// Metric: peer flags per 100 words (the T-19 rate; confidence spans
// excluded so every provider is measured on the same signal). Lower is
// better. Each provider's rate is pooled -- total flags / total words over
// its scored cells -- not a mean of per-call rates, so a 30-word call
// doesn't weigh as much as a 900-word one.
//
// Noise floor: a paired bootstrap over the calls the top two providers
// both scored. Resample those calls with replacement, recompute both pooled
// rates from the resample, take the difference; the 2.5th and 97.5th
// percentiles of 1,000 such differences are the 95% interval. If that
// interval includes zero the two are "too close to call on this evidence"
// and no winner is named (docs/logic-register.md §11 asked for exactly this:
// overlapping intervals = no ranking claim). The resampler is seeded so the
// same cells always give the same interval -- a verdict must be reproducible.

export const BOOTSTRAP_ITERATIONS = 1000;
/** Below this many evidence calls the whole verdict is provisional
 *  (docs/PRD-v4-uiux.md U-12 / D.3.3: "below ~20 calls"). */
export const PROVISIONAL_EVIDENCE_CALLS = 20;
/** Fewer shared calls than this and no noise floor is drawn at all: a
 *  bootstrap over 1 call resamples that same call every time, its interval
 *  collapses to a point, and a 2% gap on one call would read as "outside
 *  noise" -- seen live on the first cut of this module. */
export const MIN_SHARED_CALLS_FOR_VERDICT = 5;
/** callsToSettle above this is reported as null with the pair called
 *  "effectively tied" -- "2,750 more calls" is false precision, not a plan. */
export const MAX_CALLS_TO_SETTLE = 500;

export type VerdictCell = {
  callId: string;
  providerId: string;
  /** Peer-only flag count for this cell. null = never hybrid-flagged; the
   *  cell is excluded, never counted clean. */
  peerFlagCount: number | null;
  /** Word count of this provider's normalised transcript for the call. */
  words: number;
};

export type VerdictProviderRate = {
  providerId: string;
  /** Pooled peer flags per 100 words, lower is better. */
  flagsPer100Words: number;
  calls: number;
  totalFlags: number;
  totalWords: number;
};

export type NoiseFloor = {
  /** Calls both top-two providers scored; the paired sample. */
  sharedCalls: number;
  /** Point estimate: runner-up rate minus winner rate, in flags/100 words
   *  (positive = winner cleaner) over the shared calls only. */
  difference: number;
  /** 95% bootstrap percentile interval on `difference`. */
  ci95: [number, number];
  /** true when ci95 includes zero -- the evidence can't separate them. */
  withinNoise: boolean;
};

export type HeadlineVerdict = {
  /** "winner" = a winner is named. "too_close" = top two inside the noise
   *  floor, no winner named. "too_few_calls" = the top two share fewer than
   *  MIN_SHARED_CALLS_FOR_VERDICT calls, so no noise floor can be drawn and
   *  no winner is named. "insufficient" = fewer than two providers have
   *  scored evidence, nothing to compare. */
  decision: "winner" | "too_close" | "too_few_calls" | "insufficient";
  /** Named only when decision is "winner". */
  winnerProviderId: string | null;
  /** Second-lowest rate. For "too_close" this and `leaderProviderId` are
   *  the pair that couldn't be separated. */
  runnerUpProviderId: string | null;
  /** The lowest-rate provider regardless of decision -- what the winner
   *  WOULD be if the noise floor were ignored. Never render this as the
   *  winner; it exists so the UI can say "X leads, but too close to call." */
  leaderProviderId: string | null;
  /** Relative improvement of the winner over the runner-up in flags/100
   *  words, 0..100 (38 = "38% cleaner"). null unless decision is "winner". */
  marginPct: number | null;
  /** Same, winner vs the provider Vapi runs live for this group's calls.
   *  Positive = winner cleaner, negative = production cleaner. null when
   *  production isn't known, wasn't benchmarked here, or IS the winner. */
  vsProductionPct: number | null;
  productionProviderId: string | null;
  /** true when the production provider is the leader/winner. */
  productionIsLeader: boolean;
  /** Distinct calls with at least one flagged cell in this group -- the
   *  number every margin must be read against. */
  evidenceCalls: number;
  /** evidenceCalls < PROVISIONAL_EVIDENCE_CALLS. */
  provisional: boolean;
  /** For "too_close": a rough estimate of how many evidence calls would
   *  shrink the interval enough to separate the pair at the current point
   *  difference (interval half-width scales with 1/sqrt(n)). null when the
   *  point difference is zero (no amount of the same evidence settles a
   *  tie) or when decision isn't "too_close". A direction, not a promise. */
  callsToSettle: number | null;
  noiseFloor: NoiseFloor | null;
  /** How many of the group's providers reported per-word confidence at all
   *  -- the comparability note for the confidence-inclusive columns. */
  confidenceComparable: { reporting: number; total: number };
  rates: VerdictProviderRate[];
  /** The verdict as one sentence, evidence count attached (U-12). */
  sentence: string;
};

/** Deterministic PRNG (mulberry32) so a bootstrap is reproducible. */
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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx]!;
}

export function pooledRate(cells: { flags: number; words: number }[]): number | null {
  const words = cells.reduce((s, c) => s + c.words, 0);
  if (words === 0) return null;
  const flags = cells.reduce((s, c) => s + c.flags, 0);
  return (flags / words) * 100;
}

/** Paired bootstrap of (runner-up pooled rate − leader pooled rate) over
 *  the calls both scored. Exported for tests. */
export function bootstrapNoiseFloor(
  pairs: { leader: { flags: number; words: number }; runnerUp: { flags: number; words: number } }[],
  iterations = BOOTSTRAP_ITERATIONS,
  seed = 20260829,
): NoiseFloor | null {
  const usable = pairs.filter((p) => p.leader.words > 0 && p.runnerUp.words > 0);
  if (usable.length === 0) return null;
  const point =
    (pooledRate(usable.map((p) => p.runnerUp)) ?? 0) - (pooledRate(usable.map((p) => p.leader)) ?? 0);
  const rand = seededRandom(seed);
  const diffs: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let leaderFlags = 0;
    let leaderWords = 0;
    let runnerFlags = 0;
    let runnerWords = 0;
    for (let k = 0; k < usable.length; k++) {
      const p = usable[Math.floor(rand() * usable.length)]!;
      leaderFlags += p.leader.flags;
      leaderWords += p.leader.words;
      runnerFlags += p.runnerUp.flags;
      runnerWords += p.runnerUp.words;
    }
    diffs.push((runnerFlags / runnerWords) * 100 - (leaderFlags / leaderWords) * 100);
  }
  diffs.sort((a, b) => a - b);
  const ci95: [number, number] = [percentile(diffs, 0.025), percentile(diffs, 0.975)];
  return {
    sharedCalls: usable.length,
    difference: point,
    ci95,
    withinNoise: ci95[0] <= 0 && ci95[1] >= 0,
  };
}

function relativeImprovementPct(better: number, worse: number): number | null {
  if (worse <= 0) return null;
  return ((worse - better) / worse) * 100;
}

function fmtPct(p: number): string {
  return `${Math.round(Math.abs(p))}%`;
}

function fmtRate(r: number): string {
  return r.toFixed(1);
}

export type VerdictOptions = {
  productionProviderId?: string | null;
  /** Provider ids in this group that report per-word confidence. */
  confidenceReportingProviderIds?: string[];
  providerNames?: Record<string, string>;
};

export function computeVerdict(cells: VerdictCell[], options: VerdictOptions = {}): HeadlineVerdict {
  const productionProviderId = options.productionProviderId ?? null;
  const name = (id: string | null): string => (id ? (options.providerNames?.[id] ?? id) : "—");

  const flagged = cells.filter((c) => c.peerFlagCount !== null);
  const byProvider = new Map<string, VerdictCell[]>();
  for (const c of flagged) {
    const list = byProvider.get(c.providerId) ?? [];
    list.push(c);
    byProvider.set(c.providerId, list);
  }
  const providerIds = [...byProvider.keys()].sort();
  const reporting = new Set(options.confidenceReportingProviderIds ?? []);
  const confidenceComparable = {
    reporting: providerIds.filter((id) => reporting.has(id)).length,
    total: providerIds.length,
  };

  const rates: VerdictProviderRate[] = [];
  for (const id of providerIds) {
    const rows = byProvider.get(id)!;
    const totalWords = rows.reduce((s, r) => s + r.words, 0);
    if (totalWords === 0) continue;
    const totalFlags = rows.reduce((s, r) => s + (r.peerFlagCount ?? 0), 0);
    rates.push({
      providerId: id,
      flagsPer100Words: (totalFlags / totalWords) * 100,
      calls: new Set(rows.map((r) => r.callId)).size,
      totalFlags,
      totalWords,
    });
  }
  rates.sort((a, b) => a.flagsPer100Words - b.flagsPer100Words || a.providerId.localeCompare(b.providerId));

  const evidenceCalls = new Set(flagged.map((c) => c.callId)).size;
  const provisional = evidenceCalls < PROVISIONAL_EVIDENCE_CALLS;
  const rateOf = (id: string | null) => (id ? rates.find((r) => r.providerId === id) ?? null : null);
  const productionRate = rateOf(productionProviderId);

  const base = {
    winnerProviderId: null,
    runnerUpProviderId: null,
    leaderProviderId: null,
    marginPct: null,
    vsProductionPct: null,
    productionProviderId,
    productionIsLeader: false,
    evidenceCalls,
    provisional,
    callsToSettle: null,
    noiseFloor: null,
    confidenceComparable,
    rates,
  };

  if (rates.length < 2) {
    const only = rates[0];
    return {
      ...base,
      decision: "insufficient",
      leaderProviderId: only?.providerId ?? null,
      productionIsLeader: !!only && only.providerId === productionProviderId,
      sentence: only
        ? `Only ${name(only.providerId)} ran here (${evidenceCalls} call${evidenceCalls === 1 ? "" : "s"}) -- nothing to compare.`
        : "No scored calls yet.",
    };
  }

  const leader = rates[0]!;
  const runnerUp = rates[1]!;

  // Paired sample: the calls both scored.
  const leaderByCall = new Map(byProvider.get(leader.providerId)!.map((c) => [c.callId, c]));
  const pairs = byProvider
    .get(runnerUp.providerId)!
    .filter((c) => leaderByCall.has(c.callId))
    .map((c) => {
      const l = leaderByCall.get(c.callId)!;
      return {
        leader: { flags: l.peerFlagCount ?? 0, words: l.words },
        runnerUp: { flags: c.peerFlagCount ?? 0, words: c.words },
      };
    });
  const noiseFloor = pairs.length >= MIN_SHARED_CALLS_FOR_VERDICT ? bootstrapNoiseFloor(pairs) : null;
  const tooFewCalls = noiseFloor === null;
  const tooClose = !tooFewCalls && noiseFloor.withinNoise;

  const productionIsLeader = leader.providerId === productionProviderId;
  const vsProductionPct =
    productionRate && !productionIsLeader
      ? relativeImprovementPct(leader.flagsPer100Words, productionRate.flagsPer100Words)
      : null;
  // T-81 copy: the confidence-comparability caveat is no longer appended to
  // the sentence (it describes a column the sentence does not use); the
  // `confidenceComparable` field still carries it for the tooltip.
  const evidence = `${evidenceCalls} call${evidenceCalls === 1 ? "" : "s"}${provisional ? ` (early read, under ${PROVISIONAL_EVIDENCE_CALLS})` : ""}.`;

  if (tooFewCalls) {
    return {
      ...base,
      decision: "too_few_calls",
      runnerUpProviderId: runnerUp.providerId,
      leaderProviderId: leader.providerId,
      vsProductionPct,
      productionIsLeader,
      sentence:
        `Not enough calls: ${name(leader.providerId)} (${fmtRate(leader.flagsPer100Words)} disagreements per 100 words) is ahead of ${name(runnerUp.providerId)} (${fmtRate(runnerUp.flagsPer100Words)}), but only ${pairs.length} call${pairs.length === 1 ? "" : "s"} ran on both. Need ${MIN_SHARED_CALLS_FOR_VERDICT}. ${evidence}`,
    };
  }

  if (tooClose) {
    let callsToSettle: number | null = null;
    if (noiseFloor.difference > 0) {
      const halfWidth = (noiseFloor.ci95[1] - noiseFloor.ci95[0]) / 2;
      // half-width ∝ 1/sqrt(n): n_needed = n × (halfWidth / difference)².
      const needed = Math.ceil(noiseFloor.sharedCalls * (halfWidth / noiseFloor.difference) ** 2);
      callsToSettle = Math.max(needed, noiseFloor.sharedCalls + 1);
      if (callsToSettle > MAX_CALLS_TO_SETTLE) callsToSettle = null;
    }
    const settle =
      callsToSettle !== null
        ? ` About ${callsToSettle} calls run on both would decide it.`
        : " Effectively tied. More calls won't separate them.";
    return {
      ...base,
      decision: "too_close",
      runnerUpProviderId: runnerUp.providerId,
      leaderProviderId: leader.providerId,
      vsProductionPct,
      productionIsLeader,
      callsToSettle,
      noiseFloor,
      sentence:
        `Too close to call: ${name(leader.providerId)} (${fmtRate(leader.flagsPer100Words)} disagreements per 100 words) and ${name(runnerUp.providerId)} (${fmtRate(runnerUp.flagsPer100Words)}) are inside the margin of error. ${evidence}${settle}`,
    };
  }

  const marginPct = relativeImprovementPct(leader.flagsPer100Words, runnerUp.flagsPer100Words);
  // Comparative clause (same sentence) vs. a follow-on sentence.
  const vsProdClause =
    vsProductionPct === null
      ? ""
      : vsProductionPct >= 0
        ? `, ${fmtPct(vsProductionPct)} fewer than ${name(productionProviderId)} (in production today)`
        : `, but ${fmtPct(vsProductionPct)} more than ${name(productionProviderId)} (in production today)`;
  const vsProdSentence =
    vsProductionPct !== null
      ? ""
      : productionIsLeader
        ? " It is also in production today."
        : productionProviderId
          ? ` ${name(productionProviderId)} (in production today) was not benchmarked in this group.`
          : "";
  const marginText = marginPct === null ? "" : `, ${fmtPct(marginPct)} fewer than ${name(runnerUp.providerId)}`;
  const sentence =
    `${name(leader.providerId)} wins: ${fmtRate(leader.flagsPer100Words)} disagreements per 100 words${marginText}${vsProdClause}.${vsProdSentence} ${evidence}`;

  return {
    ...base,
    decision: "winner",
    winnerProviderId: leader.providerId,
    runnerUpProviderId: runnerUp.providerId,
    leaderProviderId: leader.providerId,
    marginPct,
    vsProductionPct,
    productionIsLeader,
    noiseFloor,
    sentence,
  };
}
