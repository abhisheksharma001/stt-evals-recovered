// @vitest-environment jsdom
//
// T-183: Results (Rankings.tsx) rendered against a stubbed API.
//
// This is the page the decision is read off. Three things on it can be
// wrong in ways no server test can see, because they are all about what the
// page does with a correct response:
//   - scope: "One bulk" must ask for that bulk and the all-time view must
//     not pretend to a verdict it has no noise floor for;
//   - the verdict's phrase ("Least disagreement" since M-9, "Winner"
//     before it): it belongs to the verdict, never to rank 1;
//   - price: the $/min column is what the bulk PAID, so a changed list
//     price has to announce itself instead of silently disagreeing.
// Fixtures are typed as the generated response types -- typecheck is the
// contract check.
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react"
import type {
  AgentMark,
  AppSettings,
  BenchmarkCall,
  Bulk,
  BulkDetail,
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
  latencyEndOfAudioMs: null,
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
    // R-4: the sentence run-executor stores for rank 1. It used to be "" in
    // this fixture, so the card's own block never rendered and no assertion
    // here could see it.
    recommendation: "On this assistant's 12 calls: fewest disagreements Deepgram Nova-3, cheapest Deepgram Nova-3.",
    score: { ...emptyScore, avgFlagCount: 1.1, avgPeerFlagCount: 0.9, costPerMinute: 0.0043, latencyFinalMs: 3500 },
  }),
  row({
    providerId: "gladia-solaria",
    providerName: "Gladia Solaria",
    rank: 2,
    // M-10e: the only row carrying an end-of-audio number, and it is rank
    // 2 on purpose -- the number must not read as having won anything.
    score: { ...emptyScore, avgFlagCount: 2.4, avgPeerFlagCount: 2.0, costPerMinute: 0.0061, latencyFinalMs: 15300, latencyEndOfAudioMs: 812 },
  }),
  // A manually-added call has no Vapi assistant. It gets its own bucket that
  // says why, instead of being folded into a real org or dropped.
  row({
    providerId: "deepgram-nova-3",
    providerName: "Deepgram Nova-3",
    rank: 1,
    assistantId: null,
    assistantLabel: "Unassigned (no assistant ID captured at import)",
    recommendation:
      "On 3 calls with no assistant on file: only Deepgram Nova-3 produced a transcript to compare, so nothing here is a comparison.",
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

// M-7b: the same assistant's calls, carrying the production signals M-7a
// stores. Deliberately mixed: three calls Vapi timed, two it never did.
// 378.29998779296875 is what Postgres real() hands back for 378.3.
function signalCall(id: string, over: Partial<BenchmarkCall>): BenchmarkCall {
  return {
    id,
    label: id,
    vertical: "rush",
    durationSeconds: 120,
    status: "ready_to_run",
    hardCases: [],
    entityReferences: [],
    sourceAccountLabel: "Default",
    sourceAssistantId: "asst-rush",
    sourceTranscriberProvider: "deepgram",
    sourceTranscriberModel: "nova-3",
    createdAt: "2026-08-20T09:00:00.000Z",
    ...over,
  }
}

const measuredCalls: BenchmarkCall[] = [
  signalCall("m-1", { prodTranscriberLatencyMs: 206.5, prodAssistantInterruptions: 0 }),
  signalCall("m-2", { prodTranscriberLatencyMs: 378.29998779296875, prodAssistantInterruptions: 2 }),
  signalCall("m-3", { prodTranscriberLatencyMs: 495, prodAssistantInterruptions: 0 }),
  signalCall("m-4", {}),
  signalCall("m-5", {}),
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
      // M-8a: this fixture's bulk is mono, so production has no comparable
      // number. Results renders nothing for it -- that line arrives in M-8b.
      productionDisagreement: null,
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

// M-5a: the channel line reads the BULK's frozen criteria, so it needs the
// detail response the rest of this file deliberately does without.
function detailFor(requireCustomerAudio: boolean | undefined): BulkDetail {
  return {
    ...bulks[0],
    selectionCriteria: { ...bulks[0].selectionCriteria, requireCustomerAudio },
    progress: {
      callsTotal: 12, callsRun: 12, cellsTotal: 24, cellsOk: 24, cellsFailed: 0,
      cellsPending: 0, cellsCancelled: 0, cellsSkippedPendingReview: 0,
      agentCallsTotal: 12, agentCallsChecked: 12, agentCallsInFlight: 0,
    },
    runs: [],
    actualCost: {
      sttCostMicrocents: 500_000, agentCostMicrocents: 120_000, agentCallsChecked: 12,
      agentCallsFlagged: 3, agentCallsResolved: 0, agentCallsErrored: 0, agentCallsJudged: 3,
    },
    failureBreakdown: [],
  }
}

const baseRoutes: StubRoutes = {
  "GET /api/benchmark/providers": providers,
  "GET /api/benchmark/bulks": bulks,
  "GET /api/benchmark/rankings": rankings,
  "GET /api/benchmark/settings": settings,
  "GET /api/benchmark/calls": calls,
  "GET /api/benchmark/bulks/bulk-1/verdicts": verdicts,
  "GET /api/benchmark/bulks/bulk-1": reply(404, { error: "not needed by these assertions" }),
  // U-1b: every assistant card asks what has been marked on it. Empty by
  // default so the other assertions here see the page they were written for.
  "GET /api/benchmark/agent-marks": [],
}

describe("Results", () => {
  // M-18: the agreement figure appended to M-9's legend. Three branches,
  // because the interesting one is the branch that refuses to print a number.
  const agreement = (
    labelledCalls: number,
    n: number,
    top1: number | null,
    tau: number | null,
    // M-20 rides on the same response and the same floor. Defaulted so the
    // M-18 cases above read unchanged; the M-20 cases pass them.
    judgePicks = 0,
    judgeTop1Agreement: number | null = null,
  ) => ({
    labelledCalls,
    n,
    top1Agreement: top1,
    kendallTau: tau,
    judgePicks,
    judgeTop1Agreement,
  })

  it("says nothing about human transcripts when nobody has written one", async () => {
    stubApi({ ...baseRoutes, "GET /api/benchmark/proxy-agreement": agreement(0, 0, null, null) })
    renderPage(<Results />, { path: "/results" })
    await screen.findAllByText("Deepgram Nova-3")

    // M-9's line already says the ranking is not scored against a human
    // transcript. "0 of 20" underneath it is that sentence twice.
    expect(screen.getAllByTestId("relative-not-accuracy").length).toBe(1)
    expect(screen.queryByTestId("proxy-agreement")).toBeNull()
  })

  // R-14: below the floor this line used to read "Not enough human-checked
  // calls to measure this yet -- 2 of 20", a progress bar over a counter that
  // will never advance. Both roads to a labelled set are closed by decision
  // (2026-09-09), so the sentence now says the check is not being run, why, and
  // what the order IS measured on. The count survives as evidence, not progress.
  it("says the check is not being run, and no percentage, below 20 calls", async () => {
    // The corpus R-14 was built on: 2 labelled calls, tau-b 0.017 -- no
    // relationship. The step as written would have printed "agreed 50% of
    // the time" off that. The floor is M-20's, on this same labelled set.
    //
    // R-17: labelledCalls and n differ here on purpose. They were equal on the
    // live corpus, which is why R-14 could print n beside the words "written
    // out by a person" and look right. 3 people transcribed, 2 rankable: the
    // sentence has to say 3.
    stubApi({ ...baseRoutes, "GET /api/benchmark/proxy-agreement": agreement(3, 2, 0.5, 0.017) })
    renderPage(<Results />, { path: "/results" })

    const line = await screen.findByTestId("proxy-agreement")
    expect(line.textContent).toContain("Not checked against human transcripts.")
    expect(line.textContent).toContain("needs 20 calls written out by a person")
    expect(line.textContent).toContain("3 exist and no more are being written")
    // The count that is NOT what a person transcribed must not stand there.
    expect(line.textContent).not.toContain("2 exist")
    // What the reader is looking at instead. Without this the sentence says
    // only what is missing and the ranking is left unexplained.
    expect(line.textContent).toContain("the ranking on this page measures is how much the providers disagreed")
    // The whole failure this step exists to prevent: any wording that reads as
    // a human pass still to come.
    expect(line.textContent).not.toContain("yet")
    expect(line.textContent).not.toContain("%")
    expect(line.textContent).not.toContain("50")
    // The whole-order figure is still available to anyone who wants it.
    expect(line.getAttribute("title")).toContain("0.02")
  })

  // R-17 cleared the fragment gold, so the live corpus is one labelled call
  // and this branch is the one a reader actually sees. "1 exist" is what the
  // sentence said before this case existed.
  it("says 'exists', not 'exist', on a single labelled call", async () => {
    stubApi({ ...baseRoutes, "GET /api/benchmark/proxy-agreement": agreement(1, 1, 1, null) })
    renderPage(<Results />, { path: "/results" })

    const line = await screen.findByTestId("proxy-agreement")
    expect(line.textContent).toContain("1 exists and no more are being written")
    expect(line.textContent).not.toContain("1 exist ")
    // One call at 100% is precisely the number the floor exists to withhold.
    expect(line.textContent).not.toContain("%")
  })

  it("prints the agreement percentage once the labelled set reaches the floor", async () => {
    // 24 calls carry a gold; 21 of them could be ranked two ways. The
    // sentence counts the ones that were actually measured, not the ones
    // that were labelled -- and the tooltip says why the two differ.
    stubApi({ ...baseRoutes, "GET /api/benchmark/proxy-agreement": agreement(24, 21, 0.7142857, 0.63) })
    renderPage(<Results />, { path: "/results" })

    const line = await screen.findByTestId("proxy-agreement")
    // Both counts, because they differ: 24 people-hours of transcription,
    // 21 calls that could actually be ranked two ways. Naming only n beside
    // "a person has transcribed" would credit less work than was done.
    expect(line.textContent).toContain("On 21 of the 24 calls a person has transcribed")
    expect(line.textContent).toContain("71% of the time")
    expect(line.textContent).not.toContain("Not checked against human transcripts")
    expect(line.getAttribute("title")).toContain("24 call(s) carry a human transcript")
    expect(line.getAttribute("title")).toContain("0.63")
  })

  // M-20: the judge's pick has been shown as a verdict input since T-108 and
  // its accuracy has never been measured. Below the floor the card has to say
  // so with a number and no percentage -- the failure this guards is a card
  // that prints "100%" off one call.
  it("refuses a judge-accuracy percentage below the floor, and says the check is not being run", async () => {
    stubApi({ ...baseRoutes, "GET /api/benchmark/proxy-agreement": agreement(2, 2, 0.5, 0.017, 1, 0) })
    renderPage(<Results />, { path: "/results" })

    const line = await screen.findByTestId("judge-accuracy")
    expect(line.textContent).toContain("Judge accuracy: not checked.")
    expect(line.textContent).toContain("1 of")
    expect(line.textContent).toContain("20")
    expect(line.textContent).toContain("none are coming")
    // R-14: the judge's pick is on this page as a verdict input. Saying only
    // "not checked" would leave a reader free to read it as a right answer
    // that simply has not been graded.
    expect(line.textContent).toContain("never as a verified answer")
    expect(line.textContent).not.toContain("yet")
    expect(line.textContent).not.toContain("%")
  })

  it("prints the judge-accuracy percentage once the measured set reaches the floor", async () => {
    stubApi({ ...baseRoutes, "GET /api/benchmark/proxy-agreement": agreement(30, 28, 0.7, 0.63, 24, 0.625) })
    renderPage(<Results />, { path: "/results" })

    const line = await screen.findByTestId("judge-accuracy")
    expect(line.textContent).toContain("on 24 calls a person has transcribed")
    expect(line.textContent).toContain("63% of the time")
    expect(line.textContent).not.toContain("not checked")
  })

  // The two lines share one floor and one response. This is the pair that
  // must never disagree about whether the measurement exists.
  it("shows both lines or neither, never one alone", async () => {
    stubApi({ ...baseRoutes, "GET /api/benchmark/proxy-agreement": agreement(0, 0, null, null, 0, null) })
    renderPage(<Results />, { path: "/results" })
    await screen.findAllByText("Deepgram Nova-3")
    expect(screen.queryByTestId("proxy-agreement")).toBeNull()
    expect(screen.queryByTestId("judge-accuracy")).toBeNull()

    cleanup()
    stubApi({ ...baseRoutes, "GET /api/benchmark/proxy-agreement": agreement(2, 2, 0.5, 0.017, 1, 0) })
    renderPage(<Results />, { path: "/results" })
    expect(await screen.findByTestId("proxy-agreement")).toBeTruthy()
    expect(await screen.findByTestId("judge-accuracy")).toBeTruthy()
  })

  // S-7: one hairline where identity ends and measurement begins. The break
  // test showed nothing on this page was looked at, so marking every metric
  // column -- the spreadsheet-grid mistake -- passed unnoticed.
  it("rules off the measurements once, not once per metric column", async () => {
    stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })
    await screen.findAllByText("Deepgram Nova-3")

    // One table per assistant group on this page, so scope to the first.
    const headers = within(screen.getAllByRole("table")[0]).getAllByRole("columnheader")
    const marked = headers.filter((h) => h.hasAttribute("data-group-start"))
    expect(marked).toHaveLength(1)
    expect(headers.indexOf(marked[0])).toBeGreaterThan(1)
    expect(marked[0].className).toContain("data-[group-start]:border-l")
  })

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
    expect(screen.getAllByText("Ahead, but not decided").length).toBe(1)
    // The provider production runs on is marked, from settings.
    expect(screen.getAllByText("In production").length).toBeGreaterThan(0)
    api.restore()
  })

  // M-9 (PRD-v6 D1): a client reading "Winner" hears "most accurate". The
  // page must offer the metric's name instead, and must carry the qualifier
  // that says what the number is not -- visible without a click, and ONCE,
  // because it describes the scoring method and not any one org (M-8b).
  it("says 'Least disagreement', never 'Winner', and carries the relative line once", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })

    await screen.findAllByText("Deepgram Nova-3")
    expect(document.body.textContent).not.toContain("Winner")

    // The verdict chip itself, found by the decision it renders for.
    const chip = document.querySelector('[data-decision="winner"]')
    expect(chip?.textContent).toBe("Least disagreement")
    // ...and the row marker the verdict named.
    expect(screen.getAllByTitle(/Named by this group's verdict/)[0].textContent).toContain("Least disagreement")

    const rel = screen.getAllByTestId("relative-not-accuracy")
    expect(rel.length).toBe(1)
    expect(rel[0].textContent).toContain("Not a measured accuracy")
    expect(rel[0].textContent).toContain("nothing here is scored against a human-checked transcript")
    // Corrections to M-9 as written -- see the register. The step's own
    // sentence said "the same customer audio" (no bulk on file is
    // customer-channel) and "no transcript here was checked by a person"
    // (2 of 176 calls carry a human gold, both in runs).
    expect(rel[0].textContent).not.toContain("customer audio")
    expect(rel[0].textContent).not.toContain("checked by a person")

    // M-9b: the lowercase family too. `data-decision="winner"` is an
    // attribute, so it never reaches textContent -- the enum stays, the copy
    // goes. "Ahead, not a winner" became "Ahead, but not decided".
    expect(document.body.textContent).not.toMatch(/winner/i)
    expect(document.body.textContent).not.toMatch(/\bwins\b/i)
    api.restore()
  })

  // U-1b: the Results card is one of the two places a mark can be made --
  // the other is a disputed span inside a call's comparison.
  it("offers to mark every assistant card, scoped to that assistant", async () => {
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/proxy-agreement": agreement(0, 0, null, null) })
    renderPage(<Results />, { path: "/results" })
    await screen.findAllByText("Deepgram Nova-3")

    await waitFor(() => expect(screen.getAllByTestId("agent-marks-section").length).toBeGreaterThan(0))
    expect(screen.getAllByTestId("mark-open").length).toBeGreaterThan(0)
    expect(document.body.textContent).toContain("To do on this agent")

    // The scoping is the part that can silently be wrong: one card's marks
    // showing on another's looks perfectly fine on screen.
    const asked = api.calls.filter((c) => c.startsWith("GET /api/benchmark/agent-marks"))
    expect(asked.some((c) => c.includes("assistantId=asst-rush"))).toBe(true)
    // The card with no assistant asks for the unassigned bucket rather than
    // asking for everything.
    expect(asked.some((c) => c.includes("assistantId=__unassigned__"))).toBe(true)
    expect(asked.every((c) => c.includes("status=open"))).toBe(true)
  })

  it("counts what is marked by kind, in words, and never says nothing is sent has happened", async () => {
    const marked = [
      {
        id: "m1",
        assistantId: "asst-rush",
        callId: null,
        span: "Edison Hills",
        note: "hears Addison",
        actionType: "keyterm",
        actionValue: "Edison Hills",
        status: "open",
        createdByLabel: "abhishek",
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:00:00.000Z",
      },
      {
        id: "m2",
        assistantId: "asst-rush",
        callId: null,
        span: null,
        note: "digits come back as words",
        actionType: "numerals",
        actionValue: null,
        status: "open",
        createdByLabel: "abhishek",
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:00:00.000Z",
      },
    ] as unknown as AgentMark[]
    stubApi({
      ...baseRoutes,
      "GET /api/benchmark/proxy-agreement": agreement(0, 0, null, null),
      "GET /api/benchmark/agent-marks": marked,
    })
    renderPage(<Results />, { path: "/results" })
    await screen.findAllByText("Deepgram Nova-3")

    await waitFor(() => expect(screen.getAllByTestId("agent-marks-panel").length).toBeGreaterThan(0))
    const text = document.body.textContent ?? ""
    expect(text).toContain("Marked for this agent: 2")
    expect(text).toContain("1 × teach the agent this word")
    expect(text).toContain("1 × write numbers as digits, not words")
    // A list of proposals must never read as work already done.
    expect(text).toContain("nothing here has been sent to Vapi")
    expect(text).not.toContain("keyterm")
  })

  it("a ranking row with no assistant gets a bucket that says why, never dropped", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })

    expect(await screen.findByText(/Unassigned \(no assistant ID captured at import\)/)).toBeTruthy()
    api.restore()
  })

  // R-4: the card describes; the org verdict decides. Before this, every
  // card opened "Leading candidate for this assistant's calls" and closed
  // "Confidence: low ... Do not treat as decision-grade" -- a pick and its
  // retraction in one sentence, on all 29 live assistant groups, 0 of which
  // reach the >=12-call bar.
  it("the assistant card describes its own calls and sends the decision upstairs", async () => {
    stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })
    await screen.findAllByText("Deepgram Nova-3")

    const summary = screen.getAllByTestId("assistant-card-summary")[0]!
    expect(summary.textContent).toContain("What the calls showed:")
    expect(summary.textContent).toContain("On this assistant's 12 calls: fewest disagreements Deepgram Nova-3")
    expect(summary.textContent).not.toContain("Why this order:")

    const pointer = screen.getAllByTestId("assistant-card-decision-pointer")[0]!
    expect(pointer.textContent).toContain("The decision for Default is made above, on 12 calls.")
    expect(pointer.textContent).toContain("One assistant alone has too few calls to decide")
  })

  it("no card anywhere on the page claims a decision or retracts one", async () => {
    stubApi(baseRoutes)
    const { container } = renderPage(<Results />, { path: "/results" })
    await screen.findAllByText("Deepgram Nova-3")

    for (const card of screen.getAllByTestId("assistant-card-summary")) {
      expect(card.textContent).not.toContain("Leading candidate")
      expect(card.textContent).not.toContain("decision-grade")
      expect(card.textContent).not.toContain("Confidence: low")
    }
    // And not in a tooltip either -- the same stored sentence is the row
    // title attribute, which no visible-text assertion would catch.
    const html = container.innerHTML
    expect(html).not.toContain("Leading candidate")
    expect(html).not.toContain("decision-grade")
  })

  it("the org banner carries the evidence count once, and the card does not repeat it", async () => {
    stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })
    await screen.findAllByText("Deepgram Nova-3")

    // Scoped to the ORG box on purpose. The page-top bulk banner also says
    // "N calls scored", but that N is the sum across every group in the
    // bulk -- a different quantity that happens to coincide when the bulk
    // holds one org. Logged as a redundancy in docs/backlog/good-to-have.md
    // (2026-09-09), not fixed here.
    // Every org section gets a verdict box, including the unassigned
    // bucket (whose box says it has no verdict), so this asks: exactly one
    // of them carries the count, and it carries it once.
    const orgBanners = screen.getAllByTestId("group-verdict-headline")
    const carrying = orgBanners.filter((b) => /12 calls scored/.test(b.textContent ?? ""))
    expect(carrying.length).toBe(1)
    expect(within(carrying[0]!).getAllByText(/12 calls scored/).length).toBe(1)

    // The card underneath states the evidence its own way (its call count
    // opens the sentence) and never repeats the banner's phrasing.
    for (const card of screen.getAllByTestId("assistant-card-summary")) {
      expect(card.textContent).not.toContain("calls scored")
    }
  })

  it("all-time combined points at where a decision is made, not at one that is not on the page", async () => {
    // The verdict box is rendered only in One bulk. A card saying "the
    // decision is made above" in All-time combined would be pointing at
    // nothing at all.
    stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })
    await screen.findAllByText("Deepgram Nova-3")
    fireEvent.click(screen.getByText("All-time combined"))
    await screen.findAllByText("Deepgram Nova-3")

    expect(screen.queryByTestId("group-verdict-headline")).toBeNull()
    const pointer = screen.getAllByTestId("assistant-card-decision-pointer")[0]!
    expect(pointer.textContent).toContain("No decision is made here")
    expect(pointer.textContent).toContain("switch to One bulk above")
    expect(pointer.textContent).not.toContain("is made above,")
  })

  it("switching to all-time drops the bulk filter and claims no verdict", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })

    expect((await screen.findAllByText("Deepgram Nova-3")).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText("All-time combined"))

    // Both rank-1 rows now read "ahead": with no verdict, nothing is decided.
    expect((await screen.findAllByText("Ahead, but not decided")).length).toBe(2)
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

  // M-5a. This page is where the decision is read off, so it has to say
  // what the decision was measured on before it is read.
  it("the bulk view names the channel the bulk was measured on", async () => {
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/bulks/bulk-1": detailFor(true) })
    renderPage(<Results />, { path: "/results" })

    const line = await screen.findByTestId("channel-line")
    expect(line.getAttribute("data-channel")).toBe("customer")
    expect(line.textContent).toContain("caller-only channel")
    api.restore()
  })

  it("a bulk with no channel frozen says not recorded rather than asserting mono", async () => {
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/bulks/bulk-1": detailFor(undefined) })
    renderPage(<Results />, { path: "/results" })

    const line = await screen.findByTestId("channel-line")
    expect(line.getAttribute("data-channel")).toBe("untracked")
    expect(line.textContent).toContain("not recorded")
    api.restore()
  })

  it("all-time claims no channel, because it pools bulks measured on different ones", async () => {
    // The same reason this view claims no verdict (T-183 above): one label
    // over a mixture would be a statement about audio that was never all
    // the same audio.
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/bulks/bulk-1": detailFor(true) })
    renderPage(<Results />, { path: "/results" })

    expect(await screen.findByTestId("channel-line")).toBeTruthy()
    fireEvent.click(screen.getByText("All-time combined"))
    expect(screen.queryByTestId("channel-line")).toBeNull()
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

  // M-7b. The production line is the one number on this page that is not
  // about the candidates -- it is what the client is paying for today. A
  // median that counted the calls nobody timed as 0 ms is what dropped the
  // corpus figure from 378 ms to 274 ms in the PRD.
  it("the production line's median comes only from calls that were measured", async () => {
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/calls": measuredCalls })
    renderPage(<Results />, { path: "/results" })

    const latency = await screen.findByTestId("prod-latency")
    // Median of 206.5 / 378.3 / 495 -- not of five values, and not their mean
    // (359 ms). The float4 round-trip is rounded to whole ms.
    expect(latency.textContent).toContain("378 ms transcriber latency")
    expect(latency.textContent).toContain("median of 3 measured calls")
    // Two of the three counted calls reported no interruption: a real 0 that
    // belongs in the denominator, unlike the two Vapi never counted.
    expect(screen.getByTestId("prod-interrupted").textContent).toContain("1 of 3 measured calls")
    api.restore()
  })

  it("a group with no signal on any call says nothing, never 0 ms", async () => {
    const blank = measuredCalls.map((c) => signalCall(c.id, {}))
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/calls": blank })
    renderPage(<Results />, { path: "/results" })

    // The line itself still renders -- the vendor IS known, only its
    // measurements are missing.
    const note = await screen.findByTestId("production-baseline")
    expect(note.textContent).toContain("Production today:")
    expect(screen.queryByTestId("prod-latency")).toBeNull()
    expect(screen.queryByTestId("prod-interrupted")).toBeNull()
    expect(note.textContent).not.toContain("0 ms")
    expect(note.textContent).not.toContain("0 of")
    api.restore()
  })

  // M-7c: the per-card silence above is right per card and invisible in
  // aggregate -- live, 7 of the 29 groups the all-time view renders say
  // nothing at all. The denominator is the groups THIS page renders, not the
  // 32 in the corpus.
  it("the page says once how many groups have a production latency at all", async () => {
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/calls": measuredCalls })
    renderPage(<Results />, { path: "/results" })

    // Two groups render: asst-rush (three timed calls) and the unassigned
    // bucket (no calls of its own, so nothing was ever timed for it).
    const line = await screen.findByTestId("production-coverage")
    expect(line.textContent).toContain("1 of 2")
    expect(line.textContent).toContain("assistant groups")
    api.restore()
  })

  it("nothing is said when every group on the page has one", async () => {
    const all = [...measuredCalls, signalCall("m-6", { sourceAssistantId: null, prodTranscriberLatencyMs: 640 })]
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/calls": all })
    renderPage(<Results />, { path: "/results" })

    // Both cards carry a latency, so the page has no coverage caveat to make.
    expect((await screen.findAllByTestId("prod-latency")).length).toBe(2)
    expect(screen.queryByTestId("production-coverage")).toBeNull()
    api.restore()
  })

  // M-8b. The number is a property of the verdict GROUP, and a group is an
  // org: on the real corpus one org group covers 22 assistants. So the
  // fixture's group is made to cover BOTH assistant cards, and the test
  // counts the line -- one for the org, not one per assistant. That is the
  // correction to M-8b as written, which named the per-assistant
  // ProductionBaselineNote.
  const measuredVerdicts: BulkVerdicts = {
    ...verdicts,
    groups: [
      {
        ...verdicts.groups[0],
        assistantIds: ["asst-rush", null],
        productionDisagreement: {
          rate: 0.041,
          leaderProviderId: "gladia-solaria",
          leaderRate: 0.018,
          calls: 19,
          totalCalls: 56,
        },
      },
    ],
  }

  it("states production's own disagreement once for the org, not once per assistant", async () => {
    const api = stubApi({
      ...baseRoutes,
      "GET /api/benchmark/bulks/bulk-1": detailFor(true),
      "GET /api/benchmark/bulks/bulk-1/verdicts": measuredVerdicts,
    })
    renderPage(<Results />, { path: "/results" })

    const lines = await screen.findAllByTestId("production-disagreement")
    // Two assistant cards (one Export CSV button each) under one org
    // section, and one production line above them both.
    expect(screen.getAllByText("Export CSV").length).toBe(2)
    expect(screen.getAllByTestId("org-section").length).toBe(1)
    expect(lines.length).toBe(1)
    expect(lines[0].textContent).toContain("4.1 of every 100 caller words")
    expect(lines[0].textContent).toContain("1.8")
    expect(lines[0].textContent).toContain("Gladia Solaria")
    expect(lines[0].textContent).toContain("19 of 56 calls")
    // Must not: production is never a row, a rank or a candidate.
    expect(lines[0].textContent).toContain("never ranked with them")
    expect(document.body.textContent).not.toContain("__production__")
    // A customer bulk has a figure, so the page has no absence to explain.
    expect(screen.queryByTestId("production-disagreement-unavailable")).toBeNull()
    api.restore()
  })

  // R-3: production is what the reader is already living with, so it leads --
  // in the banner at the top of the page and inside the org box, above the
  // decision. Both say the same words because both call scoring's
  // productionLead.
  it("leads the banner and the org box with production, before the decision", async () => {
    const api = stubApi({
      ...baseRoutes,
      "GET /api/benchmark/bulks/bulk-1": detailFor(true),
      "GET /api/benchmark/bulks/bulk-1/verdicts": measuredVerdicts,
    })
    renderPage(<Results />, { path: "/results" })

    const banner = await screen.findByTestId("bulk-verdict-banner")
    const lead = within(banner).getByTestId("verdict-production-lead")
    expect(lead.textContent).toContain("4.1 of every 100 caller words")
    expect(lead.textContent).toContain("Gladia Solaria")
    // The units differ from the table's on purpose, and the banner says so.
    expect(lead.textContent).toContain("not the per-100-words flag count the ranking uses")
    expect(lead.textContent).toContain("ran live during the call")
    // One org in this bulk, so its name is not prefixed onto the number.
    expect(lead.textContent).not.toContain("Default:")
    // The verdict still follows, in the same banner.
    expect(banner.textContent).toContain("has the least disagreement in 1 of 1 org")
    expect(banner.textContent!.indexOf("4.1 of every 100 caller words")).toBeLessThan(
      banner.textContent!.indexOf("has the least disagreement in 1 of 1 org"),
    )

    // In the org box, production is above the decision headline.
    const box = screen.getByTestId("production-disagreement").parentElement!
    const kids = [...box.children]
    expect(kids.indexOf(screen.getByTestId("production-disagreement"))).toBeLessThan(
      kids.indexOf(screen.getByTestId("group-verdict-headline")),
    )
    api.restore()
  })

  it("shows no production figure at all on a mono bulk, and says why once", async () => {
    // baseRoutes' verdicts carry productionDisagreement: null, which is what
    // both bulks on disk really return. Absent, never 0.0, never a dash.
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/bulks/bulk-1": detailFor(false) })
    renderPage(<Results />, { path: "/results" })

    const why = await screen.findByTestId("production-disagreement-unavailable")
    expect(why.textContent).toContain("not compared on this bulk")
    expect(why.textContent).toContain("mono mix")
    expect(screen.queryByTestId("production-disagreement")).toBeNull()
    expect(document.body.textContent).not.toContain("of every 100 caller words")
    // R-3: with no figure, nothing moves -- the banner has no lead block and
    // the verdict keeps the big type it always had.
    expect(screen.queryByTestId("verdict-production-lead")).toBeNull()
    api.restore()
  })

  it("the page explains its own arrows before any number is read", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })

    const legend = await screen.findByTestId("results-legend")
    expect(within(legend).getByText("Lower is better")).toBeTruthy()
    // M-10d: the legend used to read "Lower is better for disagreements,
    // flags, speed and price". M-10a rewrote the Speed tooltip to say the
    // number means two different things and left this sentence claiming a
    // direction for it, one paragraph above the same column.
    expect(legend.textContent).not.toMatch(/flags, speed and price/i)
    expect(legend.textContent).toMatch(/Speed has no direction/i)
    // M-10e added a latency column that DOES have a direction, right next
    // to the one that does not. The legend has to carry both or the reader
    // learns "latency has no direction here" and applies it to the wrong
    // column.
    //
    // Scoped to the lower-is-better clause, not the paragraph: the legend
    // names this column twice (once in the direction list, once explaining
    // why it compares when Speed does not), so a bare
    // `toMatch(/wait after audio ends/)` passed even with the column
    // dropped from the direction list -- caught by break-testing this very
    // assertion, 2026-09-07.
    const lowerClause = legend.textContent?.match(/Lower is better[^↓]*\(↓\)/)?.[0] ?? ""
    expect(lowerClause).toMatch(/wait after audio ends/i)
    api.restore()
  })

  // M-10e. The failure this guards is not a missing column -- it is a
  // column that renders and lies. Six of seven providers can never report
  // this number, so the dash is permanent, and a dash that says nothing
  // sits under a "↓ lower is better" header claiming those six lost.
  it("shows the end-of-audio number, and explains the dash instead of implying slow", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })

    await screen.findAllByText("Deepgram Nova-3")

    const head = screen.getAllByRole("columnheader").find((h) => h.textContent?.startsWith("After audio ends"))
    expect(head).toBeTruthy()
    // The header must carry the reason a cell can be empty forever, not
    // just what the number means.
    expect(head!.getAttribute("title")).toMatch(/batch API is handed a finished file/i)
    expect(head!.getAttribute("title")).toMatch(/not slow/i)
    expect(head!.getAttribute("title")).toContain("Does not affect Rank")
    // Must-not from the step: trailing silence is included, so calling this
    // end-of-speech would overstate what was measured.
    expect(head!.getAttribute("title")).toMatch(/not end of speech/i)

    // The one fixture row that measured it renders the number...
    expect(screen.getAllByText("812ms").length).toBeGreaterThan(0)
    // ...and it is NOT rank 1, so having the number is visibly not winning.
    const measuredRow = screen.getAllByText("812ms")[0].closest("tr")
    expect(measuredRow!.textContent).toContain("Gladia Solaria")

    // ...and the rows that cannot measure it say why, in the cell. Scoped
    // to cells on purpose: the column header explains the dash too, and a
    // page-wide sweep would pass on the header alone while every cell in
    // the table stayed a bare, unexplained dash.
    const dashTitles = Array.from(document.querySelectorAll("td [title]"))
      .map((el) => el.getAttribute("title") ?? "")
      .filter((t) => /no end-of-audio moment/i.test(t))
    expect(dashTitles.length).toBeGreaterThan(0)
    for (const t of dashTitles) expect(t).toMatch(/not a slow score/i)
    api.restore()
  })

  // The two latency columns must stay opposite: one carries a direction,
  // one deliberately does not. Guarding either alone lets a future edit
  // "fix" the pair by making them agree -- which is the M-10d bug again.
  it("gives the end-of-audio column a direction while Speed still has none", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })

    await screen.findAllByText("Deepgram Nova-3")

    const labelsOf = (startsWith: string) => {
      const th = screen.getAllByRole("columnheader").find((h) => h.textContent?.startsWith(startsWith))
      expect(th).toBeTruthy()
      return Array.from(th!.querySelectorAll("[aria-label]")).map((el) => el.getAttribute("aria-label"))
    }

    expect(labelsOf("After audio ends")).toContain("lower is better")
    expect(labelsOf("Speed")).not.toContain("lower is better")
    expect(labelsOf("Speed")).not.toContain("higher is better")
    api.restore()
  })

  // M-10a: latency left the ranking composite because `latencyFinalMs` is
  // file turnaround for a batch adapter and call length for a streaming one.
  // The column stays -- the number is still worth seeing -- so the only thing
  // stopping the page from claiming a rank it no longer computes is this
  // guard on the two header tooltips.
  it("does not claim speed feeds Rank, and says why the Speed column cannot", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })

    await screen.findAllByText("Deepgram Nova-3")

    // The header, by its label, not by a substring of its own tooltip.
    const rankHead = screen.getAllByRole("columnheader").find((h) => h.textContent?.startsWith("Rank"))
    expect(rankHead).toBeTruthy()
    // Not a blanket ban on the word: the tooltip names speed in order to
    // disclaim it, which is the point. What must never come back is the old
    // "price and speed", so the guard pins the disclaimer itself.
    expect(rankHead!.getAttribute("title")).toMatch(/not from speed/i)
    expect(rankHead!.getAttribute("title")).not.toMatch(/price and speed/i)

    const speedHead = screen.getAllByRole("columnheader").find((h) => h.textContent?.startsWith("Speed"))
    expect(speedHead).toBeTruthy()
    // Both halves matter: that it is not the same measurement, and that it
    // therefore does not vote. A tooltip saying only the first would leave a
    // reader assuming the number still counts.
    expect(speedHead!.getAttribute("title")).toContain("does not affect Rank")
    expect(speedHead!.getAttribute("title")).toMatch(/not the same measurement/i)
    api.restore()
  })

  // The header tooltips were not the only place the page named its own
  // ranking basis, and the first pass at M-10a missed the other two: a
  // visible "Ranked by disagreements, price, speed" line on every group card,
  // and its own title. A guard scoped to the table header could not see them,
  // so this one sweeps the whole page instead of naming elements.
  it("no visible text and no tooltip anywhere names speed as a ranking basis", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Results />, { path: "/results" })

    await screen.findAllByText("Deepgram Nova-3")

    // Visible copy: the group cards say what they are ranked by, out loud.
    const rankedBy = screen.getAllByText(/^Ranked by/)
    expect(rankedBy.length).toBeGreaterThan(0)
    for (const el of rankedBy) expect(el.textContent).not.toMatch(/speed/i)

    // Every title on the page, not just the ones this test knows to look for.
    // A tooltip may mention speed to disclaim it; none may list it as an input.
    const titles = Array.from(document.querySelectorAll("[title]")).map((el) => el.getAttribute("title") ?? "")
    expect(titles.length).toBeGreaterThan(0)
    for (const t of titles) {
      expect(t).not.toMatch(/price and speed/i)
      expect(t).not.toMatch(/disagreements, price, speed/i)
    }

    // M-10d: a title sweep still could not see the arrow. Each sortable
    // header renders its direction as a separate span whose aria-label reads
    // "lower is better" -- so the Speed column disclaimed itself in its
    // tooltip and recommended minimising itself in the same cell. Speed has
    // no direction; its header must carry no direction label at all.
    const speedHeader = screen.getAllByText("Speed").map((el) => el.closest("th")).find(Boolean)
    expect(speedHeader).toBeTruthy()
    const labels = Array.from(speedHeader!.querySelectorAll("[aria-label]")).map((el) => el.getAttribute("aria-label"))
    expect(labels).not.toContain("lower is better")
    expect(labels).not.toContain("higher is better")

    // The other columns keep theirs -- this must not pass by stripping every
    // arrow on the page.
    const allDirections = Array.from(document.querySelectorAll('[aria-label="lower is better"]'))
    expect(allDirections.length).toBeGreaterThan(0)
    api.restore()
  })
})
