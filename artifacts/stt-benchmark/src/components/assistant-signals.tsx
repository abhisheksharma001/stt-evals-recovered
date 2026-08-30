import { Link } from "wouter"
import { useGetAssistantSignals, getGetAssistantSignalsQueryKey } from "@workspace/api-client-react"
import { Flag, Loader2, ShieldQuestion } from "lucide-react"

/**
 * T-112 / T-113: two lines under a Results assistant card.
 *
 * 1. How sure the AI judge was, as counts -- never a score. Evidence: Adaline
 *    evaluator results (Passed / Failed / Unknown counts at the top, each a
 *    plain number) and Lenny's "How to do AI analysis you can actually trust"
 *    (2026-02-17): say what a signal can and cannot tell you. "Not recorded"
 *    is its own bucket, not folded into "low" -- a verdict from before batch 8
 *    is a real verdict with no level on it.
 * 2. What a person flagged as hard on the Calls page, with the tags used, so
 *    the human's own judgement sits next to the machine's.
 */
export function AssistantSignals({ bulkId, assistantId }: { bulkId: string | null; assistantId: string | null }) {
  const params = { ...(bulkId ? { bulkId } : {}), ...(assistantId ? { assistantId } : {}) }
  const { data, isLoading, isError } = useGetAssistantSignals(params, { query: { queryKey: getGetAssistantSignalsQueryKey(params) } })

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 border-t px-4 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Reading judge confidence and hard-case flags...
      </div>
    )
  }
  if (isError || !data) {
    return <div className="border-t px-4 py-3 text-xs text-destructive">Could not load judge confidence and hard-case flags for this assistant.</div>
  }

  const j = data.judge
  const scopeWord = bulkId ? "in this bulk" : `across ${data.bulksCovered} finished bulk${data.bulksCovered === 1 ? "" : "s"}`
  const chip = (label: string, n: number, tone: "success" | "warning" | "destructive" | "muted") => {
    const tones = {
      success: "border-success/40 bg-success/10 text-success",
      warning: "border-warning/40 bg-warning/10 text-warning",
      destructive: "border-destructive/40 bg-destructive/10 text-destructive",
      muted: "border-border bg-muted/40 text-muted-foreground",
    } as const
    return (
      <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] ${tones[tone]}`} data-testid={`judge-${label.toLowerCase().replace(/\s+/g, "-")}`}>
        {n} {label}
      </span>
    )
  }

  return (
    <div className="space-y-2 border-t px-4 py-3 text-xs" data-testid="assistant-signals">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <ShieldQuestion className="h-3.5 w-3.5 text-muted-foreground" /> AI judge
        </span>
        {j.judged === 0 ? (
          <span className="text-muted-foreground" data-testid="judge-none">
            {j.checked === 0
              ? `no calls checked ${scopeWord}`
              : `${j.checked} call${j.checked === 1 ? "" : "s"} checked ${scopeWord}, ${j.clean} clean, ${j.errored} errored -- the judge was never asked (nothing flagged)`}
          </span>
        ) : (
          <>
            <span className="text-muted-foreground">
              {j.judged} verdict{j.judged === 1 ? "" : "s"} {scopeWord} ({j.checked} checked, {j.clean} clean{j.errored > 0 ? `, ${j.errored} errored` : ""}) &mdash; how sure it was:
            </span>
            {chip("high", j.high, "success")}
            {chip("medium", j.medium, "warning")}
            {chip("low", j.low, "destructive")}
            {j.notRecorded > 0 && (
              <span title="Verdicts made before confidence was recorded (batch 8). They are real verdicts with no level on them; a new bulk records one.">
                {chip("not recorded", j.notRecorded, "muted")}
              </span>
            )}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2" data-testid="hard-cases-line">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <Flag className="h-3.5 w-3.5 text-muted-foreground" /> Flagged hard by a person
        </span>
        {data.hardCases.calls === 0 ? (
          <span className="text-muted-foreground">
            none of {data.callsInScope} call{data.callsInScope === 1 ? "" : "s"} {scopeWord} &mdash; flag one from Calls (gear icon) and it shows here
          </span>
        ) : (
          <>
            <span className="text-muted-foreground">
              {data.hardCases.calls} of {data.callsInScope} call{data.callsInScope === 1 ? "" : "s"} {scopeWord}:
            </span>
            {data.hardCases.tags.map((t) => (
              <span key={t.tag} className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]" title={`${t.calls} call${t.calls === 1 ? "" : "s"} carry this tag`}>
                {t.tag} <span className="text-muted-foreground">x{t.calls}</span>
              </span>
            ))}
            <Link href={`/corpus?hard=1${bulkId ? `&bulk=${bulkId}` : ""}`} className="text-primary underline-offset-2 hover:underline">
              open on Calls
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
