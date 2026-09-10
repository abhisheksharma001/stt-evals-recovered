// R-53. Three routes read `approverLabel`, trim it, and then write the
// trimmed value as the person who decided something:
//
//   routes/agent.ts:approve   -> decidedByLabel + audit actorLabel
//   routes/agent.ts:reject    -> decidedByLabel + audit actorLabel
//   routes/benchmark.ts:attest-deid -> deIdAttestedByLabel / deIdSecondApproverLabel
//                                      + audit actorLabel
//
// None of them re-checked the value after trimming, so `"   "` became `""`
// on the way in. The contract does not catch it either: `AgentScanDecision`
// has no `minLength` at all, and `AttestDeidBody`'s `minLength: 2` is
// satisfied by two spaces. The result is a decision row and an audit row
// attributed to nobody -- on attest-deid, that is the two-person
// de-identification gate (FR-C3), where "who" is the entire point of the
// record.
//
// `routes/agent-marks.ts:112` already solves exactly this for a mark's note
// and says why. This is that check, shared, because three sites need it.

/** The label as it will be stored, or null when nothing is left after
 *  trimming. Blank is the only rejection: a short name is a real name, and
 *  this is not the place to decide what a person may call themselves. */
export function trimmedApproverLabel(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Said once, because all three surfaces are refusing the same thing. */
export const BLANK_APPROVER_MESSAGE =
  "An approval has to name who gave it -- approverLabel is blank once the spaces are removed.";
