/**
 * The store's `search` repository (docs/ai.md §6, §8): the visual search index of every file this computer has
 * opened. The editors compute the vectors (CLIP image, MiniLM text) and hand them in with a 224 px thumbnail; the
 * store keeps one index file per file (`format.ts`), answers `versions` so an editor re-embeds only what changed, and
 * ranks queries by cosine with exact name matches first (`rank.ts`).
 *
 * - Files that no longer exist (deleted from the workspace — `fileDeleted` — or gone from the workspace's list) drop
 *   their index; trashed files are left out of results until they are restored.
 * - Indexes load lazily, once, and stay in memory (a few KB a node); writes go through one queue.
 *
 * No Node or DOM imports: the desktop store (`Workspace/spaces/search/`) and the browser's dev store (keys) both run
 * it through `SearchStoreHost`.
 */
import type { SearchDoc, SearchHit, SearchKind, SearchQuery, SearchRepository, SearchVectors } from "../../shared/ai/types";
import { StoreError } from "../../shared/store/protocol";
import { SerialQueue } from "../../shared/store/queue";
import type { FileMeta } from "../../shared/store/types";
import { CLIP_DIM, TEXT_DIM, decodeIndex, encodeIndex, normalize, type FileIndex, type IndexEntry } from "./format";
import { rank } from "./rank";

export interface SearchStoreHost {
  /** `<fileKey>.idx` under the search folder; null: none */
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  /** The file names in the search folder */
  list(): Promise<string[]>;
  getMeta(fileKey: string): FileMeta | null;
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void;
}

const KINDS: readonly SearchKind[] = ["frame", "component", "componentSet"];
/** A node's text as indexed (docs/ai.md §6: ≤ 2,000 chars) */
export const MAX_TEXT = 2000;
/** A thumbnail (224 px PNG) — anything bigger is refused */
export const MAX_THUMB = 2 * 1024 * 1024;
const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
const nameOf = (fileKey: string) => `${fileKey}.idx`;

const bad = (what: string) => new StoreError("invalid", `search: ${what}`);

function checkKey(fileKey: unknown): string {
  if (typeof fileKey !== "string" || !KEY_RE.test(fileKey)) throw bad("bad file key");
  return fileKey;
}

function cleanDoc(d: SearchDoc): SearchDoc {
  if (!d || typeof d !== "object") throw bad("missing doc");
  const str = (v: unknown, what: string, max = 1000) => {
    if (typeof v !== "string" || v.length > max) throw bad(`bad ${what}`);
    return v;
  };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (!KINDS.includes(d.kind)) throw bad("bad kind");
  return {
    fileKey: checkKey(d.fileKey),
    fileName: str(d.fileName, "file name"),
    nodeId: str(d.nodeId, "node id", 200),
    kind: d.kind,
    name: str(d.name, "name"),
    pageId: str(d.pageId, "page id", 200),
    pageName: str(d.pageName, "page name"),
    version: str(d.version, "version", 200),
    text: typeof d.text === "string" ? d.text.slice(0, MAX_TEXT) : "",
    width: num(d.width),
    height: num(d.height),
    modifiedAt: num(d.modifiedAt),
  };
}

function vector(v: unknown, dim: number, what: string): Float32Array {
  if (v === undefined || v === null) return new Float32Array(dim);
  if (!(v instanceof Float32Array) && !Array.isArray(v)) throw bad(`bad ${what} vector`);
  if (v.length !== dim) throw bad(`${what} vector has ${v.length} values, not ${dim}`);
  return normalize(v as ArrayLike<number>, dim);
}

export class SearchService {
  private readonly loaded = new Map<string, FileIndex>();
  private all: Promise<void> | null = null;
  private readonly queue = new SerialQueue();

  constructor(private readonly host: SearchStoreHost) {}

  repository(): SearchRepository {
    return {
      upsert: (entries) => this.upsert(entries),
      remove: (fileKey, nodeIds) => this.remove(fileKey, nodeIds),
      versions: (fileKey) => this.versions(fileKey),
      query: (q) => this.query(q),
      thumb: (fileKey, nodeId) => this.thumb(fileKey, nodeId),
      stats: () => this.stats(),
      clear: () => this.clear(),
    };
  }

  /** A file was deleted from the workspace: its index goes too. */
  fileDeleted(fileKey: string): Promise<void> {
    return this.queue.run(async () => {
      this.loaded.delete(fileKey);
      await this.host.remove(nameOf(fileKey));
    });
  }

  async upsert(entries: { doc: SearchDoc; vectors: SearchVectors; thumb: Uint8Array }[]): Promise<void> {
    if (!Array.isArray(entries)) throw bad("entries must be a list");
    const clean = entries.map((e) => {
      const doc = cleanDoc(e?.doc);
      if (!(e.thumb instanceof Uint8Array) || e.thumb.length > MAX_THUMB) throw bad("bad thumbnail");
      return { doc, clip: vector(e.vectors?.clip, CLIP_DIM, "clip"), text: vector(e.vectors?.text, TEXT_DIM, "text"), thumb: e.thumb.slice() };
    });
    const byFile = new Map<string, IndexEntry[]>();
    for (const e of clean) byFile.set(e.doc.fileKey, [...(byFile.get(e.doc.fileKey) ?? []), e]);
    await this.queue.run(async () => {
      for (const [fileKey, list] of byFile) {
        if (!this.host.getMeta(fileKey)) throw new StoreError("not-found", `search: no file ${fileKey}`);
        const index = (await this.load(fileKey)) ?? { fileKey, dims: { clip: CLIP_DIM, text: TEXT_DIM }, entries: new Map() };
        for (const e of list) index.entries.set(e.doc.nodeId, e);
        await this.save(index);
      }
    });
  }

  remove(fileKey: string, nodeIds?: string[]): Promise<void> {
    checkKey(fileKey);
    if (nodeIds !== undefined && (!Array.isArray(nodeIds) || nodeIds.some((n) => typeof n !== "string"))) throw bad("bad node ids");
    return this.queue.run(async () => {
      if (!nodeIds) {
        this.loaded.delete(fileKey);
        await this.host.remove(nameOf(fileKey));
        return;
      }
      const index = await this.load(fileKey);
      if (!index) return;
      let changed = false;
      for (const id of nodeIds) changed = index.entries.delete(id) || changed;
      if (changed) await this.save(index);
    });
  }

  async versions(fileKey: string): Promise<Record<string, string>> {
    checkKey(fileKey);
    const index = await this.queue.run(() => this.load(fileKey));
    const out: Record<string, string> = {};
    for (const [id, e] of index?.entries ?? []) out[id] = e.doc.version;
    return out;
  }

  async query(q: SearchQuery): Promise<SearchHit[]> {
    if (!q || typeof q !== "object") throw bad("missing query");
    if (q.kinds && (!Array.isArray(q.kinds) || q.kinds.some((k) => !KINDS.includes(k)))) throw bad("bad kinds");
    if (q.sort !== "relevance" && q.sort !== "modified") throw bad("bad sort");
    if (q.clip !== undefined && q.clip.length !== CLIP_DIM) throw bad(`clip vector has ${q.clip.length} values, not ${CLIP_DIM}`);
    if (q.textVec !== undefined && q.textVec.length !== TEXT_DIM) throw bad(`text vector has ${q.textVec.length} values, not ${TEXT_DIM}`);
    await this.loadAll();
    const files = q.fileKey ? [this.loaded.get(q.fileKey)] : q.libraryKey ? [this.loaded.get(q.libraryKey)] : [...this.loaded.values()];
    const metas = new Map<string, FileMeta | null>();
    const metaOf = (k: string) => {
      if (!metas.has(k)) metas.set(k, this.host.getMeta(k));
      return metas.get(k)!;
    };
    const gone = new Set<string>();
    function* entries() {
      for (const f of files) if (f) yield* f.entries.values();
    }
    const hits = rank(entries(), q, (e) => {
      const meta = metaOf(e.doc.fileKey);
      if (!meta) gone.add(e.doc.fileKey);
      return !!meta && meta.trashedAt === null;
    });
    // Files deleted while the store wasn't told (another store, by hand): their index goes now.
    for (const k of gone) void this.fileDeleted(k);
    // The file's current name (renamed since it was indexed).
    return hits.map((h) => {
      const name = metaOf(h.doc.fileKey)?.name;
      return name && name !== h.doc.fileName ? { ...h, doc: { ...h.doc, fileName: name } } : h;
    });
  }

  async thumb(fileKey: string, nodeId: string): Promise<Uint8Array | null> {
    checkKey(fileKey);
    const index = await this.queue.run(() => this.load(fileKey));
    return index?.entries.get(nodeId)?.thumb ?? null;
  }

  async stats(): Promise<{ files: number; docs: number; bytes: number }> {
    await this.loadAll();
    let docs = 0;
    let bytes = 0;
    for (const f of this.loaded.values()) {
      docs += f.entries.size;
      for (const e of f.entries.values()) bytes += (f.dims.clip + f.dims.text) * 2 + e.thumb.length;
    }
    return { files: this.loaded.size, docs, bytes };
  }

  clear(): Promise<void> {
    return this.queue.run(async () => {
      this.loaded.clear();
      this.all = null;
      for (const name of await this.host.list()) if (name.endsWith(".idx")) await this.host.remove(name);
    });
  }

  // ---- loading and saving ----

  private async load(fileKey: string): Promise<FileIndex | null> {
    const cached = this.loaded.get(fileKey);
    if (cached) return cached;
    const bytes = await this.host.read(nameOf(fileKey)).catch((err: unknown) => {
      this.host.log("warn", `search: couldn't read the index of ${fileKey}`, err);
      return null;
    });
    if (!bytes) return null;
    const index = decodeIndex(bytes);
    if (!index || index.fileKey !== fileKey || index.dims.clip !== CLIP_DIM || index.dims.text !== TEXT_DIM) {
      // Another format or other models: the editors index the file again.
      this.host.log("info", `search: the index of ${fileKey} is from another version; starting it again`);
      await this.host.remove(nameOf(fileKey));
      return null;
    }
    this.loaded.set(fileKey, index);
    return index;
  }

  private loadAll(): Promise<void> {
    this.all ??= this.queue.run(async () => {
      for (const name of await this.host.list()) {
        if (!name.endsWith(".idx")) continue;
        const fileKey = name.slice(0, -4);
        if (!KEY_RE.test(fileKey)) continue;
        if (!this.host.getMeta(fileKey)) {
          await this.host.remove(name);
          continue;
        }
        await this.load(fileKey);
      }
    });
    // A failed listing is tried again next time.
    this.all.catch(() => (this.all = null));
    return this.all;
  }

  private async save(index: FileIndex): Promise<void> {
    this.loaded.set(index.fileKey, index);
    if (!index.entries.size) return this.host.remove(nameOf(index.fileKey));
    await this.host.write(nameOf(index.fileKey), encodeIndex(index));
  }
}

export { type IndexEntry };
