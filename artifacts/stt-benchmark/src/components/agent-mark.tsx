import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useCreateAgentMark,
  useListAgentMarks,
  useUpdateAgentMark,
  getListAgentMarksQueryKey,
  type AgentMark,
  type AgentMarkCreateActionType,
} from "@workspace/api-client-react"
import { Flag, X } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"

// ---------------------------------------------------------------------------
// U-1b (Part U): marking, where the problem is visible.
//
// Two capture points, one record. On the per-call comparison a mark is made
// against a disputed span; on the Results assistant card it is made against
// the assistant itself. Both write the same row (POST /benchmark/agent-marks).
//
// The note is required and the action is optional, in that order, on purpose:
// the categories worth having come from reading a pile of marks, not from
// making someone pick one before they have written the sentence.
//
// Nothing here reaches Vapi. A mark is a proposal; U-2 shows what the open
// marks would change and U-3 is the only thing that ever writes.
// ---------------------------------------------------------------------------

/** The action list in the words a person would use. The wire values are the
 *  contract's (`keyterm` / `numerals` / `prompt`); none of them belong on
 *  screen -- "keyterm" is Deepgram's word for it, not anybody else's. */
/** The contract's enum also admits `null` (a mark with no action); the
 *  <select> models that as the empty string, so null is excluded here. */
type MarkAction = NonNullable<AgentMarkCreateActionType>

const ACTIONS: Array<{ value: "" | MarkAction; label: string; valueLabel: string | null; placeholder: string }> = [
  { value: "", label: "Just a note for now", valueLabel: null, placeholder: "" },
  {
    value: "keyterm",
    label: "Teach the agent this word",
    valueLabel: "The word or name, spelled the way it should come out",
    placeholder: "Edison Hills",
  },
  { value: "numerals", label: "Write numbers as digits, not words", valueLabel: null, placeholder: "" },
  {
    value: "prompt",
    label: "Change the agent's instructions",
    valueLabel: "What the instructions should say",
    placeholder: "Read the unit number back before confirming",
  },
]

/** The list filter's sentinel for "this mark has no agent" -- the same shape
 *  the Calls page uses for "no org". Kept next to its only two callers. */
const UNASSIGNED = "__unassigned__"

function actionLabel(actionType: string | null): string | null {
  if (!actionType) return null
  return ACTIONS.find((a) => a.value === actionType)?.label ?? actionType
}

function invalidateMarks(qc: ReturnType<typeof useQueryClient>): void {
  // Every list of marks, whatever it was filtered by -- a new mark can land
  // in the unassigned bucket, this assistant's, or a call's, and the panel
  // that has to notice is not always the one that made it.
  void qc.invalidateQueries({ queryKey: getListAgentMarksQueryKey() })
}

export function MarkButton({
  assistantId,
  callId,
  span,
  label = "Mark",
}: {
  assistantId?: string | null
  callId?: string | null
  /** The disputed span this mark is about, when there is one. */
  span?: string | null
  label?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [note, setNote] = React.useState("")
  const [actionType, setActionType] = React.useState<"" | MarkAction>("")
  const [actionValue, setActionValue] = React.useState("")
  const { toast } = useToast()
  const qc = useQueryClient()
  const create = useCreateAgentMark()

  const action = ACTIONS.find((a) => a.value === actionType) ?? ACTIONS[0]
  const needsValue = action.valueLabel !== null
  const canSave = note.trim().length > 0 && (!needsValue || actionValue.trim().length > 0)

  const close = () => {
    setOpen(false)
    setNote("")
    setActionType("")
    setActionValue("")
  }

  const save = () => {
    create.mutate(
      {
        data: {
          // assistantId is sent only when this control knows it. From a
          // comparison it does not, and the server fills it in from the call
          // -- the one place that can be sure which agent a call belongs to.
          ...(assistantId ? { assistantId } : {}),
          ...(callId ? { callId } : {}),
          ...(span ? { span } : {}),
          note: note.trim(),
          ...(actionType ? { actionType } : {}),
          ...(needsValue ? { actionValue: actionValue.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          invalidateMarks(qc)
          toast({ title: "Marked", description: "Saved to this agent's list. Nothing has been changed in Vapi." })
          close()
        },
        onError: (e) =>
          toast({
            variant: "destructive",
            title: "Couldn't save the mark",
            description: e instanceof Error ? e.message : "unknown error",
          }),
      },
    )
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        data-testid="mark-open"
      >
        <Flag className="h-3 w-3" /> {label}
      </button>
    )
  }

  return (
    <div className="mt-1.5 w-full basis-full space-y-2 rounded-md border border-border bg-muted/20 p-2.5" data-testid="mark-form">
      {span && (
        <p className="text-[11px] text-muted-foreground">
          About <span className="font-mono font-semibold text-foreground">“{span}”</span>
        </p>
      )}
      <Textarea
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What should change on this agent? e.g. it keeps hearing “Edison” as “Addison”"
        className="min-h-[52px] text-xs"
        aria-label="What should change on this agent?"
        data-testid="mark-note"
      />
      <label className="block text-[11px] text-muted-foreground">
        Turn this into a change (optional)
        <select
          value={actionType}
          onChange={(e) => {
            setActionType(e.target.value as "" | MarkAction)
            setActionValue("")
          }}
          className="mt-1 block w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs text-foreground"
          data-testid="mark-action"
        >
          {ACTIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      {action.valueLabel && (
        <label className="block text-[11px] text-muted-foreground">
          {action.valueLabel}
          <Input
            value={actionValue}
            onChange={(e) => setActionValue(e.target.value)}
            placeholder={action.placeholder}
            className="mt-1 h-7 text-xs"
            data-testid="mark-action-value"
          />
        </label>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!canSave || create.isPending}
          className="rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
          data-testid="mark-save"
        >
          {create.isPending ? "Saving…" : "Save mark"}
        </button>
        <button type="button" onClick={close} className="text-[11px] text-muted-foreground hover:text-foreground">
          Cancel
        </button>
        <span className="ml-auto text-[10px] text-muted-foreground">Nothing is sent to Vapi.</span>
      </div>
    </div>
  )
}

/** The per-assistant list: what has been marked, and how much of it is of
 *  each kind. The counts are the point -- "which of these comes up most" is
 *  the question a pile of notes exists to answer. */
export function AgentMarksPanel({ assistantId }: { assistantId: string | null }) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const params = { assistantId: assistantId ?? UNASSIGNED, status: "open" as const }
  const q = useListAgentMarks(params, { query: { queryKey: getListAgentMarksQueryKey(params) } })
  const update = useUpdateAgentMark()

  const marks: AgentMark[] = q.data ?? []
  if (marks.length === 0) return null

  const counts = new Map<string, number>()
  for (const m of marks) {
    const key = actionLabel(m.actionType) ?? "Notes with no action yet"
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const dismiss = (id: string) =>
    update.mutate(
      { markId: id, data: { status: "dismissed" } },
      {
        onSuccess: () => invalidateMarks(qc),
        onError: (e) =>
          toast({
            variant: "destructive",
            title: "Couldn't dismiss the mark",
            description: e instanceof Error ? e.message : "unknown error",
          }),
      },
    )

  return (
    <div data-testid="agent-marks-panel">
      <p className="text-xs font-medium text-foreground">
        Marked for this agent: {marks.length}
        <span className="font-normal text-muted-foreground">
          {" "}
          ({[...counts.entries()].map(([k, n]) => `${n} × ${k.toLowerCase()}`).join(", ")})
        </span>
      </p>
      <ul className="mt-1 space-y-1">
        {marks.map((m) => (
          <li key={m.id} className="flex items-start gap-1.5 text-[11px]">
            <span className="shrink-0 text-muted-foreground">·</span>
            <span className="min-w-0">
              {m.span && <span className="font-mono font-semibold text-foreground">“{m.span}” </span>}
              <span className="text-foreground">{m.note}</span>
              {m.actionType && (
                <span className="text-muted-foreground">
                  {" "}
                  — {actionLabel(m.actionType)?.toLowerCase()}
                  {m.actionValue ? `: ${m.actionValue}` : ""}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => dismiss(m.id)}
              title="Dismiss -- keeps the note, drops it from the list"
              aria-label={`Dismiss mark: ${m.note}`}
              className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[10px] text-muted-foreground">
        A list, not a change -- nothing here has been sent to Vapi.
      </p>
    </div>
  )
}

/** The Results card's own strip: mark this agent, and read what is already
 *  marked. Renders whether or not the agent has a production baseline or a
 *  live Vapi config -- there is always something to write down. */
export function AgentMarksSection({ assistantId }: { assistantId: string | null }) {
  return (
    <div className="border-t border-border px-4 py-3" data-testid="agent-marks-section">
      <div className="flex flex-wrap items-start gap-2">
        <p className="text-xs font-medium text-foreground">To do on this agent</p>
        <MarkButton assistantId={assistantId} label="Mark something" />
      </div>
      <AgentMarksPanel assistantId={assistantId} />
    </div>
  )
}
