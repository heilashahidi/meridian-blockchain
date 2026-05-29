import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The `*.live.test.ts` integration tests share one local validator and one
    // keypair; running files in parallel races their balance assertions. Serialize
    // file execution so they don't interfere. The pure tests are fast regardless.
    fileParallelism: false,
  },
});
