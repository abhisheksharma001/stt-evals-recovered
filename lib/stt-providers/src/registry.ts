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
  // T-104 (2026-08-30): ids whose api model string is not a clean slug of
  // itself, or that predate the vendor-prefix rule below. Everything else
  // resolves by prefix: "<vendor>-<apiModel>".
  "elevenlabs-scribe-v2": { adapterId: elevenLabsAdapter.providerId, apiModel: "scribe_v2" },
};

/** T-104: the provider id a (vendor, apiModel) pair gets. Stable, so
 *  enabling the same model twice finds the same row. */
export function providerIdForModel(vendor: string, apiModel: string): string {
  const slug = apiModel.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-|-$/g, "");
  return `${vendor}-${slug}`;
}

export function listProviderAdapters(): ProviderAdapter[] {
  return Object.values(providerRegistry);
}

/** Vendor key of an adapter: declared, else the first segment of its id. */
export function vendorOf(adapter: ProviderAdapter): string {
  return adapter.vendor ?? adapter.providerId.split("-")[0]!;
}

function adapterByVendorPrefix(providerId: string): ProviderAdapter | undefined {
  return Object.values(providerRegistry).find((a) => providerId.startsWith(`${vendorOf(a)}-`));
}

/** T-110: the vendor behind any provider id -- the adapter's own id, a
 *  catalog id, or a T-104 "<vendor>-<apiModel>" row. Everything that used
 *  to switch on an exact id (confidence / timing extraction, concurrency)
 *  keys on this instead, so a newly enabled model row gets the same
 *  treatment as the vendor's historical row. */
export function vendorOfProviderId(providerId: string): string {
  const adapter = providerRegistry[providerId] ?? adapterByVendorPrefix(providerId);
  return adapter ? vendorOf(adapter) : providerId.split("-")[0]!;
}

/** The API model string to send for a provider id, if the catalog knows one. */
export function getProviderApiModel(providerId: string): string | undefined {
  const fromCatalog = providerCatalog[providerId]?.apiModel;
  if (fromCatalog) return fromCatalog;
  // An adapter's own historical id keeps its own default (undefined here).
  if (providerRegistry[providerId]) return undefined;
  const adapter = adapterByVendorPrefix(providerId);
  return adapter ? providerId.slice(vendorOf(adapter).length + 1) : undefined;
}

export function getProviderAdapter(providerId: string): ProviderAdapter | undefined {
  // Exact adapter id first, so every pre-existing provider row resolves
  // exactly as it always did.
  const direct = providerRegistry[providerId];
  if (direct) return direct;
  // Then a catalog entry, which points at the vendor adapter that serves it.
  const entry = providerCatalog[providerId];
  if (entry) return providerRegistry[entry.adapterId];
  // T-104: "<vendor>-<apiModel>" rows created from the model list.
  return adapterByVendorPrefix(providerId);
}
