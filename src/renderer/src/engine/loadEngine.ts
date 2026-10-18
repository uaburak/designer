/**
 * Loads the engine's Wasm module once per renderer process (each file tab is a
 * process of its own, docs/engine.md §0) and checks that its ABI is the one
 * this TS was written against. An abort of the module (running out of memory,
 * a failed check) is told to whoever listens (onEngineAbort): every engine of
 * the process is gone then.
 */
import createEngineModule, { type EngineModuleOptions } from "./wasm/engine.mjs";
import { ABI_VERSION } from "./abi";
import { EngineExports } from "./EngineExports";

let loading: Promise<EngineExports> | null = null;
let aborted: { what: unknown; memoryBytes: number } | null = null;
let memoryOf: () => number = () => 0;
const abortListeners = new Set<(what: unknown, memoryBytes: number) => void>();

/** Called when the module aborts (at once when it already has); returns the unsubscribe. */
export function onEngineAbort(listener: (what: unknown, memoryBytes: number) => void): () => void {
  if (aborted) listener(aborted.what, aborted.memoryBytes);
  abortListeners.add(listener);
  return () => abortListeners.delete(listener);
}

/** The module (loaded on first use). `options` count on the first call only (tests pass `wasmBinary`). */
export function loadEngine(options: EngineModuleOptions = {}): Promise<EngineExports> {
  loading ??= createEngineModule({
    printErr: (text) => console.warn(`[engine] ${text}`),
    onAbort: (what) => {
      aborted = { what, memoryBytes: memoryOf() };
      for (const listener of [...abortListeners]) listener(aborted.what, aborted.memoryBytes);
    },
    ...options,
  }).then((module) => {
    memoryOf = () => module.HEAPU8?.byteLength ?? 0;
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
