/**
 * Loads the engine's Wasm module once per renderer process (each file tab is a
 * process of its own, docs/engine.md §0) and checks that its ABI is the one
 * this TS was written against.
 */
import createEngineModule, { type EngineModuleOptions } from "./wasm/engine.mjs";
import { ABI_VERSION } from "./abi";
import { EngineExports } from "./EngineExports";

let loading: Promise<EngineExports> | null = null;

/** The module (loaded on first use). `options` count on the first call only (tests pass `wasmBinary`). */
export function loadEngine(options: EngineModuleOptions = {}): Promise<EngineExports> {
  loading ??= createEngineModule({
    printErr: (text) => console.warn(`[engine] ${text}`),
    ...options,
  }).then((module) => {
    const exports = new EngineExports(module);
    const version = exports.abiVersion();
    if (version !== ABI_VERSION) throw new Error(`engine: ABI ${version}, expected ${ABI_VERSION} (rebuild with npm run engine:build)`);
    return exports;
  });
  loading.catch(() => {
    loading = null; // a later call tries again
  });
  return loading;
}
