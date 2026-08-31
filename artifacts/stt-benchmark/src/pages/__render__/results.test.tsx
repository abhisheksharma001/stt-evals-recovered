// @vitest-environment jsdom
//
// T-183: Results (Rankings.tsx) rendered against a stubbed API.
//
// This is the page the decision is read off. Three things on it can be
// wrong in ways no server test can see, because they are all about what the
// page does with a correct response:
//   - scope: "One bulk" must ask for that bulk and the all-time view must
//     not pretend to a verdict it has no noise floor for;
//   - the word "Winner": it belongs to the verdict, never to rank 1;
//   - price: the $/min column is what the bulk PAID, so a changed list
//     price has to announce itself instead of silently disagreeing.
// Fixtures are typed as the generated response types -- typecheck is the
// contract check.
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, screen, within } from "@testing-library/react"
import type {
  AppSettings,
  BenchmarkCall,
  Bulk,
  BulkVerdicts,
  Provider,
  VerticalRanking,
} from "@workspace/api-client-react"
import Results from "../Rankings"
import { installBrowserShims, renderPage, reply, stubApi, type StubRoutes } from "./harness"

installBrowserShims()
afterEach(cleanup)

const emptyScore = {
  wer: null,
  entityAccuracy: null,
  alphanumericAccuracy: null,
  latencyFirstPartialMs: null,
  latencyFinalMs: null,
  costPerMinute: null,
  diarizationScore: null,
  avgFlagCount: null,
  avgFlagSeverityScore: null,
  avgPeerFlagCount: null,
  avgPeerFlagSeverityScore: null,
  peerFlagsPer100Words: null,
  cleanCallRate: null,
} satisfies VerticalRanking["score"]

function row(over: Partial<VerticalRanking> & Pick<VerticalRanking, "providerId" | "providerName" | "rank">): VerticalRanking {
  return {
    runId: "run-1",
    vertical: "rush",
    assistantId: "asst-rush",
    assistantLabel: "Rush parts desk",
    recommendation: "",
    score: emptyScore,
    ...over,
  }
}

const rankings: VerticalRanking[] = [
  row({
    providerId: "deepgram-nova-3",
    providerName: "Deepgram Nova-3",
    rank: 1,
    score: { ...emptyScore, avgFlagCount: 1.1, avgPeerFlagCount: 0.9, costPerMinute: 0.0043, latencyFinalMs: 3500 },
  }),
  row({
    providerId: "gladia-solaria",
    providerName: "Gladia Solaria",
    rank: 2,
    score: { ...emptyScore, avgFlagCount: 2.4, avgPeerFlagCount: 2.0, costPerMinute: 0.0061, latencyFinalMs: 15300 },
  }),
  // A manually-added call has no Vapi assistant. It gets its own bucket that
  // says why, instead of being folded into a real org or dropped.
  row({
    providerId: "deepgram-nova-3",
    providerName: "Deepgram Nova-3",
    rank: 1,
    assistantId: null,
    assistantLabel: "Unassigned (no assistant ID captured at import)",
    score: { ...emptyScore, avgFlagCount: 3.0, avgPeerFlagCount: 2.8 },
  }),
]

const providers: Provider[] = [
  {
    id: "deepgram-nova-3",
    name: "Deepgram Nova-3",
    model: "nova-3",
    status: "ready",
    supportsStreaming: true,
    supportsDiarization: true,
    // T-116: the list price on Setup today, deliberately above what the bulk
    // paid below, so the chip has something to say.
    costPerMinute: 0.0077,
    keywordBoosting: true,
    hasAdapter: true,
    apiKeyConfigured: true,
  },
  {
    id: "gladia-solaria",
    name: "Gladia Solaria",
    model: "solaria-1",
    status: "ready",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.0061,
    keywordBoosting: false,
    hasAdapter: true,
    apiKeyConfigured: true,
  },
]

const bulks: Bulk[] = [
  {
    id: "bulk-1",
    name: "August sweep",
    status: "complete",
    selectionCriteria: { vertical: "rush" },
    providerIds: ["deepgram-nova-3", "gladia-solaria"],
    shardSize: 50,
    minDurationSeconds: 30,
    maxDurationSeconds: null,
    createdAt: "2026-08-30T09:00:00.000Z",
    completedAt: "2026-08-30T10:00:00.000Z",
  },
]

const calls: BenchmarkCall[] = [
  {
    id: "call-1",
    label: "Rush 001",
    vertical: "rush",
    durationSeconds: 120,
    status: "ready_to_run",
    hardCases: [],
    entityReferences: [],
    sourceAccountLabel: "Default",
    sourceAssistantId: "asst-rush",
    createdAt: "2026-08-20T09:00:00.000Z",
  },
]

const settings: AppSettings = { activeProviderId: "deepgram-nova-3", agentModel: "gpt-4o" }

const verdicts: BulkVerdicts = {
  bulkId: "bulk-1",
  providers: [
    { id: "deepgram-nova-3", name: "Deepgram Nova-3" },
    { id: "gladia-solaria", name: "Gladia Solaria" },
  ],
  groups: [
    {
      clientLabel: "Default",
      assistantIds: ["asst-rush"],
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
          { providerId: "deepgram-nova-3", flagsPer100Words: 0.9, calls: 12, totalFlags: 16, totalWords: 1800 },
          { providerId: "gladia-solaria", flagsPer100Words: 2.0, calls: 12, totalFlags: 36, totalWords: 1800 },
        ],
        sentence: "Deepgram Nova-3 is ahead on 12 calls.",
      },
    },
  ],
}

const baseRoutes: StubRoutes = {
  "GET /api/benchmark/providers": providers,
  "GET /api/benchmark/bulks": bulks,
  "GET /api/benchmark/rankings": rankings,
  "GET /api/benchmark/settings": settings,
  "GET /api/benchmark/calls": calls,
  "GET /api/benchmark/bulks/bulk-1/verdicts": verdicts,
  "GET /api/benchmark/bulks/bulk-1": reply(404, { error: "not needed by these assertions" }),
}

describe("Results", () => {
  it("One bulk asks for that bulk's rankings and names the verdict's winner", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })

    expect((await screen.findAllByText("Deepgram Nova-3")).length).toBeGreaterThan(0)
    // Scope is in the request, not filtered in the browser: the bulk the
    // picker defaults to (newest first) is the one the server is asked for.
    expect(api.calls.some((c) => c === "GET /api/benchmark/rankings?bulkId=bulk-1")).toBe(true)
    // T-57: "Winner" is the verdict's word. Rank 1 alone does not earn it --
    // the unassigned bucket's rank 1 has no verdict and says so. The row
    // marker is matched by its own title, because the word also appears in
    // the verdict chip and in the legend that explains it.
    expect(screen.getAllByTitle(/Named by this group's verdict/).length).toBe(1)
    expect(screen.getAllByText("Ahead, not a winner").length).toBe(1)
    // The provider production runs on is marked, from settings.
    expect(screen.getAllByText("In production").length).toBeGreaterThan(0)
    api.restore()
  })

  it("a ranking row with no assistant gets a bucket that says why, never dropped", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })

    expect(await screen.findByText(/Unassigned \(no assistant ID captured at import\)/)).toBeTruthy()
    api.restore()
  })

  it("switching to all-time drops the bulk filter and claims no verdict", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })

    expect((await screen.findAllByText("Deepgram Nova-3")).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText("All-time combined"))

    // Both rank-1 rows now read "ahead": with no verdict, nothing is decided.
    expect((await screen.findAllByText("Ahead, not a winner")).length).toBe(2)
    // The all-time view has no noise floor of its own, so it shows no
    // verdict rather than a wrong one -- no row is named a winner here.
    expect(screen.queryAllByTitle(/Named by this group's verdict/)).toEqual([])
    expect(api.calls).toContain("GET /api/benchmark/rankings")
    api.restore()
  })

  it("a paid rate that no longer matches the list price says so on the row", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })

    // Deepgram: the bulk paid $0.0043/min, Setup says $0.0077 today.
    const chips = await screen.findAllByTestId("paid-vs-list")
    expect(chips.length).toBe(1)
    expect(chips[0].textContent).toContain("0.0077")
    expect(chips[0].title).toContain("This bulk paid")
    api.restore()
  })

  it("a paid rate matching today's list price stays quiet", async () => {
    // Gladia paid exactly its list price; only Deepgram's chip should exist,
    // which the previous test already counted. Here the list price is moved
    // to match, and the chip disappears entirely.
    const matched: Provider[] = providers.map((p) => (p.id === "deepgram-nova-3" ? { ...p, costPerMinute: 0.0043 } : p))
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/providers": matched })
    renderPage(<Results />, { path: "/results" })

    expect((await screen.findAllByText("Deepgram Nova-3")).length).toBeGreaterThan(0)
    expect(screen.queryAllByTestId("paid-vs-list")).toEqual([])
    api.restore()
  })

  it("a dead rankings endpoint names the failure and offers a retry", async () => {
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/rankings": reply(500, { error: "rankings query blew up" }) })
    renderPage(<Results />, { path: "/results" })

    expect(await screen.findByText(/Failed to load rankings/)).toBeTruthy()
    expect(screen.getByText("Retry")).toBeTruthy()
    expect(document.body.textContent).toContain("rankings query blew up")
    api.restore()
  })

  it("the page explains its own arrows before any number is read", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })

    const legend = await screen.findByTestId("results-legend")
    expect(within(legend).getByText("Lower is better")).toBeTruthy()
    api.restore()
  })
})
