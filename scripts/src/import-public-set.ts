// `stt-evals public-set` -- W-12a: the Pipecat public calibration set
// (docs/PRD-v8-watch.md §5 Part F, decision D-15).
//
// Pulls the 1,000 clips of pipecat-ai/stt-benchmark-data through the Hugging
// Face datasets-server rows API, registers each as a benchmark call with its
// human-reviewed gold, writes the clip into the API server's audio cache as
// both the mono file and the customer track (the clip IS the customer), and
// creates one bulk over every ready provider.
//
// Money: the bulk is the only thing here that spends (≈ $6.32 at the seven
// prices of 2026-09-14). The script prints the exact minutes and the priced
// estimate and STOPS unless --apply and --go-spend are both given; it refuses
// above the $7 ceiling D-15 set, when MAX_LIVE_BULKS live bulks already exist
// (creating an eleventh would evict a client's bulk, FR-BLK-10), or when the
// bulk already exists (one run only; a second is a new decision).
//
// Nothing here leaves the machine except requests to Hugging Face for public
// clips. The clips and transcripts stay in the gitignored cache (D-15).
//
// Usage:
//   API_BASE_URL=http://localhost:8177 \
//     pnpm --filter @workspace/scripts cli public-set [--apply --go-spend] \
//     [--cache-dir=<dir>] [--limit=N]
//
// env: HF_TOKEN (optional; raises the datasets-server rate limit, never printed).
import fs from "node:fs/promises";
import path from "node:path";
import {
  createBenchmarkCall,
  createBulk,
  listBenchmarkCalls,
  listBenchmarkProviders,
  listBulks,
} from "@workspace/api-client";

export const DATASET = "pipecat-ai/stt-benchmark-data";
export const ACCOUNT_LABEL = "Public: Pipecat 1k";
export const BULK_NAME = ACCOUNT_LABEL;
export const SOURCE_PROVIDER = "pipecat" as const;
export const VERTICAL = "public_benchmark" as const;
/** D-15: the delegated spend's hard ceiling, in cents. */
export const CEILING_CENTS = 700;
/** Mirrors `MAX_LIVE_BULKS` in artifacts/api-server/src/lib/bulks.ts (W-13:
 * 10). The API does not report its cap, so the number is repeated here;
 * FR-BLK-10 would otherwise evict a client's bulk to make room for this one. */
export const MAX_LIVE_BULKS = 10;
const PAGE = 100;

export type Clip = {
  sampleId: string;
  durationSeconds: number;
  transcription: string;
  audioUrl: string;
};

export type Plan = {
  clips: number;
  /** Sum of the dataset's own `duration_seconds`, in minutes. */
  exactMinutes: number;
  /** Sum after the server's per-call integer rounding, in minutes -- what the
   * bulk's own estimate will be priced from. */
  roundedMinutes: number;
  providers: Array<{ id: string; costPerMinute: number }>;
  /** Dollars per minute across the ready providers. */
  perMinute: number;
  estimateCents: number;
};

export function planFor(
  durations: number[],
  providers: Array<{ id: string; costPerMinute: number }>,
): Plan {
  const exactMinutes = durations.reduce((a, b) => a + b, 0) / 60;
  const roundedMinutes = durations.reduce((a, b) => a + Math.round(b), 0) / 60;
  const perMinute = providers.reduce((a, p) => a + p.costPerMinute, 0);
  return {
    clips: durations.length,
    exactMinutes,
    roundedMinutes,
    providers,
    perMinute,
    estimateCents: Math.round(exactMinutes * perMinute * 100),
  };
}

export type Gate =
  | { action: "dry-run"; reason: string }
  | { action: "go"; reason: string }
  | { action: "refuse"; reason: string };

/** The one decision that spends. Pure so the dry-run rule is testable and
 * removing the --go-spend check makes a test fail, not a card get charged. */
export function gate(input: {
  apply: boolean;
  goSpend: boolean;
  estimateCents: number;
  liveBulks: number;
  bulkExists: boolean;
  readyProviders: number;
}): Gate {
  if (input.readyProviders === 0) return { action: "refuse", reason: "no ready provider" };
  if (input.estimateCents > CEILING_CENTS) {
    return {
      action: "refuse",
      reason: `estimate ${cents(input.estimateCents)} is above the ${cents(CEILING_CENTS)} ceiling (D-15)`,
    };
  }
  if (input.bulkExists) {
    return { action: "refuse", reason: `a bulk named "${BULK_NAME}" already exists; D-15 allows one run` };
  }
  if (input.liveBulks >= MAX_LIVE_BULKS) {
    return {
      action: "refuse",
      reason: `${input.liveBulks} live bulks; one more would evict a client's bulk (FR-BLK-10)`,
    };
  }
  if (!input.apply || !input.goSpend) {
    return { action: "dry-run", reason: "re-run with --apply --go-spend to import and launch" };
  }
  return { action: "go", reason: "importing and launching" };
}

export function cents(n: number): string {
  return `$${(n / 100).toFixed(2)}`;
}

function flag(argv: string[], name: string): string | undefined {
  return argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

async function hf(url: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`${res.status} ${res.statusText} for ${url}`);
      }
      lastErr = new Error(`${res.status} ${res.statusText}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw new Error(`Hugging Face gave up after 6 tries: ${String(lastErr)}`);
}

type RowsPage = {
  rows: Array<{
    row: {
      sample_id: string;
      duration_seconds: number;
      transcription: string;
      audio: Array<{ src: string; type: string }>;
    };
  }>;
  num_rows_total: number;
};

async function fetchClips(limit: number | undefined): Promise<Clip[]> {
  const clips: Clip[] = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total && (limit === undefined || clips.length < limit)) {
    const url =
      `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}` +
      `&config=default&split=train&offset=${offset}&length=${PAGE}`;
    const page = (await (await hf(url)).json()) as RowsPage;
    total = page.num_rows_total;
    for (const { row } of page.rows) {
      const audio = row.audio[0];
      if (!audio) throw new Error(`row ${row.sample_id} has no audio`);
      clips.push({
        sampleId: row.sample_id,
        durationSeconds: row.duration_seconds,
        transcription: row.transcription,
        audioUrl: audio.src,
      });
    }
    offset += PAGE;
  }
  return limit === undefined ? clips : clips.slice(0, limit);
}

/** Same layout as artifacts/api-server/src/lib/audio-cache.ts: the mono mix
 * at `<id>.audio`, the caller-only track at `<id>.customer.audio`, 0600. */
async function writeClip(cacheDir: string, callId: string, bytes: Buffer): Promise<void> {
  for (const name of [`${callId}.audio`, `${callId}.customer.audio`]) {
    await fs.writeFile(path.join(cacheDir, name), bytes, { mode: 0o600 });
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function runPublicSet(argv: string[]): Promise<number> {
  const apply = argv.includes("--apply");
  const goSpend = argv.includes("--go-spend");
  const limitRaw = flag(argv, "limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    throw new Error(`--limit must be a positive integer, got "${limitRaw}"`);
  }
  const cacheDir =
    flag(argv, "cache-dir") ??
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../artifacts/api-server/audio-cache");

  console.log(`dataset: ${DATASET}  cache: ${cacheDir}${limit ? `  limit: ${limit}` : ""}`);
  const clips = await fetchClips(limit);

  const providers = (await listBenchmarkProviders())
    .filter((p) => p.status === "ready")
    .map((p) => ({ id: p.id, costPerMinute: p.costPerMinute }));
  const plan = planFor(
    clips.map((c) => c.durationSeconds),
    providers,
  );

  const bulks = await listBulks();
  const bulkExists = bulks.some((b) => b.name === BULK_NAME);
  const existing = await listBenchmarkCalls({ vertical: VERTICAL });
  const bySample = new Map(existing.map((c) => [c.sourceCallId ?? "", c]));
  let cached = 0;
  for (const c of existing) {
    if (await exists(path.join(cacheDir, `${c.id}.customer.audio`))) cached++;
  }

  console.log(
    `\nclips: ${plan.clips}  minutes: ${plan.exactMinutes.toFixed(1)} (exact)  ` +
      `${plan.roundedMinutes.toFixed(1)} (after per-call rounding)`,
  );
  for (const p of plan.providers) console.log(`  ${p.id.padEnd(28)} $${p.costPerMinute.toFixed(4)}/min`);
  console.log(
    `${plan.providers.length} ready providers, $${plan.perMinute.toFixed(4)}/min summed -> ` +
      `estimate ${cents(plan.estimateCents)} (ceiling ${cents(CEILING_CENTS)})`,
  );
  console.log(
    `live bulks: ${bulks.length}/${MAX_LIVE_BULKS}  bulk "${BULK_NAME}": ${bulkExists ? "exists" : "absent"}  ` +
      `public calls in corpus: ${existing.length} (${cached} with audio)`,
  );

  const decision = gate({
    apply,
    goSpend,
    estimateCents: plan.estimateCents,
    liveBulks: bulks.length,
    bulkExists,
    readyProviders: plan.providers.length,
  });
  console.log(`\n${decision.action}: ${decision.reason}`);
  if (decision.action === "refuse") return 1;
  if (decision.action === "dry-run") return 0;

  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  let created = 0;
  let written = 0;
  for (const [i, clip] of clips.entries()) {
    let call = bySample.get(clip.sampleId);
    if (!call) {
      call = await createBenchmarkCall({
        label: `pipecat ${clip.sampleId.slice(0, 8)}`,
        vertical: VERTICAL,
        durationSeconds: clip.durationSeconds,
        goldTranscript: clip.transcription,
        sourceProvider: SOURCE_PROVIDER,
        sourceCallId: clip.sampleId,
        sourceAccountLabel: ACCOUNT_LABEL,
      });
      bySample.set(clip.sampleId, call);
      created++;
    }
    if (!(await exists(path.join(cacheDir, `${call.id}.customer.audio`)))) {
      const bytes = Buffer.from(await (await hf(clip.audioUrl)).arrayBuffer());
      await writeClip(cacheDir, call.id, bytes);
      written++;
    }
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${clips.length}  created ${created}  audio written ${written}`);
  }
  console.log(`\ncalls created: ${created}  audio written: ${written}  (skipped what already existed)`);

  const bulk = await createBulk({
    name: BULK_NAME,
    criteria: { accountLabel: ACCOUNT_LABEL, requireCustomerAudio: true, minCustomerWords: 0 },
    providerIds: plan.providers.map((p) => p.id),
    minDurationSeconds: 0,
    maxDurationSeconds: null,
  });
  const selected = bulk.selectionCriteria.resolvedCallIds?.length ?? 0;
  console.log(
    `bulk ${bulk.id} "${bulk.name}" ${bulk.status}: ${selected} calls, ` +
      `server estimate ${bulk.estimatedCostCents === null || bulk.estimatedCostCents === undefined ? "n/a" : cents(bulk.estimatedCostCents)}`,
  );
  return 0;
}
