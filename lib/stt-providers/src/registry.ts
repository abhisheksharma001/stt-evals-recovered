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

export function getProviderAdapter(providerId: string): ProviderAdapter | undefined {
  return providerRegistry[providerId];
}
