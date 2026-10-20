/**
 * Component thumbnails for Assets, the swap picker and the library UI: rendered by the engine
 * (`renderNodeThumbnailPixels`, a GPU render and a synchronous read-back, ~1 ms each), but never on the critical path —
 * as Figma's panel fills its tiles in after it shows (its publish flow, too, yields while it prepares thumbnails:
 * atlas 12 §publish). A tile asks for its thumbnail only once it is on screen (one shared IntersectionObserver); the
 * requests are drawn a few per frame within a time budget; the pixels are cached per (node, size), so a re-render, a
 * scroll back, a search or another panel showing the same component draws from the cache. A cached thumbnail is
 * redrawn only when something inside its component changed — the refs of NODES_CHANGED and COMPONENTS_CHANGED (an
 * instance re-derived from its main's change) are resolved to the components they sit in once the editor is idle — and
 * until then the old pixels stay up (no flash). The cache keeps the most recently used ~48 MB.
 */
import { useEffect } from "react";
import type { Guid, Pixels } from "@/engine/codec";
import type { EditorController } from "./controller";
import { engineMethod } from "./engineCompat";

/** Time spent rendering thumbnails per frame (ms): a 120 Hz frame keeps most of its 8 ms. */
const FRAME_BUDGET = 4;
/** The cache's size in pixel bytes. */
const CACHE_BYTES = 48 * 1024 * 1024;
/** Past this many changed refs, every cached thumbnail is marked stale instead of resolving them one by one. */
const RESOLVE_LIMIT = 4000;

interface Entry {
  image: ImageData;
  /** Something inside the node changed since it was drawn: drawn again when next asked for (shown until then). */
  stale: boolean;
}

interface Request {
  node: Guid;
  maxSize: number;
  done: (image: ImageData | null) => void;
}

type Render = (o: { node: Guid; maxSize: number }) => Pixels | null;

const key = (node: Guid, maxSize: number) => `${node}|${maxSize}`;

export class AssetThumbnails {
  /** Insertion order is recency: a hit moves its entry to the end, the oldest go first. */
  private readonly cache = new Map<string, Entry>();
  private bytes = 0;
  /** Cached sizes per node (what invalidation marks). */
  private readonly sizes = new Map<Guid, Set<number>>();
  private readonly queue: Request[] = [];
  private frame = 0;
  /** Refs changed since the last resolution; null: too many, everything is stale. */
  private dirty: Set<Guid> | null = new Set();
  /**
   * Instances re-derived since (COMPONENTS_CHANGED): what they sit in is resolved, not they themselves — the engine
   * names an instance's main with it, and a main whose instance was inserted or moved hasn't changed.
   */
  private above = new Set<Guid>();
  private resolving = 0;
  private readonly offs: (() => void)[] = [];
  private readonly watchers = new Map<Guid, Set<() => void>>();
  /** Thumbnails rendered (tests and the bench count them). */
  rendered = 0;

  constructor(private readonly ed: EditorController) {
    const note = (refs: readonly Guid[], into: "dirty" | "above") => {
      if (!this.cache.size) return;
      const set = into === "dirty" ? this.dirty : this.above;
      if (this.dirty && set && set.size + refs.length <= RESOLVE_LIMIT) for (const r of refs) set.add(r);
      else this.dirty = null;
      this.scheduleResolve();
    };
    this.offs.push(
      ed.engine.on("NODES_CHANGED", (e) => note(e.refs, "dirty")),
      ed.engine.onAny((e) => {
        if ((e as { type: string }).type === "COMPONENTS_CHANGED") note((e as unknown as { refs: Guid[] }).refs ?? [], "above");
      })
    );
  }

  dispose(): void {
    this.offs.splice(0).forEach((off) => off());
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.resolving) cancelIdle(this.resolving);
    this.queue.length = 0;
    this.cache.clear();
    this.sizes.clear();
    this.bytes = 0;
  }

  /** Whether the engine can draw thumbnails at all (the glyph stands in otherwise). */
  get available(): boolean {
    return !!engineMethod<Render>(this.ed.engine, "renderNodeThumbnailPixels");
  }

  /** The cached thumbnail (stale or not), or null. */
  peek(node: Guid, maxSize: number): { image: ImageData; stale: boolean } | null {
    const k = key(node, maxSize);
    const e = this.cache.get(k);
    if (!e) return null;
    this.cache.delete(k);
    this.cache.set(k, e);
    return e;
  }

  /**
   * Asks for a thumbnail: `done` is called with it once drawn (in a later frame), or with null when the engine can't
   * draw it. A fresh cached one needs no request. Returns the cancel (a tile scrolled away or unmounted).
   */
  request(node: Guid, maxSize: number, done: (image: ImageData | null) => void): () => void {
    const r: Request = { node, maxSize, done };
    this.queue.push(r);
    this.schedule();
    return () => {
      const i = this.queue.indexOf(r);
      if (i >= 0) this.queue.splice(i, 1);
    };
  }

  /** Draws one now (for callers that need it at once: the publish flow). */
  renderNow(node: Guid, maxSize: number): ImageData | null {
    const render = engineMethod<Render>(this.ed.engine, "renderNodeThumbnailPixels");
    if (!render || this.ed.engine.destroyed) return null;
    let px: Pixels | null = null;
    try {
      px = render({ node, maxSize });
    } catch {
      px = null;
    }
    this.rendered++;
    if (!px || !px.width || !px.height) return null;
    const image = new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height);
    this.store(node, maxSize, image);
    return image;
  }

  private store(node: Guid, maxSize: number, image: ImageData): void {
    const k = key(node, maxSize);
    const old = this.cache.get(k);
    if (old) {
      this.bytes -= old.image.data.byteLength;
      this.cache.delete(k);
    }
    this.cache.set(k, { image, stale: false });
    this.bytes += image.data.byteLength;
    let sizes = this.sizes.get(node);
    if (!sizes) this.sizes.set(node, (sizes = new Set()));
    sizes.add(maxSize);
    for (const [oldest, e] of this.cache) {
      if (this.bytes <= CACHE_BYTES) break;
      this.cache.delete(oldest);
      this.bytes -= e.image.data.byteLength;
      const [n, s] = oldest.split("|");
      this.sizes.get(n)?.delete(Number(s));
    }
  }

  private schedule(): void {
    if (this.frame || !this.queue.length) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.pump();
    });
  }

  /** Draws queued thumbnails until the frame's budget is spent; the rest wait for the next frame. */
  private pump(): void {
    const start = performance.now();
    while (this.queue.length && performance.now() - start < FRAME_BUDGET) {
      const r = this.queue.shift()!;
      const cached = this.cache.get(key(r.node, r.maxSize));
      r.done(cached && !cached.stale ? cached.image : this.renderNow(r.node, r.maxSize));
    }
    this.schedule();
  }

  private scheduleResolve(): void {
    if (this.resolving) return;
    this.resolving = whenIdle(() => {
      this.resolving = 0;
      this.resolve();
    });
  }

  /** The changed refs resolved to the cached components they sit in (their ancestors, a level per read): those go stale. */
  private resolve(): void {
    const dirty = this.dirty;
    const above = this.above;
    this.dirty = new Set();
    this.above = new Set();
    if (!dirty) {
      for (const e of this.cache.values()) e.stale = true;
      for (const set of this.watchers.values()) set.forEach((w) => w());
      return;
    }
    if ((!dirty.size && !above.size) || !this.sizes.size || this.ed.engine.destroyed) return;
    const parentsOf = (ids: readonly Guid[]) => {
      const out = new Set<Guid>();
      for (const n of this.ed.engine.readNodes(ids, { fields: ["parentIndex", "type"] })) {
        const parent = (n as { parentIndex?: { guid?: Guid } }).parentIndex?.guid;
        if (n.type !== "CANVAS" && n.type !== "DOCUMENT" && parent) out.add(parent);
      }
      return out;
    };
    const seen = new Set<Guid>();
    const stale = new Set<Guid>();
    let level = new Set([...dirty, ...(above.size ? parentsOf([...above]) : [])]);
    for (let depth = 0; level.size && depth < 64; depth++) {
      const ask: Guid[] = [];
      for (const id of level) {
        if (seen.has(id)) continue;
        seen.add(id);
        ask.push(id);
        const sizes = this.sizes.get(id);
        if (!sizes) continue;
        for (const s of sizes) this.cache.get(key(id, s))!.stale = true;
        stale.add(id);
      }
      level = ask.length ? parentsOf(ask) : new Set();
    }
    for (const id of stale) this.watchers.get(id)?.forEach((w) => w());
  }

  /** Calls `cb` when `node`'s cached thumbnails go stale (a tile on screen asks again). */
  watch(node: Guid, cb: () => void): () => void {
    let set = this.watchers.get(node);
    if (!set) this.watchers.set(node, (set = new Set()));
    set.add(cb);
    return () => {
      set.delete(cb);
      if (!set.size) this.watchers.delete(node);
    };
  }
}

function whenIdle(run: () => void): number {
  const w = globalThis as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  return w.requestIdleCallback ? w.requestIdleCallback(run, { timeout: 500 }) : (setTimeout(run, 50) as unknown as number);
}

function cancelIdle(id: number): void {
  const w = globalThis as unknown as { cancelIdleCallback?: (id: number) => void };
  if (w.cancelIdleCallback) w.cancelIdleCallback(id);
  else clearTimeout(id);
}

// ---- On screen ----------------------------------------------------------------------------------------------------

let observer: IntersectionObserver | null = null;
const watchers = new Map<Element, (visible: boolean) => void>();

/** Calls `cb` as `el` comes near the screen (200 px ahead) or leaves it; one observer for every tile. */
export function watchVisible(el: Element, cb: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    cb(true);
    return () => {};
  }
  observer ??= new IntersectionObserver((entries) => entries.forEach((e) => watchers.get(e.target)?.(e.isIntersecting)), { rootMargin: "200px" });
  watchers.set(el, cb);
  observer.observe(el);
  return () => {
    watchers.delete(el);
    observer?.unobserve(el);
  };
}

/**
 * Draws `node`'s thumbnail (fitted into maxSize × maxSize device px) into the canvas once it is on screen, from the
 * cache when it can, marking it `data-drawn`; a stale or missing one is asked for and drawn in a later frame. `node`
 * null: nothing to draw.
 */
export function useAssetThumbnail(ed: EditorController, canvas: React.RefObject<HTMLCanvasElement | null>, node: Guid | null, maxSize: number): void {
  useEffect(() => {
    const c = canvas.current;
    const thumbs = ed.thumbnails as AssetThumbnails | undefined;
    if (!c || !node || !thumbs?.available || maxSize <= 0) return;
    const paint = (image: ImageData | null) => {
      if (!image) return;
      c.width = image.width;
      c.height = image.height;
      c.getContext("2d")?.putImageData(image, 0, 0);
      c.dataset.drawn = "";
    };
    let shown: ImageData | null = null;
    let cancel: (() => void) | null = null;
    let unwatch: (() => void) | null = null;
    const show = () => {
      cancel?.();
      cancel = null;
      const cached = thumbs.peek(node, maxSize);
      if (cached && cached.image !== shown) paint((shown = cached.image));
      if (!cached || cached.stale)
        cancel = thumbs.request(node, maxSize, (image) => {
          cancel = null;
          if (image && image !== shown) paint((shown = image));
        });
    };
    const stop = watchVisible(c.parentElement ?? c, (visible) => {
      unwatch?.();
      unwatch = null;
      if (!visible) {
        cancel?.();
        cancel = null;
        return;
      }
      unwatch = thumbs.watch(node, show);
      show();
    });
    return () => {
      stop();
      unwatch?.();
      cancel?.();
    };
  }, [ed, canvas, node, maxSize]);
}
