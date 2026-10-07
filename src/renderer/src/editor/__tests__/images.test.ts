// The editor's image service: the engine's REQUEST_IMAGE answered from the store, bitmaps decoded off the main
// thread, uploads held until the chrome's first paint and then a few per frame (the first frames of a file with
// images never pay for them), `settled()` once every upload is in.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImageService, memoryImageStore } from "../images";

type Handler = (e: { type: string; hash: string }) => void;

/** A fake engine: emits REQUEST_IMAGE, counts uploads. */
function fakeEngine() {
  const handlers = new Set<Handler>();
  const uploads: string[] = [];
  return {
    destroyed: false,
    uploads,
    onAny: (h: Handler) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    request: (hash: string) => handlers.forEach((h) => h({ type: "REQUEST_IMAGE", hash })),
    addImage: (hash: string) => {
      uploads.push(hash);
      return 0;
    },
    imageFailed: () => 0,
  };
}

/** requestAnimationFrame run by hand, and a createImageBitmap that decodes nothing. */
function fakeBrowser() {
  const g = globalThis as Record<string, unknown>;
  const before = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, cib: g.createImageBitmap };
  const queue: FrameRequestCallback[] = [];
  g.requestAnimationFrame = (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  };
  g.cancelAnimationFrame = () => {};
  g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  return {
    frame: () => {
      for (const cb of queue.splice(0)) cb(0);
    },
    pending: () => queue.length,
    restore: () => {
      g.requestAnimationFrame = before.raf;
      g.cancelAnimationFrame = before.caf;
      g.createImageBitmap = before.cib;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ImageService", () => {
  let browser: ReturnType<typeof fakeBrowser>;
  beforeEach(() => (browser = fakeBrowser()));
  afterEach(() => browser.restore());

  it("holds uploads until the first paint, then two per frame, and settles when they are in", async () => {
    const store = memoryImageStore();
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) hashes.push(await store.put(new Uint8Array([i, 1, 2, 3]), "image/png"));
    const engine = fakeEngine();
    const images = new ImageService(engine as never, store);
    const off = images.attach();
    for (const h of hashes) engine.request(h);
    // Decoded, but nothing reaches the engine before the chrome has painted.
    for (let i = 0; i < 5; i++) await tick();
    expect(engine.uploads).toEqual([]);
    expect(images.loadingCount).toBe(5);
    images.releaseUploads();
    browser.frame();
    expect(engine.uploads.length).toBe(2);
    browser.frame();
    expect(engine.uploads.length).toBe(4);
    browser.frame();
    expect(engine.uploads.length).toBe(5);
    expect(engine.uploads.sort()).toEqual([...hashes].sort());
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
    for (let i = 0; i < 4; i++) await tick();
    expect(failed).toBe("0".repeat(40));
    expect(engine.uploads).toEqual([]);
  });
});
