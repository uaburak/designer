import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { rendererConfig } from "./vite.shared";

/**
 * The web app (docs/cloud.md §7): the whole renderer built for a browser — Home, the editor, presentations — as the
 * Worker serves it at https://wecra.app. Output: out/web (the Worker's static assets, server/wrangler.jsonc):
 *
 *   out/web/index.html            the app (the Worker answers `/` and `/app/…` with it, no-cache)
 *   out/web/assets/…              hashed scripts, styles, the engine's Wasm, workers, fonts (immutable)
 *   out/web/boot.js               the theme's boot script (src/renderer/public)
 *   out/web/_viewer/index.html    the developer preview viewer (out/viewer, built first by `npm run build:viewer`)
 *
 *   npm run build:web             viewer + app (server: `npm run deploy` runs it before `wrangler deploy`)
 *
 * VITE_WECRA_WEB=1 makes it the product (app/webApp.ts `isWebApp`): the server is the page's own origin, the store the
 * account's Drafts from the server with an IndexedDB cache, only the product's routes.
 */
const root = fileURLToPath(new URL(".", import.meta.url));
const outDir = join(root, "out/web");
const viewer = join(root, "out/viewer/index.html");

/** The preview viewer beside the app (the Worker reads `/_viewer/index.html` for `/p/<id>` and `/embed/<key>`). */
function withViewer(): Plugin {
  return {
    name: "wecra-web-viewer",
    apply: "build",
    writeBundle: {
      order: "post",
      sequential: true,
      handler() {
        // onnxruntime's own bundle names its Wasm too (`new URL(…, import.meta.url)`): that copy goes, its references
        // become the CDN's (ortWasmFromCdn)
        const assets = join(outDir, "assets");
        for (const big of readdirSync(assets).filter((f) => /^ort-wasm-simd-threaded\.asyncify-[\w-]+\.wasm$/.test(f))) {
          for (const js of readdirSync(assets).filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))) {
            const path = join(assets, js);
            const text = readFileSync(path, "utf8");
            if (text.includes(big)) writeFileSync(path, text.split(`"/assets/${big}"`).join(JSON.stringify(ORT_WASM_CDN)));
          }
          rmSync(join(assets, big));
        }
        const left = readdirSync(assets).filter((f) => statSync(join(assets, f)).size > 25 * 1024 * 1024);
        if (left.length) throw new Error(`web build: over Workers Static Assets' 25 MiB a file: ${left.join(", ")}`);
        if (!existsSync(viewer)) throw new Error("web build: out/viewer/index.html is missing — npm run build:viewer first (npm run build:web does)");
        mkdirSync(join(outDir, "_viewer"), { recursive: true });
        copyFileSync(viewer, join(outDir, "_viewer", "index.html"));
      },
    },
  };
}

/**
 * onnxruntime-web's Wasm (27 MB) is over Workers Static Assets' 25 MiB a file: the web app takes the very same file of
 * the same version from jsDelivr (the page's CSP allows it). The models it runs come from the desktop's `aimodel://`, so
 * the web app's image tools and visual search don't load it today.
 */
const ORT_VERSION = (JSON.parse(readFileSync(join(root, "node_modules/onnxruntime-web/package.json"), "utf8")) as { version: string }).version;
export const ORT_WASM_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.asyncify.wasm`;
function ortWasmFromCdn(): Plugin {
  const id = "\0wecra-ort-wasm-cdn";
  return {
    name: "wecra-ort-wasm-cdn",
    apply: "build",
    enforce: "pre",
    resolveId: (source) => (/onnxruntime-web\/ort-wasm-simd-threaded\.asyncify\.wasm\?url$/.test(source) ? id : null),
    load: (source) => (source === id ? `export default ${JSON.stringify(ORT_WASM_CDN)};` : null),
  };
}

export default defineConfig(({ mode }) => {
  const base = rendererConfig(mode);
  return {
    ...base,
    root: "src/renderer",
    base: "/",
    define: { "import.meta.env.VITE_WECRA_WEB": JSON.stringify("1") },
    plugins: [...(base.plugins ?? []), ortWasmFromCdn(), withViewer()],
    worker: { plugins: () => [ortWasmFromCdn()] },
    build: { ...base.build, outDir, emptyOutDir: true, assetsDir: "assets", sourcemap: false },
    server: { ...base.server, port: 5198, strictPort: true },
  };
});
