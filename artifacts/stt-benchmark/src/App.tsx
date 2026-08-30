import * as React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useLocation } from "wouter"
import { Layout } from "@/components/layout"
import { ErrorBoundary } from "@/components/error-boundary"
import { Toaster } from "@/components/ui/toaster"

import Dashboard from "@/pages/Dashboard"
import Corpus from "@/pages/Corpus"
import Setup from "@/pages/Setup"
import Bulks from "@/pages/Bulks"
import Results from "@/pages/Rankings"
import NotFound from "@/pages/not-found"
import Landing from "@/pages/Landing"

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
// T-31 (D.4): five pages. /runs, /providers and /sources stay as aliases so
// bookmarks and deep links keep working -- Runs renders inside Bulks,
// Providers and Sources are tabs of Setup.
const KNOWN_ROUTES = new Set([
  "/",
  "/corpus",
  "/bulks",
  "/runs",
  "/results",
  "/setup",
  "/providers",
  "/sources",
])

export default function App() {
  const [location] = useLocation()
  // B-52: normalize trailing slashes so bookmarks/proxies handing us
  // "/results/" don't 404 a real page.
  const path = (location.split("?")[0].replace(/\/+$/, "") || "/")

  // T-83: the public landing page lives outside the app shell -- no
  // sidebar, no data hooks, so it never needs the API to render.
  if (path === "/welcome") return <Landing />

  return (
    <QueryClientProvider client={queryClient}>
      <Layout>
        <ErrorBoundary resetKey={location}>
          {path === "/" && <Dashboard />}
          {path === "/corpus" && <Corpus />}
          {(path === "/bulks" || path === "/runs") && <Bulks />}
          {path === "/results" && <Results />}
          {path === "/setup" && <Setup />}
          {path === "/providers" && <Setup defaultTab="providers" />}
          {path === "/sources" && <Setup defaultTab="sources" />}
          {!KNOWN_ROUTES.has(path) && <NotFound />}
        </ErrorBoundary>
        <Toaster />
      </Layout>
    </QueryClientProvider>
  )
}
