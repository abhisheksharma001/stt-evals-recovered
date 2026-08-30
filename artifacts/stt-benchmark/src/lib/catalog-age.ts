/**
 * T-107 / T-119: a vendor with no model-list API (AssemblyAI, Gladia,
 * Cartesia, ElevenLabs) has a catalog that is only as fresh as the day
 * someone last checked the vendor's docs. After this many days it is
 * flagged for a re-check -- on Setup next to the vendor (T-107) and as one
 * figure on the Overview (T-119). Deepgram and OpenAI are live and never age.
 */
export const CATALOG_RECHECK_DAYS = 60

export function catalogAge(m: { source: string; verifiedAt: string }, now: number = Date.now()): number | null {
  if (m.source === "live") return null
  const t = Date.parse(m.verifiedAt)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((now - t) / 86_400_000))
}

/** Vendors whose newest-model catalog is older than the re-check window. */
export function staleCatalogVendors(
  vendors: Array<{ vendorLabel: string; models: Array<{ latest: boolean; source: string; verifiedAt: string }> }>,
  now: number = Date.now(),
): string[] {
  const out: string[] = []
  for (const v of vendors) {
    const latest = v.models.find((m) => m.latest)
    const age = latest ? catalogAge(latest, now) : null
    if (age != null && age > CATALOG_RECHECK_DAYS) out.push(v.vendorLabel)
  }
  return out
}
