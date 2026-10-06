import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import { rendererConfig } from "./vite.shared";

// electron-vite 5's isolatedEntries draws a progress line with the terminal's cursor calls, and fails when the output is
// piped (scripts, CI): without a terminal those calls do nothing.
if (!process.stdout.isTTY) {
  const stdout = process.stdout as NodeJS.WriteStream;
  stdout.clearLine ??= () => true;
  stdout.cursorTo ??= () => true;
  stdout.moveCursor ??= () => true;
}

const preload = (role: string) => resolve(import.meta.dirname, `src/preload/${role}.ts`);

// main is built for Node (Electron's own modules stay outside the bundle) with a second entry, the store's utility
// process (out/main/store.js, docs/data-impl.md; its compactor worker runs the same bundle); the renderer is the app
// (see vite.shared.ts). Each view role has its own preload, each a bundle of its own: a sandboxed preload can't load a
// shared chunk.
const main = (file: string) => resolve(import.meta.dirname, file);

export default defineConfig(({ mode }) => ({
  main: { build: { externalizeDeps: true, rollupOptions: { input: { index: main("src/main/index.ts"), store: main("src/store/index.ts") } } } },
  preload: {
    build: {
      externalizeDeps: true,
      isolatedEntries: true,
      rollupOptions: { input: { tabbar: preload("tabbar"), home: preload("home"), editor: preload("editor") } },
    },
  },
  renderer: rendererConfig(mode),
}));
