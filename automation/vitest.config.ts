import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The `*.live.test.ts` integration tests share one local validator and one
    // keypair; running files in parallel races their balance assertions.
    // Serialize file execution so they don't interfere (matches app/vitest.config.ts).
    fileParallelism: false,
  },
});
