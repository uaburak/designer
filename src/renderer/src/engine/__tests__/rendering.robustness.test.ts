import { describe, expect, it, vi } from "vitest";
import { afterDeviceFailure, blocklisted, hardwareAcceleration, requestAdapter, webgl2Status, webgpuPlatformBlock, type GpuAdapterLike } from "../gfx";
import { CONTEXT_NOT_RESTORED, CONTEXT_REPEATEDLY_LOST, ContextRestorer, type Clock } from "../contextLoss";
import { HEAP_LIMITS, HeapMemoryMode, heapModeOf, isOutOfMemory, MemoryMonitor, MemoryWarningLevel, memoryPercent, recoveryUrl } from "../memory";
import { FrameTelemetry } from "../frameTelemetry";

const GiB = 1024 ** 3;

const adapter = (info: GpuAdapterLike["info"], rest: Partial<GpuAdapterLike> = {}): GpuAdapterLike => ({
  info,
  features: { has: () => false },
  limits: {},
  requestDevice: () => Promise.reject(new Error("unused")),
  ...rest,
});

describe("backend choice (Figma's rules, docs/research/atlas/20-rendering.md §3)", () => {
  it("platform: no WebGPU in Safari, Firefox < 141, on phones and tablets, nor on Linux outside the desktop app", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";
    expect(webgpuPlatformBlock(`${mac} Chrome/141.0.0.0 Safari/537.36`)).toBeNull();
    expect(webgpuPlatformBlock(`${mac} designer/1.0.0 Chrome/141.0.0.0 Electron/38.0.0 Safari/537.36`)).toBeNull();
    expect(webgpuPlatformBlock(`${mac} Version/26.0 Safari/605.1.15`)).toBe("Safari");
    expect(webgpuPlatformBlock("Mozilla/5.0 (Macintosh; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox 140");
    expect(webgpuPlatformBlock("Mozilla/5.0 (Macintosh; rv:141.0) Gecko/20100101 Firefox/141.0")).toBeNull();
    expect(webgpuPlatformBlock("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36")).toBe("mobile");
    expect(webgpuPlatformBlock("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/604.1")).toBe("mobile");
    expect(webgpuPlatformBlock("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36")).toBe("Linux");
    expect(webgpuPlatformBlock("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Electron/38.0.0 Safari/537.36")).toBeNull();
  });

  it("blocklist: software and compatibility adapters, Intel gen-7 / gen-8 on Windows; Apple metal-3 stays on", () => {
    expect(blocklisted(adapter({ isFallbackAdapter: true }))).toBe("software adapter");
    expect(blocklisted(adapter({}, { featureLevel: "compatibility" }))).toBe("compatibility mode");
    expect(blocklisted(adapter({ vendor: "intel", architecture: "gen-8" }), true)).toMatch(/blocklisted/);
    expect(blocklisted(adapter({ vendor: "intel", architecture: "gen-7" }), true)).toMatch(/blocklisted/);
    expect(blocklisted(adapter({ vendor: "intel", architecture: "gen-9" }), true)).toBeNull();
    expect(blocklisted(adapter({ vendor: "intel", architecture: "gen-8" }), false)).toBeNull();
    expect(blocklisted(adapter({ vendor: "apple", architecture: "metal-3" }))).toBeNull();
  });

  it("adapter order: high-performance, then low-power, then the default; a software adapter only when nothing else", async () => {
    const asked: unknown[] = [];
    const soft = adapter({ isFallbackAdapter: true });
    const hard = adapter({ vendor: "apple" });
    const gpu = (answers: (GpuAdapterLike | null)[]) => ({
      requestAdapter: (options?: object) => {
        asked.push(options);
        return Promise.resolve(answers.shift() ?? null);
      },
    });
    expect(await requestAdapter(gpu([hard]))).toBe(hard);
    expect(asked).toEqual([{ powerPreference: "high-performance" }]);
    asked.length = 0;
    expect(await requestAdapter(gpu([null, soft, hard]))).toBe(hard);
    expect(asked).toEqual([{ powerPreference: "high-performance" }, { powerPreference: "low-power" }, undefined]);
    expect(await requestAdapter(gpu([soft, null, null]))).toBe(soft);
    expect(await requestAdapter(gpu([null, null, null]))).toBeNull();
  });

  it("a lost device is re-created (after 3 s when destroyed); a self test failure, or a loss again within 30 s, falls back", () => {
    expect(afterDeviceFailure("device lost (unknown): GPU process gone", Infinity)).toEqual({ recreate: true, delayMs: 0 });
    expect(afterDeviceFailure("device lost (destroyed): ", Infinity)).toEqual({ recreate: true, delayMs: 3000 });
    expect(afterDeviceFailure("device lost (unknown): again", 10_000)).toEqual({ recreate: false });
    expect(afterDeviceFailure("device lost (unknown): later", 30_000)).toEqual({ recreate: true, delayMs: 0 });
    expect(afterDeviceFailure("self test drew [0,0,0,0], expected [128,0,0,128]", Infinity)).toEqual({ recreate: false });
  });

  it("the WebGL2 probe's statuses and the hardware-acceleration detector", () => {
    expect(webgl2Status(null, null)).toBe("webgl2_not_supported");
    expect(webgl2Status({ renderer: "" }, null)).toBe("webgl2_disallow_list");
    expect(webgl2Status({ renderer: "ANGLE (AMD, AMD Radeon Pro 5500M OpenGL Engine)" }, null)).toBe("webgl2_disallow_list");
    expect(webgl2Status({ renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))" }, { renderer: "ANGLE (Apple, Apple M2)" })).toBe("webgl2_software_rendering");
    expect(webgl2Status({ renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)" }, null)).toBe("webgl2_success");
    const swiftshader = { vendor: "Google Inc. (Google)", renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))" };
    expect(hardwareAcceleration("Mozilla/5.0 Chrome/141.0", swiftshader)).toBe("DISABLED");
    expect(hardwareAcceleration("Mozilla/5.0 Chrome/141.0 Electron/38.0.0", swiftshader)).toBe("UNKNOWN");
    expect(hardwareAcceleration("Mozilla/5.0 Chrome/141.0", { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, Apple M2)" })).toBe("ENABLED");
  });
});

describe("WebGL context loss (Figma's restore polls, atlas 20 §3.6)", () => {
  function setup() {
    let now = 0;
    const timers = new Map<number, { at: number; f: () => void }>();
    let next = 1;
    const clock: Clock = {
      now: () => now,
      setTimeout: (f, ms) => (timers.set(next, { at: now + ms, f }), next++),
      clearTimeout: (id) => void timers.delete(id),
    };
    const advance = (ms: number) => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].f();
      }
      now = end;
    };
    const ctx = { lost: true, restores: 0, isLost: () => ctx.lost, restore: () => void ctx.restores++ };
    const fatal = vi.fn();
    const restorer = new ContextRestorer(ctx, fatal, clock);
    return { ctx, fatal, restorer, advance };
  }

  it("the browser gets 3 s to restore it by itself; then restoreContext every 3 s, three times, then the error", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, fatal, restorer, advance } = setup();
    restorer.lost();
    advance(2999);
    expect(ctx.restores).toBe(0);
    advance(1);
    expect(ctx.restores).toBe(1);
    advance(6000);
    expect(ctx.restores).toBe(3);
    expect(fatal).not.toHaveBeenCalled();
    advance(3000);
    expect(fatal).toHaveBeenCalledWith(CONTEXT_NOT_RESTORED);
    expect(ctx.restores).toBe(3);
  });

  it("restored by itself: no request; a fourth forced restore in a row (each loss < 30 s after the last) gives up", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, fatal, restorer, advance } = setup();
    restorer.lost();
    advance(1000);
    ctx.lost = false;
    restorer.restored();
    advance(10_000);
    expect(ctx.restores).toBe(0);
    for (let i = 0; i < 3; i++) {
      ctx.lost = true;
      restorer.lost();
      advance(3000);
      ctx.lost = false;
      restorer.restored();
      advance(1000);
    }
    expect(ctx.restores).toBe(3);
    ctx.lost = true;
    restorer.lost();
    expect(fatal).toHaveBeenCalledWith(CONTEXT_REPEATEDLY_LOST);
  });

  it("a loss 30 s or more after the last restore starts the count again", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, fatal, restorer, advance } = setup();
    for (let i = 0; i < 5; i++) {
      ctx.lost = true;
      restorer.lost();
      advance(3000);
      ctx.lost = false;
      restorer.restored();
      advance(30_000);
    }
    expect(fatal).not.toHaveBeenCalled();
  });
});

describe("the file's memory (Figma's heap limits and threshold, atlas 20 §9)", () => {
  it("limits by mode, and the mode from the URL", () => {
    expect(HEAP_LIMITS[HeapMemoryMode.DEFAULT]).toBe(2 * GiB);
    expect(HEAP_LIMITS[HeapMemoryMode.LOAD_ALL_PAGES]).toBe(3 * GiB);
    expect(HEAP_LIMITS[HeapMemoryMode.RECOVERY]).toBe(0xffff0000);
    expect(heapModeOf("?file=abc")).toBe(HeapMemoryMode.DEFAULT);
    expect(heapModeOf("?file=abc&recovery=true")).toBe(HeapMemoryMode.RECOVERY);
    expect(heapModeOf("?wasm-4gb=1")).toBe(HeapMemoryMode.MAXIMUM);
    expect(recoveryUrl("app://designer/editor?file=abc", true)).toBe("app://designer/editor?file=abc&recovery=true");
    expect(recoveryUrl("app://designer/editor?file=abc&recovery=true", false)).toBe("app://designer/editor?file=abc");
  });

  it("the percentage: clamped, two decimals", () => {
    expect(memoryPercent(GiB, 2 * GiB)).toBe(50);
    expect(memoryPercent(1234567, 2 * GiB)).toBe(0.06);
    expect(memoryPercent(3 * GiB, 2 * GiB)).toBe(100);
    expect(memoryPercent(1, 0)).toBe(0);
  });

  it("crossing 90 % purges once and warns; under it again: safe, with the 'good to go' note; 100 %: out of memory", () => {
    let used = 0.5 * 2 * GiB;
    const purge = vi.fn();
    const m = new MemoryMonitor({ used: () => used, purge });
    m.poll();
    expect(m.state.level).toBe(MemoryWarningLevel.SAFE);
    used = 0.91 * 2 * GiB;
    m.poll();
    m.poll();
    expect(purge).toHaveBeenCalledTimes(1);
    expect(m.state).toMatchObject({ level: MemoryWarningLevel.ERROR, percent: 91, recovered: false });
    used = 0.8 * 2 * GiB;
    m.poll();
    expect(m.state).toMatchObject({ level: MemoryWarningLevel.SAFE, recovered: true });
    used = 0.95 * 2 * GiB;
    m.poll();
    expect(purge).toHaveBeenCalledTimes(2);
    used = 2 * GiB;
    m.poll();
    expect(m.state.level).toBe(MemoryWarningLevel.OOM);
    used = 0.1 * 2 * GiB;
    m.poll();
    expect(m.state.level).toBe(MemoryWarningLevel.OOM); // the dialog stays
  });

  it("recovery mode's 4 GiB limit; an abort for memory is out of memory", () => {
    const m = new MemoryMonitor({ used: () => 2.2 * GiB, purge: () => {} }, HeapMemoryMode.RECOVERY);
    m.poll();
    expect(m.state.level).toBe(MemoryWarningLevel.SAFE);
    m.outOfMemory();
    expect(m.state.level).toBe(MemoryWarningLevel.OOM);
    expect(isOutOfMemory("Aborted(OOM)", GiB)).toBe(true);
    expect(isOutOfMemory("Aborted()", 3.9 * GiB)).toBe(true);
    expect(isOutOfMemory("Aborted(Assertion failed)", GiB)).toBe(false);
  });
});

describe("frame telemetry (Figma's histograms, atlas 20 §10)", () => {
  it("frames go into Figma's bins; slow frames (≥ 50 ms) are kept; gaps in continuous frames count as dropped", () => {
    const f = new FrameTelemetry();
    let t = 0;
    for (const ms of [0.5, 8, 8, 8, 30, 60]) f.record(ms, (t += 8.33));
    t += 8.33 * 3; // two frames shown without a new one
    f.record(4, t);
    t += 5000; // idle: not dropped
    f.record(4, t);
    const r = f.report();
    expect(r.frame_count).toBe(8);
    expect(r.max_frame_ms).toBe(60);
    expect(r.frames.count_0_to_1_ms).toBe(1);
    expect(r.frames.count_1_to_9_ms).toBe(5);
    expect(r.frames.count_29_to_32_ms).toBe(1);
    expect(r.frames.count_48_to_64_ms).toBe(1);
    expect(r.frames.count_3584_to_inf_ms).toBe(0);
    expect(r.slow).toEqual([{ frame: 6, ms: 60, at: expect.any(Number) }]);
    expect(r.dropped.count_0_dropped).toBe(5);
    expect(r.dropped.count_2_to_2_dropped).toBe(1);
    expect(Object.keys(r.dropped).at(-1)).toBe("count_257_to_inf_dropped");
  });
});
