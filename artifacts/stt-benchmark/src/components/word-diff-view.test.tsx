// @vitest-environment jsdom
//
// R-6. Abhishek, 2026-09-08: a difference that is only a convention must
// not read as a difference. The diff still HOLDS every op -- WER and the
// Differ / ref column count them exactly as before -- so the whole change
// lives in these two views, and only a render test can hold it.
//
// The ops below are written by hand rather than produced by the aligner:
// which runs get marked is proved in lib/scoring (markConventionOps), and
// what this file has to prove is what the reader sees once they are.
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { CallComparison } from "@workspace/api-client-react"
import { WordDiffView, type WordDiffOp } from "./word-diff-view"
import { TranscriptSideBySide } from "./transcript-side-by-side"

afterEach(cleanup)

// Reference: "the 1 bedroom unit apartment". Hypothesis: "the 1-bedroom
// unit apartments um". Three convention ops (the hyphen run is two of them
// on its own) and one real difference, apartment -> apartments.
const ops: WordDiffOp[] = [
  { op: "ok", ref: "the", hyp: "the" },
  { op: "sub", ref: "1", hyp: "1-bedroom", convention: true },
  { op: "del", ref: "bedroom", hyp: null, convention: true },
  { op: "ok", ref: "unit", hyp: "unit" },
  { op: "sub", ref: "apartment", hyp: "apartments" },
  { op: "ins", ref: null, hyp: "um", convention: true },
]

/** Every word the view strikes through -- i.e. every reference word it
 *  tells the reader the provider did not write. */
const struckOut = () => Array.from(document.querySelectorAll(".line-through")).map((el) => el.textContent)

describe("WordDiffView hides conventions (R-6)", () => {
  it("shows only the real difference, counts the rest, and offers them", () => {
    render(<WordDiffView wordDiff={ops} referenceLabel="gold" />)
    const text = document.body.textContent ?? ""

    expect(text).toContain("1 word differ from gold, out of 6.")
    expect(text).toContain("3 more are the same words written differently, hidden.")
    expect(screen.getByRole("button", { name: "Show conventions (3)" })).toBeTruthy()

    // Exactly one struck-out word: the real difference. The convention del
    // ("bedroom") must not be struck out -- and must not be printed at all,
    // because the provider wrote "1-bedroom" instead, which is on screen.
    expect(struckOut()).toEqual(["apartment"])
    expect(text).toContain("1-bedroom")
    expect(text).toContain("um")
    // The hidden insertion is printed plainly, never with the "+" the view
    // uses for a word the provider added that is not in the reference.
    expect(text).not.toContain("+um")
  })

  it("restores today's view exactly when the reader asks for the conventions", () => {
    render(<WordDiffView wordDiff={ops} referenceLabel="gold" />)
    fireEvent.click(screen.getByRole("button", { name: "Show conventions (3)" }))
    const text = document.body.textContent ?? ""

    expect(text).toContain("4 words differ from gold, out of 6.")
    expect(text).not.toContain("hidden.")
    expect(struckOut()).toEqual(["1", "bedroom", "apartment"])
    expect(text).toContain("+um")
    expect(screen.getByRole("button", { name: "Hide conventions (3)" })).toBeTruthy()
  })

  it("offers nothing when no difference is a convention", () => {
    render(<WordDiffView wordDiff={ops.filter((o) => !o.convention)} referenceLabel="gold" />)
    const text = document.body.textContent ?? ""
    expect(text).toContain("1 word differ from gold, out of 3.")
    expect(text).not.toContain("hidden.")
    expect(screen.queryByRole("button", { name: /conventions/ })).toBeNull()
  })
})

const comparison = {
  callId: "c1",
  label: "fixture call",
  callStatus: "ready_to_run",
  durationSeconds: 85,
  reference: { kind: "gold", text: "the 1 bedroom unit apartment" },
  audioAvailable: false,
  production: null,
  productionRow: null,
  context: null,
  ordering: "alphabetical",
  judge: null,
  rows: [
    {
      providerId: "deepgram-nova-3",
      providerName: "Deepgram Nova-3",
      status: "ok",
      resultId: "r1",
      runId: "run1",
      hypothesisTranscript: "the 1-bedroom unit apartments um",
      // wordsDiffer counts all four, unchanged by R-6 -- the view subtracts
      // for display, the wire number does not move.
      diff: { wordDiff: ops, referenceWords: 5, wordsDiffer: 4, werVsReference: 0.8 },
      peerFlagCount: null,
      hybridFlags: null,
      failureClass: null,
      retryable: null,
    },
  ],
} as unknown as CallComparison

/** Struck-out words inside the transcript grid only. The legend above it
 *  carries a permanent struck-out "left out" swatch, which is chrome, not a
 *  provider's missing word. */
const struckOutInGrid = () =>
  Array.from(document.querySelector(".grid")?.querySelectorAll(".line-through") ?? []).map((el) => el.textContent)

describe("TranscriptSideBySide hides conventions (R-6)", () => {
  it("counts a column's visible differences, names what it hid, and gives it back", () => {
    render(<TranscriptSideBySide data={comparison} referenceLabel="gold" />)
    expect(document.body.textContent).toContain("1 of 5 words differ")
    expect(document.body.textContent).toContain("3 conventions hidden")

    // The column body has to follow its own header. The only struck-out op
    // here is the convention del, so hiding leaves nothing struck out at
    // all -- and the provider's own "1-bedroom" is what stands in its place,
    // never the reference's "1 bedroom".
    expect(struckOutInGrid()).toEqual([])
    expect(document.body.textContent).toContain("1-bedroom")

    fireEvent.click(screen.getByRole("button", { name: "Show conventions (3)" }))
    expect(document.body.textContent).toContain("4 of 5 words differ")
    expect(document.body.textContent).not.toContain("conventions hidden")
    expect(struckOutInGrid()).toEqual(["bedroom "])
  })
})
