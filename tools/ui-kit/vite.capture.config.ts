import { defineConfig } from "vite";
import { rendererConfig } from "../../vite.shared";

// The renderer in a browser for tools/ui-kit/capture.mjs: vite.web.config.ts with a cache of its own, so it never
// fights another dev server over node_modules/.vite. `npx vite --config tools/ui-kit/vite.capture.config.ts --mode demo`
export default defineConfig(({ mode }) => ({
  root: "src/renderer",
  ...rendererConfig(mode),
  cacheDir: "../../node_modules/.vite-uikit",
  server: { ...rendererConfig(mode).server, port: 5202, strictPort: true },
}));
