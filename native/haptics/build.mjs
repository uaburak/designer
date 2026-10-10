/* global process, console */
// Builds native/haptics/haptics.node (docs/desktop.md §10.2 "Haptics"): the haptics addon, universal (arm64 + x86_64),
// macOS 11+. The built file is committed, so nothing builds at install; run this (`node native/haptics/build.mjs`) only
// after changing haptics.mm. Needs the Xcode command line tools and Node's headers (the running Node's own
// include/node, else node-gyp's cache).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("haptics: macOS only, nothing to build");
  process.exit(0);
}
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [join(dirname(process.execPath), "..", "include", "node"), join(homedir(), "Library", "Caches", "node-gyp", process.versions.node, "include", "node")];
const include = candidates.find((d) => existsSync(join(d, "node_api.h")));
if (!include) throw new Error(`haptics: node_api.h not found in ${candidates.join(" or ")}`);
const out = join(here, "haptics.node");
execFileSync(
  "xcrun",
  [
    "clang++",
    "-std=c++17",
    "-ObjC++",
    "-fobjc-arc",
    "-O2",
    "-arch", "arm64",
    "-arch", "x86_64",
    "-mmacosx-version-min=11.0",
    "-DNODE_GYP_MODULE_NAME=haptics",
    "-DNAPI_VERSION=8",
    "-I", include,
    "-bundle",
    "-undefined", "dynamic_lookup",
    "-framework", "AppKit",
    "-o", out,
    join(here, "haptics.mm"),
  ],
  { stdio: "inherit" }
);
console.log(`haptics: built ${out}`);
