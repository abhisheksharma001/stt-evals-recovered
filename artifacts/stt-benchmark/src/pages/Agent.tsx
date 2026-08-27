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
import { Bot, ChevronDown, ChevronRight, Check, X, Sparkles, AlertTriangle } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"

// 2026-08-27, per Abhishek: "we don't need a gold transcript any more ...
// make agent system better ... use a hybrid system." A scan no longer reads
// one "true" transcript and guesses what sounds wrong -- it runs the same
// gold-free hybrid pipeline every bundle run gets automatically (cross-
// provider disagreement + provider confidence + domain-entity cross-check),
// reusing whatever candidates the call already has. An LLM only explains the
// flags the hybrid pass actually found -- it's not the thing doing the
// finding any more.

const SEVERITY_STYLES: Record<string, string> = {
  none: "bg-secondary text-muted-foreground border-border",
  low: "bg-secondary text-muted-foreground border-border",
  medium: "bg-warning/10 text-warning border-warning/25",
  high: "bg-destructive/10 text-destructive border-destructive/25",
}

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold font-mono uppercase tracking-widest border ${SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.none}`}>
      {severity}
    </span>
  )
}

function useScannableCalls() {
  const { data: calls } = useListBenchmarkCalls()
  // Anything with audio on file can be scanned -- the scan spawns a
  // transcription pass itself if the call doesn't already have candidates
  // from a prior bundle run.
  return React.useMemo(() => (calls ?? []).filter((c) => c.audioObjectPath), [calls])
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
            toast({ title: "Clean", description: "No cross-provider disagreement, low-confidence span, or entity mismatch found." })
          } else if (scan.status === "flagged") {
            toast({ title: "Flagged", description: `${scan.hybridFlags?.flagCount ?? scan.flags.length} flag(s) found -- review below.` })
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
                Compares this call's candidate transcripts across providers -- cross-provider word
                disagreement, provider-native confidence (AssemblyAI/Deepgram/Gladia), and domain
                entities (phone/VIN/reference numbers) that don't match between candidates. Reuses
                whatever this call has already been transcribed by; only spawns a fresh
                transcription pass if fewer than 2 providers have ever succeeded on it. An LLM only
                explains the flags found here -- it never runs blind, and never runs at all on a
                clean call.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={callId} onValueChange={setCallId} disabled={createScan.isPending}>
                <SelectTrigger className="w-full max-w-[420px]">
                  <SelectValue placeholder={scannableCalls.length === 0 ? "No calls with audio yet -- import first" : "Select a call to scan..."} />
                </SelectTrigger>
                <SelectContent>
                  {scannableCalls.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label} -- {c.vertical}
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
                This can take a minute or two if this call needs a fresh transcription pass. Keep
                this tab open; the result appears here when done.
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

  const canDecide = scan.status === "flagged"
  const canReject = scan.status !== "approved" && scan.status !== "rejected"
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListAgentScansQueryKey() })
    queryClient.invalidateQueries({ queryKey: getListBenchmarkCallsQueryKey() })
  }
  const promptApprover = (verb: string): string | null => {
    const approver = window.prompt(`${verb} (name or email):`)?.trim() ?? ""
    if (!approver) return null
    return approver
  }

  const handleApprove = () => {
    const approver = promptApprover("Acknowledge these flags as reviewed, from")
    if (!approver) return
    approve.mutate(
      { scanId: scan.id, data: { approverLabel: approver } },
      {
        onSuccess: () => {
          invalidate()
          toast({ title: "Acknowledged", description: "Recorded in the audit log -- no transcript was changed." })
        },
        onError: (err) => toast({ title: "Error", description: err instanceof Error ? err.message : "Failed.", variant: "destructive" }),
      },
    )
  }
  const handleReject = () => {
    const approver = promptApprover("Dismiss this scan, from")
    if (!approver) return
    reject.mutate(
      { scanId: scan.id, data: { approverLabel: approver } },
      {
        onSuccess: () => {
          invalidate()
          toast({ title: "Dismissed" })
        },
        onError: (err) => toast({ title: "Error", description: err instanceof Error ? err.message : "Failed.", variant: "destructive" }),
      },
    )
  }

  const hybrid = scan.hybridFlags
  const disagreementByProvider = new Map((hybrid?.crossProviderDisagreements ?? []).map((d) => [d.providerId, d.disagreementRate]))
  const confidenceByProvider = hybrid?.lowConfidenceSpans ?? {}

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
        {hybrid && hybrid.flagCount > 0 && <SeverityBadge severity={hybrid.flagSeverity} />}
        <span className="text-xs text-muted-foreground">
          {hybrid ? `${hybrid.flagCount} flag(s)` : scan.flags.length > 0 ? `${scan.flags.length} flag(s)` : "no flags"}
        </span>
        <span className="ml-auto text-xs text-muted-foreground font-mono">
          {formatDistanceToNow(new Date(scan.createdAt), { addSuffix: true })}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          {scan.flags.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">What the hybrid pass found</div>
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

          {scan.sourceTranscript && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                Vapi's own draft transcript (context only -- not what candidates are compared against)
              </div>
              <p className="text-sm bg-muted/40 rounded-md px-3 py-2 leading-relaxed text-muted-foreground">{scan.sourceTranscript}</p>
            </div>
          )}

          {scan.candidates.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                Candidates -- compared against each other, not a human reference
              </div>
              <div className="space-y-2">
                {scan.candidates.map((c) => {
                  const disagreementRate = disagreementByProvider.get(c.providerId)
                  const confidenceSpans = confidenceByProvider[c.providerId] ?? []
                  return (
                    <div
                      key={c.providerId}
                      className={`text-sm rounded-md border px-3 py-2 ${c.providerId === scan.agentPickProviderId ? "border-primary bg-primary/5" : "border-border"}`}
                    >
                      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                        <span className="font-semibold text-xs">{c.providerName}</span>
                        {c.providerId === scan.agentPickProviderId && (
                          <Badge className="text-[10px]">agent's pick</Badge>
                        )}
                        {disagreementRate !== undefined && disagreementRate > 0.15 && (
                          <Badge variant="outline" className="text-[10px] gap-1">
                            <AlertTriangle className="h-2.5 w-2.5" /> {Math.round(disagreementRate * 100)}% disagrees with peers
                          </Badge>
                        )}
                        <Badge variant={c.status === "ok" ? "default" : "destructive"} className="text-[10px] uppercase ml-auto">
                          {c.status}
                        </Badge>
                      </div>
                      {c.transcript ? (
                        <>
                          <p className="text-foreground leading-relaxed">{c.transcript}</p>
                          {confidenceSpans.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {confidenceSpans.map((span, i) => (
                                <span
                                  key={i}
                                  className="rounded border border-destructive/25 bg-destructive/10 px-1.5 py-0.5 font-mono text-[10px] text-destructive"
                                  title={`avg confidence ${((span.avgConfidence ?? 0) * 100).toFixed(0)}%`}
                                >
                                  {(span.words ?? []).join(" ")}
                                </span>
                              ))}
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="text-muted-foreground text-xs leading-relaxed">(no transcript -- this provider failed)</p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {hybrid && hybrid.entityMismatches.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Entity mismatches</div>
              <div className="space-y-1.5">
                {hybrid.entityMismatches.map((m, i) => (
                  <div key={i} className="text-sm bg-destructive/5 border border-destructive/20 rounded-md px-3 py-2">
                    <span className="font-mono font-semibold text-destructive uppercase text-xs">{(m.type ?? "").replace(/_/g, " ")}</span>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {Object.entries(m.valuesByProvider ?? {}).map(([providerId, values]) => (
                        <span key={providerId}>
                          <span className="font-mono">{providerId}</span>: {values.join(", ")}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
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
                This is a diagnostic, not a fact -- nothing here writes to any transcript.
                Acknowledging just records that a human looked at these flags.
              </p>
              <Button size="sm" variant="outline" onClick={handleReject} disabled={reject.isPending}>
                <X className="w-3.5 h-3.5 mr-1.5" /> Dismiss
              </Button>
              <Button size="sm" onClick={handleApprove} disabled={approve.isPending}>
                <Check className="w-3.5 h-3.5 mr-1.5" /> Acknowledge
              </Button>
            </div>
          )}

          {!canDecide && canReject && (
            <div className="flex items-center gap-2 pt-1">
              <p className="text-xs text-muted-foreground flex-1">
                {scan.status === "scanning" && "Still scanning — dismissing cancels this record if the scan never completes."}
                {scan.status === "error" && "This scan errored. Dismiss to close it out."}
              </p>
              <Button size="sm" variant="outline" onClick={handleReject} disabled={reject.isPending}>
                <X className="w-3.5 h-3.5 mr-1.5" /> Dismiss
              </Button>
            </div>
          )}

          {scan.status === "approved" && (
            <div className="text-xs text-success flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" /> Acknowledged by {scan.decidedByLabel}.
            </div>
          )}
          {scan.status === "rejected" && (
            <div className="text-xs text-muted-foreground flex items-center gap-1.5">
              <X className="w-3.5 h-3.5" /> Dismissed by {scan.decidedByLabel}.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Agent() {
  const { data: scans, isLoading, isError, error } = useListAgentScans(undefined, {
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
          Gold-free hybrid quality checks: cross-provider disagreement, provider confidence, and
          entity cross-checks -- with an LLM explaining flags, never inventing them.
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
