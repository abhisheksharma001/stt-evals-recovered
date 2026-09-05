/**
 * M-7a: what PRODUCTION's own pipeline measured on a call.
 *
 * Two callers, one reader: the importer passes Vapi's `call.artifact`
 * straight off the live response, and backfill-m7a-production-signals.ts
 * passes the parsed `<callId>.artifact.json` that cacheCallSidecars() and
 * scripts/rescue-customer-audio.mjs write field for field. Both objects
 * carry `performanceMetrics` and `messages` at the top level, which is the
 * only shape this file knows about -- keeping it one function is what stops
 * the imported calls and the rescued ones from being measured differently.
 *
 * Counted on disk 2026-09-06 across the 100 saved artifacts, because the
 * rules below are only defensible with the numbers next to them:
 *
 *   transcriberLatencyAverage   100 present, 23 of them 0, median of the 77
 *                               real ones 378.3 ms (max 6,651)
 *   endpointingLatencyAverage   100 present, 28 of them 0, median 120.3 ms
 *   numAssistantInterrupted      47 present, 26 of those >= 1 (max 9)
 *   toolCalls entries           119 across 75 of the 100 calls
 *
 * A zero latency is not a fast call: 21 of the 23 carry an EMPTY
 * `turnLatencies` array, so nothing was timed, and no transcriber answers in
 * 0 ms. An absent `numAssistantInterrupted` is not a calm call: 53 calls
 * were never asked. Both become null. Tool calls are the one honest zero --
 * `messages` is present on all 100, so an array with no tool call in it is a
 * measurement that says "none", and that is stored as 0.
 */

export type ProductionSignals = {
  prodTranscriberLatencyMs: number | null;
  prodEndpointingLatencyMs: number | null;
  prodAssistantInterruptions: number | null;
  prodToolCalls: number | null;
};

const NONE: ProductionSignals = {
  prodTranscriberLatencyMs: null,
  prodEndpointingLatencyMs: null,
  prodAssistantInterruptions: null,
  prodToolCalls: null,
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A latency Vapi actually measured. 0 means it measured nothing. */
function measuredLatency(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** A count Vapi reported. Absent stays absent; a reported 0 is kept. */
function reportedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Tool INVOCATIONS, not tool-call messages: the corpus has 116 messages
 * carrying 119 entries, and the 119 `tool_call_result` messages beside them
 * agree with the entries. A `tool_calls` message with no `toolCalls` array
 * contributes nothing -- no saved artifact has one.
 */
function countToolCalls(messages: unknown): number | null {
  if (!Array.isArray(messages)) return null;
  let count = 0;
  for (const message of messages) {
    const entry = record(message);
    if (!entry || entry.role !== "tool_calls") continue;
    if (Array.isArray(entry.toolCalls)) count += entry.toolCalls.length;
  }
  return count;
}

export function readProductionSignals(artifact: unknown): ProductionSignals {
  const source = record(artifact);
  if (!source) return { ...NONE };
  const metrics = record(source.performanceMetrics) ?? {};
  return {
    prodTranscriberLatencyMs: measuredLatency(metrics.transcriberLatencyAverage),
    prodEndpointingLatencyMs: measuredLatency(metrics.endpointingLatencyAverage),
    prodAssistantInterruptions: reportedCount(metrics.numAssistantInterrupted),
    prodToolCalls: countToolCalls(source.messages),
  };
}
