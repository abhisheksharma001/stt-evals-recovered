// T-18: provider correlation. Two providers that transcribe the same call
// the same way are not two independent witnesses -- a Whisper-derived pair
// agreeing on a word is one vote, not two. This measures, per provider
// pair, how often they agree, so the consensus that hybrid flagging and
// the judge lean on can be read with that in mind. Pure text arithmetic:
// no gold transcript, no LLM.
import { diffWords, normalizeTranscript } from "./index";

/** Raw agreement cannot tell "same engine" from "both correct" -- on the
 *  live corpus every pair sits between 0.78 and 0.94 because the transcripts
 *  are mostly right. What marks a shared engine is agreeing with each other
 *  MORE than either agrees with everyone else. A pair whose excess is at or
 *  above this (3 points) is called correlated in the UI. First cut chosen by
 *  reading three real bulks (top pair +0.03..+0.04, the rest within +-0.02),
 *  not a tuned constant. */
export const CORRELATED_EXCESS_AGREEMENT = 0.03;

export type CorrelationCall = {
  callId: string;
  transcripts: { providerId: string; transcript: string }[];
};

export type ProviderPairCorrelation = {
  providerAId: string;
  providerBId: string;
  /** Calls where both providers produced a transcript. */
  sharedCalls: number;
  /** Mean over shared calls of (agreeing words / aligned positions), 0..1.
   *  null when the pair never shared a call -- never a confident 0. */
  agreement: number | null;
  /** agreement minus the mean of (A's mean agreement with every other
   *  provider, B's mean agreement with every other provider). Positive =
   *  these two agree with each other more than with the field. null when
   *  agreement is null or there is no third provider to form a baseline. */
  excessAgreement: number | null;
};

export type ProviderCorrelation = {
  providerIds: string[];
  callCount: number;
  pairs: ProviderPairCorrelation[];
};

/** Share of aligned word positions two transcripts agree on, after the same
 *  normalisation scoring uses. Symmetric up to alignment ties. Two empty
 *  transcripts agree completely. */
export function pairwiseAgreement(a: string, b: string): number {
  const wordsA = normalizeTranscript(a).split(" ").filter(Boolean);
  const wordsB = normalizeTranscript(b).split(" ").filter(Boolean);
  const ops = diffWords(wordsA, wordsB);
  if (ops.length === 0) return 1;
  const ok = ops.filter((op) => op.op === "ok").length;
  return ok / ops.length;
}

const pairKey = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export function computeProviderCorrelation(calls: CorrelationCall[]): ProviderCorrelation {
  const providerIds = [...new Set(calls.flatMap((c) => c.transcripts.map((t) => t.providerId)))].sort();
  const sums = new Map<string, { shared: number; total: number }>();

  for (const call of calls) {
    // One transcript per provider per call; a duplicate (two runs covering
    // the same call) keeps the first, so no pair is counted twice per call.
    const byProvider = new Map<string, string>();
    for (const t of call.transcripts) if (!byProvider.has(t.providerId)) byProvider.set(t.providerId, t.transcript);
    const ids = [...byProvider.keys()];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const [a, b] = pairKey(ids[i]!, ids[j]!);
        const key = `${a} ${b}`;
        const acc = sums.get(key) ?? { shared: 0, total: 0 };
        acc.shared += 1;
        acc.total += pairwiseAgreement(byProvider.get(a)!, byProvider.get(b)!);
        sums.set(key, acc);
      }
    }
  }

  const raw: Omit<ProviderPairCorrelation, "excessAgreement">[] = [];
  for (let i = 0; i < providerIds.length; i += 1) {
    for (let j = i + 1; j < providerIds.length; j += 1) {
      const a = providerIds[i]!;
      const b = providerIds[j]!;
      const acc = sums.get(`${a} ${b}`);
      raw.push({
        providerAId: a,
        providerBId: b,
        sharedCalls: acc?.shared ?? 0,
        agreement: acc && acc.shared > 0 ? acc.total / acc.shared : null,
      });
    }
  }

  // Baseline per provider: its mean agreement with every OTHER provider it
  // shared calls with. A pair's excess is measured against the two
  // baselines with the pair itself left out, so a strongly correlated pair
  // does not inflate its own baseline.
  const baselineExcluding = (id: string, other: string): number | null => {
    const values = raw
      .filter((p) => p.agreement !== null && (p.providerAId === id || p.providerBId === id))
      .filter((p) => p.providerAId !== other && p.providerBId !== other)
      .map((p) => p.agreement as number);
    return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
  };
  const pairs: ProviderPairCorrelation[] = raw.map((p) => {
    if (p.agreement === null) return { ...p, excessAgreement: null };
    const ba = baselineExcluding(p.providerAId, p.providerBId);
    const bb = baselineExcluding(p.providerBId, p.providerAId);
    if (ba === null || bb === null) return { ...p, excessAgreement: null };
    return { ...p, excessAgreement: p.agreement - (ba + bb) / 2 };
  });
  return { providerIds, callCount: calls.length, pairs };
}
