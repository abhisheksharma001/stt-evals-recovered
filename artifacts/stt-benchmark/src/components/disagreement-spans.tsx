import * as React from "react"
import { useListDisagreementSpans, type DisagreementSpan } from "@workspace/api-client-react"
import { Play, Loader2, Repeat } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { apiBase } from "@/lib/api-base"
import { PlaybackSpeed } from "@/components/playback-speed"
import { spanPlaybackAction } from "@/lib/span-playback"

// T-08: "a disagreement is a play button" (PRD-v4-uiux D.3.2).
// T-86: listen-only. There is no human judge in this product -- nobody
// picks who heard it right. Where the providers heard different words,
// this lists each stretch with its timestamp; clicking it plays just those
// seconds (plus a little context) from the cached audio, with every
// provider's reading beside it. J/K or arrows move, Space plays.
//
// T-137 (backlog "review workspace polish"): every ordinary word in the
// reading is a caret too -- click any word and the audio plays from that
// word onward, so checking a name or a number no longer means dragging the
// transport bar to guess where it was. The word starts come from the same
// reference timings that anchor the spans (referenceWordStartMs), so a
// caret can never point somewhere the spans disagree with.
//
// T-138 (same backlog item, "loop-selection / spot-audition"): a span can be
// put on repeat. Two seconds of a phone number played once is a guess; the
// same two seconds on a loop is a decision. Loop applies to spans only -- a
// caret has no end to loop back from.

/** Seconds of audio played either side of the disputed words. */
const CONTEXT_SECONDS = 0.75

/** T-137: a hair of lead-in before the clicked word, so its first consonant
 *  is not clipped by the seek. */
const CARET_LEAD_IN_SECONDS = 0.12

function fmtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

// T-22: one flowing reading of the call. The reference provider's words
// run as plain text; each stretch where the providers disagree is swapped
// for a play button carrying its timestamp and the reference's own reading.
// The reference is only the clock and the alignment anchor (T-08) -- its
// reading is never "the right one".
function DisagreementReading({
  referenceWords,
  wordStartMs,
  spans,
  activeIndex,
  playingIndex,
  caretIndex,
  nameOf,
  onPlay,
  onPlayFromWord,
}: {
  referenceWords: string[]
  /** T-137: start of each referenceWords[i] in the audio. Same length; empty
   *  only when the API sent no timings, which is when carets stay off. */
  wordStartMs: number[]
  spans: DisagreementSpan[]
  activeIndex: number
  playingIndex: number | null
  caretIndex: number | null
  nameOf: (providerId: string) => string
  onPlay: (index: number) => void
  onPlayFromWord: (position: number) => void
}) {
  const carets = wordStartMs.length === referenceWords.length
  // T-137: one clickable word. Rendered as a plain inline button so the
  // reading still reads as prose -- no boxes, no underlines until hover.
  const word = (position: number) => {
    const text = referenceWords[position]!
    if (!carets) return <span key={`w${position}`}>{text} </span>
    return (
      <button
        type="button"
        key={`w${position}`}
        data-testid="caret-word"
        data-word-position={position}
        onClick={(e) => {
          e.stopPropagation()
          onPlayFromWord(position)
        }}
        title={`Play from here (${fmtTime(wordStartMs[position]!)})`}
        className={`rounded-sm px-px hover:bg-primary/15 hover:underline ${
          caretIndex === position ? "bg-primary/20 underline" : ""
        }`}
      >
        {text}
      </button>
    )
  }
  const plain = (from: number, to: number) => {
    const out: React.ReactNode[] = []
    for (let p = from; p < to; p += 1) {
      out.push(word(p))
      out.push(<span key={`ws${p}`}> </span>)
    }
    return out
  }

  const pieces: React.ReactNode[] = []
  let cursor = 0
  spans.forEach((span, index) => {
    const [first, last] = span.referencePositions as [number, number]
    if (first > cursor) pieces.push(...plain(cursor, first))
    const ownWords = referenceWords.slice(first, last + 1).join(" ")
    const others = span.readings.filter((r) => !r.agreesWithReference)
    const active = index === activeIndex
    const playing = index === playingIndex
    pieces.push(
      <button
        type="button"
        key={`s${index}`}
        onClick={(e) => {
          e.stopPropagation()
          onPlay(index)
        }}
        title={
          (span.majorityText !== null ? `most heard: ${span.majorityText || "(nothing)"}\n` : "no majority (tie)\n") +
          (others.length > 0
            ? others.map((r) => `${nameOf(r.providerId)}: ${r.text || "(nothing)"}`).join("\n")
            : "Providers disagree here")
        }
        aria-label={`Play ${fmtTime(span.startMs)} to ${fmtTime(span.endMs)}: ${ownWords || "nothing"}`}
        className={`mx-0.5 inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 align-baseline font-mono text-[11px] leading-tight transition-colors ${
          playing
            ? "border-primary bg-primary text-primary-foreground"
            : active
              ? "border-primary bg-primary/10 text-foreground"
              : "border-warning/40 bg-warning/10 text-foreground hover:bg-warning/20"
        }`}
      >
        <Play className="h-2.5 w-2.5 shrink-0" />
        <span className="shrink-0 text-muted-foreground">{fmtTime(span.startMs)}</span>
        <span className={`truncate ${ownWords ? "" : "italic text-muted-foreground"}`}>{ownWords || "(nothing)"}</span>
      </button>,
    )
    pieces.push(<span key={`g${index}`}> </span>)
    cursor = last + 1
  })
  if (cursor < referenceWords.length) pieces.push(...plain(cursor, referenceWords.length))

  return (
    <div
      data-testid="disagreement-reading"
      className="max-h-72 overflow-y-auto rounded-md border border-border bg-muted/20 p-3 font-serif text-sm leading-7 text-foreground"
    >
      {pieces}
    </div>
  )
}

export function DisagreementSpans({
  callId,
  runId,
  providerNames,
}: {
  callId: string
  runId: string | null
  /** providerId -> display name, from whatever the caller already has. */
  providerNames: Record<string, string>
}) {
  const { toast } = useToast()
  const params = { callId, ...(runId ? { runId } : {}) }
  const { data, isLoading, isError } = useListDisagreementSpans(params)

  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  // T-135: kept across span clicks; re-applied onLoadedMetadata because the
  // browser resets playbackRate when the element (re)loads its source.
  const [playbackRate, setPlaybackRate] = React.useState(1)
  const applyRate = (rate: number) => {
    setPlaybackRate(rate)
    if (audioRef.current) audioRef.current.playbackRate = rate
  }
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const stopAtRef = React.useRef<number | null>(null)
  // T-138: where the current span's loop restarts from. Null while a caret
  // plays (nothing to loop) or before anything has played.
  const loopFromRef = React.useRef<number | null>(null)
  const [loop, setLoop] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [playingIndex, setPlayingIndex] = React.useState<number | null>(null)
  // T-137: which word the caret is playing from, for the highlight. Null
  // whenever a span (or nothing) is playing.
  const [caretIndex, setCaretIndex] = React.useState<number | null>(null)

  const spans: DisagreementSpan[] = data?.spans ?? []

  /** Play from `fromSec`, stopping at `stopAtSec` (null = play on until the
   *  audio ends or the person pauses). The <audio> element has no "play a
   *  window" API, so the stop is a timeupdate watch. */
  const playFrom = React.useCallback(
    (fromSec: number, stopAtSec: number | null, onBlocked: () => void) => {
      const audio = audioRef.current
      if (!audio) return
      stopAtRef.current = stopAtSec
      audio.currentTime = Math.max(0, fromSec)
      void audio.play().catch((err: unknown) => {
        onBlocked()
        // T-59: say what actually went wrong.
        const name = err instanceof DOMException ? err.name : ""
        const description =
          name === "NotAllowedError"
            ? "The browser blocked playback until you interact with the page. Click anywhere on the page first, then play again."
            : name === "AbortError"
              ? "Playback was interrupted by another play request."
              : "The recording isn't cached on the server and its Vapi link may have expired."
        toast({ title: "Couldn't play audio", description, variant: "destructive" })
      })
    },
    [toast],
  )

  const play = React.useCallback(
    (index: number) => {
      const span = spans[index]
      if (!span) return
      setActiveIndex(index)
      setPlayingIndex(index)
      setCaretIndex(null)
      const from = span.startMs / 1000 - CONTEXT_SECONDS
      loopFromRef.current = Math.max(0, from)
      playFrom(from, span.endMs / 1000 + CONTEXT_SECONDS, () => setPlayingIndex(null))
    },
    [spans, playFrom],
  )

  // T-137: play from a word in the reading. No stop point -- "hear that
  // moment" means the call keeps running from there until it is paused,
  // which is how someone checks whether a name was said right.
  const wordStartMs = data?.referenceWordStartMs ?? []
  const playFromWord = React.useCallback(
    (position: number) => {
      const startMs = wordStartMs[position]
      if (startMs === undefined) return
      setPlayingIndex(null)
      setCaretIndex(position)
      loopFromRef.current = null
      playFrom(startMs / 1000 - CARET_LEAD_IN_SECONDS, null, () => setCaretIndex(null))
    },
    [wordStartMs, playFrom],
  )

  React.useEffect(() => {
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-span-index="${activeIndex}"]`)
    row?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  const onTimeUpdate = () => {
    const audio = audioRef.current
    if (!audio) return
    // T-138: the decision itself lives in lib/span-playback.ts, under test.
    const action = spanPlaybackAction({
      currentTime: audio.currentTime,
      stopAt: stopAtRef.current,
      loop,
      loopFrom: loopFromRef.current,
    })
    if (action === "continue") return
    if (action === "restart") {
      audio.currentTime = loopFromRef.current!
      return
    }
    audio.pause()
    stopAtRef.current = null
    setPlayingIndex(null)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (spans.length === 0) return
    const key = e.key
    if (key === "j" || key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => Math.min(spans.length - 1, i + 1))
    } else if (key === "k" || key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (key === " " || key === "Enter") {
      e.preventDefault()
      play(activeIndex)
    } else if (key === "l" || key === "L") {
      // T-138: the loop toggle, without leaving the keyboard.
      e.preventDefault()
      setLoop((on) => !on)
    } else if (key === "Escape") {
      e.preventDefault()
      audioRef.current?.pause()
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Finding where providers disagree...
      </div>
    )
  }
  if (isError || !data) {
    return <p className="text-xs text-destructive">Couldn't load disagreement spans for this call.</p>
  }

  const unavailableCopy: Record<string, string> = {
    no_run: "No run has a successful transcript for this call yet.",
    no_word_timings: "None of the providers that succeeded on this call returned word timings, so spans can't be anchored to the audio.",
    fewer_than_two_candidates: "Only one provider succeeded on this call -- nothing to disagree with.",
  }
  if (data.unavailableReason) {
    return <p className="text-xs text-muted-foreground">{unavailableCopy[data.unavailableReason] ?? data.unavailableReason}</p>
  }
  if (spans.length === 0) {
    return <p className="text-xs text-success">Every provider heard every word the same way.</p>
  }

  const nameOf = (providerId: string) => providerNames[providerId] ?? providerId

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={() => containerRef.current?.focus()}
      className="space-y-2 rounded-md outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label="Disagreement spans -- J/K to move, Space to play, L to loop, Esc to stop"
    >
      <audio
        ref={audioRef}
        preload="metadata"
        src={`${apiBase()}/api/benchmark/calls/${callId}/audio`}
        onLoadedMetadata={(e) => { e.currentTarget.playbackRate = playbackRate }}
        onTimeUpdate={onTimeUpdate}
        onEnded={() => {
          setPlayingIndex(null)
          setCaretIndex(null)
        }}
        onPause={() => {
          setPlayingIndex(null)
          setCaretIndex(null)
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-foreground">
            {spans.length} span{spans.length === 1 ? "" : "s"} where providers disagree
          </span>
          {data.referenceProviderId && (
            <span className="text-muted-foreground" title="Whose word timings anchor the spans to the audio. Not a judgement about who is right.">
              timed by {nameOf(data.referenceProviderId)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={loop ? "default" : "outline"}
            aria-pressed={loop}
            data-testid="loop-span"
            onClick={(e) => {
              e.stopPropagation()
              setLoop((on) => !on)
            }}
            title="Repeat the span you play until you stop it (Esc stops, L toggles)"
            className="h-7 gap-1 px-2 text-[11px]"
          >
            <Repeat className="h-3 w-3" />
            Loop
          </Button>
          <PlaybackSpeed value={playbackRate} onChange={applyRate} />
          <span className="font-mono text-[10px] text-muted-foreground">J/K move · Space play · L loop · Esc stop · click a word to play from it</span>
        </div>
      </div>

      {data.referenceWords.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground">
            The call as {data.referenceProviderId ? nameOf(data.referenceProviderId) : "the reference"} heard it, normalized
            (lowercase, digits, no punctuation). Highlighted stretches are where providers disagree -- click one to hear
            it and see every reading below. Click any other word to play the call from there.
          </p>
          <DisagreementReading
            referenceWords={data.referenceWords}
            wordStartMs={data.referenceWordStartMs}
            spans={spans}
            activeIndex={activeIndex}
            playingIndex={playingIndex}
            caretIndex={caretIndex}
            nameOf={nameOf}
            onPlay={play}
            onPlayFromWord={playFromWord}
          />
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-border">
        {spans.map((span, index) => {
          const active = index === activeIndex
          const playing = index === playingIndex
          return (
            <div
              key={`${span.startMs}-${span.endMs}`}
              data-span-index={index}
              className={`border-b border-border last:border-b-0 ${active ? "bg-primary/5" : ""}`}
              onClick={(e) => {
                e.stopPropagation()
                setActiveIndex(index)
                containerRef.current?.focus()
              }}
            >
              <div className="flex items-start gap-2 px-3 py-2">
                <Button
                  type="button"
                  size="sm"
                  variant={playing ? "default" : "outline"}
                  className="h-7 shrink-0 gap-1 px-2 font-mono text-[11px]"
                  onClick={(e) => {
                    e.stopPropagation()
                    play(index)
                  }}
                  aria-label={`Play ${fmtTime(span.startMs)} to ${fmtTime(span.endMs)}`}
                >
                  <Play className="h-3 w-3" />
                  {fmtTime(span.startMs)}
                </Button>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="font-serif text-xs text-muted-foreground">
                    {span.contextBefore && <span>…{span.contextBefore} </span>}
                    <span className="font-medium text-foreground">[ disputed ]</span>
                    {span.contextAfter && <span> {span.contextAfter}…</span>}
                  </p>
                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {span.readings.map((reading) => (
                      <div
                        key={reading.providerId}
                        className={`flex items-center gap-2 rounded border px-2 py-1 text-xs ${
                          reading.agreesWithMajority ? "border-border" : "border-warning/40 bg-warning/5"
                        }`}
                        title={reading.agreesWithMajority ? "Same as most providers" : "Differs from most providers"}
                      >
                        <span className="w-24 shrink-0 truncate font-medium">{nameOf(reading.providerId)}</span>
                        <span className={`min-w-0 flex-1 truncate font-mono ${reading.text ? "" : "italic text-muted-foreground"}`}>
                          {reading.text || "(nothing)"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
