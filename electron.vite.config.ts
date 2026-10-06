import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import { rendererConfig } from "./vite.shared";

/** The sign-in page in the browser loads this Firebase from Google's CDN — the same version the app runs (see main/signIn.ts). */
const firebaseVersion: string = JSON.parse(readFileSync(new URL("./node_modules/firebase/package.json", import.meta.url), "utf8")).version;

// electron-vite 5's isolatedEntries draws a progress line with the terminal's cursor calls, and fails when the output is
// piped (scripts, CI): without a terminal those calls do nothing.
if (!process.stdout.isTTY) {
  const stdout = process.stdout as NodeJS.WriteStream;
  stdout.clearLine ??= () => true;
  stdout.cursorTo ??= () => true;
  stdout.moveCursor ??= () => true;
}

const preload = (role: string) => resolve(import.meta.dirname, `src/preload/${role}.ts`);

// main is built for Node (Electron's own modules stay outside the bundle); the renderer is the app (see vite.shared.ts).
// Each view role has its own preload, each a bundle of its own: a sandboxed preload can't load a shared chunk.
export default defineConfig(({ mode }) => ({
  main: { build: { externalizeDeps: true }, define: { __FIREBASE_VERSION__: JSON.stringify(firebaseVersion) } },
  preload: {
    build: {
      externalizeDeps: true,
      isolatedEntries: true,
      rollupOptions: { input: { tabbar: preload("tabbar"), home: preload("home"), editor: preload("editor") } },
    },
  },
  renderer: rendererConfig(mode),
}));
