// T-09: "how often does the judge agree with a human?" -- one number with
// its sample size, and the button that grows the sample (which spends
// OpenAI money, so it says so and says how much it just spent).
import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useGetJudgeAccuracy,
  useReplayJudgeAccuracy,
  getGetJudgeAccuracyQueryKey,
} from "@workspace/api-client-react"
import { Scale } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { formatMicrocents } from "@/lib/utils"

function pct(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`
}

export function JudgeAccuracyCard({ providerNames }: { providerNames: Record<string, string> }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { data, isLoading } = useGetJudgeAccuracy()
  const replay = useReplayJudgeAccuracy()
  const [showItems, setShowItems] = React.useState(false)

  const runReplay = () => {
    replay.mutate(
      { data: {} },
      {
        onSuccess: (outcome) => {
          void queryClient.invalidateQueries({ queryKey: getGetJudgeAccuracyQueryKey() })
          toast({
            title: `Replayed ${outcome.replayed} span${outcome.replayed === 1 ? "" : "s"} through the judge`,
            description:
              `Spent ${formatMicrocents(outcome.costMicrocents)}.` +
              (outcome.remaining > 0 ? ` ${outcome.remaining} still pending.` : "") +
              (outcome.judgeFailed > 0 ? ` ${outcome.judgeFailed} judge call(s) failed and stay pending.` : "") +
              (outcome.spanNotFound > 0 ? ` ${outcome.spanNotFound} span(s) could not be rebuilt.` : ""),
          })
        },
        onError: (err) =>
          toast({ title: "Replay failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" }),
      },
    )
  }

  const name = (id: string | null) => (id == null ? "none of them" : providerNames[id] ?? id)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Scale className="h-4 w-4" />
          Judge vs. human
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading || !data ? (
          <div className="text-muted-foreground">Loading…</div>
        ) : data.totalVerdicts === 0 ? (
          <div className="text-muted-foreground">
            No human verdicts yet. Open a call in Corpus, listen to a disagreement under
            "Hear the disagreements", and say who heard it right — the judge is measured
            against those.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <div>
                <span className="text-3xl font-bold tabular-nums">{pct(data.agreementRate)}</span>
                <span className="ml-2 text-muted-foreground">
                  agree · {data.agreements} of {data.comparable} comparable span{data.comparable === 1 ? "" : "s"}
                </span>
              </div>
              <div className="text-muted-foreground tabular-nums">
                {data.totalVerdicts} verdict{data.totalVerdicts === 1 ? "" : "s"} · {data.replayed} replayed
                {data.pending > 0 ? ` · ${data.pending} pending` : ""}
                {data.humanSaidNone > 0 ? ` · ${data.humanSaidNone} "none of them"` : ""}
                {data.judgeNoPick > 0 ? ` · ${data.judgeNoPick} judge named nothing` : ""}
                {" · "}replay cost {formatMicrocents(data.replayCostMicrocents)}
              </div>
            </div>
            {/* T-47: the free baseline the judge has to beat. */}
            <div className="text-sm text-muted-foreground tabular-nums" data-testid="majority-vs-human">
              Majority vote (no LLM) vs human: <span className="font-semibold text-foreground">{pct(data.majorityAgreementRate)}</span>
              {" "}({data.majorityAgreements}/{data.majorityComparable}; ties excluded)
            </div>
            <p className="text-xs text-muted-foreground">
              "Agree" means the judge, given only the same few words of context and each provider's
              reading (no audio), picked a reading with the same words the human picked. "None of
              them" verdicts are shown but not scored: the judge is not allowed to answer that.
            </p>
            {data.byAdjudicator.length > 1 && (
              <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground tabular-nums">
                {data.byAdjudicator.map((a) => (
                  <span key={a.label}>
                    {a.label}: {pct(a.agreementRate)} ({a.agreements}/{a.comparable})
                  </span>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {data.pending > 0 && (
                <Button size="sm" variant="outline" onClick={runReplay} disabled={replay.isPending}>
                  {replay.isPending
                    ? "Replaying…"
                    : `Replay ${Math.min(data.pending, data.replayBatchLimit)} pending through the judge`}
                </Button>
              )}
              {data.pending > 0 && (
                <span className="text-xs text-muted-foreground">Costs one short OpenAI call per span.</span>
              )}
              {data.items.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setShowItems((v) => !v)}>
                  {showItems ? "Hide" : "Show"} the {data.items.length} replayed span{data.items.length === 1 ? "" : "s"}
                </Button>
              )}
            </div>
            {showItems && (
              <ul className="space-y-2 border-t pt-3">
                {data.items.map((item) => (
                  <li key={item.adjudicationId} className="text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 font-medium ${
                          item.agrees === true
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : item.agrees === false
                              ? "bg-red-500/15 text-red-700 dark:text-red-300"
                              : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {item.agrees === true ? "agree" : item.agrees === false ? "disagree" : "not scored"}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        call {item.callId.slice(0, 8)} · {(item.spanStartMs / 1000).toFixed(1)}s
                      </span>
                      <span>
                        human: <strong>{name(item.humanProviderId)}</strong> · judge:{" "}
                        <strong>{item.judgeProviderId == null ? "nothing" : name(item.judgeProviderId)}</strong>
                      </span>
                    </div>
                    <div className="mt-0.5 text-muted-foreground">
                      {item.readings.map((r) => (
                        <span key={r.providerId} className="mr-3">
                          {providerNames[r.providerId] ?? r.providerId}: “{r.text || "—"}”
                        </span>
                      ))}
                    </div>
                    {item.judgeReasoning && (
                      <div className="mt-0.5 italic text-muted-foreground">{item.judgeReasoning}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
