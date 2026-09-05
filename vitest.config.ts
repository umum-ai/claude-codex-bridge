import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/*.test.ts"],
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
    isolate: false,
    sequence: { shuffle: true },
    coverage: {
      provider: "v8",
      include: ["src/*.ts", "scripts/release.ts", "scripts/publish.ts"],
      reporter: ["text", "lcov"],
      thresholds: { perFile: true, lines: 90, functions: 90 },
    },
  },
});
