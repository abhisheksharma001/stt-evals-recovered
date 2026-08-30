import * as React from "react"
import { Link } from "wouter"
import { useGetWordsToWatch, getGetWordsToWatchQueryKey } from "@workspace/api-client-react"
import { Ear, Loader2 } from "lucide-react"

/**
 * T-87: "Words to watch" -- the words that keep splitting the providers for
 * one assistant in one bulk. Evidence: Profound "Similar keywords" and
 * Fiverr "Keyword research" (Mobbin) -- a plain frequency table, term first,
 * count beside it, no chart. Nobody here decides who heard it right (T-86);
 * every row links to Corpus so a person can listen to the worst call.
 */
export function WordsToWatch({
  bulkId,
  assistantId,
  providerNames,
  callLabels,
  compact = false,
}: {
  /** Null = all-time across every finished bulk (T-92). */
  bulkId: string | null
  assistantId: string | null
  providerNames: Record<string, string>
  callLabels: Record<string, string>
  /** Fewer rows, for a card that has a table under it already. */
  compact?: boolean
}) {
  const params = { ...(bulkId ? { bulkId } : {}), ...(assistantId ? { assistantId } : {}) }
  const { data, isLoading, isError } = useGetWordsToWatch(params, { query: { queryKey: getGetWordsToWatchQueryKey(params) } })
  const [showAll, setShowAll] = React.useState(false)
  const [showFillers, setShowFillers] = React.useState(false)
  const nameOf = (id: string) => providerNames[id] ?? id

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 px-4 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Finding the words providers split on...
      </div>
    )
  }
  if (isError || !data) return <p className="px-4 py-3 text-xs text-destructive">Could not load words to watch.</p>

  // T-98: format-only splits (hyphens, spacing, "one" vs "1", a stray "um")
  // hide with the fillers -- nothing is at stake in either.
  const meaningful = data.words.filter((w) => w.kind !== "filler" && w.kind !== "format")
  const fillers = data.words.length - meaningful.length
  const visible = showFillers ? data.words : meaningful
  const limit = compact && !showAll ? 8 : visible.length
  const rows = visible.slice(0, limit)

  return (
    <section className="border-t border-border" data-testid="words-to-watch">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pt-3">
        <h4 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Words to watch</h4>
        <p className="text-[11px] text-muted-foreground">
          {data.callsWithSpans} of {data.callsScanned} call{data.callsScanned === 1 ? "" : "s"} had a split
          {bulkId === null && ` · across ${data.bulksCovered} finished bulk${data.bulksCovered === 1 ? "" : "s"}, latest run per call`}
          {data.words.length > 0 && ` · ${data.words.length} distinct`}
        </p>
      </div>
      {data.words.length === 0 ? (
        <p className="px-4 pb-3 pt-1 text-xs text-muted-foreground">
          {data.callsScanned === 0
            ? "No transcribed calls in scope yet."
            : "Every provider heard every word the same way across these calls."}
        </p>
      ) : (
        <>
          <p className="px-4 pt-1 text-[11px] text-muted-foreground">
            Where the providers heard different words, grouped by what most of them heard. Most calls first.
            The tool does not say who was right -- open a call and listen.
          </p>
          <div className="overflow-x-auto">
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-1.5 font-medium">Most heard</th>
                  <th className="px-2 py-1.5 font-medium">Also heard as</th>
                  <th className="px-2 py-1.5 text-right font-medium" title="Distinct calls where providers split on this">Calls</th>
                  <th className="px-2 py-1.5 text-right font-medium" title="Stretches of audio; one call can hold several">Spans</th>
                  <th className="px-4 py-1.5 font-medium">Listen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={`${w.heardAs}|${w.alternatives[0]?.text ?? ""}`} className="border-t border-border/60 align-top">
                    <td className="px-4 py-1.5 font-mono">
                      {w.kind === "number" && (
                        <span className="mr-1.5 rounded border border-warning/40 bg-warning/10 px-1 font-sans text-[9px] uppercase tracking-wide text-foreground" title="A digit is involved: phone number, date, amount, unit -- the meaning of the call is at stake">
                          number
                        </span>
                      )}
                      {w.kind === "format" && (
                        <span className="mr-1.5 rounded border border-border bg-muted px-1 font-sans text-[9px] uppercase tracking-wide text-muted-foreground" title="Same words, different convention: hyphen vs space, 'one' vs '1', a stray um. Nothing at stake.">
                          format
                        </span>
                      )}
                      {w.heardAs || <span className="italic text-muted-foreground">(nothing)</span>}
                      {w.noMajority && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground" title="No single reading had a plurality; this is the first alphabetically">
                          no majority
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <ul className="space-y-0.5">
                        {w.alternatives.slice(0, 3).map((a) => (
                          <li key={a.text} className="flex flex-wrap items-baseline gap-x-1.5">
                            <span className="font-mono">{a.text || <span className="italic text-muted-foreground">(nothing)</span>}</span>
                            <span className="text-[10px] text-muted-foreground" title={a.providerIds.map(nameOf).join(", ")}>
                              {a.providerIds.map(nameOf).join(", ")}
                              {a.count > 1 && ` ×${a.count}`}
                            </span>
                          </li>
                        ))}
                        {w.alternatives.length > 3 && (
                          <li className="text-[10px] text-muted-foreground">+{w.alternatives.length - 3} more</li>
                        )}
                      </ul>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{w.calls}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{w.spans}</td>
                    <td className="px-4 py-1.5">
                      <span className="flex flex-wrap gap-x-2">
                        {w.exampleCallIds.map((id) => (
                          <Link
                            key={id}
                            href={bulkId ? `/corpus?call=${id}&bulk=${bulkId}` : `/corpus?call=${id}`}
                            className="inline-flex items-center gap-1 font-mono text-[11px] text-primary hover:underline"
                            title="Open this call in Corpus and hear the disagreements"
                          >
                            <Ear className="h-3 w-3" /> {callLabels[id] ?? id.slice(0, 8)}
                          </Link>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-x-4 px-4 pb-3 pt-2 text-xs">
            {compact && visible.length > 8 && (
              <button type="button" onClick={() => setShowAll((v) => !v)} className="text-primary hover:underline">
                {showAll ? "Show fewer" : `Show all ${visible.length}`}
              </button>
            )}
            {fillers > 0 && (
              <button type="button" onClick={() => setShowFillers((v) => !v)} className="text-muted-foreground hover:underline" title="Splits where every reading is empty or a filler word (um, uh, yeah), or where the readings differ only in convention (1-bedroom / one-bedroom, in-person / in person). Real disagreement, nothing at stake.">
                {showFillers ? "Hide" : "Show"} {fillers} filler / format-only split{fillers === 1 ? "" : "s"}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
