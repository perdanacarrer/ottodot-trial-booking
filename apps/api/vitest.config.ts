import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
    // Run test files sequentially: each file resets the shared SQLite test
    // database, so files must not run concurrently against it.
    fileParallelism: false,
  },
});
