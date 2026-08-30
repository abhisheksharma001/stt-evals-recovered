import { describe, expect, it } from "vitest";
import { classifyAudioAttemptFailure } from "./audio-attempt-classify";

describe("classifyAudioAttemptFailure (T-131)", () => {
  it("Vapi's retention 400 is a permanent source refusal", () => {
    expect(
      classifyAudioAttemptFailure(
        'Vapi call fetch failed: HTTP 400 -- "Your subscription plan only covers the last 14 days of call history."',
      ),
    ).toBe("source_refused");
  });

  it("a storage-bucket 403 on a freshly resolved url is a permanent source refusal", () => {
    expect(classifyAudioAttemptFailure("Failed to fetch audio: HTTP 403 Forbidden")).toBe("source_refused");
  });

  it("anything else stays retryable", () => {
    expect(classifyAudioAttemptFailure("fetch failed: socket hang up")).toBe("failed");
    expect(classifyAudioAttemptFailure("Vapi call fetch failed: HTTP 500")).toBe("failed");
    // 403 must be a real HTTP status word, not a number inside an id.
    expect(classifyAudioAttemptFailure("call vapi-4031 timed out")).toBe("failed");
  });
});
