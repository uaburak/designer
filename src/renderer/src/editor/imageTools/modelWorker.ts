/// <reference lib="webworker" />
/**
 * The models' Worker (docs/ai.md §2.4): onnxruntime-web over WebGPU, falling back to wasm, with the model files read
 * from `aimodel://<id>/<path>` (main serves the downloaded, checked files). One session lives at a time: a call for
 * another model releases the one before. fp16 models get fp16 inputs (as their metadata asks) and their outputs come
 * back as float32. The search models (CLIP, MiniLM) go through @huggingface/transformers for their tokenizers and
 * processors, pointed at the same scheme; loaded only when asked for.
 */
import * as ort from "onnxruntime-web/webgpu";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import type { AiModelId } from "../../../../shared/ai/types";
import type { ModelInput, OnnxTensor } from "./worker";
import { fromHalfArray, toHalfArray } from "./pixels";

declare const self: DedicatedWorkerGlobalScope;

ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
ort.env.wasm.numThreads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

let live: { key: string; session: ort.InferenceSession } | null = null;

async function session(model: AiModelId, file: string): Promise<ort.InferenceSession> {
  const key = `${model}/${file}`;
  if (live?.key === key) return live.session;
  await live?.session.release().catch(() => {});
  live = null;
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

self.onmessage = async (e: MessageEvent<{ reqId: number; model: AiModelId; input: ModelInput }>) => {
  const { reqId, model, input } = e.data;
  try {
    if (input.kind !== "onnx") throw new Error("Embeddings run in visual search's own worker (editor/search/embed.worker.ts).");
    const output = await onnx(model, input);
    const transfer = output.map((t) => t.data.buffer as ArrayBuffer);
    self.postMessage({ reqId, ok: true, output }, transfer);
  } catch (err) {
    self.postMessage({ reqId, ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
