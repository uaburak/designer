/**
 * Visual search's models as the indexer and the query see them (docs/ai.md §6): CLIP ViT-B/32 (image and text, 512
 * floats) and all-MiniLM-L6-v2 (text, 384). The real one runs in a Worker (`embed.worker.ts`, transformers.js over
 * onnxruntime-web) on the files main serves at `aimodel://<id>/<path>` (6b); tests hand in a fake.
 */
import type { AiModelId } from "../../../../shared/ai/types";

/** Straight RGBA, as the engine's exports give it */
export interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface Embedder {
  /** CLIP's image embedding (512) */
  image(image: RgbaImage): Promise<Float32Array>;
  /** CLIP's text embedding (512), the same space as `image` */
  clipText(text: string): Promise<Float32Array>;
  /** MiniLM's sentence embedding (384), mean-pooled */
  text(text: string): Promise<Float32Array>;
  /** Releases the models (the worker stops) */
  dispose(): void;
}

/** The models visual search needs, in the order they download */
export const SEARCH_MODELS: readonly AiModelId[] = ["clip-vit-b32", "minilm-l6"];

/**
 * The files each model's worker reads under `aimodel://<id>/` — what 6b's download must hold (transformers.js reads
 * the configs and the tokenizer beside the ONNX files; `q8` picks the `_quantized` files of docs/ai.md §2.4).
 */
export const SEARCH_MODEL_FILES: Record<"clip-vit-b32" | "minilm-l6", { repo: string; files: readonly string[] }> = {
  "clip-vit-b32": {
    repo: "Xenova/clip-vit-base-patch32",
    files: ["config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/vision_model_quantized.onnx", "onnx/text_model_quantized.onnx"],
  },
  "minilm-l6": {
    repo: "Xenova/all-MiniLM-L6-v2",
    files: ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"],
  },
};

// ---- the worker's messages ----

export type EmbedRequest =
  | { id: number; op: "image"; image: RgbaImage }
  | { id: number; op: "clipText"; text: string }
  | { id: number; op: "text"; text: string }
  | { id: number; op: "release" };
export type EmbedReply = { id: number; vector: Float32Array } | { id: number; error: string } | { id: number; released: true };

/** The models are released after this long without a call (one session live at a time, docs/ai.md §2.4) */
export const IDLE_RELEASE_MS = 60_000;

interface WorkerLike {
  postMessage(message: EmbedRequest, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<EmbedReply>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

/**
 * The Worker's client. One worker per editor view, made on the first call and ended `IDLE_RELEASE_MS` after the last
 * (its models' memory goes with it); calls queue in the worker.
 */
export class WorkerEmbedder implements Embedder {
  private worker: WorkerLike | null = null;
  private next = 1;
  private readonly pending = new Map<number, { resolve: (v: Float32Array) => void; reject: (e: Error) => void }>();
  private idle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly make: () => WorkerLike = defaultWorker) {}

  image(image: RgbaImage): Promise<Float32Array> {
    const copy = { width: image.width, height: image.height, pixels: image.pixels.slice() };
    return this.call({ id: 0, op: "image", image: copy }, [copy.pixels.buffer]);
  }
  clipText(text: string): Promise<Float32Array> {
    return this.call({ id: 0, op: "clipText", text });
  }
  text(text: string): Promise<Float32Array> {
    return this.call({ id: 0, op: "text", text });
  }

  dispose(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error("Visual search stopped"));
    this.pending.clear();
  }

  private call(req: EmbedRequest, transfer: Transferable[] = []): Promise<Float32Array> {
    const w = (this.worker ??= this.start());
    const id = this.next++;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    return new Promise<Float32Array>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ ...req, id } as EmbedRequest, transfer);
    }).finally(() => {
      if (!this.pending.size && this.worker) this.idle = setTimeout(() => this.dispose(), IDLE_RELEASE_MS);
    });
  }

  private start(): WorkerLike {
    const w = this.make();
    w.onmessage = (e) => {
      const reply = e.data;
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      if ("vector" in reply) p.resolve(reply.vector);
      else if ("error" in reply) p.reject(new Error(reply.error));
    };
    w.onerror = (e) => {
      const err = new Error(e.message || "The visual search worker stopped");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    };
    return w;
  }
}

function defaultWorker(): WorkerLike {
  return new Worker(new URL("./embed.worker.ts", import.meta.url), { type: "module", name: "Visual search" }) as unknown as WorkerLike;
}
