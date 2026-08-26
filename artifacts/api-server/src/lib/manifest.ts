import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  benchmarkCallsTable,
  benchmarkProvidersTable,
  db,
  type BenchmarkRunManifest,
} from "@workspace/db";
import { SCORING_VERSION } from "@workspace/scoring";

// RUN-01 / P2-T1: frozen record of exactly what a run executed against.
// Written once at run creation, never mutated -- editing a gold transcript
// or provider config afterwards must not change what a past run claims it
// used (FR-REP1). Hashes, not copies, for transcripts/configs: the verbatim
// data already lives in benchmark_calls / benchmark_providers, the manifest
// only needs to pin WHICH version.
function providerConfigHash(provider: {
  model: string;
  costPerMinute: number;
  supportsStreaming: boolean;
  supportsDiarization: boolean;
  keywordBoosting: boolean;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        model: provider.model,
        costPerMinute: provider.costPerMinute,
        supportsStreaming: provider.supportsStreaming,
        supportsDiarization: provider.supportsDiarization,
        keywordBoosting: provider.keywordBoosting,
      }),
    )
    .digest("hex");
}

export async function buildRunManifest(
  callIds: string[],
  providerIds: string[],
): Promise<BenchmarkRunManifest> {
  const [calls, providers] = await Promise.all([
    callIds.length
      ? db
          .select()
          .from(benchmarkCallsTable)
          .where(inArray(benchmarkCallsTable.id, callIds))
      : [],
    providerIds.length
      ? db
          .select()
          .from(benchmarkProvidersTable)
          .where(inArray(benchmarkProvidersTable.id, providerIds))
      : [],
  ]);

  return {
    manifestVersion: 1,
    scoringVersion: SCORING_VERSION,
    createdAt: new Date().toISOString(),
    calls: calls.map((call) => ({
      id: call.id,
      label: call.label,
      goldTranscriptSha256: call.goldTranscript
        ? createHash("sha256").update(call.goldTranscript).digest("hex")
        : null,
    })),
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      model: provider.model,
      configSha256: providerConfigHash(provider),
    })),
  };
}
