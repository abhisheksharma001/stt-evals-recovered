// W-10: the MCP server is a client of the API, never part of it
// (docs/integration-strategy.md: "MCP must never be included in a
// benchmark-run code path"). scripts/check-import-cycles.mjs follows relative
// specifiers only, so a package import of @workspace/mcp-server from a
// deployable artifact would walk straight past it. This greps every tracked
// file under artifacts/ for the package name instead and fails on any hit.
//
// Usage: node scripts/check-mcp-boundary.mjs   (exit 1 on any hit)
import { execFileSync } from "node:child_process";

let hits = "";
try {
  hits = execFileSync("git", ["grep", "-n", "mcp-server", "--", "artifacts/"], { encoding: "utf8" });
} catch (err) {
  // git grep exits 1 when nothing matches; anything else is a real failure.
  if (err.status !== 1) throw err;
}

if (hits.trim()) {
  console.error("artifacts/ must never reference the MCP server (W-10, docs/integration-strategy.md):");
  console.error(hits.trim());
  process.exit(1);
}
console.log("ok: nothing under artifacts/ references mcp-server");
