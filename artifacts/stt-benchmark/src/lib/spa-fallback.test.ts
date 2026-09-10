import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getBaseUrl, setBaseUrl } from "@workspace/api-client-react";
import { afterEach, describe, expect, it } from "vitest";

// R-50 (ox-alpha waves: vercel.json + custom-fetch.ts). Two halves of one
// failure -- a web build that is not pointed at an API answers its own API
// calls, successfully, with its own index.html.
//
// The client's default responseType is "auto": text/html takes the text
// branch, so a 200 index.html resolves as a *string* and never becomes an
// ApiError. React Query caches it as BenchmarkCall[]. What the operator needed
// to be told is exactly what nothing said.

const vercelConfig = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../vercel.json", import.meta.url)), "utf8"),
) as { rewrites: Array<{ source: string; destination: string }> };

/** Vercel compiles `source` with path-to-regexp, anchored at both ends. This
 *  is that anchoring, which is the part the /api exclusion depends on. */
function matchesRewrite(source: string, path: string): boolean {
  return new RegExp(`^${source}$`).test(path);
}

describe("the SPA catch-all", () => {
  const spa = vercelConfig.rewrites.find((r) => r.destination === "/index.html");

  it("still serves every app route from index.html", () => {
    expect(spa).toBeDefined();
    for (const path of ["/", "/corpus", "/runs", "/rankings/deep/link"]) {
      expect(matchesRewrite(spa!.source, path)).toBe(true);
    }
  });

  it("does not answer API paths with the app", () => {
    // Every generated operation path begins with /api, so same-origin mode
    // sends all of them here. They must fall through to a 404 the client
    // reports, not a 200 the client believes.
    for (const path of ["/api/healthz", "/api/benchmark/calls", "/api/benchmark/runs/abc"]) {
      expect(matchesRewrite(spa!.source, path)).toBe(false);
    }
  });

  it("does not exclude an app route that merely starts with the letters api", () => {
    expect(matchesRewrite(spa!.source, "/apiary")).toBe(true);
  });
});

describe("setBaseUrl", () => {
  afterEach(() => {
    setBaseUrl(null);
  });

  it("trims a value CI injected with whitespace", () => {
    // deploy-web.yml passes the repo variable verbatim to --build-env.
    setBaseUrl("  https://stt-api.example.com\n");
    expect(getBaseUrl()).toBe("https://stt-api.example.com");
  });

  it("still strips a trailing slash, and both together", () => {
    setBaseUrl(" https://stt-api.example.com/// ");
    expect(getBaseUrl()).toBe("https://stt-api.example.com");
  });

  it("treats a whitespace-only value as unset, which means same-origin", () => {
    setBaseUrl("   ");
    expect(getBaseUrl()).toBeNull();
  });

  it("leaves a clean origin exactly as given", () => {
    setBaseUrl("http://localhost:8177");
    expect(getBaseUrl()).toBe("http://localhost:8177");
  });
});
