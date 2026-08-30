// T-97: the production transcriber *configuration* behind an assistant --
// primary, fallback, boosted vocabulary -- read live from Vapi, so the
// Results baseline can say "production also has a fallback and 120 boosted
// keyterms; the benchmark ran with neither". Read-only.
//
// Which Vapi account owns the assistant is not stored anywhere; it is the
// account label most of the assistant's imported calls carry (same rule as
// the Results org grouping). No calls -> null, not a guess.
import { eq } from "drizzle-orm";
import { benchmarkCallsTable, db } from "@workspace/db";
import { fetchVapiAssistantTranscriber, listVapiAccounts, type VapiAssistantTranscriber } from "./vapi";

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: VapiAssistantTranscriber }>();

export type AssistantTranscriberLookup =
  | { kind: "ok"; config: VapiAssistantTranscriber }
  | { kind: "no_calls" }
  | { kind: "no_account"; accountLabel: string | null };

export async function assistantTranscriberConfig(assistantId: string): Promise<AssistantTranscriberLookup> {
  const hit = cache.get(assistantId);
  if (hit && Date.now() - hit.at < TTL_MS) return { kind: "ok", config: hit.value };

  const calls = await db
    .select({ label: benchmarkCallsTable.sourceAccountLabel })
    .from(benchmarkCallsTable)
    .where(eq(benchmarkCallsTable.sourceAssistantId, assistantId));
  if (calls.length === 0) return { kind: "no_calls" };
  const tally = new Map<string | null, number>();
  for (const c of calls) tally.set(c.label ?? null, (tally.get(c.label ?? null) ?? 0) + 1);
  const label = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const account = label === null ? undefined : listVapiAccounts().find((a) => a.label === label);
  if (!account) return { kind: "no_account", accountLabel: label };

  const config = await fetchVapiAssistantTranscriber(account.id, assistantId);
  cache.set(assistantId, { at: Date.now(), value: config });
  return { kind: "ok", config };
}
