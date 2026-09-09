import { readFile, writeFile } from "node:fs/promises";
import { parseScoreInput, score } from "@workspace/scoring";

function usage(): never {
  throw new Error(
    "Usage: pnpm --filter @workspace/scripts score:stt -- <input.json> <output.json>",
  );
}

const [inputPath, outputPath] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!inputPath || !outputPath) usage();

const raw = await readFile(inputPath, "utf8");
// R-43 (ox-alpha B-63): both of these used to be one blind cast. A file that
// was not JSON at all, and a row missing a field, both surfaced as a
// TypeError from inside score() naming neither the file nor the row.
let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  throw new Error(
    `${inputPath}: not valid JSON -- ${err instanceof Error ? err.message : String(err)}`,
  );
}
const rows = parseScoreInput(parsed, inputPath);
const output = rows.map(score);
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
