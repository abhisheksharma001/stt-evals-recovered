// @vitest-environment jsdom
//
// T-186: Setup (Setup.tsx -> Providers.tsx) rendered against a stubbed API.
//
// Setup is where a provider is turned on and where the "newest model" claim
// is made, and both have already gone wrong here in ways only the rendered
// page shows:
//   - the disable toggle once fired on a provider with no key, and
//     syncProviderReadiness checks manuallyDisabled BEFORE the key, so the
//     provider locked into "disabled" and stayed stuck after a real key was
//     added (found live 2026-08-26). The button must be inert until the
//     provider is at least ready;
//   - "Newest" comes from a dated catalog for the vendors with no model-list
//     API, so it is only as fresh as the day someone last read their docs.
//     An old catalog has to say its age (T-107/T-119), and a vendor whose
//     list did not answer has to say that rather than show nothing.
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, screen, within } from "@testing-library/react"
import type { AgentModelList, AppSettings, Provider, ProviderModelList } from "@workspace/api-client-react"
import Setup from "../Setup"
import { installBrowserShims, renderPage, reply, stubApi, type StubRoutes } from "./harness"

installBrowserShims()
afterEach(cleanup)

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

const providers: Provider[] = [
  {
    id: "deepgram-nova-3",
    name: "Deepgram",
    model: "nova-3",
    status: "ready",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.0043,
    keywordBoosting: true,
    hasAdapter: true,
    apiKeyConfigured: true,
  },
  {
    id: "speechmatics-ursa",
    name: "Speechmatics",
    model: "ursa-2",
    status: "not_configured",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.0052,
    keywordBoosting: false,
    hasAdapter: true,
    apiKeyConfigured: false,
  },
]

const settings: AppSettings = { activeProviderId: "deepgram-nova-3", agentModel: null }

const agentModels: AgentModelList = {
  defaultModel: "gpt-4o",
  pinned: [
    { id: "gpt-4o", priced: true, available: true },
    { id: "gpt-4o-mini", priced: true, available: true },
  ],
  others: [],
  live: true,
  fetchedAt: new Date().toISOString(),
  error: null,
}

/** Deepgram answers live; Speechmatics has no list API and a stale catalog. */
const models: ProviderModelList = {
  fetchedAt: new Date().toISOString(),
  vendors: [
    {
      vendor: "deepgram",
      vendorLabel: "Deepgram",
      adapterId: "deepgram-nova-3",
      apiKeyConfigured: true,
      source: "live",
      error: null,
      models: [
        { apiModel: "nova-3", label: "Nova-3", latest: true, source: "live", verifiedAt: daysAgo(0), note: null, providerId: "deepgram-nova-3", enabled: true, rowStatus: "ready" },
      ],
    },
    {
      vendor: "speechmatics",
      vendorLabel: "Speechmatics",
      adapterId: "speechmatics-ursa",
      apiKeyConfigured: false,
      source: "catalog",
      error: null,
      models: [
        { apiModel: "ursa-3", label: "Ursa 3", latest: true, source: "catalog", verifiedAt: daysAgo(90), note: null, providerId: "speechmatics-ursa", enabled: false, rowStatus: null },
      ],
    },
  ],
}

const baseRoutes: StubRoutes = {
  "GET /api/benchmark/providers": providers,
  "GET /api/benchmark/settings": settings,
  "GET /api/benchmark/agent-models": agentModels,
  "GET /api/benchmark/providers/models": models,
}

describe("Setup", () => {
  it("shows the server's status per provider and says what a missing key blocks", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Setup />, { path: "/setup" })

    expect(await screen.findByText("nova-3")).toBeTruthy()
    expect(screen.getByText("ready")).toBeTruthy()
    // The underscore is only a display detail; the state is the server's.
    expect(screen.getByText("not configured")).toBeTruthy()
    expect(screen.getByText(/API key not set/)).toBeTruthy()
    api.restore()
  })

  it("the disable toggle is inert on a provider that has no key yet", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Setup />, { path: "/setup" })

    await screen.findByText("ursa-2")
    const buttons = screen.getAllByRole("button").filter((b) => b.textContent?.trim() === "Disable")
    expect(buttons.length).toBe(2)
    const [deepgram, speechmatics] = buttons
    // Ready: switchable.
    expect((deepgram as HTMLButtonElement).disabled).toBe(false)
    // No key: clicking would send disabled:true, and manuallyDisabled
    // outranks key presence, so the provider would stay stuck after a real
    // key arrived. The button says why instead of doing it.
    expect((speechmatics as HTMLButtonElement).disabled).toBe(true)
    expect(speechmatics.title).toContain("Add an API key")
    api.restore()
  })

  it("a catalog older than the re-check window says how old it is", async () => {
    const api = stubApi(baseRoutes)
    renderPage(<Setup />, { path: "/setup" })

    const warning = await screen.findByTestId("catalog-age")
    expect(warning.textContent).toContain("no model-list API")
    expect(warning.textContent).toContain("90 days ago")
    // Only the stale vendor warns; the one that answered live does not.
    expect(screen.getAllByTestId("catalog-age").length).toBe(1)
    expect(screen.getByText(/live from the vendor just now/)).toBeTruthy()
    api.restore()
  })

  it("a vendor whose model list did not answer says so instead of showing nothing", async () => {
    const broken: ProviderModelList = {
      ...models,
      vendors: models.vendors.map((v) => (v.vendor === "speechmatics" ? { ...v, error: "vendor timed out", models: [] } : v)),
    }
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/providers/models": broken })
    renderPage(<Setup />, { path: "/setup" })

    const lines = await screen.findAllByTestId("vendor-models")
    expect(lines.some((l) => l.textContent?.includes("Model list unavailable: vendor timed out"))).toBe(true)
    // Nothing is offered as "newest" for a vendor that did not answer.
    expect(screen.queryByText("ursa-3")).toBeNull()
    api.restore()
  })

  it("an unreachable OpenAI list falls back to the pinned models and admits it", async () => {
    const offline: AgentModelList = { ...agentModels, pinned: agentModels.pinned, others: [], live: false, fetchedAt: null, error: "connection refused" }
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/agent-models": offline })
    renderPage(<Setup />, { path: "/setup" })

    // Wait for the line itself to change -- the element exists from the
    // first paint, saying it is still loading.
    const source = await screen.findByText(/OpenAI model list unavailable/)
    expect(source.dataset.testid).toBe("agent-models-source")
    expect(source.textContent).toContain("connection refused")
    expect(source.textContent).toContain("showing the pinned")
    api.restore()
  })

  it("a dead providers endpoint names the failure and offers a retry", async () => {
    const api = stubApi({ ...baseRoutes, "GET /api/benchmark/providers": reply(500, { error: "providers query failed" }) })
    renderPage(<Setup />, { path: "/setup" })

    const failure = await screen.findByText(/Failed to load/)
    expect(failure.textContent).toContain("providers query failed")
    expect(within(failure.closest("div")!).getByText("Retry")).toBeTruthy()
    api.restore()
  })
})
