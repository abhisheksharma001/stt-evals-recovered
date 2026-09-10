import { QueryClient } from "@tanstack/react-query";

import { queryClient } from "./query-client";
import { ApiError } from "@workspace/api-client-react";
import { describe, expect, it } from "vitest";

import { MAX_QUERY_RETRIES, shouldRetryQuery, statusOf } from "./retry-policy";

/** A failure shaped exactly like one the generated hooks throw. */
function apiError(status: number, statusText = ""): ApiError {
  return new ApiError(
    new Response(JSON.stringify({ error: "nope" }), {
      status,
      statusText,
      headers: { "content-type": "application/json" },
    }),
    { error: "nope" },
    { method: "GET", url: "http://localhost:8177/api/benchmark/runs/gone/results" },
  );
}

describe("statusOf", () => {
  it("reads the status off an ApiError", () => {
    expect(statusOf(apiError(404, "Not Found"))).toBe(404);
  });

  it("returns null for a transport failure, which carries no server verdict", () => {
    expect(statusOf(new TypeError("Failed to fetch"))).toBeNull();
  });

  it("returns null for anything thrown that is not an Error at all", () => {
    expect(statusOf("boom")).toBeNull();
    expect(statusOf(undefined)).toBeNull();
  });
});

describe("shouldRetryQuery", () => {
  it("does not retry the 4xx codes that will answer the same way forever", () => {
    for (const status of [400, 401, 403, 404, 409, 410, 413, 415, 422]) {
      expect(shouldRetryQuery(0, apiError(status))).toBe(false);
    }
  });

  it("still retries 408 and 429 -- a timeout and a rate limit both expire", () => {
    expect(shouldRetryQuery(0, apiError(408))).toBe(true);
    expect(shouldRetryQuery(0, apiError(429))).toBe(true);
  });

  it("still retries 5xx", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(shouldRetryQuery(0, apiError(status))).toBe(true);
    }
  });

  it("still retries a transport failure", () => {
    expect(shouldRetryQuery(0, new TypeError("Failed to fetch"))).toBe(true);
  });

  it("keeps the old ceiling for everything it does retry", () => {
    expect(shouldRetryQuery(MAX_QUERY_RETRIES - 1, apiError(503))).toBe(true);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES, apiError(503))).toBe(false);
  });

  it("does not retry a 429 past the ceiling either", () => {
    expect(shouldRetryQuery(MAX_QUERY_RETRIES, apiError(429))).toBe(false);
  });
});

// The point of the whole change, driven through the real React Query retry
// machinery rather than the predicate alone. `retryDelay: 0` only removes the
// 1s/2s backoff waits -- it does not change how many attempts are made, which
// is the number under test.
describe("a real QueryClient using this policy", () => {
  function clientWithCounter(error: unknown) {
    let attempts = 0;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: shouldRetryQuery, retryDelay: 0 } },
    });
    const run = () =>
      client.fetchQuery({
        queryKey: ["cell", Math.random()],
        queryFn: () => {
          attempts += 1;
          return Promise.reject(error);
        },
      });
    return { run, attempts: () => attempts };
  }

  it("asks a 404 endpoint exactly once, not three times", async () => {
    const { run, attempts } = clientWithCounter(apiError(404, "Not Found"));
    await expect(run()).rejects.toBeInstanceOf(ApiError);
    expect(attempts()).toBe(1);
  });

  it("still makes three attempts against a 503", async () => {
    const { run, attempts } = clientWithCounter(apiError(503, "Service Unavailable"));
    await expect(run()).rejects.toBeInstanceOf(ApiError);
    expect(attempts()).toBe(1 + MAX_QUERY_RETRIES);
  });

  it("still makes three attempts when the API is simply not answering", async () => {
    const { run, attempts } = clientWithCounter(new TypeError("Failed to fetch"));
    await expect(run()).rejects.toBeInstanceOf(TypeError);
    expect(attempts()).toBe(1 + MAX_QUERY_RETRIES);
  });
});

// Breaking the policy back to `retry: 2` in the app's own client was caught by
// nothing before these existed: `noUnusedLocals` is false, and the client was a
// module-scope const inside App.tsx that no test could reach. A correct policy
// nobody installed is not a fix.
describe("the app's own QueryClient", () => {
  const defaults = queryClient.getDefaultOptions();

  it("uses this policy, not a bare number", () => {
    expect(defaults.queries?.retry).toBe(shouldRetryQuery);
  });

  it("asks a 404 endpoint once through the app's real defaults", async () => {
    let attempts = 0;
    await expect(
      queryClient.fetchQuery({
        queryKey: ["app-defaults-404"],
        retryDelay: 0,
        queryFn: () => {
          attempts += 1;
          return Promise.reject(apiError(404, "Not Found"));
        },
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(attempts).toBe(1);
  });

  it("still never auto-retries a mutation", () => {
    expect(defaults.mutations?.retry).toBe(0);
  });
});
