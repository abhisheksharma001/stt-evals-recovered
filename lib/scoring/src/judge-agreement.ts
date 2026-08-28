// T-09: "how often does the judge agree with a human?"
//
// Pure arithmetic over adjudication rows that have already been replayed
// through the judge (the replay itself lives in the API server, because it
// spends OpenAI money and writes to the DB; this file must stay free of
// both so the definition of "agree" can be unit-tested exactly).
//
// What "agree" means here, precisely -- because the number is only worth
// reporting if its definition is stated:
//
//   * A verdict is COMPARABLE when the human named a provider AND the judge
//     named a provider. Those are the only rows where agreement is defined.
//   * Two picks AGREE when the readings they point at say the same words.
//     Not "same provider id": several providers usually heard a short span
//     identically ("are" x4 vs "were" x1), and a human who clicks the first
//     of four identical readings has not disagreed with a judge that named
//     the third. Comparing text is the fair reading of both verdicts.
//   * "None of them" (human null) is a real verdict the judge is not
//     allowed to give -- judgeCandidates is forced to choose one of the
//     readings -- so those rows are reported separately, never folded into
//     the rate as automatic disagreements and never hidden.
//   * A replay where the judge named nothing recognisable (judge null) is a
//     judge failure, also counted separately.
//   * Rows not yet replayed are the PENDING sample: the number the report
//     could grow to, and a reminder that replaying costs money.

export type JudgeAgreementRow = {
  readings: { providerId: string; text: string }[];
  /** Human verdict: provider id, or null for "none of them". */
  humanProviderId: string | null;
  /** Judge pick after replay: provider id, null if the judge could not name
   *  one, undefined if the row has not been replayed yet. */
  judgeProviderId: string | null | undefined;
  /** Who made the human verdict -- see T-49; may well be "unknown". */
  adjudicatedByLabel: string;
};

export type JudgeAgreementReport = {
  /** Every human verdict on file. */
  totalVerdicts: number;
  /** Verdicts the judge has been replayed on (money already spent). */
  replayed: number;
  /** Verdicts still waiting for a replay. */
  pending: number;
  /** Replayed rows where the human said "none of them" -- excluded from
   *  the rate because the judge cannot say that. */
  humanSaidNone: number;
  /** Replayed rows where the judge named nothing usable. */
  judgeNoPick: number;
  /** Rows where both sides named a provider: the denominator. */
  comparable: number;
  /** Rows where the two named readings say the same words. */
  agreements: number;
  /** agreements / comparable, or null when comparable is 0 -- never a
   *  confident 0% from an empty sample. */
  agreementRate: number | null;
  /** Same rate, per human, so "agrees with a human" can say which one. */
  byAdjudicator: { label: string; comparable: number; agreements: number; agreementRate: number | null }[];
};

function readingText(readings: JudgeAgreementRow["readings"], providerId: string): string | null {
  const reading = readings.find((r) => r.providerId === providerId);
  return reading ? reading.text.trim() : null;
}

/** Whether a replayed, comparable row is an agreement. Exported so the API
 *  can label each row the same way the totals are computed. */
export function picksAgree(row: JudgeAgreementRow): boolean | null {
  if (row.humanProviderId === null || row.judgeProviderId === null || row.judgeProviderId === undefined) return null;
  const human = readingText(row.readings, row.humanProviderId);
  const judge = readingText(row.readings, row.judgeProviderId);
  if (human === null || judge === null) return null;
  return human === judge;
}

function rate(agreements: number, comparable: number): number | null {
  return comparable === 0 ? null : agreements / comparable;
}

export function computeJudgeAgreement(rows: readonly JudgeAgreementRow[]): JudgeAgreementReport {
  let replayed = 0;
  let pending = 0;
  let humanSaidNone = 0;
  let judgeNoPick = 0;
  let comparable = 0;
  let agreements = 0;
  const perLabel = new Map<string, { comparable: number; agreements: number }>();

  for (const row of rows) {
    if (row.judgeProviderId === undefined) {
      pending += 1;
      continue;
    }
    replayed += 1;
    if (row.humanProviderId === null) {
      humanSaidNone += 1;
      continue;
    }
    const agree = picksAgree(row);
    if (agree === null) {
      judgeNoPick += 1;
      continue;
    }
    comparable += 1;
    const bucket = perLabel.get(row.adjudicatedByLabel) ?? { comparable: 0, agreements: 0 };
    bucket.comparable += 1;
    if (agree) {
      agreements += 1;
      bucket.agreements += 1;
    }
    perLabel.set(row.adjudicatedByLabel, bucket);
  }

  return {
    totalVerdicts: rows.length,
    replayed,
    pending,
    humanSaidNone,
    judgeNoPick,
    comparable,
    agreements,
    agreementRate: rate(agreements, comparable),
    byAdjudicator: [...perLabel.entries()]
      .map(([label, b]) => ({ label, comparable: b.comparable, agreements: b.agreements, agreementRate: rate(b.agreements, b.comparable) }))
      .sort((a, b) => b.comparable - a.comparable || a.label.localeCompare(b.label)),
  };
}
