/// <reference lib="webworker" />
/**
 * The models' Worker (docs/ai.md §2.4): onnxruntime-web over WebGPU, falling back to wasm (sessions.ts: a model that
 * fails on WebGPU — at creation or at its first run — is done again on wasm and stays there), with the model files
 * read from `aimodel://<id>/<path>` (main serves the downloaded, checked files). One session lives at a time: a call
 * for another model releases the one before. fp16 models get fp16 inputs (as their metadata asks) and their outputs
 * come back as float32. The search models (CLIP, MiniLM) run in visual search's own worker.
 */
import * as ort from "onnxruntime-web/webgpu";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import type { AiModelId } from "../../../../shared/ai/types";
import type { ModelInput, OnnxTensor } from "./worker";
import { fromHalfArray, toHalfArray } from "./pixels";
import { SessionCache } from "./sessions";

declare const self: DedicatedWorkerGlobalScope;

ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
ort.env.wasm.numThreads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

/** The live model's bytes, so a fallback to wasm doesn't fetch them again */
let bytesOf: { key: string; bytes: Uint8Array } | null = null;

/** One live session (a call for another model releases it): WebGPU else wasm, a WebGPU failure redone on wasm (sessions.ts). */
const sessions = new SessionCache<ort.InferenceSession>(
  {
    async hasGpu() {
      return "gpu" in navigator && !!(await (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter().catch(() => null));
    },
    async open(key, providers) {
      if (bytesOf?.key !== key) {
        bytesOf = null;
        bytesOf = { key, bytes: new Uint8Array(await (await fetch(`aimodel://${key}`)).arrayBuffer()) };
      }
      // No memory pattern: it assumes every run has the shapes of the first, and Swin2SR's tiles vary.
      return ort.InferenceSession.create(bytesOf.bytes, { executionProviders: providers, graphOptimizationLevel: "all", enableMemPattern: false });
    },
    async release(s) {
      await s.release();
    },
    log(message) {
      console.info(`[ai models] ${message}`);
    },
  },
  // LaMa's FFT layers answer garbage on WebGPU (checked 2026-10-12, Apple M3); wasm is right (≈ 4–5 s for 512²).
  { wasmOnly: (key) => key.startsWith("lama/") }
);

/** Whether the session's input takes float16 (its metadata), else float32. */
function wantsHalf(s: ort.InferenceSession, i: number): boolean {
  const meta = (s as unknown as { inputMetadata?: { type?: string }[] }).inputMetadata?.[i];
  return meta?.type === "float16";
}

async function onnx(model: AiModelId, input: Extract<ModelInput, { kind: "onnx" }>): Promise<OnnxTensor[]> {
  return sessions.run(`${model}/${input.file}`, (s) => runOn(s, input));
}

async function runOn(s: ort.InferenceSession, input: Extract<ModelInput, { kind: "onnx" }>): Promise<OnnxTensor[]> {
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
