/**
 * Images end to end (docs/engine.md §6.6, docs/schema.md §11.3, docs/data.md §10):
 * a file (the Image tool's picker, a drop, a paste) → its bytes, downscaled
 * to Figma's 4096 px cap → SHA-1 → the document source's image store (the
 * store's content-addressed blobs; in memory for the browser's demo files) →
 * an IMAGE paint referencing the hash. The other way: the engine asks for a
 * hash it hasn't drawn yet (REQUEST_IMAGE) and gets the bytes from the store.
 * Object URLs for the panels' swatches and the picker's preview are kept here.
 */
import { Status } from "@/engine/abi";
import type { Engine } from "@/engine/Engine";
import { engineMethod } from "./engineCompat";

/** Where a file's images live (DocumentSource.images): content-addressed by the SHA-1 of their bytes. */
export interface ImageStore {
  /** Stores the bytes; resolves to their SHA-1 (40 hex digits). */
  put(bytes: Uint8Array, mime: string): Promise<string>;
  /** The bytes of a stored image, or null. */
  get(hash: string): Promise<Uint8Array | null>;
}

/** Figma's import cap: an image larger than this on either side is scaled down (aspect kept). */
export const MAX_IMAGE_SIZE = 4096;

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

/** The layer name Figma gives a placed image: the file's name without its extension. */
export const imageLayerName = (fileName: string | undefined) => (fileName ?? "").replace(/\.[a-z0-9]+$/i, "").trim() || "Image";

export interface ImportedImage {
  hash: string;
  /** Its size in px after the cap (the rectangle Figma places is this size) */
  width: number;
  height: number;
  name: string;
  mime: string;
}

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
export const isImageFile = (f: { type: string }) => IMAGE_TYPES.test(f.type);

/** Decodes, caps at 4096 (re-encoding only then), hashes and stores one image. */
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
  bitmap.close();
  const hash = await store.put(bytes, mime);
  return { hash, width, height, name: imageLayerName(file.name), mime };
}

type RequestImageEvent = { type: "REQUEST_IMAGE"; hash: unknown; maxDevicePx?: number };

/**
 * One editor's images: object URLs for the panels, the engine's REQUEST_IMAGE answered from the store, and
 * `settled()` for work that must see every image drawn (the thumbnail).
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

  constructor(
    private readonly engine: Engine,
    readonly store: ImageStore | null
  ) {}

  /** Starts answering the engine (E5). Returns the detach. */
  attach(): () => void {
    const engine = this.engine;
    // A loader the engine calls itself, if the facade takes one; else the REQUEST_IMAGE event.
    const setSource = engineMethod<(load: (hash: string) => Promise<Uint8Array | null>) => void>(engine, "setImageSource", "setImageLoader");
    if (setSource) setSource((hash) => this.bytes(hash));
    else
      this.offs.push(
        engine.onAny((e) => {
          const ev = e as unknown as RequestImageEvent;
          if (ev.type === "REQUEST_IMAGE") this.track(this.answer(ev.hash));
        })
      );
    return () => this.dispose();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.listeners.clear();
  }

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

  /** REQUEST_IMAGE: the bytes to the engine (decoded where it wants a bitmap), or "failed". */
  private async answer(raw: unknown): Promise<void> {
    const hash = typeof raw === "string" ? raw.toLowerCase() : Array.isArray(raw) || raw instanceof Uint8Array ? Array.from(raw as ArrayLike<number>).map((b) => b.toString(16).padStart(2, "0")).join("") : "";
    const engine = this.engine;
    const bytes = hash ? await this.bytes(hash) : null;
    if (engine.destroyed) return;
    const failed = engineMethod<(hash: string) => void>(engine, "imageFailed", "failImage");
    if (!bytes) return void failed?.(hash);
    const addBytes = engineMethod<(hash: string, bytes: Uint8Array) => number | Promise<number>>(engine, "addImageBytes", "imageAddBytes");
    if (addBytes) {
      const s = await addBytes(hash, bytes);
      if (typeof s === "number" && s !== Status.OK) failed?.(hash);
      return;
    }
    const addBitmap = engineMethod<(hash: string, bitmap: ImageBitmap) => number>(engine, "addImage", "addImageBitmap", "imageAdd");
    if (!addBitmap || typeof createImageBitmap === "undefined") return;
    try {
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { premultiplyAlpha: "premultiply", colorSpaceConversion: "default" });
      if (!engine.destroyed) addBitmap(hash, bitmap);
    } catch {
      failed?.(hash);
    }
  }
}
