import { defineConfig } from "vitest/config";

// T-26: only the offline contract tests live here. Nothing under src/ that
// touches the database or a provider is a vitest target. Route-level tests
// against a throwaway database are *.int.test.ts and run through
// vitest.integration.config.ts (T-77).
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"], exclude: ["**/node_modules/**", "src/**/*.int.test.ts"] },
});
