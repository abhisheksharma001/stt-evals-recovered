import { defineConfig } from "vitest/config";

// T-26: only the offline contract tests live here. Nothing under src/ that
// touches the database or a provider is a vitest target.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
