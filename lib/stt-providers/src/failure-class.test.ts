import { describe, expect, it } from "vitest";
import {
  ClassifiedError,
  FAILURE_CLASSES,
  classifyProviderHttpStatus,
  failureClassOf,
  isFailureClass,
  isRetryableFailureClass,
  type FailureClass,
} from "./failure-class";

// T-06. The whole point of the enum is that a class is decided once, where the
// failure happens, and then travels untouched. These cover the two ways that
// promise can quietly break: a class that stops round-tripping off a thrown
// error, and a retry judgement that drifts away from the class list it is
// supposed to cover exhaustively.

describe("failureClassOf", () => {
  it("reads the class a ClassifiedError was thrown with", () => {
    const err = new ClassifiedError("audio link refused", "audio_url_forbidden", {
      httpStatus: 403,
    });
    expect(failureClassOf(err)).toBe("audio_url_forbidden");
    expect(err.httpStatus).toBe(403);
  });

  it("returns null for an ordinary Error rather than guessing from its message", () => {
    // The message says "timed out" in plain English on purpose: if this ever
    // returns provider_timeout, someone has added message parsing, which is
    // the exact thing T-06 exists to prevent.
    expect(failureClassOf(new Error("the websocket timed out waiting"))).toBeNull();
  });

  it("returns null for a non-error value, and for a bogus failureClass", () => {
    expect(failureClassOf(null)).toBeNull();
    expect(failureClassOf("retention_expired")).toBeNull();
    expect(failureClassOf({ failureClass: "not_a_real_class" })).toBeNull();
  });

  it("reads a class off a plain object that carries one (adapters that do not subclass Error)", () => {
    expect(failureClassOf({ failureClass: "rate_limited" })).toBe("rate_limited");
  });
});

describe("classifyProviderHttpStatus", () => {
  it("maps the statuses it claims to", () => {
    expect(classifyProviderHttpStatus(429)).toBe("rate_limited");
    expect(classifyProviderHttpStatus(408)).toBe("provider_timeout");
    expect(classifyProviderHttpStatus(500)).toBe("provider_5xx");
    expect(classifyProviderHttpStatus(503)).toBe("provider_5xx");
  });

  it("classes a provider's 401/403 as provider_auth (T-42); the audio-URL 403 is decided earlier, by fetchAudioBytes", () => {
    expect(classifyProviderHttpStatus(403)).toBe("provider_auth");
    expect(classifyProviderHttpStatus(401)).toBe("provider_auth");
  });

  it("returns unknown for an unmapped 4xx rather than the nearest-looking bucket", () => {
    expect(classifyProviderHttpStatus(400)).toBe("unknown");
    expect(classifyProviderHttpStatus(404)).toBe("unknown");
  });
});

describe("isRetryableFailureClass", () => {
  it("refuses to retry the three permanent classes", () => {
    expect(isRetryableFailureClass("retention_expired")).toBe(false);
    expect(isRetryableFailureClass("audio_url_forbidden")).toBe(false);
    expect(isRetryableFailureClass("audio_decode")).toBe(false);
  });

  it("retries the transport-ish classes", () => {
    expect(isRetryableFailureClass("provider_timeout")).toBe(true);
    expect(isRetryableFailureClass("provider_5xx")).toBe(true);
    expect(isRetryableFailureClass("rate_limited")).toBe(true);
  });

  it("treats unknown as retryable — an unclassified failure has not been shown to be permanent", () => {
    expect(isRetryableFailureClass("unknown")).toBe(true);
  });

  it("has an answer for every class in the enum", () => {
    // Guard the guard: adding a class to FAILURE_CLASSES without deciding its
    // retry semantics would otherwise fall off the end of the switch and
    // return undefined, which T-07's retry count would read as falsy.
    for (const cls of FAILURE_CLASSES) {
      expect(typeof isRetryableFailureClass(cls)).toBe("boolean");
    }
  });
});

describe("classifyProviderHttpStatus (T-42)", () => {
  it("classes a provider's 401/403 as provider_auth, never retryable", async () => {
    const { classifyProviderHttpStatus } = await import("./failure-class");
    expect(classifyProviderHttpStatus(401)).toBe("provider_auth");
    expect(classifyProviderHttpStatus(403)).toBe("provider_auth");
    expect(isRetryableFailureClass("provider_auth")).toBe(false);
    expect(classifyProviderHttpStatus(429)).toBe("rate_limited");
  });
});

describe("isFailureClass", () => {
  it("accepts every member of the enum and rejects near-misses", () => {
    for (const cls of FAILURE_CLASSES) expect(isFailureClass(cls)).toBe(true);
    expect(isFailureClass("retention-expired")).toBe(false);
    expect(isFailureClass("RETENTION_EXPIRED")).toBe(false);
    expect(isFailureClass(undefined)).toBe(false);
  });

  it("is the gate the database column relies on", () => {
    // benchmark_provider_call_results.failure_class is a text column typed to
    // FailureClass, so this predicate is what keeps a stray string out.
    const fromDb: unknown = "provider_5xx";
    expect(isFailureClass(fromDb) ? (fromDb as FailureClass) : "unknown").toBe("provider_5xx");
  });
});
