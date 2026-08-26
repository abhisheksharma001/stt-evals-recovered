import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListBenchmarkCalls,
  useListAgentScans,
  useCreateAgentScan,
  useApproveAgentScan,
  useRejectAgentScan,
  getListAgentScansQueryKey,
  getListBenchmarkCallsQueryKey,
  type AgentScan,
} from "@workspace/api-client-react"
import { Bot, ChevronDown, ChevronRight, Check, X, Sparkles } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { diffWords, normalizeTranscript } from "@workspace/scoring"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { WordDiffView } from "@/pages/Runs"

// A call is scannable once it has *some* transcript to read (draft counts --
// a call still mid-review is exactly when catching a likely mis-transcription
// early is most useful, not just after it's already gold).
function useScannableCalls() {
  const { data: calls } = useListBenchmarkCalls()
  return React.useMemo(
    () => (calls ?? []).filter((c) => c.goldTranscript?.trim() || c.draftTranscript?.trim()),
    [calls],
  )
}

function TriggerScanCard() {
  const scannableCalls = useScannableCalls()
  const [callId, setCallId] = React.useState<string>("")
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const createScan = useCreateAgentScan()
  // UX review 2026-08-25: the scan POST is synchronous and can run minutes;
  // a bare "Scanning..." label read as a hang. A live elapsed counter makes
  // progress visible without server-side job plumbing.
  const [scanStartedAt, setScanStartedAt] = React.useState<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0)
  // B-36: pending state lives in this component, so navigating away and back
  // re-enabled Scan while the first scan still ran server-side -> duplicate
  // billed re-transcription. Derive in-flight from the (polled) scans list;
  // the server's decided-scan 409s remain the backstop.
  const { data: scansForInFlight } = useListAgentScans()
  const scanInFlight =
    !!callId && (scansForInFlight?.some((s) => s.status === "scanning" && s.callId === callId) ?? false)
  React.useEffect(() => {
    if (scanStartedAt === null) return
    const t = setInterval(() => setElapsedSeconds(Math.round((Date.now() - scanStartedAt) / 1000)), 1000)
    return () => clearInterval(t)
  }, [scanStartedAt])

  const handleScan = () => {
    if (!callId) return
    setScanStartedAt(Date.now())
    setElapsedSeconds(0)
    createScan.mutate(
      { data: { callId } },
      {
        onSuccess: (scan) => {
          setScanStartedAt(null)
          queryClient.invalidateQueries({ queryKey: getListAgentScansQueryKey() })
          if (scan.status === "clean") {
            toast({ title: "Clean", description: "The agent found nothing worth flagging in this transcript." })
          } else if (scan.status === "flagged") {
            toast({ title: "Flagged", description: `${scan.flags.length} span(s) flagged -- review the pick below.` })
          } else {
            toast({ title: "Scan error", description: scan.errorMessage ?? "The scan could not complete.", variant: "destructive" })
          }
        },
        onError: () => {
          setScanStartedAt(null)
          toast({ title: "Error", description: "Failed to start the scan.", variant: "destructive" })
        },
      },
    )
  }

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Bot className="h-4.5 w-4.5 text-primary" />
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <div className="font-semibold text-sm">Scan a call</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Reads the call's current transcript for spans that sound wrong, then -- if it
                finds any -- re-transcribes the call across every other configured provider and
                picks whichever reads most sensibly. On-demand only: nothing runs until you pick
                a call and scan it. This can take a minute or two when it finds something to
                re-transcribe.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={callId} onValueChange={setCallId} disabled={createScan.isPending}>
                <SelectTrigger className="w-full max-w-[420px]">
                  <SelectValue placeholder={scannableCalls.length === 0 ? "No calls with transcripts yet -- import first" : "Select a call to scan..."} />
                </SelectTrigger>
                <SelectContent>
                  {scannableCalls.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label} -- {c.vertical} -- {c.goldTranscript?.trim() ? "gold" : "draft only"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={handleScan} disabled={!callId || createScan.isPending || scanInFlight}>
                <Sparkles className={`w-3.5 h-3.5 mr-1.5 ${createScan.isPending ? "animate-pulse" : ""}`} />
                {createScan.isPending || scanInFlight ? `Scanning… ${elapsedSeconds}s` : "Scan"}
              </Button>
            </div>
            {createScan.isPending && (
              <p className="text-xs text-muted-foreground">
                Re-transcribing across providers -- this can take a minute or two. Keep this tab
                open; the result appears here when done.
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    scanning: "bg-muted text-muted-foreground border-border",
    clean: "bg-success/10 text-success border-success/25",
    flagged: "bg-warning/10 text-warning border-warning/25",
    error: "bg-destructive/10 text-destructive border-destructive/25",
    approved: "bg-success/10 text-success border-success/25",
    rejected: "bg-muted text-muted-foreground border-border",
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold font-mono uppercase tracking-widest border ${styles[status] ?? styles.scanning}`}>
      {status}
    </span>
  )
}

function ScanRow({ scan, callLabel }: { scan: AgentScan; callLabel: string }) {
  const [expanded, setExpanded] = React.useState(false)
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const approve = useApproveAgentScan()
  const reject = useRejectAgentScan()

  const canDecide = scan.status === "flagged" && !!scan.agentPickProviderId
  // B-58: a crashed scan stays "scanning" forever; the server accepts
  // rejects for any undecided scan, so the operator needs an exit from
  // scanning/error rows too — hiding Reject left them stuck.
  const canReject = scan.status !== "approved" && scan.status !== "rejected"
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListAgentScansQueryKey() })
    queryClient.invalidateQueries({ queryKey: getListBenchmarkCallsQueryKey() })
  }
  // B-59: a whitespace-only prompt used to write decidedByLabel:"" into the
  // DB and the audit log.
  const promptApprover = (verb: string): string | null => {
    const approver = window.prompt(`${verb} from (name or email):`)?.trim() ?? ""
    if (!approver) return null
    return approver
  }

  const handleApprove = () => {
    const approver = promptApprover("Approve this pick as gold")
    if (!approver) return
    approve.mutate(
      { scanId: scan.id, data: { approverLabel: approver } },
      {
        onSuccess: () => {
          invalidate()
          toast({ title: "Approved", description: "The agent's pick is now this call's gold transcript." })
        },
        onError: (err) => toast({ title: "Error", description: err instanceof Error ? err.message : "Approve failed.", variant: "destructive" }),
      },
    )
  }
  const handleReject = () => {
    const approver = promptApprover("Reject this pick")
    if (!approver) return
    reject.mutate(
      { scanId: scan.id, data: { approverLabel: approver } },
      {
        onSuccess: () => {
          invalidate()
          toast({ title: "Rejected", description: "No change made -- the call keeps its current gold transcript." })
        },
        onError: (err) => toast({ title: "Error", description: err instanceof Error ? err.message : "Reject failed.", variant: "destructive" }),
      },
    )
  }

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
        <span className="font-mono text-xs w-40 truncate">{callLabel}</span>
        <StatusBadge status={scan.status} />
        <span className="text-xs text-muted-foreground">
          {scan.flags.length > 0 ? `${scan.flags.length} flag(s)` : "no flags"}
        </span>
        <span className="ml-auto text-xs text-muted-foreground font-mono">
          {formatDistanceToNow(new Date(scan.createdAt), { addSuffix: true })}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          {scan.flags.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Flagged spans</div>
              <div className="space-y-1.5">
                {scan.flags.map((f, i) => (
                  <div key={i} className="text-sm bg-warning/5 border border-warning/20 rounded-md px-3 py-2">
                    <span className="font-mono text-warning font-semibold">"{f.text}"</span>
                    <span className="text-muted-foreground"> -- {f.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
              Real transcript ({scan.sourceLabel})
            </div>
            <p className="text-sm bg-muted/40 rounded-md px-3 py-2 leading-relaxed">{scan.sourceTranscript}</p>
          </div>

          {scan.candidates.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                Candidates -- highlighted against the real transcript above
              </div>
              <div className="space-y-2">
                {scan.candidates.map((c) => {
                  // 2026-08-26, per Abhishek: show exactly what changed from
                  // the real transcript to each candidate, color-highlighted
                  // -- same diff/colors as the Results page (WordDiffView),
                  // not a second convention.
                  const wordDiff = c.transcript
                    ? diffWords(
                        normalizeTranscript(scan.sourceTranscript).split(" ").filter(Boolean),
                        normalizeTranscript(c.transcript).split(" ").filter(Boolean),
                      )
                    : null
                  return (
                    <div
                      key={c.providerId}
                      className={`text-sm rounded-md border px-3 py-2 ${c.providerId === scan.agentPickProviderId ? "border-primary bg-primary/5" : "border-border"}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-xs">{c.providerName}</span>
                        {c.providerId === scan.agentPickProviderId && (
                          <Badge className="text-[10px]">agent's pick</Badge>
                        )}
                        <Badge variant={c.status === "ok" ? "default" : "destructive"} className="text-[10px] uppercase ml-auto">
                          {c.status}
                        </Badge>
                      </div>
                      {wordDiff ? (
                        <WordDiffView wordDiff={wordDiff} />
                      ) : (
                        <p className="text-muted-foreground text-xs leading-relaxed">(no transcript -- this provider failed)</p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {scan.agentPickReasoning && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Agent's reasoning</div>
              <p className="text-sm text-muted-foreground bg-muted/40 rounded-md px-3 py-2">{scan.agentPickReasoning}</p>
            </div>
          )}

          {scan.errorMessage && (
            <div className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md px-3 py-2">
              {scan.errorMessage}
            </div>
          )}

          {canDecide && (
            <div className="flex items-center gap-2 pt-1">
              <p className="text-xs text-muted-foreground flex-1">
                This is a suggestion, not a fact -- it never becomes gold on its own. Approving writes
                this pick as the call's gold transcript (same rules as manual review -- no audio
                verification happens here); verify it against the audio in Review first.
              </p>
              <Button size="sm" variant="outline" onClick={handleReject} disabled={reject.isPending}>
                <X className="w-3.5 h-3.5 mr-1.5" /> Reject
              </Button>
              <Button size="sm" onClick={handleApprove} disabled={approve.isPending}>
                <Check className="w-3.5 h-3.5 mr-1.5" /> Approve as gold
              </Button>
            </div>
          )}

          {/* B-58: flagged-but-unpickable (all candidates failed) or crashed
              scans need an exit too — reject is valid for any undecided scan. */}
          {!canDecide && canReject && (
            <div className="flex items-center gap-2 pt-1">
              <p className="text-xs text-muted-foreground flex-1">
                {scan.status === "scanning" && "Still scanning — rejecting cancels this record if the scan never completes."}
                {scan.status === "error" && "This scan errored. Reject to close it out."}
                {scan.status === "flagged" && "No viable pick: the candidate providers did not return a usable transcript."}
              </p>
              <Button size="sm" variant="outline" onClick={handleReject} disabled={reject.isPending}>
                <X className="w-3.5 h-3.5 mr-1.5" /> Reject
              </Button>
            </div>
          )}

          {scan.status === "approved" && (
            <div className="text-xs text-success flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" /> Approved by {scan.decidedByLabel} -- this call's gold transcript was updated.
            </div>
          )}
          {scan.status === "rejected" && (
            <div className="text-xs text-muted-foreground flex items-center gap-1.5">
              <X className="w-3.5 h-3.5" /> Rejected by {scan.decidedByLabel} -- no change made.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Agent() {
  const { data: scans, isLoading, isError, error } = useListAgentScans(undefined, {
    // A row observed mid-run (second tab, or after navigating back during a
    // scan) used to freeze on "scanning" forever -- poll only while a scan
    // is actually in flight (UX review 2026-08-25).
    query: {
      queryKey: getListAgentScansQueryKey(),
      refetchInterval: (q) =>
        q.state.data?.some((s) => s.status === "scanning") ? 3000 : false,
    },
  })
  const { data: calls } = useListBenchmarkCalls()
  const callLabelById = React.useMemo(
    () => new Map((calls ?? []).map((c) => [c.id, c.label])),
    [calls],
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Transcript Agent</h1>
        <p className="text-muted-foreground mt-1">
          Flags likely mis-transcriptions and compares candidates from other providers.
          Every pick is a suggestion until a human approves it.
        </p>
      </div>

      <TriggerScanCard />

      <Card>
        <CardContent className="p-0">
          {isError ? (
            <div className="h-32 flex items-center justify-center text-sm text-destructive">
              Failed to load scan history: {error instanceof Error ? error.message : String(error)}
            </div>
          ) : isLoading ? (
            <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">Loading scan history...</div>
          ) : !scans?.length ? (
            <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">No scans yet -- pick a call above.</div>
          ) : (
            scans.map((scan) => (
              <ScanRow key={scan.id} scan={scan} callLabel={callLabelById.get(scan.callId) ?? scan.callId} />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
