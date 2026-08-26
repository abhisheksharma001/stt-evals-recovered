import * as React from "react"
import { useSearch } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListBenchmarkCalls,
  useUpdateBenchmarkCall,
  useAttestBenchmarkCallDeid,
  getListBenchmarkCallsQueryKey,
  getGetBenchmarkDashboardQueryKey,
  BenchmarkCall,
  EntityType,
} from "@workspace/api-client-react"
import { editCounts, normalizeTranscript } from "@workspace/scoring"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CornerDownLeft,
  Pause,
  Play,
  ShieldCheck,
  Tag,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { apiBase } from "@/lib/api-base"
import { setNavGuard } from "@/lib/nav-guard"
import { useToast } from "@/hooks/use-toast"

// ---------------------------------------------------------------------------
// Entity vocabulary. The colour per type is a design token so the same hue
// identifies a type here, in the corpus table, and in the results breakdown.
// ---------------------------------------------------------------------------

const ENTITY_TYPES: { type: EntityType; label: string; token: string }[] = [
  { type: "ro_number", label: "RO number", token: "--entity-ro-number" },
  { type: "unit_number", label: "Unit number", token: "--entity-unit-number" },
  { type: "vin", label: "VIN", token: "--entity-vin" },
  { type: "phone_number", label: "Phone", token: "--entity-phone-number" },
  { type: "name", label: "Name", token: "--entity-name" },
  { type: "address", label: "Address", token: "--entity-address" },
  { type: "load_number", label: "Load number", token: "--entity-load-number" },
  { type: "city", label: "City", token: "--entity-city" },
]

const entityColor = (type: string) => {
  const found = ENTITY_TYPES.find((e) => e.type === type)
  return found ? `hsl(var(${found.token}))` : "hsl(var(--muted-foreground))"
}

const entityLabel = (type: string) =>
  ENTITY_TYPES.find((e) => e.type === type)?.label ?? type

// ---------------------------------------------------------------------------
// Review state derived from a call, so the queue, the progress pips and the
// gating rules all read the same three questions.
// ---------------------------------------------------------------------------

type CallProgress = {
  hasGold: boolean
  hasEntities: boolean
  deIdComplete: boolean
  done: boolean
}

function progressOf(call: BenchmarkCall): CallProgress {
  const hasGold = Boolean(call.goldTranscript && call.goldTranscript.trim().length > 0)
  const hasEntities = (call.entityReferences?.length ?? 0) > 0
  const deIdComplete = Boolean(call.deIdAttestedByLabel && call.deIdSecondApproverLabel)
  return { hasGold, hasEntities, deIdComplete, done: hasGold && deIdComplete }
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

/**
 * Word error rate of the provider's draft against the SAVED gold text --
 * deliberately not the text being typed right now. Watching a score move on
 * every keystroke turns "correct what was actually said" into "make the
 * number move," which anchors edits toward the metric instead of the audio.
 * So this is computed from selected.goldTranscript (persisted) and hidden
 * entirely whenever there are unsaved edits (see `dirty` at the call site).
 * Uses the same `editCounts` the run scorer uses, so once shown, the number
 * matches what the benchmark will report -- not a second implementation.
 */
function draftWer(draft: string | null | undefined, gold: string): number | null {
  const reference = normalizeTranscript(gold).split(" ").filter(Boolean)
  const hypothesis = normalizeTranscript(draft ?? "").split(" ").filter(Boolean)
  if (reference.length === 0) return null
  const counts = editCounts(reference, hypothesis)
  return (counts.substitutions + counts.deletions + counts.insertions) / reference.length
}

// 2026-08-27, found live: a 51s call's gold transcript was approved with
// only its first two lines -- every real provider correctly transcribed
// the whole call, so comparing against that truncated "gold" inflated WER
// to 250-360% for every one of them. Nothing was wrong with the providers
// or the scoring; one call's gold was incomplete. This catches that class
// of mistake before approval instead of after a run has already scored
// against it -- a plain speech rate check, not a hard block (a genuinely
// short gold transcript, e.g. mostly silence or hold music, is real too).
const SUSPICIOUS_WORDS_PER_SECOND = 0.7
const MIN_DURATION_TO_CHECK = 15

function goldLooksShortFor(gold: string, durationSeconds: number): boolean {
  const words = gold.trim().split(/\s+/).filter(Boolean).length
  if (words === 0 || durationSeconds < MIN_DURATION_TO_CHECK) return false
  return words / durationSeconds < SUSPICIOUS_WORDS_PER_SECOND
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  return `${mins}:${String(seconds % 60).padStart(2, "0")}`
}

// ---------------------------------------------------------------------------

function ProgressPips({ progress }: { progress: CallProgress }) {
  const pips = [progress.hasGold, progress.hasEntities, progress.deIdComplete]
  return (
    <div className="flex gap-1">
      {pips.map((filled, i) => (
        <span
          key={i}
          className={cn(
            "h-[3px] w-[26px] rounded-full",
            filled ? (progress.done ? "bg-success" : "bg-primary") : "bg-secondary",
          )}
        />
      ))}
    </div>
  )
}

function MonoLabel({
  className,
  style,
  children,
}: {
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}) {
  return (
    <span
      className={cn("font-mono text-[10px] font-medium uppercase tracking-[0.09em]", className)}
      style={style}
    >
      {children}
    </span>
  )
}

export default function Review() {
  const { data: calls, isLoading, isError, error, refetch } = useListBenchmarkCalls()
  const search = useSearch()
  const queryClient = useQueryClient()
  const updateCall = useUpdateBenchmarkCall()
  const attestDeid = useAttestBenchmarkCallDeid()
  const { toast } = useToast()

  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [gold, setGold] = React.useState("")
  const [entities, setEntities] = React.useState<{ type: EntityType; value: string }[]>([])
  const [panelTab, setPanelTab] = React.useState<"entities" | "deid" | "notes">("entities")
  const [playing, setPlaying] = React.useState(false)
  const [selectionText, setSelectionText] = React.useState("")
  const goldRef = React.useRef<HTMLTextAreaElement>(null)
  const audioRef = React.useRef<HTMLAudioElement>(null)

  // Queue order: unfinished work first, so opening Review lands on something
  // that needs doing rather than on whatever was created most recently.
  const queue = React.useMemo(() => {
    if (!calls) return []
    return [...calls].sort((a, b) => {
      const ap = progressOf(a).done ? 1 : 0
      const bp = progressOf(b).done ? 1 : 0
      if (ap !== bp) return ap - bp
      return a.vertical.localeCompare(b.vertical) || a.label.localeCompare(b.label)
    })
  }, [calls])

  // B-48 (bug register): the `?? queue[0]` fallback used to re-resolve on
  // every queue re-sort (e.g. after an attestation reorders unfinished-first),
  // silently jumping the editor to a different call — bypassing both dirty
  // guards and risking a cross-call save. Pin the selection once instead.
  const selected = React.useMemo(
    () => queue.find((c) => c.id === selectedId) ?? null,
    [queue, selectedId],
  )

  // Deep link: /review?call=<id> from Corpus or anywhere else. Applied once
  // when the queue first has data -- after that, in-page navigation (queue
  // clicks, prev/next) owns selectedId and the URL param is not re-read, so
  // it doesn't fight the user for control of what's open.
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

  // Load the selected call's saved work into the editor. Keyed on id only, so
  // a background refetch never clobbers what is being typed.
  React.useEffect(() => {
    if (!selected) return
    setGold(selected.goldTranscript ?? "")
    setEntities(selected.entityReferences ?? [])
    setSelectionText("")
    // The <audio> element remounts (keyed on call id) so playback itself
    // resets; this just keeps the play/pause icon in sync with it.
    setPlaying(false)
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const index = selected ? queue.findIndex((c) => c.id === selected.id) : -1
  const doneCount = queue.filter((c) => progressOf(c).done).length
  const draftTurns = React.useMemo(() => parseTurns(selected?.draftTranscript), [selected?.id])
  const wer = React.useMemo(
    () => draftWer(selected?.draftTranscript, selected?.goldTranscript ?? ""),
    [selected?.id, selected?.goldTranscript],
  )

  const goldLooksShort = selected !== null && goldLooksShortFor(gold, selected.durationSeconds)

  const dirty =
    selected !== null &&
    (gold !== (selected.goldTranscript ?? "") ||
      JSON.stringify(entities) !== JSON.stringify(selected.entityReferences ?? []))

  // B-14: sidebar clicks unmount this page without running goTo/queue-click
  // guards -- register a navigation guard while dirty so the shell consults
  // us before wouter navigates away.
  React.useEffect(() => {
    setNavGuard(
      dirty
        ? () => window.confirm("Discard unsaved gold edits on this call?")
        : null,
    )
    return () => setNavGuard(null)
  }, [dirty])

  const goTo = (offset: number) => {
    const next = queue[index + offset]
    if (!next) return
    // Unsaved gold edits are real work (found in UX review 2026-08-25:
    // j/k, Prev/Next and queue clicks all discarded them silently). One
    // guard here covers every navigation path that uses goTo.
    if (dirty && !window.confirm("Discard unsaved gold edits on this call?")) return
    setSelectedId(next.id)
  }

  const save = React.useCallback(() => {
    if (!selected) return
    // ⌘Enter used to fire with nothing changed or while a save was already
    // in flight -> overlapping PATCHes (bug-register B-28).
    if (!dirty || updateCall.isPending) return
    updateCall.mutate(
      {
        callId: selected.id,
        data: {
          goldTranscript: gold,
          entityReferences: entities,
          // A call with a human reference is no longer awaiting one. De-id is
          // a separate gate and is not touched here. B-28: only ADVANCE from
          // the two "awaiting gold" states -- blindly sending gold_in_review
          // used to demote ready_to_run/archived calls out of Runs.
          status:
            gold.trim() &&
            (selected.status === "needs_review" || selected.status === "ready_for_gold")
              ? "gold_in_review"
              : undefined,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListBenchmarkCallsQueryKey() })
          // B-32: Overview counts derive from this payload too -- without
          // invalidating it, the dashboard kept showing "Queue a run" with
          // pre-save numbers inside its 30s staleTime window.
          queryClient.invalidateQueries({ queryKey: getGetBenchmarkDashboardQueryKey() })
          toast({ title: "Saved", description: `${selected.label} updated.` })
        },
        onError: () =>
          toast({ title: "Save failed", description: "Nothing was written.", variant: "destructive" }),
      },
    )
  }, [selected, gold, entities, dirty, updateCall, queryClient, toast])

  const captureSelection = () => {
    const el = goldRef.current
    if (!el) return
    const text = el.value.slice(el.selectionStart, el.selectionEnd).trim()
    setSelectionText(text)
  }

  const tagSelection = (type: EntityType) => {
    if (!selectionText) return
    if (entities.some((e) => e.type === type && e.value === selectionText)) return
    setEntities((prev) => [...prev, { type, value: selectionText }])
    setSelectionText("")
  }

  const attest = () => {
    if (!selected) return
    const approver = window.prompt("Attest de-identification as (name or email):")?.trim()
    if (!approver) return
    attestDeid.mutate(
      { callId: selected.id, data: { approverLabel: approver } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListBenchmarkCallsQueryKey() })
          toast({ title: "Attestation recorded", description: approver })
        },
        onError: (err) =>
          toast({
            title: "Attestation rejected",
            // B-50: network failures, short names and real 409s all looked
            // like "two distinct approvers required" -- surface the server's
            // actual reason.
            description: err instanceof Error ? err.message : "Two distinct approvers are required.",
            variant: "destructive",
          }),
      },
    )
  }

  // Keyboard: save without reaching for the mouse, move through the queue.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault()
        save()
      }
      // B-51: Ctrl+J / Alt+Space are browser/app shortcuts -- don't hijack
      // them for queue navigation or playback.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)
      if (typing) return
      // UX review 2026-08-25: Space on a focused button/queue item used to
      // BOTH activate that control and toggle audio; native audio controls
      // double-fired too. Interactive elements own their keys.
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

  // UX review: switching calls (or closing the tab) with unsaved gold edits
  // must warn, not silently discard. Covers queue clicks + tab close; j/k
  // and Prev/Next are covered inside goTo.
  React.useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [dirty])

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
    // B-13: an error during a background refetch used to throw away the
    // cached queue and swap the whole editor for an error panel — with
    // unsaved edits still in local state. Only take over when there is no
    // cached data to keep working with.
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

  const progress = progressOf(selected)

  return (
    <div className="flex h-screen w-full overflow-hidden">
      {/* queue -------------------------------------------------------- */}
      <div className="flex w-[252px] shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="border-b border-border px-4 pb-3.5 pt-4">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-sm font-semibold">Review queue</span>
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
            const p = progressOf(call)
            const active = call.id === selected.id
            return (
              <button
                key={call.id}
                onClick={() => {
                  if (call.id === selected.id) return
                  if (dirty && !window.confirm("Discard unsaved gold edits on this call?")) return
                  setSelectedId(call.id)
                }}
                className={cn(
                  "mb-0.5 w-full rounded-lg px-2.5 py-2.5 text-left transition-colors",
                  active
                    ? "border-l-2 border-primary bg-secondary"
                    : "border-l-2 border-transparent hover:bg-secondary/50",
                )}
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "truncate font-mono text-xs",
                      active ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {call.label}
                  </span>
                  {p.done ? (
                    <Check className="h-3 w-3 shrink-0 text-success" strokeWidth={2.6} />
                  ) : (
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                      {formatDuration(call.durationSeconds)}
                    </span>
                  )}
                </div>
                <ProgressPips progress={p} />
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
              {selected.sourceTranscriberProvider && (
                <MonoLabel className="text-muted-foreground">
                  Draft via {selected.sourceTranscriberProvider}
                  {selected.sourceTranscriberModel ? ` ${selected.sourceTranscriberModel}` : ""}
                </MonoLabel>
              )}
              {dirty ? (
                <MonoLabel className="text-muted-foreground/60">
                  Save to see draft WER
                </MonoLabel>
              ) : (
                wer !== null && (
                  <MonoLabel className="text-muted-foreground">
                    Draft WER {(wer * 100).toFixed(1)}%
                  </MonoLabel>
                )
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
            <button
              onClick={save}
              disabled={!dirty || updateCall.isPending}
              className="ml-1 flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-primary-foreground transition-opacity disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" strokeWidth={2.6} />
              <span className="text-xs font-semibold">
                {updateCall.isPending ? "Saving…" : dirty ? "Save" : "Saved"}
              </span>
            </button>
          </div>
        </div>

        {goldLooksShort && (
          <div className="flex shrink-0 items-center gap-2 border-b border-warning/25 bg-warning/10 px-5 py-2">
            <MonoLabel className="text-warning">
              ⚠ Gold looks short for a {formatDuration(selected.durationSeconds)} call ({gold.trim().split(/\s+/).filter(Boolean).length} words) — check nothing got cut off before saving.
            </MonoLabel>
          </div>
        )}

        {/* column headers */}
        <div className="flex h-[30px] shrink-0 items-center border-b border-border bg-muted/40 px-5">
          <div className="flex-1 pr-3.5">
            <MonoLabel className="text-muted-foreground">Provider draft · read only</MonoLabel>
          </div>
          <div className="flex-1 pl-3.5">
            <MonoLabel className="text-primary">Gold transcript · editable</MonoLabel>
          </div>
        </div>

        {/* two columns */}
        <div className="flex min-h-0 flex-1">
          <div className="flex-1 overflow-y-auto border-r border-border px-5 py-4">
            {draftTurns.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No provider draft for this call — the gold transcript starts from the audio.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {draftTurns.map((turn, i) => (
                  <div key={i} className="flex gap-3">
                    {turn.speaker && (
                      <MonoLabel className="w-12 shrink-0 pt-1 text-muted-foreground">
                        {turn.speaker}
                      </MonoLabel>
                    )}
                    <p className="font-serif text-[15px] leading-[1.62] text-muted-foreground rounded-md bg-muted/30 p-3 m-3">
                      {turn.text}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-1 flex-col">
            <textarea
              ref={goldRef}
              value={gold}
              onChange={(e) => {
                // UX review: a stale selection made BEFORE an edit used to
                // survive into entity tagging, inserting text the operator
                // had already fixed. Edits invalidate the selection.
                setSelectionText("")
                setGold(e.target.value)
              }}
              onSelect={captureSelection}
              onKeyUp={captureSelection}
              spellCheck={false}
              placeholder="Correct the draft here. This is what every provider gets scored against."
              className="flex-1 resize-none bg-transparent px-5 py-4 font-serif text-[15px] leading-[1.62] text-foreground outline-none placeholder:text-muted-foreground/70"
            />
            {selectionText && (
              <div className="border-t border-border bg-muted/50 px-5 py-3">
                <div className="mb-2 flex items-center gap-2">
                  <Tag className="h-3.5 w-3.5 text-primary" />
                  <MonoLabel className="text-muted-foreground">
                    Tag “{selectionText.length > 40 ? `${selectionText.slice(0, 40)}…` : selectionText}” as
                  </MonoLabel>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {ENTITY_TYPES.map((e) => (
                    <button
                      key={e.type}
                      onClick={() => tagSelection(e.type)}
                      className="rounded-md border px-2 py-1 transition-colors"
                      style={{
                        borderColor: entityColor(e.type),
                        color: entityColor(e.type),
                      }}
                    >
                      <MonoLabel>{e.label}</MonoLabel>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
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
                // Not the stored URL directly -- Vapi's recording links are
                // short-lived signed URLs that expire within hours, long
                // before most calls get reviewed. This route re-asks Vapi
                // for a fresh one on every load and redirects here.
                // Built from the configured API base (B-30): a hardcoded
                // same-origin /api broke playback under split hosting.
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
            <MonoLabel className="text-muted-foreground">
              <span className="text-foreground">
                <CornerDownLeft className="inline h-3 w-3" /> ⌘
              </span>{" "}
              save
            </MonoLabel>
          </div>
        </div>
      </div>

      {/* right panel -------------------------------------------------- */}
      <div className="flex w-[300px] shrink-0 flex-col border-l border-border bg-sidebar">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3">
          {(["entities", "deid", "notes"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setPanelTab(tab)}
              className={cn(
                "rounded-md px-2.5 py-1.5 transition-colors",
                panelTab === tab ? "bg-secondary" : "hover:bg-secondary/50",
              )}
            >
              <MonoLabel className={panelTab === tab ? "text-primary" : "text-muted-foreground"}>
                {tab === "entities" ? `Entities ${entities.length}` : tab === "deid" ? "De-ID" : "Notes"}
              </MonoLabel>
            </button>
          ))}
        </div>

        {panelTab === "entities" && (
          <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
            {entities.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-3 text-xs leading-relaxed text-muted-foreground">
                Select text in the gold column, then pick a type. These are what providers get
                scored on — they matter more than raw word accuracy.
              </p>
            ) : (
              entities.map((entity, i) => (
                <div
                  key={`${entity.type}-${entity.value}-${i}`}
                  className="flex flex-col gap-1.5 rounded-lg border border-card-border bg-card p-2.5"
                >
                  <div className="flex items-center justify-between">
                    <MonoLabel style={{ color: entityColor(entity.type) }}>
                      {entityLabel(entity.type)}
                    </MonoLabel>
                    <button
                      onClick={() => setEntities((prev) => prev.filter((_, j) => j !== i))}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  <span className="break-all font-mono text-[13px]">{entity.value}</span>
                </div>
              ))
            )}
          </div>
        )}

        {panelTab === "deid" && (
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
              onClick={attest}
              disabled={progress.deIdComplete || attestDeid.isPending}
              className="flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 transition-colors hover:bg-secondary disabled:opacity-40"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <MonoLabel>{progress.deIdComplete ? "Attested" : "Attest de-identification"}</MonoLabel>
            </button>

            {!progress.deIdComplete && (
              <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-2.5">
                <MonoLabel className="leading-relaxed text-destructive">
                  Blocked from runs until two different people sign off.
                </MonoLabel>
              </div>
            )}
          </div>
        )}

        {panelTab === "notes" && (
          <div className="flex flex-1 flex-col gap-3 p-3">
            <MonoLabel className="text-muted-foreground">Hard cases</MonoLabel>
            <div className="flex flex-wrap gap-1.5">
              {selected.hardCases.length === 0 ? (
                <span className="text-xs text-muted-foreground">None tagged.</span>
              ) : (
                selected.hardCases.map((hc) => (
                  <span
                    key={hc}
                    className="rounded-md border border-primary/30 bg-primary/10 px-2 py-1"
                  >
                    <MonoLabel className="text-primary">{hc}</MonoLabel>
                  </span>
                ))
              )}
            </div>

            <MonoLabel className="pt-2 text-muted-foreground">Curator notes</MonoLabel>
            <p className="min-h-[80px] rounded-lg border border-card-border bg-card p-2.5 font-serif text-sm leading-relaxed text-muted-foreground">
              {selected.entityNotes ?? "No notes on this call."}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
