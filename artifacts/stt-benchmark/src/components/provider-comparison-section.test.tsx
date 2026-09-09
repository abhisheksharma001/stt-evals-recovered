// @vitest-environment jsdom
// M-10d. Corpus is the only page rendering ProviderComparisonSection, and
// there is no Corpus render test -- so nothing swept this component's copy.
// That is how it kept titling its Speed column "Time to the final
// transcript. Lower is better." over `latencyFinalMs`, the exact claim
// M-10a removed from Results, and how its section header kept promising
// "Lower is better on every number in this table" while Speed sat in it.
import { afterEach, describe, expect, it } from "vitest"
import * as React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen } from "@testing-library/react"
import type { CallComparison, ComparisonRow } from "@workspace/api-client-react"
import { ComparisonBody } from "./provider-comparison-section"

const row = {
  providerId: "cartesia-ink-whisper",
  providerName: "Cartesia Ink Whisper",
  status: "ok",
  resultId: "r1",
  runId: "run1",
  attemptedAt: "2026-09-07T00:00:00.000Z",
  hypothesisTranscript: "the tenant asked about the lease",
  diff: null,
  peerFlagCount: 0,
  peerFlagSeverity: "none",
  flagCount: 0,
  flagSeverity: "none",
  hybridFlags: null,
  // 80,754 ms is the live Cartesia average: not slowness, the length of the
  // call, because the adapter streams at real time.
  latencyFinalMs: 80_754,
  // M-10f. The one adapter that opens a WebSocket, so the one that has an
  // end-of-audio moment to measure from at all.
  latencyEndOfAudioMs: 812,
  costMicrocents: 22_000,
  audioSource: "mono",
  failureClass: null,
  retryable: null,
} as unknown as ComparisonRow

/** M-10f. A batch adapter sitting beside the streaming one: same table, same
 *  run, and permanently no end-of-audio number -- it is handed a finished
 *  file, so there is no moment the audio ended. Both halves of the acceptance
 *  sentence have to be on screen together or the dash cannot be told apart
 *  from a missing measurement. */
const batchRow = {
  ...row,
  providerId: "deepgram-nova-3",
  providerName: "Deepgram Nova-3",
  resultId: "r2",
  latencyFinalMs: 3_400,
  latencyEndOfAudioMs: null,
} as unknown as ComparisonRow

const data = {
  callId: "c1",
  label: "fixture call",
  callStatus: "ready_to_run",
  durationSeconds: 85,
  reference: null,
  audioAvailable: false,
  production: null,
  productionRow: null,
  context: null,
  ordering: "alphabetical",
  judge: null,
  rows: [row, batchRow],
} as unknown as CallComparison

/** Every title on the rendered component, plus its visible text. */
function renderedCopy() {
  render(<ComparisonBody data={data} />)
  const titles = Array.from(document.querySelectorAll("[title]")).map((el) => el.getAttribute("title") ?? "")
  return { titles, text: document.body.textContent ?? "" }
}

afterEach(cleanup)

describe("ComparisonBody copy", () => {
  it("renders the comparison table at all", () => {
    const { titles } = renderedCopy()
    expect(screen.getByText("Speed")).toBeTruthy()
    expect(titles.length).toBeGreaterThan(0)
  })

  it("never claims a lower-is-better direction for the Speed number", () => {
    const { titles, text } = renderedCopy()

    // The Speed column's own title must explain that the number is two
    // different measurements, and must not recommend minimising it.
    const speed = titles.find((t) => t.includes("Time from sending the audio to the final transcript"))
    expect(speed).toBeTruthy()
    expect(speed).toContain("roughly the length of the call")
    expect(speed).toMatch(/not lower-is-better/i)

    // The arrow is gone with the claim: "Speed ↓" recommended a direction
    // that does not exist across a batch adapter and a streaming one.
    expect(text).not.toContain("Speed ↓")

    // And no title may make the blanket promise the section header used to.
    for (const t of titles) expect(t).not.toMatch(/lower is better on every number/i)
    expect(text).not.toMatch(/Provider outputs · lower is better/i)
  })

  it("shows the end-of-audio number, and explains its dash instead of implying slow", () => {
    const { titles, text } = renderedCopy()

    // The streamed provider's real number, in ms, distinct from the Speed
    // cell beside it (80.8s) so the two are not one measurement twice.
    expect(text).toContain("812ms")
    expect(text).toContain("80.8s")

    // The header must say why a dash is possible at all, and must not let
    // the dash be read as a slow score or as end-of-SPEECH.
    const header = titles.find((t) => t.includes("last audio byte"))
    expect(header).toBeTruthy()
    expect(header).toMatch(/batch API is handed a finished file/i)
    expect(header).toMatch(/not slow/i)
    expect(header).toMatch(/not end of speech/i)

    // And the cell carries its own explanation, because this is the only
    // column here whose blank is structural. Scoped to titled elements
    // whose whole text is the dash: a sweep over every [title] would be
    // satisfied by the header alone, which says "not slow" and not "not a
    // slow score" -- the exact false pass M-10e hit.
    const dashTitles = Array.from(document.querySelectorAll("[title]"))
      .filter((el) => el.textContent?.trim() === "—")
      .map((el) => el.getAttribute("title") ?? "")
    expect(dashTitles.length).toBeGreaterThanOrEqual(1)
    for (const t of dashTitles) {
      expect(t).toMatch(/no end-of-audio moment/i)
      expect(t).toMatch(/not a slow score/i)
    }
  })

  it("gives the end-of-audio column a direction while Speed still has none", () => {
    const { text } = renderedCopy()
    // M-10d took the arrow off Speed because it is two measurements under
    // one label. This column is one measurement, so it keeps its arrow.
    // Asserted as a pair: nobody may "tidy" them into agreeing.
    expect(text).toContain("After audio ends ↓")
    expect(text).not.toContain("Speed ↓")
  })

  it("keeps lower-is-better where it is still true", () => {
    const { titles } = renderedCopy()
    // Disagreements, unsure words and cost genuinely are lower-is-better.
    // The fix must not sweep away true statements to satisfy a grep.
    expect(titles.filter((t) => /lower is better/i.test(t)).length).toBeGreaterThanOrEqual(2)
  })
})

// U-1b: the judge's disputed spans are the only place in the product where a
// specific stretch of misheard speech is on screen, so each one carries its
// own Mark control. The judge is null in the fixture above (these tests are
// about the table), so this block builds its own.
describe("ComparisonBody marks", () => {
  const judged = {
    ...data,
    judge: {
      scanId: "scan-1",
      status: "flagged",
      pickProviderId: "cartesia-ink-whisper",
      reasoning: "one reads better",
      confidence: "medium",
      keyDifferences: [
        { span: "Edison Hills", alternatives: "Addison Hills", matters: "it is the property name" },
        { span: "four one three", alternatives: "4 1 3", matters: "it is the unit" },
      ],
      createdAt: "2026-09-09T00:00:00.000Z",
    },
  } as unknown as CallComparison

  function renderJudged() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <ComparisonBody data={judged} />
      </QueryClientProvider>,
    )
  }

  it("puts a mark control on every difference, not one for the whole call", () => {
    renderJudged()
    expect(screen.getAllByTestId("mark-open").length).toBe(2)
  })

  it("the form it opens is about the span that was clicked", async () => {
    renderJudged()
    const { fireEvent } = await import("@testing-library/react")
    fireEvent.click(screen.getAllByTestId("mark-open")[1])
    const form = screen.getByTestId("mark-form")
    expect(form.textContent).toContain("four one three")
    expect(form.textContent).not.toContain("Edison Hills")
    // The comparison does not know the assistant, so the form must not
    // pretend to: it says plainly that nothing has left the box.
    expect(form.textContent).toContain("Nothing is sent to Vapi.")
  })
})
