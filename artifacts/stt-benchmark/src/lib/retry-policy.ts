// R-52 (ox-alpha waves: App.ts, cited three times). The app-wide query
// default was a bare `retry: 2`, which React Query applies to *every*
// failure -- including the ones that will never come out differently.
//
// A 404 is the live case, not a hypothetical. R-38 made an unknown run id
// answer 404 instead of a pending status, and `ResultsDialog`
// (`pages/Runs.tsx:408`) polls that endpoint every 3s for as long as the
// dialog is open. Open it on a run id that is gone and every tick becomes
// three requests -- the first, then two retries 1s and 2s later, which
// overlap the next tick. Three times the load, three times the log noise,
// and the answer is the same 404 every time. `Dashboard.tsx:206` polls a
// bulk on the same terms every 5s.
//
// 408 and 429 are the two 4xx codes that genuinely change on their own:
// a request that timed out and a rate limit that expires. Everything else
// in the 4xx range is the server saying the request itself is wrong, and
// repeating an identical wrong request is just noise. 5xx and transport
// failures (no `status` at all -- a dropped connection, DNS, the API being
// restarted by `deploy-api.sh`) keep the original two retries, because
// those are exactly what a retry is for.
//
// Read-after-write is not the reason to retry a 404 here. Every polling
// query in this app already re-asks on its own interval, which covers a
// row that appears a second later far better than a 1s backoff does.

import { ApiError } from "@workspace/api-client-react";

/** Default attempts after the first failure, unchanged from before. */
export const MAX_QUERY_RETRIES = 2;

/** 4xx codes that can succeed later without the request changing. */
const RETRYABLE_4XX = new Set([408, 429]);

/** The HTTP status behind a React Query failure, or null when there is none
 *  -- a transport error, an abort, or anything thrown that is not an
 *  `ApiError`. Null means "no server verdict", which is retryable. */
export function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

/** React Query's `retry` predicate. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = statusOf(error);
  if (status !== null && status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)) {
    return false;
  }
  return failureCount < MAX_QUERY_RETRIES;
}
