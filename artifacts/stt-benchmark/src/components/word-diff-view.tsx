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

/** T-109: a run of words the provider itself reported low confidence on
 *  (hybrid signal 2 -- AssemblyAI, Deepgram, Gladia report per-word
 *  confidence; the rest never do). */
export type LowConfidenceSpan = { words: string[]; avgConfidence: number; severity: string }

const tokenKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9']+/g, "")

/** Which diff ops (by index) carry a hypothesis word inside a low-confidence
 *  span. Spans are matched as word sequences against the hypothesis side of
 *  the diff, in order, because the stored span has no token index that
 *  survives the diff's own normalisation. A span that is not found (the
 *  diff normalised it away) simply marks nothing -- never a wrong word. */
export function lowConfidenceOpIndexes(wordDiff: WordDiffOp[], spans: LowConfidenceSpan[] | undefined): Map<number, LowConfidenceSpan> {
  const marks = new Map<number, LowConfidenceSpan>()
  if (!spans?.length) return marks
  const hyp: { idx: number; key: string }[] = []
  wordDiff.forEach((w, idx) => {
    if (w.hyp != null) hyp.push({ idx, key: tokenKey(w.hyp) })
  })
  let cursor = 0
  for (const span of spans) {
    const keys = span.words.map(tokenKey).filter(Boolean)
    if (!keys.length) continue
    let found = -1
    for (let i = cursor; i + keys.length <= hyp.length; i++) {
      let all = true
      for (let j = 0; j < keys.length; j++) {
        if (hyp[i + j]!.key !== keys[j]) { all = false; break }
      }
      if (all) { found = i; break }
    }
    if (found < 0) continue
    for (let j = 0; j < keys.length; j++) marks.set(hyp[found + j]!.idx, span)
    cursor = found + keys.length
  }
  return marks
}

export function WordDiffView({
  wordDiff,
  referenceLabel = "the reference",
  lowConfidence,
}: {
  wordDiff: WordDiffOp[]
  referenceLabel?: string
  lowConfidence?: LowConfidenceSpan[]
}) {
  if (!wordDiff.length) return <p className="text-xs text-muted-foreground">No diff available.</p>
  const errorCount = wordDiff.filter(w => w.op !== "ok").length
  const marks = lowConfidenceOpIndexes(wordDiff, lowConfidence)
  const unsureWords = marks.size
  // Dotted underline, not a colour: the provider's own doubt is a different
  // kind of signal from a disagreement with the reference, and the two can
  // land on the same word.
  const unsure = (key: number, span: LowConfidenceSpan | undefined, node: React.ReactNode) =>
    span ? (
      <span key={key} className="underline decoration-dotted decoration-warning underline-offset-4" title={`The provider itself was unsure here (confidence ${span.avgConfidence.toFixed(2)})`} data-testid="unsure-word">
        {node}
      </span>
    ) : (
      <React.Fragment key={key}>{node}</React.Fragment>
    )
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {errorCount} word{errorCount === 1 ? '' : 's'} differ from {referenceLabel}, out of {wordDiff.length}.
        {unsureWords > 0 && <> {unsureWords} word{unsureWords === 1 ? '' : 's'} the provider itself was unsure of (dotted underline).</>}
      </p>
      <p className="text-sm leading-7 font-mono">
        {wordDiff.map((w, i) => {
          const span = marks.get(i)
          if (w.op === "ok") {
            return unsure(i, span, <span className="text-muted-foreground">{w.ref} </span>)
          }
          if (w.op === "sub") {
            return unsure(i, span, (
              <span className="mr-1 inline-block">
                {/* Full-opacity destructive + strikethrough: /70 opacity
                    measured ≈3:1 contrast, vanishing the reference word a
                    reviewer needs (theme review 2026-08-25). */}
                <span className="line-through text-destructive">{w.ref}</span>
                {"→"}
                <span className="text-warning font-semibold">{w.hyp}</span>
              </span>
            ))
          }
          if (w.op === "del") {
            return <span key={i} className="line-through text-destructive mr-1">{w.ref}</span>
          }
          // ins: provider said a word that isn't in the reference at all
          return unsure(i, span, <span className="text-chart-3 font-semibold mr-1">+{w.hyp}</span>)
        })}
      </p>
    </div>
  )
}
