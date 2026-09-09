import { describe, expect, it } from "vitest";
import { checkApiBaseUrl } from "./api-base";

// R-29 (ox-alpha B-18). The contract this pins: VITE_API_BASE_URL is an
// ORIGIN. Every generated operation path already starts with /api, so a base
// that also ends in /api sends every request to /api/api/... -- which is what
// the deploy workflow used to document as the example value.
describe("checkApiBaseUrl", () => {
  it("accepts the API origin, which is the whole point", () => {
    expect(checkApiBaseUrl("https://stt-api.example.com")).toBeNull();
  });

  it("accepts an origin with a port", () => {
    expect(checkApiBaseUrl("http://localhost:8177")).toBeNull();
  });

  it("reports the value the workflow used to document", () => {
    const problem = checkApiBaseUrl("https://stt-api.example.com/api");
    expect(problem).toContain("/api/api/");
    expect(problem).toContain("API origin only");
  });

  it("reports it with a trailing slash too, since that is the same mistake", () => {
    expect(checkApiBaseUrl("https://stt-api.example.com/api/")).not.toBeNull();
  });

  it("is case-insensitive about the path segment", () => {
    expect(checkApiBaseUrl("https://stt-api.example.com/API")).not.toBeNull();
  });

  it("says nothing when unset, blank, or whitespace -- same-origin is valid", () => {
    expect(checkApiBaseUrl(undefined)).toBeNull();
    expect(checkApiBaseUrl("")).toBeNull();
    expect(checkApiBaseUrl("   ")).toBeNull();
  });

  // Not "contains /api" -- an origin that merely has api in the host, or a
  // real sub-path that is not /api, is none of this function's business.
  it("does not report a host that merely contains the word api", () => {
    expect(checkApiBaseUrl("https://api.example.com")).toBeNull();
    expect(checkApiBaseUrl("https://stt-api.example.com/gateway")).toBeNull();
  });
});
