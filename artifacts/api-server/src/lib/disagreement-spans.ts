// T-09 / T-86: the span builder shared by routes/disagreement-spans.ts and
// lib/words-to-watch.ts, so both read a span from the exact same inputs. Spans are a pure function of stored,
// immutable results, so rebuilding is how a (call, run, startMs, endMs) key
// is turned back into words and context -- nothing about a span is stored.
import { and, eq } from "drizzle-orm";
import { benchmarkProviderCallResultsTable, db } from "@workspace/db";
import { buildDisagreementSpans, type DisagreementSpansResult, type SpanCandidate } from "@workspace/scoring";
import { extractProviderTimedWords } from "./timed-words";

export async function buildSpansForCallRun(callId: string, runId: string): Promise<DisagreementSpansResult> {
  const results = await db
    .select({
      providerId: benchmarkProviderCallResultsTable.providerId,
      hypothesisTranscript: benchmarkProviderCallResultsTable.hypothesisTranscript,
      rawOutput: benchmarkProviderCallResultsTable.rawOutput,
    })
    .from(benchmarkProviderCallResultsTable)
    .where(
      and(
        eq(benchmarkProviderCallResultsTable.runId, runId),
        eq(benchmarkProviderCallResultsTable.callId, callId),
        eq(benchmarkProviderCallResultsTable.status, "ok"),
      ),
    );

  const candidates: SpanCandidate[] = [];
  for (const r of results) {
    const timedWords = extractProviderTimedWords(r.providerId, r.rawOutput);
    if (timedWords) candidates.push({ providerId: r.providerId, timedWords });
    else if (r.hypothesisTranscript) candidates.push({ providerId: r.providerId, transcript: r.hypothesisTranscript });
  }
  return buildDisagreementSpans(candidates);
}
