/**
 * W-4 (PRD v8 Part B): preview and import, as functions instead of as route
 * bodies. Moved out of `artifacts/api-server/src/routes/benchmark.ts`
 * unchanged -- same queries, same order, same responses, same audit rows,
 * same log lines.
 *
 * Why the move: `scripts/daily-import.sh` reaches the importer over HTTP, and
 * that is fine for a cron job outside the process. W-5's tick runs *inside*
 * this process. Without this module it would have to call its own API over
 * loopback, or keep a second copy of two hundred lines that write to the
 * corpus. Neither is acceptable for code that spends money on transcription.
 *
 * The routes keep the HTTP vocabulary -- status codes, the 400 body, the
 * Vapi error mapping. This module keeps the work, and says what went wrong by
 * throwing: `UnknownVapiAccountError` for an account this server does not
 * serve, and the `lib/vapi.ts` errors untouched for anything Vapi said.
 */

import { and, eq, inArray, or } from "drizzle-orm";
import type { ZodInput } from "@workspace/api-zod";
import { ImportVapiCallsResponse, PreviewVapiCallsResponse } from "@workspace/api-zod";
import { benchmarkCallsTable, db } from "@workspace/db";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import {
  draftTranscriptOf,
  durationSecondsOf,
  fetchVapiCall,
  fetchVapiCalls,
  listVapiAccounts,
  recordingUrlOf,
  successEvaluationOf,
  transcriberOf,
  VapiConfigError,
  type VapiCall,
} from "./vapi";
import { writeAudit } from "./audit";
import { logger } from "./logger";
import { drainWithConcurrency } from "./concurrency";
import { cacheCallSidecars, getOrCacheAudioBytes } from "./audio-cache";
import { readProductionSignals } from "./production-signals";
import { classifyAudioAttemptFailure, recordAudioCacheAttempt } from "./audio-attempt";
import { serializeCall } from "./serialize-call";

// How many Vapi calls the importer re-fetches/inserts concurrently.
// Vapi's API tolerates modest parallelism; 4 keeps a 100-call backfill at
// ~25 round trips instead of 100 without risking 429 storms. Clamped like
// the executor knobs (threshold review 2026-08-25) -- a typo of 400 here
// would hammer Vapi from every import click.
const VAPI_IMPORT_CONCURRENCY = (() => {
  const raw = process.env.VAPI_IMPORT_CONCURRENCY;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 4;
  return Math.min(parsed, 16);
})();

const VAPI_PREVIEW_CHARS = 240;

/** The account id was not one this server has a key for. The route turns this
 *  into the 400 it has always returned; a caller inside the process (W-5) can
 *  catch it and write `refused:no_key` to its ledger instead. */
export class UnknownVapiAccountError extends Error {
  readonly accountId: string;
  constructor(accountId: string) {
    super(`Unknown or unconfigured Vapi account "${accountId}".`);
    this.name = "UnknownVapiAccountError";
    this.accountId = accountId;
  }
}

/**
 * Marks *where* a failure happened, not what kind it was: this came out of
 * talking to Vapi, and `cause` is the untouched original.
 *
 * It exists because the behaviour being preserved is positional. In the route
 * bodies this replaced, only the Vapi read was wrapped in a try/catch that
 * answered 502; a database failure a few lines later fell through to the
 * error handler and answered 500. A library that threw both the same way
 * would turn a broken Postgres into "Vapi request failed", which is a lie the
 * operator would chase for an hour. So the Vapi stage tags itself, the route
 * unwraps and maps exactly as before, and everything else propagates.
 */
export class VapiSourceError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Vapi request failed.");
    this.name = "VapiSourceError";
    this.cause = cause;
  }
}

/** Corpus label the importer assigns to a Vapi call.
 *
 * Hashes the id rather than truncating it directly -- Vapi call ids are
 * UUIDv7, whose first bytes are a millisecond timestamp, not random bits.
 * Truncating to the first 8 hex chars truncates the timestamp, so any two
 * calls placed close together in time collide on the label (confirmed live:
 * 3 real collisions in a 22-call corpus, calls made in the same session).
 * Hashing first makes the truncated output uniformly distributed, so
 * collisions go back to being astronomically rare instead of routine. */
export function vapiLabelFor(vapiCallId: string): string {
  const digest = createHash("sha256").update(vapiCallId).digest("hex");
  return `vapi-${digest.slice(0, 8)}`;
}

/**
 * Finds an existing corpus row for a Vapi call id.
 *
 * Two lookups, not one: `sourceCallId` is exact and authoritative, but calls
 * imported by the earlier CLI predate that column and only carry the derived
 * `vapi-<first8>` label. Without the label fallback, re-previewing a window
 * that overlaps the original CLI import would offer those calls as fresh
 * and duplicate them.
 */
async function findExistingVapiCall(
  vapiCallId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: benchmarkCallsTable.id })
    .from(benchmarkCallsTable)
    .where(
      or(
        and(
          eq(benchmarkCallsTable.sourceProvider, "vapi"),
          eq(benchmarkCallsTable.sourceCallId, vapiCallId),
        ),
        eq(benchmarkCallsTable.label, vapiLabelFor(vapiCallId)),
      ),
    )
    .limit(1);
  return row;
}

export type PreviewVapiCallsInput = {
  accountId: string;
  limit?: number;
  /** The generated zod schema coerces `format: date-time` into a Date; this
   *  keeps that shape so the route hands its parse straight over. */
  startDate?: Date;
  endDate?: Date;
  assistantId?: string;
};

/** What is in that window, and which of it the corpus already holds.
 *  Throws `UnknownVapiAccountError` for an account this server has no key
 *  for, `VapiSourceError` when Vapi itself refused, and anything the database
 *  threw, untouched. */
export async function previewVapiCalls(
  input: PreviewVapiCallsInput,
): Promise<ZodInput<typeof PreviewVapiCallsResponse>> {
  const account = listVapiAccounts().find((a) => a.id === input.accountId);
  if (!account) throw new UnknownVapiAccountError(input.accountId);

  let calls: VapiCall[];
  try {
    calls = await fetchVapiCalls({
      accountId: input.accountId,
      limit: input.limit ?? 50,
      // Vapi's query params want ISO strings.
      createdAtGe: input.startDate?.toISOString(),
      createdAtLe: input.endDate?.toISOString(),
      assistantId: input.assistantId,
    });
  } catch (err) {
    throw new VapiSourceError(err);
  }

  // One query for the whole batch rather than per-call, so the duplicate
  // annotation stays cheap as the window widens. Matches on either the exact
  // source id or the derived label (see findExistingVapiCall).
  const ids = calls.map((c) => c.id);
  const existing = ids.length
    ? await db
        .select({
          id: benchmarkCallsTable.id,
          label: benchmarkCallsTable.label,
          sourceCallId: benchmarkCallsTable.sourceCallId,
        })
        .from(benchmarkCallsTable)
        .where(
          or(
            and(
              eq(benchmarkCallsTable.sourceProvider, "vapi"),
              inArray(benchmarkCallsTable.sourceCallId, ids),
            ),
            inArray(benchmarkCallsTable.label, ids.map(vapiLabelFor)),
          ),
        )
    : [];
  const existingBySourceId = new Map(
    existing.flatMap((row) => (row.sourceCallId ? [[row.sourceCallId, row.id]] : [])),
  );
  const existingByLabel = new Map(existing.map((row) => [row.label, row.id]));

  const previewCalls = calls.map((call) => {
    const draft = draftTranscriptOf(call);
    const recordingUrl = recordingUrlOf(call);
    const existingCallId =
      existingBySourceId.get(call.id) ??
      existingByLabel.get(vapiLabelFor(call.id)) ??
      null;
    const startedAtRaw = call.startedAt ?? call.createdAt ?? null;
    return {
      vapiCallId: call.id,
      assistantId: call.assistantId ?? null,
      startedAt: startedAtRaw ? new Date(startedAtRaw) : null,
      durationSeconds: durationSecondsOf(call),
      hasRecording: Boolean(recordingUrl),
      recordingUrl: recordingUrl ?? null,
      draftTranscriptChars: draft?.length ?? 0,
      draftTranscriptPreview: draft ? draft.slice(0, VAPI_PREVIEW_CHARS) : null,
      alreadyImported: existingCallId !== null,
      existingCallId,
    };
  });

  return {
    accountId: account.id,
    accountLabel: account.label,
    fetchedCount: previewCalls.length,
    importableCount: previewCalls.filter(
      (c) => c.hasRecording && !c.alreadyImported,
    ).length,
    calls: previewCalls,
  };
}

export type ImportVapiCallsInput = {
  accountId: string;
  vertical: string;
  vapiCallIds: string[];
};

/**
 * Imports the named calls. `actorLabel` is written to every audit row, so a
 * scheduled import is distinguishable from one a person clicked.
 *
 * `log` defaults to the process logger; the route passes `req.log` so an
 * import's warnings stay attached to the request that caused them.
 */
export async function importVapiCalls(
  input: ImportVapiCallsInput,
  actorLabel: string,
  log: Logger = logger,
): Promise<ZodInput<typeof ImportVapiCallsResponse>> {
  const account = listVapiAccounts().find((a) => a.id === input.accountId);
  if (!account) throw new UnknownVapiAccountError(input.accountId);

  type ImportOutcome = {
    vapiCallId: string;
    outcome: "imported" | "skipped_duplicate" | "skipped_no_recording" | "failed";
    callId: string | null;
    label: string | null;
    message: string | null;
  };

  // One call's full import path (duplicate check -> Vapi re-fetch -> insert
  // -> audit). Errors other than a missing config are per-call failures; the
  // batch continues (review finding #4's import parallelism, P1-4 in
  // ox-alpha/improvement-plan.md).
  const importOne = async (vapiCallId: string): Promise<ImportOutcome> => {
    const duplicate = await findExistingVapiCall(vapiCallId);
    if (duplicate) {
      return {
        vapiCallId,
        outcome: "skipped_duplicate",
        callId: duplicate.id,
        label: null,
        message: "Already in the corpus.",
      };
    }

    let call: VapiCall;
    try {
      // Re-fetched from Vapi rather than taken from the request body: the
      // browser must not be able to point a corpus entry at arbitrary audio.
      call = await fetchVapiCall(input.accountId, vapiCallId);
    } catch (err) {
      if (err instanceof VapiConfigError) throw err; // aborts the whole batch
      log.warn({ err, vapiCallId }, "Vapi call fetch failed during import");
      return {
        vapiCallId,
        outcome: "failed",
        callId: null,
        label: null,
        message: err instanceof Error ? err.message : "Fetch failed.",
      };
    }

    const recordingUrl = recordingUrlOf(call);
    if (!recordingUrl) {
      return {
        vapiCallId,
        outcome: "skipped_no_recording",
        callId: null,
        label: null,
        message: "Call has no recording URL; nothing to transcribe.",
      };
    }

    const draft = draftTranscriptOf(call);
    const transcriber = transcriberOf(call);
    const label = vapiLabelFor(call.id);
    const startedAt = call.startedAt ?? call.createdAt;

    const [created] = await db
      .insert(benchmarkCallsTable)
      .values({
        label,
        vertical: input.vertical,
        // R-42 (ox-alpha B-98): was Math.max(1, ...). durationSecondsOf
        // returns 0 when startedAt or endedAt is missing or the delta is not
        // positive -- a crashed call. Flooring that to 1 made "we do not know
        // how long this was" indistinguishable from "this was a one-second
        // call", permanently and at import time, and it disagreed with the
        // preview, which shows the true 0.
        //
        // Nothing divides BY duration (checked across artifacts and lib): the
        // cost math multiplies and the bulk estimate sums, so 0 is safe in
        // both. It is also safer in the one place duration steers behaviour --
        // scaledPollTimeoutMs(0) gives the 120s default, while the fabricated
        // scaledPollTimeoutMs(1) gave 60s. The floor was handing a call of
        // unknown length a SHORTER timeout than "unknown" gets.
        durationSeconds: durationSecondsOf(call),
        audioObjectPath: recordingUrl,
        // Vapi's transcript goes in draftTranscript, never goldTranscript
        // (GOLD-01): it is the reviewer's starting point, not the reference.
        draftTranscript: draft ?? null,
        status: "ready_to_run",
        sourceProvider: "vapi",
        sourceCallId: call.id,
        sourceAccountLabel: account.label,
        sourceAssistantId: call.assistantId ?? null,
        sourceStartedAt: startedAt ? new Date(startedAt) : null,
        // Best-effort -- null when Vapi doesn't echo the assistant config
        // back on this call. See transcriberOf()'s comment in lib/vapi.ts.
        sourceTranscriberProvider: transcriber?.provider ?? null,
        sourceTranscriberModel: transcriber?.model ?? null,
        sourceEndedReason: call.endedReason ?? null,
        sourceSuccessEvaluation: successEvaluationOf(call),
        // M-7a: what production's own pipeline measured on this call, from
        // the same object the sidecar writer saves to disk seconds later --
        // so an imported call and a rescued one carry identical numbers.
        // Every one of these is null when Vapi measured nothing; see
        // lib/production-signals.ts for why null and not 0.
        ...readProductionSignals(call.artifact),
      })
      .returning();

    await writeAudit({
      entityType: "call",
      entityId: created.id,
      actorLabel,
      action: "import_vapi",
      afterState: serializeCall(created),
    });

    // T-127: save the audio bytes to the server's disk right now, while the
    // recording is certainly still alive at Vapi -- so a newly imported call
    // never sits on the 14-day retention countdown at all. A cache failure
    // must NOT fail the import (the call row is real either way); it is
    // named in the outcome message instead of being a silent gap. This
    // re-resolves a fresh URL via the same path every other cache write
    // uses (getOrCacheAudioBytes), so the player, the run executor and the
    // importer can never disagree about what "the audio" is.
    let message: string | null = null;
    try {
      await getOrCacheAudioBytes(created);
      await recordAudioCacheAttempt(created.id, "saved", null);
      // M-6: the caller-only channel, the assistant channel and the call
      // artifact, written from the SAME object the import already fetched --
      // its presigned links are minutes old here and dead within the hour.
      // Never fails the import: the corpus row and the mono mix are already
      // real, and a missing channel is said out loud rather than left as a
      // gap somebody discovers on the day they need the caller's voice.
      const sidecars = await cacheCallSidecars(created.id, call);
      const gaps = [
        ...sidecars.missing.map((channel) => `Vapi offered no ${channel} channel for it`),
        ...sidecars.errors,
      ];
      if (gaps.length > 0) {
        message = `Imported with its mono audio, but ${gaps.join("; ")}.`;
      }
    } catch (err) {
      log.warn({ err, callId: created.id }, "import: audio could not be cached at import time");
      const errText = err instanceof Error ? err.message : String(err);
      // T-131: remember what this attempt learned (permanent refusal vs
      // retryable), same as the rescue endpoint does.
      await recordAudioCacheAttempt(created.id, classifyAudioAttemptFailure(errText), errText);
      message = `Imported, but the audio could not be saved to the server yet (${errText}). The first run, or "Save audio now" on Calls, will try again.`;
    }

    return {
      vapiCallId,
      outcome: "imported",
      callId: created.id,
      label,
      message,
    };
  };

  // Bounded-parallel import (same worker pool the run executor uses). A
  // missing/invalid account key is fatal for every cell, so that one error
  // aborts the drain and surfaces to the caller -- tagged, because that is
  // the one failure the route answers as a Vapi failure. Anything else out of
  // the drain is a database or disk failure and keeps travelling untouched.
  const byId = new Map<string, ImportOutcome>();
  try {
    await drainWithConcurrency(
      input.vapiCallIds,
      VAPI_IMPORT_CONCURRENCY,
      async (vapiCallId) => {
        byId.set(vapiCallId, await importOne(vapiCallId));
      },
    );
  } catch (err) {
    if (err instanceof VapiConfigError) throw new VapiSourceError(err);
    throw err;
  }
  // Preserve request order so the UI table matches what the operator ticked.
  const results = input.vapiCallIds.map((id) => byId.get(id)!);

  return {
    importedCount: results.filter((r) => r.outcome === "imported").length,
    skippedCount: results.filter((r) => r.outcome.startsWith("skipped")).length,
    failedCount: results.filter((r) => r.outcome === "failed").length,
    results,
  };
}
