// T-140: turning the Overview's "N transcripts a retry could fix" into a
// sentence a person can act on.
//
// The number alone answered none of the three questions it raises -- whose
// transcripts, what went wrong, and what happens if I click retry. Live
// today it reads 15, and all 15 are one provider's timeouts; a retry re-
// calls that provider and costs real money. The server sends the same cells
// grouped (lib/overview.ts); this turns the groups into words.

/** One group as the API sends it. */
export type RetryGroup = {
  providerId: string
  providerName: string
  /** A retryable failure class, or "skipped_pending_review". */
  reason: string
  cells: number
}

/** Plain words for a group's reason. Failure-class copy lives in
 *  components/no-output.tsx (the single source since T-73); this only needs
 *  the short label, and only for the handful of classes that can be
 *  retryable at all -- a permanent class never reaches this figure. */
const REASON_LABEL: Record<string, string> = {
  provider_timeout: "timed out",
  provider_5xx: "server error",
  rate_limited: "rate limited",
  unknown: "cause not identified",
  skipped_pending_review: "held back by review",
}

export function retryReasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason.replace(/_/g, " ")
}

export type RetryFigureCopy = {
  /** One short line under the figure. */
  hint: string
  /** The full breakdown, for the link's title attribute. */
  title: string
}

/**
 * Describes the figure. Returns null when there is nothing to describe
 * (count 0, or a server that sent no groups) -- the caller then shows the
 * bare number, never an invented explanation.
 */
export function describeRetryableCells(groups: RetryGroup[], total: number): RetryFigureCopy | null {
  if (total <= 0 || groups.length === 0) return null

  const lines = groups.map((g) => `${g.cells} × ${g.providerName} — ${retryReasonLabel(g.reason)}`)
  const providers = new Set(groups.map((g) => g.providerId))
  const reasons = new Set(groups.map((g) => g.reason))

  const hint =
    groups.length === 1
      ? `all ${groups[0]!.cells} — ${groups[0]!.providerName}, ${retryReasonLabel(groups[0]!.reason)}`
      : providers.size === 1
        ? `all ${groups[0]!.providerName} — ${[...reasons].map(retryReasonLabel).join(", ")}`
        : `${providers.size} providers — ${[...reasons].map(retryReasonLabel).join(", ")}`

  return {
    hint,
    // The warning is the point: this figure is the only one in "Needs a
    // person" whose fix spends money.
    title: `${lines.join("\n")}\n\nRetrying re-calls the provider and costs what that provider charges.`,
  }
}
