// T-138: what the <audio> element should do at each timeupdate while a
// disagreement span (or a caret) is playing. Pulled out of the component so
// the one piece of real logic in the listener -- when does a boundary mean
// "stop" and when does it mean "go round again" -- can be tested without a
// browser, a fake audio element or a mocked API hook.

export type SpanPlaybackTick = {
  /** Where the audio is now, seconds. */
  currentTime: number
  /** Where this playback should end, seconds. Null while a caret plays:
   *  "hear that moment" runs on to the end of the call. */
  stopAt: number | null
  /** Whether the loop toggle is on. */
  loop: boolean
  /** Where a loop restarts from, seconds. Null when nothing loopable is
   *  playing (a caret has no start to come back to). */
  loopFrom: number | null
}

export type SpanPlaybackAction = "continue" | "restart" | "stop"

export function spanPlaybackAction({ currentTime, stopAt, loop, loopFrom }: SpanPlaybackTick): SpanPlaybackAction {
  if (stopAt === null) return "continue"
  if (currentTime < stopAt) return "continue"
  // Loop wins at the boundary, and only there: switching the toggle off
  // mid-pass lets the current pass finish rather than cutting it short.
  if (loop && loopFrom !== null) return "restart"
  return "stop"
}
