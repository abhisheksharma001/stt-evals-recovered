import { describe, expect, it } from "vitest";
import { providerRegistry } from "@workspace/stt-providers";
import { defaultProviders } from "./default-providers";

describe("defaultProviders (R-12)", () => {
  // The gap this closes: deepgram-nova-3-streaming had an adapter and a
  // catalog entry from M-11a and no seeded row for three weeks, so the id
  // resolved through getProviderAdapter() -- which reads the registry -- and
  // then failed at POST /benchmark/runs with "one or more providers do not
  // exist", which reads the table. Two sources of truth, and only the table
  // one can be selected.
  //
  // An adapter's own providerId is the case that must hold: the id is
  // hardcoded in the adapter, so nothing else will ever create that row.
  // providerCatalog keys are deliberately NOT asserted -- elevenlabs-scribe-v2
  // is a catalog entry with no seed row on purpose, because T-104 rows get
  // created on demand from the Setup page's model list.
  it("seeds a row for every adapter in the registry", () => {
    const seeded = new Set<string>(defaultProviders.map((provider) => provider.id));
    const missing = Object.values(providerRegistry)
      .map((adapter) => adapter.providerId)
      .filter((id) => !seeded.has(id));
    expect(missing).toEqual([]);
  });

  // R-12's break test found this uncovered: flipping manuallyDisabled to
  // false on either socket row changed nothing that any test read, and it is
  // the single edit here that can cost real money. A row seeded enabled with
  // its key set derives status "ready" (syncProviderReadiness) and is
  // selectable by the next bulk, and no Deepgram socket has ever been opened
  // from this repo -- the handshake, the finalize sequence and the latencies
  // are all unverified. Relax this when M-11d has streamed one live call to
  // each and Abhishek has seen the numbers; until then a seeded enable is a
  // bug, not a decision.
  it("seeds the two unproven Deepgram socket rows disabled", () => {
    const unproven = ["deepgram-nova-3-streaming", "deepgram-flux-general-en"];
    for (const id of unproven) {
      const row = defaultProviders.find((provider) => provider.id === id);
      expect(row, `${id} is not seeded at all`).toBeDefined();
      expect(row && "manuallyDisabled" in row && row.manuallyDisabled, id).toBe(true);
    }
  });
});
