import { defineConfig } from "vitest/config";

// T-121: unit tests for the pure logic under src/lib/ (chip buckets,
// catalog age, retention state). Node environment on purpose -- nothing
// here renders a component or touches the DOM; the pages call these
// functions and stay covered by the live browser pass each batch. Tests
// import their subject relatively, so no path-alias config is needed.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
