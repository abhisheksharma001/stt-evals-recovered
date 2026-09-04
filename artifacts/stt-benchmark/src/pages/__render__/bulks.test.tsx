// @vitest-environment jsdom
//
// T-185: Bulks (Bulks.tsx) rendered against a stubbed API.
//
// This is the page that spends money, so the first thing held here is that
// nothing spends by accident: rendering the page, expanding a bulk and
// opening the creation form must not POST to any launch endpoint. The stub
// answers 500 for anything not listed, and every launch path is deliberately
// left off the list -- if the page ever fires one, the test fails on the
// unmatched request rather than in production on a bill.
//
// The rest is the nesting T-106 introduced: a bulk's shard runs belong under
// its own row, and the section at the bottom is only for runs that belong to
// no bulk. Getting that wrong shows the same run twice, which is how a
// reader over-counts what a bulk did.
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, screen, within } from "@testing-library/react"
import type { BenchmarkRun, Bulk, BulkPreview, BulkTemplate, Provider } from "@workspace/api-client-react"
import Bulks from "../Bulks"
import { installBrowserShims, renderPage, reply, stubApi, type StubRoutes } from "./harness"

installBrowserShims()
afterEach(cleanup)

const providers: Provider[] = [
  {
    id: "deepgram-nova-3",
    name: "Deepgram Nova-3",
    model: "nova-3",
    status: "ready",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.0043,
    keywordBoosting: true,
    hasAdapter: true,
    apiKeyConfigured: true,
  },
]

const bulks: Bulk[] = [
  {
    id: "bulk-1",
    name: "August sweep",
    status: "complete",
    selectionCriteria: { vertical: "rush", resolvedCallIds: ["call-1", "call-2"] },
    providerIds: ["deepgram-nova-3"],
    shardSize: 50,
    minDurationSeconds: 30,
    maxDurationSeconds: null,
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "bulk-2",
    name: "Never launched",
    status: "awaiting_confirmation",
    selectionCriteria: { vertical: "trucking", resolvedCallIds: ["call-3"] },
    providerIds: ["deepgram-nova-3"],
    shardSize: 50,
    minDurationSeconds: 30,
    maxDurationSeconds: null,
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  },
]

const runs: BenchmarkRun[] = [
  { id: "shard-01-run", status: "complete", providerIds: ["deepgram-nova-3"], callCount: 2, createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), bulkId: "bulk-1", bulkName: "August sweep", shardIndex: 0 },
  { id: "shard-02-run", status: "complete", providerIds: ["deepgram-nova-3"], callCount: 2, createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), bulkId: "bulk-1", bulkName: "August sweep", shardIndex: 1 },
  { id: "adhoc-09-run", status: "complete", providerIds: ["deepgram-nova-3"], callCount: 1, createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), bulkId: null, bulkName: null, shardIndex: null },
]

const templates: BulkTemplate[] = [
  {
    id: "tpl-1",
    name: "Rush weekly",
    selectionCriteria: { vertical: "rush" },
    providerIds: ["deepgram-nova-3"],
    shardSize: 50,
    minDurationSeconds: 30,
    maxDurationSeconds: null,
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  },
]

const preview: BulkPreview = {
  productionCoverage: [{ vendor: "deepgram", model: "nova-3", calls: 12, providerId: "deepgram-nova-3", benchmarked: true }],
  inScopeCount: 14,
  matchedCount: 12,
  excluded: [
    { bucket: "shorter than 30s", count: 1 },
    { bucket: "outside the date window", count: 1 },
  ],
  estimate: { sttCostCents: 50, agentCostCents: 12, totalCostCents: 62, overThreshold: false },
  costThresholdCents: 500,
}

// Deliberately NOT stubbed: POST /benchmark/bulks, .../launch,
// .../bulk-templates/{id}/launch, .../retry-failed. Anything that spends
// provider money is absent, so firing one lands in `unmatched`.
const baseRoutes: StubRoutes = {
  "GET /api/benchmark/providers": providers,
  "GET /api/benchmark/bulks": bulks,
  "GET /api/benchmark/runs": runs,
  "GET /api/benchmark/bulk-templates": templates,
  "POST /api/benchmark/bulks/preview": preview,
  // Both expanded rows read the corpus to label their calls.
  "GET /api/benchmark/calls": [],
  "GET /api/benchmark/bulks/bulk-1": reply(404, { error: "not needed by these assertions" }),
  "GET /api/benchmark/bulks/bulk-2": reply(404, { error: "not needed by these assertions" }),
}

describe("Bulks", () => {
  it("renders, expands and shows the creation form without ever asking to spend", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Bulks />, { path: "/bulks" })

    await screen.findAllByText("August sweep")
    for (const toggle of screen.getAllByTestId("bulk-row-toggle")) fireEvent.click(toggle)
    await screen.findByTestId("bulk-runs-list")

    // The only POST a page load may make is the cost preview, which reads.
    // The count is asserted first: `every` on an empty list is true, and a
    // test that passes because nothing happened proves nothing.
    const posts = api.calls.filter((c) => c.startsWith("POST"))
    expect(posts.length).toBeGreaterThan(0)
    expect(posts.every((p) => p.startsWith("POST /api/benchmark/bulks/preview"))).toBe(true)
    expect(api.calls.some((c) => c.includes("/launch"))).toBe(false)
    expect(api.calls.some((c) => c.includes("/retry-failed"))).toBe(false)
    expect(api.unmatched).toEqual([])
    api.restore()
  })

  it("a bulk's shards sit under its own row, and the ad-hoc list keeps none of them", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Bulks />, { path: "/bulks" })

    const rows = await screen.findAllByTestId("bulk-row")
    expect(rows.length).toBe(2)
    // The row says how many runs it owns before it is even opened.
    expect(within(rows[0]).getByTestId("bulk-row-toggle").textContent).toContain("2 runs")

    fireEvent.click(within(rows[0]).getByTestId("bulk-row-toggle"))
    const nested = await screen.findByTestId("bulk-runs-list")
    expect(within(nested).getByText("shard 1")).toBeTruthy()
    expect(within(nested).getByText("shard 2")).toBeTruthy()

    // T-106: the section below is runs that belong to no bulk. A shard
    // appearing there too would double-count what the bulk did.
    // Run ids render truncated to their first 8 characters, so the fixture
    // ids are distinct within those 8 -- an id that never appears either way
    // would make this assertion pass for the wrong reason.
    const adhoc = screen.getByText("Ad-hoc runs").closest("details")!
    expect(within(adhoc).getByText("adhoc-09")).toBeTruthy()
    expect(within(adhoc).queryByText("shard-01")).toBeNull()
    expect(within(adhoc).queryByText("shard-02")).toBeNull()
    api.restore()
  })

  it("a bulk that was never launched says so rather than showing an empty run list", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Bulks />, { path: "/bulks" })

    const rows = await screen.findAllByTestId("bulk-row")
    fireEvent.click(within(rows[1]).getByTestId("bulk-row-toggle"))
    expect((await screen.findByTestId("bulk-runs-empty")).textContent).toContain("has not been launched")
    api.restore()
  })

  it("an unspent bulk's cost reads as unknown, never as free, and stays split in two", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Bulks />, { path: "/bulks" })

    // The newest bulk's card leads the page. Nothing was recorded for it, so
    // both lines read "—": an unknown cost must never render as $0.00, which
    // would read as "this was free".
    await screen.findByText("Most recent bulk")
    expect(screen.getByText(/^STT cost/).textContent).toContain("(estimate)")
    expect(screen.getByText(/^Agent cost/).textContent).toContain("(estimate)")
    expect(screen.queryByText("$0.00")).toBeNull()
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2)
    api.restore()
  })

  it("a bulk with recorded estimates shows STT and the AI check as two numbers", async () => {
    const priced: Bulk[] = [{ ...bulks[0], estimatedSttCostCents: 50, estimatedAgentCostCents: 12, estimatedCostCents: 62 }, bulks[1]]
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/bulks": priced })
    renderPage(<Bulks />, { path: "/bulks" })

    await screen.findByText("Most recent bulk")
    // Never summed into one figure: the two spend different money at
    // different vendors, and only one of them is the STT decision.
    expect(screen.getByText("$0.50")).toBeTruthy()
    expect(screen.getByText("$0.12")).toBeTruthy()
    expect(screen.queryByText("$0.62")).toBeNull()
    api.restore()
  })

  it("an empty corpus of bulks says what to do instead of showing a bare table", async () => {
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/bulks": [] })
    renderPage(<Bulks />, { path: "/bulks" })

    expect(await screen.findByText(/No bulks yet/)).toBeTruthy()
    api.restore()
  })

  // M-5a. Two bulks with identical costs are not comparable if one of them
  // measured the assistant's own synthesised voice, so the card has to say
  // which audio it read before any number on it can be trusted.
  it("a bulk that froze the caller-only decision names that channel on its card", async () => {
    const onCustomer: Bulk[] = [
      { ...bulks[0], selectionCriteria: { ...bulks[0].selectionCriteria, requireCustomerAudio: true } },
      bulks[1],
    ]
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/bulks": onCustomer })
    renderPage(<Bulks />, { path: "/bulks" })

    await screen.findByText("Most recent bulk")
    const line = screen.getAllByTestId("channel-line")[0]
    expect(line.getAttribute("data-channel")).toBe("customer")
    expect(line.textContent).toContain("caller-only channel")
    api.restore()
  })

  it("a bulk with no channel frozen says it was not recorded, and never names one", async () => {
    // The fixture bulks predate M-5 exactly as the real ones do: no flag in
    // their criteria at all. Those runs did read the mono mix -- there was
    // no other code path -- but the BULK does not record that, and a card
    // that printed "mono mix" here would be stating a derivation as data.
    const api = stubApi(baseRoutes)
    renderPage(<Bulks />, { path: "/bulks" })

    await screen.findByText("Most recent bulk")
    const line = screen.getAllByTestId("channel-line")[0]
    expect(line.getAttribute("data-channel")).toBe("untracked")
    expect(line.textContent).toContain("not recorded")
    expect(line.textContent).not.toContain("Measured on")
    api.restore()
  })

  // Found by reading the diff, not by any of the above: the same line was
  // pasted into the detail dialog twice, and every test still passed because
  // none of them opened it. Counting is the assertion -- a page that says
  // the same true thing twice reads as two different measurements.
  it("says the channel exactly once per bulk surface, on the card and in the dialog", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Bulks />, { path: "/bulks" })

    await screen.findByText("Most recent bulk")
    expect(screen.getAllByTestId("channel-line").length).toBe(1)

    fireEvent.click(screen.getByText("Open detail"))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getAllByTestId("channel-line").length).toBe(1)
    api.restore()
  })

  it("a dead bulks endpoint names the failure and offers a retry", async () => {
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/bulks": reply(500, { error: "bulks query failed" }) })
    renderPage(<Bulks />, { path: "/bulks" })

    expect((await screen.findAllByText(/Failed to load/)).length).toBeGreaterThan(0)
    expect(document.body.textContent).toContain("bulks query failed")
    api.restore()
  })
})
