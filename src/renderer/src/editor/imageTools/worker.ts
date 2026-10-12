/**
 * The local models' worker, as the editor calls it (docs/ai.md §2.4): `runModel(id, input)` runs a downloaded model
 * in a module Worker (modelWorker.ts: onnxruntime-web — WebGPU, else wasm). One worker, one live session at a time; the worker is ended after 60 s idle (its memory
 * goes with it — the 16 GB rule). The models' files come from main at `aimodel://<id>/<path>` once downloaded
 * (`ensureModel` asks first: models download on first use, owner §10.2).
 *
 * Inputs:
 * - `{kind: "onnx", file, inputs}` — one ONNX run of the model's `file` (the image tools' pre/post-processing is in
 *   runners.ts); answers `OnnxTensor[]` (the session's outputs in order).
 * - `{kind: "text"}` / `{kind: "image"}` are refused: visual search (6d) embeds in its own worker
 *   (editor/search/embed.worker.ts) over the same `aimodel:` files.
 */
import type { AiModelId } from "../../../../shared/ai/types";
import type { Rgba } from "./pixels";

export interface OnnxTensor {
  data: Float32Array;
  dims: number[];
}

export type ModelInput = { kind: "onnx"; file: string; inputs: OnnxTensor[] } | { kind: "text"; text: string } | { kind: "image"; image: Rgba };

export type ModelRunner = (id: AiModelId, input: ModelInput) => Promise<unknown>;

/** Idle time before the worker (and its session) goes. */
export const IDLE_MS = 60_000;

let override: ModelRunner | null = null;

/** Tests (and a browser without models) put their own runner here; null restores the worker. */
export function setModelRunner(r: ModelRunner | null): void {
  override = r;
}

let worker: Worker | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

function stopWorker() {
  worker?.terminate();
  worker = null;
  for (const p of pending.values()) p.reject(new Error("The model stopped."));
  pending.clear();
}

function startWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./modelWorker.ts", import.meta.url), { type: "module", name: "AI models" });
  w.onmessage = (e: MessageEvent<{ reqId: number; ok: boolean; output?: unknown; message?: string }>) => {
    const p = pending.get(e.data.reqId);
    if (!p) return;
    pending.delete(e.data.reqId);
    if (e.data.ok) p.resolve(e.data.output);
    else p.reject(new Error(e.data.message ?? "The model failed."));
    armIdle();
  };
  w.onerror = (e) => {
    const message = e.message || "The model's worker failed.";
    for (const p of pending.values()) p.reject(new Error(message));
    pending.clear();
    stopWorker();
  };
  worker = w;
  return w;
}

function armIdle() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    if (!pending.size) stopWorker();
  }, IDLE_MS);
}

const transferables = (input: ModelInput): Transferable[] => (input.kind === "onnx" ? input.inputs.map((t) => t.data.buffer as ArrayBuffer) : []);

export async function runModel(id: AiModelId, input: unknown): Promise<unknown> {
  if (override) return override(id, input as ModelInput);
  const w = startWorker();
  if (idle) clearTimeout(idle);
  const reqId = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    const i = input as ModelInput;
    w.postMessage({ reqId, model: id, input: i }, transferables(i));
  });
}

/** Ends the worker now (the editor closing, Settings › AI removing a model). */
export const releaseModels = () => stopWorker();
