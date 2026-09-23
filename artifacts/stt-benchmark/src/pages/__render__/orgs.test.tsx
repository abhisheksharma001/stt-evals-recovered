// @vitest-environment jsdom
//
// W-6c: Orgs (Orgs.tsx) rendered against a stubbed API.
//
// Layer 1 of the daily watch. What is held here is the colouring rule and
// the "absent is not zero" rule, because both are the kind of thing a page
// gets wrong silently: a forming baseline that shows amber cries wolf on
// every new agent, a refused day that shows green hides the reason it did
// not run, and a day the ledger settled without a production number must
// not read as "0.0 per 100 words". The verdicts themselves come from the
// server (D-13); the page only maps them to colour and words.
//
// Fixtures are typed as the generated response types -- typecheck is the
// contract check.
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, screen, waitFor } from "@testing-library/react"
import type { WatchOverview, WatchOverviewAgent, WatchOverviewDay } from "@workspace/api-client-react"
import Orgs, { calendarDays, tickTone } from "../Orgs"
import { installBrowserShims, renderPage, stubApi, type StubRoutes } from "./harness"

installBrowserShims()
afterEach(cleanup)

const TODAY = "2026-09-23"
const WINDOW_START = "2026-08-25"

function settled(day: string, rate: number, calls: number): WatchOverviewDay {
  return { day, outcome: "settled", bulkId: `bulk-${day}`, rate, calls, leaderProviderId: "deepgram-nova-3", leaderRate: rate - 0.4 }
}

function agent(over: Partial<WatchOverviewAgent>): WatchOverviewAgent {
  return {
    scheduleId: "sched-1",
    enabled: true,
    assistantId: "asst-rush-1",
    production: { vendor: "deepgram", model: "flux-general-en" },
    baseline: { state: "steady", priorDays: 12, low: 1.8, high: 2.6 },
    monthEstimatedCents: 42,
    days: [settled(TODAY, 2.1, 10)],
    ...over,
  }
}

function overview(agents: WatchOverviewAgent[]): WatchOverview {
  return { today: TODAY, windowStart: WINDOW_START, accounts: [{ accountId: "acct-1", accountLabel: "Rush Clinics", agents }] }
}

function routes(body: WatchOverview): StubRoutes {
  return { "GET /api/benchmark/watch/overview": body }
}

async function rendered(body: WatchOverview) {
  const api = stubApi(routes(body))
  const view = renderPage(<Orgs />, { path: "/orgs" })
  await waitFor(() => expect(view.container.querySelector("[aria-busy]")).toBeNull())
  return { api, view }
}

function ticks(view: { container: HTMLElement }, tone: string): HTMLElement[] {
  return Array.from(view.container.querySelectorAll<HTMLElement>(`[data-tone="${tone}"]`))
}

describe("Orgs", () => {
  it("asks the overview endpoint once and shows the account, the agent and its production transcriber", async () => {
    const { api, view } = await rendered(overview([agent({})]))
    try {
      expect(api.unmatched).toEqual([])
      expect(api.calls.filter((c) => c.startsWith("GET /api/benchmark/watch/overview"))).toHaveLength(1)
      expect(screen.getByText("Rush Clinics")).toBeTruthy()
      expect(screen.getByText("asst-rush-1")).toBeTruthy()
      expect(screen.getByText("runs deepgram flux-general-en")).toBeTruthy()
      expect(screen.getByText("2.1 per 100 words today · 10 calls")).toBeTruthy()
      expect(screen.getByText("within baseline 1.8–2.6")).toBeTruthy()
      expect(screen.getByText("$0.42 this month, estimated")).toBeTruthy()
      // 30 days from windowStart to today inclusive -- the calendar is built
      // from the response, never from the browser clock.
      expect(view.container.querySelectorAll("[data-day]")).toHaveLength(30)
      expect(view.container.textContent).not.toMatch(/vertical/i)
    } finally {
      api.restore()
    }
  })

  it("reads 'baseline forming' and paints no amber tick while the baseline is forming", async () => {
    const { api, view } = await rendered(
      overview([agent({ baseline: { state: "forming", priorDays: 3, low: null, high: null }, days: [settled(TODAY, 9.9, 10)] })]),
    )
    try {
      expect(screen.getByText("baseline forming · 3 of 7 days")).toBeTruthy()
      expect(ticks(view, "moved")).toHaveLength(0)
      expect(ticks(view, "ran")).toHaveLength(1)
    } finally {
      api.restore()
    }
  })

  it("paints today amber and says so when the server's baseline verdict is moved", async () => {
    const { api, view } = await rendered(
      overview([agent({ baseline: { state: "moved", priorDays: 12, low: 1.8, high: 2.6 }, days: [settled("2026-09-22", 2.0, 10), settled(TODAY, 6.0, 10)] })]),
    )
    try {
      expect(screen.getByText("moved against baseline 1.8–2.6")).toBeTruthy()
      const amber = ticks(view, "moved")
      expect(amber).toHaveLength(1)
      expect(amber[0].dataset.day).toBe(TODAY)
      // Yesterday ran and is not re-judged in the browser.
      expect(ticks(view, "ran").map((t) => t.dataset.day)).toEqual(["2026-09-22"])
    } finally {
      api.restore()
    }
  })

  it("paints a refused day red with the ledger outcome verbatim on hover", async () => {
    const { api, view } = await rendered(
      overview([agent({ days: [{ day: "2026-09-20", outcome: "refused:daily_cap", bulkId: null }, settled(TODAY, 2.1, 10)] })]),
    )
    try {
      const red = ticks(view, "bad")
      expect(red).toHaveLength(1)
      expect(red[0].dataset.day).toBe("2026-09-20")
      expect(red[0].title).toContain("refused:daily_cap")
      expect(screen.getByTitle("2026-09-20 · refused:daily_cap")).toBeTruthy()
      // A day with no ledger row is grey and says so.
      expect(screen.getByTitle("2026-09-19 · no run").dataset.tone).toBe("none")
    } finally {
      api.restore()
    }
  })

  it("never shows an absent measurement as 0", async () => {
    const { api, view } = await rendered(
      overview([agent({ days: [{ day: TODAY, outcome: "settled", bulkId: "bulk-mono" }], baseline: { state: "steady", priorDays: 12, low: 1.8, high: 2.6 } })]),
    )
    try {
      expect(screen.getByText("no measurement today (settled)")).toBeTruthy()
      expect(view.container.textContent).not.toContain("0.0 per 100")
      expect(screen.getByTitle(`${TODAY} · settled`)).toBeTruthy()
    } finally {
      api.restore()
    }
  })

  it("greys a paused schedule and names an agent-less one, and says when nothing is watched", async () => {
    const { api } = await rendered(overview([agent({ enabled: false, assistantId: null, production: null })]))
    try {
      expect(screen.getByText("paused")).toBeTruthy()
      expect(screen.getByText("no agent named")).toBeTruthy()
      expect(screen.getByText("production transcriber not on file")).toBeTruthy()
    } finally {
      api.restore()
    }
    cleanup()
    const empty = await rendered({ today: TODAY, windowStart: WINDOW_START, accounts: [] })
    try {
      expect(screen.getByText("No agent is under watch yet.")).toBeTruthy()
    } finally {
      empty.api.restore()
    }
  })
})

describe("tick rules", () => {
  it("colours from the ledger outcome and the server's baseline state only", () => {
    const steady = "steady" as const
    expect(tickTone(undefined, true, "moved")).toBe("none")
    expect(tickTone({ day: TODAY, outcome: "failed", bulkId: null }, true, "moved")).toBe("bad")
    expect(tickTone({ day: TODAY, outcome: "refused:no_key", bulkId: null }, false, steady)).toBe("bad")
    expect(tickTone(settled(TODAY, 5, 10), true, "moved")).toBe("moved")
    expect(tickTone(settled("2026-09-22", 5, 10), false, "moved")).toBe("ran")
    expect(tickTone({ day: TODAY, outcome: "launched", bulkId: "b" }, true, steady)).toBe("ran")
  })

  it("builds the calendar inclusively and refuses a backwards window", () => {
    expect(calendarDays("2026-09-21", "2026-09-23")).toEqual(["2026-09-21", "2026-09-22", "2026-09-23"])
    expect(calendarDays(WINDOW_START, TODAY)).toHaveLength(30)
    expect(calendarDays(TODAY, WINDOW_START)).toEqual([])
  })
})
