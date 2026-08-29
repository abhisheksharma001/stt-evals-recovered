import * as React from "react"

// Colors a reference-vs-hypothesis word alignment so a reviewer can see
// exactly which words a provider missed instead of only an aggregate
// number. "ok" words are dimmed (not the point), "sub"/"del" are what the
// provider got wrong, "ins" is text the provider added that isn't in the
// reference at all.
//
// T-72: lifted out of pages/Runs.tsx into an organism so Corpus, Results
// and Runs render a mismatch the same way. `referenceLabel` is what the
// summary line calls the reference -- "gold" only when the caller knows
// the reference IS a gold transcript; the Vapi draft must never be
// described as gold (project standing rule).
export type WordDiffOp = { op: string; ref: string | null; hyp: string | null }

export function WordDiffView({ wordDiff, referenceLabel = "the reference" }: { wordDiff: WordDiffOp[]; referenceLabel?: string }) {
  if (!wordDiff.length) return <p className="text-xs text-muted-foreground">No diff available.</p>
  const errorCount = wordDiff.filter(w => w.op !== "ok").length
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{errorCount} word{errorCount === 1 ? '' : 's'} differ from {referenceLabel}, out of {wordDiff.length}.</p>
      <p className="text-sm leading-7 font-mono">
        {wordDiff.map((w, i) => {
          if (w.op === "ok") {
            return <span key={i} className="text-muted-foreground">{w.ref} </span>
          }
          if (w.op === "sub") {
            return (
              <span key={i} className="mr-1 inline-block">
                {/* Full-opacity destructive + strikethrough: /70 opacity
                    measured ≈3:1 contrast, vanishing the reference word a
                    reviewer needs (theme review 2026-08-25). */}
                <span className="line-through text-destructive">{w.ref}</span>
                {"→"}
                <span className="text-warning font-semibold">{w.hyp}</span>
              </span>
            )
          }
          if (w.op === "del") {
            return <span key={i} className="line-through text-destructive mr-1">{w.ref}</span>
          }
          // ins: provider said a word that isn't in the reference at all
          return <span key={i} className="text-chart-3 font-semibold mr-1">+{w.hyp}</span>
        })}
      </p>
    </div>
  )
}
