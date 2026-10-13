/// <reference types="vitest/config" />
// The get.wecra.app pages (docs/site.md §2): a static multi-page build from `src/` into `dist/`,
// which the Worker (`worker/`, the channel's) serves as its assets.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "src");
const partials = resolve(src, "partials");

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
 *  `MOCK_RELEASES=empty` or `=error` shows the other states. */
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
        next();
      });
    },
  };
}

export default defineConfig({
  root: src,
  publicDir: resolve(here, "public"),
  appType: "mpa",
  plugins: [includes(), devApi()],
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, resolve(src, v)])),
    },
  },
  test: {
    root: here,
    include: ["src/**/*.test.ts"],
  },
});
