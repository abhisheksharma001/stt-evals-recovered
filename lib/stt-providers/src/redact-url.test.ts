import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAudioBytes, redactUrlForMessage } from "./types";

// B-5. The message this feeds is persisted into benchmark_scores.error_message
// and served to the browser, so the assertion that matters is not "it looks
// tidy" -- it is that no substring of the signature survives anywhere in the
// output.
describe("redactUrlForMessage", () => {
  const SIGNED =
    "https://storage.vapi.ai/org/abc/rec-123.wav" +
    "?X-Amz-Signature=deadbeefcafe&X-Amz-Credential=AKIAEXAMPLE%2Fus-east-1&X-Amz-Expires=3600";

  it("keeps the object identifiable and drops every query parameter", () => {
    const out = redactUrlForMessage(SIGNED);
    expect(out).toBe("https://storage.vapi.ai/org/abc/rec-123.wav (credentials redacted)");
  });

  it("leaks no part of the signature, credential or expiry", () => {
    const out = redactUrlForMessage(SIGNED);
    for (const secret of ["deadbeefcafe", "AKIAEXAMPLE", "X-Amz-Signature", "3600", "?"]) {
      expect(out).not.toContain(secret);
    }
  });

  it("drops userinfo credentials, which live outside the query string", () => {
    expect(redactUrlForMessage("https://user:hunter2@example.com/a.wav")).toBe(
      "https://example.com/a.wav (credentials redacted)",
    );
  });

  // A password with no username sets `password` and leaves `username` empty.
  // `origin` drops it either way, so this is about the flag telling the truth.
  it("counts a password-only userinfo as something dropped", () => {
    expect(redactUrlForMessage("https://:hunter2@example.com/a.wav")).toBe(
      "https://example.com/a.wav (credentials redacted)",
    );
  });

  it("drops a fragment", () => {
    expect(redactUrlForMessage("https://example.com/a.wav#token=xyz")).toBe(
      "https://example.com/a.wav (credentials redacted)",
    );
  });

  it("says nothing about credentials when the URL carried none", () => {
    expect(redactUrlForMessage("https://example.com/a.wav")).toBe("https://example.com/a.wav");
  });

  it("keeps a non-default port, which is part of naming the host", () => {
    expect(redactUrlForMessage("http://localhost:8177/audio/x.wav")).toBe(
      "http://localhost:8177/audio/x.wav",
    );
  });

  // audio-cache.test.ts feeds data: URIs. Their path IS the audio, so echoing
  // it would put caller bytes in a persisted error row.
  it("never echoes the payload of a data: URI", () => {
    const out = redactUrlForMessage("data:audio/wav;base64,QUJDREVGRw==");
    expect(out).toBe("data:<redacted>");
    expect(out).not.toContain("QUJDREVGRw");
  });

  it("redacts blob: the same way", () => {
    expect(redactUrlForMessage("blob:https://example.com/9f8e")).toBe("blob:<redacted>");
  });

  // This runs inside a catch. Throwing here would replace a provider failure
  // with a different, wrong one.
  it("returns a placeholder rather than throwing on junk, and never echoes it", () => {
    expect(redactUrlForMessage("not a url at all")).toBe("<unparseable url>");
    expect(redactUrlForMessage("")).toBe("<unparseable url>");
  });
});

// The helper being correct is not the fix. The fix is that the call site uses
// it -- so this asserts on the message fetchAudioBytes actually throws.
describe("fetchAudioBytes error message", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the object but not the signature when the fetch fails", async () => {
    const signed =
      "https://storage.vapi.ai/org/abc/rec-123.wav?X-Amz-Signature=deadbeefcafe&X-Amz-Expires=3600";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 403 })),
    );

    await expect(fetchAudioBytes(signed)).rejects.toThrow(
      /storage\.vapi\.ai\/org\/abc\/rec-123\.wav/,
    );
    await expect(fetchAudioBytes(signed)).rejects.not.toThrow(/deadbeefcafe/);

    let message = "";
    try {
      await fetchAudioBytes(signed);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("HTTP 403");
    expect(message).not.toContain("X-Amz-Signature");
  });
});
