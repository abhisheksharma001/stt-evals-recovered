import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListDisagreementSpans,
  useAdjudicateSpan,
  getListDisagreementSpansQueryKey,
  type DisagreementSpan,
} from "@workspace/api-client-react"
import { Play, Check, Ban, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { apiBase } from "@/lib/api-base"

// T-08: "a disagreement is a play button" (PRD-v4-uiux D.3.2).
//
// Where the providers heard different words, this lists each stretch with
// its timestamp; clicking it plays just those seconds (plus a little
// context) from the cached audio, and the reader picks which provider heard
// it right -- or that none did. That verdict is the only place in the tool
// where a person, not a diff and not a model, says what was correct. It
// feeds T-09 (how often the judge agrees with a human).
//
// Built for volume: everything is on the keyboard so twenty spans are a
// couple of minutes, not a scrubbing session. J/K or arrows move, Space
// plays, 1-9 picks a reading, 0 says "none of them", and a verdict advances
// to the next unadjudicated span by itself.

/** Seconds of audio played either side of the disputed words. */
const CONTEXT_SECONDS = 0.75

function fmtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

export function SpanAdjudicator({
  callId,
  runId,
  providerNames,
}: {
  callId: string
  runId: string | null
  /** providerId -> display name, from whatever the caller already has. */
  providerNames: Record<string, string>
}) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const params = { callId, ...(runId ? { runId } : {}) }
  const { data, isLoading, isError } = useListDisagreementSpans(params)
  const adjudicate = useAdjudicateSpan()

  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const stopAtRef = React.useRef<number | null>(null)
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [playingIndex, setPlayingIndex] = React.useState<number | null>(null)

  const spans: DisagreementSpan[] = data?.spans ?? []
  const adjudicatedCount = spans.filter((s) => s.adjudication).length

  // Stop at the end of the span -- the <audio> element has no "play a
  // window" API, so it's a timeupdate watch. ~250ms granularity is fine for
  // a 3-5 second listen.
  const play = React.useCallback(
    (index: number) => {
      const span = spans[index]
      const audio = audioRef.current
      if (!span || !audio) return
      stopAtRef.current = span.endMs / 1000 + CONTEXT_SECONDS
      audio.currentTime = Math.max(0, span.startMs / 1000 - CONTEXT_SECONDS)
      setActiveIndex(index)
      setPlayingIndex(index)
      void audio.play().catch(() => {
        setPlayingIndex(null)
        toast({
          title: "Couldn't play audio",
          description: "The recording isn't cached on the server and its Vapi link may have expired.",
          variant: "destructive",
        })
      })
    },
    [spans, toast],
  )

  const onTimeUpdate = () => {
    const audio = audioRef.current
    if (!audio || stopAtRef.current === null) return
    if (audio.currentTime >= stopAtRef.current) {
      audio.pause()
      stopAtRef.current = null
      setPlayingIndex(null)
    }
  }

  const record = React.useCallback(
    (index: number, correctProviderId: string | null) => {
      const span = spans[index]
      if (!span || !data?.runId || adjudicate.isPending) return
      adjudicate.mutate(
        {
          callId,
          data: {
            runId: data.runId,
            spanStartMs: span.startMs,
            spanEndMs: span.endMs,
            correctProviderId,
            readings: span.readings.map((r) => ({ providerId: r.providerId, text: r.text })),
          },
        },
        {
          onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: getListDisagreementSpansQueryKey(params) })
            // Advance to the next span that still needs a verdict, if any.
            const next = spans.findIndex((s, i) => i > index && !s.adjudication)
            if (next !== -1) setActiveIndex(next)
          },
          onError: (err) =>
            toast({ title: "Verdict not saved", description: err instanceof Error ? err.message : String(err), variant: "destructive" }),
        },
      )
    },
    [spans, data?.runId, adjudicate, callId, queryClient, params, toast],
  )

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
    } else if (key === "0" || key === "n") {
      e.preventDefault()
      record(activeIndex, null)
    } else if (/^[1-9]$/.test(key)) {
      e.preventDefault()
      const reading = spans[activeIndex]?.readings[Number(key) - 1]
      if (reading) record(activeIndex, reading.providerId)
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
    return <p className="text-xs text-success">Every provider heard every word the same way. Nothing to adjudicate.</p>
  }

  const nameOf = (providerId: string) => providerNames[providerId] ?? providerId

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={() => containerRef.current?.focus()}
      className="space-y-2 rounded-md outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label="Disagreement spans -- J/K to move, Space to play, 1-9 to pick a provider, 0 for none of them"
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
          <span className="font-mono text-muted-foreground">
            {adjudicatedCount}/{spans.length} decided
          </span>
          {data.referenceProviderId && (
            <span className="text-muted-foreground" title="Whose word timings anchor the spans to the audio. Not a judgement about who is right.">
              timed by {nameOf(data.referenceProviderId)}
            </span>
          )}
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          J/K move · Space play · 1-9 pick · 0 none
        </span>
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        {spans.map((span, index) => {
          const active = index === activeIndex
          const playing = index === playingIndex
          const verdict = span.adjudication
          return (
            <div
              key={`${span.startMs}-${span.endMs}`}
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
                    {span.readings.map((reading, rIndex) => {
                      const chosen = verdict?.correctProviderId === reading.providerId
                      return (
                        <button
                          type="button"
                          key={reading.providerId}
                          onClick={(e) => {
                            e.stopPropagation()
                            record(index, reading.providerId)
                          }}
                          disabled={adjudicate.isPending}
                          className={`flex items-center gap-2 rounded border px-2 py-1 text-left text-xs transition-colors hover:bg-muted/40 ${
                            chosen ? "border-success bg-success/10" : "border-border"
                          }`}
                          title={`Press ${rIndex + 1}`}
                        >
                          <kbd className="shrink-0 rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                            {rIndex + 1}
                          </kbd>
                          <span className="w-24 shrink-0 truncate font-medium">{nameOf(reading.providerId)}</span>
                          <span className={`min-w-0 flex-1 truncate font-mono ${reading.text ? "" : "italic text-muted-foreground"}`}>
                            {reading.text || "(nothing)"}
                          </span>
                          {chosen && <Check className="h-3.5 w-3.5 shrink-0 text-success" />}
                        </button>
                      )
                    })}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        record(index, null)
                      }}
                      disabled={adjudicate.isPending}
                      className={`flex items-center gap-2 rounded border border-dashed px-2 py-1 text-left text-xs transition-colors hover:bg-muted/40 ${
                        verdict && verdict.correctProviderId === null ? "border-warning bg-warning/10" : "border-border"
                      }`}
                      title="Press 0"
                    >
                      <kbd className="shrink-0 rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">0</kbd>
                      <Ban className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="text-muted-foreground">None of them heard it right</span>
                      {verdict && verdict.correctProviderId === null && <Check className="h-3.5 w-3.5 shrink-0 text-warning" />}
                    </button>
                  </div>
                  {verdict && (
                    <p className="text-[10px] text-muted-foreground">
                      <Badge variant="outline" className="mr-1 text-[9px] uppercase">decided</Badge>
                      {verdict.correctProviderId ? nameOf(verdict.correctProviderId) : "none of them"} · by {verdict.adjudicatedByLabel} ·{" "}
                      {new Date(verdict.adjudicatedAt).toLocaleString()}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
