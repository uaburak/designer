/**
 * Which GPU backend the engine's canvas uses (docs/engine.md §6.1), as Figma chooses
 * (docs/research/figma/R10-webgpu.md): WebGPU when the browser has it and the device isn't blocklisted, else
 * WebGL2; a WebGPU session that fails (device lost, or the engine's self test after start) moves to WebGL2 and the
 * machine counts a fallback — Figma blocklists devices by how often they fall back, here this machine stops trying
 * WebGPU after a few.
 *
 * WebGPU's adapter and device requests are promises and the engine's calls synchronous: the GPUDevice is requested
 * here, before engine_create, and handed over as Module.engineGpuDevice (one per renderer process, shared by its
 * engines).
 *
 * Debug switch: `?gfx=webgl` / `?gfx=webgpu` in the page's URL (or EngineOptions.gfx). `webgpu` skips the blocklist.
 */
import type { EngineWasm } from "./wasm/engine.mjs";

export type GfxBackend = "webgpu" | "webgl2";
/** "auto": Figma's rule; the others force a backend. */
export type GfxPreference = "auto" | GfxBackend;

/** Adapters WebGPU stays off on (GPUAdapterInfo vendor / architecture / description substrings), as Figma's list. */
const BLOCKLIST: readonly { vendor?: string; architecture?: string; description?: string }[] = [];
/** Fallbacks on this machine after which WebGPU stays off (cleared by ?gfx=webgpu). */
const MAX_FALLBACKS = 2;
const FALLBACKS_KEY = "designer.gfx.webgpuFallbacks";

interface GpuAdapterLike {
  info?: { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean };
  isFallbackAdapter?: boolean;
  featureLevel?: string;
  features: { has(name: string): boolean };
  limits: Record<string, number>;
  requestDevice(descriptor?: object): Promise<GpuDeviceLike>;
}
interface GpuDeviceLike {
  lost: Promise<unknown>;
  destroy(): void;
}
interface GpuLike {
  requestAdapter(options?: object): Promise<GpuAdapterLike | null>;
}

/** The backend asked for: EngineOptions.gfx, else the URL's ?gfx=, else auto. */
export function gfxPreference(option?: GfxPreference): GfxPreference {
  if (option && option !== "auto") return option;
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? "").get("gfx");
    if (q === "webgl" || q === "webgl2") return "webgl2";
    if (q === "webgpu") return "webgpu";
  } catch {
    // no location (workers, tests)
  }
  return "auto";
}

function fallbacks(): number {
  try {
    return Number(globalThis.localStorage?.getItem(FALLBACKS_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** A WebGPU session fell back to WebGL2 on this machine. */
export function recordWebGPUFallback(): void {
  try {
    globalThis.localStorage?.setItem(FALLBACKS_KEY, String(fallbacks() + 1));
  } catch {
    // storage blocked: the next session tries WebGPU again
  }
}

function blocklisted(adapter: GpuAdapterLike): string | null {
  const info = adapter.info ?? {};
  // Software adapters (SwiftShader) and compatibility-mode ones: Figma requires full WebGPU.
  if (info.isFallbackAdapter || adapter.isFallbackAdapter) return "software adapter";
  if (adapter.featureLevel === "compatibility") return "compatibility mode";
  for (const entry of BLOCKLIST) {
    const hit = (["vendor", "architecture", "description"] as const).every((k) => !entry[k] || (info[k] ?? "").includes(entry[k]!));
    if (hit) return `blocklisted (${info.vendor ?? "?"} ${info.architecture ?? ""})`;
  }
  return null;
}

let devicePromise: Promise<GpuDeviceLike | null> | null = null;

async function requestDevice(force: boolean): Promise<GpuDeviceLike | null> {
  const gpu = (globalThis.navigator as { gpu?: GpuLike } | undefined)?.gpu;
  if (!gpu) return null;
  if (!force && fallbacks() >= MAX_FALLBACKS) return null;
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const blocked = blocklisted(adapter);
  if (blocked && !force) {
    console.info(`[engine] WebGPU off: ${blocked}`);
    return null;
  }
  // The adapter's texture size, as WebGL2 reports MAX_TEXTURE_SIZE (WebGPU's default limit is 8192).
  const device = await adapter.requestDevice({ requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D } });
  device.lost.then(() => {
    devicePromise = null; // the next engine asks again
  });
  return device;
}

/**
 * The backend for a new canvas engine, with the GPUDevice in place on the module when it is WebGPU.
 */
export async function prepareGfx(module: EngineWasm, option?: GfxPreference): Promise<GfxBackend> {
  const want = gfxPreference(option);
  if (want === "webgl2") return "webgl2";
  const force = want === "webgpu";
  if (force) {
    try {
      globalThis.localStorage?.removeItem(FALLBACKS_KEY);
    } catch {
      // nothing to clear
    }
  }
  devicePromise ??= requestDevice(force).catch((e: unknown) => {
    console.warn(`[engine] WebGPU unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  const device = await devicePromise;
  if (!device) {
    devicePromise = null;
    return "webgl2";
  }
  module.engineGpuDevice = device;
  return "webgpu";
}
