// The editor's image service: the engine's REQUEST_IMAGE answered from the store, bitmaps decoded off the main
// thread, uploads held until the chrome's first paint and then a few per frame (the first frames of a file with
// images never pay for them), `settled()` once every upload is in. Progressive images as Figma does them: the
// ThumbHash placeholder first, the ≤ 512 px tier for paints covering ≤ 512 device px, the full image when asked for
// more; imports compute both; older files' paints get them written back as a "system" change.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message, NodeChange } from "@/engine/codec";
import { Status } from "@/engine/abi";
import { deriveProgressive, ImageService, importImage, memoryImageStore, sha1Hex, sniffImageMime, tierMime, tierSize, type ImageStore } from "../images";
import { hashBytes, hashHex, imagePaint, paintThumbHash, paintThumbnailHash } from "../model/paints";
import { rgbaToThumbHash, thumbHashToApproximateAspectRatio } from "../thumbHash";

type Handler = (e: Record<string, unknown>) => void;
type Request = { hash: string; maxDevicePx?: number; thumbHash?: number[] | string; thumbnailHash?: string };

/** A fake engine: emits REQUEST_IMAGE, counts uploads and placeholders; reads and applies for the write-back. */
function fakeEngine(doc: { page?: string; nodes?: NodeChange[] } = {}) {
  const handlers = new Set<Handler>();
  const uploads: { hash: string; width: number; height: number }[] = [];
  const placeholders: { hash: string; width: number; height: number; rgba: Uint8Array }[] = [];
  const applied: { message: Message; kind: string }[] = [];
  const nodes = new Map((doc.nodes ?? []).map((n) => [n.guid, n]));
  const engine = {
    destroyed: false,
    uploads,
    placeholders,
    applied,
    nodes,
    busy: 0,
    reads: 0,
    onAny: (h: Handler) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    request: (r: string | Request) => handlers.forEach((h) => h({ type: "REQUEST_IMAGE", ...(typeof r === "string" ? { hash: r } : r) })),
    addImage: (hash: string, bitmap: { width: number; height: number }) => {
      uploads.push({ hash, width: bitmap.width, height: bitmap.height });
      return 0;
    },
    addImageRgba: (hash: string, width: number, height: number, rgba: Uint8Array) => {
      placeholders.push({ hash, width, height, rgba });
      return 0;
    },
    imageFailed: () => 0,
    getSelection: () => ({ pageId: doc.page ?? "0:1", refs: [] }),
    readNodes: (refs: readonly string[], options: { subtree?: boolean }) => {
      engine.reads++;
      if (options.subtree) return [...nodes.values()];
      return refs.map((r) => nodes.get(r)).filter((n): n is NodeChange => !!n);
    },
    txnBegin: () => (engine.busy > 0 ? (engine.busy--, Status.E_BUSY) : Status.OK),
    txnCancel: () => {},
    applyChanges: (message: Message, kind: string) => {
      applied.push({ message, kind });
      for (const c of message.nodeChanges) nodes.set(c.guid, { ...nodes.get(c.guid), ...c });
      return Status.OK;
    },
  };
  return engine;
}

/** Image bytes whose first four bytes are the size (so the fake decoder knows it) — no real format. */
const imageBytes = (width: number, height: number, tag = 0) => new Uint8Array([width >> 8, width & 255, height >> 8, height & 255, tag, 1, 2, 3, 4, 5, 6, 7]);

type FakeBitmap = { width: number; height: number; close(): void };

/**
 * requestAnimationFrame run by hand; a createImageBitmap that reads the size from the bytes (or resizes a bitmap);
 * an OffscreenCanvas whose pixels are a red → blue gradient and whose convertToBlob yields recognisable bytes.
 */
function fakeBrowser() {
  const g = globalThis as Record<string, unknown>;
  const before = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, cib: g.createImageBitmap, oc: g.OffscreenCanvas };
  const queue: FrameRequestCallback[] = [];
  g.requestAnimationFrame = (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  };
  g.cancelAnimationFrame = () => {};
  g.createImageBitmap = async (src: Blob | FakeBitmap, opts?: { resizeWidth?: number; resizeHeight?: number }): Promise<FakeBitmap> => {
    if (src instanceof Blob) {
      const b = new Uint8Array(await src.arrayBuffer());
      return { width: (b[0] << 8) | b[1], height: (b[2] << 8) | b[3], close() {} };
    }
    return { width: opts?.resizeWidth ?? src.width, height: opts?.resizeHeight ?? src.height, close() {} };
  };
  class FakeOffscreenCanvas {
    constructor(
      readonly width: number,
      readonly height: number
    ) {}
    getContext() {
      const { width, height } = this;
      return {
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "low",
        drawImage() {},
        getImageData(_x: number, _y: number, w: number, h: number) {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              const i = (y * w + x) * 4;
              const t = w > 1 ? x / (w - 1) : 0;
              data[i] = Math.round(255 * (1 - t));
              data[i + 2] = Math.round(255 * t);
              data[i + 3] = 255;
            }
          return { data, width, height };
        },
      };
    }
    async convertToBlob(opts: { type: string }) {
      return new Blob([imageBytes(this.width, this.height, 0xee)], { type: opts.type });
    }
  }
  g.OffscreenCanvas = FakeOffscreenCanvas;
  return {
    frame: () => {
      for (const cb of queue.splice(0)) cb(0);
    },
    pending: () => queue.length,
    restore: () => {
      g.requestAnimationFrame = before.raf;
      g.cancelAnimationFrame = before.caf;
      g.createImageBitmap = before.cib;
      g.OffscreenCanvas = before.oc;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await tick();
};

/** A store that notes every `get`. */
function spyStore(): ImageStore & { readonly size: number; fetched: string[] } {
  const inner = memoryImageStore();
  const fetched: string[] = [];
  return {
    get size() {
      return inner.size;
    },
    fetched,
    put: (b, m) => inner.put(b, m),
    get: (h) => {
      fetched.push(h);
      return inner.get(h);
    },
  };
}

describe("ImageService", () => {
  let browser: ReturnType<typeof fakeBrowser>;
  beforeEach(() => (browser = fakeBrowser()));
  afterEach(() => browser.restore());

  it("holds uploads until the first paint, then two per frame, and settles when they are in", async () => {
    const store = memoryImageStore();
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) hashes.push(await store.put(imageBytes(100, 100, i), "image/png"));
    const engine = fakeEngine();
    const images = new ImageService(engine as never, store);
    const off = images.attach();
    for (const h of hashes) engine.request(h);
    // Decoded, but nothing reaches the engine before the chrome has painted.
    await ticks(5);
    expect(engine.uploads).toEqual([]);
    expect(images.loadingCount).toBe(5);
    images.releaseUploads();
    browser.frame();
    expect(engine.uploads.length).toBe(2);
    browser.frame();
    expect(engine.uploads.length).toBe(4);
    browser.frame();
    expect(engine.uploads.length).toBe(5);
    expect(engine.uploads.map((u) => u.hash).sort()).toEqual([...hashes].sort());
    // Each answer resolves (its upload is in): settled() returns.
    for (let i = 0; i < 5; i++) {
      browser.frame();
      await tick();
    }
    await images.settled();
    expect(images.loadingCount).toBe(0);
    // A hash is fetched from the store once, however often the engine asks.
    engine.request(hashes[0]);
    expect(images.requests).toBe(5);
    expect(images.levelOf(hashes[0])).toBe("full");
    off();
  });

  it("an image the store doesn't have is reported failed, not uploaded", async () => {
    const engine = fakeEngine();
    let failed = "";
    engine.imageFailed = ((hash: string) => {
      failed = hash;
      return 0;
    }) as never;
    const images = new ImageService(engine as never, memoryImageStore());
    images.attach();
    images.releaseUploads();
    engine.request("0".repeat(40));
    await ticks(4);
    expect(failed).toBe("0".repeat(40));
    expect(engine.uploads).toEqual([]);
  });

  it("a request carrying the paint's thumbHash puts the placeholder in at once, before any bitmap", async () => {
    const store = memoryImageStore();
    const hash = await store.put(imageBytes(2048, 1024), "image/png");
    const thumbHash = rgbaToThumbHash(2, 1, [255, 0, 0, 255, 0, 0, 255, 255]);
    const engine = fakeEngine();
    const images = new ImageService(engine as never, store);
    images.attach();
    engine.request({ hash, thumbHash: Array.from(thumbHash) });
    // Synchronously, before the chrome's first paint: the 32 px placeholder, premultiplied RGBA.
    expect(engine.placeholders.length).toBe(1);
    expect(engine.placeholders[0].hash).toBe(hash);
    expect(engine.placeholders[0].width).toBe(32);
    expect(engine.placeholders[0].height).toBe(Math.round(32 / thumbHashToApproximateAspectRatio(thumbHash)));
    expect(engine.placeholders[0].rgba.length).toBe(32 * engine.placeholders[0].height * 4);
    expect(engine.uploads).toEqual([]);
    expect(images.levelOf(hash)).toBe("placeholder");
    // Then the full image, in its turn.
    await ticks(4);
    images.releaseUploads();
    browser.frame();
    expect(engine.uploads).toEqual([{ hash, width: 2048, height: 1024 }]);
    expect(images.levelOf(hash)).toBe("full");
    // Asked again with the thumbHash: the placeholder never goes over a bitmap.
    engine.request({ hash, thumbHash: Array.from(thumbHash) });
    await ticks(2);
    expect(engine.placeholders.length).toBe(1);
    // A base64 thumbHash (another wire) is read too.
    const other = await store.put(imageBytes(100, 100, 7), "image/png");
    engine.request({ hash: other, thumbHash: btoa(String.fromCharCode(...thumbHash)) });
    expect(engine.placeholders.length).toBe(2);
    expect(engine.placeholders[1].hash).toBe(other);
  });

  it("maxDevicePx ≤ 512 with a thumbnailHash fetches the tier, not the full image; asked for more, the full image follows", async () => {
    const store = spyStore();
    const full = await store.put(imageBytes(2048, 1024), "image/jpeg");
    const tier = await store.put(imageBytes(512, 256, 1), "image/jpeg");
    const engine = fakeEngine();
    const images = new ImageService(engine as never, store);
    images.attach();
    images.releaseUploads();
    engine.request({ hash: full, maxDevicePx: 300, thumbnailHash: tier });
    await ticks(4);
    browser.frame();
    expect(store.fetched).toEqual([tier]);
    expect(engine.uploads).toEqual([{ hash: full, width: 512, height: 256 }]);
    expect(images.levelOf(full)).toBe("tier");
    // Still within the tier: nothing new is fetched.
    engine.request({ hash: full, maxDevicePx: 512 });
    await ticks(3);
    browser.frame();
    expect(store.fetched).toEqual([tier]);
    // Zoomed in / scrolled into view at more than 512 device px: the full image replaces the tier.
    engine.request({ hash: full, maxDevicePx: 1500 });
    await ticks(4);
    browser.frame();
    expect(store.fetched).toEqual([tier, full]);
    expect(engine.uploads.at(-1)).toEqual({ hash: full, width: 2048, height: 1024 });
    expect(images.levelOf(full)).toBe("full");
    // The tier's hash is remembered: a later request without it still takes the tier path for a small paint.
    const full2 = await store.put(imageBytes(1024, 1024, 2), "image/png");
    const tier2 = await store.put(imageBytes(512, 512, 3), "image/png");
    engine.request({ hash: full2, maxDevicePx: 100, thumbnailHash: tier2 });
    await ticks(4);
    browser.frame();
    expect(store.fetched.at(-1)).toBe(tier2);
    await images.settled();
  });

  it("a tier the store lacks falls back to the full image; an image that is its own thumbnail loads once", async () => {
    const store = spyStore();
    const full = await store.put(imageBytes(2048, 1024), "image/png");
    const engine = fakeEngine();
    const images = new ImageService(engine as never, store);
    images.attach();
    images.releaseUploads();
    engine.request({ hash: full, maxDevicePx: 200, thumbnailHash: "ab".repeat(20) });
    await ticks(5);
    browser.frame();
    expect(store.fetched).toEqual(["ab".repeat(20), full]);
    expect(engine.uploads).toEqual([{ hash: full, width: 2048, height: 1024 }]);
    expect(images.levelOf(full)).toBe("full");
    // A ≤ 512 px image: Figma's imageThumbnail is the image itself — the full image is the tier.
    const small = await store.put(imageBytes(300, 200, 9), "image/png");
    engine.request({ hash: small, maxDevicePx: 100, thumbnailHash: small });
    await ticks(4);
    browser.frame();
    expect(store.fetched.at(-1)).toBe(small);
    expect(images.levelOf(small)).toBe("full");
  });

  it("without the new fields (today's wasm: hash alone) the full image goes, as before", async () => {
    const store = spyStore();
    const full = await store.put(imageBytes(2048, 1024), "image/png");
    const engine = fakeEngine();
    const images = new ImageService(engine as never, store);
    images.attach();
    images.releaseUploads();
    engine.request(full);
    await ticks(4);
    browser.frame();
    expect(store.fetched).toEqual([full]);
    expect(engine.placeholders).toEqual([]);
    expect(engine.uploads).toEqual([{ hash: full, width: 2048, height: 1024 }]);
  });

  it("writes thumbHash and imageThumbnail back onto the page's paints that lack them, as one system change, once their images are decoded", async () => {
    const store = spyStore();
    const full = await store.put(imageBytes(2048, 1024), "image/jpeg");
    const tiered = await store.put(imageBytes(1000, 1000, 5), "image/png");
    const lacking = { type: "IMAGE", image: { hash: hashBytes(full) }, imageScaleMode: "FILL", opacity: 1 } as const;
    const engine = fakeEngine({
      page: "0:1",
      nodes: [
        { guid: "0:1", type: "CANVAS" },
        { guid: "1:2", type: "ROUNDED_RECTANGLE", fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }, lacking] },
        { guid: "1:3", type: "ELLIPSE", strokePaints: [{ ...lacking, opacity: 0.5 }] },
        // Has both already: left alone. Its imageThumbnail also teaches the service the tier.
        { guid: "1:4", type: "ROUNDED_RECTANGLE", fillPaints: [{ type: "IMAGE", image: { hash: hashBytes(tiered) }, imageThumbnail: { hash: hashBytes("cd".repeat(20)) }, thumbHash: [1, 2, 3, 4, 5] }] },
        // An instance sublayer (derived ref): never written to.
        { guid: "I1:5;1:6", type: "ROUNDED_RECTANGLE", fillPaints: [lacking] },
      ],
    });
    engine.busy = 1; // a scrub is open the first time the write-back tries
    const images = new ImageService(engine as never, store);
    images.attach();
    images.releaseUploads();
    // The idle scan found the paints; nothing is written until the image is decoded.
    await ticks(3);
    expect(engine.reads).toBe(1);
    expect(engine.applied).toEqual([]);
    engine.request(full);
    await ticks(4);
    browser.frame(); // the full image is in → the ThumbHash and the tier are computed (OffscreenCanvas)
    await ticks(6);
    // First try: busy (E_BUSY) → nothing applied yet; retried a moment later.
    expect(engine.applied).toEqual([]);
    await new Promise((r) => setTimeout(r, 320));
    expect(engine.applied.length).toBe(1);
    const { message, kind } = engine.applied[0];
    expect(kind).toBe("system");
    expect(message.nodeChanges.map((c) => c.guid).sort()).toEqual(["1:2", "1:3"]);
    const rect = message.nodeChanges.find((c) => c.guid === "1:2")!;
    expect(rect.fillPaints).toHaveLength(2);
    expect(rect.fillPaints![0]).toEqual({ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }); // untouched
    const paint = rect.fillPaints![1];
    expect(hashHex(paint.image?.hash)).toBe(full);
    expect(Array.isArray(paint.thumbHash)).toBe(true);
    expect(paintThumbHash(paint)!.length).toBeGreaterThanOrEqual(5);
    const tierHash = paintThumbnailHash(paint)!;
    expect(tierHash).toMatch(/^[0-9a-f]{40}$/);
    expect(tierHash).not.toBe(full);
    // The tier is a blob of its own in the store (512 × 256, JPEG for a JPEG original), kept alive by the paint's imageThumbnail.
    const tierBytes = await store.get(tierHash);
    expect(tierBytes).not.toBeNull();
    expect([(tierBytes![0] << 8) | tierBytes![1], (tierBytes![2] << 8) | tierBytes![3]]).toEqual([512, 256]);
    const ellipse = message.nodeChanges.find((c) => c.guid === "1:3")!;
    expect(ellipse.strokePaints![0].opacity).toBe(0.5);
    expect(paintThumbnailHash(ellipse.strokePaints![0])).toBe(tierHash);
    expect(images.writeBacks).toBe(1);
    // Nothing more to write: another slice applies nothing.
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.applied.length).toBe(1);
    // The tier learned from 1:4's paint is what a later small request for that image fetches first (the store
    // lacks it here, so the full image follows).
    expect(store.fetched).not.toContain("cd".repeat(20));
    engine.request({ hash: tiered, maxDevicePx: 200 });
    await ticks(4);
    expect(store.fetched.slice(-2)).toEqual(["cd".repeat(20), tiered]);
    for (let i = 0; i < 3; i++) {
      browser.frame();
      await tick();
    }
    await images.settled();
    expect(engine.uploads.at(-1)).toEqual({ hash: tiered, width: 1000, height: 1000 });
  });
});

describe("importImage", () => {
  let browser: ReturnType<typeof fakeBrowser>;
  beforeEach(() => (browser = fakeBrowser()));
  afterEach(() => browser.restore());

  /** A file: image bytes with a size, a type and a name. */
  const file = (width: number, height: number, type: string, name: string) => Object.assign(new Blob([imageBytes(width, height)], { type }), { name });

  it("a high-res image gets a ThumbHash and a ≤ 512 px tier stored as its own blob; the paint carries both", async () => {
    const store = memoryImageStore();
    const img = await importImage(file(2048, 1024, "image/jpeg", "Photo.jpg"), store);
    expect(img).toMatchObject({ width: 2048, height: 1024, name: "Photo", mime: "image/jpeg" });
    expect(img.thumbHash).toBeInstanceOf(Uint8Array);
    expect(img.thumbHash!.length).toBeGreaterThanOrEqual(5);
    expect(thumbHashToApproximateAspectRatio(img.thumbHash!)).toBeGreaterThan(1);
    expect(img.thumbnail).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{40}$/), width: 512, height: 256 });
    expect(img.thumbnail!.hash).not.toBe(img.hash);
    expect(store.size).toBe(2); // the image and its tier
    expect(await store.get(img.thumbnail!.hash)).not.toBeNull();
    const p = imagePaint(img.hash, img, img.name);
    expect(p.thumbHash).toEqual(Array.from(img.thumbHash!));
    expect(p.imageThumbnail).toEqual({ hash: hashBytes(img.thumbnail!.hash) });
    expect(p.originalImageWidth).toBe(2048);
  });

  it("an image of 512 px or less is its own thumbnail (as in Figma's files): no extra blob", async () => {
    const store = memoryImageStore();
    const img = await importImage(file(300, 200, "image/png", "icon.png"), store);
    expect(img.thumbnail).toEqual({ hash: img.hash, width: 300, height: 200 });
    expect(store.size).toBe(1);
    expect(img.thumbHash!.length).toBeGreaterThanOrEqual(5);
    const p = imagePaint(img.hash, img);
    expect(hashHex((p.imageThumbnail as { hash: number[] }).hash)).toBe(img.hash);
  });

  it("without OffscreenCanvas the import still works, without the progressive fields", async () => {
    (globalThis as Record<string, unknown>).OffscreenCanvas = undefined;
    const store = memoryImageStore();
    const img = await importImage(file(2048, 1024, "image/png", "big.png"), store);
    expect(img).toMatchObject({ width: 2048, height: 1024, thumbHash: null, thumbnail: null });
    const p = imagePaint(img.hash, img);
    expect(p.thumbHash).toBeUndefined();
    expect(p.imageThumbnail).toBeUndefined();
  });

  it("deriveProgressive: the tier's format follows the original (JPEG/WebP → JPEG, else PNG)", async () => {
    const store = memoryImageStore();
    const bitmap = { width: 4096, height: 4096, close() {} } as unknown as ImageBitmap;
    const png = await deriveProgressive(bitmap, { hash: "0".repeat(40), width: 4096, height: 4096, mime: "image/png" }, store);
    expect(png.thumbnail).toMatchObject({ width: 512, height: 512 });
    expect(png.thumbHash!.length).toBe(5 + Math.ceil(37 / 2));
    expect(tierMime("image/webp")).toBe("image/jpeg");
    expect(tierMime("image/gif")).toBe("image/png");
  });
});

describe("pure parts", () => {
  it("tierSize: ≤ 512 on the longer side for high-res images only", () => {
    expect(tierSize(2048, 1024)).toEqual({ width: 512, height: 256 });
    expect(tierSize(600, 513)).toEqual({ width: 512, height: 438 });
    expect(tierSize(512, 512)).toBeNull();
    expect(tierSize(300, 200)).toBeNull();
    expect(tierSize(1, 10000)).toEqual({ width: 1, height: 512 });
  });

  it("sniffImageMime reads the magic numbers", async () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/jpeg");
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe("image/png");
    expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]))).toBe("image/gif");
    expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
    expect(sniffImageMime(imageBytes(10, 10))).toBeNull();
    expect(await sha1Hex(new Uint8Array(0))).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });
});
