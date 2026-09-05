import { defineConfig } from "vitest/config";

// T-77: route-level tests against a THROWAWAY database. TEST_DATABASE_URL
// is required and must not be the working DATABASE_URL -- the tests insert
// and delete rows. In CI it is a postgres service container with the schema
// pushed by drizzle-kit; locally, a spare database on the dev container:
//
//   TEST_DATABASE_URL=postgres://.../stt_evals_test pnpm --filter @workspace/api-server run test:integration
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL must be set to a throwaway database for the integration tests");
if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
  throw new Error("TEST_DATABASE_URL equals DATABASE_URL -- refusing to run integration tests against the working database");
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.int.test.ts"],
    // M-6c: names the request behind a "socket hang up", which node's
    // client-side error cannot.
    setupFiles: ["./src/routes/__integration__/setup.ts"],
    env: { DATABASE_URL: url, LOG_LEVEL: process.env.LOG_LEVEL ?? "silent" },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
