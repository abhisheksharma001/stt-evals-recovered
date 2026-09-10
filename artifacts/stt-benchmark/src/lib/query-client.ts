import { QueryClient } from "@tanstack/react-query";

import { shouldRetryQuery } from "./retry-policy";

// Review finding #21: the bare QueryClient meant every query used library
// defaults -- refetch-on-window-focus storms against a single-node Express,
// zero caching, three retries on hard failures. These defaults match how the
// app is actually used: read-heavy dashboards over a small internal API.
//
// R-52 moved this out of App.tsx so the defaults are testable. Unwiring the
// retry predicate there was caught by nothing -- not typecheck
// (`noUnusedLocals` is false) and not any test, because no test could see
// App.tsx's module-scope const. Now one can.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // mutations invalidate explicitly; no need to refetch sooner
      gcTime: 5 * 60_000,
      // R-52: was a bare `retry: 2`, which re-asked permanent 4xx answers.
      // A polling dialog on a 404 fired three requests per tick. See
      // retry-policy.ts for which codes still get the two retries.
      retry: shouldRetryQuery,
      refetchOnWindowFocus: false, // single-user internal tool; focus storms just hammer Express
    },
    mutations: {
      retry: 0, // POSTs are not idempotent -- never auto-retry (double imports / double attestations)
    },
  },
});
