import React from "react"
import { useGetBulkProviderCorrelation, getGetBulkProviderCorrelationQueryKey } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * T-18: how often each pair of providers transcribed the same call the
 * same way. The point is the reading rule under the grid: a pair that agrees
 * almost always is one witness, not two, so a "4 of 6 providers agree"
 * consensus may really be 3 voices. Nothing here ranks anyone -- it only
 * says how independent the votes below are.
 */
export function ProviderCorrelationCard({ bulkId }: { bulkId: string }) {
  const { data, isLoading, isError } = useGetBulkProviderCorrelation(bulkId, {
    query: { queryKey: getGetBulkProviderCorrelationQueryKey(bulkId) },
  })

  const byPair = React.useMemo(() => {
    const map = new Map<string, { sharedCalls: number; agreement: number | null; excess: number | null }>()
    for (const p of data?.pairs ?? []) {
      const cell = { sharedCalls: p.sharedCalls, agreement: p.agreement, excess: p.excessAgreement }
      map.set(`${p.providerAId}|${p.providerBId}`, cell)
      map.set(`${p.providerBId}|${p.providerAId}`, cell)
    }
    return map
  }, [data])

  if (isLoading) return null
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-destructive">Could not load provider correlation for this bulk.</CardContent>
      </Card>
    )
  }

  const threshold = data.correlatedExcessAgreement
  const correlated = data.pairs
    .filter((p) => p.excessAgreement !== null && p.excessAgreement >= threshold)
    .sort((a, b) => (b.excessAgreement ?? 0) - (a.excessAgreement ?? 0))
  const pts = (v: number) => `${v >= 0 ? "+" : "\u2212"}${Math.abs(Math.round(v * 100))} pt${Math.abs(Math.round(v * 100)) === 1 ? "" : "s"}`
  const nameOf = (id: string) => data.providers.find((p) => p.id === id)?.name ?? id

  if (data.providers.length < 2) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Provider correlation</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Needs at least two providers with successful transcripts on the same calls. This bulk has{" "}
          {data.providers.length}.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Provider correlation</CardTitle>
        <p className="text-xs text-muted-foreground">
          Share of words each pair transcribed identically, over {data.callCount} call
          {data.callCount === 1 ? "" : "s"}. Most pairs agree a lot because most words are right; what marks a
          shared engine is a pair agreeing with each other more than either does with everyone else (shown as
          points above that baseline). Such a pair is one witness, not two.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto">
          <table className="text-xs font-mono">
            <thead>
              <tr>
                <th className="p-1" />
                {data.providers.map((p) => (
                  <th key={p.id} className="p-1 text-left font-normal text-muted-foreground align-bottom">
                    <div className="max-w-[6rem] truncate" title={p.name}>{p.name}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.providers.map((row) => (
                <tr key={row.id}>
                  <th className="p-1 text-right font-normal text-muted-foreground whitespace-nowrap">{row.name}</th>
                  {data.providers.map((col) => {
                    if (row.id === col.id) {
                      return <td key={col.id} className="p-1 text-center text-muted-foreground/40">—</td>
                    }
                    const cell = byPair.get(`${row.id}|${col.id}`)
                    const agreement = cell?.agreement ?? null
                    const pct = agreement === null ? null : Math.round(agreement * 100)
                    const excess = cell?.excess ?? null
                    const near = excess !== null && excess >= threshold
                    // Intensity tracks EXCESS, not raw agreement -- raw is
                    // uniformly high and would paint the whole grid.
                    const alpha = excess === null ? 0 : Math.min(0.6, Math.max(0, 0.06 + excess * 8))
                    return (
                      <td
                        key={col.id}
                        className={`p-1 text-center tabular-nums ${near ? "font-semibold text-warning" : ""}`}
                        style={{ backgroundColor: `hsl(var(--primary) / ${alpha.toFixed(2)})` }}
                        title={
                          cell && cell.sharedCalls > 0
                            ? `${row.name} vs ${col.name}: ${pct}% of words identical over ${cell.sharedCalls} shared call${cell.sharedCalls === 1 ? "" : "s"}${excess === null ? "" : `, ${pts(excess)} vs their baseline with everyone else`}`
                            : `${row.name} and ${col.name} never shared a call in this bulk`
                        }
                      >
                        {pct === null ? "n/a" : `${pct}%`}
                        {excess !== null && (
                          <div className={`text-[10px] ${near ? "" : "text-muted-foreground"}`}>{pts(excess)}</div>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          {correlated.length === 0 ? (
            <>No pair agrees with each other {pts(threshold)} or more above its baseline — every provider here reads as an independent voice.</>
          ) : (
            <>
              <span className="font-medium text-warning">Correlated pair{correlated.length === 1 ? "" : "s"}</span>{" "}
              ({pts(threshold)} or more above baseline):{" "}
              {correlated
                .map((p) => `${nameOf(p.providerAId)} + ${nameOf(p.providerBId)} (${pts(p.excessAgreement ?? 0)})`)
                .join("; ")}
              . When both back a reading, count it as one vote.
            </>
          )}{" "}
          "n/a" = never on the same call.
        </p>
      </CardContent>
    </Card>
  )
}
