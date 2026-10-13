/// <reference types="vitest/config" />
// The get.wecra.app pages (docs/site.md §2): a static multi-page build from `src/` into `dist/`, which the Worker
// (`worker/`, the channel's) serves as its assets.
//
// The scenes are React, drawn with the app's own design system and engine (`src/renderer/src/ds`,
// `src/renderer/src/engine`), read in place through the same `@/` and `@shared/` aliases the app uses. React,
// react-dom and the ds's own dependencies resolve from the repository root's node_modules (one React for the site
// and the ds): run `npm install` at the root before building the site.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const src = resolve(here, "src");
const partials = resolve(src, "partials");
const renderer = resolve(repo, "src/renderer/src");
const shared = resolve(repo, "src/shared");
const rootModules = resolve(repo, "node_modules");

const pages = {
  home: "index.html",
  features: "features/index.html",
  ai: "ai/index.html",
  download: "download/index.html",
  changelog: "changelog/index.html",
  notFound: "404.html",
};

/** `<!--#include name -->` pulls `src/partials/<name>.html` in (nested includes too), and the header's
 *  link to the current section gets `aria-current="page"`. */
function includes(): Plugin {
  const expand = (html: string, depth = 0): string =>
    html.replace(/<!--#include ([\w/-]+) -->/g, (_, name: string) => {
      if (depth > 4) throw new Error(`include too deep: ${name}`);
      return expand(readFileSync(resolve(partials, `${name}.html`), "utf8"), depth + 1);
    });
  return {
    name: "wecra-includes",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const section = ctx.path.split("/").filter(Boolean)[0] ?? "";
        return expand(html).replace(/data-nav="([\w-]+)"/g, (all, name: string) =>
          name === section ? `${all} aria-current="page"` : all,
        );
      },
    },
    handleHotUpdate({ file, server }) {
      if (file.startsWith(partials)) server.ws.send({ type: "full-reload" });
    },
  };
}

/** `npm run dev`: `/api/releases` from a fixture, and the download routes back to /download/.
 *  `MOCK_RELEASES=empty` or `=error` shows the other states. `POST /__still/<name>` (dev only) saves the WebP a
 *  scene sent (a still frame the engine drew, `public/stills/<name>.webp`). */
function devApi(): Plugin {
  return {
    name: "wecra-dev-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (url === "/api/releases") {
          const mode = process.env.MOCK_RELEASES;
          if (mode === "error") {
            res.statusCode = 500;
            res.end("mock error");
            return;
          }
          const body = mode === "empty" ? '{"releases":[]}' : readFileSync(resolve(src, "dev/releases.json"), "utf8");
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(body);
          return;
        }
        if (url === "/download/mac" || url === "/download/windows") {
          res.statusCode = 302;
          res.setHeader("Location", "/download/?dev-download=" + url.slice(10));
          res.end();
          return;
        }
        const still = /^\/__still\/([\w-]+)$/.exec(url);
        if (still && req.method === "POST") {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            const dir = resolve(here, "public/stills");
            mkdirSync(dir, { recursive: true });
            writeFileSync(resolve(dir, `${still[1]}.webp`), Buffer.concat(chunks));
            res.end("ok");
          });
          return;
        }
        next();
      });
    },
  };
}

/** Every `"16.x"` / `"24.x"` icon name written in the site's code or in the app code it draws with. */
function usedIconNames(): Set<string> {
  const names = new Set<string>();
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (entry === "node_modules" || entry === "__tests__" || entry === "svg") continue;
      if (statSync(path).isDirectory()) scan(path);
      else if (/\.tsx?$/.test(entry) && !entry.endsWith("registry.ts"))
        for (const m of readFileSync(path, "utf8").matchAll(/["'`]((?:16|24|32)\.[a-z0-9.\-]+)["'`]/g)) names.add(m[1]);
    }
  };
  for (const dir of [src, resolve(renderer, "ds"), resolve(renderer, "editor/panels/agents")]) if (existsSync(dir)) scan(dir);
  return names;
}

/**
 * The ds's icon registry holds every chrome icon (150 KB); the site keeps the ones its code and the ds components it
 * uses name (the same entries, untouched). An icon named only at run time (a template string) would draw nothing:
 * write such names out in full.
 */
function iconSubset(): Plugin {
  const registry = resolve(renderer, "ds/icons/registry.ts");
  return {
    name: "wecra-icon-subset",
    apply: "build",
    enforce: "pre",
    load(id) {
      if (id.split("?")[0] !== registry) return null;
      const used = usedIconNames();
      const lines = readFileSync(registry, "utf8").split("\n");
      return lines.filter((line) => {
        const m = /^\s+"((?:16|24|32)\.[^"]+)":/.exec(line);
        return !m || used.has(m[1]);
      }).join("\n");
    },
  };
}

/**
 * Modules of the app swapped for the site's stand-ins (`src/shims/`), where the real one reaches for the desktop or
 * the store; each shim says why. The app's files themselves are never changed.
 */
const SHIMS: Record<string, string> = {
  // The engine's web font source (the web app's account and server): the site draws with the bundled Inter only.
  "engine/webFonts.ts": "shims/webFonts.ts",
  // The Agents chat's service (the store, the engine, the CLIs): the Studio cards get a scripted stand-in.
  "editor/agents/service.ts": "shims/agentsService.ts",
  // Manager settings read main's image routes over IPC; the site lists them itself.
  "editor/panels/agents/ManagerSettings.tsx": "shims/managerSettings.ts",
  // The brand and product forms write to the store.
  "editor/studio/forms.tsx": "shims/studioForms.tsx",
};

function shims(): Plugin {
  const map = new Map(Object.entries(SHIMS).map(([from, to]) => [resolve(renderer, from), resolve(src, to)]));
  return {
    name: "wecra-shims",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith("\0")) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const target = resolved && map.get(resolved.id.split("?")[0]);
      return target ?? null;
    },
  };
}

export default defineConfig({
  root: src,
  publicDir: resolve(here, "public"),
  appType: "mpa",
  plugins: [includes(), devApi(), iconSubset(), shims(), react() as unknown as Plugin],
  resolve: {
    alias: [
      { find: /^@shared\//, replacement: `${shared}/` },
      { find: /^@\//, replacement: `${renderer}/` },
      { find: /^react$/, replacement: resolve(rootModules, "react") },
      { find: /^react\/(.*)$/, replacement: `${resolve(rootModules, "react")}/$1` },
      { find: /^react-dom$/, replacement: resolve(rootModules, "react-dom") },
      { find: /^react-dom\/(.*)$/, replacement: `${resolve(rootModules, "react-dom")}/$1` },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: { fs: { allow: [repo] } },
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, resolve(src, v)])),
    },
  },
  test: {
    root: here,
    include: ["src/**/*.test.ts"],
  },
});
