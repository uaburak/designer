import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { rendererConfig } from "./vite.shared";

/**
 * The developer preview viewer (src/viewer, docs/data.md §13) as ONE self-contained page, out/viewer/index.html: its
 * JS and CSS inlined, fonts and images as data URLs, the engine's Wasm as a base64 block the viewer instantiates
 * from bytes — so the store can add a preview's data to it and the result opens from file:// (Export preview as
 * HTML…), and the same page serves Firebase Hosting (`/p/<id>`).
 *
 *   npm run build:viewer      build it (npm run build does too)
 *   npm run viewer            dev server (http://localhost:5231/?src=<folder with a preview's files>)
 */
const outDir = fileURLToPath(new URL("./out/viewer", import.meta.url));
const bootJs = fileURLToPath(new URL("./src/renderer/public/boot.js", import.meta.url));
const previewConfig = fileURLToPath(new URL("./firebase/preview-config.json", import.meta.url));

/** The theme's boot script inline (the page has no other files). */
function inlineBoot(): Plugin {
  return {
    name: "designer-viewer-boot",
    transformIndexHtml: { order: "pre", handler: (html) => html.replace('<script src="./boot.js"></script>', () => `<script>${readFileSync(bootJs, "utf8")}</script>`) },
  };
}

/** The italic Inter isn't shipped: the viewer binds the upright one only (src/viewer/fonts.ts). */
function noItalicInter(): Plugin {
  const id = "\0viewer-no-italic-inter";
  return {
    name: "designer-viewer-no-italic",
    apply: "build",
    enforce: "pre",
    resolveId: (source) => (source.includes("InterVariable-Italic.ttf") ? id : null),
    load: (source) => (source === id ? 'export default "data:,"' : null),
  };
}

/**
 * Once the bundle is written: the page's scripts, styles and the Wasm moved into index.html, their files removed.
 * In `writeBundle` (after every file of this output is on disk), not `closeBundle`: Vite calls closeBundle after a
 * failed build too, and from a build that wrote nothing it read a missing index.html (ENOENT) instead of reporting
 * the build's own error.
 */
function singleFile(): Plugin {
  return {
    name: "designer-viewer-single-file",
    apply: "build",
    writeBundle: {
      order: "post",
      sequential: true,
      handler() {
        const htmlPath = join(outDir, "index.html");
        if (!existsSync(htmlPath)) throw new Error(`viewer build: ${htmlPath} wasn't written`);
        let html = readFileSync(htmlPath, "utf8");
        const assets = join(outDir, "assets");
        const files = readdirSync(assets);
        for (const f of files.filter((x) => x.endsWith(".css"))) {
          const css = readFileSync(join(assets, f), "utf8");
          html = html.replace(new RegExp(`<link rel="stylesheet"[^>]*href="[^"]*${f.replace(/\./g, "\\.")}"[^>]*>`), () => `<style>${css}</style>`);
        }
        for (const f of files.filter((x) => x.endsWith(".js"))) {
          const js = readFileSync(join(assets, f), "utf8").replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
          html = html.replace(new RegExp(`<script type="module" crossorigin src="[^"]*${f.replace(/\./g, "\\.")}"></script>`), () => `<script type="module">${js}</script>`);
        }
        // The module script stays where Vite put it (head); modules run after parsing, when the data block is there.
        const wasm = files.find((x) => x.endsWith(".wasm"));
        if (!wasm) throw new Error("viewer build: no engine.wasm asset");
        const b64 = readFileSync(join(assets, wasm)).toString("base64");
        if (!html.includes("<!--designer:preview-data-->")) throw new Error("viewer build: the data placeholder is gone");
        html = html.replace("<!--designer:preview-data-->", () => `<script id="designer-engine-wasm" type="application/octet-stream">${b64}</script>\n    <!--designer:preview-data-->`);
        if (/<link rel="(stylesheet|modulepreload)"|<script[^>]+src=/.test(html)) throw new Error("viewer build: a file was left outside the page");
        writeFileSync(htmlPath, html);
        rmSync(assets, { recursive: true, force: true });
        // Firebase Hosting: where previews are stored (the owner's firebase/preview-config.json, never committed).
        if (existsSync(previewConfig)) copyFileSync(previewConfig, join(outDir, "preview-config.json"));
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const base = rendererConfig(mode);
  return {
    ...base,
    root: "src/viewer",
    base: "./",
    publicDir: false,
    plugins: [...(base.plugins ?? []), inlineBoot(), noItalicInter(), singleFile()],
    build: {
      ...base.build,
      outDir,
      emptyOutDir: true,
      // Everything but the Wasm becomes a data URL (fonts, icons); the Wasm is inlined as bytes by singleFile().
      assetsInlineLimit: (file: string) => !file.endsWith(".wasm"),
      cssCodeSplit: false,
      modulePreload: false,
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
    // A single-threaded page: no cross-origin isolation needed (Firebase Hosting sets the headers anyway).
    server: { port: 5231, strictPort: true },
  };
});
