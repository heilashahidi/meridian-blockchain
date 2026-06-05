import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Use the automatic JSX runtime so .tsx test files (and the components they
  // render) transpile without a global `React` in scope. The app itself builds
  // via Next's own toolchain; this only affects vitest's esbuild transform.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Match .tsx too so component/render tests (e.g. the wallet-gating test,
    // which sets `// @vitest-environment jsdom` per-file) are picked up.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // The `*.live.test.ts` integration tests share one local validator and one
    // keypair; running files in parallel races their balance assertions. Serialize
    // file execution so they don't interfere. The pure tests are fast regardless.
    fileParallelism: false,
  },
});
