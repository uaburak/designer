/**
 * Images end to end (docs/engine.md §6.6, docs/schema.md §11.3, docs/data.md §10):
 * a file (the Image tool's picker, a drop, a paste) → its bytes, downscaled
 * to Figma's 4096 px cap → SHA-1 → the document source's image store (the
 * store's content-addressed blobs; in memory for the browser's demo files) →
 * an IMAGE paint referencing the hash. The other way: the engine asks for a
 * hash it hasn't drawn yet (REQUEST_IMAGE) and gets the bytes from the store.
 * Object URLs for the panels' swatches and the picker's preview are kept here.
 *
 * Progressive display, as Figma does it (help.figma.com/hc/en-us/articles/360052988373:
 * "Figma only downloads high quality versions of images in your current
 * viewport. For images outside your current view, Figma loads a lower quality
 * version"; high-resolution = larger than 512 × 512): an import computes the
 * paint's `thumbHash` (Evan Wallace's placeholder, from a ≤ 100 px downscale)
 * and, for a high-res image, a ≤ 512 px tier stored as a blob of its own and
 * referenced by the paint's `imageThumbnail` (a ≤ 512 px image is its own
 * thumbnail, as in Figma's files). A REQUEST_IMAGE is answered with the
 * placeholder at once (before the first paint), then with the tier when the
 * paint covers at most 512 device px, the full image otherwise or when the
 * engine asks for more. Files whose paints lack the fields (older files,
 * imports) get them written back as a "system" change once their images are
 * decoded, for the page shown, a few paints per idle slice.
 */
import { Status } from "@/engine/abi";
import type { Guid, Message, NodeChange, Paint } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";
import { engineCall, engineMethod } from "./engineCompat";
import { isImageLike, paintImageHash, paintLacksProgressive, paintThumbnailHash, thumbHashBytes, withProgressive, type ProgressiveImage } from "./model/paints";
import { rgbaToThumbHash, THUMBHASH_MAX_INPUT, thumbHashToPremultipliedRGBA } from "./thumbHash";

/** Where a file's images live (DocumentSource.images): content-addressed by the SHA-1 of their bytes. */
export interface ImageStore {
  /** Stores the bytes; resolves to their SHA-1 (40 hex digits). */
  put(bytes: Uint8Array, mime: string): Promise<string>;
  /** The bytes of a stored image, or null. */
  get(hash: string): Promise<Uint8Array | null>;
}

/** Figma's import cap: an image larger than this on either side is scaled down (aspect kept). */
export const MAX_IMAGE_SIZE = 4096;

/** Figma's high-resolution threshold: an image larger than this on either side gets a low-res tier of this size. */
export const HIGH_RES_SIZE = 512;

/** The tier's JPEG quality (for JPEG and WebP originals; others stay PNG). */
export const TIER_JPEG_QUALITY = 0.85;

/** The SHA-1 of `bytes` as lower-case hex. */
export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Images held in memory (the browser's `?editor` demo documents, tests). */
export function memoryImageStore(): ImageStore & { readonly size: number } {
  const blobs = new Map<string, Uint8Array>();
  return {
    get size() {
      return blobs.size;
    },
    put: async (bytes) => {
      const hash = await sha1Hex(bytes);
      blobs.set(hash, bytes);
      return hash;
    },
    get: async (hash) => blobs.get(hash) ?? null,
  };
}

/** A width × height fitted inside the cap, aspect kept (whole pixels, at least 1). */
export function fitImageSize(width: number, height: number, max = MAX_IMAGE_SIZE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The low-res tier's size for an image: at most 512 px on the longer side, aspect kept — or null when the image
 * is not high-resolution (512 px or less on both sides: it is its own thumbnail).
 */
export function tierSize(width: number, height: number, max = HIGH_RES_SIZE): { width: number; height: number } | null {
  return Math.max(width, height) > max ? fitImageSize(width, height, max) : null;
}

/** The tier's encoding: JPEG for JPEG and WebP originals (lossy anyway), PNG for the rest (alpha kept). */
export const tierMime = (mime: string): "image/jpeg" | "image/png" => (mime === "image/jpeg" || mime === "image/webp" ? "image/jpeg" : "image/png");

/** The image format from the bytes' magic numbers (the store keeps no MIME with a blob), or null. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/** The layer name Figma gives a placed image: the file's name without its extension. */
export const imageLayerName = (fileName: string | undefined) => (fileName ?? "").replace(/\.[a-z0-9]+$/i, "").trim() || "Image";

/** An image's low-res copy: its own blob (≤ 512 px on the longer side), or the image itself when it is that small. */
export interface ImageTier {
  hash: string;
  width: number;
  height: number;
}

export interface ImportedImage {
  hash: string;
  /** Its size in px after the cap (the rectangle Figma places is this size) */
  width: number;
  height: number;
  name: string;
  mime: string;
  /** Evan Wallace's ThumbHash of the image (Paint.thumbHash); null when it couldn't be computed (no canvas). */
  thumbHash?: Uint8Array | null;
  /** Its low-res copy (Paint.imageThumbnail); null when it couldn't be made. */
  thumbnail?: ImageTier | null;
}

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
export const isImageFile = (f: { type: string }) => IMAGE_TYPES.test(f.type);

/** Draws `bitmap` scaled to w × h on a fresh OffscreenCanvas (a high-quality resize when the browser offers one). */
async function drawScaled(bitmap: ImageBitmap, width: number, height: number): Promise<OffscreenCanvas> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  let source: ImageBitmap = bitmap;
  let resized: ImageBitmap | null = null;
  if (bitmap.width !== width || bitmap.height !== height) {
    try {
      resized = await createImageBitmap(bitmap, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
      source = resized;
    } catch {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
  }
  ctx.drawImage(source, 0, 0, width, height);
  resized?.close();
  return canvas;
}

/** The ThumbHash of a decoded image (from a ≤ 100 px downscale). */
export async function thumbHashOf(bitmap: ImageBitmap): Promise<Uint8Array> {
  const fit = fitImageSize(bitmap.width, bitmap.height, THUMBHASH_MAX_INPUT);
  const canvas = await drawScaled(bitmap, fit.width, fit.height);
  const data = canvas.getContext("2d")!.getImageData(0, 0, fit.width, fit.height).data;
  return rgbaToThumbHash(fit.width, fit.height, data);
}

/**
 * What progressive display needs of a decoded image: its ThumbHash and its low-res copy — a ≤ 512 px re-encode
 * stored as a blob of its own when the image is high-res, the image itself otherwise. Each part is null when it
 * couldn't be made (no OffscreenCanvas: Node, old browsers).
 */
export async function deriveProgressive(bitmap: ImageBitmap, image: { hash: string; width: number; height: number; mime: string }, store: ImageStore): Promise<{ thumbHash: Uint8Array | null; thumbnail: ImageTier | null }> {
  if (typeof OffscreenCanvas === "undefined") return { thumbHash: null, thumbnail: null };
  const thumbHash = await thumbHashOf(bitmap).catch(() => null);
  const tier = tierSize(image.width, image.height);
  let thumbnail: ImageTier | null = tier ? null : { hash: image.hash, width: image.width, height: image.height };
  if (tier) {
    try {
      const canvas = await drawScaled(bitmap, tier.width, tier.height);
      const type = tierMime(image.mime);
      const blob = await canvas.convertToBlob({ type, quality: TIER_JPEG_QUALITY });
      const hash = await store.put(new Uint8Array(await blob.arrayBuffer()), blob.type || type);
      thumbnail = { hash, ...tier };
    } catch {
      thumbnail = null;
    }
  }
  return { thumbHash, thumbnail };
}

/** Decodes, caps at 4096 (re-encoding only then), hashes and stores one image, with its ThumbHash and low-res tier. */
export async function importImage(file: Blob & { name?: string }, store: ImageStore): Promise<ImportedImage> {
  const mime = file.type || "image/png";
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  if (Math.max(width, height) > MAX_IMAGE_SIZE && typeof OffscreenCanvas !== "undefined") {
    const fit = fitImageSize(width, height);
    const canvas = new OffscreenCanvas(fit.width, fit.height);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, fit.width, fit.height);
    const blob = await canvas.convertToBlob({ type: mime === "image/jpeg" || mime === "image/webp" ? mime : "image/png", quality: 0.92 });
    bytes = new Uint8Array(await blob.arrayBuffer());
    ({ width, height } = fit);
  }
  const hash = await store.put(bytes, mime);
  const progressive = await deriveProgressive(bitmap, { hash, width, height, mime }, store);
  bitmap.close();
  return { hash, width, height, name: imageLayerName(file.name), mime, ...progressive };
}

/**
 * The engine's request. Today's wasm sends `hash` alone; the parity round's engine (docs/engine-build.md "Figma
 * parity round 3 — API" §5) adds `maxDevicePx`, the largest device-pixel extent the paint has been drawn at (0 =
 * unknown), and may add the paint's `thumbHash` and `thumbnailHash` (`imageThumbnail.hash`). Every extra is
 * feature-detected; without them the full image goes, as before.
 */
type RequestImageEvent = { type: "REQUEST_IMAGE"; hash: unknown; maxDevicePx?: unknown; thumbHash?: unknown; thumbnailHash?: unknown };

/** What the engine holds for an image, in order: nothing, the ThumbHash placeholder, the ≤ 512 px tier, the full image. */
const NONE = 0;
const PLACEHOLDER = 1;
const TIER = 2;
const FULL = 3;
type Level = typeof NONE | typeof PLACEHOLDER | typeof TIER | typeof FULL;

interface ImageState {
  /** What the engine has. */
  level: Level;
  /** What is being fetched, decoded or waiting for its upload (NONE when nothing is). */
  loading: Level;
  /** The bitmap at `level` (TIER or FULL), as handed to the engine (it keeps it; so may we). */
  bitmap: ImageBitmap | null;
  /** The format of the full image's bytes (for the tier's encoding). */
  mime: string | null;
  /** Re-uploads done for a repeated request of a served level (bounded: never a loop with the engine). */
  reuploads: number;
}

/** Full-image bitmaps handed to the engine per animation frame: each upload is a synchronous GPU copy (~10 ms for a big one). */
const UPLOADS_PER_FRAME = 2;
/** A tier (≤ 512 px) costs a quarter of a full image's slot: eight tiers a frame. */
const TIER_COST = 0.25;

/** The write-back's paints per idle slice. */
export const WRITE_BACK_PAINTS_PER_SLICE = 50;

/** A node ref that is a document node ("s:l"), not an instance sublayer's derived ref ("I…;…"). */
const isDocumentRef = (guid: string) => /^\d+:\d+$/.test(guid);

/** The hash as 40 lower-case hex digits (from hex text or 20 bytes), or null. */
function normalizeHash(raw: unknown): string | null {
  if (typeof raw === "string") return /^[0-9a-f]{40}$/i.test(raw) ? raw.toLowerCase() : null;
  if (Array.isArray(raw) || raw instanceof Uint8Array) {
    const bytes = Array.from(raw as ArrayLike<number>);
    return bytes.length === 20 ? bytes.map((b) => (b & 255).toString(16).padStart(2, "0")).join("") : null;
  }
  return null;
}

/**
 * One editor's images: object URLs for the panels, the engine's REQUEST_IMAGE answered from the store, and
 * `settled()` for work that must see every image drawn (the thumbnail). The bytes are decoded off the main thread
 * (createImageBitmap); the uploads wait for the chrome's first paint (`releaseUploads`) and go a few per frame, so
 * a file's images never make the first frames long (Figma shows the canvas before its images are in). ThumbHash
 * placeholders are tiny and go at once, before the first paint.
 */
export class ImageService {
  private readonly urls = new Map<string, string>();
  private readonly loading = new Map<string, Promise<Uint8Array | null>>();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly offs: (() => void)[] = [];
  private version = 0;
  /** Bumped by every first request of a hash (a render that needed an image it didn't have). */
  requests = 0;
  /** Decoded bitmaps waiting for their upload (after the first paint, a few per frame). */
  private readonly uploads: { hash: string; bitmap: ImageBitmap; level: Level; again: boolean }[] = [];
  private uploadFrame = 0;
  private released = false;
  private releaseResolve: () => void = () => {};
  private readonly releasedPromise = new Promise<void>((resolve) => (this.releaseResolve = resolve));
  /** Per image: what the engine has and what is on its way. */
  private readonly states = new Map<string, ImageState>();
  /** Image hash → its low-res copy's hash: from imports, from requests that name it, and from the page's paints. */
  private readonly tiers = new Map<string, string>();

  // ---- The write-back (paints lacking thumbHash / imageThumbnail) --------------------------------
  /** On the page scanned: the nodes whose IMAGE paints lack the fields, by image hash. */
  private readonly missing = new Map<string, Set<Guid>>();
  /** Computed for images whose paints lack the fields, waiting to be written. */
  private readonly derived = new Map<string, ProgressiveImage>();
  private readonly deriving = new Set<string>();
  private scannedPage: Guid | null = null;
  private idleHandle: number | ReturnType<typeof setTimeout> | null = null;
  private idleIsTimeout = false;
  /** Write-backs applied so far (tests, diagnostics). */
  writeBacks = 0;

  constructor(
    private readonly engine: Engine,
    readonly store: ImageStore | null
  ) {}

  /** Starts answering the engine (E5). Returns the detach. */
  attach(): () => void {
    const engine = this.engine;
    const addBitmap = engineMethod<(hash: string, bitmap: ImageBitmap) => number>(engine, "addImage", "addImageBitmap", "imageAdd");
    if (addBitmap && typeof createImageBitmap !== "undefined") {
      // The event path with this service's own scheduling: decode here, upload after the first paint, a few per frame.
      this.offs.push(
        engine.onAny((e) => {
          const ev = e as unknown as RequestImageEvent;
          if (ev.type === "REQUEST_IMAGE") this.track(this.answer(ev));
        })
      );
      // Older files' paints: the page's IMAGE paints lacking thumbHash / imageThumbnail, written back once decoded.
      this.scheduleIdle();
      return () => this.dispose();
    }
    // A loader the engine calls itself, if the facade takes one; else the REQUEST_IMAGE event.
    const setSource = engineMethod<(load: (hash: string) => Promise<Uint8Array | null>) => void>(engine, "setImageSource", "setImageLoader");
    if (setSource) setSource((hash) => this.bytes(hash));
    else
      this.offs.push(
        engine.onAny((e) => {
          const ev = e as unknown as RequestImageEvent;
          if (ev.type === "REQUEST_IMAGE") this.track(this.answer(ev));
        })
      );
    return () => this.dispose();
  }

  /** The chrome has painted: the decoded images may go to the GPU now (EditorApp calls it after its first frame). */
  releaseUploads(): void {
    if (this.released) return;
    this.released = true;
    this.releaseResolve();
    this.scheduleUploads();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.listeners.clear();
    if (this.uploadFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.uploadFrame);
    this.uploadFrame = 0;
    for (const u of this.uploads.splice(0)) if (!u.again) u.bitmap.close();
    this.cancelIdle();
    this.missing.clear();
    this.derived.clear();
    this.released = true;
    this.releaseResolve();
  }

  private stateOf(hash: string): ImageState {
    let s = this.states.get(hash);
    if (!s) {
      s = { level: NONE, loading: NONE, bitmap: null, mime: null, reuploads: 0 };
      this.states.set(hash, s);
    }
    return s;
  }

  /** What the engine has for an image: "none", "placeholder", "tier" or "full" (tests, diagnostics). */
  levelOf(hash: string): "none" | "placeholder" | "tier" | "full" {
    return (["none", "placeholder", "tier", "full"] as const)[this.states.get(hash.toLowerCase())?.level ?? NONE];
  }

  // ---- Uploads -----------------------------------------------------------------------------------

  private scheduleUploads(): void {
    if (this.uploadFrame || !this.uploads.length || !this.released) return;
    if (typeof requestAnimationFrame !== "function") {
      this.drainUploads(Infinity);
      return;
    }
    this.uploadFrame = requestAnimationFrame(() => {
      this.uploadFrame = 0;
      this.drainUploads(UPLOADS_PER_FRAME);
      this.scheduleUploads();
    });
  }

  private drainUploads(budget: number): void {
    const addBitmap = engineMethod<(hash: string, bitmap: ImageBitmap) => number>(this.engine, "addImage", "addImageBitmap", "imageAdd");
    const failed = engineMethod<(hash: string) => void>(this.engine, "imageFailed", "failImage");
    let spent = 0;
    while (this.uploads.length) {
      const cost = this.uploads[0].level === FULL ? 1 : TIER_COST;
      if (spent > 0 && spent + cost > budget) break;
      const { hash, bitmap, level, again } = this.uploads.shift()!;
      spent += cost;
      const state = this.stateOf(hash);
      if (this.engine.destroyed || (!again && level <= state.level)) {
        // Gone, or something at least as good is already in (a later request's full image overtook this tier).
        if (!again) bitmap.close();
        continue;
      }
      if (!addBitmap) {
        bitmap.close();
        failed?.(hash);
        continue;
      }
      const s = addBitmap(hash, bitmap);
      if (typeof s === "number" && s !== Status.OK) {
        failed?.(hash);
        continue;
      }
      state.level = level;
      state.bitmap = bitmap;
      if (level === FULL) this.noteDecoded(hash);
    }
  }

  /** A decoded bitmap, uploaded after the first paint in its turn; resolves when it is in (or the engine is gone). */
  private enqueueUpload(hash: string, bitmap: ImageBitmap, level: Level, again = false): Promise<void> {
    const entry = { hash, bitmap, level, again };
    this.uploads.push(entry);
    this.scheduleUploads();
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.engine.destroyed || !this.uploads.includes(entry)) resolve();
        else if (typeof requestAnimationFrame === "function") requestAnimationFrame(check);
        else setTimeout(check, 16);
      };
      void this.releasedPromise.then(check);
    });
  }

  // ---- Bytes and URLs ----------------------------------------------------------------------------

  /** The image's bytes from the store (once per hash), or null. */
  bytes(hash: string): Promise<Uint8Array | null> {
    let p = this.loading.get(hash);
    if (!p) {
      this.requests++;
      p = this.store ? this.store.get(hash).catch(() => null) : Promise.resolve(null);
      this.loading.set(hash, p);
      this.track(p);
    }
    return p;
  }

  /** Image loads and imports still in flight. */
  get loadingCount(): number {
    return this.pending.size;
  }

  /** Every image request and import in flight has finished. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** An object URL for the image (null until its bytes are in; `subscribe` hears when they are). */
  urlOf(hash: string | null): string | null {
    if (!hash) return null;
    const url = this.urls.get(hash);
    if (url) return url;
    void this.bytes(hash).then((b) => {
      if (!b || this.urls.has(hash)) return;
      this.urls.set(hash, URL.createObjectURL(new Blob([b as BlobPart])));
      this.version++;
      this.listeners.forEach((l) => l());
    });
    return null;
  }

  /** A known image's bytes and URL right away (just imported). */
  remember(hash: string, bytes: Uint8Array): void {
    this.loading.set(hash, Promise.resolve(bytes));
    if (!this.urls.has(hash)) {
      this.urls.set(hash, URL.createObjectURL(new Blob([bytes as BlobPart])));
      this.version++;
      this.listeners.forEach((l) => l());
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getVersion = (): number => this.version;

  /** Imports files (images only), in order; the ones that fail are skipped. */
  async import(files: readonly (Blob & { name?: string })[]): Promise<ImportedImage[]> {
    const store = this.store;
    if (!store) return [];
    const out: ImportedImage[] = [];
    const work = (async () => {
      for (const f of files) {
        if (!isImageFile(f)) continue;
        try {
          const img = await importImage(f, store);
          const bytes = await store.get(img.hash);
          if (bytes) this.remember(img.hash, bytes);
          if (img.thumbnail) this.tiers.set(img.hash, img.thumbnail.hash);
          out.push(img);
        } catch {
          /* not decodable: skipped, as Figma skips files it can't read */
        }
      }
    })();
    this.track(work);
    await work;
    return out;
  }

  private track(p: Promise<unknown>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  // ---- REQUEST_IMAGE -----------------------------------------------------------------------------

  /**
   * REQUEST_IMAGE: the ThumbHash placeholder at once when the request carries one and nothing is in yet; then the
   * tier when the paint covers at most 512 device px and the image has one, else the full image — decoded where the
   * engine wants a bitmap, uploaded in turn; or "failed".
   */
  private async answer(ev: RequestImageEvent): Promise<void> {
    const hash = normalizeHash(ev.hash);
    const engine = this.engine;
    const failed = engineMethod<(hash: string) => void>(engine, "imageFailed", "failImage");
    if (!hash) return void failed?.(typeof ev.hash === "string" ? ev.hash : "");
    const state = this.stateOf(hash);
    if (state.level === NONE && state.loading === NONE) {
      const thumbHash = thumbHashBytes(ev.thumbHash);
      if (thumbHash) this.placeholder(hash, thumbHash, state);
    }
    const maxPx = typeof ev.maxDevicePx === "number" && ev.maxDevicePx > 0 ? ev.maxDevicePx : 0;
    const named = normalizeHash(ev.thumbnailHash);
    if (named) this.tiers.set(hash, named);
    const tierHash = named ?? this.tiers.get(hash) ?? null;
    const want: Level = maxPx > 0 && maxPx <= HIGH_RES_SIZE && tierHash && tierHash !== hash ? TIER : FULL;
    if (this.scannedPage && this.currentPage() !== this.scannedPage) this.scheduleIdle();
    if (state.loading >= want) return; // on its way
    if (state.level >= want) {
      // Asked again for what it has: the engine lost it (a dropped source). Once, from the bitmap kept here.
      if (state.bitmap && state.reuploads < 1) {
        state.reuploads++;
        await this.enqueueUpload(hash, state.bitmap, state.level, true);
      }
      return;
    }
    state.loading = want;
    try {
      let level: Level = want;
      let bytes: Uint8Array | null = null;
      if (want === TIER && tierHash) {
        bytes = await this.bytes(tierHash);
        if (!bytes) level = FULL; // no tier blob (an import whose low-res copy wasn't in the file): the full image
      }
      if (level === FULL) bytes = await this.bytes(hash);
      if (engine.destroyed) return;
      if (!bytes) return void failed?.(hash);
      const addBitmap = engineMethod<(hash: string, bitmap: ImageBitmap) => number>(engine, "addImage", "addImageBitmap", "imageAdd");
      if (addBitmap && typeof createImageBitmap !== "undefined") {
        // Decoded off the main thread; the upload waits for the first paint and its turn (a few per frame).
        let bitmap: ImageBitmap;
        try {
          bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { premultiplyAlpha: "premultiply", colorSpaceConversion: "default" });
        } catch {
          failed?.(hash);
          return;
        }
        if (engine.destroyed) return void bitmap.close();
        if (level === FULL) state.mime = sniffImageMime(bytes);
        await this.enqueueUpload(hash, bitmap, level);
        return;
      }
      const addBytes = engineMethod<(hash: string, bytes: Uint8Array) => number | Promise<number>>(engine, "addImageBytes", "imageAddBytes");
      if (addBytes) {
        const s = await addBytes(hash, bytes);
        if (typeof s === "number" && s !== Status.OK) failed?.(hash);
        else state.level = level;
      }
    } finally {
      if (state.loading === want) state.loading = NONE;
    }
  }

  /** The ThumbHash placeholder (a 32 px blur, a few KB) straight to the engine: the first frame shows it. */
  private placeholder(hash: string, thumbHash: Uint8Array, state: ImageState): void {
    const addRgba = engineCall<(hash: string, width: number, height: number, rgba: Uint8Array) => number>(this.engine, "addImageRgba", "image_add_rgba");
    if (!addRgba || this.engine.destroyed) return;
    try {
      const { w, h, rgba } = thumbHashToPremultipliedRGBA(thumbHash);
      if (addRgba(hash, w, h, rgba) === Status.OK) state.level = PLACEHOLDER;
    } catch {
      /* not a ThumbHash: the engine's grey stays until the image is in */
    }
  }

  // ---- The write-back ----------------------------------------------------------------------------

  private currentPage(): Guid | null {
    const get = engineMethod<() => { pageId?: Guid } | null>(this.engine, "getSelection");
    if (!get || this.engine.destroyed) return null;
    try {
      return get()?.pageId ?? null;
    } catch {
      return null;
    }
  }

  /** An idle slice (requestIdleCallback; a timer where there is none): scan the page shown, write what is ready. */
  private scheduleIdle(delayMs = 0): void {
    if (this.idleHandle !== null || this.engine.destroyed) return;
    const run = () => {
      this.idleHandle = null;
      this.idleTick();
    };
    if (delayMs === 0 && typeof requestIdleCallback === "function") {
      this.idleIsTimeout = false;
      this.idleHandle = requestIdleCallback(run, { timeout: 2000 });
    } else {
      this.idleIsTimeout = true;
      this.idleHandle = setTimeout(run, delayMs);
    }
  }

  private cancelIdle(): void {
    if (this.idleHandle === null) return;
    if (this.idleIsTimeout) clearTimeout(this.idleHandle as ReturnType<typeof setTimeout>);
    else if (typeof cancelIdleCallback === "function") cancelIdleCallback(this.idleHandle as number);
    this.idleHandle = null;
  }

  private idleTick(): void {
    if (this.engine.destroyed) return;
    const page = this.currentPage();
    if (page && page !== this.scannedPage) this.scanPage(page);
    const outcome = this.flushWriteBacks();
    if (outcome === "busy") this.scheduleIdle(250);
    else if (outcome === "more") this.scheduleIdle();
  }

  /**
   * One paints-only read of the page shown: which IMAGE paints lack `thumbHash` / `imageThumbnail` (by image, with
   * their nodes), and which images have a low-res copy (for the tier path). Instance sublayers are left out (their
   * paints are their mains'; a write would be an override).
   */
  private scanPage(page: Guid): void {
    const read = engineMethod<(refs: readonly Guid[], options: object) => NodeChange[]>(this.engine, "readNodes");
    if (!read) return;
    let nodes: NodeChange[];
    try {
      nodes = read([page], { fields: ["fillPaints", "strokePaints"], subtree: true });
    } catch {
      return;
    }
    this.scannedPage = page;
    this.missing.clear();
    for (const n of nodes) {
      if (!n.guid || !isDocumentRef(n.guid)) continue;
      for (const key of ["fillPaints", "strokePaints"] as const) {
        for (const p of n[key] ?? []) {
          if (!isImageLike(p)) continue;
          const hash = paintImageHash(p);
          if (!hash) continue;
          const tier = paintThumbnailHash(p);
          if (tier) this.tiers.set(hash, tier);
          if (!paintLacksProgressive(p)) continue;
          let set = this.missing.get(hash);
          if (!set) this.missing.set(hash, (set = new Set()));
          set.add(n.guid);
          if (!this.derived.has(hash)) this.derive(hash);
        }
      }
    }
  }

  /** A full image is in: if the page's paints lack its fields, compute them. */
  private noteDecoded(hash: string): void {
    if (this.missing.has(hash) && !this.derived.has(hash)) this.derive(hash);
  }

  /** ThumbHash + tier from the full bitmap the engine has (the tier stored as a blob), then a write-back is due. */
  private derive(hash: string): void {
    const state = this.states.get(hash);
    const store = this.store;
    if (!store || !state?.bitmap || state.level !== FULL || this.deriving.has(hash) || this.derived.has(hash)) return;
    const bitmap = state.bitmap;
    this.deriving.add(hash);
    const work = deriveProgressive(bitmap, { hash, width: bitmap.width, height: bitmap.height, mime: state.mime ?? "image/png" }, store)
      .then((p) => {
        if (this.engine.destroyed || (!p.thumbHash && !p.thumbnail)) return;
        this.derived.set(hash, p);
        if (p.thumbnail) this.tiers.set(hash, p.thumbnail.hash);
        this.scheduleIdle();
      })
      .catch(() => undefined)
      .finally(() => this.deriving.delete(hash));
    this.track(work);
  }

  /**
   * Writes the computed fields onto the page's paints that lack them: one "system" change (journaled, not an undo
   * step), at most 50 paints a slice, never while a user step is open. "busy": try again later; "more": another
   * slice is due; "done": nothing left.
   */
  private flushWriteBacks(): "done" | "busy" | "more" {
    const engine = this.engine;
    const apply = engineCall<(message: Message, kind: string) => number>(engine, "applyChanges", "apply_changes");
    const read = engineMethod<(refs: readonly Guid[], options: object) => NodeChange[]>(engine, "readNodes");
    const begin = engineMethod<(label: string) => number>(engine, "txnBegin");
    const cancel = engineMethod<() => void>(engine, "txnCancel");
    if (!apply || !read || !begin || !cancel) return "done";
    const guids = new Set<Guid>();
    for (const [hash, nodes] of this.missing) if (this.derived.has(hash)) for (const g of nodes) guids.add(g);
    if (!guids.size) return "done";
    // Never inside a user step (a scrub, a drag): the probe transaction tells.
    if (begin("Image placeholders") !== Status.OK) return "busy";
    cancel();
    let fresh: NodeChange[];
    try {
      fresh = read([...guids], { fields: ["fillPaints", "strokePaints"] });
    } catch {
      return "done";
    }
    const changes: NodeChange[] = [];
    const complete = new Set<Guid>();
    let count = 0;
    let cut = false;
    for (const n of fresh) {
      if (cut) break;
      const change: NodeChange = { guid: n.guid };
      let touched = false;
      for (const key of ["fillPaints", "strokePaints"] as const) {
        const paints = n[key];
        if (!paints?.length) continue;
        let changed = false;
        const next: Paint[] = paints.map((p) => {
          if (cut || !paintLacksProgressive(p)) return p;
          const d = this.derived.get(paintImageHash(p)!);
          if (!d) return p;
          if (count >= WRITE_BACK_PAINTS_PER_SLICE) {
            cut = true;
            return p;
          }
          count++;
          changed = true;
          return withProgressive(p, d);
        });
        if (changed) {
          change[key] = next;
          touched = true;
        }
      }
      if (cut) break;
      complete.add(n.guid);
      if (touched) changes.push(change);
    }
    // Nodes no longer in the document are done with.
    const present = new Set(fresh.map((n) => n.guid));
    for (const g of guids) if (!present.has(g)) complete.add(g);
    if (changes.length) {
      const status = apply({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes }, "system");
      if (status === Status.E_BUSY) return "busy";
      this.writeBacks++;
    }
    for (const [hash, nodes] of [...this.missing]) {
      for (const g of complete) nodes.delete(g);
      if (!nodes.size) this.missing.delete(hash);
    }
    return cut ? "more" : "done";
  }
}
