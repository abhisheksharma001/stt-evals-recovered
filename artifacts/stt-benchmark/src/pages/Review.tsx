import * as React from "react"
import { useSearch } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListBenchmarkCalls,
  getListBenchmarkCallsQueryKey,
  BenchmarkCall,
} from "@workspace/api-client-react"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  ShieldCheck,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiBase } from "@/lib/api-base"
import { useToast } from "@/hooks/use-toast"

// ---------------------------------------------------------------------------
// 2026-08-27, per Abhishek: "we don't need a gold transcript any more."
// This page used to be a two-column transcript editor (provider draft on the
// left, editable gold on the right) plus entity tagging -- both retired.
// Nothing downstream reads a gold transcript any more (see
// docs/PRD-technical-fixes.md's companion redesign: the run-executor's
// hybrid flag pass compares candidate providers to each other, not to a
// human reference), so there is nothing left to correct here. What remains
// was the de-identification sign-off gate -- and 2026-08-27, per Abhishek's
// explicit decision, that gate is removed too: nothing blocks a call from a
// run any more.
//
// What is left is worth keeping on its own terms: this is the only place you
// can play a call's audio while reading its transcript. So the page stays as
// a read-only listen/inspect view, with no gate and nothing to approve.
// ---------------------------------------------------------------------------

/** Speaker turns parsed out of a provider transcript ("AI: ...", "User: ..."). */
type Turn = { speaker: string | null; text: string }

function parseTurns(transcript: string | null | undefined): Turn[] {
  if (!transcript) return []
  return transcript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^([A-Za-z][A-Za-z ]{0,14}):\s*(.*)$/.exec(line)
      return match ? { speaker: match[1], text: match[2] } : { speaker: null, text: line }
    })
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  return `${mins}:${String(seconds % 60).padStart(2, "0")}`
}

function MonoLabel({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <span className={cn("font-mono text-[10px] font-medium uppercase tracking-[0.09em]", className)}>
      {children}
    </span>
  )
}

export default function Review() {
  const { data: calls, isLoading, isError, error, refetch } = useListBenchmarkCalls()
  const search = useSearch()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [playing, setPlaying] = React.useState(false)
  const audioRef = React.useRef<HTMLAudioElement>(null)

  // Nothing is "done" or "pending" any more, so order is simply stable and
  // predictable: by vertical, then label.
  const queue = React.useMemo(() => {
    if (!calls) return []
    return [...calls].sort(
      (a, b) => a.vertical.localeCompare(b.vertical) || a.label.localeCompare(b.label),
    )
  }, [calls])

  const selected = React.useMemo(
    () => queue.find((c) => c.id === selectedId) ?? null,
    [queue, selectedId],
  )

  // Deep link: /review?call=<id> from Corpus or anywhere else. Applied once
  // when the queue first has data.
  const appliedDeepLink = React.useRef(false)
  React.useEffect(() => {
    if (appliedDeepLink.current || queue.length === 0) return
    appliedDeepLink.current = true
    const requested = new URLSearchParams(search).get("call")
    if (requested && queue.some((c) => c.id === requested)) {
      setSelectedId(requested)
    } else {
      setSelectedId(queue[0].id)
    }
  }, [queue, search])

  React.useEffect(() => {
    setPlaying(false)
  }, [selected?.id])

  const index = selected ? queue.findIndex((c) => c.id === selected.id) : -1
  const draftTurns = React.useMemo(() => parseTurns(selected?.draftTranscript), [selected?.id])

  const goTo = (offset: number) => {
    const next = queue[index + offset]
    if (!next) return
    setSelectedId(next.id)
  }

  // Keyboard: move through the queue, toggle playback.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      const typing =
        target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)
      if (typing) return
      if (target?.closest("button, a, select, audio, [role='button'], [role='slider']")) return
      if (e.key === "j") goTo(1)
      if (e.key === "k") goTo(-1)
      if (e.key === " ") {
        e.preventDefault()
        togglePlay()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const togglePlay = () => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) {
      void el.play().catch(() => setPlaying(false))
      setPlaying(true)
    } else {
      el.pause()
      setPlaying(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading review queue…
      </div>
    )
  }

  if (isError && !calls) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-destructive">
          Failed to load the review queue: {error instanceof Error ? error.message : String(error)}
        </p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>Retry</Button>
      </div>
    )
  }

  if (!selected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-sm font-medium">Nothing to review</p>
        <p className="text-sm text-muted-foreground">Import calls from Vapi to get started.</p>
      </div>
    )
  }

  return (
    <div className="flex h-screen w-full overflow-hidden">
      {/* queue -------------------------------------------------------- */}
      <div className="flex w-[252px] shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="border-b border-border px-4 pb-3.5 pt-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold">Calls</span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {queue.length}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {queue.map((call) => {
            const active = call.id === selected.id
            return (
              <button
                key={call.id}
                onClick={() => setSelectedId(call.id)}
                className={cn(
                  "mb-0.5 w-full rounded-lg px-2.5 py-2.5 text-left transition-colors",
                  active
                    ? "border-l-2 border-primary bg-secondary"
                    : "border-l-2 border-transparent hover:bg-secondary/50",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "truncate font-mono text-xs",
                      active ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {call.label}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {formatDuration(call.durationSeconds)}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* main --------------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[76px] shrink-0 items-center justify-between border-b border-border bg-sidebar px-5">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-base font-semibold">{selected.label}</span>
              <span className="rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5">
                <MonoLabel className="text-primary">
                  {selected.vertical.replace(/_/g, " ")}
                </MonoLabel>
              </span>
            </div>
            <div className="flex gap-3.5">
              <MonoLabel className="text-muted-foreground">
                {formatDuration(selected.durationSeconds)}
              </MonoLabel>
              {selected.sourceAccountLabel && (
                <MonoLabel className="text-muted-foreground">
                  {selected.sourceAccountLabel}
                </MonoLabel>
              )}
              {selected.hardCases.length > 0 && (
                <MonoLabel className="text-muted-foreground">
                  {selected.hardCases.join(", ")}
                </MonoLabel>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => goTo(-1)}
              disabled={index <= 0}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              <MonoLabel>Prev</MonoLabel>
            </button>
            <button
              onClick={() => goTo(1)}
              disabled={index >= queue.length - 1}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-40"
            >
              <MonoLabel>Next</MonoLabel>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* draft transcript, read-only -- context for confirming de-id */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <MonoLabel className="mb-3 block text-muted-foreground">
            Provider draft transcript · read only, listen against the audio below to confirm no PII survived de-identification
          </MonoLabel>
          {draftTurns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No provider draft transcript on file for this call.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {draftTurns.map((turn, i) => (
                <div key={i} className="flex gap-3">
                  {turn.speaker && (
                    <MonoLabel className="w-12 shrink-0 pt-1 text-muted-foreground">
                      {turn.speaker}
                    </MonoLabel>
                  )}
                  <p className="font-serif text-[15px] leading-[1.62] text-foreground rounded-md bg-muted/30 p-3">
                    {turn.text}
                  </p>
                </div>
              ))}
            </div>
          )}
          {selected.entityNotes && (
            <div className="mt-4 rounded-lg border border-card-border bg-card p-3">
              <MonoLabel className="mb-1.5 block text-muted-foreground">Curator notes</MonoLabel>
              <p className="font-serif text-sm leading-relaxed text-muted-foreground">{selected.entityNotes}</p>
            </div>
          )}
        </div>

        {/* transport */}
        <div className="flex h-[72px] shrink-0 flex-col justify-center gap-2.5 border-t border-border bg-sidebar px-5">
          <div className="flex items-center gap-3.5">
            <button
              onClick={togglePlay}
              disabled={!selected.audioObjectPath}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
            >
              {playing ? (
                <Pause className="h-3.5 w-3.5" fill="currentColor" />
              ) : (
                <Play className="h-3.5 w-3.5" fill="currentColor" />
              )}
            </button>
            {selected.audioObjectPath ? (
              <audio
                key={selected.id}
                ref={audioRef}
                src={`${apiBase()}/api/benchmark/calls/${selected.id}/audio`}
                controls
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onError={() =>
                  toast({
                    title: "Couldn't load audio",
                    description: "The recording link may have expired on Vapi's side, or no Vapi account is configured on the server.",
                    variant: "destructive",
                  })
                }
                className="h-8 flex-1"
              />
            ) : (
              <span className="flex-1 text-xs text-muted-foreground">
                No audio URL on this call.
              </span>
            )}
          </div>
          <div className="flex gap-4">
            <MonoLabel className="text-muted-foreground">
              <span className="text-foreground">Space</span> play
            </MonoLabel>
            <MonoLabel className="text-muted-foreground">
              <span className="text-foreground">J K</span> move
            </MonoLabel>
          </div>
        </div>
      </div>


    </div>
  )
}
