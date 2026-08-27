import * as React from "react"
import { Link } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListBenchmarkCalls,
  useCreateBenchmarkCall,
  useUpdateBenchmarkCall,
  useAttestBenchmarkCallDeid,
  getListBenchmarkCallsQueryKey,
  CallStatus,
  Vertical,
} from "@workspace/api-client-react"
import { Plus, Search, AlertCircle, ExternalLink, Settings2, ShieldCheck, AudioLines, TimerReset } from "lucide-react"
import { differenceInCalendarDays } from "date-fns"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"

export default function Corpus() {
  const { data: calls, isLoading, isError, error } = useListBenchmarkCalls()
  const [search, setSearch] = React.useState("")
  // UX review 2026-08-25: label/id substring search alone couldn't answer
  // "show me the needs_review trucking calls" on a 1000-row corpus.
  const [statusFilter, setStatusFilter] = React.useState("all")
  const [verticalFilter, setVerticalFilter] = React.useState("all")

  const filteredCalls = React.useMemo(() => {
    if (!calls) return []
    const q = search.toLowerCase()
    return calls.filter(c =>
      (c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) &&
      (statusFilter === "all" || c.status === statusFilter) &&
      (verticalFilter === "all" || c.vertical === verticalFilter)
    )
  }, [calls, search, statusFilter, verticalFilter])

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Corpus</h1>
          <p className="text-muted-foreground mt-1">De-identified audio and their gold-transcript status. Correcting a transcript happens in Review.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative w-56">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search calls..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger aria-label="Filter by status" className="h-9 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="needs_review">Needs review</SelectItem>
              <SelectItem value="ready_to_run">Ready to run</SelectItem>
            </SelectContent>
          </Select>
          <Select value={verticalFilter} onValueChange={setVerticalFilter}>
            <SelectTrigger aria-label="Filter by vertical" className="h-9 w-48 capitalize"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All verticals</SelectItem>
              <SelectItem value="rush">Rush</SelectItem>
              <SelectItem value="property_management">Property management</SelectItem>
              <SelectItem value="trucking">Trucking</SelectItem>
            </SelectContent>
          </Select>
          <span className="font-mono text-xs text-muted-foreground whitespace-nowrap">
            {filteredCalls.length}{calls ? ` / ${calls.length}` : ""}
          </span>
          <CreateCallDialog />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Call ID / Label</TableHead>
                <TableHead>Vertical</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>De-ID</TableHead>
                <TableHead>Hard Cases</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isError ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-destructive text-sm">
                    Failed to load corpus: {error instanceof Error ? error.message : String(error)}
                  </TableCell>
                </TableRow>
              ) : isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">Loading corpus data...</TableCell>
                </TableRow>
              ) : filteredCalls.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">No calls found.</TableCell>
                </TableRow>
              ) : (
                filteredCalls.map(call => (
                  <TableRow key={call.id}>
                    <TableCell>
                      <div className="font-medium text-foreground">{call.label}</div>
                      <div className="text-xs font-mono text-muted-foreground">{call.id.substring(0, 8)}...</div>
                    </TableCell>
                    <TableCell>
                      <span className="capitalize text-xs font-mono px-2 py-0.5 rounded-md border border-border bg-secondary text-secondary-foreground">
                        {call.vertical.replace('_', ' ')}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-sm tabular-nums">{Math.floor(call.durationSeconds / 60)}:{(call.durationSeconds % 60).toString().padStart(2, '0')}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={call.status} />
                        <RetentionWarning sourceStartedAt={call.sourceStartedAt} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <DeidBadge call={call} />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 flex-wrap">
                        {call.hardCases.map((hc, i) => (
                          <span key={i} className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border border-border bg-muted text-muted-foreground">
                            {hc}
                          </span>
                        ))}
                        {call.hardCases.length === 0 && <span className="text-muted-foreground text-xs">—</span>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <Link href={`/review?call=${call.id}`}>
                          <Button variant="outline" size="sm">
                            <AudioLines className="w-3.5 h-3.5 mr-1.5" /> Review
                          </Button>
                        </Link>
                        <CallDetailsDialog call={call} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

// Status carries meaning through the same three semantic tokens Review's
// progress pips use: not-started stays neutral, in-progress is the accent,
// done is success. No raw Tailwind palette colors here -- that's what let
// green-500/amber-500/purple-500 leak in and clash with the rest of the app.
function StatusBadge({ status }: { status: CallStatus }) {
  const styles: Record<CallStatus, string> = {
    needs_review: "bg-secondary text-muted-foreground border-border",
    ready_for_gold: "bg-secondary text-muted-foreground border-border",
    gold_in_review: "bg-primary/10 text-primary border-primary/25",
    ready_to_run: "bg-success/10 text-success border-success/25",
    archived: "bg-secondary text-muted-foreground/60 border-border",
  }

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wider border ${styles[status]}`}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

// ux-fixes UX-9: Vapi's plan only retains a call's recording for 14 days --
// past that, no provider can ever get a fresh copy of the audio again (see
// docs/PRD-technical-fixes.md FIX-2). Once a run has successfully cached a
// call's bytes, that call is no longer actually at risk -- but this page
// doesn't know per-call cache state, so this warns from age alone. That
// means a cached call can still show a stale warning after day 14 --
// conservative false positive, not a false "all clear," which is the
// direction that's safe to be wrong in for a review-effort warning.
const RETENTION_WINDOW_DAYS = 14
const RETENTION_WARNING_DAYS = 10

function RetentionWarning({ sourceStartedAt }: { sourceStartedAt?: string | null }) {
  if (!sourceStartedAt) return null
  const age = differenceInCalendarDays(new Date(), new Date(sourceStartedAt))
  if (age >= RETENTION_WINDOW_DAYS) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-destructive/25 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-mono uppercase text-destructive"
        title={`This call's recording is ${age} days old -- past Vapi's 14-day retention window. If it hasn't already been successfully run, its audio may be permanently unfetchable now.`}
      >
        <TimerReset className="h-2.5 w-2.5" /> expired?
      </span>
    )
  }
  if (age >= RETENTION_WARNING_DAYS) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-warning/25 bg-warning/10 px-1.5 py-0.5 text-[10px] font-mono uppercase text-warning"
        title={`This call's recording is ${age} days old. Vapi stops serving it after day 14 -- review and run it soon if it hasn't been run yet.`}
      >
        <TimerReset className="h-2.5 w-2.5" /> {RETENTION_WINDOW_DAYS - age}d left
      </span>
    )
  }
  return null
}

function DeidBadge({ call }: { call: { deIdAttestedByLabel?: string | null; deIdSecondApproverLabel?: string | null } }) {
  const complete = Boolean(call.deIdAttestedByLabel && call.deIdSecondApproverLabel)
  const started = Boolean(call.deIdAttestedByLabel)
  if (complete) {
    return <span className="text-xs font-mono text-success">2 / 2</span>
  }
  if (started) {
    return <span className="text-xs font-mono text-warning">1 / 2</span>
  }
  return <span className="text-xs font-mono text-muted-foreground">0 / 2</span>
}

function CreateCallDialog() {
  const [open, setOpen] = React.useState(false)
  const [label, setLabel] = React.useState("")
  const [vertical, setVertical] = React.useState<Vertical>("rush")
  const [duration, setDuration] = React.useState("120")

  const queryClient = useQueryClient()
  const { toast } = useToast()
  const createCall = useCreateBenchmarkCall()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    createCall.mutate({
      data: {
        label,
        vertical,
        durationSeconds: (() => {
          // B-54: parseInt("1e3") === 1 — a "1000"-second call stored as 1s,
          // corrupting every duration-based cost estimate. Number() rejects
          // the partial parse.
          const parsed = Number(duration)
          return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
        })(),
        hardCases: []
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBenchmarkCallsQueryKey() })
        setOpen(false)
        setLabel("")
        toast({ title: "Call added", description: "Successfully added to corpus." })
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to add call.", variant: "destructive" })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="w-4 h-4 mr-2" /> Add Call</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register Benchmark Call</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Label / Identifier</label>
            <Input value={label} onChange={e => setLabel(e.target.value)} required minLength={2} placeholder="e.g. Call-1029-A" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Vertical</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={vertical}
                onChange={(e) => setVertical(e.target.value as Vertical)}
              >
                <option value="rush">Rush</option>
                <option value="property_management">Property Management</option>
                <option value="trucking">Trucking</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Duration (sec)</label>
              <Input type="number" value={duration} onChange={e => setDuration(e.target.value)} required min={1} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={createCall.isPending}>
              {createCall.isPending ? 'Saving...' : 'Add Call'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// Everything content-related (gold transcript, entity tags) lives in Review
// now -- this dialog is deliberately narrow: a manual status override for
// edge cases (e.g. archiving a bad recording) plus de-id attestation, which
// stays available here too since bulk attestation from this table doesn't
// exist yet and forcing every single-call approval through Review would be
// a detour for a curator just clearing a backlog of easy ones.
function CallDetailsDialog({ call }: { call: any }) {
  const [open, setOpen] = React.useState(false)
  const [status, setStatus] = React.useState<CallStatus>(call.status)
  // B-53: the dialog is mounted per row, but `call` is a fresh object after
  // every refetch — a dialog reopened mid-refetch used to edit against the
  // STALE saved status, so Save silently reverted what had just been saved.
  // Re-sync local state from the latest props each time the dialog opens.
  React.useEffect(() => {
    if (open) setStatus(call.status)
  }, [open, call.status])

  const queryClient = useQueryClient()
  const { toast } = useToast()
  const updateCall = useUpdateBenchmarkCall()

  const deidComplete = Boolean(call.deIdAttestedByLabel && call.deIdSecondApproverLabel)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    updateCall.mutate({
      callId: call.id,
      data: { status },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBenchmarkCallsQueryKey() })
        setOpen(false)
        toast({ title: "Call updated" })
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err?.message ?? "Failed to update call.", variant: "destructive" })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setStatus(call.status) }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm"><Settings2 className="w-4 h-4" /></Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{call.label}</DialogTitle>
        </DialogHeader>

        <DeidAttestationPanel call={call} />

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Status</label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono uppercase text-xs"
              value={status}
              onChange={(e) => setStatus(e.target.value as CallStatus)}
            >
              <option value="needs_review">Needs Review</option>
              <option value="ready_for_gold">Ready for Gold</option>
              <option value="gold_in_review">Gold in Review</option>
              <option value="ready_to_run">Ready to Run</option>
              <option value="archived">Archived</option>
            </select>
            {status === 'ready_to_run' && !deidComplete && (
              <p className="text-xs text-warning flex items-center gap-1"><AlertCircle className="w-3 h-3" /> Needs two distinct de-id approvals first (above).</p>
            )}
            {status === 'ready_to_run' && deidComplete && !call.goldTranscript?.trim() && (
              <p className="text-xs text-warning flex items-center gap-1"><AlertCircle className="w-3 h-3" /> Also needs a gold transcript (edit in Review) before it can run.</p>
            )}
          </div>
          <Link href={`/review?call=${call.id}`} className="flex items-center gap-1.5 text-xs text-primary hover:underline">
            <ExternalLink className="w-3 h-3" /> Edit gold transcript &amp; entities in Review
          </Link>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            {/* UX review 2026-08-25: this combination is a guaranteed 409 --
                disable up front instead of letting the operator burn the
                action and read an error toast. */}
            <Button
              type="submit"
              disabled={updateCall.isPending || (status === 'ready_to_run' && (!deidComplete || !call.goldTranscript?.trim()))}
            >
              {updateCall.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// FR-C3 two-person de-id gate. Same approver cannot provide both
// attestations (enforced server-side too, HTTP 409).
function DeidAttestationPanel({ call }: { call: any }) {
  const [approver, setApprover] = React.useState("")
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const attest = useAttestBenchmarkCallDeid()

  const attested1 = Boolean(call.deIdAttestedByLabel)
  const attested2 = Boolean(call.deIdSecondApproverLabel)

  const submit = () => {
    if (!approver.trim()) return
    attest.mutate({ callId: call.id, data: { approverLabel: approver.trim() } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBenchmarkCallsQueryKey() })
        setApprover("")
        toast({ title: "Attestation recorded" })
      },
      onError: (err: any) => {
        toast({ title: "Cannot record attestation", description: err?.message ?? "Same approver cannot attest twice.", variant: "destructive" })
      }
    })
  }

  return (
    <div className="border border-border rounded-lg p-3 bg-muted/30 space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <ShieldCheck className="w-3.5 h-3.5" /> De-identification approvals (two required)
      </div>
      <div className="flex flex-col gap-1 text-xs font-mono">
        <span className={attested1 ? "text-success" : "text-muted-foreground"}>
          1st: {attested1 ? call.deIdAttestedByLabel : "not yet approved"}
        </span>
        <span className={attested2 ? "text-success" : "text-muted-foreground"}>
          2nd: {attested2 ? call.deIdSecondApproverLabel : "not yet approved"}
        </span>
      </div>
      {!attested2 && (
        <div className="flex gap-2 pt-1">
          <Input
            value={approver}
            onChange={e => setApprover(e.target.value)}
            placeholder="your name or email"
            className="h-8 text-xs"
          />
          <Button type="button" size="sm" className="h-8" disabled={attest.isPending || !approver.trim()} onClick={submit}>
            Attest
          </Button>
        </div>
      )}
    </div>
  )
}
