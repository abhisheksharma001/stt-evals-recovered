// @vitest-environment jsdom
//
// T-184: Calls (Corpus.tsx) rendered against a stubbed API.
//
// Two things on this page are statements of fact about audio that nobody
// can check by reading the API's response alone:
//   - the per-call chip ("audio saved" / "Nd left" / "audio gone" / "source
//     refuses audio"), which must never invent a state for a call whose age
//     is unknown; and
//   - the "Save audio now (N)" button, whose count must equal what a click
//     can actually save -- counting a call the source will never hand over
//     leaves a button that can never reach zero.
// Dates are relative to now, so the fixtures do not rot.
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, screen, within } from "@testing-library/react"
import type {
  AgentScan,
  BenchmarkCall,
  BenchmarkDashboard,
  CallDisagreement,
  VapiAssistant,
} from "@workspace/api-client-react"
import Corpus from "../Corpus"
import { installBrowserShims, renderPage, reply, stubApi, type StubRoutes } from "./harness"

installBrowserShims()
afterEach(cleanup)

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

function call(over: Partial<BenchmarkCall> & Pick<BenchmarkCall, "id" | "label">): BenchmarkCall {
  return {
    vertical: "rush",
    durationSeconds: 120,
    status: "ready_to_run",
    hardCases: [],
    entityReferences: [],
    createdAt: daysAgo(30),
    ...over,
  }
}

const calls: BenchmarkCall[] = [
  // Cached, and far older than the window: bytes on disk mean Vapi's clock
  // stopped mattering.
  call({ id: "call-saved", label: "A saved", audioCached: true, sourceStartedAt: daysAgo(60), sourceAccountLabel: "Default", sourceAssistantId: "asst-1" }),
  // Uncached and fresh: nothing to warn about yet.
  call({ id: "call-fresh", label: "B fresh", audioCached: false, sourceStartedAt: daysAgo(3), sourceAccountLabel: "Default", sourceAssistantId: "asst-1" }),
  // Uncached past day 14: gone for everyone, and a click cannot fix it.
  call({ id: "call-gone", label: "C gone", audioCached: false, sourceStartedAt: daysAgo(20), sourceAccountLabel: "Land And Apartment", sourceAssistantId: "asst-2" }),
  // Uncached at day 11: three days of warning left.
  call({ id: "call-expiring", label: "D expiring", audioCached: false, sourceStartedAt: daysAgo(11), sourceAccountLabel: "Land And Apartment", sourceAssistantId: "asst-2" }),
  // The server already tried and the source refused permanently.
  call({ id: "call-refused", label: "E refused", audioCached: false, sourceStartedAt: daysAgo(12), audioCacheLastOutcome: "source_refused", sourceAccountLabel: "Default", sourceAssistantId: "asst-1" }),
  // Added by hand: no source date at all, so its age is unknown.
  call({ id: "call-manual", label: "F manual", audioCached: false }),
]

const assistants: VapiAssistant[] = [
  { id: "asst-1", name: "Rush parts desk", accountId: "acct-1", accountLabel: "Default" },
  { id: "asst-2", name: "Leasing line", accountId: "acct-2", accountLabel: "Land And Apartment" },
]

// C is the worst call, then A; B scored clean. Everything else never ran.
const disagreement: CallDisagreement = {
  bulkId: null,
  calls: [
    { callId: "call-gone", disagreements: 9, providers: 4 },
    { callId: "call-saved", disagreements: 3, providers: 4 },
    { callId: "call-fresh", disagreements: 0, providers: 4 },
  ],
}

const scans: AgentScan[] = [
  {
    id: "scan-1",
    callId: "call-saved",
    sourceLabel: "draft",
    sourceTranscript: null,
    status: "flagged",
    flags: [],
    candidates: [],
    agentPickProviderId: "deepgram-nova-3",
    agentPickReasoning: "reads more sensibly",
    judgeConfidence: "high",
    requestedByLabel: "bulk:bulk-1",
    createdAt: daysAgo(1),
  },
]

const dashboard: BenchmarkDashboard = {
  corpusCount: calls.length,
  readyToRunCount: calls.length,
  configuredProviderCount: 4,
  totalProviderCount: 9,
  latestRunStatus: "complete",
  decisionStatus: "ready",
  latestFinishedBulk: null,
  runningBulk: null,
  needsHuman: { callsAwaitingReview: 0, hardCaseCalls: 0, retryableFailedCells: 0, retryableFailedCellGroups: [], audioUnsavedCalls: 3 },
  thisMonth: { monthStart: daysAgo(30), sttMicrocents: 0, sttCellsPriced: 0, sttCellsUnpriced: 0, agentMicrocents: 0, agentJudgementsPriced: 0, agentJudgementsUnpriced: 0 },
}

const baseRoutes: StubRoutes = {
  "GET /api/benchmark/calls": calls,
  "GET /api/benchmark/agent/scans": scans,
  "GET /api/benchmark/dashboard": dashboard,
  "GET /api/benchmark/vapi/assistants": assistants,
  "GET /api/benchmark/calls/disagreement": disagreement,
}

/** The retention chip on one call's row, by the call's visible label. */
function chipFor(label: string): string {
  const row = screen.getByText(label).closest("tr")!
  return within(row).getByTestId("retention-chip").textContent ?? ""
}

describe("Calls", () => {
  it("states each call's audio as a fact, and invents no state for a call with no known age", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Corpus />, { path: "/corpus" })

    fireEvent.click(await screen.findByText("Flat"))
    await screen.findByText("A saved")

    // Cached wins outright, whatever the call's age.
    expect(chipFor("A saved")).toContain("audio saved")
    expect(chipFor("C gone")).toContain("audio gone")
    expect(chipFor("D expiring")).toContain("3d left")
    // T-131: a permanent refusal is stated before any age math -- this call
    // is only 12 days old and still unfetchable.
    expect(chipFor("E refused")).toContain("source refuses audio")
    // Fresh, and unknown-age: no chip rather than a guess in either
    // direction.
    const fresh = screen.getByText("B fresh").closest("tr")!
    expect(within(fresh).queryByTestId("retention-chip")).toBeNull()
    const manual = screen.getByText("F manual").closest("tr")!
    expect(within(manual).queryByTestId("retention-chip")).toBeNull()
    expect(api.unmatched).toEqual([])
    api.restore()
  })

  it("the rescue button counts only the calls a click can actually save", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Corpus />, { path: "/corpus" })

    // Six calls: one cached, one gone, one refused. Three are savable.
    const button = await screen.findByTestId("rescue-audio-button")
    expect(button.textContent).toBe("Save audio now (3)")
    // The summary beside it counts the rows on screen.
    expect((await screen.findByTestId("audio-retention-summary")).textContent).toContain("1 audio saved")
    expect((await screen.findByTestId("audio-retention-summary")).textContent).toContain("1 gone for good")
    expect(api.unmatched).toEqual([])
    api.restore()
  })

  it("groups org then assistant, and names the bucket for a call with no assistant", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Corpus />, { path: "/corpus" })

    expect((await screen.findAllByTestId("org-group")).length).toBe(3)
    const assistantRows = screen.getAllByTestId("assistant-group")
    expect(assistantRows.map((r) => r.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Rush parts desk"), expect.stringContaining("Leasing line")]),
    )
    // A hand-added call is not silently attached to a real assistant.
    expect(screen.getByText("No assistant id captured at import")).toBeTruthy()
    api.restore()
  })

  it("flat view puts the worst call first, and a call that never ran last", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Corpus />, { path: "/corpus" })

    fireEvent.click(await screen.findByText("Flat"))
    await screen.findByText("C gone")
    const labels = ["A saved", "B fresh", "C gone", "D expiring", "E refused", "F manual"]
    const order = screen
      .getAllByRole("row")
      .map((r) => labels.find((l) => r.textContent?.includes(l)))
      .filter((l): l is string => !!l)
    // 9 disagreements, then 3, then 0; the three never scored sort last, by
    // label -- absent is not zero.
    expect(order).toEqual(["C gone", "A saved", "B fresh", "D expiring", "E refused", "F manual"])
    api.restore()
  })

  it("carries the AI check's verdict on the call's own row", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Corpus />, { path: "/corpus" })

    fireEvent.click(await screen.findByText("Flat"))
    const scanned = (await screen.findByText("A saved")).closest("tr")!
    expect(within(scanned).getByTestId("judge-chip").textContent).toBe("judge: high")
    // A call the check never scanned shows no chip -- never "clean".
    const unscanned = screen.getByText("D expiring").closest("tr")!
    expect(within(unscanned).queryByTestId("judge-chip")).toBeNull()
    api.restore()
  })

  it("a dead calls endpoint names the failure and offers a retry", async () => {
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/calls": reply(503, { error: "calls query failed" }) })
    renderPage(<Corpus />, { path: "/corpus" })

    expect(await screen.findByText(/Failed to load/)).toBeTruthy()
    expect(screen.getByText("Retry")).toBeTruthy()
    expect(document.body.textContent).toContain("calls query failed")
    api.restore()
  })
})
