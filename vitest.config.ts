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
    // Generous because the deploy target is a 512 MB droplet where PGlite runs
    // through swap — migration-heavy files and createHarness hooks are slow
    // there. On a normal machine everything finishes in a fraction of this.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
