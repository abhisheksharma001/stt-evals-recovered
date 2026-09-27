// W-12b: the pure half of method-check.ts. No db import so it can be
// unit-tested without DATABASE_URL, same split and same reason as
// proxy-agreement-aggregate.ts.
import { callWordBasis, pooledRate, spearmanPermutationP, spearmanRho } from "@workspace/scoring";

export type MethodCheckRow = {
  callId: string;
  providerId: string;
  /** substitutions + deletions + insertions against the gold, from
   *  benchmark_scores.detail.edits. null when the cell was scored without a
   *  gold (no edits on file). */
  errors: number | null;
  /** The gold's word count from the same edits. */
  referenceWords: number | null;
  /** Peer-only flags. null = never hybrid-flagged; excluded, never clean. */
  peerFlagCount: number | null;
  /** This cell's normalised hypothesis word count, the input to R-1's
   *  shared per-call word basis. */
  words: number;
};

export type MethodCheckProvider = {
  providerId: string;
  /** Pooled gold WER: sum of errors / sum of gold words, not a mean of
   *  per-call WERs, so a short clip does not weigh as much as a long one. */
  wer: number;
  /** Pooled peer flags per 100 words on R-1's call word basis -- the
   *  quantity the bulk verdict ranks by. */
  flagsPer100Words: number;
  calls: number;
};

export type MethodCheckVerdict = "agrees" | "weak" | "disagrees" | "not_measurable";

export type MethodCheckFigures = {
  providers: MethodCheckProvider[];
  n: number;
  rho: number | null;
  pOneSided: number | null;
  verdict: MethodCheckVerdict;
};

/** agrees: rho > 0 and p < 0.05. weak: rho > 0 and p >= 0.05. disagrees:
 *  rho <= 0. not_measurable: rho is null (fewer than 3 providers, or one
 *  side entirely tied). */
export function methodCheckVerdict(rho: number | null, pOneSided: number | null): MethodCheckVerdict {
  if (rho === null || pOneSided === null) return "not_measurable";
  if (rho <= 0) return "disagrees";
  return pOneSided < 0.05 ? "agrees" : "weak";
}

/**
 * Whole calls only (Abhishek 2026-09-26, when the W-12 bulk was capped at
 * 2,000 cells): a call counts only when every provider seen in the rows has a
 * cell on it. Pooling each provider over a different set of clips would rank
 * the clips, not the providers -- a cut bulk leaves its last shard's calls
 * half-run.
 */
export function wholeCallRows(rows: readonly MethodCheckRow[]): MethodCheckRow[] {
  const providerCount = new Set(rows.map((r) => r.providerId)).size;
  const providersByCall = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = providersByCall.get(row.callId) ?? new Set<string>();
    set.add(row.providerId);
    providersByCall.set(row.callId, set);
  }
  return rows.filter((r) => providersByCall.get(r.callId)!.size === providerCount);
}

/**
 * One ordering per provider over the public bulk's whole calls, both
 * lower-is-better: pooled gold WER and pooled peer flags per 100 words. A
 * provider enters the comparison only when it carries both; one that is
 * missing either is left out of n rather than given a zero.
 */
export function aggregateMethodCheck(allRows: readonly MethodCheckRow[]): MethodCheckFigures {
  const rows = wholeCallRows(allRows);
  const basis = callWordBasis(rows.map((r) => ({ callId: r.callId, words: r.words })));

  const byProvider = new Map<string, MethodCheckRow[]>();
  for (const row of rows) byProvider.set(row.providerId, [...(byProvider.get(row.providerId) ?? []), row]);

  const providers: MethodCheckProvider[] = [];
  for (const [providerId, cells] of [...byProvider.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    const gold = cells.filter((c) => c.errors !== null && c.referenceWords !== null);
    const goldWords = gold.reduce((s, c) => s + c.referenceWords!, 0);
    const flagged = cells.filter((c) => c.peerFlagCount !== null);
    const rate = pooledRate(flagged.map((c) => ({ flags: c.peerFlagCount!, words: basis.get(c.callId) ?? 0 })));
    if (goldWords === 0 || rate === null) continue;
    providers.push({
      providerId,
      wer: gold.reduce((s, c) => s + c.errors!, 0) / goldWords,
      flagsPer100Words: rate,
      calls: new Set(gold.map((c) => c.callId)).size,
    });
  }

  const wer = providers.map((p) => p.wer);
  const flags = providers.map((p) => p.flagsPer100Words);
  const rho = spearmanRho(wer, flags);
  const pOneSided = spearmanPermutationP(wer, flags);
  return { providers, n: providers.length, rho, pOneSided, verdict: methodCheckVerdict(rho, pOneSided) };
}
