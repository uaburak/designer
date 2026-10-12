/** The upload panel's store side (docs/multiplayer.md §5.1): progress math, the ~10/s throttle, states, naming. */
import { describe, expect, it } from "vitest";
import type { UploadEvent, UploadProgress } from "../../shared/multiplayer/uploads";
import { countingBody, DONE_KEPT_MS, UPLOAD_CHUNK, UPLOAD_EVENT_MS, UploadTracker, uploadDestination, type UploadClock } from "./uploads";

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
