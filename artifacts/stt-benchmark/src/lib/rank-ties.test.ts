import { describe, expect, it } from "vitest"
import { tiedAtTop, type RankTieRow } from "./rank-ties"

const row = (providerId: string, rank: number, cleanCallRate: number | null, peerFlagsPer100Words: number | null = 0): RankTieRow => ({
  providerId,
  rank,
  score: { cleanCallRate, peerFlagsPer100Words },
})

describe("tiedAtTop", () => {
  // The live shape on bulk 42769f26 after R-2b: every provider on the card
  // clean (or flagged) on the same calls, rank 1 decided by provider id.
  it("returns every provider when all tie on both keys", () => {
    const ids = tiedAtTop([row("assemblyai", 1, 1), row("cartesia", 2, 1), row("deepgram", 3, 1)])
    expect([...ids].sort()).toEqual(["assemblyai", "cartesia", "deepgram"])
  })

  it("returns only the providers tied with rank 1", () => {
    const ids = tiedAtTop([row("a", 1, 1), row("b", 2, 1), row("c", 3, 0.5)])
    expect([...ids].sort()).toEqual(["a", "b"])
  })

  it("returns nothing when rank 1 is strictly ahead on the flagged-call rate", () => {
    expect(tiedAtTop([row("a", 1, 1), row("b", 2, 0.5)]).size).toBe(0)
  })

  it("returns nothing when rank 1 is ahead on disagreements per 100 words", () => {
    expect(tiedAtTop([row("a", 1, 0.5, 1.2), row("b", 2, 0.5, 3.4)]).size).toBe(0)
  })

  it("counts a missing per-100-words rate as not separating them", () => {
    const ids = tiedAtTop([row("a", 1, 0.5, 1.2), row("b", 2, 0.5, null)])
    expect([...ids].sort()).toEqual(["a", "b"])
  })

  it("claims no tie when rank 1 has no rate to be tied on", () => {
    expect(tiedAtTop([row("a", 1, null), row("b", 2, null)]).size).toBe(0)
  })

  it("ignores lower ranks that tie only with each other", () => {
    expect(tiedAtTop([row("a", 1, 1), row("b", 2, 0.5), row("c", 3, 0.5)]).size).toBe(0)
  })

  it("returns nothing for a card of one", () => {
    expect(tiedAtTop([row("a", 1, 1)]).size).toBe(0)
  })
})
