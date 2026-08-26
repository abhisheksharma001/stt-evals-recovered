import { readFile, writeFile } from "node:fs/promises";
import { score, type ScoreInput } from "@workspace/scoring";

function usage(): never {
  throw new Error(
    "Usage: pnpm --filter @workspace/scripts score:stt -- <input.json> <output.json>",
  );
}

const [inputPath, outputPath] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!inputPath || !outputPath) usage();

const raw = await readFile(inputPath, "utf8");
const input = JSON.parse(raw) as ScoreInput | ScoreInput[];
const rows = Array.isArray(input) ? input : [input];
const output = rows.map(score);
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
