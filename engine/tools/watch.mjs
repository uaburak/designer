#!/usr/bin/env node
// Rebuilds wasm-debug whenever engine/ sources or schema/ change (docs/engine.md §1.6).
// Run beside `npm run engine:dev` (or the app's dev server): Vite reloads on the new engine.mjs.
import { spawn } from "node:child_process";
import console from "node:console";
import { watch } from "node:fs";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(engineDir, "..");
const preset = process.argv[2] ?? "wasm-debug";
let timer = null;
let building = false;
let again = false;

function build() {
  if (building) {
    again = true;
    return;
  }
  building = true;
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(engineDir, "tools/build.mjs"), preset], { stdio: "inherit" });
  child.on("exit", (code) => {
    building = false;
    console.log(code === 0 ? `engine: rebuilt in ${Date.now() - started} ms` : "engine: build failed — waiting for changes");
    if (again) {
      again = false;
      build();
    }
  });
}

function changed(file) {
  if (!file || file.includes("build/") || file.endsWith("~")) return;
  clearTimeout(timer);
  timer = setTimeout(build, 150);
}

for (const dir of [path.join(engineDir, "src"), path.join(engineDir, "api"), path.join(engineDir, "cmake"), path.join(repo, "schema")])
  watch(dir, { recursive: true }, (_event, file) => changed(file ?? ""));
console.log(`engine: watching engine/src, engine/api, engine/cmake and schema/ (${preset})`);
build();
