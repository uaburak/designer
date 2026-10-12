/**
 * Images coming down after their file opened (Wecra 1.1.1, docs/cloud.md §4.1): 8 at a time, the page the file opens
 * on first, an editor's image bumped to the front, one download per image across files, retries with backoff, the
 * file's "Downloading images" row, and the arrivals said.
 */
import { describe, expect, it } from "vitest";
import type { UploadEvent, UploadProgress } from "../../shared/multiplayer/uploads";
import { encodeMessage, type NodeChange } from "../../shared/schema/codec";
import { StoreError } from "../../shared/store/protocol";
import { BlobDownloads, DOWNLOAD_CONCURRENCY, imageDownloadOrder, type BlobSource } from "./downloads";
import { UploadTracker } from "./uploads";

const sha = (n: number) => n.toString(16).padStart(2, "0").repeat(20);
const hashBytes = (n: number) => new Uint8Array(20).fill(n);

/** A server whose answers the test releases one by one */
function fakeSource(opts: { sizes?: Record<string, number>; fail?: (sha1: string, attempt: number) => StoreError | null } = {}) {
  const store = new Set<string>();
  const started: string[] = [];
  const waiting = new Map<string, () => void>();
  const attempts = new Map<string, number>();
  const sleeps: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const src: BlobSource = {
    has: async (sha1s) => sha1s.map((s) => store.has(s)),
    get: async (_key, sha1, onReceived, onSize) => {
      const attempt = (attempts.get(sha1) ?? 0) + 1;
      attempts.set(sha1, attempt);
      const err = opts.fail?.(sha1, attempt);
      if (err) throw err;
      started.push(sha1);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      onSize(1000);
      await new Promise<void>((r) => waiting.set(sha1, r));
      onReceived(1000);
      inFlight--;
      const body = new Uint8Array(1000);
      body.set(new TextEncoder().encode(sha1));
      return body;
    },
    put: async (bytes) => void store.add(new TextDecoder().decode(bytes.subarray(0, 40))),
    ...(opts.sizes ? { sizes: async () => opts.sizes! } : {}),
    sleep: async (ms) => void sleeps.push(ms),
    log: () => {},
  };
  const tick = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };
  /** Lets the image's answer come, then the queue move on */
  const release = async (sha1: string) => {
    waiting.get(sha1)?.();
    waiting.delete(sha1);
    await tick();
  };
  const releaseAll = async () => {
    while (waiting.size) for (const s of [...waiting.keys()]) await release(s);
  };
  return { src, store, started, waiting, attempts, sleeps, tick, release, releaseAll, max: () => maxInFlight };
}

function setup(o: Parameters<typeof fakeSource>[0] = {}) {
  const s = fakeSource(o);
  const tracker = new UploadTracker();
  const events: UploadEvent[] = [];
  tracker.on((e) => events.push(e));
  const done: string[] = [];
  const dl = new BlobDownloads(s.src, tracker, { retryDelays: [100, 400], onFileDone: (f) => done.push(f) });
  const arrived: string[] = [];
  dl.onArrived((sha1s) => arrived.push(...sha1s));
  const rows = () => tracker.list();
  const last = () => events.filter((e): e is { upload: UploadProgress } => "upload" in e).at(-1)!.upload;
  return { ...s, tracker, dl, arrived, done, rows, last };
}

describe("BlobDownloads", () => {
  it("queues only what the store lacks and resolves before any image comes", async () => {
    const t = setup();
    t.store.add(sha(1));
    const queued = await t.dl.add({ fileKey: "f", key: "room", name: "Big file", rest: [sha(1), sha(2), sha(3)] });
    expect(queued).toEqual([sha(2), sha(3)]);
    expect(t.store.has(sha(2))).toBe(false);
    expect(t.rows()).toEqual([expect.objectContaining({ fileKey: "f", name: "Big file", direction: "download", destination: "Downloading images" })]);
    await t.releaseAll();
    expect(t.done).toEqual(["f"]);
    expect(t.arrived.sort()).toEqual([sha(2), sha(3)]);
    expect(t.rows()[0]).toMatchObject({ state: "done", bytesSent: 2000, bytesTotal: 2000 });
  });

  it(`downloads ${DOWNLOAD_CONCURRENCY} at a time`, async () => {
    const t = setup();
    const all = Array.from({ length: 20 }, (_, i) => sha(i + 1));
    await t.dl.add({ fileKey: "f", key: "room", name: "F", rest: all });
    await t.tick();
    expect(t.started.length).toBe(DOWNLOAD_CONCURRENCY);
    await t.release(all[0]);
    expect(t.started.length).toBe(DOWNLOAD_CONCURRENCY + 1);
    await t.releaseAll();
    expect(t.max()).toBe(DOWNLOAD_CONCURRENCY);
    expect(t.store.size).toBe(20);
  });

  it("the page the file opens on first, then the rest; an editor's image goes to the front", async () => {
    const t = setup();
    const rest = Array.from({ length: 10 }, (_, i) => sha(i + 1));
    const first = [sha(50), sha(51)];
    await t.dl.add({ fileKey: "f", key: "room", name: "F", first, rest });
    await t.tick();
    expect(t.started.slice(0, 2)).toEqual(first);
    // Wanted while queued: next to start
    const wanted = t.dl.want(sha(10))!;
    expect(wanted).toBeInstanceOf(Promise);
    await t.release(sha(50));
    expect(t.started.at(-1)).toBe(sha(10));
    await t.release(sha(10));
    expect(await wanted).toBe(true);
    // Nothing fetching it: null at once
    expect(t.dl.want(sha(99))).toBeNull();
    await t.releaseAll();
  });

  it("one download per image across files; each file's row finishes", async () => {
    const t = setup();
    await t.dl.add({ fileKey: "a", key: "ra", name: "A", rest: [sha(1), sha(2)] });
    await t.dl.add({ fileKey: "b", key: "rb", name: "B", rest: [sha(2), sha(3)] });
    await t.releaseAll();
    expect(t.attempts.get(sha(2))).toBe(1);
    expect(t.done.sort()).toEqual(["a", "b"]);
    expect(t.rows().map((r) => r.state)).toEqual(["done", "done"]);
  });

  it("goes again after a busy moment (with backoff); an image the room hasn't is skipped", async () => {
    const busy = new StoreError("unavailable", "busy", { code: "server_busy" });
    const t = setup({ fail: (s, attempt) => (s === sha(1) && attempt <= 2 ? busy : s === sha(2) ? new StoreError("not-found", "none") : null) });
    await t.dl.add({ fileKey: "f", key: "room", name: "F", rest: [sha(1), sha(2)] });
    await t.tick();
    expect(t.sleeps).toEqual([100, 400]);
    await t.releaseAll();
    expect(t.store.has(sha(1))).toBe(true);
    expect(t.store.has(sha(2))).toBe(false);
    expect(t.done).toEqual(["f"]);
    expect(t.arrived).toEqual([sha(1)]);
  });

  it("a row fails once the tries are spent; Retry (or an editor wanting it) queues it again", async () => {
    let down = true;
    const t = setup({ fail: () => (down ? new StoreError("offline", "no network") : null) });
    await t.dl.add({ fileKey: "f", key: "room", name: "F", rest: [sha(1), sha(2)] });
    await t.tick();
    expect(t.rows()[0]).toMatchObject({ state: "failed", retryable: true, error: "2 images couldn’t download. Check your connection." });
    expect(t.dl.pendingOf("f").sort()).toEqual([sha(1), sha(2)]);
    down = false;
    // An editor needs one: it goes at once
    const wanted = t.dl.want(sha(2))!;
    await t.tick();
    await t.release(sha(2));
    expect(await wanted).toBe(true);
    t.tracker.retry(t.rows()[0].id);
    await t.tick();
    expect(t.rows()[0].state).toBe("uploading");
    await t.releaseAll();
    expect(t.rows()[0].state).toBe("done");
    expect(t.done).toEqual(["f"]);
  });

  it("the row's total is the server's sizes when it says them, bytes received as they come", async () => {
    const t = setup({ sizes: { [sha(1)]: 1000, [sha(2)]: 1000, [sha(3)]: 4000 } });
    await t.dl.add({ fileKey: "f", key: "room", name: "F", rest: [sha(1), sha(2), sha(3)] });
    await t.tick();
    expect(t.last()).toMatchObject({ bytesTotal: 6000, direction: "download" });
    await t.release(sha(1));
    expect(t.rows()[0]).toMatchObject({ bytesSent: 1000, state: "uploading" });
    await t.releaseAll();
  });
});

describe("imageDownloadOrder", () => {
  const n = (localID: number, fields: Record<string, unknown>): NodeChange => ({ guid: { sessionID: 0, localID }, phase: "CREATED", ...fields }) as NodeChange;
  const paint = (image: number, thumb?: number) => ({ type: "IMAGE", image: { hash: hashBytes(image) }, ...(thumb ? { imageThumbnail: { hash: hashBytes(thumb) } } : {}) });
  const parent = (localID: number, position: string) => ({ parentIndex: { guid: { sessionID: 0, localID }, position } });

  it("the first page's tiers, then its images and its instances' main components' images; the rest after", () => {
    const snapshot = encodeMessage({
      type: "NODE_CHANGES",
      sessionID: 0,
      ackID: 0,
      blobs: [],
      nodeChanges: [
        n(0, { type: "DOCUMENT", name: "Document" }),
        n(2, { type: "CANVAS", name: "Second", ...parent(0, "b") }),
        n(1, { type: "CANVAS", name: "First", ...parent(0, "a") }),
        n(10, { type: "SYMBOL", name: "Card", ...parent(2, "a"), fillPaints: [paint(3)] }),
        n(11, { type: "RECTANGLE", ...parent(2, "b"), fillPaints: [paint(4)] }),
        n(5, { type: "RECTANGLE", ...parent(1, "a"), fillPaints: [paint(1, 2)] }),
        n(6, { type: "INSTANCE", ...parent(1, "b"), symbolData: { symbolID: { sessionID: 0, localID: 10 } } }),
      ],
    });
    expect(imageDownloadOrder(snapshot)).toEqual({ first: [sha(2), sha(3), sha(1)], rest: [sha(4)] });
  });

  it("a document without pages (or unreadable) has no first page", () => {
    expect(imageDownloadOrder(new Uint8Array([1, 2, 3]))).toEqual({ first: [], rest: [] });
  });
});
