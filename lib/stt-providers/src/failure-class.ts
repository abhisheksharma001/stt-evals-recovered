// T-06: why a cell failed, decided where the failure happens.
//
// Before this, the only record of a failure was a free-text `errorMessage`.
// Counting "how many of these 45 failures are actually our problem" meant
// reading 45 strings by eye, and any code that wanted to act on the answer
// (retry only what is retryable, T-07) would have had to regex a sentence
// that no one guarantees the shape of -- a vendor rewording its own error
// text would silently reclassify our data.
//
// So the class is assigned **at the throw site**, by the code that is
// holding the actual HTTP status / socket state / vendor error body, and is
// then carried to the database untouched. Nothing downstream ever infers a
// class from a message.
//
// `unknown` is a real, expected value, not a bug: a failure nobody has
// classified yet must stay visible as unclassified rather than be forced
// into the nearest-looking bucket. Cartesia's "returned no final transcript
// segment" (a 1000-close with an empty final) is exactly that today.
export const FAILURE_CLASSES = [
  /** The source no longer has this recording. Vapi's plan only retains a
   *  recording 14 days; past that the audio is gone for good, from anyone,
   *  forever -- reported either as a 400 with a retention message, or as a
   *  call that simply has no recording URL any more. Never retryable. */
  "retention_expired",
  /** The signed audio URL answered 403 -- either to our own fetch, or to
   *  the provider's fetch of a URL we handed it. Storage-bucket specific,
   *  observed live and not fixable from here. Never retryable. */
  "audio_url_forbidden",
  /** The provider accepted the audio and then never returned a final
   *  transcript inside its deadline. Retryable. */
  "provider_timeout",
  /** The provider's own side failed the request -- an HTTP 5xx, or a stream
   *  the provider's server dropped mid-transfer (Cartesia's intermittent
   *  premature WebSocket close, documented in the backlog). Retryable. */
  "provider_5xx",
  /** The provider refused for rate/quota reasons (429, or an explicit
   *  quota error body). Retryable after backoff. */
  "rate_limited",
  /** The provider fetched the bytes but could not decode them as audio --
   *  a corrupt or unsupported file, not a transport problem. Not
   *  retryable without fixing the source audio. */
  "audio_decode",
  /** T-42: the provider rejected OUR credentials -- a 401/403 from the
   *  vendor's own API with a key that is present but wrong, revoked, or
   *  out of plan. A missing key never reaches the vendor (ProviderConfigError
   *  stops it first). Not retryable: the same key gets the same answer. */
  "provider_auth",
  /** Deliberately unclassified. Must stay visible. */
  "unknown",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export function isFailureClass(value: unknown): value is FailureClass {
  return typeof value === "string" && (FAILURE_CLASSES as readonly string[]).includes(value);
}

/**
 * Whether a failure of this class could plausibly succeed on a re-run.
 * T-07 turns this into a retry button that carries a real count; keeping
 * the judgement next to the enum means the two can never disagree.
 *
 * `unknown` counts as retryable on purpose: an unclassified failure has not
 * been shown to be permanent, and quietly refusing to retry it would hide
 * work rather than surface it.
 */
export function isRetryableFailureClass(failureClass: FailureClass): boolean {
  switch (failureClass) {
    case "retention_expired":
    case "audio_url_forbidden":
    case "audio_decode":
    case "provider_auth":
      return false;
    case "provider_timeout":
    case "provider_5xx":
    case "rate_limited":
    case "unknown":
      return true;
  }
}

/**
 * An Error that knows why it failed. Thrown by the code that actually saw
 * the HTTP status or socket state, so the class never has to be guessed
 * from the message afterwards.
 */
export class ClassifiedError extends Error {
  readonly failureClass: FailureClass;
  readonly httpStatus: number | null;

  constructor(
    message: string,
    failureClass: FailureClass,
    options?: { httpStatus?: number | null; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ClassifiedError";
    this.failureClass = failureClass;
    this.httpStatus = options?.httpStatus ?? null;
  }
}

/**
 * Reads a class off a thrown value, without inspecting its message. Returns
 * null when the thrower did not classify it -- callers decide whether that
 * means `unknown` or whether they have better context of their own.
 */
export function failureClassOf(err: unknown): FailureClass | null {
  const candidate = (err as { failureClass?: unknown } | null)?.failureClass;
  return isFailureClass(candidate) ? candidate : null;
}

/**
 * Turns a *provider's own* HTTP status into a class. This is not message
 * parsing: the caller is holding a real response object at the moment it
 * decides, which is the throw site by definition.
 *
 * 401/403 here means the PROVIDER refused our key (T-42: provider_auth).
 * The other 403 in this system -- a forbidden presigned audio URL -- is
 * classified by fetchAudioBytes (types.ts) before it ever reaches this
 * helper, because that caller is the one holding the audio response.
 */
export function classifyProviderHttpStatus(status: number): FailureClass {
  if (status === 401 || status === 403) return "provider_auth";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_5xx";
  if (status === 408) return "provider_timeout";
  return "unknown";
}
