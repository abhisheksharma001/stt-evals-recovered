import { promises as fs } from "node:fs";
import path from "node:path";
import { fetchAudioBytes } from "@workspace/stt-providers";
import { resolveFreshRecordingUrl, type RecordingUrlSourceCall } from "./vapi";
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
    await fs.writeFile(cachePath, bytes);
  } catch (err) {
    // Never fail the run over a cache-write problem (disk full, permissions)
    // -- the bytes are already in hand and good for this run; just log it so
    // the durability gap is visible instead of silent.
    logger.warn({ err, callId: call.id }, "failed to write audio cache -- this run proceeds, but the next run will re-fetch from Vapi");
  }

  return bytes;
}

/** Whether a call's audio has already been cached (used for the "expires
 * soon" UI warning -- a call not yet cached is still on Vapi's retention
 * clock; a cached one no longer is). */
export async function isAudioCached(callId: string): Promise<boolean> {
  try {
    await fs.access(cachePathFor(callId));
    return true;
  } catch {
    return false;
  }
}
