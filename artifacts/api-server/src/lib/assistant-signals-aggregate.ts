// T-112 / T-113: the arithmetic behind GET /benchmark/assistant-signals.
// Pure -- no db import -- so it is unit-testable without DATABASE_URL (same
// split as words-to-watch / words-to-watch-aggregate).

export type ScanLike = {
  callId: string;
  createdAt: Date;
  status: string;
  judgeConfidence: string | null;
  agentPickReasoning: string | null;
};

export type JudgeConfidenceSummary = {
  /** Calls with a scan in scope (latest scan per call). */
  checked: number;
  /** Latest scan is "flagged" / "approved" / "rejected" AND the judge answered. */
  judged: number;
  high: number;
  medium: number;
  low: number;
  /** Judged before T-108 (batch 8) recorded confidence -- a real verdict, no level. */
  notRecorded: number;
  clean: number;
  errored: number;
};

/**
 * One scan per call: a re-execution appends a new scan row and keeps the old
 * one (history), so counting rows over-reports coverage (T-35). The most
 * recent row wins.
 */
export function latestScanPerCall<T extends { callId: string; createdAt: Date }>(scans: T[]): T[] {
  const latest = new Map<string, T>();
  for (const s of scans) {
    const cur = latest.get(s.callId);
    if (!cur || s.createdAt > cur.createdAt) latest.set(s.callId, s);
  }
  return [...latest.values()];
}

const JUDGED_STATUSES = new Set(["flagged", "approved", "rejected"]);

export function aggregateJudgeConfidence(scans: ScanLike[]): JudgeConfidenceSummary {
  const latest = latestScanPerCall(scans);
  const out: JudgeConfidenceSummary = { checked: latest.length, judged: 0, high: 0, medium: 0, low: 0, notRecorded: 0, clean: 0, errored: 0 };
  for (const s of latest) {
    if (s.status === "clean") out.clean += 1;
    else if (s.status === "error") out.errored += 1;
    // "judged" = the judge answered (reasoning on the row), the same rule
    // routes/bulks.ts uses for agentCallsJudged (T-34). A flagged scan whose
    // judge call failed is neither judged nor clean.
    if (!JUDGED_STATUSES.has(s.status) || s.agentPickReasoning === null) continue;
    out.judged += 1;
    if (s.judgeConfidence === "high") out.high += 1;
    else if (s.judgeConfidence === "medium") out.medium += 1;
    else if (s.judgeConfidence === "low") out.low += 1;
    else out.notRecorded += 1;
  }
  return out;
}

export type HardCaseCallLike = { id: string; label: string; hardCases: string[] };

export type HardCaseSummary = {
  /** Calls in scope a person flagged (hardCases non-empty). */
  calls: number;
  /** Every tag a person used, most calls first. */
  tags: { tag: string; calls: number }[];
  /** The flagged calls themselves, for linking to Calls. */
  examples: { callId: string; label: string; tags: string[] }[];
};

export function aggregateHardCases(calls: HardCaseCallLike[], exampleLimit = 5): HardCaseSummary {
  const flagged = calls.filter((c) => c.hardCases.length > 0);
  const byTag = new Map<string, number>();
  for (const c of flagged) {
    // A tag counts once per call however many times it is written on it.
    for (const tag of new Set(c.hardCases.map((t) => t.trim()).filter(Boolean))) byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
  }
  return {
    calls: flagged.length,
    tags: [...byTag.entries()].map(([tag, n]) => ({ tag, calls: n })).sort((a, b) => b.calls - a.calls || a.tag.localeCompare(b.tag)),
    examples: flagged.slice(0, exampleLimit).map((c) => ({ callId: c.id, label: c.label, tags: c.hardCases })),
  };
}
