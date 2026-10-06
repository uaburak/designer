import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Alias, UserConfig } from "vite";

const src = fileURLToPath(new URL("./src/renderer/src/", import.meta.url));
const shared = fileURLToPath(new URL("./src/shared/", import.meta.url));

/** `@/…` is the renderer's source, `@shared/…` what main, the preloads and the store share with it. */
const aliases: Alias[] = [
  { find: /^@shared\//, replacement: shared },
  { find: /^@\//, replacement: src },
];

/**
 * Cross-origin isolation in dev too (docs/desktop.md §12.3), as main's `app://` handler sends it for the built app:
 * the dev server's pages get `crossOriginIsolated` and SharedArrayBuffer like the real ones.
 * DESIGNER_CROSS_ORIGIN_ISOLATED=0 turns it off, as for the built app.
 */
export const isolationHeaders = (): Record<string, string> =>
  process.env.DESIGNER_CROSS_ORIGIN_ISOLATED === "0"
    ? {}
    : { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin" };

/**
 * The renderer's Vite settings — the same in Electron (electron.vite.config.ts) and in a browser (vite.web.config.ts).
 * The mode changes nothing today (`--mode demo` builds the same app; the store's samples come from DESIGNER_SEED).
 */
export function rendererConfig(_mode: string): UserConfig {
  const headers = isolationHeaders();
  return {
    resolve: { alias: aliases },
    plugins: [react()],
    build: { chunkSizeWarningLimit: 4000 },
    server: { headers },
    preview: { headers },
  };
}
