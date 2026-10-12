// @vitest-environment happy-dom
// The image tools on the real engine (docs/ai.md §2.6, §4, §5): each tool's result applied as one undo step with the
// tool's name and undone in one ⌘Z — Remove background, Boost resolution, Erase, Isolate (a new layer above), Expand
// (the layer grows, the original re-composited untouched), Edit with prompt, Make an image (fill or new layer) — on
// small fixture pictures, with the models replaced by a fake runner (the real ones are 23–115 MB) and main's image
// route by a fake `ai:image`; every run in the ledger; the download confirmation; Vectorize's flow (begin, debounced
// updates, apply as one step, cancel).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { AiImageRequest, AiModelInfo, AiModelState, AiRunEventMsg, AiUsageEntry } from "../../../../../shared/ai/types";
import { EditorController } from "../../controller";
import { memoryDocumentSource } from "../../documentSource";
import { memoryImageStore, type ImportedImage } from "../../images";
import { encodePng } from "../../agents/png";
import { paintImageHash } from "../../model/paints";
import type { Rgba } from "../pixels";
import * as tools from "../tools";
import { setModelRunner, type ModelInput, type OnnxTensor } from "../worker";
import { VectorizeSession } from "../vectorize";
import { ImageTools } from "../controller";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

afterEach(() => {
  setModelRunner(null);
  tools.setAnswerDecoder(null);
});

/** Our own PNGs back to pixels (8-bit RGBA, filter 0 — what encodePng writes). */
function decodePng(png: Uint8Array): Rgba {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = v.getUint32(16), height = v.getUint32(20);
  const idat: Uint8Array[] = [];
  for (let at = 8; at < png.length; ) {
    const len = v.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) data.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  return { width, height, data };
}

const fill = (width: number, height: number, f: (x: number, y: number) => [number, number, number, number]): Rgba => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(f(x, y), (y * width + x) * 4);
  return { width, height, data };
};
const px = (img: Rgba, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

/** The file's images as pixels, by hash. */
function memoryIO(store: ReturnType<typeof memoryImageStore>) {
  const pixels = new Map<string, Rgba>();
  const io: tools.ImageIO = {
    async read(hash) {
      const p = pixels.get(hash);
      if (!p) throw new Error(`no image ${hash}`);
      return p;
    },
    async put(image, name): Promise<ImportedImage> {
      const hash = await store.put(await encodePng(image.width, image.height, image.data), "image/png");
      pixels.set(hash, image);
      return { hash, width: image.width, height: image.height, name, mime: "image/png" };
    },
  };
  return { io, pixels };
}

const MODELS: AiModelInfo[] = ["isnet", "swin2sr-x4", "lama"].map((id) => ({ id: id as AiModelInfo["id"], label: id, use: "", license: "MIT", repo: "x/y", revision: "a".repeat(40), files: [], bytes: 1000 }));

/** main's AI: models ready (or not), `ai:image` answering `answer` as a PNG with its usage. */
function fakeApi(o: { answer?: Rgba; ready?: boolean } = {}) {
  const listeners = new Set<(m: AiRunEventMsg) => void>();
  const requests: AiImageRequest[] = [];
  const downloads: string[] = [];
  let ready = o.ready ?? true;
  const api = {
    async models() {
      return { info: MODELS, state: MODELS.map((m): AiModelState => ({ id: m.id, state: ready ? "ready" : "absent", bytes: m.bytes })) };
    },
    async modelDownload(id: AiModelInfo["id"]): Promise<AiModelState> {
      downloads.push(id);
      ready = true;
      return { id, state: "ready", bytes: 1000 };
    },
    onEvent(cb: (m: AiRunEventMsg) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async cancel() {},
    async image(req: AiImageRequest) {
      requests.push(req);
      const a = o.answer ?? fill(8, 8, () => [0, 0, 255, 255]);
      const data = Buffer.from(await encodePng(a.width, a.height, a.data)).toString("base64");
      setTimeout(() => {
        const emit = (event: AiRunEventMsg["event"]) => listeners.forEach((l) => l({ runId: req.runId, event }));
        emit({ type: "status", text: "Asking Antigravity…" });
        emit({ type: "image", data, mime: "image/png", width: a.width, height: a.height });
        emit({ type: "usage", usage: { input: 0, output: 0, images: 1, credits: 8, providerId: req.route?.providerId ?? "antigravity", model: "gemini-image-test" } });
        emit({ type: "done" });
      }, 1);
    },
  };
  return { api, requests, downloads };
}

/** The models replaced: ISNet keeps the left half, Swin2SR repeats each pixel 4 × 4, LaMa paints mid grey. */
function fakeModels(calls: string[]) {
  setModelRunner(async (id, input: ModelInput) => {
    calls.push(id);
    if (input.kind !== "onnx") throw new Error("not onnx");
    const [t] = input.inputs;
    if (id === "isnet") {
      const n = 1024;
      const out = new Float32Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = x < n / 2 ? 1 : 0;
      return [{ data: out, dims: [1, 1, n, n] }] satisfies OnnxTensor[];
    }
    if (id === "swin2sr-x4") {
      const [, , h, w] = t.dims;
      const out = new Float32Array(3 * h * 4 * w * 4);
      for (let c = 0; c < 3; c++) for (let y = 0; y < h * 4; y++) for (let x = 0; x < w * 4; x++) out[c * h * w * 16 + y * w * 4 + x] = t.data[c * h * w + Math.floor(y / 4) * w + Math.floor(x / 4)];
      return [{ data: out, dims: [1, 3, h * 4, w * 4] }];
    }
    if (id === "lama") {
      expect(input.inputs[1].dims).toEqual([1, 1, 512, 512]);
      return [{ data: new Float32Array(3 * 512 * 512).fill(128), dims: [1, 3, 512, 512] }];
    }
    throw new Error(id);
  });
}

const ORIGINAL = fill(56, 32, (x) => (x < 28 ? [255, 0, 0, 255] : [0, 255, 0, 255]));

async function setup(o: { ready?: boolean; answer?: Rgba; confirm?: boolean } = {}) {
  const store = memoryImageStore();
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Image tools", images: store });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const { io, pixels } = memoryIO(store);
  const original = await io.put(ORIGINAL, "Photo");
  // "Card" (280 × 160) gets an image fill, Fill mode.
  expect(engine.setProps(["1:5"], { fillPaints: [{ type: "IMAGE", image: { hash: original.hash.match(/../g)!.map((h) => parseInt(h, 16)) }, imageScaleMode: "FILL", opacity: 1, visible: true, blendMode: "NORMAL", transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, originalImageWidth: 56, originalImageHeight: 32 }] as never })).toBe(0);
  const fake = fakeApi(o);
  const recorded: Omit<AiUsageEntry, "id" | "at" | "fileKey" | "orgId" | "input" | "output">[] = [];
  const confirms: string[] = [];
  const hooks: tools.ToolHooks = {
    api: fake.api,
    checkCredits: async () => {},
    record: (e) => recorded.push(e),
    confirmDownload: async (info) => {
      confirms.push(info.id);
      return o.confirm ?? true;
    },
  };
  const labels: string[] = [];
  engine.onAny((e) => {
    if (e.type === "DOCUMENT_CHANGED") labels.push(e.label);
  });
  tools.setAnswerDecoder(async (bytes) => decodePng(bytes));
  const env: tools.ToolEnv = { ed, io, hooks };
  const target = () => tools.imageTargetOf(engine.readNode("1:5"))!;
  return { ed, engine, env, io, pixels, original, fake, recorded, confirms, labels, target };
}

const undo = (engine: Engine) => engine.command("UNDO");

describe("image layers", () => {
  it("are layers whose topmost visible fill is an image", async () => {
    const { ed, target, original } = await setup();
    expect(target()).toMatchObject({ id: "1:5", index: 0, hash: original.hash });
    expect(tools.imageTargetOf(ed.engine.readNode("1:6"))).toBeNull();
    expect(tools.imageTargets(ed, ["1:5", "1:6"]).map((t) => t.id)).toEqual(["1:5"]);
  });

  it("draw their paint as the layer shows it (the engine's scale modes)", async () => {
    const { target } = await setup();
    const t = target();
    const shown = tools.drawPaint(ORIGINAL, t.paint, { x: 280, y: 160 }, 280, 160);
    // Fill mode, 56 × 32 into 280 × 160: same aspect, so the whole picture, ×5.
    expect(px(shown, 10, 80)).toEqual([255, 0, 0, 255]);
    expect(px(shown, 270, 80)).toEqual([0, 255, 0, 255]);
    const fit = tools.drawPaint(ORIGINAL, { ...t.paint, imageScaleMode: "FIT" }, { x: 280, y: 320 }, 280, 320);
    expect(px(fit, 140, 5)[3]).toBe(0); // letterboxed
    expect(tools.pictureDensity(t.paint, { x: 28, y: 16 }, ORIGINAL)).toBe(2);
  });
});

describe("each tool is one undo step", () => {
  it("Remove background swaps the picture, keeps the paint, records the run; ⌘Z brings it back", async () => {
    const s = await setup();
    const calls: string[] = [];
    fakeModels(calls);
    expect(await tools.removeBackground(s.env, [s.target()])).toBe(1);
    const t = s.target();
    expect(t.hash).not.toBe(s.original.hash);
    expect(t.paint.imageScaleMode).toBe("FILL");
    const out = s.pixels.get(t.hash)!;
    expect(px(out, 2, 16)).toEqual([255, 0, 0, 255]);
    expect(px(out, 50, 16)[3]).toBe(0);
    expect(s.labels).toContain("Remove background");
    expect(s.recorded).toEqual([{ action: "remove-background", providerId: "local", model: "isnet", images: 1, credits: 1, local: true, ok: true }]);
    undo(s.engine);
    expect(s.target().hash).toBe(s.original.hash);
  });

  it("Boost resolution makes the picture ×4", async () => {
    const s = await setup();
    fakeModels([]);
    const progress: number[] = [];
    await tools.boostResolution(s.env, [s.target()], { onProgress: (p) => progress.push(p) });
    const t = s.target();
    expect(t.paint.originalImageWidth).toBe(224);
    expect(s.pixels.get(t.hash)!.width).toBe(224);
    expect(px(s.pixels.get(t.hash)!, 200, 60)).toEqual([0, 255, 0, 255]);
    expect(progress.at(-1)).toBe(1);
    expect(s.labels.at(-1)).toBe("Boost resolution");
    undo(s.engine);
    expect(s.target().paint.originalImageWidth).toBe(56);
  });

  it("asks before the first download; declining runs nothing", async () => {
    const s = await setup({ ready: false, confirm: false });
    const calls: string[] = [];
    fakeModels(calls);
    await expect(tools.removeBackground(s.env, [s.target()])).rejects.toMatchObject({ code: "cancelled" });
    expect(s.confirms).toEqual(["isnet"]);
    expect(calls).toEqual([]);
    expect(s.fake.downloads).toEqual([]);
    const yes = await setup({ ready: false, confirm: true });
    fakeModels(calls);
    await tools.removeBackground(yes.env, [yes.target()]);
    expect(yes.fake.downloads).toEqual(["isnet"]);
  });

  it("Erase fills the lassoed area (LaMa) and keeps the rest exactly", async () => {
    const s = await setup();
    fakeModels([]);
    const lasso = [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }, { x: 20, y: 80 }];
    await tools.eraseArea(s.env, s.target(), lasso);
    const t = s.target();
    expect(t.paint.imageScaleMode).toBe("FILL");
    const out = s.pixels.get(t.hash)!;
    expect(out.width).toBe(280);
    expect(px(out, 50, 50)).toEqual([128, 128, 128, 255]);
    expect(px(out, 200, 100)).toEqual([0, 255, 0, 255]);
    expect(px(out, 5, 150)).toEqual([255, 0, 0, 255]);
    expect(s.labels.at(-1)).toBe("Erase");
    undo(s.engine);
    expect(s.target().hash).toBe(s.original.hash);
  });

  it("Erase without the model goes to the image route with a mask", async () => {
    const s = await setup({ ready: false, confirm: false, answer: fill(280, 160, () => [9, 9, 9, 255]) });
    await tools.eraseArea(s.env, s.target(), [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }]);
    expect(s.fake.requests[0]).toMatchObject({ action: "erase-object" });
    expect(s.fake.requests[0].mask).toBeTruthy();
    const out = s.pixels.get(s.target().hash)!;
    expect(px(out, 10, 10)).toEqual([9, 9, 9, 255]);
    expect(px(out, 100, 100)).toEqual([255, 0, 0, 255]);
    // The provider main says answered (this run had no route: it was recorded as "image" — found 2026-10-12)
    expect(s.recorded.at(-1)).toMatchObject({ action: "erase-object", providerId: "antigravity", model: "gemini-image-test", credits: 8, local: false, ok: true });
  });

  it("Isolate makes a new image layer just above, the original kept; ⌘Z removes it", async () => {
    const s = await setup();
    fakeModels([]);
    const id = await tools.isolateArea(s.env, s.target(), [{ x: 100, y: 40 }, { x: 180, y: 40 }, { x: 180, y: 120 }, { x: 100, y: 120 }]);
    const n = s.engine.readNode(id)!;
    expect(n.parentIndex?.guid).toBe("1:1");
    expect(n.parentIndex!.position > s.engine.readNode("1:5")!.parentIndex!.position).toBe(true);
    expect(n.parentIndex!.position < s.engine.readNode("1:6")!.parentIndex!.position).toBe(true);
    expect(n.size!.x).toBeCloseTo(84, 0);
    expect(n.transform!.m02).toBeCloseTo(24 + 98, 0);
    expect(s.target().hash).toBe(s.original.hash);
    expect(s.labels.at(-1)).toBe("Isolate");
    expect(s.ed.selection).toEqual([id]);
    undo(s.engine);
    expect(s.engine.readNode(id)).toBeNull();
  });

  it("Expand grows the layer, sends the padded canvas with its mask, re-composites the original untouched", async () => {
    const s = await setup({ answer: fill(100, 40, () => [0, 0, 255, 255]) });
    const before = s.engine.readNode("1:5")!;
    await tools.expandImage(s.env, s.target(), { left: 20, top: 0, right: 40, bottom: 10 });
    const req = s.fake.requests[0];
    expect(req).toMatchObject({ action: "expand-image", size: { width: 340, height: 170 } });
    const sent = decodePng(Uint8Array.from(atob(req.image!), (c) => c.charCodeAt(0)));
    expect(px(sent, 5, 5)[3]).toBe(0);
    expect(px(sent, 25, 5)).toEqual([255, 0, 0, 255]);
    const mask = decodePng(Uint8Array.from(atob(req.mask!), (c) => c.charCodeAt(0)));
    expect(px(mask, 5, 5)[3]).toBe(0);
    expect(px(mask, 25, 5)[3]).toBe(255);
    const after = s.engine.readNode("1:5")!;
    expect(after.size).toEqual({ x: 340, y: 170 });
    expect(after.transform!.m02).toBe(before.transform!.m02 - 20);
    expect(after.transform!.m12).toBe(before.transform!.m12);
    const out = s.pixels.get(s.target().hash)!;
    expect(out.width).toBe(340);
    expect(px(out, 5, 5)).toEqual([0, 0, 255, 255]);
    for (const [x, y] of [[20, 0], [159, 80], [299, 159]]) expect(px(out, x, y)).toEqual(px(tools.drawPaint(ORIGINAL, s.target().paint, { x: 280, y: 160 }, 280, 160), x - 20, y));
    expect(px(out, 330, 165)).toEqual([0, 0, 255, 255]);
    expect(s.labels.at(-1)).toBe("Expand");
    undo(s.engine);
    expect(s.engine.readNode("1:5")!.size).toEqual({ x: 280, y: 160 });
  });

  it("Edit with prompt sends the picture and the prompt, swaps the picture", async () => {
    const s = await setup({ answer: fill(56, 32, () => [1, 2, 3, 255]) });
    await tools.editWithPrompt(s.env, s.target(), "make it night");
    expect(s.fake.requests[0]).toMatchObject({ action: "edit-image", prompt: "make it night", size: { width: 56, height: 32 } });
    expect(px(s.pixels.get(s.target().hash)!, 0, 0)).toEqual([1, 2, 3, 255]);
    expect(s.labels.at(-1)).toBe("Edit image");
    undo(s.engine);
    expect(s.target().hash).toBe(s.original.hash);
  });

  it("Make an image fills the selected layer, else places a new image layer", async () => {
    const s = await setup();
    s.engine.setSelection(["1:6"]);
    expect(await tools.makeImage(s.env, "a sunset over the sea")).toBe("1:6");
    expect(s.fake.requests[0]).toMatchObject({ action: "make-image", prompt: "a sunset over the sea", size: { width: 280, height: 160 } });
    expect(paintImageHash(s.engine.readNode("1:6")!.fillPaints![0] as never)).toBeTruthy();
    expect(s.labels.at(-1)).toBe("Make an image");
    undo(s.engine);
    expect(s.engine.readNode("1:6")!.fillPaints![0].type).toBe("SOLID");
    s.engine.setSelection([]);
    const id = await tools.makeImage(s.env, "a cat");
    expect(id).toBeTruthy();
    const n = s.engine.readNode(id!)!;
    expect(n.name).toBe("a cat");
    expect(n.size).toEqual({ x: 8, y: 8 });
    expect(s.labels.at(-1)).toBe("Make an image");
    undo(s.engine);
    expect(s.engine.readNode(id!)).toBeNull();
    expect(s.recorded.map((r) => r.action)).toEqual(["make-image", "make-image"]);
  });
});

describe("Vectorize's flow", () => {
  const picture = fill(64, 64, (x, y) => (Math.hypot(x - 32, y - 32) < 20 ? [200, 30, 30, 255] : [255, 255, 255, 255]));

  it("begins with a preview, updates 120 ms after the last change, applies one step", async () => {
    vi.useFakeTimers();
    try {
      const s = await setup();
      const update = vi.spyOn(s.engine, "vectorizeUpdate");
      const session = await VectorizeSession.begin(s.ed, s.env.hooks, "1:5", { pixels: { width: 64, height: 64, pixels: picture.data } });
      expect(update).toHaveBeenCalledTimes(1);
      expect(session.stats!.layers).toBeGreaterThan(0);
      session.set({ colors: 3 });
      session.set({ colors: 2 });
      vi.advanceTimersByTime(119);
      expect(update).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(update).toHaveBeenCalledTimes(2);
      expect(update).toHaveBeenLastCalledWith({ mode: "FULL_COLOR", colors: 2 });
      session.set({ mode: "BLACK_AND_WHITE", threshold: 70 });
      const frame = session.apply()!;
      expect(update).toHaveBeenLastCalledWith({ mode: "BLACK_AND_WHITE", threshold: 70 });
      expect(s.labels).toEqual(["Vectorize"]);
      expect(s.engine.readNode("1:5")).toBeNull();
      expect(s.engine.readNode(frame)!.type).toBe("FRAME");
      expect(s.recorded).toEqual([{ action: "vectorize", providerId: "local", model: "engine-trace", images: 1, credits: 2, local: true, ok: true }]);
      undo(s.engine);
      expect(s.engine.readNode("1:5")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels to nothing in the history (the toolbar's controller too)", async () => {
    const s = await setup();
    const t = new ImageTools(s.ed, { hooks: s.env.hooks, io: s.io });
    s.engine.setSelection(["1:5"]);
    const session = await VectorizeSession.begin(s.ed, s.env.hooks, "1:5", { pixels: { width: 64, height: 64, pixels: picture.data } });
    t.state.set({ mode: "vectorize", target: "1:5", vectorize: session });
    t.cancelVectorize();
    expect(session.active).toBe(false);
    expect(t.state.get().mode).toBeNull();
    expect(s.labels).toEqual([]);
    expect(s.engine.readNode("1:5")).not.toBeNull();
    expect(s.recorded).toEqual([]);
  });

  it("starts from the toolbar on the selected image with its contents as drawn", async () => {
    const s = await setup();
    const t = new ImageTools(s.ed, { hooks: s.env.hooks, io: s.io });
    s.engine.setSelection(["1:5"]);
    // The engine draws the picture once it has it (headless: hand it over).
    s.engine.addImageRgba(s.original.hash, 56, 32, ORIGINAL.data);
    expect(await t.startVectorize()).toBe(true);
    expect(t.state.get().mode).toBe("vectorize");
    const v = t.state.get().vectorize!;
    expect(v.stats!.width).toBeGreaterThan(0);
    v.set({ mode: "GRAYSCALE", grays: 2 });
    const frame = t.applyVectorize();
    expect(frame).toBeTruthy();
    expect(s.labels).toEqual(["Vectorize"]);
  });
});
