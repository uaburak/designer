/**
 * The store's uploads as the upload panel shows them (docs/multiplayer.md §5.1): one entry per file going up — a share,
 * a move into an org folder, a new org file, a branch — with its bytes sent of its total and its state. Progress is
 * counted as the request bodies are read (`countingBody`) and said at most every UPLOAD_EVENT_MS; a change of state is
 * said at once. Imports nothing from Node or the DOM (both stores run it).
 *
 * Wecra 1.1 (docs/cloud.md §4): the speed is a moving average over the last SPEED_WINDOW_MS (`bytesPerSecond`, and
 * `secondsLeft` at that speed); a file's images go 4 at a time (`sendBlobs`), those over 8 MB in parts that each try
 * again alone (R2 multipart through the server), and its snapshot after them.
 */
import type { UploadEvent, UploadProgress } from "../../shared/multiplayer/uploads";
import { uploadInFlight } from "../../shared/multiplayer/uploads";
import type { FileKey } from "../../shared/store/types";
import type { Unsubscribe } from "../../shared/store/repositories";

/** Progress events at most this often per upload (~10 a second) */
export const UPLOAD_EVENT_MS = 100;
/** A finished upload stays listed this long (a window opened just after still shows it) */
export const DONE_KEPT_MS = 60_000;
/** The slices a streamed body is read in */
export const UPLOAD_CHUNK = 256 * 1024;
/** The speed is averaged over this long */
export const SPEED_WINDOW_MS = 5000;
/** … and said once this much of it has been seen */
export const SPEED_MIN_SPAN_MS = 1000;
/** Images going up at once (docs/cloud.md §4) */
export const BLOB_CONCURRENCY = 4;
/** Images larger than this go up in parts (R2 multipart, server/src/storage/blobs.ts) */
export const MULTIPART_THRESHOLD = 8 * 1024 * 1024;

export interface UploadClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: UploadClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** What the panel's buttons do for one upload (the multiplayer service's) */
export interface UploadControls {
  /** Absent: the panel offers no Retry (the person starts it again, as a library publish) */
  retry?(): void;
  cancel(): void;
}

interface Entry {
  p: UploadProgress;
  controls: UploadControls | null;
  lastEmit: number;
  timer: unknown;
  /** (time, bytes sent) over the speed's window */
  samples: { t: number; b: number }[];
}

/**
 * The moving average: bytes sent over the samples' span (the oldest within SPEED_WINDOW_MS, or just before it), once the
 * span is SPEED_MIN_SPAN_MS; and the time left at that speed. A fall in bytes (a part going again) starts it over.
 */
export function speedOf(samples: { t: number; b: number }[], total: number): { bytesPerSecond: number; secondsLeft?: number } | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = last.t - first.t;
  if (span < SPEED_MIN_SPAN_MS || last.b < first.b) return null;
  const bytesPerSecond = ((last.b - first.b) * 1000) / span;
  if (!(bytesPerSecond > 0)) return { bytesPerSecond: 0 };
  return { bytesPerSecond, ...(total > 0 ? { secondsLeft: Math.max(0, (total - last.b) / bytesPerSecond) } : {}) };
}

export class UploadTracker {
  private items = new Map<string, Entry>();
  private listeners = new Set<(e: UploadEvent) => void>();
  private n = 0;

  constructor(private clock: UploadClock = systemClock) {}

  on(listener: (e: UploadEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The uploads to show: those going or failed, and those done within DONE_KEPT_MS */
  list(): UploadProgress[] {
    const now = this.clock.now();
    for (const [id, e] of this.items) if (e.p.state === "done" && now - (e.p.endedAt ?? now) > DONE_KEPT_MS) this.items.delete(id);
    return [...this.items.values()].map((e) => ({ ...e.p }));
  }

  /** The upload (or, `direction`, the download) of this file still going or failed (a resumed one continues its entry) */
  of(fileKey: FileKey, direction?: "download"): string | null {
    for (const [id, e] of this.items) if (e.p.fileKey === fileKey && e.p.state !== "done" && e.p.direction === direction) return id;
    return null;
  }

  get inFlight(): number {
    let n = 0;
    for (const e of this.items.values()) if (uploadInFlight(e.p)) n++;
    return n;
  }

  /** A file starts going up (queued); a file with an entry not done yet continues it from 0 */
  begin(input: { fileKey: FileKey; name: string; destination?: string; direction?: "download" }, controls: UploadControls | null = null): string {
    const existing = this.of(input.fileKey, input.direction);
    if (existing) {
      const e = this.items.get(existing)!;
      e.p = { ...e.p, name: input.name || e.p.name, destination: input.destination || e.p.destination, bytesSent: 0, state: "queued" };
      delete e.p.error;
      delete e.p.attempt;
      delete e.p.endedAt;
      e.samples = [];
      clearSpeed(e.p);
      if (controls) {
        e.controls = controls;
        e.p.retryable = !!controls.retry;
      }
      this.flush(e);
      return existing;
    }
    const id = `${input.direction ? "dn" : "up"}_${this.clock.now().toString(36)}_${(++this.n).toString(36)}`;
    const e: Entry = { p: { id, fileKey: input.fileKey, name: input.name, destination: input.destination ?? "", bytesSent: 0, bytesTotal: 0, state: "queued", startedAt: this.clock.now(), retryable: !!controls?.retry, ...(input.direction ? { direction: input.direction } : {}) }, controls, lastEmit: 0, timer: null, samples: [] };
    this.items.set(id, e);
    this.flush(e);
    return id;
  }

  setDestination(id: string, destination: string): void {
    const e = this.items.get(id);
    if (!e || !destination || e.p.destination === destination) return;
    e.p = { ...e.p, destination };
    this.flush(e);
  }

  /** The bytes this upload sends in all (its missing images and its snapshot) */
  setTotal(id: string, bytesTotal: number): void {
    const e = this.items.get(id);
    if (!e) return;
    e.p = { ...e.p, bytesTotal: Math.max(0, bytesTotal), bytesSent: Math.min(e.p.bytesSent, Math.max(0, bytesTotal)) };
    this.flush(e);
  }

  /** Bytes sent so far (all parts together); said at most every UPLOAD_EVENT_MS */
  progress(id: string, bytesSent: number): void {
    const e = this.items.get(id);
    if (!e || e.p.state === "done" || e.p.state === "failed") return;
    const sent = Math.max(0, e.p.bytesTotal ? Math.min(bytesSent, e.p.bytesTotal) : bytesSent);
    const moved = e.p.state !== "uploading";
    e.p = { ...e.p, bytesSent: sent, state: "uploading" };
    delete e.p.attempt;
    this.sample(e, sent);
    if (moved) return this.flush(e);
    this.throttled(e);
  }

  /** The speed's samples: this one added, those past the window dropped (one kept before it as the baseline) */
  private sample(e: Entry, sent: number): void {
    const t = this.clock.now();
    const last = e.samples[e.samples.length - 1];
    if (last && sent < last.b) e.samples = [];
    if (last && last.t === t) last.b = sent;
    else e.samples.push({ t, b: sent });
    while (e.samples.length > 2 && t - e.samples[1].t >= SPEED_WINDOW_MS) e.samples.shift();
    const s = speedOf(e.samples, e.p.bytesTotal);
    clearSpeed(e.p);
    if (s) Object.assign(e.p, s);
  }

  /** A part failed for a moment and goes again (try `attempt`, 2 being the first retry) */
  retrying(id: string, attempt: number, bytesSent?: number): void {
    const e = this.items.get(id);
    if (!e) return;
    e.p = { ...e.p, state: "retrying", attempt, ...(bytesSent !== undefined ? { bytesSent } : {}) };
    this.flush(e);
  }

  done(id: string): void {
    const e = this.items.get(id);
    if (!e) return;
    e.p = { ...e.p, state: "done", bytesSent: Math.max(e.p.bytesSent, e.p.bytesTotal), endedAt: this.clock.now() };
    delete e.p.attempt;
    delete e.p.error;
    clearSpeed(e.p);
    this.flush(e);
  }

  failed(id: string, message: string): void {
    const e = this.items.get(id);
    if (!e) return;
    e.p = { ...e.p, state: "failed", error: message, endedAt: this.clock.now() };
    delete e.p.attempt;
    clearSpeed(e.p);
    e.samples = [];
    this.flush(e);
  }

  /** Gone from the list (cancelled) */
  remove(id: string): void {
    const e = this.items.get(id);
    if (!e) return;
    this.items.delete(id);
    if (e.timer !== null) this.clock.clearTimeout(e.timer);
    this.say({ removed: id });
  }

  retry(id: string): void {
    const e = this.items.get(id);
    if (e && e.p.state !== "done") e.controls?.retry?.();
  }

  cancel(id: string): void {
    const e = this.items.get(id);
    if (e && e.p.state !== "done") e.controls?.cancel();
  }

  close(): void {
    for (const e of this.items.values()) if (e.timer !== null) this.clock.clearTimeout(e.timer);
    this.listeners.clear();
  }

  private throttled(e: Entry): void {
    const now = this.clock.now();
    if (now - e.lastEmit >= UPLOAD_EVENT_MS) return this.flush(e);
    if (e.timer !== null) return;
    e.timer = this.clock.setTimeout(
      () => {
        e.timer = null;
        if (this.items.get(e.p.id) === e) this.flush(e);
      },
      UPLOAD_EVENT_MS - (now - e.lastEmit),
    );
  }

  private flush(e: Entry): void {
    if (e.timer !== null) {
      this.clock.clearTimeout(e.timer);
      e.timer = null;
    }
    e.lastEmit = this.clock.now();
    this.say({ upload: { ...e.p } });
  }

  private say(event: UploadEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        /* a listener's trouble isn't the upload's */
      }
    }
  }
}

function clearSpeed(p: UploadProgress): void {
  delete p.bytesPerSecond;
  delete p.secondsLeft;
}

/**
 * A request body read in UPLOAD_CHUNK slices, `onRead` told the bytes read so far as each slice is handed to the
 * connection (what has gone, give or take the socket's buffer). Made anew for every try.
 */
export function countingBody(bytes: Uint8Array, onRead: (sent: number) => void): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (off >= bytes.length) {
        c.close();
        return;
      }
      const end = Math.min(off + UPLOAD_CHUNK, bytes.length);
      c.enqueue(bytes.subarray(off, end));
      off = end;
      onRead(off);
    },
  });
}

/** What naming an upload's destination reads (the store's org repositories, its local folders) */
export interface DestinationLookups {
  orgName(orgId: string): Promise<string | null>;
  teamName(teamId: string): Promise<string | null>;
  projectName(projectId: string): Promise<string | null>;
  /** The file's local folder's name, null in Drafts */
  localFolder(): string | null;
}

/** Where an upload goes, as the panel says it: "Anex Tour › Design › KOC" (org › team › folder), "Anex Tour › Drafts",
 *  or for a file shared outside any org, its own place here ("Drafts", its folder) */
export async function uploadDestination(place: { orgId: string; teamId: string | null; projectId: string | null } | null, look: DestinationLookups): Promise<string> {
  if (!place) return look.localFolder() ?? "Drafts";
  const safe = (p: Promise<string | null>) => p.catch(() => null);
  const [org, team, project] = await Promise.all([safe(look.orgName(place.orgId)), place.teamId ? safe(look.teamName(place.teamId)) : null, place.projectId ? safe(look.projectName(place.projectId)) : null]);
  const parts = [org, ...(place.projectId ? [team, project] : ["Drafts"])].filter((s): s is string => !!s);
  return parts.join(" › ");
}

// ---- images going up: 4 at a time, big ones in parts (docs/cloud.md §4) ------------------------------------------------

/** A multipart upload's start: the server has the image already, or the upload to send parts to */
export type MultipartStart = { done: true } | { uploadId: string; partSize: number };

/** How one file's images reach the server (the multiplayer service's calls; a test's fakes) */
export interface BlobSender {
  /** The image's bytes (the store's blob file) */
  bytes(sha1: string): Promise<Uint8Array>;
  /** One request; `onSent` told the bytes sent of it as they go */
  put(sha1: string, bytes: Uint8Array, onSent: (n: number) => void): Promise<void>;
  /** A multipart upload begun; null when the server takes none (an older server, an org with key management) */
  start(sha1: string, size: number): Promise<MultipartStart | null>;
  part(sha1: string, uploadId: string, n: number, bytes: Uint8Array, onSent: (n: number) => void): Promise<{ partNumber: number; etag: string }>;
  complete(sha1: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  /** Cancel: the upload dropped on the server (best effort) */
  abort(sha1: string, uploadId: string): Promise<void>;
  /** Each request tried again through a busy moment (`withRetry`) */
  retry<T>(step: () => Promise<T>): Promise<T>;
}

/**
 * Bounded concurrency: `run` over `items`, `limit` at a time, in order of start; the first failure stops new starts and
 * is thrown once those running have settled.
 */
export async function pool<T>(items: readonly T[], limit: number, run: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: { e: unknown } | null = null;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        await run(items[i], i);
      } catch (e) {
        failed ??= { e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw (failed as { e: unknown }).e;
}

/**
 * A file's missing images sent, BLOB_CONCURRENCY at a time; those over MULTIPART_THRESHOLD in parts, each part tried
 * again alone. `onProgress(sent, landed)`: the bytes of every image together as they go, and those done for good (a
 * part going again falls back to what had landed). `signal`: Cancel — a multipart upload under way is aborted on the
 * server.
 */
export async function sendBlobs(
  sha1s: readonly string[],
  s: BlobSender,
  o: { onProgress?(sent: number, landed: number): void; onSize?(sha1: string, size: number): void; signal?: AbortSignal; concurrency?: number } = {},
): Promise<void> {
  const inFlight = new Map<string, number>();
  let landed = 0;
  const say = () => o.onProgress?.(landed + [...inFlight.values()].reduce((a, b) => a + b, 0), landed);
  await pool(sha1s, o.concurrency ?? BLOB_CONCURRENCY, async (sha1) => {
    const bytes = await s.bytes(sha1);
    o.onSize?.(sha1, bytes.length);
    inFlight.set(sha1, 0);
    const sent = (base: number) => (n: number) => {
      inFlight.set(sha1, base + n);
      say();
    };
    const start = bytes.length > MULTIPART_THRESHOLD ? await s.retry(() => s.start(sha1, bytes.length)) : null;
    if (start && "done" in start) {
      // The server had it already (another file's): nothing to send
    } else if (start) {
      const parts: { partNumber: number; etag: string }[] = [];
      try {
        for (let n = 1, at = 0; at < bytes.length; n++, at += start.partSize) {
          const part = bytes.subarray(at, Math.min(at + start.partSize, bytes.length));
          const base = at;
          parts.push(await s.retry(() => s.part(sha1, start.uploadId, n, part, sent(base))));
          inFlight.set(sha1, at + part.length);
        }
        await s.retry(() => s.complete(sha1, start.uploadId, parts));
      } catch (e) {
        if (o.signal?.aborted) await s.abort(sha1, start.uploadId).catch(() => undefined);
        throw e;
      }
    } else {
      await s.retry(() => s.put(sha1, bytes, sent(0)));
    }
    inFlight.delete(sha1);
    landed += bytes.length;
    say();
  });
}
