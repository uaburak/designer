// The engine playground on its own: a Vite dev server rooted at
// src/renderer/src/engine/dev (http://localhost:5299). Run `npm run engine:watch`
// beside it to rebuild the Wasm on every engine change.
//
//   npm run engine:dev               serve
//   node scripts/engine-dev.mjs --build <outDir>   a static build (used by scripts/engine-shot.mjs)
import { fileURLToPath } from "node:url";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { build, createServer } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repo, "src/renderer/src/engine/dev");
const config = {
  configFile: false,
  root,
  plugins: [react()],
  resolve: { alias: [{ find: /^@\//, replacement: path.join(repo, "src/renderer/src") + "/" }] },
  server: { port: Number(process.env.PORT) || 5299, fs: { allow: [repo] } },
  logLevel: "info",
};

const buildAt = process.argv.indexOf("--build");
if (buildAt >= 0) {
  const outDir = path.resolve(process.argv[buildAt + 1] ?? path.join(repo, "engine/build/playground"));
  await build({ ...config, base: "./", build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 4000 } });
  console.log(`engine: playground built to ${outDir}`);
} else {
  const server = await createServer(config);
  await server.listen();
  server.printUrls();
}
