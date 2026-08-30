// T-85: the pure half of call-disagreement.ts. No db import so it can be
// unit-tested without DATABASE_URL (vitest.config: offline tests only).
export type CallDisagreement = { callId: string; disagreements: number; providers: number };

export type CallDisagreementRow = {
  callId: string;
  providerId: string;
  peerFlagCount: number | null;
};

/** Pure aggregation, unit-tested: sum flags per call, count scored
 *  providers, most disagreement first, ties by callId for a stable order. */
export function aggregateDisagreement(rows: CallDisagreementRow[]): CallDisagreement[] {
  const byCall = new Map<string, { disagreements: number; providers: Set<string> }>();
  for (const r of rows) {
    if (r.peerFlagCount === null) continue;
    const entry = byCall.get(r.callId) ?? { disagreements: 0, providers: new Set<string>() };
    entry.disagreements += r.peerFlagCount;
    entry.providers.add(r.providerId);
    byCall.set(r.callId, entry);
  }
  return [...byCall.entries()]
    .map(([callId, e]) => ({ callId, disagreements: e.disagreements, providers: e.providers.size }))
    .sort((a, b) => b.disagreements - a.disagreements || a.callId.localeCompare(b.callId));
}

