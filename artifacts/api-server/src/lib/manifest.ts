import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { inArray } from "drizzle-orm";
import {
  benchmarkCallsTable,
  benchmarkProvidersTable,
  db,
  type BenchmarkRunManifest,
} from "@workspace/db";
import { SCORING_VERSION } from "@workspace/scoring";
import { customerAudioPathFor } from "./audio-cache";

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

/**
 * M-5: which channel this run will transcribe each call from, frozen at
 * creation like everything else in the manifest. `preferCustomer` is the
 * run's intent (a customer-channel bulk sets it; a mono bulk does not);
 * the per-call answer is that intent AND what is actually on disk right
 * now. Recording it here is what lets a replay months later say "this run
 * was scored on the caller-only track" without trusting a cache directory
 * that has changed since.
 */
export async function buildRunManifest(
  callIds: string[],
  providerIds: string[],
  options: { preferCustomer: boolean } = { preferCustomer: false },
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

  // One stat per call, only when the run actually wants the customer
  // channel -- a mono run does no filesystem work here at all.
  const audioSourceByCallId = new Map<string, "customer" | "mono">();
  if (options.preferCustomer) {
    await Promise.all(
      calls.map(async (call) => {
        try {
          await fs.access(customerAudioPathFor(call.id));
          audioSourceByCallId.set(call.id, "customer");
        } catch {
          audioSourceByCallId.set(call.id, "mono");
        }
      }),
    );
  }

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
      audioSource: audioSourceByCallId.get(call.id) ?? "mono",
    })),
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      model: provider.model,
      configSha256: providerConfigHash(provider),
    })),
  };
}
