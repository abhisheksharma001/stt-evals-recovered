// @vitest-environment jsdom
// M-10d. Corpus is the only page rendering ProviderComparisonSection, and
// there is no Corpus render test -- so nothing swept this component's copy.
// That is how it kept titling its Speed column "Time to the final
// transcript. Lower is better." over `latencyFinalMs`, the exact claim
// M-10a removed from Results, and how its section header kept promising
// "Lower is better on every number in this table" while Speed sat in it.
import { afterEach, describe, expect, it } from "vitest"
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
  costMicrocents: 22_000,
  audioSource: "mono",
  failureClass: null,
  retryable: null,
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
  rows: [row],
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

  it("keeps lower-is-better where it is still true", () => {
    const { titles } = renderedCopy()
    // Disagreements, unsure words and cost genuinely are lower-is-better.
    // The fix must not sweep away true statements to satisfy a grep.
    expect(titles.filter((t) => /lower is better/i.test(t)).length).toBeGreaterThanOrEqual(2)
  })
})
