// W-4: moved out of `routes/benchmark.ts` unchanged, so the importer can
// write the same audit `afterState` the route wrote without the route file
// and the import library importing each other (scripts/check-import-cycles.mjs
// would refuse that, and rightly).
//
// T-153: the serializer declares the shape it produces as the contract's own
// input type, so a required field cannot fall out of it without failing tsc.
// Dates travel as Date: the schemas are zod.coerce.date(), and res.json writes
// a Date as the same ISO string toISOString produced.

import type { ZodInput } from "@workspace/api-zod";
import { GetBenchmarkCallResponse } from "@workspace/api-zod";
import type { BenchmarkCallRow } from "@workspace/db";

// M-6: the two cache flags travel together in one object rather than as two
// adjacent optional booleans -- they are both "is this file on disk", one
// letter apart in meaning, and a swapped pair would be invisible.
export type CallCacheState = { audio: boolean; customerAudio: boolean };

/** Decorations the read routes compute and the write routes do not, so they
 *  travel together and are absent (not false) on a write response. `cache` is
 *  M-6's pair; `benchmarked` is whether any provider has transcribed the call,
 *  which is a join, not a column. */
export type CallReadState = { cache?: CallCacheState; benchmarked?: boolean };

export function serializeCall(
  call: BenchmarkCallRow,
  read: CallReadState = {},
): ZodInput<typeof GetBenchmarkCallResponse> {
  const cache = read.cache;
  return {
    id: call.id,
    label: call.label,
    // Same rule as serializeProvider's status: unconstrained text columns,
    // values held by the runtime parse.
    vertical: call.vertical as ZodInput<typeof GetBenchmarkCallResponse>["vertical"],
    durationSeconds: call.durationSeconds,
    status: call.status as ZodInput<typeof GetBenchmarkCallResponse>["status"],
    hardCases: call.hardCases,
    goldTranscript: call.goldTranscript,
    draftTranscript: call.draftTranscript,
    entityNotes: call.entityNotes,
    entityReferences: call.entityReferences,
    audioObjectPath: call.audioObjectPath,
    deIdAttestedByLabel: call.deIdAttestedByLabel,
    deIdAttestedAt: call.deIdAttestedAt,
    deIdSecondApproverLabel: call.deIdSecondApproverLabel,
    deIdSecondApprovedAt: call.deIdSecondApprovedAt,
    sourceProvider: call.sourceProvider,
    sourceCallId: call.sourceCallId,
    sourceAccountLabel: call.sourceAccountLabel,
    sourceAssistantId: call.sourceAssistantId,
    sourceStartedAt: call.sourceStartedAt,
    sourceTranscriberProvider: call.sourceTranscriberProvider,
    sourceTranscriberModel: call.sourceTranscriberModel,
    sourceEndedReason: call.sourceEndedReason,
    sourceSuccessEvaluation: call.sourceSuccessEvaluation,
    // T-124: only the read routes pass this -- write responses leave it
    // absent rather than claiming false without having looked.
    audioCached: cache?.audio,
    // M-6: same rule, for the caller-only channel. A call with the mono mix
    // but no customer file can only be measured on audio that also contains
    // the assistant's own voice.
    customerAudioCached: cache?.customerAudio,
    // Whether any provider has transcribed this call. Absent (not false) on
    // write responses for the same reason as the two cache flags: only the
    // read routes pay for the join that answers it.
    benchmarked: read.benchmarked,
    // T-131: last audio-cache attempt (rescue/import), so the UI can name a
    // permanent source refusal instead of offering to save the unsaveable.
    audioCacheLastOutcome: call.audioCacheLastOutcome ?? null,
    audioCacheLastError: call.audioCacheLastError ?? null,
    audioCacheLastAttemptAt: call.audioCacheLastAttemptAt,
    // M-7a: production's own measurements. Null is "not measured" and must
    // stay distinguishable from 0 all the way to the screen.
    prodTranscriberLatencyMs: call.prodTranscriberLatencyMs,
    prodEndpointingLatencyMs: call.prodEndpointingLatencyMs,
    prodAssistantInterruptions: call.prodAssistantInterruptions,
    prodToolCalls: call.prodToolCalls,
    createdAt: call.createdAt,
  };
}
