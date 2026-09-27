// @vitest-environment jsdom
//
// R-56b: the sidebar footer's API badge says when the database is down.
// /api/healthz answers either way (it is a liveness probe), so before R-56b a
// stopped database showed as a green dot and a commit -- 2026-09-27/28, for
// hours. Rendered inside Layout, where App.tsx puts it.
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, screen } from "@testing-library/react"
import type { HealthStatus } from "@workspace/api-client-react"
import { Layout } from "@/components/layout"
import { installBrowserShims, renderPage, stubApi } from "./harness"

installBrowserShims()
afterEach(cleanup)

const health = (database: HealthStatus["database"]): HealthStatus => ({
  status: "ok",
  database,
  commitSha: "db53a231f237",
  builtAt: "2026-09-28T00:00:00.000Z",
  startedAt: "2026-09-28T00:00:01.000Z",
  providersConfigured: [],
})

function badge(): HTMLElement {
  return screen.getAllByText((_, el) => el?.getAttribute("title")?.includes("api     db53a231f237") ?? false)[0]!
}

describe("Layout's API badge (R-56b)", () => {
  it("shows the build, quietly, when the database answers", async () => {
    const api = stubApi({ "GET /api/healthz": health("ok") })
    renderPage(<Layout><div /></Layout>)
    expect(await screen.findByText("db53a231f237")).toBeTruthy()
    expect(screen.queryByText("database unreachable")).toBeNull()
    expect(badge().querySelector(".bg-warning")).toBeNull()
    api.restore()
  })

  it("says the database is unreachable, in amber, when it is", async () => {
    const api = stubApi({ "GET /api/healthz": health("unreachable") })
    renderPage(<Layout><div /></Layout>)
    expect(await screen.findByText("database unreachable")).toBeTruthy()
    expect(badge().querySelector(".bg-warning")).not.toBeNull()
    expect(badge().getAttribute("title")).toContain("its database did not answer")
    api.restore()
  })
})
