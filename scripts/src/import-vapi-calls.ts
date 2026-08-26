// CLI front-end for the Vapi importer (COR-01).
//
// This is a thin wrapper over the API server's own routes
// (POST /benchmark/vapi/preview and /import) rather than a second
// implementation: the server owns the Vapi credentials, the duplicate check,
// and the provenance columns, so a CLI that talked to Vapi directly would
// drift from the UI at "Import Calls".
//
// The Vapi API key lives on the API server as an env var; this script never
// sees it. Pick which account to pull from with --account=<id>.
//
// Nothing here de-identifies, approves, or writes a gold transcript: imported
// calls land in needs_review and still need the human gold pass plus the
// two-person de-id gate before any run can use them.
//
// Usage:
//   API_BASE_URL=http://localhost:8177/api \
//     pnpm --filter @workspace/scripts import:vapi -- \
//     --vertical=rush [--account=default] [--limit=20] \
//     [--start=2026-08-01] [--end=2026-08-21] [--assistant-id=xxx] [--apply]
//
// Without --apply this only prints what WOULD be imported (dry run).

type Vertical = "rush" | "property_management" | "trucking";

type Args = {
  vertical: Vertical;
  account?: string;
  limit: number;
  start?: string;
  end?: string;
  assistantId?: string;
  apply: boolean;
};

type VapiAccount = {
  id: string;
  label: string;
  envVar: string;
  keyFingerprint: string;
};

type PreviewCall = {
  vapiCallId: string;
  assistantId?: string | null;
  startedAt?: string | null;
  durationSeconds: number;
  hasRecording: boolean;
  draftTranscriptChars: number;
  alreadyImported: boolean;
};

type PreviewResult = {
  accountId: string;
  accountLabel: string;
  fetchedCount: number;
  importableCount: number;
  calls: PreviewCall[];
};

type ImportResult = {
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  results: Array<{
    vapiCallId: string;
    outcome: string;
    callId?: string | null;
    label?: string | null;
    message?: string | null;
  }>;
};

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:8177/api";

function parseArgs(): Args {
  const raw = process.argv.slice(2);
  const get = (flag: string) => {
    const match = raw.find((a) => a.startsWith(`--${flag}=`));
    return match?.split("=").slice(1).join("=");
  };
  const vertical = get("vertical");
  if (
    vertical !== "rush" &&
    vertical !== "property_management" &&
    vertical !== "trucking"
  ) {
    throw new Error(
      "Usage: --vertical=rush|property_management|trucking [--account=default] " +
        "[--limit=20] [--start=YYYY-MM-DD] [--end=YYYY-MM-DD] [--assistant-id=xxx] [--apply]",
    );
  }
  return {
    vertical,
    account: get("account"),
    limit: Number(get("limit") ?? "20"),
    start: get("start"),
    end: get("end"),
    assistantId: get("assistant-id"),
    apply: raw.includes("--apply"),
  };
}

/** Local-timezone day boundary, matching what the Import Calls page sends. */
function dayBoundaryIso(
  value: string | undefined,
  edge: "start" | "end",
): string | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid date "${value}" -- expected YYYY-MM-DD.`);
  }
  const date =
    edge === "start"
      ? new Date(year, month - 1, day, 0, 0, 0, 0)
      : new Date(year, month - 1, day, 23, 59, 59, 999);
  return date.toISOString();
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-actor": "vapi-importer-cli",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`${path} returned HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(
    `\n⚠️  This pulls REAL call recordings from Vapi. Nothing is de-identified or\n` +
      `   approved by this script -- every imported call lands in needs_review and\n` +
      `   requires the two-person de-id gate + human gold transcript before it can\n` +
      `   be used in a run (see docs/data-governance.md).\n`,
  );

  const accounts = await api<VapiAccount[]>("/benchmark/vapi/accounts");
  if (accounts.length === 0) {
    throw new Error(
      "No Vapi accounts configured on the API server. Set VAPI_API_KEY (or " +
        "VAPI_API_KEY_<LABEL>) in the server's environment and restart it.",
    );
  }
  const account = args.account
    ? accounts.find((a) => a.id === args.account)
    : accounts[0];
  if (!account) {
    throw new Error(
      `Unknown account "${args.account}". Available: ${accounts.map((a) => a.id).join(", ")}`,
    );
  }
  console.log(
    `Account: ${account.label} (${account.id}, from ${account.envVar}, key ${account.keyFingerprint})\n`,
  );

  const preview = await api<PreviewResult>("/benchmark/vapi/preview", {
    method: "POST",
    body: JSON.stringify({
      accountId: account.id,
      limit: args.limit,
      startDate: dayBoundaryIso(args.start, "start"),
      endDate: dayBoundaryIso(args.end, "end"),
      assistantId: args.assistantId,
    }),
  });

  console.log(
    `Fetched ${preview.fetchedCount} call(s), ${preview.importableCount} importable ` +
      `(the rest are already in the corpus or have no recording).\n`,
  );

  const importable = preview.calls.filter(
    (c) => c.hasRecording && !c.alreadyImported,
  );

  for (const call of importable) {
    console.log(
      `  ${call.vapiCallId.slice(0, 8)}  ${call.startedAt ?? "unknown start"}  ` +
        `${call.durationSeconds}s  draft:${call.draftTranscriptChars} chars`,
    );
  }

  if (!args.apply) {
    console.log(
      `\nDry run only -- re-run with --apply to import these ${importable.length} call(s) ` +
        `as vertical "${args.vertical}".`,
    );
    return;
  }

  if (importable.length === 0) {
    console.log("Nothing to import.");
    return;
  }

  const result = await api<ImportResult>("/benchmark/vapi/import", {
    method: "POST",
    body: JSON.stringify({
      accountId: account.id,
      vertical: args.vertical,
      vapiCallIds: importable.map((c) => c.vapiCallId),
    }),
  });

  console.log(
    `\nimported: ${result.importedCount}  skipped: ${result.skippedCount}  failed: ${result.failedCount}`,
  );
  for (const row of result.results) {
    if (row.outcome === "imported") {
      console.log(`  created: ${row.label} -> ${row.callId}`);
    } else {
      console.log(
        `  ${row.outcome}: ${row.vapiCallId.slice(0, 8)}${row.message ? ` (${row.message})` : ""}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
