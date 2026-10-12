import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import type { AiModelId, AiModelInfo, AiModelState } from "../../shared/ai/types";

/**
 * The local models (docs/ai.md §2.4): downloaded on first use — after the view's confirmation with the size — from
 * Hugging Face at a **pinned revision**, every file checked against its pinned SHA-256 and size, into
 * `userData/models/<id>/` (a `.partial` folder renamed into place once every file checked; a `manifest.json` names the
 * revision). Served read-only to the views at `aimodel://<id>/<path>` (./protocol.ts). Electron-free: the folder, the
 * fetch and the base URL are injected (tests run a local HTTP server).
 *
 * Pins (Hugging Face API, 2026-10-12): the revision is the repo's commit; LFS files' SHA-256 are the API's
 * `lfs.sha256`, small files' were computed from the bytes at that revision.
 */

const f = (path: string, bytes: number, sha256: string) => ({ path, bytes, sha256 });

const model = (m: Omit<AiModelInfo, "bytes">): AiModelInfo => ({ ...m, bytes: m.files.reduce((s, x) => s + x.bytes, 0) });

export const AI_MODELS: readonly AiModelInfo[] = [
  model({
    id: "birefnet-lite",
    label: "BiRefNet lite",
    use: "Remove background, Isolate",
    license: "MIT",
    repo: "onnx-community/BiRefNet_lite-ONNX",
    revision: "de15b22ba131738a16dff04aab8bdf8dc32e3ac1",
    files: [
      f("config.json", 81, "50acd2d700ee3d5facdcf3aab2312bb586372726dce8bdd5741bdae0ca6eb84f"),
      f("preprocessor_config.json", 391, "447d9ccb2c4129ab0ca045fc293e7d79dbc45e293ac1e94818d865db77f65a54"),
      f("onnx/model_fp16.onnx", 114_538_221, "d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402"),
    ],
  }),
  model({
    id: "swin2sr-x4",
    label: "Swin2SR x4",
    use: "Boost resolution",
    license: "Apache-2.0",
    repo: "Xenova/swin2SR-compressed-sr-x4-48",
    revision: "7d3f2242026e00cbd998056c2a11e200fce198a7",
    files: [
      f("config.json", 830, "d8bbbbc19933e760c29fe49e98c18001a7ec208f21b47c4531abac75348060d9"),
      f("preprocessor_config.json", 152, "cbc36266fcc93d5bc1e9ca69bcc648ae9d268918ad14cd3507216740f129cc4d"),
      f("onnx/model_fp16.onnx", 32_742_186, "1c47d2e3df273f6eec27073d489c54fc60e755aa036ef078dcf762f2a82c36b0"),
    ],
  }),
  model({
    id: "lama",
    label: "LaMa",
    use: "Erase",
    license: "Apache-2.0",
    repo: "opencv/inpainting_lama",
    revision: "aee6d22f0a13e5e35af1c9a1c3afd62841fc6f3f",
    files: [f("inpainting_lama_2025jan.onnx", 92_591_623, "7df918ac3921d3daf0aae1d219776cf0dc4e4935f035af81841b40adcf74fdf2")],
  }),
  model({
    id: "clip-vit-b32",
    label: "CLIP ViT-B/32",
    use: "Visual search",
    license: "MIT",
    repo: "Xenova/clip-vit-base-patch32",
    revision: "d15189d7028b43f1d3e65039190477f6af591c2a",
    files: [
      f("config.json", 4524, "493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495"),
      f("preprocessor_config.json", 520, "6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f"),
      f("tokenizer.json", 2_224_119, "f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd"),
      f("tokenizer_config.json", 775, "60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967"),
      f("special_tokens_map.json", 472, "c4864a9376a8401918425bed71fc14fc0e81f9b59ec45c1cf96cccb2df508eac"),
      f("onnx/vision_model_quantized.onnx", 89_117_001, "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299"),
      f("onnx/text_model_quantized.onnx", 64_504_507, "73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a"),
    ],
  }),
  model({
    id: "minilm-l6",
    label: "all-MiniLM-L6-v2",
    use: "Text search",
    license: "Apache-2.0",
    repo: "Xenova/all-MiniLM-L6-v2",
    revision: "751bff37182d3f1213fa05d7196b954e230abad9",
    files: [
      f("config.json", 650, "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7"),
      f("tokenizer.json", 711_661, "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0"),
      f("tokenizer_config.json", 366, "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3"),
      f("special_tokens_map.json", 125, "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3"),
      f("onnx/model_quantized.onnx", 22_972_370, "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1"),
    ],
  }),
];

export const MODEL_IDS = new Set<string>(AI_MODELS.map((m) => m.id));
export const isModelId = (v: unknown): v is AiModelId => typeof v === "string" && MODEL_IDS.has(v);

export interface ModelStoreOptions {
  /** userData/models */
  dir: string;
  /** Default https://huggingface.co */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Every state change (progress at most every 250 ms or 1 %) */
  onState?(s: AiModelState): void;
  /** The catalogue (tests pass their own) */
  models?: readonly AiModelInfo[];
}

interface Manifest {
  id: string;
  revision: string;
  files: { path: string; bytes: number; sha256: string }[];
}

/** A file path inside a model's folder, or null when it would leave it. */
export function safeJoin(root: string, rel: string): string | null {
  if (!rel || rel.includes("\0") || rel.startsWith("/") || rel.split("/").some((p) => p === ".." || p === "." || p === "")) return null;
  const full = normalize(join(root, rel));
  return full.startsWith(normalize(root) + sep) ? full : null;
}

export class ModelStore {
  private readonly downloads = new Map<AiModelId, Promise<AiModelState>>();
  private readonly progress = new Map<AiModelId, AiModelState>();
  private readonly errors = new Map<AiModelId, string>();
  private readonly models: readonly AiModelInfo[];

  constructor(private readonly o: ModelStoreOptions) {
    this.models = o.models ?? AI_MODELS;
  }

  info(): AiModelInfo[] {
    return this.models.map((m) => ({ ...m, files: m.files.map((x) => ({ ...x })) }));
  }

  private infoOf(id: AiModelId): AiModelInfo {
    const m = this.models.find((x) => x.id === id);
    if (!m) throw new Error(`Unknown model ${String(id)}`);
    return m;
  }

  private folder(id: AiModelId) {
    return join(this.o.dir, id);
  }

  /** Ready: the manifest names the pinned revision and every file is there at its size. */
  isReady(id: AiModelId): boolean {
    const m = this.infoOf(id);
    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(join(this.folder(id), "manifest.json"), "utf8")) as Manifest;
    } catch {
      return false;
    }
    if (manifest.revision !== m.revision) return false;
    return m.files.every((file) => {
      try {
        return statSync(join(this.folder(id), file.path)).size === file.bytes;
      } catch {
        return false;
      }
    });
  }

  state(id: AiModelId): AiModelState {
    const m = this.infoOf(id);
    const live = this.progress.get(id);
    if (live) return { ...live };
    if (this.isReady(id)) return { id, state: "ready", bytes: m.bytes };
    const error = this.errors.get(id);
    return error ? { id, state: "error", bytes: m.bytes, error } : { id, state: "absent", bytes: m.bytes };
  }

  states(): AiModelState[] {
    return this.models.map((m) => this.state(m.id));
  }

  /** A served file's absolute path (only a pinned file of a ready model), or null. */
  filePath(id: string, rel: string): string | null {
    const m = this.models.find((x) => x.id === id);
    if (!m) return null;
    if (!m.files.some((x) => x.path === rel)) return null;
    if (this.progress.has(m.id) || !this.isReady(m.id)) return null;
    return safeJoin(this.folder(m.id), rel);
  }

  private emit(s: AiModelState) {
    this.o.onState?.({ ...s });
  }

  /** Downloads (once at a time per model); resolves with the final state (ready or error). */
  download(id: AiModelId): Promise<AiModelState> {
    this.infoOf(id);
    if (this.isReady(id) && !this.progress.has(id)) return Promise.resolve(this.state(id));
    let p = this.downloads.get(id);
    if (!p) {
      p = this.run(id).finally(() => this.downloads.delete(id));
      this.downloads.set(id, p);
    }
    return p;
  }

  remove(id: AiModelId): AiModelState {
    this.infoOf(id);
    if (this.downloads.has(id)) throw new Error("The model is downloading");
    rmSync(this.folder(id), { recursive: true, force: true });
    rmSync(`${this.folder(id)}.partial`, { recursive: true, force: true });
    this.errors.delete(id);
    const s = this.state(id);
    this.emit(s);
    return s;
  }

  private async run(id: AiModelId): Promise<AiModelState> {
    const m = this.infoOf(id);
    const partial = `${this.folder(id)}.partial`;
    const fetchFn = this.o.fetch ?? fetch;
    const base = (this.o.baseUrl ?? "https://huggingface.co").replace(/\/+$/, "");
    this.errors.delete(id);
    let received = 0;
    let lastAt = 0;
    let lastPct = -1;
    const tick = (force = false) => {
      const s: AiModelState = { id, state: "downloading", received, bytes: m.bytes };
      this.progress.set(id, s);
      const pct = Math.floor((received / Math.max(1, m.bytes)) * 100);
      const now = Date.now();
      if (force || pct !== lastPct || now - lastAt > 250) {
        lastPct = pct;
        lastAt = now;
        this.emit(s);
      }
    };
    try {
      rmSync(partial, { recursive: true, force: true });
      mkdirSync(partial, { recursive: true });
      tick(true);
      for (const file of m.files) {
        const dest = safeJoin(partial, file.path);
        if (!dest) throw new Error(`Bad file path ${file.path}`);
        mkdirSync(dirname(dest), { recursive: true });
        const url = `${base}/${m.repo}/resolve/${m.revision}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
        const res = await fetchFn(url, { redirect: "follow" });
        if (!res.ok || !res.body) throw new Error(`Couldn't download ${file.path} (HTTP ${res.status})`);
        const hash = createHash("sha256");
        const out = createWriteStream(dest);
        let size = 0;
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > file.bytes) throw new Error(`${file.path} is larger than expected`);
            hash.update(value);
            received += value.byteLength;
            if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
            tick();
          }
        } finally {
          await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
        }
        const digest = hash.digest("hex");
        if (size !== file.bytes) throw new Error(`${file.path} is incomplete (${size} of ${file.bytes} bytes)`);
        if (digest !== file.sha256) throw new Error(`${file.path} didn't match its checksum`);
      }
      const manifest: Manifest = { id, revision: m.revision, files: m.files.map((x) => ({ ...x })) };
      writeFileSync(join(partial, "manifest.json"), JSON.stringify(manifest, null, 1));
      rmSync(this.folder(id), { recursive: true, force: true });
      renameSync(partial, this.folder(id));
      this.progress.delete(id);
      const s = this.state(id);
      this.emit(s);
      return s;
    } catch (err) {
      rmSync(partial, { recursive: true, force: true });
      this.progress.delete(id);
      const message = err instanceof Error ? err.message : String(err);
      this.errors.set(id, /fetch failed|ENOTFOUND|ECONN|EAI_AGAIN/i.test(message) ? "Couldn't reach Hugging Face. Check your connection and try again." : message);
      const s = this.state(id);
      this.emit(s);
      return s;
    }
  }
}
