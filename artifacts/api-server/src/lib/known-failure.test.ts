import { describe, expect, it } from "vitest";
import { matchKnownFailure } from "./agent";

// T-41: the free, deterministic diagnosis is keyed on the stored
// failureClass. The error sentence is only read for rows that were never
// classified (pre-T-06 rows on a database where T-40 has not run).
describe("matchKnownFailure", () => {
  it("is driven by failureClass, not by the error text", () => {
    const known = matchKnownFailure({ failureClass: "retention_expired", errorMessage: "HTTP 400" });
    expect(known?.diagnosis).toContain("14 days");
    const forbidden = matchKnownFailure({ failureClass: "audio_url_forbidden", errorMessage: null });
    expect(forbidden?.diagnosis).toContain("403");
  });

  it("returns null for a classified failure with no canned diagnosis, even if the text looks known", () => {
    expect(
      matchKnownFailure({ failureClass: "provider_5xx", errorMessage: "exceeds your retention window" }),
    ).toBeNull();
    expect(matchKnownFailure({ failureClass: "unknown", errorMessage: "storage.supabase.co/archive/x" })).toBeNull();
  });

  it("never reads the error text: a null failureClass is null, whatever the message says (T-69)", () => {
    expect(matchKnownFailure({ failureClass: null, errorMessage: "call exceeds your retention window" })).toBeNull();
    expect(
      matchKnownFailure({ failureClass: null, errorMessage: "Failed to fetch https://x.storage.supabase.co/archive/a.wav" }),
    ).toBeNull();
    expect(matchKnownFailure({ failureClass: null, errorMessage: "Deepgram returned HTTP 400" })).toBeNull();
    expect(matchKnownFailure({ failureClass: null, errorMessage: null })).toBeNull();
  });
});
