// The Worker's unit tests (from site/: npx vitest run --root worker). Its own config so the repository's root
// vitest.config.ts and the pages' vite.config.ts don't apply.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["**/*.test.ts"], environment: "node" },
});
