// W-10: stdio entry point. Reads exactly one env var, API_BASE_URL (the API
// server's origin; a trailing /api is stripped, as the CLI does). stdout is
// the protocol channel, so nothing here may print to it.
//
//   API_BASE_URL=http://localhost:8177 pnpm --silent --filter @workspace/mcp-server start
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setBaseUrl } from "@workspace/api-client";
import { createServer } from "./server";

const base = (process.env.API_BASE_URL ?? "http://localhost:8177").replace(/\/api\/?$/, "");
setBaseUrl(base);

await createServer().connect(new StdioServerTransport());
