/**
 * Visual search's indexer for the open file (docs/ai.md §6). While the editor is idle — 30 s after the last change,
 * ≤ 20 nodes a pass — it brings the store's index of this file up to date:
 *
 * - every target (top-level frame, component, set) whose content hash differs from the version the store has is
 *   rendered at 224 px, embedded (CLIP image, MiniLM text) and upserted with its thumbnail;
 * - nodes the store has that are gone from the file are removed;
 * - after the first full check of a session, only targets a change touched (NODES_CHANGED, local or remote) are
 *   hashed again.
 *
 * Nothing runs while Settings › AI's "Index files for visual search" (or AI) is off, or before the models are on this
 * computer (they download from the search view, after a confirmation).
 */
import type { SearchDoc, SearchRepository } from "../../../../shared/ai/types";
import type { Embedder, RgbaImage } from "./embedder";
import { THUMB_SIZE, type SearchSource } from "./source";

export const INDEX_DEBOUNCE_MS = 30_000;
/** Next pass when one stopped with work left */
export const INDEX_CONTINUE_MS = 2_000;
export const NODES_PER_PASS = 20;
/** A node whose fonts or images keep loading is drawn as it is after this many passes */
const BUSY_PASSES = 2;

export interface IndexerDeps {
  source: SearchSource;
  repo: Pick<SearchRepository, "versions" | "upsert" | "remove">;
  /** The models, or null while they aren't on this computer */
  embedder(): Promise<Embedder | null>;
  /** Settings › AI allows indexing */
  enabled(): Promise<boolean>;
  encodePng(image: RgbaImage): Promise<Uint8Array>;
  now(): number;
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  /** Runs `fn` when the main thread is idle (requestIdleCallback); default: at once */
  idle?(fn: () => void): void;
  log?(message: string, detail?: unknown): void;
}

export interface PassResult {
  indexed: number;
  removed: number;
  /** Targets left for the next pass */
  left: number;
  skipped?: "disabled" | "no-models" | "busy";
}

/** `image` centred on a white square (CLIP's processor would crop a wide frame's sides otherwise) */
export function squareOnWhite(image: RgbaImage): RgbaImage {
  const side = Math.max(image.width, image.height, 1);
  const out = new Uint8Array(side * side * 4).fill(255);
  const ox = Math.floor((side - image.width) / 2);
  const oy = Math.floor((side - image.height) / 2);
  const src = image.pixels;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const s = (y * image.width + x) * 4;
      const d = ((y + oy) * side + x + ox) * 4;
      const a = src[s + 3] / 255;
      out[d] = Math.round(src[s] * a + 255 * (1 - a));
      out[d + 1] = Math.round(src[s + 1] * a + 255 * (1 - a));
      out[d + 2] = Math.round(src[s + 2] * a + 255 * (1 - a));
    }
  }
  return { width: side, height: side, pixels: out };
}

export class SearchIndexer {
  /** Targets checked against the store this session (after that only touched ones are hashed again) */
  private readonly checked = new Set<string>();
  private readonly dirty = new Set<string>();
  /** Changed refs not yet mapped to targets */
  private readonly touched = new Set<string>();
  private readonly busy = new Map<string, number>();
  private timer: unknown = null;
  private running: Promise<PassResult> | null = null;
  private stopped = false;
  private readonly timers: NonNullable<IndexerDeps["timers"]>;

  constructor(private readonly deps: IndexerDeps) {
    this.timers = deps.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  /** The first pass, after the debounce */
  start(): void {
    this.schedule(INDEX_DEBOUNCE_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Nodes changed (any node: mapped to the targets above it at the next pass); the pass waits 30 s more */
  touch(refs: Iterable<string>): void {
    for (const r of refs) this.touched.add(r);
    this.schedule(INDEX_DEBOUNCE_MS);
  }

  /** Runs a pass now (tests, or "index now" after the models arrive) */
  runNow(): Promise<PassResult> {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    return this.pass();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      const go = () => void this.pass().catch((err: unknown) => this.deps.log?.("visual search: indexing failed", err));
      if (this.deps.idle) this.deps.idle(go);
      else go();
    }, ms);
  }

  private pass(): Promise<PassResult> {
    this.running ??= this.passOnce().finally(() => (this.running = null));
    return this.running;
  }

  private async passOnce(): Promise<PassResult> {
    const { source, repo } = this.deps;
    if (!(await this.deps.enabled())) return { indexed: 0, removed: 0, left: 0, skipped: "disabled" };
    const embedder = await this.deps.embedder();
    if (!embedder) return { indexed: 0, removed: 0, left: 0, skipped: "no-models" };

    // Map what changed to the targets above it.
    for (const ref of this.touched) for (const id of source.chain(ref)) this.dirty.add(id);
    this.touched.clear();

    const targets = source.targets();
    const stored = await repo.versions(source.fileKey);
    const present = new Set(targets.map((t) => t.nodeId));
    const gone = Object.keys(stored).filter((id) => !present.has(id));
    if (gone.length) await repo.remove(source.fileKey, gone);

    const todo = targets.filter((t) => !stored[t.nodeId] || !this.checked.has(t.nodeId) || this.dirty.has(t.nodeId));
    const entries: { doc: SearchDoc; vectors: { clip: Float32Array; text: Float32Array }; thumb: Uint8Array }[] = [];
    let i = 0;
    let waiting = false;
    for (; i < todo.length && entries.length < NODES_PER_PASS; i++) {
      if (this.stopped) break;
      const t = todo[i];
      const version = source.version(t.nodeId);
      if (stored[t.nodeId] === version) {
        this.checked.add(t.nodeId);
        this.dirty.delete(t.nodeId);
        continue;
      }
      const tries = this.busy.get(t.nodeId) ?? 0;
      const px = source.pixels(t.nodeId, THUMB_SIZE, tries >= BUSY_PASSES);
      if (px === "busy") {
        this.busy.set(t.nodeId, tries + 1);
        waiting = true;
        continue;
      }
      this.busy.delete(t.nodeId);
      this.checked.add(t.nodeId);
      this.dirty.delete(t.nodeId);
      if (!px) continue; // draws nothing
      const text = source.text(t.nodeId);
      const [clip, textVec, thumb] = await Promise.all([embedder.image(squareOnWhite(px)), embedder.text(text || t.name), this.deps.encodePng(px)]);
      entries.push({
        doc: { fileKey: source.fileKey, fileName: source.fileName(), nodeId: t.nodeId, kind: t.kind, name: t.name, pageId: t.pageId, pageName: t.pageName, version, text, width: t.width, height: t.height, modifiedAt: this.deps.now() },
        vectors: { clip, text: textVec },
        thumb,
      });
    }
    if (entries.length) await repo.upsert(entries);
    const left = todo.length - i + (waiting ? 1 : 0);
    if (left > 0) this.schedule(INDEX_CONTINUE_MS);
    return { indexed: entries.length, removed: gone.length, left, ...(waiting && !entries.length ? { skipped: "busy" as const } : {}) };
  }
}
