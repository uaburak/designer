/**
 * Visual search's worker (docs/ai.md §2.4, §6): CLIP ViT-B/32 and all-MiniLM-L6-v2 through transformers.js over
 * onnxruntime-web — WebGPU where the GPU has it, else Wasm. The model files come from main's `aimodel://<id>/…`
 * (downloaded on first use after a confirmation, 6b); nothing is fetched from the network. onnxruntime's own Wasm is
 * bundled with the app (no CDN).
 */
/// <reference lib="webworker" />
import { AutoProcessor, AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, RawImage, env, pipeline, type FeatureExtractionPipeline, type PreTrainedModel, type PreTrainedTokenizer, type Processor } from "@huggingface/transformers";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import type { EmbedReply, EmbedRequest } from "./embedder";

/** transformers.js asks `<host>/<model>/<file>`; the fetch below turns it into `aimodel://<model>/<file>`. */
const HOST = "https://aimodel.invalid/";
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.remoteHost = HOST;
env.remotePathTemplate = "{model}/";
env.useBrowserCache = false;
/** onnxruntime's own runtime, bundled with the app: transformers.js pre-loads it through `env.fetch` too (refusing it
 * only logged "Failed to pre-load WASM binary" and loaded it again — seen running search in the app, 2026-10-12). */
const RUNTIME = new Set([ortMjs, ortWasm].map((u) => new URL(u, self.location.href).href));
env.fetch = (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  if (RUNTIME.has(new URL(url, self.location.href).href)) return fetch(url, init);
  if (!url.startsWith(HOST)) return Promise.reject(new Error(`Visual search reads only its own models (${url})`));
  return fetch(`aimodel://${url.slice(HOST.length)}`, init);
};
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; proxy?: boolean } };
if (onnx.wasm) onnx.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };

const CLIP = "clip-vit-b32";
const MINILM = "minilm-l6";

type Device = "webgpu" | "wasm";
let device: Device = (self.navigator as Navigator & { gpu?: unknown }).gpu ? "webgpu" : "wasm";

let vision: Promise<{ processor: Processor; model: PreTrainedModel }> | null = null;
let clipText: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | null = null;
let minilm: Promise<FeatureExtractionPipeline> | null = null;

/** A model on WebGPU, else (no adapter, an op it lacks) on Wasm from then on */
async function onDevice<T>(load: (d: Device) => Promise<T>): Promise<T> {
  try {
    return await load(device);
  } catch (err) {
    if (device !== "webgpu") throw err;
    device = "wasm";
    return load(device);
  }
}

const visionModel = () =>
  (vision ??= onDevice(async (d) => ({
    processor: await AutoProcessor.from_pretrained(CLIP),
    model: await CLIPVisionModelWithProjection.from_pretrained(CLIP, { dtype: "q8", device: d }),
  })));
const textModel = () =>
  (clipText ??= onDevice(async (d) => ({
    tokenizer: await AutoTokenizer.from_pretrained(CLIP),
    model: await CLIPTextModelWithProjection.from_pretrained(CLIP, { dtype: "q8", device: d }),
  })));
const sentenceModel = () => (minilm ??= onDevice((d) => pipeline("feature-extraction", MINILM, { dtype: "q8", device: d }) as Promise<FeatureExtractionPipeline>));

const vectorOf = (t: { data: unknown }) => Float32Array.from(t.data as ArrayLike<number>);

async function run(req: Exclude<EmbedRequest, { op: "release" }>): Promise<Float32Array> {
  switch (req.op) {
    case "image": {
      const { processor, model } = await visionModel();
      const image = new RawImage(req.image.pixels, req.image.width, req.image.height, 4).rgb();
      const out = (await model(await processor(image))) as { image_embeds: { data: ArrayLike<number> } };
      return vectorOf(out.image_embeds);
    }
    case "clipText": {
      const { tokenizer, model } = await textModel();
      const inputs = tokenizer([req.text], { padding: true, truncation: true });
      const out = (await model(inputs)) as { text_embeds: { data: ArrayLike<number> } };
      return vectorOf(out.text_embeds);
    }
    case "text": {
      const extract = await sentenceModel();
      return vectorOf(await extract(req.text, { pooling: "mean", normalize: true }));
    }
  }
}

async function release(): Promise<void> {
  const all = [vision, clipText, minilm];
  vision = clipText = minilm = null;
  for (const p of all) {
    const m = await p?.catch(() => null);
    if (!m) continue;
    await ("model" in m ? m.model : m).dispose().catch(() => undefined);
  }
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (e: MessageEvent<EmbedRequest>) => {
  const req = e.data;
  if (req.op === "release") {
    void release().then(() => scope.postMessage({ id: req.id, released: true } satisfies EmbedReply));
    return;
  }
  run(req).then(
    (vector) => scope.postMessage({ id: req.id, vector } satisfies EmbedReply, [vector.buffer]),
    (err: unknown) => scope.postMessage({ id: req.id, error: err instanceof Error ? err.message : String(err) } satisfies EmbedReply),
  );
};
