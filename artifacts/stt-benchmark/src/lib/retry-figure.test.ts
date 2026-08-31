import { describe, expect, it } from "vitest"
import { describeRetryableCells, retryReasonLabel } from "./retry-figure"

const cartesia = { providerId: "cartesia-ink-whisper", providerName: "Cartesia Ink Whisper", reason: "provider_timeout", cells: 15 }

describe("describeRetryableCells", () => {
  it("says nothing when the figure is zero", () => {
    expect(describeRetryableCells([], 0)).toBeNull()
  })

  it("says nothing when the count is real but no groups came back", () => {
    // Never invent an explanation for a number we cannot break down.
    expect(describeRetryableCells([], 4)).toBeNull()
  })

  it("names the one provider and cause when there is only one group", () => {
    const copy = describeRetryableCells([cartesia], 15)!
    expect(copy.hint).toBe("all 15 — Cartesia Ink Whisper, timed out")
    expect(copy.title).toContain("15 × Cartesia Ink Whisper — timed out")
  })

  it("keeps one provider's name when it has several causes", () => {
    const copy = describeRetryableCells(
      [cartesia, { ...cartesia, reason: "rate_limited", cells: 2 }],
      17,
    )!
    expect(copy.hint).toBe("all Cartesia Ink Whisper — timed out, rate limited")
  })

  it("counts providers when more than one is involved", () => {
    const copy = describeRetryableCells(
      [cartesia, { providerId: "gladia-solaria", providerName: "Gladia Solaria", reason: "unknown", cells: 3 }],
      18,
    )!
    expect(copy.hint).toBe("2 providers — timed out, cause not identified")
    expect(copy.title).toContain("3 × Gladia Solaria — cause not identified")
  })

  it("always warns that a retry spends provider money", () => {
    expect(describeRetryableCells([cartesia], 15)!.title).toContain("costs what that provider charges")
  })
})

describe("retryReasonLabel", () => {
  it("uses plain words for the classes that can be retried", () => {
    expect(retryReasonLabel("provider_timeout")).toBe("timed out")
    expect(retryReasonLabel("skipped_pending_review")).toBe("held back by review")
  })

  it("falls back to the raw reason, readably, for anything unrecognised", () => {
    expect(retryReasonLabel("some_new_class")).toBe("some new class")
  })
})
