// The geometry comparator on any .fig (round 7, item 14): Figma's own fillGeometry / strokeGeometry against the
// engine's, node by node (engine/tests/unit/geometry.figma_golden.test.cpp). Writes the file as the native tests read
// it (the whole Message, blobs as base64: engine/tools/fig.mjs) into a scratch directory and runs the native test
// binary on it; prints the mean outline distance per kind and the worst nodes.
//
//   npm run engine:test            (once: builds engine/build/native-test/engine_tests)
//   node engine/tools/fig-geometry.mjs file.fig [--debug <guid>]
//
// Private files: the output names the file's layers — it goes to the terminal only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readFig } from "./fig.mjs";

const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const debugAt = args.indexOf("--debug");
const debug = debugAt >= 0 ? args.splice(debugAt, 2)[1] : "";
const file = args[0];
if (!file) {
  console.error("usage: node engine/tools/fig-geometry.mjs file.fig [--debug <guid>]");
  process.exit(2);
}
const binary = path.join(engine, "build/native-test/engine_tests");
if (!existsSync(binary)) {
  console.error("build the native tests first: npm run engine:test");
  process.exit(2);
}
const dir = mkdtempSync(path.join(tmpdir(), "fig-geometry-"));
try {
  const { message } = readFig(file);
  const json = path.join(dir, "file.full.json");
  writeFileSync(json, JSON.stringify(message));
  const out = execFileSync(binary, ["-tc=geometry comparator: any file*", "--no-version"], {
    env: { ...process.env, ENG_FIG_GEOMETRY: json, ENG_FIG_DEBUG: debug },
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  for (const line of out.split("\n")) {
    const m = /MESSAGE: (.*)$/.exec(line);
    if (m) console.log(m[1].replace(json, path.basename(file)));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
