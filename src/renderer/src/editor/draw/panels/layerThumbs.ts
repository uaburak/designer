/**
 * Layer previews for Draw's Layers rows (docs/draw.md §5.9): each layer drawn alone by the engine's node thumbnail
 * (`renderNodeThumbnailPixels`, 64 device px = the 32 box at 2×), for the rows on screen only, cached by the layer's
 * content version and redrawn when a DOCUMENT_CHANGED touches the layer or anything under it — at most 8 a frame,
 * while the editor is idle. The cache keeps the last 512 previews (least recently shown out first).
 *
 * A preview is kept as the engine's RGBA (the row's canvas puts it with putImageData — an ImageBitmap would need an
 * async hop per preview for no gain at 64 px). A stale preview keeps showing until its redraw lands.
 */
import type { Guid, Pixels } from "@/engine/codec";
import type { EditorController } from "../../controller";

/** The preview's box in device px (32 CSS px at 2×). */
export const THUMB_MAX = 64;
/** Previews kept. */
export const THUMB_LRU = 512;
/** Previews drawn per idle slice. */
export const THUMBS_PER_FRAME = 8;

export type ThumbRender = (node: Guid, maxSize: number) => Pixels | null;
export type Scheduler = (run: () => void) => void;

/** requestIdleCallback where there is one (the editor's renderer), else the next frame or task. */
export const idle: Scheduler = (run) => {
  const w = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; requestAnimationFrame?: (cb: () => void) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 200 });
  else if (w.requestAnimationFrame) w.requestAnimationFrame(run);
  else setTimeout(run, 16);
};

interface Entry {
  version: number;
  pixels: Pixels | null;
}

export class LayerThumbnails {
  /** Insertion order = least recently shown first. */
  private readonly cache = new Map<Guid, Entry>();
  /** Content versions: bumped when a change reaches the layer or its subtree. */
  private readonly versions = new Map<Guid, number>();
  private readonly listeners = new Map<Guid, Set<() => void>>();
  private readonly queue = new Set<Guid>();
  private scheduled = false;
  /** How many previews the engine drew (tests, View › Memory usage). */
  rendered = 0;

  constructor(
    private readonly render: ThumbRender,
    private readonly schedule: Scheduler = idle,
    private readonly limit = THUMB_LRU,
    private readonly perFrame = THUMBS_PER_FRAME
  ) {}

  private version = (node: Guid) => this.versions.get(node) ?? 0;

  /**
   * The layer's preview for a row on screen: the cached one (current or stale — a stale one is queued for a redraw),
   * or undefined while it is queued for its first drawing; null when the engine draws nothing for it (empty).
   */
  get(node: Guid): Pixels | null | undefined {
    const hit = this.cache.get(node);
    if (hit) {
      // Shown: the most recently used.
      this.cache.delete(node);
      this.cache.set(node, hit);
    }
    if (!hit || hit.version !== this.version(node)) this.enqueue(node);
    return hit?.pixels;
  }

  /** A row on screen listens for its layer's preview; the returned function stops it (the row scrolled away). */
  subscribe(node: Guid, listener: () => void): () => void {
    let set = this.listeners.get(node);
    if (!set) this.listeners.set(node, (set = new Set()));
    set.add(listener);
    // (A slice that ran between the row's render and its subscription dropped it from the queue.)
    if (this.cache.get(node)?.version !== this.version(node)) this.enqueue(node);
    return () => {
      set!.delete(listener);
      if (!set!.size) {
        this.listeners.delete(node);
        this.queue.delete(node);
      }
    };
  }

  /** Changed layers: they and their ancestors (`parentOf`) get a new version; removed layers leave the cache. */
  invalidate(changed: Iterable<Guid>, parentOf: (id: Guid) => Guid | null, removed: Iterable<Guid> = []): void {
    const touched = new Set<Guid>();
    for (const id of changed) {
      for (let at: Guid | null = id, guard = 0; at && !touched.has(at) && guard < 1000; at = parentOf(at), guard++) touched.add(at);
    }
    for (const id of touched) this.versions.set(id, this.version(id) + 1);
    for (const id of removed) {
      this.cache.delete(id);
      this.versions.delete(id);
    }
    for (const id of touched) if (this.listeners.has(id)) this.enqueue(id);
  }

  /** Everything again (a page switch, fonts or images arrived). */
  clear(): void {
    this.cache.clear();
    for (const id of this.listeners.keys()) this.enqueue(id);
  }

  get size(): number {
    return this.cache.size;
  }

  private enqueue(node: Guid): void {
    this.queue.add(node);
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.pump());
  }

  /** One idle slice: up to `perFrame` previews of rows still on screen, then the next slice if more are waiting. */
  pump(): void {
    this.scheduled = false;
    let drawn = 0;
    for (const node of [...this.queue]) {
      if (drawn >= this.perFrame) break;
      this.queue.delete(node);
      if (!this.listeners.has(node)) continue;
      const version = this.version(node);
      if (this.cache.get(node)?.version === version) continue;
      let pixels: Pixels | null = null;
      try {
        pixels = this.render(node, THUMB_MAX);
      } catch {
        pixels = null;
      }
      this.rendered++;
      drawn++;
      this.cache.delete(node);
      this.cache.set(node, { version, pixels: pixels && pixels.width > 0 && pixels.height > 0 ? pixels : null });
      while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value as Guid);
      this.listeners.get(node)?.forEach((l) => l());
    }
    if (this.queue.size && !this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.pump());
    }
  }
}

const perEditor = new WeakMap<object, LayerThumbnails>();

/**
 * The editor's previews: the engine draws them, the document's changes invalidate them (a change reaches every
 * ancestor's preview: a group shows its children).
 */
export function layerThumbnails(ed: EditorController): LayerThumbnails {
  let thumbs = perEditor.get(ed.engine);
  if (thumbs) return thumbs;
  thumbs = new LayerThumbnails((node, maxSize) => (ed.engine.destroyed ? null : ed.engine.renderNodeThumbnailPixels({ node, maxSize })));
  perEditor.set(ed.engine, thumbs);
  const t = thumbs;
  ed.engine.onDocumentChanged((changes) => {
    const tree = ed.getTree();
    const changed: Guid[] = [];
    const removed: Guid[] = [];
    // "s:l" on either wire (Engine.onDocumentChanged normalises the kiwi stream's {sessionID, localID}).
    for (const c of changes) if (c.guid) (c.phase === "REMOVED" ? removed : changed).push(c.guid);
    t.invalidate(changed, (id) => tree.nodes.get(id)?.parent ?? null, removed);
  });
  return thumbs;
}
