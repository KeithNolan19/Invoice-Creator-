import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // PGlite bundles a large WebAssembly module. Run test files sequentially in
    // one reused worker process to keep memory flat (parallel forks exhaust the
    // address space on Windows).
    pool: "forks",
    isolate: false,
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
