/** The upload panel's store side (docs/multiplayer.md §5.1): progress math, the ~10/s throttle, states, naming. */
import { describe, expect, it } from "vitest";
import type { UploadEvent, UploadProgress } from "../../shared/multiplayer/uploads";
import { BLOB_CONCURRENCY, countingBody, DONE_KEPT_MS, MULTIPART_THRESHOLD, pool, sendBlobs, speedOf, SPEED_WINDOW_MS, UPLOAD_CHUNK, UPLOAD_EVENT_MS, UploadTracker, uploadDestination, type BlobSender, type UploadClock } from "./uploads";

/** A clock the test moves by hand, with its timers */
function fakeClock() {
  let t = 1_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let n = 0;
  const clock: UploadClock = {
    now: () => t,
    setTimeout: (fn, ms) => (timers.set(++n, { at: t + ms, fn }), n),
    clearTimeout: (h) => void timers.delete(h as number),
  };
  const advance = (ms: number) => {
    t += ms;
    for (const [id, x] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (x.at > t) continue;
      timers.delete(id);
      x.fn();
    }
  };
  return { clock, advance, pending: () => timers.size };
}

function tracked() {
  const c = fakeClock();
  const tracker = new UploadTracker(c.clock);
  const events: UploadEvent[] = [];
  tracker.on((e) => events.push(e));
  const uploads = () => events.filter((e): e is { upload: UploadProgress } => "upload" in e).map((e) => e.upload);
  return { ...c, tracker, events, uploads };
}

describe("UploadTracker", () => {
  it("counts bytes against the total and says progress at most every 100 ms, the latest last", () => {
    const { tracker, uploads, advance, pending } = tracked();
    const id = tracker.begin({ fileKey: "f1", name: "Big file", destination: "Anex Tour › Design › KOC" });
    tracker.setTotal(id, 340_000_000);
    expect(uploads().at(-1)).toMatchObject({ state: "queued", bytesSent: 0, bytesTotal: 340_000_000, destination: "Anex Tour › Design › KOC", retryable: false });
    tracker.progress(id, 1_000_000); // the first progress moves the state: said at once
    expect(uploads().at(-1)).toMatchObject({ state: "uploading", bytesSent: 1_000_000 });
    const before = uploads().length;
    // 50 reads in 50 ms: nothing more said until the window ends, then the latest once
    for (let i = 2; i <= 51; i++) {
      advance(1);
      tracker.progress(id, i * 1_000_000);
    }
    expect(uploads().length).toBe(before);
    expect(pending()).toBe(1);
    advance(UPLOAD_EVENT_MS);
    expect(uploads().length).toBe(before + 1);
    expect(uploads().at(-1)!.bytesSent).toBe(51_000_000);
    // Over a second of steady reads: about ten events
    const start = uploads().length;
    for (let i = 0; i < 1000; i++) {
      advance(1);
      tracker.progress(id, 51_000_000 + i * 100_000);
    }
    advance(UPLOAD_EVENT_MS);
    expect(uploads().length - start).toBeGreaterThanOrEqual(9);
    expect(uploads().length - start).toBeLessThanOrEqual(11);
    // Never past the total
    tracker.progress(id, 999_999_999);
    advance(UPLOAD_EVENT_MS);
    expect(uploads().at(-1)!.bytesSent).toBe(340_000_000);
  });

  it("says a change of state at once (a pending progress goes with it), and a retry falls back to the parts landed", () => {
    const { tracker, uploads, advance, pending } = tracked();
    const id = tracker.begin({ fileKey: "f1", name: "A" }, { retry: () => {}, cancel: () => {} });
    tracker.setTotal(id, 1000);
    tracker.progress(id, 100);
    tracker.progress(id, 600);
    expect(pending()).toBe(1);
    tracker.retrying(id, 2, 400);
    expect(pending()).toBe(0);
    expect(uploads().at(-1)).toMatchObject({ state: "retrying", attempt: 2, bytesSent: 400, retryable: true });
    tracker.progress(id, 450);
    expect(uploads().at(-1)).toMatchObject({ state: "uploading", bytesSent: 450 });
    expect(uploads().at(-1)!.attempt).toBeUndefined();
    advance(5);
    tracker.done(id);
    expect(uploads().at(-1)).toMatchObject({ state: "done", bytesSent: 1000, endedAt: 1005 });
    // Progress after the end changes nothing
    tracker.progress(id, 10);
    expect(uploads().at(-1)!.state).toBe("done");
  });

  it("continues a file's failed entry when it goes again (a resumed upload), and lists done ones for a minute", () => {
    const { tracker, uploads, advance } = tracked();
    const id = tracker.begin({ fileKey: "f1", name: "A", destination: "Drafts" });
    tracker.setTotal(id, 10);
    tracker.failed(id, "The server is busy. Try again in a moment.");
    expect(uploads().at(-1)).toMatchObject({ state: "failed", error: "The server is busy. Try again in a moment." });
    expect(tracker.inFlight).toBe(0);
    expect(tracker.begin({ fileKey: "f1", name: "A" })).toBe(id);
    expect(uploads().at(-1)).toMatchObject({ id, state: "queued", destination: "Drafts", bytesSent: 0 });
    expect(uploads().at(-1)!.error).toBeUndefined();
    expect(tracker.inFlight).toBe(1);
    tracker.done(id);
    // A new upload of the same file after it finished is a new entry
    const again = tracker.begin({ fileKey: "f1", name: "A" });
    expect(again).not.toBe(id);
    expect(tracker.list().map((u) => u.id)).toEqual([id, again]);
    advance(DONE_KEPT_MS + 1);
    expect(tracker.list().map((u) => u.id)).toEqual([again]);
  });

  it("hands Retry and Cancel to the upload's controls; a removed upload is said gone", () => {
    const { tracker, events } = tracked();
    const did: string[] = [];
    const id = tracker.begin({ fileKey: "f1", name: "A" }, { retry: () => did.push("retry"), cancel: () => did.push("cancel") });
    tracker.retry(id);
    tracker.cancel(id);
    tracker.retry("nope");
    expect(did).toEqual(["retry", "cancel"]);
    tracker.remove(id);
    expect(events.at(-1)).toEqual({ removed: id });
    expect(tracker.list()).toEqual([]);
    // Without a retry control (a library publish) Retry does nothing
    const lib = tracker.begin({ fileKey: "f2", name: "B" }, { cancel: () => did.push("cancel 2") });
    tracker.retry(lib);
    expect(did).toEqual(["retry", "cancel"]);
  });
});

describe("countingBody", () => {
  it("reads the bytes in slices and counts them as they go", async () => {
    const bytes = new Uint8Array(UPLOAD_CHUNK * 2 + 123).map((_, i) => i % 251);
    const seen: number[] = [];
    const out = new Uint8Array(await new Response(countingBody(bytes, (n) => seen.push(n))).arrayBuffer());
    expect(out).toEqual(bytes);
    expect(seen).toEqual([UPLOAD_CHUNK, UPLOAD_CHUNK * 2, UPLOAD_CHUNK * 2 + 123]);
  });
});

describe("uploadDestination", () => {
  const look = {
    orgName: async (id: string) => (id === "o1" ? "Anex Tour" : null),
    teamName: async (id: string) => (id === "t1" ? "Design" : null),
    projectName: async (id: string) => {
      if (id === "p1") return "KOC";
      throw new Error("offline");
    },
    localFolder: () => null,
  };
  it("names org › team › folder, an org's drafts, and a file shared outside any org by its place here", async () => {
    expect(await uploadDestination({ orgId: "o1", teamId: "t1", projectId: "p1" }, look)).toBe("Anex Tour › Design › KOC");
    expect(await uploadDestination({ orgId: "o1", teamId: null, projectId: null }, look)).toBe("Anex Tour › Drafts");
    expect(await uploadDestination({ orgId: "o1", teamId: "t1", projectId: "p2" }, look)).toBe("Anex Tour › Design");
    expect(await uploadDestination(null, look)).toBe("Drafts");
    expect(await uploadDestination(null, { ...look, localFolder: () => "Client work" })).toBe("Client work");
  });
});

// --- Wecra 1.1 (docs/cloud.md §4) ---

describe("the speed and the time left", () => {
  it("a moving average over the last 5 s, said once a second of it is seen; the time left at that speed", () => {
    const { tracker, uploads, advance } = tracked();
    const id = tracker.begin({ fileKey: "f1", name: "Big" });
    tracker.setTotal(id, 100_000_000);
    tracker.progress(id, 0);
    advance(500);
    tracker.progress(id, 1_000_000);
    expect(uploads().at(-1)!.bytesPerSecond).toBeUndefined(); // half a second: not yet
    advance(500);
    tracker.progress(id, 2_000_000);
    advance(UPLOAD_EVENT_MS);
    expect(uploads().at(-1)).toMatchObject({ bytesPerSecond: 2_000_000, secondsLeft: 49 });
    // Faster now: the window forgets the start
    for (let i = 0; i < 10; i++) {
      advance(1000);
      tracker.progress(id, 2_000_000 + (i + 1) * 8_000_000);
    }
    advance(UPLOAD_EVENT_MS);
    const last = uploads().at(-1)!;
    expect(last.bytesPerSecond).toBe(8_000_000);
    expect(last.secondsLeft).toBeCloseTo((100_000_000 - 82_000_000) / 8_000_000, 5);
    // Done: no speed any more
    tracker.done(id);
    expect(uploads().at(-1)!.bytesPerSecond).toBeUndefined();
  });

  it("a part going again (fewer bytes) starts the average over; a failure clears it", () => {
    const s = speedOf(
      [
        { t: 0, b: 0 },
        { t: 2000, b: 4_000_000 },
      ],
      10_000_000,
    );
    expect(s).toEqual({ bytesPerSecond: 2_000_000, secondsLeft: 3 });
    expect(speedOf([{ t: 0, b: 5 }], 10)).toBeNull();
    const { tracker, uploads, advance } = tracked();
    const id = tracker.begin({ fileKey: "f1", name: "Big" });
    tracker.setTotal(id, 10_000_000);
    tracker.progress(id, 0);
    advance(SPEED_WINDOW_MS / 2);
    tracker.progress(id, 5_000_000);
    tracker.retrying(id, 2, 1_000_000);
    advance(100);
    tracker.progress(id, 1_200_000);
    expect(uploads().at(-1)!.bytesPerSecond).toBeUndefined();
    tracker.failed(id, "nope");
    expect(uploads().at(-1)!.bytesPerSecond).toBeUndefined();
  });
});

/** A fake server for `sendBlobs`: who was asked what, how many at once */
function fakeSender(blobs: Record<string, Uint8Array>, o: { multipart?: boolean; failPart?: number; failPartError?: unknown } = {}) {
  const log: string[] = [];
  let active = 0;
  let most = 0;
  let failOnce = o.failPart;
  const busy = async <T>(name: string, run: () => T): Promise<T> => {
    log.push(name);
    active++;
    most = Math.max(most, active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    return run();
  };
  const s: BlobSender = {
    bytes: async (sha1) => blobs[sha1],
    put: (sha1, bytes, onSent) => busy(`put ${sha1}`, () => onSent(bytes.length)),
    start: async (sha1) => (log.push(`start ${sha1}`), o.multipart === false ? null : { uploadId: `u-${sha1}`, partSize: 8 * 1024 * 1024 }),
    part: (sha1, id, n, bytes, onSent) =>
      busy(`part ${sha1} ${n}`, () => {
        if (failOnce === n) {
          failOnce = undefined;
          throw o.failPartError ?? new Error("busy");
        }
        onSent(bytes.length);
        return { partNumber: n, etag: `${id}-${n}` };
      }),
    complete: async (sha1, id, parts) => void log.push(`complete ${sha1} ${parts.map((p) => p.etag).join(",")}`),
    abort: async (sha1, id) => void log.push(`abort ${sha1} ${id}`),
    retry: async (run) => {
      try {
        return await run();
      } catch (e) {
        if ((e as Error).message !== "busy") throw e;
        log.push("retry");
        return run();
      }
    },
  };
  return { s, log, most: () => most };
}

describe("sendBlobs", () => {
  it("4 at a time; the bytes of all together as they go", async () => {
    const blobs = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`s${i}`, new Uint8Array(1000 + i)]));
    const f = fakeSender(blobs);
    const seen: number[] = [];
    await sendBlobs(Object.keys(blobs), f.s, { onProgress: (sent) => seen.push(sent) });
    expect(f.most()).toBe(BLOB_CONCURRENCY);
    expect(f.log.filter((l) => l.startsWith("put"))).toHaveLength(10);
    expect(seen.at(-1)).toBe(Object.values(blobs).reduce((n, b) => n + b.length, 0));
  });

  it("over 8 MB in parts, a failed part tried again alone, then completed; small ones whole", async () => {
    const big = new Uint8Array(MULTIPART_THRESHOLD * 2 + 5);
    const f = fakeSender({ big, small: new Uint8Array(10) }, { failPart: 2 });
    let landed = 0;
    await sendBlobs(["big", "small"], f.s, { onProgress: (_sent, done) => (landed = done) });
    expect(f.log.filter((l) => l.startsWith("part big"))).toEqual(["part big 1", "part big 2", "part big 2", "part big 3"]);
    expect(f.log).toContain("complete big u-big-1,u-big-2,u-big-3");
    expect(f.log).toContain("put small");
    expect(f.log).not.toContain("put big");
    expect(landed).toBe(big.length + 10);
  });

  it("a server without multipart takes one PUT; Cancel aborts a multipart upload under way", async () => {
    const big = new Uint8Array(MULTIPART_THRESHOLD + 1);
    const plain = fakeSender({ big }, { multipart: false });
    await sendBlobs(["big"], plain.s);
    expect(plain.log).toEqual(["start big", "put big"]);
    const ac = new AbortController();
    const cancelled = fakeSender({ big }, { failPart: 1, failPartError: new Error("aborted") });
    ac.abort();
    await expect(sendBlobs(["big"], cancelled.s, { signal: ac.signal })).rejects.toThrow("aborted");
    expect(cancelled.log).toContain("abort big u-big");
  });

  it("pool: the first failure stops new starts and is thrown once the others settle", async () => {
    const started: number[] = [];
    await expect(
      pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n);
        await new Promise((r) => setTimeout(r, 1));
        if (n === 2) throw new Error("two");
      }),
    ).rejects.toThrow("two");
    expect(started).toEqual([1, 2, 3]);
  });
});
