import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * T-01 (2026-08-28): real spend is stored in MICRO-CENTS (1 cent = 10,000
 * microcents, $1 = 1,000,000) because integer cents rounded a real judge
 * call to a failed insert and a real STT cell to 1c. Display rule: never
 * show a sub-cent amount as "$0.00" -- that reads as "this was free" when it
 * means "this was small". null is "not recorded", which is not zero.
 *
 * T-03 (2026-08-28): null now says so in words instead of an em dash. A dash
 * is ambiguous in a money column -- it reads as "nothing" as easily as
 * "unknown". A measured zero still renders "$0.00"; only an unmeasured one
 * says "not recorded".
 */
export function formatMicrocents(microcents: number | null | undefined): string {
  if (microcents == null) return "not recorded"
  const dollars = microcents / 1_000_000
  if (dollars > 0 && dollars < 0.01) return `$${dollars.toFixed(4)}`
  return `$${dollars.toFixed(2)}`
}
