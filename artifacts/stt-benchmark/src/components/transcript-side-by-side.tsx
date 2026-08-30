import * as React from "react"
import type { CallComparison, ComparisonRow } from "@workspace/api-client-react"
import { Trophy } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { NoOutputChip, type NoOutputStatus } from "@/components/no-output"

// ---------------------------------------------------------------------------
// T-82 (per Abhishek 2026-08-30: "the whole transcript comparison, original
// vs all the other STT providers we are getting the proper result from").
//
// One column per transcript, side by side: the reference first (gold when
// the call has one, else the Vapi draft -- never called gold), then every
// provider that returned output. Each provider column shows its FULL text
// with the words that differ from the reference tinted inline; the
// reference column is plain. Providers with no output are one line above
// the grid, not empty columns. Columns share one scroll container so they
// move together.
//
// Pattern checked on Mobbin: Semrush's "Original | New" review mode (full
// text columns, inline highlights, score in the header) -- not the code-
// diff style of GitHub/Devin, which is for engineers reading lines.
// ---------------------------------------------------------------------------

type Op = { op: string; ref: string | null; hyp: string | null }

function HypothesisText({ ops }: { ops: Op[] }) {
  return (
    <p className="whitespace-pre-wrap font-serif text-sm leading-7">
      {ops.map((w, i) => {
        if (w.op === "ok") return <React.Fragment key={i}>{w.hyp ?? w.ref} </React.Fragment>
        if (w.op === "del")
          return (
            <span key={i} className="rounded-sm bg-destructive/10 px-0.5 text-destructive line-through decoration-destructive/60" title={`Missing: "${w.ref}"`}>
              {w.ref}{" "}
            </span>
          )
        // sub / ins: what the provider actually wrote, marked
        return (
          <span key={i} className="rounded-sm bg-warning/15 px-0.5 font-medium text-foreground" title={w.op === "sub" ? `Reference: "${w.ref}"` : "Not in the reference"}>
            {w.hyp}{" "}
          </span>
        )
      })}
    </p>
  )
}

export function TranscriptSideBySide({ data, referenceLabel }: { data: CallComparison; referenceLabel: string }) {
  const withOutput = data.rows.filter((r): r is ComparisonRow & { hypothesisTranscript: string } => r.status === "ok" && !!r.hypothesisTranscript)
  const without = data.rows.filter((r) => r.status !== "ok")
  const columns = 1 + withOutput.length

  if (!data.reference && withOutput.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing to compare: no reference and no provider output.</p>
  }

  return (
    <div className="min-w-0 max-w-full space-y-2">
      {without.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>No output from:</span>
          {without.map((r) => (
            <span key={r.providerId} className="inline-flex items-center gap-1">
              <span className="font-medium text-foreground">{r.providerName}</span>
              <NoOutputChip status={r.status as NoOutputStatus} failureClass={r.failureClass} retryable={r.retryable} errorMessage={r.errorMessage} />
            </span>
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Tinted words differ from {referenceLabel}: <span className="rounded-sm bg-warning/15 px-0.5">wrote something else</span>,{" "}
        <span className="rounded-sm bg-destructive/10 px-0.5 text-destructive line-through">left out</span>. Fewer tints = closer to {referenceLabel}.
      </p>
      <div className="max-h-[70vh] w-full max-w-full overflow-auto rounded-md border border-border">
        <div
          className="grid divide-x divide-border"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(280px, 1fr))`, minWidth: `${columns * 280}px` }}
        >
          {/* headers */}
          <div className="sticky top-0 z-10 border-b border-border bg-muted/60 px-3 py-2 backdrop-blur">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{data.reference?.kind === "gold" ? "Gold transcript" : "Vapi draft"}</span>
              <Badge variant={data.reference?.kind === "gold" ? "default" : "outline"} className="text-[9px] uppercase">
                {data.reference?.kind === "gold" ? "Reference" : "Reference · live output"}
              </Badge>
            </div>
            <div className="text-[10px] font-mono text-muted-foreground">
              {data.production && data.reference?.kind === "draft" ? `${data.production.vendor}${data.production.model ? ` ${data.production.model}` : ""} · in production` : "human-corrected"}
            </div>
          </div>
          {withOutput.map((r) => (
            <div key={`h-${r.providerId}`} className="sticky top-0 z-10 border-b border-border bg-muted/60 px-3 py-2 backdrop-blur">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{r.providerName}</span>
                {r.isJudgePick && (
                  <Badge className="text-[9px] uppercase"><Trophy className="mr-1 h-2.5 w-2.5" /> Picked</Badge>
                )}
              </div>
              <div className="text-[10px] font-mono text-muted-foreground">
                {r.diff ? `${r.diff.wordsDiffer} of ${r.diff.referenceWords} words differ` : "no diff (no reference)"}
                {r.peerFlagCount != null && <> · {r.peerFlagCount} disagreement{r.peerFlagCount === 1 ? "" : "s"}</>}
              </div>
            </div>
          ))}
          {/* bodies */}
          <div className="px-3 py-3">
            {data.reference ? (
              <p className="whitespace-pre-wrap font-serif text-sm leading-7">{data.reference.text}</p>
            ) : (
              <p className="text-sm text-muted-foreground">No reference on file.</p>
            )}
          </div>
          {withOutput.map((r) => (
            <div key={`b-${r.providerId}`} className="px-3 py-3">
              {r.diff ? <HypothesisText ops={r.diff.wordDiff} /> : <p className="whitespace-pre-wrap font-serif text-sm leading-7">{r.hypothesisTranscript}</p>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
