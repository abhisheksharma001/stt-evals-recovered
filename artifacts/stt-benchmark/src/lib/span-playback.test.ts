import { describe, expect, it } from "vitest"
import { spanPlaybackAction } from "./span-playback"

describe("spanPlaybackAction", () => {
  it("keeps playing before the span's end", () => {
    expect(spanPlaybackAction({ currentTime: 3, stopAt: 5, loop: false, loopFrom: 2 })).toBe("continue")
  })

  it("stops at the end when the loop is off", () => {
    expect(spanPlaybackAction({ currentTime: 5, stopAt: 5, loop: false, loopFrom: 2 })).toBe("stop")
  })

  it("restarts at the end when the loop is on", () => {
    expect(spanPlaybackAction({ currentTime: 5.2, stopAt: 5, loop: true, loopFrom: 2 })).toBe("restart")
  })

  it("never restarts without a point to restart from (a caret is playing)", () => {
    expect(spanPlaybackAction({ currentTime: 9, stopAt: 5, loop: true, loopFrom: null })).toBe("stop")
  })

  it("runs on for ever when there is no stop point at all", () => {
    // A caret plays from a word to the end of the call; a boundary never
    // arrives, loop toggle or not.
    expect(spanPlaybackAction({ currentTime: 120, stopAt: null, loop: true, loopFrom: 2 })).toBe("continue")
  })
})
