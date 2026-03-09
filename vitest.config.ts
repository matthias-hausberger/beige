import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/cli.ts", "src/index.ts"],
    },
    // Use fake timers for time-dependent tests
    fakeTimers: { toFake: ["Date"] },
    // Timeout for async operations
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
