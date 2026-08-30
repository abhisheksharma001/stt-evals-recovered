import * as React from "react"
import { useListDisagreementSpans, type DisagreementSpan } from "@workspace/api-client-react"
import { Play, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { apiBase } from "@/lib/api-base"

// T-08: "a disagreement is a play button" (PRD-v4-uiux D.3.2).
// T-86: listen-only. There is no human judge in this product -- nobody
// picks who heard it right. Where the providers heard different words,
// this lists each stretch with its timestamp; clicking it plays just those
// seconds (plus a little context) from the cached audio, with every
// provider's reading beside it. J/K or arrows move, Space plays.

/** Seconds of audio played either side of the disputed words. */
const CONTEXT_SECONDS = 0.75

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
  spans,
  activeIndex,
  playingIndex,
  nameOf,
  onPlay,
}: {
  referenceWords: string[]
  spans: DisagreementSpan[]
  activeIndex: number
  playingIndex: number | null
  nameOf: (providerId: string) => string
  onPlay: (index: number) => void
}) {
  const pieces: React.ReactNode[] = []
  let cursor = 0
  spans.forEach((span, index) => {
    const [first, last] = span.referencePositions as [number, number]
    if (first > cursor) pieces.push(<span key={`t${cursor}`}>{referenceWords.slice(cursor, first).join(" ")} </span>)
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
  if (cursor < referenceWords.length) pieces.push(<span key={`t${cursor}`}>{referenceWords.slice(cursor).join(" ")}</span>)

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
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const stopAtRef = React.useRef<number | null>(null)
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [playingIndex, setPlayingIndex] = React.useState<number | null>(null)

  const spans: DisagreementSpan[] = data?.spans ?? []

  // Stop at the end of the span -- the <audio> element has no "play a
  // window" API, so it's a timeupdate watch.
  const play = React.useCallback(
    (index: number) => {
      const span = spans[index]
      const audio = audioRef.current
      if (!span || !audio) return
      stopAtRef.current = span.endMs / 1000 + CONTEXT_SECONDS
      audio.currentTime = Math.max(0, span.startMs / 1000 - CONTEXT_SECONDS)
      setActiveIndex(index)
      setPlayingIndex(index)
      void audio.play().catch((err: unknown) => {
        setPlayingIndex(null)
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
    [spans, toast],
  )

  React.useEffect(() => {
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-span-index="${activeIndex}"]`)
    row?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  const onTimeUpdate = () => {
    const audio = audioRef.current
    if (!audio || stopAtRef.current === null) return
    if (audio.currentTime >= stopAtRef.current) {
      audio.pause()
      stopAtRef.current = null
      setPlayingIndex(null)
    }
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
      aria-label="Disagreement spans -- J/K to move, Space to play"
    >
      <audio
        ref={audioRef}
        preload="metadata"
        src={`${apiBase()}/api/benchmark/calls/${callId}/audio`}
        onTimeUpdate={onTimeUpdate}
        onEnded={() => setPlayingIndex(null)}
        onPause={() => setPlayingIndex(null)}
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
        <span className="font-mono text-[10px] text-muted-foreground">J/K move · Space play</span>
      </div>

      {data.referenceWords.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground">
            The call as {data.referenceProviderId ? nameOf(data.referenceProviderId) : "the reference"} heard it, normalized
            (lowercase, digits, no punctuation). Highlighted stretches are where providers disagree -- click one to hear
            it and see every reading below.
          </p>
          <DisagreementReading
            referenceWords={data.referenceWords}
            spans={spans}
            activeIndex={activeIndex}
            playingIndex={playingIndex}
            nameOf={nameOf}
            onPlay={play}
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
