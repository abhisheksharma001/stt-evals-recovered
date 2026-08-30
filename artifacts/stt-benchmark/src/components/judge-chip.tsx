import { judgeChipFor, type JudgeChipScan, type JudgeChipTone } from "@/lib/judge-chip"

/**
 * T-117: one small chip per row saying what the AI check made of this call
 * and, when the judge ruled, how sure it was -- the same buckets Results
 * shows per assistant (T-112), now findable per call. Counts and words
 * only, never a score. No scan = no chip (the call has not been through a
 * run); "checking" while a scan is in flight.
 *
 * T-129: extracted from Corpus.tsx so it renders under test (jsdom) --
 * the bucket/tone/title mapping lives in lib/judge-chip.ts (T-122, unit
 * tested); this component owns only the CSS per tone.
 */
export function JudgeChip({ scan }: { scan: JudgeChipScan | null }) {
  const chip = judgeChipFor(scan)
  if (!chip) return null
  const toneClass: Record<JudgeChipTone, string> = {
    muted: "border-border bg-muted/40 text-muted-foreground",
    success: "border-success/40 bg-success/10 text-success",
    warning: "border-warning/40 bg-warning/10 text-warning",
    destructive: "border-destructive/40 bg-destructive/10 text-destructive",
  }
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] ${toneClass[chip.tone]}`}
      data-testid="judge-chip"
      title={chip.title}
    >
      {chip.label}
    </span>
  )
}
