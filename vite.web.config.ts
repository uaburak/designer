import { defineConfig } from "vite";
import { rendererConfig } from "./vite.shared";

// The renderer alone, in a browser (`npm run web`, `npm run web:demo`): the app without Electron — the sign-in is a popup there.
export default defineConfig(({ mode }) => ({
  root: "src/renderer",
  ...rendererConfig(mode),
  server: { port: 5199, strictPort: true },
}));
