// Types of the Emscripten glue next to this file (engine.mjs + engine.wasm),
// built from engine/ by `npm run engine:build` (engine/tools/build.mjs).

export interface EngineModuleOptions {
  /** Where engine.wasm is (Vite resolves it through the glue's `new URL("engine.wasm", import.meta.url)` by default). */
  locateFile?: (path: string, prefix: string) => string;
  wasmBinary?: ArrayBuffer;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  onAbort?: (what: unknown) => void;
}

/** The instantiated module: its heap views (re-read after every call: memory growth replaces them) and its exports. */
export interface EngineWasm {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
  /** ImageBitmaps the engine uploads from JavaScript (engine_image_add_bitmap), by id. Set by Engine.ts. */
  engineBitmaps?: Record<number, ImageBitmap>;
  _malloc(size: number): number;
  _free(ptr: number): void;
  [exported: `_engine_${string}`]: (...args: number[]) => number;
}

declare function createEngineModule(options?: EngineModuleOptions): Promise<EngineWasm>;
export default createEngineModule;
