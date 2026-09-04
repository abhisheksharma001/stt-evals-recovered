// M-5a (2026-09-05). One place for the words the screens use to say WHICH
// audio a number was measured on, so Results, Bulks and the per-call
// comparison can never describe the same channel differently.
//
// Why this matters at all: a Vapi call's mono recording is the caller and
// the assistant mixed into one track, and about 71% of the words in it are
// the assistant's own TTS voice. M-5 gave runs the rescued caller-only
// track and recorded which one each cell actually read. Until this file
// existed, none of that reached a reader -- a ranking measured on the mono
// mix looked exactly like one measured on the caller.
//
// Two rules, both from M-5a:
//   1. A bulk's channel comes from its own frozen selectionCriteria, never
//      from the cells underneath it. The criteria are what the executor
//      obeyed; the cells are the result. Reading the result back would be
//      a second, disagreeing source of truth.
//   2. Not recorded is never rendered as a confident "mono" and never as
//      blank. Rows written before the channel was tracked really were mono
//      -- there was no other code path -- but the ROW does not say so, and
//      the difference between "it says mono" and "we know it must be" is
//      exactly the kind of thing this tool exists to keep straight.

export type AudioChannelKind = "customer" | "mono" | "untracked"

export type AudioChannel = {
  kind: AudioChannelKind
  /** Chip-sized. Fits next to a provider name or in a table cell. */
  short: string
  /** One sentence, for a card line or a title attribute. */
  long: string
}

const CUSTOMER: AudioChannel = {
  kind: "customer",
  short: "caller-only channel",
  long: "Measured on the caller-only channel -- only the person who called is in this audio.",
}

const MONO: AudioChannel = {
  kind: "mono",
  short: "mono mix",
  long: "Measured on the mono mix, which includes the assistant's own voice as well as the caller's.",
}

const BULK_UNTRACKED: AudioChannel = {
  kind: "untracked",
  short: "channel not recorded",
  long: "Channel not recorded for this bulk -- it ran before the tool started tracking channels, when every run read the mono mix.",
}

const CELL_UNTRACKED: AudioChannel = {
  kind: "untracked",
  short: "mono (recorded before this was tracked)",
  long: "Transcribed before the tool started recording the channel. Every run from that time read the mono mix, but this row does not say so itself.",
}

/**
 * What a bulk was measured on, from the bulk's own frozen criteria.
 * `undefined` is a bulk created before the flag existed -- not a "false".
 */
export function bulkChannel(requireCustomerAudio: boolean | undefined): AudioChannel {
  if (requireCustomerAudio === undefined) return BULK_UNTRACKED
  return requireCustomerAudio ? CUSTOMER : MONO
}

/**
 * What one cell was measured on. `transcribed` is false for a cell that
 * produced no text (failed, cancelled, missing, still pending): there is no
 * measurement to attach a channel to, so nothing is said rather than
 * labelling an empty cell with the audio nobody successfully read.
 */
export function cellChannel(
  audioSource: "customer" | "mono" | null | undefined,
  transcribed: boolean,
): AudioChannel | null {
  if (!transcribed) return null
  if (audioSource === "customer") return CUSTOMER
  if (audioSource === "mono") return MONO
  return CELL_UNTRACKED
}

// M-6 (2026-09-05). The Calls chip used to have one thing to say about a
// saved call: the bytes are on disk, so Vapi's 14-day clock stopped
// mattering. Now that the importer saves the caller-only channel too, "the
// audio is saved" splits into two facts, and only one of them means this
// call can ever be measured on the caller alone.

export type SavedAudio = {
  /** Chip-sized, as it reads in the Calls table. */
  short: string
  /** One or two sentences, for the title attribute. */
  long: string
}

const RETENTION_SENTENCE =
  "The mono mix is on the server's disk, so Vapi's 14-day retention window no longer applies to this call."

/**
 * What the saved-audio chip says. Three states, not two, for the same
 * reason M-5a needed three: `undefined` is a response that never looked at
 * the customer channel, so the chip states the retention fact it does know
 * and claims nothing about a channel nobody checked.
 */
export function savedAudioChip(customerAudioCached: boolean | undefined): SavedAudio {
  if (customerAudioCached === undefined) return { short: "audio saved", long: RETENTION_SENTENCE }
  if (customerAudioCached) {
    return {
      short: "customer audio saved",
      long: `${RETENTION_SENTENCE} The caller-only channel is saved beside it, so this call can be measured on the caller's voice alone.`,
    }
  }
  return {
    short: "audio saved",
    long: `${RETENTION_SENTENCE} The caller-only channel is not saved, so this call can only be measured on audio that also contains the assistant's own voice.`,
  }
}
