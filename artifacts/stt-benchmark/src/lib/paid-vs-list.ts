/**
 * T-116 / T-122: when the Results "Paid / min" cell gets its `list $x`
 * note. The ranking's rate is what the bulk actually PAID (recorded cell
 * costs over audio minutes); the note only speaks when Setup's list price
 * has drifted more than this from it -- rounding noise on short calls
 * stays quiet. Pure so the boundary is unit-testable.
 */
export const PAID_VS_LIST_TOLERANCE = 0.02;

export function paidVsListDiffers(paid: number | null, list: number | undefined): boolean {
  if (paid == null || list === undefined || list <= 0) return false;
  return Math.abs(paid - list) / list > PAID_VS_LIST_TOLERANCE;
}
