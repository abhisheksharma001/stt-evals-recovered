import { promises as fs } from "node:fs";
import path from "node:path";
import { fetchAudioBytes } from "@workspace/stt-providers";
import { resolveFreshRecordingUrl, type RecordingUrlSourceCall, type VapiCall } from "./vapi";
import { logger } from "./logger";

// 2026-08-27 (technical-fixes FIX-2): Vapi's own recording URL is only valid
// for a short window, and Vapi's subscription plan only retains a call's
// recording for 14 days at all -- past that, no fresh URL can ever be
// obtained again, from anyone, for any reason. Confirmed live: 8 corpus
// calls already permanently unscoreable, on every provider, because the
// run-executor used to re-ask Vapi for a live URL on every single run.
//
// This cache makes that a one-time cost instead of a per-run one: the first
// time a call's audio is successfully fetched (whenever that happens to be,
// hopefully well inside the 14-day window), the raw bytes are written to
// local disk keyed by call id. Every run after that reads the cached bytes
// straight off disk -- Vapi is never asked again for that call, so its
// retention window stops mattering entirely once a call is cached.
//
// Known limitation, accepted for now (matches this project's other
// single-instance-MVP tradeoffs -- no job queue yet either, see
// docs/backlog/good-to-have.md): this is a local directory on the one
// running server process, not durable object storage. Moving it to real
// storage (R2/S3) is a real follow-up once those credentials exist -- not
// invented here.
const CACHE_DIR = path.join(process.cwd(), "audio-cache");

function cachePathFor(callId: string): string {
  // Call ids are already-validated UUIDs from the DB, never user-controlled
  // free text, so a direct join is safe -- no path-traversal surface here.
  return path.join(CACHE_DIR, `${callId}.audio`);
}

/** T-9: public accessor so routes/benchmark.ts's audio-playback route can
 * stat/stream the cached file directly (with Range support) instead of
 * only this module reading whole buffers into memory. */
export function audioCachePathFor(callId: string): string {
  return cachePathFor(callId);
}

// M-5 (2026-09-05). The file above is Vapi's MONO mix: the caller and the
// assistant's TTS voice summed into one track, of which ~71% of the words
// are the assistant's. Measuring an STT provider on that mostly measures
// how well it re-reads speech a machine just synthesised.
//
// scripts/rescue-customer-audio.mjs pulled the separate stereo channels out
// of Vapi's call artifact on 2026-09-04 and wrote them beside the mono file
// as `<callId>.customer.audio` (caller only) and `<callId>.assistant.audio`.
// 99 of the corpus's 155 cached calls have them; the rest aged out of Vapi's
// retention window before the rescue ran and never will.
//
// Only the customer channel is read here. The assistant channel is on disk
// for completeness and for M-6's importer, and nothing transcribes it.
function customerCachePathFor(callId: string): string {
  return path.join(CACHE_DIR, `${callId}.customer.audio`);
}

/** M-5: public accessor, same purpose as audioCachePathFor -- the bulk
 * selection pass stats this to decide whether a call can satisfy a
 * customer-channel bulk. */
export function customerAudioPathFor(callId: string): string {
  return customerCachePathFor(callId);
}

function assistantCachePathFor(callId: string): string {
  return path.join(CACHE_DIR, `${callId}.assistant.audio`);
}

function artifactCachePathFor(callId: string): string {
  return path.join(CACHE_DIR, `${callId}.artifact.json`);
}

/** Which audio channel a cell was actually transcribed from. Persisted per
 * result row (benchmark_provider_call_results.audio_source) so a number can
 * always be traced back to the audio that produced it. */
export type CellAudioSource = "customer" | "mono";

export type CellAudio = { bytes: Buffer; source: CellAudioSource };

/**
 * M-5: reads one cell's bytes and says which channel they came from.
 *
 * `preferCustomer` is the caller's intent, not a guarantee -- with it set,
 * the customer file wins when it exists and the mono mix is used when it
 * does not. A caller that must not fall back (a bulk whose whole point is
 * the customer channel) checks `source` on the way out and refuses; this
 * function never decides that for it.
 *
 * With `preferCustomer` false the mono file is read directly and the
 * customer file is not even stat'd -- byte-for-byte the pre-M-5 behaviour,
 * which is what keeps a template saved before M-5 producing the same
 * numbers it always produced.
 */
export async function readCellAudioSource(
  callId: string,
  options: { preferCustomer: boolean },
): Promise<CellAudio> {
  if (options.preferCustomer) {
    try {
      return { bytes: await fs.readFile(customerCachePathFor(callId)), source: "customer" };
    } catch {
      // No customer channel for this call (never rescued, or aged out
      // before the rescue ran) -- fall through to the mono mix below.
    }
  }
  return { bytes: await readCachedAudioBytes(callId), source: "mono" };
}

/**
 * Returns a call's audio bytes, from the local cache if present, or by
 * resolving a fresh Vapi URL and fetching+caching it if not. Once this
 * succeeds for a call, that call never depends on Vapi's live API (or its
 * 14-day retention window) again.
 */
export async function getOrCacheAudioBytes(
  call: RecordingUrlSourceCall & { id: string },
): Promise<Buffer> {
  const cachePath = cachePathFor(call.id);
  try {
    return await fs.readFile(cachePath);
  } catch {
    // Not cached yet (or the cache dir doesn't exist) -- fall through to a
    // live fetch below.
  }

  const url = await resolveFreshRecordingUrl(call);
  const bytes = await fetchAudioBytes(url);

  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    // M-6b: same 0600 as the three sidecars written beside this file. The mono
    // mix carries the caller's voice exactly as `<id>.customer.audio` does, so
    // three locked files beside one open one protect nothing. The 0644 this
    // replaces was never a decision -- it is writeFile's 0666 minus the umask.
    await fs.writeFile(cachePath, bytes, { mode: 0o600 });
  } catch (err) {
    // Never fail the run over a cache-write problem (disk full, permissions)
    // -- the bytes are already in hand and good for this run; just log it so
    // the durability gap is visible instead of silent.
    logger.warn({ err, callId: call.id }, "failed to write audio cache -- this run proceeds, but the next run will re-fetch from Vapi");
  }

  return bytes;
}

// M-6 (2026-09-05). The mono mix is one of four things Vapi will hand over
// for a call, and the other three vanish with it when the 14-day retention
// window closes. scripts/rescue-customer-audio.mjs saved them by hand on
// 2026-09-04 for the 99 calls still inside the window; the 22 older ones
// answered 400 and are gone for good. This is that same save, run at import
// time, so no call imported from here on ever needs rescuing.
//
// Everything is written 0600 into the gitignored cache directory: the
// artifact JSON carries the caller's own words, their phone number and the
// arguments of every tool the assistant called.

export type SidecarResult = {
  /** Written by THIS call. A file already on disk is left exactly as it is. */
  saved: Array<"customer" | "assistant" | "artifact">;
  /** Channels Vapi offered no URL for on this call. A gap, not an error. */
  missing: Array<"customer" | "assistant">;
  /** Download or write problems, one sentence each. Never thrown. */
  errors: string[];
};

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves the caller-only channel, the assistant channel and the call's
 * artifact beside the mono mix.
 *
 * `call` must be a VapiCall fetched moments ago -- the presigned per-channel
 * URLs on it are short-lived, so a stale object here writes nothing and says
 * the download failed. Nothing in here ever throws: the corpus row and the
 * mono mix are already real by the time this runs, and losing an extra
 * channel must not undo an import. What did not happen comes back in the
 * result so the caller can say it out loud instead of leaving a silent gap.
 */
export async function cacheCallSidecars(callId: string, call: VapiCall): Promise<SidecarResult> {
  const result: SidecarResult = { saved: [], missing: [], errors: [] };
  const artifact = call.artifact ?? {};

  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (err) {
    result.errors.push(`the audio cache directory could not be created (${errorText(err)})`);
    return result;
  }

  const artifactPath = artifactCachePathFor(callId);
  if (!(await fileExists(artifactPath))) {
    try {
      // Field for field the shape scripts/rescue-customer-audio.mjs writes:
      // M-7's backfill reads the hand-rescued files and the imported ones
      // with one reader, or it reads neither.
      await fs.writeFile(
        artifactPath,
        JSON.stringify({
          savedAt: new Date().toISOString(),
          messages: artifact.messages ?? null,
          performanceMetrics: artifact.performanceMetrics ?? null,
          transcript: artifact.transcript ?? null,
          endedReason: call.endedReason ?? null,
          analysis: call.analysis ?? null,
          costs: call.costs ?? null,
          startedAt: call.startedAt ?? null,
          endedAt: call.endedAt ?? null,
        }),
        { mode: 0o600 },
      );
      result.saved.push("artifact");
    } catch (err) {
      result.errors.push(`the call artifact could not be saved (${errorText(err)})`);
    }
  }

  const channels = [
    { name: "customer" as const, url: artifact.presignedCustomerUrl, file: customerCachePathFor(callId) },
    { name: "assistant" as const, url: artifact.presignedAssistantUrl, file: assistantCachePathFor(callId) },
  ];
  for (const channel of channels) {
    if (await fileExists(channel.file)) continue;
    if (!channel.url) {
      result.missing.push(channel.name);
      continue;
    }
    try {
      await fs.writeFile(channel.file, await fetchAudioBytes(channel.url), { mode: 0o600 });
      result.saved.push(channel.name);
    } catch (err) {
      result.errors.push(`the ${channel.name} channel could not be saved (${errorText(err)})`);
    }
  }

  return result;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether a call's audio has already been cached (used for the "expires
 * soon" UI warning -- a call not yet cached is still on Vapi's retention
 * clock; a cached one no longer is). */
export async function isAudioCached(callId: string): Promise<boolean> {
  return fileExists(cachePathFor(callId));
}

/** M-6: the caller-only twin of isAudioCached, for the one-call read route.
 * False is a fact about this disk, never a claim that Vapi has no such
 * channel -- the two are different things and only one of them is knowable
 * from here. */
export async function isCustomerAudioCached(callId: string): Promise<boolean> {
  return fileExists(customerCachePathFor(callId));
}

/** T-7 fix (2026-08-27, base-solidity review): a plain disk read, no Vapi
 * fallback -- used by the run executor to read one cell's audio bytes right
 * before transcribing it, instead of holding every call's bytes in memory
 * for the whole shard (a 50-call shard was ~200MB of buffers held at once
 * for no reason; the bytes are already durably on disk from the pre-pass).
 * Rejects if the call isn't cached yet -- callers should fall back to
 * getOrCacheAudioBytes (or a test's substitute resolver) on a miss. */
export async function readCachedAudioBytes(callId: string): Promise<Buffer> {
  return fs.readFile(cachePathFor(callId));
}

/** T-124: every call id with audio bytes on disk, from one directory read.
 * The calls-list route decorates 100+ calls per response, so a single
 * readdir replaces per-call stat calls. A missing cache dir is an empty
 * set -- a fresh checkout has simply cached nothing yet, not an error.
 *
 * M-5 bug fix (found 2026-09-05, logged in docs/backlog/good-to-have.md):
 * `<id>.customer.audio` and `<id>.assistant.audio` also end in ".audio", so
 * since the 2026-09-04 rescue this set had been returning 198 extra entries
 * shaped `<uuid>.customer` / `<uuid>.assistant` alongside the 155 real ones.
 * They matched no call id so nothing rendered wrong, but every caller's
 * "how many calls are cached" was silently 353. Matching the id shape
 * instead of the suffix is what makes this stay right as more channel
 * files land (M-6 adds the artifact JSON's siblings). */
const CACHE_FILE_RE = /^([0-9a-f-]{36})\.audio$/;

export async function listCachedCallIds(): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(CACHE_DIR);
    const ids = new Set<string>();
    for (const entry of entries) {
      const id = CACHE_FILE_RE.exec(entry)?.[1];
      if (id) ids.add(id);
    }
    return ids;
  } catch {
    return new Set();
  }
}

/** M-5: every call id with a rescued customer channel on disk. Same single
 * readdir as above -- the bulk preview asks this once per preview instead
 * of stat'ing every in-scope call. */
export async function listCachedCustomerCallIds(): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(CACHE_DIR);
    const ids = new Set<string>();
    for (const entry of entries) {
      if (entry.endsWith(".customer.audio")) ids.add(entry.slice(0, -".customer.audio".length));
    }
    return ids;
  } catch {
    return new Set();
  }
}
