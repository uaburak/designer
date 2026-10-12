import { describe, expect, it } from "vitest";
import { SessionCache, type ExecutionProvider } from "../sessions";

/** A fake backend: sessions are their providers; `failRun` / `failOpen` say which backend breaks. */
function fake(o: { gpu?: boolean; failOpen?: ExecutionProvider; failRun?: ExecutionProvider } = {}) {
  const log: string[] = [];
  const cache = new SessionCache<{ key: string; gpu: boolean }>({
    hasGpu: async () => o.gpu ?? true,
    async open(key, providers) {
      const gpu = providers[0] === "webgpu";
      log.push(`open ${key} ${providers.join("+")}`);
      if (gpu && o.failOpen === "webgpu") throw new Error("no webgpu kernel");
      return { key, gpu };
    },
    async release(s) {
      log.push(`release ${s.key} ${s.gpu ? "webgpu" : "wasm"}`);
    },
  });
  const run = (key: string) =>
    cache.run(key, async (s) => {
      log.push(`run ${s.key} ${s.gpu ? "webgpu" : "wasm"}`);
      if (s.gpu && o.failRun === "webgpu") throw new Error("Too many storage buffers in shader. Current: 11, Max is 10");
      if (!s.gpu && o.failRun === "wasm") throw new Error("std::bad_alloc");
      return s.gpu ? "webgpu" : "wasm";
    });
  return { cache, log, run };
}

describe("the models' sessions (WebGPU, else wasm)", () => {
  it("runs on WebGPU when there is an adapter, keeping one live session", async () => {
    const f = fake();
    expect(await f.run("swin2sr-x4/onnx/model.onnx")).toBe("webgpu");
    expect(await f.run("swin2sr-x4/onnx/model.onnx")).toBe("webgpu");
    expect(await f.run("lama/inpainting_lama_2025jan.onnx")).toBe("webgpu");
    expect(f.log.filter((l) => l.startsWith("open"))).toEqual(["open swin2sr-x4/onnx/model.onnx webgpu+wasm", "open lama/inpainting_lama_2025jan.onnx webgpu+wasm"]);
    expect(f.log).toContain("release swin2sr-x4/onnx/model.onnx webgpu");
  });

  it("wasm only without an adapter", async () => {
    const f = fake({ gpu: false });
    expect(await f.run("isnet/onnx/model_fp16.onnx")).toBe("wasm");
    expect(f.log[0]).toBe("open isnet/onnx/model_fp16.onnx wasm");
  });

  it("a run that fails on WebGPU (the session made fine) is done again on wasm, and the model stays on wasm", async () => {
    const f = fake({ failRun: "webgpu" });
    expect(await f.run("isnet/onnx/model_fp16.onnx")).toBe("wasm");
    expect(f.log).toEqual([
      "open isnet/onnx/model_fp16.onnx webgpu+wasm",
      "run isnet/onnx/model_fp16.onnx webgpu",
      "release isnet/onnx/model_fp16.onnx webgpu",
      "open isnet/onnx/model_fp16.onnx wasm",
      "run isnet/onnx/model_fp16.onnx wasm",
    ]);
    expect(f.cache.liveProvider).toBe("wasm");
    // Another model, then back: still wasm, no WebGPU attempt.
    await f.run("lama/inpainting_lama_2025jan.onnx");
    f.log.length = 0;
    expect(await f.run("isnet/onnx/model_fp16.onnx")).toBe("wasm");
    expect(f.log[1]).toBe("open isnet/onnx/model_fp16.onnx wasm");
  });

  it("a session WebGPU can't make is made on wasm", async () => {
    const f = fake({ failOpen: "webgpu" });
    expect(await f.run("isnet/onnx/model_fp16.onnx")).toBe("wasm");
  });

  it("a model that answers wrong pixels on WebGPU (LaMa) never tries it", async () => {
    const log: string[] = [];
    const cache = new SessionCache<string>(
      { hasGpu: async () => true, open: async (key, p) => (log.push(`${key} ${p.join("+")}`), p[0]), release: async () => {} },
      { wasmOnly: (key) => key.startsWith("lama/") }
    );
    expect(await cache.run("lama/inpainting_lama_2025jan.onnx", async (s) => s)).toBe("wasm");
    expect(await cache.run("isnet/onnx/model_fp16.onnx", async (s) => s)).toBe("webgpu");
    expect(log).toEqual(["lama/inpainting_lama_2025jan.onnx wasm", "isnet/onnx/model_fp16.onnx webgpu+wasm"]);
  });

  it("a wasm failure is the caller's (no retry loop)", async () => {
    const f = fake({ gpu: false, failRun: "wasm" });
    await expect(f.run("isnet/onnx/model_fp16.onnx")).rejects.toThrow("bad_alloc");
    expect(f.log.filter((l) => l.startsWith("run"))).toHaveLength(1);
  });
});
