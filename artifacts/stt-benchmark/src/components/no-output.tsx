import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useExecuteBenchmarkRun,
  getListBenchmarkRunsQueryKey,
  getListBenchmarkRunResultsQueryKey,
  getGetBenchmarkDashboardQueryKey,
} from "@workspace/api-client-react"
import { RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"

// ---------------------------------------------------------------------------
// T-73 (PRD-v4-uiux E.5): "show what we did not get".
//
// One organism for a provider cell that produced no output, used by the
// per-call comparison (Corpus / Results), the Runs cell drill-down and the
// Bulks failure breakdown. A missing output is always a row that says
// "<Provider>: no output -- <failure class in plain words>", with the T-41
// diagnosis when there is one, the T-43 retryable/permanent state, and a
// retry action when re-running could actually fix it. Never an empty cell,
// never a dash.
//
// The class copy lived in Bulks.tsx (T-07) and was the only class-driven
// failure text on screen; it is the single source now. Retryability is
// never derived here -- it arrives from the API (`retryable`, decided by
// isRetryableFailureClass on the server), so this file cannot disagree
// with the executor.
// ---------------------------------------------------------------------------

/**
 * T-07: how each failure class is named and explained on screen.
 *
 * The wording is the whole point. "45 cells failed" reads as "the tool is
 * broken"; "30 recordings expired before we asked for them" reads as what
 * actually happened, and stops an operator paying to retry something that
 * can never succeed.
 *
 * Two entries deserve their difference spelled out, because they look
 * interchangeable and are not:
 *   - "unknown" is a CLASSIFIED failure whose cause was not identified. It
 *     is retryable, because nothing has shown it to be permanent.
 *   - null is an UNCLASSIFIED row -- written before the class column
 *     existed, and left alone by the T-40 backfill because its stored error
 *     text named no cause. It is not retryable: guessing that it was
 *     transient would spend real provider money on a maybe.
 */
export const FAILURE_CLASS_COPY: Record<string, { label: string; detail: string }> = {
  retention_expired: {
    label: "Recording expired",
    detail: "Vapi keeps a recording 14 days. Past that the audio is gone for everyone, permanently.",
  },
  audio_url_forbidden: {
    label: "Audio URL forbidden (403)",
    detail: "The signed storage URL refused the download. Bucket-specific and not fixable from here.",
  },
  provider_timeout: {
    label: "Provider timed out",
    detail: "The provider took the audio and never returned a final transcript inside its deadline.",
  },
  provider_5xx: {
    label: "Provider server error",
    detail: "The provider's own side failed the request, or dropped the stream mid-transfer.",
  },
  rate_limited: {
    label: "Rate limited",
    detail: "The provider refused on quota. Worth re-running once the window clears.",
  },
  audio_decode: {
    label: "Audio could not be decoded",
    detail: "The bytes arrived but were not usable audio. The source file has to be fixed first.",
  },
  provider_auth: {
    label: "Provider rejected our API key",
    detail: "The key is present but the provider answered 401/403 -- wrong, revoked, or outside its plan. Fix the key; a retry gets the same answer.",
  },
  unknown: {
    label: "Unknown cause",
    detail: "Classified as a failure, but the cause was not identified. Counted as retryable until it is.",
  },
}

export const UNCLASSIFIED_COPY = {
  label: "Unclassified (predates classification)",
  detail:
    "Recorded before failures carried a cause, and its stored error text names none. Not guessed, and not retried — re-running it would be paying for a maybe.",
}

/** Plain-words copy for a failure class; `null`/unrecognised -> unclassified. */
export function failureCopy(failureClass: string | null | undefined): { label: string; detail: string } {
  return failureClass ? (FAILURE_CLASS_COPY[failureClass] ?? UNCLASSIFIED_COPY) : UNCLASSIFIED_COPY
}

/** Every non-ok cell status the two grids can show. "missing" = the provider
 *  was in the run but no result row exists for the call (never attempted). */
export type NoOutputStatus = "failed" | "skipped_pending_review" | "pending" | "cancelled" | "missing"

/** What a no-output cell reads as, in plain words, before any diagnosis. */
export function noOutputLabel(status: NoOutputStatus, failureClass: string | null | undefined): string {
  switch (status) {
    case "failed":
      return failureCopy(failureClass).label
    case "skipped_pending_review":
      return "Skipped — call has not cleared review"
    case "pending":
      return "Not finished — still queued or running"
    case "cancelled":
      return "Cancelled before it ran"
    case "missing":
      return "Never attempted"
  }
}

/** Why a cell with that status has no output, one sentence. */
export function noOutputDetail(status: NoOutputStatus, failureClass: string | null | undefined): string {
  switch (status) {
    case "failed":
      return failureCopy(failureClass).detail
    case "skipped_pending_review":
      return "The call matched the run's filters but is still awaiting human review. A re-run picks it up once review is done."
    case "pending":
      return "The executor has not written a verdict for this cell yet. If the run is no longer running, re-executing it finishes the cell."
    case "cancelled":
      return "The run was cancelled before this cell was attempted. Re-executing the run attempts it."
    case "missing":
      return "The provider was in this run's list but no result row was ever written for this call. Re-executing the run attempts it."
  }
}

// ---------------------------------------------------------------------------
// Retryable / permanent state (T-43). `retryable` comes from the API:
//   true  -> re-running could fix it
//   false -> permanent; the executor leaves it as it is
//   null  -> unknown (no class on file); the executor treats it as permanent
//            and this reads "not retried", never "permanent" (we do not know)
// ---------------------------------------------------------------------------
export function RetryableBadge({ retryable }: { retryable: boolean | null | undefined }) {
  const cls =
    retryable === true
      ? "border-warning/25 bg-warning/10 text-warning"
      : "border-border bg-secondary text-muted-foreground"
  const text = retryable === true ? "retryable" : retryable === false ? "permanent" : "not retried"
  const title =
    retryable === true
      ? "Re-running the run attempts this cell again."
      : retryable === false
        ? "Re-running cannot fix this; the executor leaves the cell as it is."
        : "No failure class on file, so retryability is unknown. The executor does not re-run it: that would be paying for a maybe."
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest ${cls}`} title={title}>
      {text}
    </span>
  )
}

/**
 * The one-line chip that sits on a provider row / table cell:
 * "no output — Recording expired" + retryable state. Hover shows the raw
 * error text when there is one.
 */
export function NoOutputChip({
  status,
  failureClass,
  retryable,
  errorMessage,
}: {
  status: NoOutputStatus
  failureClass: string | null | undefined
  retryable: boolean | null | undefined
  errorMessage?: string | null
}) {
  const isFailure = status === "failed"
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span
        className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
          isFailure ? "border-destructive/25 bg-destructive/10 text-destructive" : "border-border bg-secondary text-muted-foreground"
        }`}
        title={errorMessage ?? noOutputDetail(status, failureClass)}
      >
        no output — {noOutputLabel(status, failureClass)}
      </span>
      {(isFailure || status === "skipped_pending_review") && <RetryableBadge retryable={retryable} />}
    </span>
  )
}

/**
 * Retry action: re-executes the run the cell belongs to. There is no
 * per-cell endpoint on purpose -- the executor is resumable and decides
 * cell by cell (only cells without a success are attempted; permanent
 * failures are left alone), so this is the same path as the Runs page's
 * Execute button, never a blind reprocess.
 */
export function RetryRunButton({ runId, label = "Retry" }: { runId: string; label?: string }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const execute = useExecuteBenchmarkRun()
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={execute.isPending}
      title="Re-executes this cell's run. Only cells without a successful result are attempted; permanent failures stay as they are. Costs real provider money for the cells it does attempt."
      onClick={(e) => {
        e.stopPropagation()
        execute.mutate(
          { runId },
          {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: getListBenchmarkRunsQueryKey() })
              queryClient.invalidateQueries({ queryKey: getListBenchmarkRunResultsQueryKey(runId) })
              queryClient.invalidateQueries({ queryKey: getGetBenchmarkDashboardQueryKey() })
              // Comparison queries are keyed per call/bulk; the executor
              // writes asynchronously, so a broad invalidate is the honest
              // option -- the row updates on the next fetch.
              queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").includes("/comparison") })
              toast({ title: "Run re-started", description: "Retrying the cells in this run that have no successful result yet." })
            },
            onError: (err) =>
              toast({ title: "Couldn't start the retry", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" }),
          },
        )
      }}
    >
      <RotateCw className={`mr-1.5 h-3.5 w-3.5 ${execute.isPending ? "animate-spin" : ""}`} /> {execute.isPending ? "Starting…" : label}
    </Button>
  )
}

/**
 * The expanded panel under a no-output row: what the class means, the T-41
 * diagnosis + suggested fix when one exists, the raw error for the record,
 * and the retry action when the API says a retry could help. `children` is
 * a slot for a caller-specific action (Runs passes its on-demand
 * "AI analysis" button).
 */
export function NoOutputDetail({
  status,
  failureClass,
  retryable,
  errorMessage,
  failureDiagnosis,
  failureSuggestedFix,
  runId,
  children,
}: {
  status: NoOutputStatus
  failureClass: string | null | undefined
  retryable: boolean | null | undefined
  errorMessage: string | null | undefined
  failureDiagnosis: string | null | undefined
  failureSuggestedFix: string | null | undefined
  runId: string | null | undefined
  children?: React.ReactNode
}) {
  const canRetry = runId != null && (retryable === true || status === "pending" || status === "cancelled" || status === "missing")
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{noOutputLabel(status, failureClass)}</span>
        {(status === "failed" || status === "skipped_pending_review") && <RetryableBadge retryable={retryable} />}
        {failureClass && <span className="font-mono text-[10px] text-muted-foreground">{failureClass}</span>}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{noOutputDetail(status, failureClass)}</p>
      {failureDiagnosis && (
        <div className="space-y-1 rounded-md border border-border bg-muted/40 px-3 py-2">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diagnosis: </span>
            {failureDiagnosis}
          </div>
          {failureSuggestedFix && (
            <div>
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Suggested fix: </span>
              {failureSuggestedFix}
            </div>
          )}
        </div>
      )}
      {errorMessage && (
        <p className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground" title="Raw error text as recorded on the cell">
          {errorMessage}
        </p>
      )}
      {(canRetry || children) && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {canRetry && runId && <RetryRunButton runId={runId} label="Retry this run's unfinished cells" />}
          {children}
        </div>
      )}
      {!canRetry && retryable === false && (
        <p className="text-[11px] text-muted-foreground">Not retried: re-running the run leaves this cell as it is.</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-provider missing counts for a section header: "Cartesia: 3 of 22
// missing" -- a provider that fails often is visible before you scroll.
// ---------------------------------------------------------------------------
export type MissingCount = { providerId: string; providerName: string; missing: number; total: number }

export function missingByProvider(
  cells: ReadonlyArray<{ providerId: string; providerName: string; ok: boolean }>,
): MissingCount[] {
  const byId = new Map<string, MissingCount>()
  for (const c of cells) {
    const e = byId.get(c.providerId) ?? { providerId: c.providerId, providerName: c.providerName, missing: 0, total: 0 }
    e.total += 1
    if (!c.ok) e.missing += 1
    byId.set(c.providerId, e)
  }
  return [...byId.values()].sort((a, b) => b.missing - a.missing || a.providerName.localeCompare(b.providerName))
}

export function MissingCounts({ counts, className = "" }: { counts: MissingCount[]; className?: string }) {
  const withMissing = counts.filter((c) => c.missing > 0)
  if (withMissing.length === 0) return null
  return (
    <span className={`inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-mono ${className}`} title="Transcripts with no output, per provider">
      {withMissing.map((c) => (
        <span key={c.providerId} className="text-warning">
          {c.providerName}: {c.missing} of {c.total} missing
        </span>
      ))}
    </span>
  )
}
