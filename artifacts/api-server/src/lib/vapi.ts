// Vapi call-source integration (COR-01).
//
// Credential handling, deliberately: Vapi API keys are NEVER stored in the
// database and never leave the server process. They live only as environment
// variables, are read at request time, and only an account's *label* plus a
// short non-reversible fingerprint are exposed over the API. Nothing here
// logs or returns a key.
//
// Multiple accounts: the team pulls recordings from more than one Vapi
// workspace, so accounts are discovered from the environment by convention:
//
//   VAPI_API_KEY               -> account id "default", label "Default"
//   VAPI_API_KEY_ELLAVOX       -> account id "ellavox", label "Ellavox"
//   VAPI_API_KEY_CLIENT_ACME   -> account id "client-acme", label "Client Acme"
//
// Adding an account is an env-var change and a server restart -- no schema
// change, no secret in Postgres.

import { createHash } from "node:crypto";
import { classifyProviderHttpStatus, type FailureClass } from "@workspace/stt-providers";

const KEY_PREFIX = "VAPI_API_KEY";
const DEFAULT_ACCOUNT_ID = "default";
// Overridable so offline tests can point fetchVapiCalls at a local stub
// (see rehearsal/proof scripts); production never sets VAPI_BASE_URL and
// gets the real endpoint.
const VAPI_BASE_URL = process.env.VAPI_BASE_URL ?? "https://api.vapi.ai";
const VAPI_MAX_LIMIT = 1000;
// Hard page cap for the pagination loop in fetchVapiCalls -- a safety bound
// against pathological API behavior; 50 pages x 1000 = far past any planned
// corpus backfill, and the seen-id freshness check breaks earlier anyway.
const MAX_VAPI_PAGES = 50;

export type VapiAccount = {
  id: string;
  label: string;
  envVar: string;
  /**
   * First 8 hex chars of sha256(key). Lets an operator tell two accounts
   * apart, and confirm the server picked up the key they think it did,
   * without the key (or any reversible part of it) reaching the browser.
   */
  keyFingerprint: string;
};

export class VapiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VapiConfigError";
  }
}

export class VapiRequestError extends Error {
  readonly httpStatus: number;
  /**
   * T-06. Assigned here, at the point the response is read, from the status
   * and the vendor's own body -- not re-derived later from `this.message`.
   *
   * The retention case is the one place a *vendor's* body text is matched,
   * and it is matched here rather than downstream for a reason: Vapi
   * returns a plain 400 with `{"message":"Your subscription plan only
   * covers the last 14 days of call history..."}` and no code, flag or
   * header that distinguishes it from any other bad request. That sentence
   * is the only signal there is, so it gets read once, at the only place
   * that holds the real response, and the class it produces is what travels
   * from then on.
   */
  readonly failureClass: FailureClass;

  constructor(httpStatus: number, message: string, bodyText: string) {
    super(message);
    this.name = "VapiRequestError";
    this.httpStatus = httpStatus;
    this.failureClass =
      httpStatus === 400 && /retention window|only covers the last \d+ days/i.test(bodyText)
        ? "retention_expired"
        : // Vapi is the call source, not an STT provider, so the "provider"
          // in this helper's name is a stretch here -- but the mapping it
          // makes is about a vendor's HTTP status, and Vapi is a vendor:
          // its 429 is a rate limit and its 5xx is its own server failing,
          // which is what those classes mean and how they should be retried.
          classifyProviderHttpStatus(httpStatus);
  }
}

function labelFromSuffix(suffix: string): string {
  return suffix
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

function fingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/**
 * Discovers configured Vapi accounts from the environment. Derived on every
 * call (not cached) so an operator restarting the server with a new key sees
 * it immediately, and a revoked key disappears immediately.
 */
export function listVapiAccounts(): VapiAccount[] {
  const accounts: VapiAccount[] = [];

  const defaultKey = process.env[KEY_PREFIX]?.trim();
  if (defaultKey) {
    accounts.push({
      id: DEFAULT_ACCOUNT_ID,
      label: "Default",
      envVar: KEY_PREFIX,
      keyFingerprint: fingerprint(defaultKey),
    });
  }

  for (const [envVar, value] of Object.entries(process.env)) {
    if (!envVar.startsWith(`${KEY_PREFIX}_`)) continue;
    const key = value?.trim();
    if (!key) continue;
    const suffix = envVar.slice(KEY_PREFIX.length + 1);
    accounts.push({
      id: suffix.toLowerCase().replace(/_/g, "-"),
      label: labelFromSuffix(suffix),
      envVar,
      keyFingerprint: fingerprint(key),
    });
  }

  return accounts.sort((a, b) => a.label.localeCompare(b.label));
}

function resolveKey(accountId: string): string {
  const account = listVapiAccounts().find((a) => a.id === accountId);
  if (!account) {
    const known = listVapiAccounts().map((a) => a.id);
    throw new VapiConfigError(
      known.length === 0
        ? `No Vapi accounts are configured. Set ${KEY_PREFIX} (or ${KEY_PREFIX}_<LABEL>) on the API server and restart it.`
        : `Unknown Vapi account "${accountId}". Configured accounts: ${known.join(", ")}.`,
    );
  }
  const key = process.env[account.envVar]?.trim();
  if (!key) {
    throw new VapiConfigError(`${account.envVar} is no longer set.`);
  }
  return key;
}

export type VapiCostEntry = {
  type: string;
  transcriber?: { provider?: string; model?: string };
};

export type VapiCall = {
  id: string;
  assistantId?: string;
  status?: string;
  // T-11: why the call ended, in Vapi's own vocabulary (e.g.
  // "customer-ended-call", "assistant-forwarded-call", "voicemail",
  // "silence-timed-out"). Confirmed live 2026-08-28 on call 01a03b89.
  endedReason?: string;
  // T-11: Vapi's post-call analysis. `summary` was present on the live
  // probe; `successEvaluation` is absent on some calls (PRD measured 9 of
  // 100) and is stored verbatim when present. Nothing else is read from
  // this object until it has been seen on a real response.
  analysis?: { successEvaluation?: string | boolean | number | null; summary?: string };
  startedAt?: string;
  endedAt?: string;
  createdAt?: string;
  recordingUrl?: string;
  transcript?: string;
  customer?: { number?: string };
  artifact?: {
    recordingUrl?: string;
    transcript?: string;
    // The actually-signed, directly-fetchable link -- confirmed live against
    // the real Vapi API on 2026-08-24. `recordingUrl`/`artifact.recordingUrl`
    // are just the bare object path and are NOT guaranteed fetchable (this
    // account's calls 403 "Missing signature" on that field). Mono is what
    // this corpus uses (see the "-mono.wav" filename convention); stereo
    // kept as a fallback in case an account only has that.
    presignedMonoUrl?: string;
    presignedStereoUrl?: string;
  };
  // Cost-breakdown entries, one per pipeline stage. The transcriber entry
  // (type "transcriber") is the only place Vapi's live API actually reports
  // which STT model produced draftTranscriptOf() -- confirmed against a real
  // call 2026-08-24. There is no separate `call.assistant` object on the
  // real response (despite what Vapi's docs pages implied); don't read one.
  costs?: VapiCostEntry[];
};

export type VapiFetchOptions = {
  accountId: string;
  limit: number;
  /** ISO datetime, inclusive lower bound on Vapi's createdAt. */
  createdAtGe?: string;
  /** ISO datetime, inclusive upper bound on Vapi's createdAt. */
  createdAtLe?: string;
  assistantId?: string;
};

export function recordingUrlOf(call: VapiCall): string | undefined {
  return (
    call.artifact?.presignedMonoUrl ??
    call.artifact?.presignedStereoUrl ??
    call.artifact?.recordingUrl ??
    call.recordingUrl
  );
}

export function draftTranscriptOf(call: VapiCall): string | undefined {
  return call.artifact?.transcript ?? call.transcript;
}

/**
 * Which STT provider/model actually generated draftTranscriptOf(), read from
 * the transcriber cost-breakdown entry. Confirmed against a real call
 * 2026-08-24 (Deepgram flux-general-multi). Legitimately undefined if Vapi
 * didn't cost-track a transcriber stage for this call.
 */
export function transcriberOf(
  call: VapiCall,
): { provider: string | undefined; model: string | undefined } | undefined {
  const entry = call.costs?.find((c) => c.type === "transcriber");
  const t = entry?.transcriber;
  if (!t || (!t.provider && !t.model)) return undefined;
  return { provider: t.provider, model: t.model };
}

/**
 * T-11: Vapi's successEvaluation as a verbatim string, or null when absent.
 * Booleans/numbers are stringified rather than coerced so a future wider
 * vocabulary ("partial", a score) survives untouched.
 */
export function successEvaluationOf(call: VapiCall): string | null {
  const v = call.analysis?.successEvaluation;
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : String(v);
}

export function durationSecondsOf(call: VapiCall): number {
  if (!call.startedAt || !call.endedAt) return 0;
  const ms = new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime();
  return ms > 0 ? Math.round(ms / 1000) : 0;
}

async function vapiGet<T>(path: string, key: string): Promise<T> {
  const res = await fetch(`${VAPI_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    // The body can echo request params; it never contains the key (which is
    // only ever sent as a header), so it is safe to surface to the operator.
    const bodyText = await res.text();
    throw new VapiRequestError(
      res.status,
      `Vapi API returned HTTP ${res.status}: ${bodyText.slice(0, 500)}`,
      bodyText,
    );
  }
  return (await res.json()) as T;
}

export type VapiAssistant = {
  id: string;
  name: string;
  accountId: string;
  accountLabel: string;
};

/**
 * Lists every assistant across every configured Vapi account (2026-08-26,
 * per Abhishek: bulk selection should pick real assistants directly, not be
 * divided by vertical). Verified live: a single `limit=1000` request
 * returns the whole list in one page for both configured accounts here
 * (138 and 70 assistants respectively) -- comfortably under
 * VAPI_MAX_LIMIT, so no pagination loop is needed the way fetchVapiCalls
 * needs one for calls.
 */
export async function fetchVapiAssistants(
  accountId?: string,
): Promise<VapiAssistant[]> {
  const accounts = accountId
    ? listVapiAccounts().filter((a) => a.id === accountId)
    : listVapiAccounts();
  if (accountId && accounts.length === 0) {
    const known = listVapiAccounts().map((a) => a.id);
    throw new VapiConfigError(`Unknown Vapi account "${accountId}". Configured accounts: ${known.join(", ")}.`);
  }

  const results = await Promise.all(
    accounts.map(async (account) => {
      const key = resolveKey(account.id);
      const raw = await vapiGet<Array<{ id: string; name?: string }>>(
        `/assistant?limit=${VAPI_MAX_LIMIT}`,
        key,
      );
      return raw.map((a) => ({
        id: a.id,
        name: a.name?.trim() || a.id,
        accountId: account.id,
        accountLabel: account.label,
      }));
    }),
  );
  return results.flat().sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fetches calls for one account over a date range, paginating past Vapi's
 * per-request cap so wide date windows no longer silently truncate at
 * VAPI_MAX_LIMIT (found as triage claim #10 in ox-alpha/triage.md).
 *
 * Pagination (T-60, 2026-08-29): Vapi returns /call NEWEST first and
 * rejects an `order` param outright, so the walk goes newest -> oldest: the
 * cursor is the OLDEST createdAt on each page, sent as createdAtLe for the
 * next, exactly as lib/volume.ts does. The old walk used the NEWEST
 * createdAt as a createdAtGe cursor, which under newest-first order re-served
 * the same page and stopped after one -- the same 14-day window returned
 * 1,000 calls here and 3,448 via descending paging. The collected Map
 * dedupes the boundary tie; `truncated` says when MAX_VAPI_PAGES ran out.
 *
 * Note on assistantId: Vapi's own `assistantId` query filter was observed to
 * return an empty list for assistants that demonstrably have calls, so the
 * filter is applied client-side here instead. That costs a slightly larger
 * fetch but is the difference between "no results" and correct results --
 * the over-fetch multiplier is applied per PAGE now, not just once up front.
 */
export async function fetchVapiCalls(
  opts: VapiFetchOptions,
): Promise<VapiCall[]> {
  return (await fetchVapiCallsPaged(opts)).calls;
}

export async function fetchVapiCallsPaged(
  opts: VapiFetchOptions,
): Promise<{ calls: VapiCall[]; truncated: boolean }> {
  const key = resolveKey(opts.accountId);
  const matchesAssistant = (c: VapiCall) =>
    !opts.assistantId || c.assistantId === opts.assistantId;

  const collected = new Map<string, VapiCall>();
  let upper: string | undefined = opts.createdAtLe; // createdAtLe watermark, walks older
  let truncated = false;

  for (let page = 0; ; page++) {
    const remaining = opts.limit - [...collected.values()].filter(matchesAssistant).length;
    if (remaining <= 0) break;
    if (page >= MAX_VAPI_PAGES) {
      truncated = true;
      break;
    }
    const wireLimit = opts.assistantId
      ? Math.min(VAPI_MAX_LIMIT, Math.max(remaining * 10, 100))
      : Math.min(VAPI_MAX_LIMIT, remaining);

    const params = new URLSearchParams();
    params.set("limit", String(wireLimit));
    if (opts.createdAtGe) params.set("createdAtGe", opts.createdAtGe);
    // `Le` re-serves the boundary tie on purpose; the Map dedupes it.
    if (upper) params.set("createdAtLe", upper);

    const calls = await vapiGet<VapiCall[]>(`/call?${params.toString()}`, key);
    if (!Array.isArray(calls) || calls.length === 0) break;

    let oldestCreatedAt = "";
    let freshCount = 0;
    for (const c of calls) {
      if (!collected.has(c.id)) freshCount += 1;
      collected.set(c.id, c);
      if (c.createdAt && (oldestCreatedAt === "" || c.createdAt < oldestCreatedAt)) oldestCreatedAt = c.createdAt;
    }
    if (freshCount === 0 || !oldestCreatedAt) break; // nothing new: end of data
    if (calls.length < wireLimit) break; // short page: end of the window
    upper = oldestCreatedAt;
  }

  return {
    calls: [...collected.values()]
      .filter(matchesAssistant)
      .slice(0, opts.limit),
    truncated,
  };
}

/**
 * T-24: one raw page of /call for an account, exactly as Vapi returns it
 * (newest first as observed live 2026-08-29). Thin wrapper so a caller
 * with its own paging rule (lib/volume.ts) does not have to re-implement
 * key resolution. Nothing here filters or sorts.
 */
export async function fetchVapiCallPage(
  accountId: string,
  params: { limit: number; createdAtGe?: string; createdAtLe?: string; createdAtLt?: string },
): Promise<VapiCall[]> {
  const key = resolveKey(accountId);
  const qs = new URLSearchParams();
  qs.set("limit", String(Math.min(VAPI_MAX_LIMIT, params.limit)));
  if (params.createdAtGe) qs.set("createdAtGe", params.createdAtGe);
  if (params.createdAtLe) qs.set("createdAtLe", params.createdAtLe);
  if (params.createdAtLt) qs.set("createdAtLt", params.createdAtLt);
  const calls = await vapiGet<VapiCall[]>(`/call?${qs.toString()}`, key);
  return Array.isArray(calls) ? calls : [];
}

/**
 * Re-fetches a single call by id at import time. The importer deliberately
 * does NOT trust a recording URL sent up by the browser -- it asks Vapi again
 * so the stored `audioObjectPath` always comes from the source of truth.
 */
export async function fetchVapiCall(
  accountId: string,
  callId: string,
): Promise<VapiCall> {
  const key = resolveKey(accountId);
  return vapiGet<VapiCall>(`/call/${encodeURIComponent(callId)}`, key);
}

// --- Recording URL refresh (COR-01 / shared by playback AND run execution) -
//
// Vapi's own recording URLs (and the presigned* fields) are short-lived --
// the one captured at import time is routinely dead by the time a call is
// reviewed or run, let alone re-run. This is the single place that resolves
// a fresh, live URL for a call so the browser player and the run executor
// can't silently drift into using two different (and differently stale)
// notions of "the audio." Never caches or persists the URL it returns.

const VAPI_CALL_ID_IN_FILENAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export type RecordingUrlSourceCall = {
  sourceCallId: string | null;
  sourceAccountLabel: string | null;
  audioObjectPath: string | null;
};

/**
 * Recovers Vapi's own call id for a corpus row. `sourceCallId` is exact and
 * authoritative; calls imported before that column existed (or ones seeded
 * outside the Vapi importer but sourced from real Vapi audio) don't have it,
 * but Vapi's call UUID is embedded as the first segment of the recording
 * FILENAME -- recover it from there. Deliberately scoped to the filename,
 * not the whole URL: some storage providers (Supabase) put an unrelated
 * project UUID earlier in the path, and matching the full URL silently
 * picks that up instead (verified against all 22 corpus calls before this
 * was trusted).
 */
export function guessVapiCallId(call: RecordingUrlSourceCall): string | null {
  if (call.sourceCallId) return call.sourceCallId;
  if (!call.audioObjectPath) return null;
  let filename: string;
  try {
    filename = new URL(call.audioObjectPath).pathname.split("/").pop() ?? "";
  } catch {
    filename = call.audioObjectPath.split("/").pop() ?? "";
  }
  const match = filename.match(VAPI_CALL_ID_IN_FILENAME);
  return match?.[1] ?? null;
}

export class VapiNoRecordingError extends Error {
  /** T-06: set by the thrower, which knows whether the recording is gone
   *  (retention) or was never imported at all (unclassified). */
  readonly failureClass: FailureClass;

  constructor(message: string, failureClass: FailureClass = "unknown") {
    super(message);
    this.name = "VapiNoRecordingError";
    this.failureClass = failureClass;
  }
}

/**
 * Resolves a fresh, live recording URL for a corpus call by re-asking Vapi.
 * Throws VapiConfigError (no/ambiguous account), VapiNoRecordingError (no
 * call id on file, or Vapi has no recording for it), or VapiRequestError
 * (Vapi API call itself failed) -- callers decide how to surface each.
 */
export async function resolveFreshRecordingUrl(
  call: RecordingUrlSourceCall,
): Promise<string> {
  const vapiCallId = guessVapiCallId(call);
  if (!vapiCallId) {
    throw new VapiNoRecordingError(
      "No source recording is on file for this call (no audio was ever imported).",
    );
  }

  const accounts = listVapiAccounts();
  // Calls from before per-account labeling existed don't know which account
  // they came from -- fall back to whichever single account is configured,
  // since that was the only option at the time they were imported.
  const account =
    accounts.find(
      (a) => a.label.toLowerCase() === (call.sourceAccountLabel ?? "").toLowerCase(),
    ) ?? (accounts.length === 1 ? accounts[0] : undefined);
  if (!account) {
    throw new VapiConfigError(
      accounts.length === 0
        ? `No Vapi account is configured on the server, so a fresh recording link can't be requested. Set ${KEY_PREFIX} and restart the server.`
        : `This call's source account ("${call.sourceAccountLabel ?? "unknown"}") isn't among the configured Vapi accounts (${accounts.map((a) => a.label).join(", ")}).`,
    );
  }

  // Observed live (2026-08-24): the SAME call's presigned URL came back
  // bare/unsigned on one fetch and fully-signed (real X-Amz-Signature query
  // string) on a later one a few minutes apart -- a transient state on
  // Vapi/storage's side while the signed link is (re)generated, not a
  // permanent per-call failure. A short retry costs little and measurably
  // recovers calls that would otherwise fail every provider for no real
  // reason. `call.recordingUrl`'s own bare fallback (no presigned* field at
  // all) can never gain a query string no matter how many times it's
  // fetched, so this only spends retries when there's an actual chance.
  const RECORDING_URL_RETRIES = 2;
  const RECORDING_URL_RETRY_DELAY_MS = 1500;
  let freshUrl: string | undefined;
  for (let attempt = 0; attempt <= RECORDING_URL_RETRIES; attempt++) {
    const fresh = await fetchVapiCall(account.id, vapiCallId);
    freshUrl = recordingUrlOf(fresh);
    if (!freshUrl) break; // Vapi has nothing at all -- retrying won't help
    if (freshUrl.includes("?")) break; // signed -- done
    if (attempt < RECORDING_URL_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, RECORDING_URL_RETRY_DELAY_MS));
    }
  }
  if (!freshUrl) {
    // Vapi answered about the call but has no recording link for it: the
    // audio is gone on their side, which is the same permanent outcome as
    // an explicit retention 400.
    throw new VapiNoRecordingError(
      "Vapi has no recording URL for this call anymore.",
      "retention_expired",
    );
  }
  return freshUrl;
}
