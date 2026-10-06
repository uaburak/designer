import { readFileSync } from "node:fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { rendererConfig } from "./vite.shared";

/** The sign-in page in the browser loads this Firebase from Google's CDN — the same version the app runs (see main/signIn.ts). */
const firebaseVersion: string = JSON.parse(readFileSync(new URL("./node_modules/firebase/package.json", import.meta.url), "utf8")).version;

// main and preload are built for Node (Electron's own modules stay outside the bundle); the renderer is the app (see vite.shared.ts).
export default defineConfig(({ mode }) => ({
  main: { plugins: [externalizeDepsPlugin()], define: { __FIREBASE_VERSION__: JSON.stringify(firebaseVersion) } },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: rendererConfig(mode),
}));
