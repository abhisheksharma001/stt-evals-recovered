/**
 * T-117 / T-122: what the per-call judge chip says, as data. One bucket per
 * scan state -- the same buckets Results shows per assistant (T-112) --
 * with the hover text spelling out what each means. Pure so the mapping is
 * unit-testable (T-122); Corpus.tsx renders the result and owns the CSS.
 */
export type JudgeChipTone = "muted" | "success" | "warning" | "destructive";

export type JudgeChipContent = { label: string; tone: JudgeChipTone; title: string };

export type JudgeChipScan = {
  status: string;
  judgeConfidence?: string | null;
  agentPickReasoning?: string | null;
};

export function judgeChipFor(scan: JudgeChipScan | null): JudgeChipContent | null {
  // No scan = no chip: the call has not been through a run at all.
  if (!scan) return null;
  if (scan.status === "scanning") return { label: "checking", tone: "muted", title: "AI check in progress" };
  if (scan.status === "clean")
    return { label: "clean", tone: "muted", title: "Every provider agreed; the AI judge was never asked" };
  if (scan.status === "error")
    return { label: "check failed", tone: "destructive", title: "The AI check itself failed on this call" };
  // flagged / approved / rejected -- the judge answered only if there is
  // reasoning on the row (T-34).
  if (!scan.agentPickReasoning)
    return { label: "flagged, no verdict", tone: "muted", title: "Providers disagreed but the judge did not answer" };
  const confidence = scan.judgeConfidence ?? null;
  const tone: JudgeChipTone =
    confidence === "high" ? "success" : confidence === "medium" ? "warning" : confidence === "low" ? "destructive" : "muted";
  const title = confidence
    ? `The AI judge ruled on this call and was ${confidence} on it. Expand the row for its pick and reasoning.`
    : "The AI judge ruled on this call before confidence was recorded (batch 8). A real verdict with no level on it.";
  return { label: `judge: ${confidence ?? "not recorded"}`, tone, title };
}
