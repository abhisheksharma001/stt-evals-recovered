// T-182: the harness the page tests share.
//
// Why this exists. The API surface is covered end to end (110 integration
// tests), but nothing renders a page. A page can still white-screen on data
// the API is perfectly happy to send -- a null where the JSX reads `.length`,
// an empty list where a `[0]` is indexed, a number formatter handed a string.
// tsc cannot see it, because the page reads a *response*, and nobody had ever
// handed a page a response outside a browser.
//
// The shape of the thing, in n8n terms: `stubApi` is a fake HTTP node. It
// answers the page's requests from a table you write in the test, records
// every request, and refuses (500) anything you did not plan for -- so a page
// quietly depending on an endpoint you never listed shows up as a failure
// instead of an empty section.
//
// The fixtures in each test are typed as the generated response types from
// `@workspace/api-client-react`. That is deliberate: the contract check is
// `pnpm run typecheck`, not a hand-written schema here. A page test whose
// fixture drifts from the API contract stops compiling.
import * as React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, type RenderResult } from "@testing-library/react"
import { Router } from "wouter"
import { memoryLocation } from "wouter/memory-location"

// ---------------------------------------------------------------------------
// jsdom shims
// ---------------------------------------------------------------------------

/**
 * jsdom implements the DOM, not a browser. These are what the app's
 * dependencies reach for and jsdom does not provide; without them a render
 * throws before any assertion runs. Call once per file. The first four are
 * added only when missing; the media methods are always replaced, because
 * jsdom does define them -- as functions that throw "Not implemented".
 */
export function installBrowserShims(): void {
  const w = globalThis as unknown as Record<string, unknown>

  if (!w.ResizeObserver) {
    // recharts (Results' trend strip) and radix popovers measure their box.
    w.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  if (!w.IntersectionObserver) {
    w.IntersectionObserver = class {
      readonly root = null
      readonly rootMargin = ""
      readonly thresholds: number[] = []
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    }
  }
  if (typeof window !== "undefined" && !window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
  }
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {}
  }
  if (typeof HTMLMediaElement !== "undefined") {
    // Call audio players mount on several pages. jsdom throws
    // "Not implemented" from play/pause/load unless they are replaced.
    HTMLMediaElement.prototype.play = async function play() {}
    HTMLMediaElement.prototype.pause = function pause() {}
    HTMLMediaElement.prototype.load = function load() {}
  }
}

// ---------------------------------------------------------------------------
// The fake API
// ---------------------------------------------------------------------------

/**
 * What a stubbed endpoint answers. A plain value is the 200 body; a non-200
 * answer is built with {@link reply}.
 *
 * The branding is not decoration. The first version of this harness spotted a
 * non-200 answer by duck-typing -- "an object with a `status` field is an
 * envelope" -- and this API's payloads have a `status` field of their own
 * (`HealthStatus.status: "ok"`, `BulkDetail.status: "running"`). Those
 * fixtures were read as envelopes and turned into `new Response(null,
 * { status: "ok" })`, which throws. A body is a body unless it is explicitly
 * marked otherwise.
 */
export type StubReply = unknown

const STUB_REPLY = Symbol.for("stt-evals.stub-reply")

type StubEnvelope = { [STUB_REPLY]: true; status: number; body?: unknown }

/** A non-200 answer (or a 204). `reply(503, { error: "..." })`. */
export function reply(status: number, body?: unknown): StubReply {
  return { [STUB_REPLY]: true, status, body } satisfies StubEnvelope
}

/**
 * Route table. Keys are `"<METHOD> <pathname>"` -- for example
 * `"GET /api/benchmark/dashboard"`. A key may end in `*` to match by prefix,
 * which is how id-bearing paths (`/api/benchmark/bulks/<uuid>`) are covered.
 * Query strings never take part in matching; assert on `api.calls` instead.
 */
export type StubRoutes = Record<string, StubReply>

export type StubbedApi = {
  /** Every request the page made, in order, as `"GET /api/..."` with query. */
  readonly calls: string[]
  /** Requests no route matched. A page test should assert this stays empty. */
  readonly unmatched: string[]
  /** True when the page asked for this path (query string ignored). */
  asked(methodAndPath: string): boolean
  restore(): void
}

function matchRoute(routes: StubRoutes, key: string): StubReply | undefined {
  if (key in routes) return routes[key]
  for (const [pattern, reply] of Object.entries(routes)) {
    if (pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1))) return reply
  }
  return undefined
}

function isEnvelope(value: StubReply): value is StubEnvelope {
  return typeof value === "object" && value !== null && STUB_REPLY in value
}

/**
 * Replace `fetch` for the duration of a test. Anything the page asks for that
 * is not in `routes` answers 500 and lands in `unmatched` -- silence is never
 * a pass here.
 */
export function stubApi(routes: StubRoutes): StubbedApi {
  const original = globalThis.fetch
  const calls: string[] = []
  const unmatched: string[] = []

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    // Relative URLs are the norm here (the client's default base is "/api").
    const url = new URL(raw, "http://test.local")
    calls.push(`${method} ${url.pathname}${url.search}`)

    const matched = matchRoute(routes, `${method} ${url.pathname}`)
    if (matched === undefined) {
      unmatched.push(`${method} ${url.pathname}`)
      return new Response(JSON.stringify({ error: `no stub for ${method} ${url.pathname}` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    }

    const status = isEnvelope(matched) ? matched.status : 200
    const body = isEnvelope(matched) ? matched.body : matched
    if (body === undefined || status === 204) return new Response(null, { status })
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  return {
    calls,
    unmatched,
    asked: (methodAndPath: string) => calls.some((c) => c.split("?")[0] === methodAndPath),
    restore: () => {
      globalThis.fetch = original
    },
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render a page the way App.tsx does, minus the shell: its own QueryClient
 * (so nothing leaks between tests) with retries off -- a test that waits out
 * two retry backoffs is a test that times out for the wrong reason.
 */
export function renderPage(ui: React.ReactElement, options?: { path?: string }): RenderResult {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  })
  const { hook } = memoryLocation({ path: options?.path ?? "/", static: false })
  return render(
    <QueryClientProvider client={client}>
      <Router hook={hook}>{ui}</Router>
    </QueryClientProvider>,
  )
}
