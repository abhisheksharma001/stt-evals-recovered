import * as React from "react"
import { useSearch } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListBenchmarkCalls,
  useAttestBenchmarkCallDeid,
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
// is exactly the one thing that's still a real, compliance-required gate
// before a call can enter a bundle: de-identification sign-off by two
// distinct people. The draft transcript still shows (read-only) so a
// reviewer has something to listen/read against while confirming de-id.
// ---------------------------------------------------------------------------

function deIdComplete(call: BenchmarkCall): boolean {
  return Boolean(call.deIdAttestedByLabel && call.deIdSecondApproverLabel)
}

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
  const attestDeid = useAttestBenchmarkCallDeid()
  const { toast } = useToast()

  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [playing, setPlaying] = React.useState(false)
  const audioRef = React.useRef<HTMLAudioElement>(null)

  // Queue order: unfinished work first, so opening Review lands on something
  // that needs doing rather than on whatever was created most recently.
  const queue = React.useMemo(() => {
    if (!calls) return []
    return [...calls].sort((a, b) => {
      const ap = deIdComplete(a) ? 1 : 0
      const bp = deIdComplete(b) ? 1 : 0
      if (ap !== bp) return ap - bp
      return a.vertical.localeCompare(b.vertical) || a.label.localeCompare(b.label)
    })
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
  const doneCount = queue.filter(deIdComplete).length
  const draftTurns = React.useMemo(() => parseTurns(selected?.draftTranscript), [selected?.id])

  const goTo = (offset: number) => {
    const next = queue[index + offset]
    if (!next) return
    setSelectedId(next.id)
  }

  // Bug found live 2026-08-27 (Abhishek): window.prompt() is not supported
  // in this preview sandbox at all ("prompt() is not supported" runtime
  // error) -- it silently blocked the ONE thing this page exists to do.
  // Replaced with an in-app dialog, same pattern as Bulks.tsx's create
  // dialogs, so approver name entry works in every environment this app
  // actually runs in.
  const [attestDialogOpen, setAttestDialogOpen] = React.useState(false)
  const [approverInput, setApproverInput] = React.useState("")
  const attestInputRef = React.useRef<HTMLInputElement>(null)

  const openAttestDialog = () => {
    if (!selected) return
    setApproverInput("")
    setAttestDialogOpen(true)
  }

  const submitAttest = () => {
    const approver = approverInput.trim()
    if (!selected || !approver) return
    attestDeid.mutate(
      { callId: selected.id, data: { approverLabel: approver } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListBenchmarkCallsQueryKey() })
          toast({ title: "Attestation recorded", description: approver })
          setAttestDialogOpen(false)
        },
        onError: (err) =>
          toast({
            title: "Attestation rejected",
            description: err instanceof Error ? err.message : "Two distinct approvers are required.",
            variant: "destructive",
          }),
      },
    )
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

  const complete = deIdComplete(selected)

  return (
    <div className="flex h-screen w-full overflow-hidden">
      {/* queue -------------------------------------------------------- */}
      <div className="flex w-[252px] shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="border-b border-border px-4 pb-3.5 pt-4">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-sm font-semibold">De-ID queue</span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {doneCount} / {queue.length}
            </span>
          </div>
          <div className="flex h-1 overflow-hidden rounded-full bg-secondary">
            <div
              className="bg-primary transition-all"
              style={{ width: `${queue.length ? (doneCount / queue.length) * 100 : 0}%` }}
            />
          </div>
          <div className="mt-2.5">
            <MonoLabel className="text-muted-foreground">
              {queue.length - doneCount} left
            </MonoLabel>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {queue.map((call) => {
            const done = deIdComplete(call)
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
                  {done ? (
                    <Check className="h-3 w-3 shrink-0 text-success" strokeWidth={2.6} />
                  ) : (
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                      {formatDuration(call.durationSeconds)}
                    </span>
                  )}
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

      {/* right panel: de-id -------------------------------------------- */}
      <div className="flex w-[300px] shrink-0 flex-col border-l border-border bg-sidebar">
        <div className="flex h-11 shrink-0 items-center border-b border-border px-3">
          <MonoLabel className="text-primary">De-identification</MonoLabel>
        </div>
        <div className="flex flex-1 flex-col gap-3 p-3">
          <MonoLabel className="text-muted-foreground">Two-person attestation</MonoLabel>

          <div className="flex items-center gap-2.5 rounded-lg border border-card-border bg-card p-2.5">
            {selected.deIdAttestedByLabel ? (
              <Check className="h-4 w-4 shrink-0 text-success" strokeWidth={2.4} />
            ) : (
              <div className="h-4 w-4 shrink-0 rounded-full border border-border" />
            )}
            <span className="truncate text-xs">
              {selected.deIdAttestedByLabel ?? "First approver required"}
            </span>
          </div>

          <div className="flex items-center gap-2.5 rounded-lg border border-card-border bg-card p-2.5">
            {selected.deIdSecondApproverLabel ? (
              <Check className="h-4 w-4 shrink-0 text-success" strokeWidth={2.4} />
            ) : (
              <div className="h-4 w-4 shrink-0 rounded-full border border-border" />
            )}
            <span className="truncate text-xs">
              {selected.deIdSecondApproverLabel ?? "Second approver required"}
            </span>
          </div>

          <button
            onClick={openAttestDialog}
            disabled={complete || attestDeid.isPending}
            className="flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 transition-colors hover:bg-secondary disabled:opacity-40"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            <MonoLabel>{complete ? "Attested" : "Attest de-identification"}</MonoLabel>
          </button>

          {!complete && (
            <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-2.5">
              <MonoLabel className="leading-relaxed text-destructive">
                Blocked from bundles until two different people sign off.
              </MonoLabel>
            </div>
          )}

          {complete && (
            <div className="rounded-lg border border-success/25 bg-success/10 p-2.5">
              <MonoLabel className="leading-relaxed text-success">
                De-identified and ready to run -- no gold transcript required.
              </MonoLabel>
            </div>
          )}
        </div>
      </div>

      <Dialog open={attestDialogOpen} onOpenChange={setAttestDialogOpen}>
        <DialogContent
          onOpenAutoFocus={(e) => {
            // Autofocus the input, not the dialog's own close button.
            e.preventDefault()
            attestInputRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>Attest de-identification</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="approver-name">Name or email</Label>
            <Input
              id="approver-name"
              ref={attestInputRef}
              value={approverInput}
              onChange={(e) => setApproverInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && approverInput.trim()) submitAttest()
              }}
              placeholder="e.g. abhishek@ellavox.ai"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Two DIFFERENT people must attest before this call can enter a bundle.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAttestDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitAttest} disabled={!approverInput.trim() || attestDeid.isPending}>
              Attest
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
