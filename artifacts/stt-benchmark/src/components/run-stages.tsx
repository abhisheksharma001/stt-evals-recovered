import * as React from "react"
import { Check, Loader2, Circle } from "lucide-react"

// T-105 (2026-08-30, per Abhishek: "when the agent is running I want to see
// an animation"). Evidence (Mobbin, visual-and-research): the pattern that
// tells a reader *where* a job is, not just that it is busy, is a staged
// checklist with a spinner on the live stage and a check on the finished
// ones -- Relevance AI "Running automated checks", Klaviyo flow creation,
// Vercel deployment steps -- with a bar and a count beside it (Remote,
// Employment Hero). Avoided: decorative illustrations (Remote "Uploading
// your resume") that animate without saying anything.
//
// Three stages, in the order the pipeline runs them: transcripts land, the
// AI check reads them, the ranking is computed. Numbers are the real
// BulkProgress counts -- nothing here is faked to look busy.

export type StageProgress = {
  cellsTotal: number
  cellsOk: number
  cellsFailed: number
  cellsPending: number
  cellsCancelled: number
  cellsSkippedPendingReview: number
  callsRun: number
  callsTotal: number
  agentCallsTotal: number
  agentCallsChecked: number
  agentCallsInFlight: number
}

type StageState = "done" | "active" | "pending"

function stageIcon(state: StageState) {
  if (state === "done") return <Check className="h-3.5 w-3.5 text-success" aria-label="done" />
  if (state === "active") return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-label="in progress" />
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/50" aria-label="not started" />
}

/** A bar that moves while the count is unknown or mid-stage: the fill is
 *  the real percentage, and a soft band sweeps across it only while the
 *  stage is active, so a stalled job looks stalled. */
export function StageBar({ pct, active, tone = "primary" }: { pct: number; active: boolean; tone?: "primary" | "accent" }) {
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={`h-full ${tone === "primary" ? "bg-primary" : "bg-accent"} transition-[width] duration-700`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      {active && <div className="stt-sweep absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-background/60 to-transparent" aria-hidden />}
    </div>
  )
}

export function RunStages({ p, inFlight, compact = false }: { p: StageProgress; inFlight: boolean; compact?: boolean }) {
  const cellsDone = p.cellsOk + p.cellsFailed + p.cellsCancelled + p.cellsSkippedPendingReview
  const sttPct = p.cellsTotal > 0 ? Math.round((cellsDone / p.cellsTotal) * 100) : 0
  const sttState: StageState = p.cellsTotal > 0 && cellsDone >= p.cellsTotal ? "done" : inFlight ? "active" : cellsDone > 0 ? "done" : "pending"
  const agentPct = p.agentCallsTotal > 0 ? Math.round((p.agentCallsChecked / p.agentCallsTotal) * 100) : 0
  const agentState: StageState =
    p.agentCallsTotal > 0 && p.agentCallsChecked >= p.agentCallsTotal && p.agentCallsInFlight === 0
      ? "done"
      : p.agentCallsInFlight > 0 || (inFlight && p.agentCallsChecked > 0)
        ? "active"
        : inFlight
          ? "pending"
          : p.agentCallsChecked > 0
            ? "done"
            : "pending"
  const rankState: StageState = !inFlight && sttState === "done" ? "done" : "pending"

  return (
    <ol className={`space-y-${compact ? "1.5" : "2"}`} data-testid="run-stages" aria-live="polite">
      <li className="space-y-1">
        <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          {stageIcon(sttState)}
          <span className={sttState === "active" ? "text-foreground" : ""}>Transcribing</span>
          <span className="ml-auto">
            {p.cellsOk} ok{p.cellsFailed > 0 ? ` · ${p.cellsFailed} failed` : ""}{p.cellsPending > 0 ? ` · ${p.cellsPending} pending` : ""}
            {p.cellsSkippedPendingReview > 0 ? ` · ${p.cellsSkippedPendingReview} skipped` : ""}{p.cellsCancelled > 0 ? ` · ${p.cellsCancelled} cancelled` : ""}
            {" "}· {sttPct}% of {p.cellsTotal} cells · {p.callsRun}/{p.callsTotal} calls
          </span>
        </div>
        <StageBar pct={sttPct} active={sttState === "active"} />
      </li>
      <li className="space-y-1" data-testid="agent-progress">
        <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          {stageIcon(agentState)}
          <span className={agentState === "active" ? "text-foreground" : ""} title="The AI check runs after the transcripts land; paid to OpenAI, not the STT vendors.">AI check</span>
          <span className="ml-auto">
            {p.agentCallsTotal > 0 || p.agentCallsInFlight > 0 ? (
              <>
                {p.agentCallsChecked}/{p.agentCallsTotal} calls verified
                {p.agentCallsInFlight > 0 && <> · <span className="text-primary">{p.agentCallsInFlight} in flight</span></>}
                {" "}· {agentPct}%
              </>
            ) : (
              "waits for transcripts"
            )}
          </span>
        </div>
        <StageBar pct={agentPct} active={agentState === "active"} tone="accent" />
      </li>
      <li className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
        {stageIcon(rankState)}
        <span>Ranking</span>
        <span className="ml-auto">{rankState === "done" ? "computed" : "after the AI check"}</span>
      </li>
    </ol>
  )
}
