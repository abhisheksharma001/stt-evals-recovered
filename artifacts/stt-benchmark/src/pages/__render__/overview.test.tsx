// @vitest-environment jsdom
//
// T-182: Overview (Dashboard.tsx) rendered against a stubbed API.
//
// Overview is the page Abhishek opens first and the one a stranger is shown
// first, and every number on it comes from a server response the page has
// never been handed outside a browser. What is held here is the behaviour
// that makes the page trustworthy when something is missing: an absent bulk
// says so rather than showing a verdict, a vendor list that will not answer
// reads "?" rather than 0, a dead API says it is dead rather than showing a
// stale build, and a dead dashboard renders a named failure rather than a
// blank page.
//
// Fixtures are typed as the generated response types, so `pnpm run typecheck`
// is the contract check -- a fixture that drifts from the API stops compiling.
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, screen } from "@testing-library/react"
import type { BenchmarkDashboard, BulkDetail, BulkVerdicts, HealthStatus, ProviderModelList } from "@workspace/api-client-react"
import Dashboard from "../Dashboard"
import { installBrowserShims, renderPage, reply, stubApi, type StubRoutes } from "./harness"

installBrowserShims()
afterEach(cleanup)

const dashboard: BenchmarkDashboard = {
  corpusCount: 21,
  readyToRunCount: 16,
  configuredProviderCount: 6,
  totalProviderCount: 9,
  latestRunStatus: "complete",
  decisionStatus: "ready",
  latestFinishedBulk: { id: "bulk-1", name: "August sweep", status: "complete", completedAt: "2026-08-30T10:00:00.000Z" },
  runningBulk: null,
  needsHuman: {
    callsAwaitingReview: 2,
    hardCaseCalls: 1,
    retryableFailedCells: 15,
    // T-140: the hint under the number is built from these groups, so the
    // sentence can never disagree with the count above it.
    retryableFailedCellGroups: [
      { providerId: "cartesia-ink-whisper", providerName: "Cartesia", reason: "provider_timeout", cells: 15 },
    ],
    audioUnsavedCalls: 0,
  },
  thisMonth: {
    monthStart: "2026-08-01T00:00:00.000Z",
    sttMicrocents: 301350,
    sttCellsPriced: 731,
    sttCellsUnpriced: 0,
    agentMicrocents: 14715,
    agentJudgementsPriced: 3,
    agentJudgementsUnpriced: 0,
  },
}

const verdicts: BulkVerdicts = {
  bulkId: "bulk-1",
  providers: [
    { id: "deepgram-nova-3", name: "Deepgram Nova-3" },
    { id: "gladia-solaria", name: "Gladia Solaria" },
  ],
  groups: [
    {
      clientLabel: "Rush",
      assistantIds: ["asst-1"],
      callCount: 12,
      vertical: "rush",
      production: { vendor: "deepgram", model: "nova-3", coverage: 12, total: 12 },
      verdict: {
        decision: "winner",
        winnerProviderId: "deepgram-nova-3",
        runnerUpProviderId: "gladia-solaria",
        leaderProviderId: "deepgram-nova-3",
        marginPct: 18.2,
        vsProductionPct: null,
        productionProviderId: "deepgram-nova-3",
        productionIsLeader: true,
        evidenceCalls: 12,
        provisional: true,
        callsToSettle: 8,
        noiseFloor: { sharedCalls: 12, difference: 0.9, ci95: [0.2, 1.6], withinNoise: false },
        confidenceComparable: { reporting: 2, total: 2 },
        rates: [
          { providerId: "deepgram-nova-3", flagsPer100Words: 1.1, calls: 12, totalFlags: 20, totalWords: 1800 },
          { providerId: "gladia-solaria", flagsPer100Words: 2.0, calls: 12, totalFlags: 36, totalWords: 1800 },
        ],
        sentence: "Deepgram Nova-3 is ahead on 12 calls.",
      },
    },
  ],
}

const models: ProviderModelList = {
  fetchedAt: "2026-08-31T09:00:00.000Z",
  vendors: [
    {
      vendor: "deepgram",
      vendorLabel: "Deepgram",
      adapterId: "deepgram-nova-3",
      apiKeyConfigured: true,
      source: "live",
      error: null,
      models: [],
    },
  ],
}

const health: HealthStatus = {
  status: "ok",
  commitSha: "37f932350c6b",
  builtAt: "2026-08-31T13:49:52.092Z",
  startedAt: "2026-08-31T13:49:52.733Z",
  providersConfigured: ["deepgram-nova-3"],
}

/** The five endpoints Overview reaches for when a bulk is finished. */
const happyRoutes: StubRoutes = {
  "GET /api/benchmark/dashboard": dashboard,
  "GET /api/benchmark/bulks/bulk-1/verdicts": verdicts,
  "GET /api/benchmark/providers/models": models,
  "GET /api/healthz": health,
}

describe("Overview", () => {
  it("shows the server's figures, the retry sentence, and asks for nothing it does not use", async () => {
    const api = stubApi(happyRoutes)
    renderPage(<Dashboard />)

    expect(await screen.findByText("August sweep · Aug 30")).toBeTruthy()
    expect(await screen.findByText("Deepgram Nova-3", { exact: false })).toBeTruthy()
    expect(screen.getByText("calls awaiting review")).toBeTruthy()
    expect(screen.getByText("hard cases")).toBeTruthy()
    // T-140: the number and the sentence under it come from the same groups.
    expect(screen.getByText("transcripts a retry could fix")).toBeTruthy()
    expect(await screen.findByText("all 15 — Cartesia, timed out")).toBeTruthy()
    // Money is shown as spent, split by what spent it.
    expect(screen.getByText("$0.30")).toBeTruthy()
    expect(screen.getByText("$0.01")).toBeTruthy()
    expect(screen.getByText("transcription")).toBeTruthy()
    expect(screen.getByText("AI judge")).toBeTruthy()

    // Nothing asked for that was not planned, and no running-bulk fetch when
    // nothing is running.
    expect(api.unmatched).toEqual([])
    expect(api.calls.some((c) => c.startsWith("GET /api/benchmark/bulks/bulk-2"))).toBe(false)
    expect(screen.queryByText("Running now")).toBeNull()
    api.restore()
  })

  it("with no finished bulk it says so instead of showing a verdict", async () => {
    const api = stubApi({ ...happyRoutes, "GET /api/benchmark/dashboard": { ...dashboard, latestFinishedBulk: null } })
    renderPage(<Dashboard />)

    expect(await screen.findByText("No bulk has finished yet.")).toBeTruthy()
    // A verdict with no bulk behind it is never fetched, let alone shown.
    expect(api.calls.some((c) => c.includes("/verdicts"))).toBe(false)
    expect(screen.queryByText("Share verdict →")).toBeNull()
    api.restore()
  })

  it("a dead dashboard endpoint renders a named failure with a retry, never a blank page", async () => {
    const api = stubApi({ ...happyRoutes, "GET /api/benchmark/dashboard": reply(503, { error: "database is down" }) })
    renderPage(<Dashboard />)

    expect(await screen.findByText("Failed to load the overview")).toBeTruthy()
    expect(screen.getByText("Retry")).toBeTruthy()
    // The real reason reaches the screen -- the person reading it is the one
    // who has to fix it.
    expect(document.body.textContent).toContain("database is down")
    api.restore()
  })

  it("a vendor list that will not answer reads '?', never folded into 'all verified'", async () => {
    const api = stubApi({ ...happyRoutes, "GET /api/benchmark/providers/models": reply(502, { error: "vendor unreachable" }) })
    renderPage(<Dashboard />)

    expect(await screen.findByText("vendor catalogs (model lists unreachable)")).toBeTruthy()
    expect(screen.getByText("?")).toBeTruthy()
    // T-119's clean state must not be showable while the list is unknown.
    expect(document.body.textContent).not.toContain("all verified within")
    api.restore()
  })

  it("one vendor answering with an error is named, and never counted as fresh", async () => {
    const stale: ProviderModelList = {
      ...models,
      vendors: [
        ...models.vendors,
        { vendor: "gladia", vendorLabel: "Gladia", adapterId: "gladia-solaria", apiKeyConfigured: true, source: null, error: "timeout", models: [] },
      ],
    }
    const api = stubApi({ ...happyRoutes, "GET /api/benchmark/providers/models": stale })
    renderPage(<Dashboard />)

    expect(await screen.findByText(/Gladia not answering/)).toBeTruthy()
    api.restore()
  })

  it("an unreachable API says so rather than showing the build it last saw", async () => {
    const api = stubApi({ ...happyRoutes, "GET /api/healthz": reply(500, { error: "down" }) })
    renderPage(<Dashboard />)

    expect(await screen.findByText("API not reachable")).toBeTruthy()
    expect(screen.getByText("down")).toBeTruthy()
    expect(document.body.textContent).not.toContain("37f932350c6b")
    api.restore()
  })

  it("a running bulk shows its own progress, from the bulk's numbers not the dashboard's", async () => {
    const detail: BulkDetail = {
      id: "bulk-2",
      name: "Rush re-run",
      status: "running",
      selectionCriteria: { vertical: "rush" },
      providerIds: ["deepgram-nova-3"],
      shardSize: 50,
      minDurationSeconds: 30,
      maxDurationSeconds: null,
      createdAt: "2026-08-31T12:00:00.000Z",
      progress: {
        callsTotal: 10,
        callsRun: 4,
        cellsTotal: 10,
        cellsOk: 3,
        cellsFailed: 1,
        cellsPending: 6,
        cellsCancelled: 0,
        cellsSkippedPendingReview: 0,
        agentCallsTotal: 10,
        agentCallsChecked: 2,
        agentCallsInFlight: 1,
      },
      runs: [],
      actualCost: {
        sttCostMicrocents: 12000,
        agentCostMicrocents: 4905,
        agentCallsChecked: 2,
        agentCallsFlagged: 1,
        agentCallsResolved: 0,
        agentCallsErrored: 0,
        agentCallsJudged: 1,
      },
      failureBreakdown: [],
    }
    const api = stubApi({
      ...happyRoutes,
      "GET /api/benchmark/dashboard": { ...dashboard, runningBulk: { id: "bulk-2", name: "Rush re-run" } },
      "GET /api/benchmark/bulks/bulk-2": detail,
    })
    renderPage(<Dashboard />)

    expect(await screen.findByText("Running now")).toBeTruthy()
    expect(await screen.findByText("Rush re-run")).toBeTruthy()
    // 3 ok + 1 failed of 10 cells = 40%. Failed cells count as done: the run
    // is not going to revisit them on its own.
    expect(await screen.findByText("· 40%")).toBeTruthy()
    // Spend so far is split the same way as the month total.
    expect(await screen.findByText(/STT so far \$0\.01 · AI check \$0\.00/)).toBeTruthy()
    expect(api.unmatched).toEqual([])
    api.restore()
  })
})
