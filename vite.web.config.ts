import { defineConfig } from "vite";
import { rendererConfig } from "./vite.shared";

// The renderer alone, in a browser (`npm run web`): `?files` (Home, on an in-memory store), `?editor`, `?gallery`,
// `?engine`, `?tabbar` — no Electron, no store process.
export default defineConfig(({ mode }) => ({
  root: "src/renderer",
  ...rendererConfig(mode),
  server: { ...rendererConfig(mode).server, port: 5199, strictPort: true },
}));
