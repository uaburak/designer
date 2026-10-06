import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Alias, UserConfig } from "vite";

const src = (path: string) => fileURLToPath(new URL(`./src/renderer/src/${path}`, import.meta.url));
const shared = fileURLToPath(new URL("./src/shared/", import.meta.url));

/**
 * `@/…` is the renderer's source. In the demo (`--mode demo`) the data, the
 * files and the sign-in are the demo's — kept in this computer's storage, no
 * Firebase — and nothing else changes.
 */
function aliases(demo: boolean): Alias[] {
  const swapped: Alias[] = demo
    ? [
        { find: /^@\/lib\/firestore$/, replacement: src("demo/firestore.ts") },
        { find: /^@\/lib\/storage$/, replacement: src("demo/storage.ts") },
        { find: /^@\/lib\/auth$/, replacement: src("demo/auth.ts") },
      ]
    : [];
  return [...swapped, { find: /^@shared\//, replacement: shared }, { find: /^@\//, replacement: src("") }];
}

/** The renderer's Vite settings — the same in Electron (electron.vite.config.ts) and in a browser (vite.web.config.ts). */
export function rendererConfig(mode: string): UserConfig {
  const demo = mode === "demo";
  return {
    resolve: { alias: aliases(demo) },
    plugins: [react(), tailwindcss()],
    define: { __DEMO__: JSON.stringify(demo) },
    build: { chunkSizeWarningLimit: 4000 },
  };
}
