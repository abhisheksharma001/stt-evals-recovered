import path from "node:path";
import { defineConfig } from "vitest/config";

// T-121: unit tests for the pure logic under src/lib/ (chip buckets,
// catalog age, retention state) run in node. T-129: component tests
// (*.test.tsx) opt into jsdom with a per-file "@vitest-environment jsdom"
// pragma and render with @testing-library/react. The "@" alias matches the
// app's Vite config so components import the same way under test.
export default defineConfig({
  // The app compiles JSX with the automatic runtime (@vitejs/plugin-react);
  // vitest's esbuild must match or every .tsx test hits "React is not defined".
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { environment: "node", include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});
