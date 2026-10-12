/// <reference lib="webworker" />
/**
 * The models' Worker (docs/ai.md §2.4): onnxruntime-web over WebGPU, falling back to wasm, with the model files read
 * from `aimodel://<id>/<path>` (main serves the downloaded, checked files). One session lives at a time: a call for
 * another model releases the one before. fp16 models get fp16 inputs (as their metadata asks) and their outputs come
 * back as float32. The search models (CLIP, MiniLM) go through @huggingface/transformers for their tokenizers and
 * processors, pointed at the same scheme; loaded only when asked for.
 */
import * as ort from "onnxruntime-web/webgpu";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import type { AiModelId } from "../../../../shared/ai/types";
import type { ModelInput, OnnxTensor } from "./worker";
import { fromHalfArray, toHalfArray } from "./pixels";

declare const self: DedicatedWorkerGlobalScope;

ort.env.wasm.wasmPaths = { wasm: ortWasm };
ort.env.wasm.numThreads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

let live: { key: string; session: ort.InferenceSession } | null = null;
let embedders: Map<string, unknown> | null = null;

async function session(model: AiModelId, file: string): Promise<ort.InferenceSession> {
  const key = `${model}/${file}`;
  if (live?.key === key) return live.session;
  await live?.session.release().catch(() => {});
  live = null;
  embedders = null;
  const url = `aimodel://${model}/${file}`;
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const hasGpu = "gpu" in navigator && !!(await (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter().catch(() => null));
  let s: ort.InferenceSession;
  try {
    s = await ort.InferenceSession.create(bytes, { executionProviders: hasGpu ? ["webgpu", "wasm"] : ["wasm"], graphOptimizationLevel: "all" });
  } catch {
    s = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  }
  live = { key, session: s };
  return s;
}

/** Whether the session's input takes float16 (its metadata), else float32. */
function wantsHalf(s: ort.InferenceSession, i: number): boolean {
  const meta = (s as unknown as { inputMetadata?: { type?: string }[] }).inputMetadata?.[i];
  return meta?.type === "float16";
}

async function onnx(model: AiModelId, input: Extract<ModelInput, { kind: "onnx" }>): Promise<OnnxTensor[]> {
  const s = await session(model, input.file);
  const feeds: Record<string, ort.Tensor> = {};
  s.inputNames.forEach((name, i) => {
    const t = input.inputs[i];
    if (!t) throw new Error(`The model wants an input "${name}"`);
    feeds[name] = wantsHalf(s, i) ? new ort.Tensor("float16", toHalfArray(t.data), t.dims) : new ort.Tensor("float32", t.data, t.dims);
  });
  const out = await s.run(feeds);
  const result: OnnxTensor[] = [];
  for (const name of s.outputNames) {
    const t = out[name];
    const data = t.type === "float16" ? fromHalfArray(t.data as Uint16Array) : Float32Array.from(t.data as ArrayLike<number>);
    result.push({ data, dims: [...t.dims] });
    t.dispose?.();
  }
  for (const t of Object.values(feeds)) t.dispose?.();
  return result;
}

/** CLIP / MiniLM embeddings through transformers.js, files from aimodel:. */
async function embed(model: AiModelId, input: Exclude<ModelInput, { kind: "onnx" }>): Promise<Float32Array> {
  const tf = await import("@huggingface/transformers");
  tf.env.allowLocalModels = false;
  tf.env.allowRemoteModels = true;
  tf.env.remoteHost = "aimodel://";
  tf.env.remotePathTemplate = "{model}/";
  tf.env.useBrowserCache = false;
  if (live) {
    await live.session.release().catch(() => {});
    live = null;
  }
  embedders ??= new Map();
  const get = async <T,>(key: string, make: () => Promise<T>): Promise<T> => {
    if (!embedders!.has(key)) embedders!.set(key, await make());
    return embedders!.get(key) as T;
  };
  const opts = { dtype: "q8" as const, device: "wasm" as const };
  const norm = (v: Float32Array) => {
    let s = 0;
    for (const x of v) s += x * x;
    const k = 1 / Math.sqrt(s || 1);
    return Float32Array.from(v, (x) => x * k);
  };
  if (model === "minilm-l6") {
    if (input.kind !== "text") throw new Error("MiniLM embeds text only");
    const extractor = await get("minilm", () => tf.pipeline("feature-extraction", model, opts));
    const out = await (extractor as (t: string, o: object) => Promise<{ data: Float32Array }>)(input.text, { pooling: "mean", normalize: true });
    return Float32Array.from(out.data);
  }
  if (model !== "clip-vit-b32") throw new Error(`${model} doesn't embed`);
  if (input.kind === "text") {
    const tokenizer = await get("clip-tok", () => tf.AutoTokenizer.from_pretrained(model));
    const textModel = await get("clip-text", () => tf.CLIPTextModelWithProjection.from_pretrained(model, opts));
    const inputs = (tokenizer as (t: string[], o: object) => object)([input.text], { padding: true, truncation: true });
    const { text_embeds } = (await (textModel as (i: object) => Promise<{ text_embeds: { data: Float32Array } }>)(inputs));
    return norm(Float32Array.from(text_embeds.data));
  }
  const processor = await get("clip-proc", () => tf.AutoProcessor.from_pretrained(model));
  const visionModel = await get("clip-vision", () => tf.CLIPVisionModelWithProjection.from_pretrained(model, opts));
  const raw = new tf.RawImage(new Uint8ClampedArray(input.image.data), input.image.width, input.image.height, 4);
  const inputs = await (processor as (i: unknown) => Promise<object>)(raw);
  const { image_embeds } = await (visionModel as (i: object) => Promise<{ image_embeds: { data: Float32Array } }>)(inputs);
  return norm(Float32Array.from(image_embeds.data));
}

self.onmessage = async (e: MessageEvent<{ reqId: number; model: AiModelId; input: ModelInput }>) => {
  const { reqId, model, input } = e.data;
  try {
    const output = input.kind === "onnx" ? await onnx(model, input) : await embed(model, input);
    const transfer = Array.isArray(output) ? output.map((t) => t.data.buffer as ArrayBuffer) : [(output as Float32Array).buffer as ArrayBuffer];
    self.postMessage({ reqId, ok: true, output }, transfer);
  } catch (err) {
    self.postMessage({ reqId, ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
