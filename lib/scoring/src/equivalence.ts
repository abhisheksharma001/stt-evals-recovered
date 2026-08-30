// T-101 (2026-08-30, per Abhishek): "highpriority -> high-priority, fortyc ->
// 40c, it's the same ... slang like 'sweet' ... marking the difference is
// fine, but not for flagging the call out."
//
// Two providers that wrote the same words in a different convention did not
// disagree. This file is the list of conventions that count as "the same",
// mined from the real corpus (72 calls, 873 disagreement spans, top pairs
// recorded in docs/backlog/good-to-have.md under T-101) -- not guessed:
//
//   17  "1 bedroom"  vs "1-bedroom"       hyphen vs space
//   16  "1 bedroom"  vs "one-bedroom"     number word
//   12  ""           vs "um"              disfluency
//    4  "all right"  vs "alright"
//    4  "saint"      vs "st"
//    4  "2 6 at 10am" vs "26th at 1 0 a m"  ordinal, time formatting
//    3  "4"          vs "forty"           NOT equal -- stays a disagreement
//    2  "going to"   vs "gonna"
//    2  "yeah"       vs "yes"
//    2  "ok"         vs "okay"
//    2  "high priority" vs "high-priority"
//
// canonicalTranscript() is what the hybrid flags, the disagreement spans and
// the words-to-watch list compare on. normalizeTranscript() (WER, the word
// diff view) is deliberately left alone: the diff still shows "gonna" vs
// "going to" as a difference, it just never raises a flag.
import { normalizeTranscript, splitDigitRuns } from "./index";

/** Dropped before comparing. Narrow: "yeah" / "okay" / "right" are answers. */
const DISFLUENCIES = new Set(["um", "uh", "umm", "uhh", "hmm", "mm", "mhm", "ah", "er", "erm"]);

/** Same meaning, different spelling. Values may be several tokens. */
const SAME_MEANING: Record<string, string> = {
  gonna: "going to",
  wanna: "want to",
  gotta: "got to",
  kinda: "kind of",
  sorta: "sort of",
  lemme: "let me",
  gimme: "give me",
  cause: "because",
  "'cause": "because",
  cuz: "because",
  cos: "because",
  ok: "okay",
  alright: "all right",
  yeah: "yes",
  yep: "yes",
  yup: "yes",
  nope: "no",
  nah: "no",
  ya: "you",
  saint: "st",
  "ma'am": "maam",
};

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const TENS_RE = new RegExp(`^(${Object.keys(TENS).join("|")})`);

/** "forty" -> "40", "fortyc" -> "40c", "twentyfive" -> "25". Null when the
 *  token is not a number word (or a number word glued to letters). */
function numberWordToDigits(token: string): string | null {
  if (token in UNITS) return String(UNITS[token]);
  if (token in TENS) return String(TENS[token]);
  const m = token.match(TENS_RE);
  if (m) {
    const rest = token.slice(m[1]!.length);
    if (rest in UNITS && UNITS[rest]! < 10) return String(TENS[m[1]!]! + UNITS[rest]!);
    if (/^[a-z]+$/.test(rest) && !(rest in UNITS)) return `${TENS[m[1]!]}${rest}`; // fortyc
    return null;
  }
  return null;
}

/** "40c" -> ["4","0","c"], "10am" -> ["1","0","am"], "26th" -> ["2","6"],
 *  "3rd" -> ["3"]. A token with no digits comes back as itself. */
function splitAlnum(token: string): string[] {
  if (!/\d/.test(token)) return [token];
  const ordinal = token.match(/^(\d+)(st|nd|rd|th)$/);
  if (ordinal) return ordinal[1]!.split("");
  const parts = token.match(/\d+|[a-z']+|[^a-z\d']+/g) ?? [token];
  return parts.flatMap((p) => (/^\d+$/.test(p) ? p.split("") : /^[a-z']+$/.test(p) ? [p] : []));
}

/**
 * The comparison form of a transcript: normalizeTranscript(), then the
 * equivalences above folded in. Two readings with the same canonical form
 * are the same words in a different convention and must not count as a
 * disagreement anywhere a flag or a "words to watch" row could come of it.
 */
export function canonicalTranscript(value: string): string {
  const base = normalizeTranscript(value).replace(/-/g, " ");
  if (!base.trim()) return "";
  const out: string[] = [];
  // "ma 'am" -> "ma'am": an apostrophe-led token belongs to the word before it.
  const tokens: string[] = [];
  for (const t of base.split(" ").filter(Boolean)) {
    if (t.startsWith("'") && tokens.length > 0) tokens[tokens.length - 1] += t;
    else tokens.push(t);
  }
  for (let i = 0; i < tokens.length; i += 1) {
    let t = tokens[i]!;
    if (DISFLUENCIES.has(t)) continue;
    const mapped = SAME_MEANING[t];
    if (mapped !== undefined) {
      out.push(...mapped.split(" "));
      continue;
    }
    // "twenty two" -> 22 (two tokens); "twenty" alone -> 20.
    // normalizeTranscript has already turned "two" into "2", so the unit
    // after a tens word arrives as a digit.
    const next = tokens[i + 1];
    const unit = next === undefined ? null : /^[1-9]$/.test(next) ? Number(next) : next in UNITS && UNITS[next]! < 10 ? UNITS[next]! : null;
    if (t in TENS && unit !== null) {
      out.push(...String(TENS[t]! + unit).split(""));
      i += 1;
      continue;
    }
    const digits = numberWordToDigits(t);
    if (digits !== null) t = digits;
    out.push(...splitAlnum(t));
  }
  // "a m" / "p m" -> "am" / "pm" (a time read out letter by letter).
  const merged: string[] = [];
  for (let i = 0; i < out.length; i += 1) {
    const t = out[i]!;
    const next = out[i + 1];
    if ((t === "a" || t === "p") && next === "m" && i > 0 && /^\d$/.test(out[i - 1]!)) {
      merged.push(`${t}m`);
      i += 1;
    } else {
      merged.push(t);
    }
  }
  return splitDigitRuns(merged).join(" ");
}

/** True when the readings are the same words in a different convention. */
export function sameOnceCanonical(texts: readonly string[]): boolean {
  const canon = new Set(texts.map(canonicalTranscript));
  return canon.size === 1;
}
