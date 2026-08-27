import * as React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useLocation } from "wouter"
import { Layout } from "@/components/layout"
import { ErrorBoundary } from "@/components/error-boundary"
import { Toaster } from "@/components/ui/toaster"

import Dashboard from "@/pages/Dashboard"
import Corpus from "@/pages/Corpus"
import Sources from "@/pages/Import"
import Providers from "@/pages/Providers"
import Runs from "@/pages/Runs"
import Bulks from "@/pages/Bulks"
import Results from "@/pages/Rankings"
import NotFound from "@/pages/not-found"

// Review finding #21: the bare QueryClient meant every query used library
// defaults -- refetch-on-window-focus storms against a single-node Express,
// zero caching, three retries on hard failures. These defaults match how the
// app is actually used: read-heavy dashboards over a small internal API.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // mutations invalidate explicitly; no need to refetch sooner
      gcTime: 5 * 60_000,
      retry: 2,
      refetchOnWindowFocus: false, // single-user internal tool; focus storms just hammer Express
    },
    mutations: {
      retry: 0, // POSTs are not idempotent -- never auto-retry (double imports / double attestations)
    },
  },
})

// Exact match on the path portion only. wouter's location includes the query
// string, so "/review?call=<id>" deep links previously matched NO page and
// rendered a blank main area; unknown paths now render NotFound instead of
// nothing (review finding #22).
const KNOWN_ROUTES = new Set([
  "/",
  "/corpus",
  "/runs",
  "/bulks",
  "/results",
  "/providers",
  "/sources",
])

export default function App() {
  const [location] = useLocation()
  // B-52: normalize trailing slashes so bookmarks/proxies handing us
  // "/results/" don't 404 a real page.
  const path = (location.split("?")[0].replace(/\/+$/, "") || "/")

  return (
    <QueryClientProvider client={queryClient}>
      <Layout>
        <ErrorBoundary resetKey={location}>
          {path === "/" && <Dashboard />}
          {path === "/corpus" && <Corpus />}
          {path === "/runs" && <Runs />}
          {path === "/bulks" && <Bulks />}
          {path === "/results" && <Results />}
          {path === "/providers" && <Providers />}
          {path === "/sources" && <Sources />}
          {!KNOWN_ROUTES.has(path) && <NotFound />}
        </ErrorBoundary>
        <Toaster />
      </Layout>
    </QueryClientProvider>
  )
}
