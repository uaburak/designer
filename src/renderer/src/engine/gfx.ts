/**
 * Which GPU backend the engine's canvas uses (docs/engine.md §6.1), as Figma chooses
 * (docs/research/figma/R10-webgpu.md, docs/research/atlas/20-rendering.md §3): WebGPU when the browser has it, the
 * platform allows it and the adapter isn't blocklisted, else WebGL2; a lost WebGPU device is re-created, and a
 * session that still fails (the device lost again, or the engine's self test after start) moves to WebGL2 and the
 * machine counts a fallback — Figma blocklists devices by how often they fall back, here this machine stops trying
 * WebGPU after a few.
 *
 * WebGPU's adapter and device requests are promises and the engine's calls synchronous: the GPUDevice is requested
 * here, before engine_create, and handed over as Module.engineGpuDevice (one per renderer process, shared by its
 * engines).
 *
 * Debug switch: `?gfx=webgl` / `?gfx=webgpu` in the page's URL (or EngineOptions.gfx), and Figma's own
 * `?force-webgl2=1` / `?force-webgpu=1`. `webgpu` skips the platform rules and the blocklist.
 */
import type { EngineWasm } from "./wasm/engine.mjs";

export type GfxBackend = "webgpu" | "webgl2";
/** "auto": Figma's rule; the others force a backend. */
export type GfxPreference = "auto" | GfxBackend;

/**
 * Adapters WebGPU stays off on (GPUAdapterInfo vendor / architecture / description substrings): Figma's
 * `vendor_architecture_blocklist` and `graphics_card_blocklist`, dynamic configs whose values aren't in its build
 * (atlas 20 §3.4) — empty until one is known. Its fixed rules are in `blocklisted`.
 */
const BLOCKLIST: readonly { vendor?: string; architecture?: string; description?: string }[] = [];
/** Firefox runs WebGPU from this version on (Figma's `minimum_firefox_version` default). */
const MIN_FIREFOX = 141;
/** Fallbacks on this machine after which WebGPU stays off (cleared by ?gfx=webgpu). */
const MAX_FALLBACKS = 2;
const FALLBACKS_KEY = "designer.gfx.webgpuFallbacks";
/** Figma re-creates a device lost as "destroyed" after this long (2108 @2 581 674). */
export const DEVICE_RECREATE_DELAY_MS = 3000;
/** A device lost again this soon after it was re-created is not re-created again: the session moves to WebGL2. */
export const DEVICE_RELOSS_MS = 30_000;

const IS_WINDOWS = typeof navigator !== "undefined" && /Win/.test(navigator.platform);

export interface GpuAdapterLike {
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
export interface GpuLike {
  requestAdapter(options?: object): Promise<GpuAdapterLike | null>;
}

/** The backend asked for: EngineOptions.gfx, else the URL's ?gfx= (or ?force-webgl2=1 / ?force-webgpu=1), else auto. */
export function gfxPreference(option?: GfxPreference): GfxPreference {
  if (option && option !== "auto") return option;
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? "");
    const q = params.get("gfx");
    if (q === "webgl" || q === "webgl2" || params.get("force-webgl2") === "1") return "webgl2";
    if (q === "webgpu" || params.get("force-webgpu") === "1") return "webgpu";
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

/**
 * Figma's `isWebGPUSupported` platform rules (atlas 20 §3.3): no WebGPU in Safari, in Firefox before 141, on Android,
 * iOS or iPad, nor on Linux outside the desktop app. The reason, or null when the platform allows it.
 */
export function webgpuPlatformBlock(userAgent: string): string | null {
  const firefox = /Firefox\/(\d+)/.exec(userAgent);
  if (firefox) return Number(firefox[1]) < MIN_FIREFOX ? `Firefox ${firefox[1]}` : null;
  if (/Android|iPhone|iPad|iPod/.test(userAgent)) return "mobile";
  if (/Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|Edg\//.test(userAgent)) return "Safari";
  if (/Linux/.test(userAgent) && !/Electron\//.test(userAgent)) return "Linux";
  return null;
}

const isFallbackAdapter = (adapter: GpuAdapterLike) => !!(adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter);

/**
 * Figma's disallow list for an adapter (2108 @2 579 799, atlas 20 §3.4), with the configs' lists (BLOCKLIST). Not
 * taken: Apple `metal-3`, which Figma blocks unless it reads WebGPU pixels back through a 2D canvas
 * (`webgpu_canvas_2d_readpixels`) — the engine's readback is such a 2D canvas (library_engine_wgpu.js), so the
 * exception holds; and an empty card name, behind a config whose value isn't known.
 */
export function blocklisted(adapter: GpuAdapterLike, windows = IS_WINDOWS): string | null {
  const info = adapter.info ?? {};
  // Software adapters (SwiftShader) and compatibility-mode ones: Figma requires full WebGPU.
  if (isFallbackAdapter(adapter)) return "software adapter";
  if (adapter.featureLevel === "compatibility") return "compatibility mode";
  // Intel's 7th and 8th generations on Windows.
  if (windows && /intel/i.test(info.vendor ?? "") && /^gen-[78]$/.test(info.architecture ?? "")) return `blocklisted (intel ${info.architecture})`;
  for (const entry of BLOCKLIST) {
    const hit = (["vendor", "architecture", "description"] as const).every((k) => !entry[k] || (info[k] ?? "").includes(entry[k]!));
    if (hit) return `blocklisted (${info.vendor ?? "?"} ${info.architecture ?? ""})`;
  }
  return null;
}

/**
 * Figma's adapter order (2108 @2 576 349): high-performance; when that gives none or a software adapter, low-power;
 * then the browser's default. The first hardware adapter, else the last one given (a software one, which
 * `blocklisted` turns down unless WebGPU is forced), else null.
 */
export async function requestAdapter(gpu: GpuLike): Promise<GpuAdapterLike | null> {
  let last: GpuAdapterLike | null = null;
  for (const options of [{ powerPreference: "high-performance" }, { powerPreference: "low-power" }, undefined]) {
    const adapter = await gpu.requestAdapter(options);
    if (adapter && !isFallbackAdapter(adapter)) return adapter;
    last = adapter ?? last;
  }
  return last;
}

/**
 * What a lost WebGPU device leads to (Figma, 2108 @2 581 674): re-created at once, or after 3 s when it was
 * "destroyed"; a self-test failure, or a device lost again within 30 s of being re-created, moves the session to
 * WebGL2. `sinceRecreatedMs`: how long ago this session last re-created its device (Infinity: never).
 */
export function afterDeviceFailure(reason: string, sinceRecreatedMs: number): { recreate: false } | { recreate: true; delayMs: number } {
  const lost = /^device lost \((\w*)\)/.exec(reason);
  if (!lost || sinceRecreatedMs < DEVICE_RELOSS_MS) return { recreate: false };
  return { recreate: true, delayMs: lost[1] === "destroyed" ? DEVICE_RECREATE_DELAY_MS : 0 };
}

let devicePromise: Promise<GpuDeviceLike | null> | null = null;

async function requestDevice(force: boolean): Promise<GpuDeviceLike | null> {
  const gpu = (globalThis.navigator as { gpu?: GpuLike } | undefined)?.gpu;
  if (!gpu) return null;
  if (!force && fallbacks() >= MAX_FALLBACKS) return null;
  const platform = force ? null : webgpuPlatformBlock(globalThis.navigator?.userAgent ?? "");
  if (platform) {
    console.info(`[engine] WebGPU off: ${platform}`);
    return null;
  }
  const adapter = await requestAdapter(gpu);
  if (!adapter) return null;
  const blocked = blocklisted(adapter);
  if (blocked && !force) {
    console.info(`[engine] WebGPU off: ${blocked}`);
    return null;
  }
  // The adapter's texture size, as WebGL2 reports MAX_TEXTURE_SIZE (WebGPU's default limit is 8192). Figma asks for no
  // limits and draws within 8192 there; ours keeps WebGL2's sizes on both backends (the same pixels either way).
  const device = await adapter.requestDevice({ requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D } });
  device.lost.then(() => {
    devicePromise = null; // the next engine asks again
  });
  return device;
}

/**
 * The backend for a new canvas engine, with the GPUDevice in place on the module when it is WebGPU. Also how a lost
 * device is re-created: the lost one is forgotten, so this asks for a new one.
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

// ---- The WebGL2 probe and the hardware-acceleration detector (atlas 20 §3.2, §3.7) ----

/** Figma's WebGL2 probe statuses (run once, cached). */
export type WebGL2Status = "webgl2_not_supported" | "webgl2_disallow_list" | "webgl2_software_rendering" | "webgl2_success";

export interface WebGL2Probe {
  status: WebGL2Status;
  /** The unmasked renderer and vendor (WEBGL_debug_renderer_info), "" when the browser hides them. */
  renderer: string;
  vendor: string;
  maxTextureSize: number;
}

interface GLLike {
  getExtension(name: string): unknown;
  getParameter(p: number): unknown;
  readonly MAX_TEXTURE_SIZE: number;
}

/** The unmasked renderer and vendor of a context ("" without WEBGL_debug_renderer_info). */
function glInfo(gl: GLLike): { renderer: string; vendor: string } {
  const debug = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number; UNMASKED_VENDOR_WEBGL: number } | null;
  if (!debug) return { renderer: "", vendor: "" };
  return { renderer: String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? ""), vendor: String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) ?? "") };
}

/**
 * Figma's statuses for what a WebGL2 context (and a WebGL1 one on the same machine) reports. Figma runs a "disallow
 * list" machine (no renderer string, or a Radeon) on WebGL1; the engine has no WebGL1 path, so there it stays on
 * WebGL2 — the status is what the detector and the logs read.
 */
export function webgl2Status(webgl2: { renderer: string } | null, webgl1: { renderer: string } | null): WebGL2Status {
  if (!webgl2) return "webgl2_not_supported";
  if (!webgl2.renderer || /radeon/i.test(webgl2.renderer)) return "webgl2_disallow_list";
  if (/swiftshader/i.test(webgl2.renderer) && webgl1 && !/swiftshader/i.test(webgl1.renderer)) return "webgl2_software_rendering";
  return "webgl2_success";
}

let probed: WebGL2Probe | null = null;

/** Figma's WebGL2 probe: throwaway contexts, read and released (WEBGL_lose_context). Cached. */
export function probeWebGL2(): WebGL2Probe {
  if (probed) return probed;
  const open = (type: "webgl2" | "webgl") => {
    try {
      const gl = document.createElement("canvas").getContext(type) as (GLLike & WebGLRenderingContext) | null;
      if (!gl) return null;
      const info = { ...glInfo(gl), maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0 };
      (gl.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
      return info;
    } catch {
      return null;
    }
  };
  const gl2 = typeof document === "undefined" ? null : open("webgl2");
  const gl1 = gl2 && /swiftshader/i.test(gl2.renderer) ? open("webgl") : null;
  probed = { status: webgl2Status(gl2, gl1), renderer: gl2?.renderer ?? "", vendor: gl2?.vendor ?? "", maxTextureSize: gl2?.maxTextureSize ?? 0 };
  return probed;
}

/** Figma's hardware-acceleration status (2108 @612 651). */
export type HardwareAcceleration = "UNKNOWN" | "DISABLED" | "ENABLED";

/**
 * DISABLED when the browser draws with SwiftShader (vendor "Google Inc.", renderer "SwiftShader": hardware
 * acceleration is off); UNKNOWN in the desktop app, which has its own switch (Figma's detector says UNKNOWN there too).
 */
export function hardwareAcceleration(userAgent: string, gpu: { renderer: string; vendor: string }): HardwareAcceleration {
  if (/Electron\//.test(userAgent)) return "UNKNOWN";
  return /Google Inc\./.test(gpu.vendor) && /SwiftShader/i.test(gpu.renderer) ? "DISABLED" : "ENABLED";
}
