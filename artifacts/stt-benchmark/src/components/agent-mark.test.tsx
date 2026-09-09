// @vitest-environment jsdom
// U-1b. The two capture points and the list, rendered.
//
// What this is really guarding: the comparison view does NOT know which
// assistant a call belongs to, so the mark it sends must carry the call and
// let the server derive the rest. A control that helpfully invented an
// assistant id would file marks under the wrong agent and nothing on screen
// would say so -- which is why the POST body is asserted, not just the 201.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { AgentMark, AgentMarkPreview } from "@workspace/api-client-react"
import { AgentMarksSection, MarkButton } from "./agent-mark"

type Recorded = { method: string; path: string; body: unknown }

let recorded: Recorded[] = []
let listReply: AgentMark[] = []
let previewReply: AgentMarkPreview | null = null
let originalFetch: typeof globalThis.fetch

function stub(): void {
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const url = new URL(raw, "http://test.local")
    const method = (init?.method ?? "GET").toUpperCase()
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    recorded.push({ method, path: url.pathname, body })
    if (method === "GET" && url.pathname.endsWith("/preview")) {
      if (previewReply === null) {
        return new Response(JSON.stringify({ error: "no preview stubbed" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify(previewReply), { status: 200, headers: { "content-type": "application/json" } })
    }
    if (method === "GET") {
      return new Response(JSON.stringify(listReply), { status: 200, headers: { "content-type": "application/json" } })
    }
    return new Response(JSON.stringify({ id: "new-mark", ...(body as object) }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const mark = (over: Partial<AgentMark>): AgentMark =>
  ({
    id: `m-${Math.random().toString(16).slice(2)}`,
    assistantId: "asst-1",
    callId: null,
    span: null,
    note: "a note",
    actionType: null,
    actionValue: null,
    status: "open",
    createdByLabel: "someone",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    ...over,
  }) as AgentMark

beforeEach(() => {
  recorded = []
  listReply = []
  previewReply = null
  stub()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanup()
  vi.restoreAllMocks()
})

describe("MarkButton", () => {
  it("sends the call and the span, and never guesses an assistant", async () => {
    renderWithClient(<MarkButton callId="call-1" span="Edison Hills" />)

    fireEvent.click(screen.getByTestId("mark-open"))
    // The span is shown back, so nobody has to retype what they just read.
    expect(document.body.textContent).toContain("Edison Hills")

    fireEvent.change(screen.getByTestId("mark-note"), { target: { value: "it hears Addison" } })
    fireEvent.click(screen.getByTestId("mark-save"))

    await waitFor(() => expect(recorded.some((r) => r.method === "POST")).toBe(true))
    const post = recorded.find((r) => r.method === "POST")!
    expect(post.path).toBe("/api/benchmark/agent-marks")
    expect(post.body).toEqual({ callId: "call-1", span: "Edison Hills", note: "it hears Addison" })
    expect(post.body).not.toHaveProperty("assistantId")
  })

  it("will not save an empty note", async () => {
    renderWithClient(<MarkButton assistantId="asst-1" />)
    fireEvent.click(screen.getByTestId("mark-open"))

    expect(screen.getByTestId("mark-save")).toHaveProperty("disabled", true)
    fireEvent.change(screen.getByTestId("mark-note"), { target: { value: "   " } })
    expect(screen.getByTestId("mark-save")).toHaveProperty("disabled", true)
    fireEvent.change(screen.getByTestId("mark-note"), { target: { value: "something real" } })
    expect(screen.getByTestId("mark-save")).toHaveProperty("disabled", false)
  })

  it("asks for a value for a word to teach, and asks for none for digits", async () => {
    renderWithClient(<MarkButton assistantId="asst-1" />)
    fireEvent.click(screen.getByTestId("mark-open"))
    fireEvent.change(screen.getByTestId("mark-note"), { target: { value: "the street name" } })

    fireEvent.change(screen.getByTestId("mark-action"), { target: { value: "keyterm" } })
    expect(screen.getByTestId("mark-action-value")).toBeTruthy()
    // The API would answer 400; the control does not let it get that far.
    expect(screen.getByTestId("mark-save")).toHaveProperty("disabled", true)
    fireEvent.change(screen.getByTestId("mark-action-value"), { target: { value: "Edison Hills" } })
    expect(screen.getByTestId("mark-save")).toHaveProperty("disabled", false)

    // numerals is a per-assistant switch -- there is nothing to type.
    fireEvent.change(screen.getByTestId("mark-action"), { target: { value: "numerals" } })
    expect(screen.queryByTestId("mark-action-value")).toBeNull()
    expect(screen.getByTestId("mark-save")).toHaveProperty("disabled", false)

    fireEvent.click(screen.getByTestId("mark-save"))
    await waitFor(() => expect(recorded.some((r) => r.method === "POST")).toBe(true))
    const post = recorded.find((r) => r.method === "POST")!
    expect(post.body).toEqual({ assistantId: "asst-1", note: "the street name", actionType: "numerals" })
  })

  it("says nothing has been sent to Vapi, on the form and in the confirmation", async () => {
    renderWithClient(<MarkButton assistantId="asst-1" />)
    fireEvent.click(screen.getByTestId("mark-open"))
    expect(document.body.textContent).toContain("Nothing is sent to Vapi.")
  })
})

describe("AgentMarksSection", () => {
  it("counts the marks by kind, in the words a person would use", async () => {
    listReply = [
      mark({ note: "street name", actionType: "keyterm", actionValue: "Edison Hills" }),
      mark({ note: "unit number", actionType: "keyterm", actionValue: "Parkville" }),
      mark({ note: "spelled digits", actionType: "numerals" }),
      mark({ note: "just noting this" }),
    ]
    renderWithClient(<AgentMarksSection assistantId="asst-1" />)

    await waitFor(() => expect(screen.queryByTestId("agent-marks-panel")).toBeTruthy())
    const text = document.body.textContent ?? ""
    expect(text).toContain("Marked for this agent: 4")
    expect(text).toContain("2 × teach the agent this word")
    expect(text).toContain("1 × write numbers as digits, not words")
    expect(text).toContain("1 × notes with no action yet")
    // The vendor's word for it never reaches the screen.
    expect(text).not.toContain("keyterm")
  })

  it("asks for the unassigned bucket when the card has no assistant", async () => {
    renderWithClient(<AgentMarksSection assistantId={null} />)
    await waitFor(() => expect(recorded.some((r) => r.method === "GET")).toBe(true))
    expect(recorded.find((r) => r.method === "GET")!.path).toBe("/api/benchmark/agent-marks")
  })

  it("offers the control even when nothing is marked yet, and shows no empty list", async () => {
    renderWithClient(<AgentMarksSection assistantId="asst-1" />)
    await waitFor(() => expect(screen.queryByTestId("mark-open")).toBeTruthy())
    expect(document.body.textContent).toContain("To do on this agent")
    expect(screen.queryByTestId("agent-marks-panel")).toBeNull()
  })
})

describe("MarkPreview", () => {
  const preview = (over: Partial<AgentMarkPreview> = {}): AgentMarkPreview =>
    ({
      assistantId: "asst-1",
      assistantName: "Parkville leasing",
      accountLabel: "Land And Apartment",
      fetchedAt: "2026-09-09T12:00:00.000Z",
      fields: [],
      manualMarks: [],
      notesOnlyCount: 0,
      ...over,
    }) as AgentMarkPreview

  it("is not asked for until someone asks for it -- the read is free but not automatic", async () => {
    previewReply = preview()
    renderWithClient(<AgentMarksSection assistantId="asst-1" />)
    await waitFor(() => expect(screen.queryByTestId("mark-preview-toggle")).toBeTruthy())
    expect(recorded.some((r) => r.path.endsWith("/preview"))).toBe(false)

    fireEvent.click(screen.getByTestId("mark-preview-toggle"))
    await waitFor(() => expect(screen.queryByTestId("mark-preview")).toBeTruthy())
    expect(recorded.some((r) => r.path === "/api/benchmark/agent-marks/preview")).toBe(true)
  })

  it("shows each field as current -> after, and what it adds", async () => {
    previewReply = preview({
      fields: [
        {
          field: "keyterm",
          label: "Words the agent is taught",
          current: "2 words",
          after: "3 words",
          added: ["Parkville"],
          alreadyPresent: ["Edison Hills"],
          overLimit: false,
          limit: 100,
          markIds: ["m1", "m2"],
        },
        {
          field: "numerals",
          label: "Numbers written as digits",
          current: "not set",
          after: "on",
          added: [],
          alreadyPresent: [],
          overLimit: false,
          limit: null,
          markIds: ["m3"],
        },
      ],
    })
    renderWithClient(<AgentMarksSection assistantId="asst-1" />)
    await waitFor(() => expect(screen.queryByTestId("mark-preview-toggle")).toBeTruthy())
    fireEvent.click(screen.getByTestId("mark-preview-toggle"))
    await waitFor(() => expect(screen.queryByTestId("mark-preview-fields")).toBeTruthy())

    const text = document.body.textContent ?? ""
    expect(text).toContain("2 words")
    expect(text).toContain("3 words")
    expect(text).toContain("Adds: Parkville")
    expect(text).toContain("Already there, so not added again: Edison Hills")
    expect(text).toContain("not set")
    // Read-only has to be said, not implied, on the screen that precedes a write.
    expect(text).toContain("this changed nothing")
    expect(text).toContain("Applying is not built yet")
  })

  it("says the cap would be passed, and never implies a silent trim", async () => {
    previewReply = preview({
      fields: [
        {
          field: "keyterm",
          label: "Words the agent is taught",
          current: "100 words",
          after: "101 words",
          added: ["one too many"],
          alreadyPresent: [],
          overLimit: true,
          limit: 100,
          markIds: ["m1"],
        },
      ],
    })
    renderWithClient(<AgentMarksSection assistantId="asst-1" />)
    await waitFor(() => expect(screen.queryByTestId("mark-preview-toggle")).toBeTruthy())
    fireEvent.click(screen.getByTestId("mark-preview-toggle"))
    await waitFor(() => expect(screen.queryByTestId("mark-preview-over-limit")).toBeTruthy())
    expect(document.body.textContent).toContain("refused, not trimmed")
  })

  it("says plainly when the marks would change no setting at all", async () => {
    previewReply = preview({ notesOnlyCount: 3 })
    renderWithClient(<AgentMarksSection assistantId="asst-1" />)
    await waitFor(() => expect(screen.queryByTestId("mark-preview-toggle")).toBeTruthy())
    fireEvent.click(screen.getByTestId("mark-preview-toggle"))
    await waitFor(() => expect(screen.queryByTestId("mark-preview-nothing")).toBeTruthy())
    expect(document.body.textContent).toContain("3 of the marks are notes with no action yet")
  })

  it("offers no preview for a card with no assistant -- there is nothing live to read", async () => {
    renderWithClient(<AgentMarksSection assistantId={null} />)
    await waitFor(() => expect(screen.queryByTestId("mark-open")).toBeTruthy())
    expect(screen.queryByTestId("mark-preview-toggle")).toBeNull()
  })
})
