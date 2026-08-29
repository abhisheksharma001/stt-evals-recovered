// T-20: per-bulk headline verdicts. T-55 (2026-08-29): one per CLIENT (the
// call's Vapi account label), no longer per assistant -- live bulks split
// into 22-23 assistant groups of 1-2 calls, so no group could reach the
// 5-shared-call floor and every card said too_few_calls. Rankings still
// group per assistant; each card looks its assistant up in the client
// group's `assistantIds`. Reads the bulk's ok cells with
// their scores and hands the peer flag counts + word counts to the pure
// scorer in @workspace/scoring. Computed at read time from the same cells
// the rankings snapshot was built from, so it can never disagree with a
// stale snapshot of its own.
import { and, eq, inArray } from "drizzle-orm";
import {
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkProvidersTable,
  benchmarkRunsTable,
  benchmarkScoresTable,
  db,
} from "@workspace/db";
import { computeVerdict, normalizeTranscript, type HeadlineVerdict, type VerdictCell } from "@workspace/scoring";
import { extractProviderConfidenceWords } from "./hybrid-flagging";

export type BulkGroupVerdict = {
  /** Vapi account label the group's calls came from; null = none on file. */
  clientLabel: string | null;
  /** Every assistant (null = no assistant id) whose calls fed this group. */
  assistantIds: (string | null)[];
  callCount: number;
  vertical: string;
  /** Vapi's live transcriber for this group's calls, most common
   *  vendor/model pair, with how many of the group's calls it covers. */
  production: { vendor: string; model: string | null; coverage: number; total: number } | null;
  verdict: HeadlineVerdict;
};

export type BulkVerdicts = {
  bulkId: string;
  providers: { id: string; name: string }[];
  groups: BulkGroupVerdict[];
};

const NO_CLIENT_KEY = "__no_client__";
const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Which provider row IS a call's production transcriber -- the same
 * vendor/model normalisation the verdict uses, shared with the bulk preview
 * (T-56) so both answer identically. Null when nothing on file matches. */
export function resolveProductionProviderId(
  vendor: string,
  model: string | null,
  providers: { id: string; name: string; model: string }[],
): string | null {
  return providers.find((p) => norm(p.name) === norm(vendor) && (model ? norm(p.model) === norm(model) : false))?.id ?? null;
}

export async function bulkVerdicts(bulkId: string): Promise<BulkVerdicts> {
  const runs = await db
    .select({ id: benchmarkRunsTable.id, callIds: benchmarkRunsTable.callIds, providerIds: benchmarkRunsTable.providerIds })
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.bulkId, bulkId));
  if (runs.length === 0) return { bulkId, providers: [], groups: [] };
  const runIds = runs.map((r) => r.id);
  const allCallIds = [...new Set(runs.flatMap((r) => r.callIds))];
  const allProviderIds = [...new Set(runs.flatMap((r) => r.providerIds))];

  const [calls, providers, cells] = await Promise.all([
    allCallIds.length
      ? db
          .select({
            id: benchmarkCallsTable.id,
            sourceAssistantId: benchmarkCallsTable.sourceAssistantId,
            sourceAccountLabel: benchmarkCallsTable.sourceAccountLabel,
            vertical: benchmarkCallsTable.vertical,
            sourceTranscriberProvider: benchmarkCallsTable.sourceTranscriberProvider,
            sourceTranscriberModel: benchmarkCallsTable.sourceTranscriberModel,
          })
          .from(benchmarkCallsTable)
          .where(inArray(benchmarkCallsTable.id, allCallIds))
      : Promise.resolve([] as { id: string; sourceAssistantId: string | null; sourceAccountLabel: string | null; vertical: string; sourceTranscriberProvider: string | null; sourceTranscriberModel: string | null }[]),
    allProviderIds.length
      ? db
          .select({ id: benchmarkProvidersTable.id, name: benchmarkProvidersTable.name, model: benchmarkProvidersTable.model })
          .from(benchmarkProvidersTable)
          .where(inArray(benchmarkProvidersTable.id, allProviderIds))
      : Promise.resolve([] as { id: string; name: string; model: string }[]),
    db
      .select({
        id: benchmarkProviderCallResultsTable.id,
        callId: benchmarkProviderCallResultsTable.callId,
        providerId: benchmarkProviderCallResultsTable.providerId,
        transcript: benchmarkProviderCallResultsTable.hypothesisTranscript,
        peerFlagCount: benchmarkScoresTable.peerFlagCount,
      })
      .from(benchmarkProviderCallResultsTable)
      .innerJoin(benchmarkScoresTable, eq(benchmarkScoresTable.resultId, benchmarkProviderCallResultsTable.id))
      .where(
        and(
          inArray(benchmarkProviderCallResultsTable.runId, runIds),
          eq(benchmarkProviderCallResultsTable.status, "ok"),
        ),
      ),
  ]);

  // Which providers report per-word confidence: decided from ONE real ok
  // response per provider through the same extractor hybrid flagging uses
  // -- not from a hardcoded list -- so it stays true to what each API
  // actually returned. One row per provider keeps rawOutput reads cheap.
  const sampleIdByProvider = new Map<string, string>();
  for (const c of cells) if (!sampleIdByProvider.has(c.providerId)) sampleIdByProvider.set(c.providerId, c.id);
  const samples = sampleIdByProvider.size
    ? await db
        .select({ providerId: benchmarkProviderCallResultsTable.providerId, rawOutput: benchmarkProviderCallResultsTable.rawOutput })
        .from(benchmarkProviderCallResultsTable)
        .where(inArray(benchmarkProviderCallResultsTable.id, [...sampleIdByProvider.values()]))
    : [];
  const confidenceReportingProviderIds = samples
    .filter((s) => extractProviderConfidenceWords(s.providerId, s.rawOutput) !== null)
    .map((s) => s.providerId);

  const providerNames = Object.fromEntries(providers.map((p) => [p.id, p.name]));
  const clientKeyOf = (c: { sourceAccountLabel: string | null }) => c.sourceAccountLabel?.trim() || NO_CLIENT_KEY;
  const groupKeys = new Set(calls.map(clientKeyOf));

  const groups: BulkGroupVerdict[] = [];
  for (const key of [...groupKeys].sort()) {
    const clientLabel = key === NO_CLIENT_KEY ? null : key;
    const groupCalls = calls.filter((c) => clientKeyOf(c) === key);
    const groupCallIds = new Set(groupCalls.map((c) => c.id));
    const assistantIds = [...new Set(groupCalls.map((c) => c.sourceAssistantId ?? null))].sort((a, b) => (a ?? "").localeCompare(b ?? ""));

    const verticalCounts = new Map<string, number>();
    for (const c of groupCalls) verticalCounts.set(c.vertical, (verticalCounts.get(c.vertical) ?? 0) + 1);
    const vertical = [...verticalCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "rush";

    // Production baseline: same vendor/model normalisation Rankings.tsx's
    // useProductionBaseline applies client-side, now done once here.
    const prodCounts = new Map<string, number>();
    for (const c of groupCalls) {
      if (!c.sourceTranscriberProvider) continue;
      const k = `${c.sourceTranscriberProvider}::${c.sourceTranscriberModel ?? ""}`;
      prodCounts.set(k, (prodCounts.get(k) ?? 0) + 1);
    }
    const topProd = [...prodCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    let production: BulkGroupVerdict["production"] = null;
    let productionProviderId: string | null = null;
    if (topProd) {
      const [vendor, model] = topProd[0].split("::") as [string, string];
      production = { vendor, model: model || null, coverage: topProd[1], total: groupCalls.length };
      productionProviderId = resolveProductionProviderId(vendor, model || null, providers);
    }

    const verdictCells: VerdictCell[] = cells
      .filter((c) => groupCallIds.has(c.callId))
      .map((c) => ({
        callId: c.callId,
        providerId: c.providerId,
        peerFlagCount: c.peerFlagCount,
        words: normalizeTranscript(c.transcript ?? "").split(" ").filter(Boolean).length,
      }));

    groups.push({
      clientLabel,
      assistantIds,
      callCount: groupCalls.length,
      vertical,
      production,
      verdict: computeVerdict(verdictCells, { productionProviderId, confidenceReportingProviderIds, providerNames }),
    });
  }

  return { bulkId, providers: providers.map((p) => ({ id: p.id, name: p.name })), groups };
}
