import { assemblyAiAdapter } from "./adapters/assemblyai";
import { cartesiaAdapter } from "./adapters/cartesia";
import { deepgramAdapter } from "./adapters/deepgram";
import { elevenLabsAdapter } from "./adapters/elevenlabs";
import { gladiaAdapter } from "./adapters/gladia";
import { openAiAdapter } from "./adapters/openai";
import { speechmaticsAdapter } from "./adapters/speechmatics";
import type { ProviderAdapter } from "./types";

// Keyed by the same `id` used in benchmark_providers (see
// artifacts/api-server/src/routes/benchmark.ts defaultProviders). If a run
// selects a provider id not in this registry, that's a config bug -- the
// executor should fail that cell loudly, not skip it silently (PRO-03 note).
export const providerRegistry: Record<string, ProviderAdapter> = {
  [deepgramAdapter.providerId]: deepgramAdapter,
  [assemblyAiAdapter.providerId]: assemblyAiAdapter,
  [openAiAdapter.providerId]: openAiAdapter,
  [elevenLabsAdapter.providerId]: elevenLabsAdapter,
  [gladiaAdapter.providerId]: gladiaAdapter,
  [speechmaticsAdapter.providerId]: speechmaticsAdapter,
  [cartesiaAdapter.providerId]: cartesiaAdapter,
};

/**
 * 2026-08-27, per Abhishek: "for each of the providers it should have
 * multiple models we can configure."
 *
 * Until now a vendor WAS a model -- deepgramAdapter hardcoded nova-3, so the
 * only Deepgram anyone could benchmark was nova-3. The live corpus made the
 * cost of that obvious: production Vapi calls actually ran
 * deepgram/flux-general-en on 86 of 121 calls and nova-2 on 2 more, so the
 * benchmark was scoring every candidate against a baseline it never measured.
 *
 * The catalog decouples the two. An entry maps a provider id (the `id`
 * column on benchmark_providers) to the vendor adapter that can serve it
 * plus the exact API model string to send. One adapter, many models.
 *
 * Only models with real evidence behind them belong here. Per this repo's
 * standing rule -- verify against the real API, not memory -- the Deepgram
 * entries below come from model strings observed in Abhishek's own live Vapi
 * traffic, not from recollection of a docs page. Add a vendor's other models
 * once they've been confirmed the same way.
 */
export type ProviderCatalogEntry = {
  /** Adapter that serves this id (a key in providerRegistry). */
  adapterId: string;
  /** Exact model string sent to the vendor's API. */
  apiModel: string;
};

export const providerCatalog: Record<string, ProviderCatalogEntry> = {
  "deepgram-nova-3": { adapterId: deepgramAdapter.providerId, apiModel: "nova-3" },
  "deepgram-nova-2": { adapterId: deepgramAdapter.providerId, apiModel: "nova-2" },
  "deepgram-flux-general-en": {
    adapterId: deepgramAdapter.providerId,
    apiModel: "flux-general-en",
  },
};

/** The API model string to send for a provider id, if the catalog knows one. */
export function getProviderApiModel(providerId: string): string | undefined {
  return providerCatalog[providerId]?.apiModel;
}

export function getProviderAdapter(providerId: string): ProviderAdapter | undefined {
  // Exact adapter id first, so every pre-existing provider row resolves
  // exactly as it always did.
  const direct = providerRegistry[providerId];
  if (direct) return direct;
  // Then a catalog entry, which points at the vendor adapter that serves it.
  const entry = providerCatalog[providerId];
  return entry ? providerRegistry[entry.adapterId] : undefined;
}
