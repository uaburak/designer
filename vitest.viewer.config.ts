import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// npm run viewer:check — the exported preview HTML opened in headless Chromium (src/viewer/testing/*.check.ts).
// Not part of npm test: it needs the built viewer (out/viewer) and a browser.
export default defineConfig({
  resolve: { alias: { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)), "@": fileURLToPath(new URL("./src/renderer/src", import.meta.url)) } },
  test: { environment: "node", include: ["src/**/*.check.ts"], fileParallelism: false, testTimeout: 180_000 },
});
