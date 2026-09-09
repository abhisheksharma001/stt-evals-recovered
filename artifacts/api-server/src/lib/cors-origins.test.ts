import { describe, expect, it } from "vitest";
import { allowedOrigins, isOriginAllowed } from "./cors-origins";

// R-31 (ox-alpha B-4). What this protects: the API has no auth, listens on
// localhost, and serves transcripts and audio. `Access-Control-Allow-Origin: *`
// let any page the operator visited read the whole corpus from their own
// machine.
describe("allowedOrigins", () => {
  it("allows the vite dev and preview origins by default", () => {
    const allowed = allowedOrigins({} as NodeJS.ProcessEnv);
    expect(allowed).toContain("http://localhost:5173");
    expect(allowed).toContain("http://127.0.0.1:5173");
    expect(allowed).toContain("http://localhost:4173");
  });

  it("adds WEB_ORIGINS for split hosting, trimming whitespace and trailing slash", () => {
    const allowed = allowedOrigins({
      WEB_ORIGINS: " https://stt.example.com/ , https://other.example.com ",
    } as NodeJS.ProcessEnv);
    expect(allowed).toContain("https://stt.example.com");
    expect(allowed).toContain("https://other.example.com");
  });

  it("never allowlists an empty origin from a trailing comma", () => {
    const allowed = allowedOrigins({ WEB_ORIGINS: "https://a.example.com,," } as NodeJS.ProcessEnv);
    expect(allowed).not.toContain("");
    expect(isOriginAllowed("", allowed)).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  const allowed = allowedOrigins({ WEB_ORIGINS: "https://stt.example.com" } as NodeJS.ProcessEnv);

  it("allows an origin on the list", () => {
    expect(isOriginAllowed("http://localhost:5173", allowed)).toBe(true);
    expect(isOriginAllowed("https://stt.example.com", allowed)).toBe(true);
  });

  // The whole point.
  it("refuses an arbitrary site, which is what * used to allow", () => {
    expect(isOriginAllowed("https://evil.example.com", allowed)).toBe(false);
    expect(isOriginAllowed("null", allowed)).toBe(false);
  });

  // A substring or prefix check here would be worse than none, because it
  // would read as careful.
  it("refuses a lookalike that merely contains an allowed origin", () => {
    expect(isOriginAllowed("https://stt.example.com.evil.test", allowed)).toBe(false);
    expect(isOriginAllowed("https://evil-stt.example.com", allowed)).toBe(false);
    expect(isOriginAllowed("http://localhost:5173.evil.test", allowed)).toBe(false);
  });

  it("refuses a different port and a different scheme on an allowed host", () => {
    expect(isOriginAllowed("http://localhost:9999", allowed)).toBe(false);
    expect(isOriginAllowed("https://localhost:5173", allowed)).toBe(false);
  });

  // CORS is a browser rule. curl and the deploy script's healthz check send no
  // Origin at all, and refusing them would break real callers while stopping
  // no attacker -- a non-browser client sets whatever Origin it likes.
  it("allows a request with no Origin header at all", () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
  });
});
