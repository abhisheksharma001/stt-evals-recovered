import * as React from "react"
import {
  useGetBulkCallComparison,
  useGetCallComparison,
  getGetBulkCallComparisonQueryKey,
  getGetCallComparisonQueryKey,
  type CallComparison,
  type ComparisonRow,
} from "@workspace/api-client-react"
import { ChevronDown, ChevronRight, Trophy, AlertTriangle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { WordDiffView } from "@/components/word-diff-view"
import { NoOutputChip, NoOutputDetail, MissingCounts, missingByProvider, type NoOutputStatus } from "@/components/no-output"
import { TranscriptSideBySide } from "@/components/transcript-side-by-side"
import { formatMicrocents } from "@/lib/utils"
import { apiBase } from "@/lib/api-base"
import { useToast } from "@/hooks/use-toast"

// ---------------------------------------------------------------------------
// T-72 (PRD-v4-uiux E.4): the per-call provider comparison, one organism
// used from Corpus (per call) and Results (per call in a group).
//
// Top: the reference transcript -- gold when the call has one, otherwise
// the Vapi draft, which is labelled DRAFT and explained as Vapi's own live
// provider output. It is never called gold (project standing rule). Audio
// sits right under it. Below: one row per provider, its output diffed
// against that reference with the cell's metrics on the row, and the
// judge's pick marked when a scan exists. Ordering, diffs and metrics all
// come from the API (lib/call-comparison.ts) so this can never disagree
// with Runs or Results.
// ---------------------------------------------------------------------------

export function ProviderComparisonSection({ callId, bulkId }: { callId: string; bulkId?: string | null }) {
  const scoped = useGetBulkCallComparison(bulkId ?? "", callId, {
    query: { queryKey: getGetBulkCallComparisonQueryKey(bulkId ?? "", callId), enabled: !!bulkId },
  })
  const unscoped = useGetCallComparison(callId, {
    query: { queryKey: getGetCallComparisonQueryKey(callId), enabled: !bulkId },
  })
  const q = bulkId ? scoped : unscoped

  if (q.isLoading) return <p className="text-xs text-muted-foreground">Loading comparison…</p>
  if (q.isError || !q.data) {
    return (
      <p className="text-xs text-destructive">
        Couldn't load the comparison: {q.error instanceof Error ? q.error.message : "unknown error"}
      </p>
    )
  }
  return <ComparisonBody data={q.data} />
}

function ComparisonBody({ data }: { data: CallComparison }) {
  const { toast } = useToast()
  const [expandedProviderId, setExpandedProviderId] = React.useState<string | null>(null)
  // T-82: "Rows" = one line per provider with metrics, expand for its diff;
  // "Side by side" = every full transcript at once, reference first.
  const [view, setView] = React.useState<"rows" | "side">("rows")
  const ref = data.reference
  const referenceLabel = ref?.kind === "gold" ? "gold" : "the draft"
  const pickName = data.judge?.pickProviderId
    ? (data.rows.find((r) => r.providerId === data.judge!.pickProviderId)?.providerName ?? data.judge.pickProviderId)
    : null
  const oneLiner = data.judge?.reasoning ? data.judge.reasoning.split(/(?<=[.!?])\s/)[0] : null
  const missing = data.rows.filter((r) => r.status !== "ok").length
  // E.5: per-provider missing counts in the header. One call here, so each
  // is "1 of 1" -- the names are what matter: which providers gave nothing
  // is readable before scrolling to their rows.
  const missingCounts = missingByProvider(data.rows.map((r) => ({ providerId: r.providerId, providerName: r.providerName, ok: r.status === "ok" })))

  return (
    <div className="min-w-0 space-y-4">
      {/* Reference */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Reference transcript</h4>
          {ref?.kind === "gold" && (
            <Badge className="text-[9px] uppercase" title="Human-corrected transcript for this call. Every row below is diffed against it.">
              Gold
            </Badge>
          )}
          {ref?.kind === "draft" && (
            <Badge
              variant="outline"
              className="text-[9px] uppercase"
              title="Vapi's own live transcript for this call -- the output of whichever provider Vapi ran in production. It is a reference for reading, not a standard: a row that differs from it is not necessarily wrong."
            >
              Draft · Vapi live output
            </Badge>
          )}
          {ref?.kind === "draft" && data.production && (
            <span className="text-[10px] font-mono text-muted-foreground">
              produced live by {data.production.vendor}{data.production.model ? ` ${data.production.model}` : ""}
            </span>
          )}
          {data.context && (
            <span className="ml-auto text-[10px] font-mono text-muted-foreground" title="Only this bulk's runs are shown; providers are ordered by the bulk's verdict rate (peer flags per 100 words, lower first).">
              in bulk: {data.context.bulkName}
            </span>
          )}
        </div>
        {ref ? (
          <p className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-serif text-sm leading-relaxed text-foreground">
            {ref.text}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No reference on file -- this call has neither a gold transcript nor a Vapi draft, so rows below show output without a diff.
          </p>
        )}
        {ref?.kind === "draft" && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            This call has no human-corrected transcript, so the Vapi draft is shown as the reference. "Words differ" below means differs from the draft, not from the truth.
          </p>
        )}
        {data.audioAvailable ? (
          <audio
            key={data.callId}
            src={`${apiBase()}/api/benchmark/calls/${data.callId}/audio`}
            controls
            onError={() =>
              toast({
                title: "Couldn't load audio",
                description: "The recording link may have expired on Vapi's side, or no Vapi account is configured on the server.",
                variant: "destructive",
              })
            }
            className="h-9 w-full"
          />
        ) : (
          <p className="text-xs text-muted-foreground">No audio URL on this call.</p>
        )}
      </section>

      {/* Judge */}
      {data.judge && data.judge.status !== "clean" && (
        data.judge.pickProviderId ? (
          <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
            <div className="flex items-center gap-1.5 text-sm">
              <Trophy className="h-3.5 w-3.5 text-primary" />
              <span className="font-semibold text-foreground">{pickName}</span>
              <Badge variant="outline" className="text-[9px] uppercase">OpenAI pick</Badge>
              <span className="text-[10px] text-muted-foreground">-- a suggestion from the judge, not a verdict</span>
            </div>
            {oneLiner && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{oneLiner}</p>}
          </div>
        ) : data.judge.status === "error" ? (
          <div className="flex items-center gap-1.5 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" /> Judge check failed on this call -- no pick.
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
            OpenAI didn't return a usable pick for this call.
          </div>
        )
      )}
      {data.judge?.status === "clean" && (
        <p className="text-xs text-muted-foreground">Judge: clean -- providers agreed closely enough that no LLM judgement was needed.</p>
      )}

      {/* Rows */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground" title="Lower is better on every number in this table">Provider outputs · lower is better</h4>
          <span className="text-[10px] font-mono text-muted-foreground">
            {data.rows.length} provider{data.rows.length === 1 ? "" : "s"}
            {missing > 0 && <>, <span className="text-warning">{missing} without output</span></>}
            {" · "}ordered {data.ordering === "verdict_rate" ? "by this bulk's verdict rate" : "alphabetically"}
          </span>
          <div className="ml-auto flex rounded-md border border-border p-0.5" role="tablist" aria-label="Comparison view">
            {(["rows", "side"] as const).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {v === "rows" ? "Rows" : "Side by side"}
              </button>
            ))}
          </div>
          <MissingCounts counts={missingCounts} className="basis-full" />
        </div>
        {data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No provider has transcribed this call{data.context ? " in this bulk" : ""} yet.
          </p>
        ) : view === "side" ? (
          <TranscriptSideBySide data={data} referenceLabel={referenceLabel} />
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <div className="grid grid-cols-[1.2fr_5rem_5rem_5rem_5rem_5rem] items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Provider</span>
              <span className="text-right" title={`Words that differ from ${referenceLabel} / words in the reference. Can exceed the reference length when a transcript is much longer than it.`}>Differ / ref</span>
              <span className="text-right" title="Disagreements with the other providers + entity mismatches only (confidence excluded, comparable across all providers). Lower is better.">Disagreements ↓</span>
              <span className="text-right" title="Low-confidence spans this provider reported itself (only providers that report confidence). Lower is better.">Unsure words ↓</span>
              <span className="text-right" title="Time to the final transcript. Lower is better.">Speed ↓</span>
              <span className="text-right" title="Recorded cost of this transcript. Lower is better.">Cost ↓</span>
            </div>
            {data.productionRow && (
              <ProductionRow text={data.productionRow.text} diff={data.productionRow.diff} production={data.production} />
            )}
            {data.rows.map((r) => (
              <ProviderRow
                key={r.providerId}
                row={r}
                referenceLabel={referenceLabel}
                expanded={expandedProviderId === r.providerId}
                onToggle={() => setExpandedProviderId(expandedProviderId === r.providerId ? null : r.providerId)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${(v * 100).toFixed(0)}%`
}

function ProviderRow({
  row,
  referenceLabel,
  expanded,
  onToggle,
}: {
  row: ComparisonRow
  referenceLabel: string
  expanded: boolean
  onToggle: () => void
}) {
  const ok = row.status === "ok"
  // ok rows expand into the diff; no-output rows expand into the E.5 panel
  // (class in plain words, diagnosis, retryable state, retry action).
  const canExpand = ok ? row.diff != null || !!row.hypothesisTranscript : true
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={canExpand ? onToggle : undefined}
        className={`grid w-full grid-cols-[1.2fr_5rem_5rem_5rem_5rem_5rem] items-center gap-2 px-3 py-2 text-left ${canExpand ? "hover:bg-muted/30" : "cursor-default"}`}
        aria-expanded={canExpand ? expanded : undefined}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {canExpand ? (
            expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <span className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="text-sm font-medium">{row.providerName}</span>
          {row.isJudgePick && (
            <Badge className="text-[9px] uppercase">
              <Trophy className="mr-1 h-2.5 w-2.5" /> Picked
            </Badge>
          )}
          {!ok && (
            <NoOutputChip status={row.status as NoOutputStatus} failureClass={row.failureClass} retryable={row.retryable} errorMessage={row.errorMessage} />
          )}
        </span>
        <span className="text-right font-mono text-xs" title={row.diff ? `${row.diff.wordsDiffer} of ${row.diff.referenceWords} reference words differ` : undefined}>
          {ok ? (row.diff ? `${row.diff.wordsDiffer}/${row.diff.referenceWords}` : <span className="text-muted-foreground">—</span>) : ""}
        </span>
        <span className={`text-right font-mono text-xs ${row.peerFlagCount ? (row.peerFlagSeverity === "high" ? "text-destructive" : "text-warning") : "text-muted-foreground"}`}>
          {ok ? (row.peerFlagCount == null ? "—" : `${row.peerFlagCount}${row.peerFlagSeverity && row.peerFlagSeverity !== "none" ? ` ${row.peerFlagSeverity}` : ""}`) : ""}
        </span>
        <span className="text-right font-mono text-xs text-muted-foreground" title={row.hybridFlags && !row.hybridFlags.confidenceAvailable ? "This provider does not report word confidence" : undefined}>
          {ok ? (row.hybridFlags ? (row.hybridFlags.confidenceAvailable ? String(row.hybridFlags.lowConfidenceSpans) : "n/a") : "—") : ""}
        </span>
        <span className="text-right font-mono text-xs text-muted-foreground">
          {ok ? (row.latencyFinalMs == null ? "—" : `${(row.latencyFinalMs / 1000).toFixed(1)}s`) : ""}
        </span>
        <span className="text-right font-mono text-xs text-muted-foreground">{ok ? formatMicrocents(row.costMicrocents) : ""}</span>
      </button>
      {expanded && ok && (
        <div className="space-y-2 border-t border-border bg-muted/20 p-3">
          {row.diff ? (
            <WordDiffView wordDiff={row.diff.wordDiff} referenceLabel={referenceLabel} />
          ) : (
            <p className="whitespace-pre-wrap font-serif text-sm leading-relaxed">{row.hypothesisTranscript}</p>
          )}
          {row.hybridFlags && (row.hybridFlags.disagreementRate != null || row.hybridFlags.entityMismatches > 0) && (
            <p className="text-[11px] text-muted-foreground">
              Peer check: {pct(row.hybridFlags.disagreementRate)} of its words disagree with the other providers
              {row.hybridFlags.entityMismatches > 0 && <>; {row.hybridFlags.entityMismatches} entity mismatch{row.hybridFlags.entityMismatches === 1 ? "" : "es"}</>}.
            </p>
          )}
        </div>
      )}
      {!ok && !expanded && row.failureDiagnosis && (
        <div className="border-t border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">{row.failureDiagnosis}</div>
      )}
      {!ok && expanded && (
        <div className="border-t border-border bg-muted/20 p-3">
          <NoOutputDetail
            status={row.status as NoOutputStatus}
            failureClass={row.failureClass}
            retryable={row.retryable}
            errorMessage={row.errorMessage}
            failureDiagnosis={row.failureDiagnosis}
            failureSuggestedFix={row.failureSuggestedFix}
            runId={row.runId}
          />
        </div>
      )}
    </div>
  )
}

// The Vapi draft as one more row when the reference is gold (E.4 open
// decision, default yes) -- the production baseline is always visible next
// to the candidates, and diffed against gold the same way they are.
function ProductionRow({
  text,
  diff,
  production,
}: {
  text: string
  diff: CallComparison["productionRow"] extends infer P ? (P extends { diff: infer D } ? D : never) : never
  production: CallComparison["production"]
}) {
  const [expanded, setExpanded] = React.useState(false)
  return (
    <div className="border-b border-border bg-secondary/40">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="grid w-full grid-cols-[1.2fr_5rem_5rem_5rem_5rem_5rem] items-center gap-2 px-3 py-2 text-left hover:bg-muted/30"
        aria-expanded={expanded}
      >
        <span className="flex min-w-0 items-center gap-2">
          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <span className="truncate text-sm font-medium">
            {production ? `${production.vendor}${production.model ? ` ${production.model}` : ""}` : "Vapi draft"}
          </span>
          <Badge variant="outline" className="text-[9px] uppercase" title="What Vapi's live provider produced on this call. Not a candidate; shown so the production baseline sits next to them.">
            Production · draft
          </Badge>
        </span>
        <span className="text-right font-mono text-xs">{diff ? `${diff.wordsDiffer}/${diff.referenceWords}` : "—"}</span>
        <span className="text-right font-mono text-xs text-muted-foreground">—</span>
        <span className="text-right font-mono text-xs text-muted-foreground">—</span>
        <span className="text-right font-mono text-xs text-muted-foreground">—</span>
        <span className="text-right font-mono text-xs text-muted-foreground">—</span>
      </button>
      {expanded && (
        <div className="border-t border-border bg-muted/20 p-3">
          {diff ? <WordDiffView wordDiff={diff.wordDiff} referenceLabel="gold" /> : <p className="whitespace-pre-wrap font-serif text-sm">{text}</p>}
        </div>
      )}
    </div>
  )
}
