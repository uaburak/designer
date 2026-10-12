/**
 * Images coming down after their file opened (Wecra 1.1.1, docs/cloud.md §4.1) — Figma opens a file as soon as its
 * document is here and fetches its images after, the page shown first. A shared, org or personal file's copy is made
 * (or filled) from the room's snapshot alone; its images not in the store yet are queued here:
 *
 * - DOWNLOAD_CONCURRENCY at a time (a bounded pool, as uploads are), in order of priority: an image an editor asked for
 *   (`want`, newest first), then the images of the page the file opens on (`imageDownloadOrder`: its low-res tiers
 *   before its full images), then the rest in document order;
 * - one download per image however many files use it (blobs are content-addressed);
 * - a momentary failure (busy, offline) goes again after DOWNLOAD_RETRY_DELAYS; an image the room doesn't have is
 *   skipped (its layer keeps the placeholder, as before); others fail the file's row, whose Retry queues them again;
 * - what is left is kept with the file's link (`LinkRecord.images`), so the next start continues (`resume`).
 *
 * Each arrival is said (`onArrived`, topic `blobs`): an open editor draws it in place of its placeholder. The transfers
 * panel shows one "Downloading images" row per file (the upload tracker's entries with `direction: "download"`).
 * Imports nothing from Node or the DOM (both stores run it).
 */
import { decodeMessage } from "../../shared/schema/codec";
import type { Message, NodeChange } from "../../shared/schema/document.generated";
import { MODEL } from "../../shared/schema/model";
import { messageImageHashes } from "../../shared/schema/patch";
import { toHex, walkValue } from "../../shared/schema/visit";
import { StoreError } from "../../shared/store/protocol";
import type { FileKey } from "../../shared/store/types";
import type { Unsubscribe } from "../../shared/store/repositories";
import { isTransient } from "./http";
import type { UploadTracker } from "./uploads";

/** Images coming down at once */
export const DOWNLOAD_CONCURRENCY = 8;
/** Waits between an image's tries when the server is busy or unreachable (then its file's row fails, with Retry) */
export const DOWNLOAD_RETRY_DELAYS = [1000, 4000, 15000];
/** The server's limit on hashes per sizes call */
const SIZES_BATCH = 1000;

/** Priorities, lowest first: asked for by an editor, the page the file opens on, the rest */
const NOW = 0;
const PAGE = 1;
const REST = 2;

/** How the images reach the store (the multiplayer service's calls; a test's fakes) */
export interface BlobSource {
  /** Which the store has */
  has(sha1s: string[]): Promise<boolean[]>;
  /** One image's bytes from the room `key`; `onReceived` told the bytes so far, `onSize` the length when the answer
   *  says it */
  get(key: string, sha1: string, onReceived: (n: number) => void, onSize: (n: number) => void): Promise<Uint8Array>;
  /** Into the store */
  put(bytes: Uint8Array): Promise<void>;
  /** The images' sizes as the server knows them (absent or failing: the total is estimated as they come) */
  sizes?(key: string, sha1s: string[]): Promise<Record<string, number>>;
  sleep(ms: number): Promise<void>;
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void;
}

export interface DownloadOptions {
  concurrency?: number;
  retryDelays?: readonly number[];
  /** A file's images are all here (or skipped): its link forgets them */
  onFileDone?(fileKey: FileKey): void;
}

interface Job {
  sha1: string;
  /** Rooms to fetch it from (the first file's first; another file's when that one hasn't it) */
  keys: string[];
  prio: number;
  files: Set<FileKey>;
  state: "queued" | "running";
  received: number;
  waiters: ((ok: boolean) => void)[];
}

interface FileDownload {
  fileKey: FileKey;
  name: string;
  /** The tracker's entry */
  id: string;
  /** Images not here yet (queued or coming) */
  left: Set<string>;
  failed: Set<string>;
  key: string;
  /** Known sizes (the server's, or the answers') */
  sizes: Map<string, number>;
  /** Bytes of the images landed */
  landed: number;
  /** How many images the file waits for in all (the total's estimate before the sizes are known) */
  count: number;
}

/**
 * The order a file's images come down in: the page it opens on first (the first page — Figma opens a file on its first
 * page the first time — its tiers, then its full images, then those its instances' main components use), then every
 * other image as the document has them.
 */
export function imageDownloadOrder(snapshot: Uint8Array | Message): { first: string[]; rest: string[] } {
  let message: Message;
  try {
    message = snapshot instanceof Uint8Array ? decodeMessage(snapshot) : snapshot;
  } catch {
    return { first: [], rest: [] };
  }
  const nodes = message.nodeChanges ?? [];
  const all = [...messageImageHashes(message)];
  const key = (g: { sessionID?: number; localID?: number } | undefined) => (g ? `${g.sessionID ?? 0}:${g.localID ?? 0}` : "");
  const byKey = new Map<string, NodeChange>();
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    const k = key(n.guid);
    byKey.set(k, n);
    const parent = n.parentIndex?.guid ? key(n.parentIndex.guid) : null;
    if (parent) {
      let list = children.get(parent);
      if (!list) children.set(parent, (list = []));
      list.push(k);
    }
  }
  const pages = nodes
    .filter((n) => n.type === "CANVAS" && !(n as { internalOnly?: boolean }).internalOnly && n.phase !== "REMOVED")
    .sort((a, b) => ((a.parentIndex?.position ?? "") < (b.parentIndex?.position ?? "") ? -1 : (a.parentIndex?.position ?? "") > (b.parentIndex?.position ?? "") ? 1 : 0));
  const page = pages[0];
  if (!page) return { first: [], rest: all };
  // The page's subtree, and the main components its instances use (wherever they are), recursively
  const seen = new Set<string>();
  const stack = [key(page.guid)];
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const c of children.get(k) ?? []) stack.push(c);
    const symbol = (byKey.get(k) as { symbolData?: { symbolID?: { sessionID?: number; localID?: number } } } | undefined)?.symbolData?.symbolID;
    if (symbol && byKey.has(key(symbol))) stack.push(key(symbol));
  }
  const tiers: string[] = [];
  const full: string[] = [];
  const paints = new Set(["Paint"]);
  for (const n of nodes) {
    if (!seen.has(key(n.guid))) continue;
    walkValue(MODEL, "NodeChange", n, paints, (_def, p: { image?: { hash?: Uint8Array }; imageThumbnail?: { hash?: Uint8Array } }) => {
      const t = p.imageThumbnail?.hash;
      if (t instanceof Uint8Array && t.length) tiers.push(toHex(t));
    });
    for (const h of messageImageHashes({ nodeChanges: [n] } as Message)) full.push(h);
  }
  const first = [...new Set([...tiers, ...full])];
  const inFirst = new Set(first);
  return { first, rest: all.filter((h) => !inFirst.has(h)) };
}

export class BlobDownloads {
  private jobs = new Map<string, Job>();
  private files = new Map<FileKey, FileDownload>();
  /** Queued hashes per priority, in order (stale entries skipped when taken) */
  private queues: string[][] = [[], [], []];
  private running = 0;
  private arrived = new Set<(sha1s: string[]) => void>();
  private idle: (() => void)[] = [];
  private closed = false;

  constructor(
    private src: BlobSource,
    private tracker: UploadTracker,
    private o: DownloadOptions = {},
  ) {}

  /** Images that arrived (an open editor draws them) */
  onArrived(listener: (sha1s: string[]) => void): Unsubscribe {
    this.arrived.add(listener);
    return () => this.arrived.delete(listener);
  }

  /**
   * A file's images not in the store yet, queued (`first`: the page it opens on; `rest`: after). Resolves once they
   * are queued — not downloaded — with those queued (empty: the file has every image already).
   */
  async add(input: { fileKey: FileKey; key: string; name: string; first?: readonly string[]; rest: readonly string[] }): Promise<string[]> {
    const order = [...new Set([...(input.first ?? []), ...input.rest])];
    if (!order.length || this.closed) return [];
    const have = await this.src.has(order);
    const missing = order.filter((_, i) => !have[i]);
    if (!missing.length) return [];
    const firstSet = new Set(input.first ?? []);
    let f = this.files.get(input.fileKey);
    if (!f) {
      const id = this.tracker.begin({ fileKey: input.fileKey, name: input.name, destination: "Downloading images", direction: "download" }, { retry: () => this.retry(input.fileKey), cancel: () => undefined });
      f = { fileKey: input.fileKey, name: input.name, id, left: new Set(), failed: new Set(), key: input.key, sizes: new Map(), landed: 0, count: 0 };
      this.files.set(input.fileKey, f);
    } else if (f.failed.size) {
      // Its row failed: going again (the session back, a resume)
      this.tracker.begin({ fileKey: input.fileKey, name: f.name, destination: "Downloading images", direction: "download" });
    }
    for (const sha1 of missing) {
      if (f.left.has(sha1)) continue;
      f.left.add(sha1);
      if (!f.failed.delete(sha1)) f.count++;
      this.queue(sha1, input.key, input.fileKey, firstSet.has(sha1) ? PAGE : REST);
    }
    this.total(f);
    this.progress(f);
    void this.fetchSizes(f, missing);
    this.pump();
    return missing;
  }

  /**
   * An image an editor needs now (on another page, an export): moved to the front of the queue. Resolves true once it
   * is in the store, false when it can't come; null at once when nothing here is fetching it.
   */
  want(sha1: string): Promise<boolean> | null {
    if (!this.jobs.has(sha1) && !this.closed) {
      // One that failed earlier: asked for again, it goes again at once
      const f = [...this.files.values()].find((x) => x.failed.has(sha1));
      if (f) {
        f.failed.delete(sha1);
        f.left.add(sha1);
        this.queue(sha1, f.key, f.fileKey, NOW);
        this.pump();
      }
    }
    const job = this.jobs.get(sha1);
    if (!job) return null;
    if (job.state === "queued" && job.prio !== NOW) {
      job.prio = NOW;
      this.queues[NOW].unshift(sha1);
    }
    return new Promise<boolean>((resolve) => job.waiters.push(resolve));
  }

  /** The images a file still waits for (its link keeps them for the next start) */
  pendingOf(fileKey: FileKey): string[] {
    const f = this.files.get(fileKey);
    return f ? [...f.left, ...f.failed] : [];
  }

  /** Queued or coming (tests, diagnostics) */
  get size(): number {
    return this.jobs.size;
  }

  /** Resolves when nothing is queued or coming (tests) */
  whenIdle(): Promise<void> {
    if (!this.jobs.size) return Promise.resolve();
    return new Promise((r) => this.idle.push(r));
  }

  /** A file's failed images queued again (the row's Retry) */
  retry(fileKey: FileKey): void {
    const f = this.files.get(fileKey);
    if (!f || !f.failed.size) return;
    this.tracker.begin({ fileKey, name: f.name, destination: "Downloading images", direction: "download" });
    for (const sha1 of f.failed) {
      f.left.add(sha1);
      this.queue(sha1, f.key, fileKey, REST);
    }
    f.failed.clear();
    this.total(f);
    this.progress(f);
    this.pump();
  }

  /** Nothing new starts (the store closing); those coming finish */
  close(): void {
    this.closed = true;
  }

  private queue(sha1: string, key: string, fileKey: FileKey, prio: number): void {
    const job = this.jobs.get(sha1);
    if (job) {
      job.files.add(fileKey);
      if (!job.keys.includes(key)) job.keys.push(key);
      if (job.state === "queued" && prio < job.prio) {
        job.prio = prio;
        this.queues[prio].push(sha1);
      }
      return;
    }
    this.jobs.set(sha1, { sha1, keys: [key], prio, files: new Set([fileKey]), state: "queued", received: 0, waiters: [] });
    this.queues[prio].push(sha1);
  }

  private take(): Job | null {
    for (let p = NOW; p <= REST; p++) {
      const q = this.queues[p];
      while (q.length) {
        const job = this.jobs.get(q.shift()!);
        if (job && job.state === "queued" && job.prio === p) return job;
      }
    }
    return null;
  }

  private pump(): void {
    while (!this.closed && this.running < (this.o.concurrency ?? DOWNLOAD_CONCURRENCY)) {
      const job = this.take();
      if (!job) break;
      job.state = "running";
      this.running++;
      for (const fk of job.files) this.markGoing(fk);
      void this.run(job).finally(() => {
        this.running--;
        this.pump();
        if (!this.jobs.size && !this.running) for (const r of this.idle.splice(0)) r();
      });
    }
  }

  private markGoing(fileKey: FileKey): void {
    const f = this.files.get(fileKey);
    if (f) this.progress(f);
  }

  private async run(job: Job): Promise<void> {
    const delays = this.o.retryDelays ?? DOWNLOAD_RETRY_DELAYS;
    let outcome: "done" | "skipped" | "failed" = "failed";
    let size = 0;
    let lastError: unknown = null;
    keys: for (const key of [...job.keys]) {
      for (let attempt = 0; ; attempt++) {
        try {
          const bytes = await this.src.get(
            key,
            job.sha1,
            (n) => {
              job.received = n;
              for (const fk of job.files) {
                const f = this.files.get(fk);
                if (f) this.progress(f);
              }
            },
            (n) => {
              for (const fk of job.files) {
                const f = this.files.get(fk);
                if (f && !f.sizes.has(job.sha1)) {
                  f.sizes.set(job.sha1, n);
                  this.total(f);
                }
              }
            },
          );
          await this.src.put(bytes);
          size = bytes.length;
          outcome = "done";
          break keys;
        } catch (e) {
          lastError = e;
          if (e instanceof StoreError && e.code === "not-found") {
            outcome = "skipped";
            continue keys; // another file's room may have it
          }
          if (!isTransient(e) || attempt >= delays.length) {
            outcome = "failed";
            break keys;
          }
          for (const fk of job.files) {
            const f = this.files.get(fk);
            if (f) this.tracker.retrying(f.id, attempt + 2);
          }
          await this.src.sleep(delays[attempt]);
        }
      }
    }
    this.jobs.delete(job.sha1);
    if (outcome === "skipped") this.src.log("warn", `multiplayer: image ${job.sha1} isn't in the room`, lastError);
    if (outcome === "failed") this.src.log("warn", `multiplayer: image ${job.sha1} didn't download`, lastError);
    for (const w of job.waiters.splice(0)) w(outcome === "done");
    if (outcome === "done") this.say([job.sha1]);
    for (const fk of job.files) {
      const f = this.files.get(fk);
      if (!f) continue;
      f.left.delete(job.sha1);
      if (outcome === "failed") f.failed.add(job.sha1);
      else {
        // An image the room hasn't counts as come: the layer keeps its placeholder
        const s = outcome === "done" ? size : (f.sizes.get(job.sha1) ?? 0);
        f.landed += s;
        if (outcome === "done") f.sizes.set(job.sha1, size);
      }
      this.finishMaybe(f, lastError);
    }
  }

  private finishMaybe(f: FileDownload, lastError: unknown): void {
    if (f.left.size) return this.progress(f);
    if (f.failed.size) {
      const n = f.failed.size;
      const offline = lastError instanceof StoreError && lastError.code === "offline";
      this.tracker.failed(f.id, offline ? `${n === 1 ? "1 image" : `${n} images`} couldn’t download. Check your connection.` : `${n === 1 ? "1 image" : `${n} images`} couldn’t download.`);
      return;
    }
    this.total(f);
    this.tracker.done(f.id);
    this.files.delete(f.fileKey);
    this.o.onFileDone?.(f.fileKey);
  }

  /** The file's bytes in all: the sizes known, and for the rest the average of those (an estimate until known) */
  private total(f: FileDownload): void {
    const known = [...f.sizes.values()];
    const sum = known.reduce((a, b) => a + b, 0);
    const unknown = Math.max(0, f.count - known.length);
    const avg = known.length ? sum / known.length : 0;
    this.tracker.setTotal(f.id, Math.round(sum + unknown * avg));
  }

  private progress(f: FileDownload): void {
    let coming = 0;
    for (const sha1 of f.left) {
      const job = this.jobs.get(sha1);
      if (job?.state === "running") coming += job.received;
    }
    if (f.landed + coming > 0 || [...f.left].some((s) => this.jobs.get(s)?.state === "running")) this.tracker.progress(f.id, f.landed + coming);
  }

  private async fetchSizes(f: FileDownload, sha1s: string[]): Promise<void> {
    if (!this.src.sizes) return;
    try {
      for (let i = 0; i < sha1s.length; i += SIZES_BATCH) {
        const sizes = await this.src.sizes(f.key, sha1s.slice(i, i + SIZES_BATCH));
        // The server knows them all at once (an answer says only its own): its sizes stand for those not landed yet
        for (const [sha1, n] of Object.entries(sizes)) if (typeof n === "number" && n >= 0 && f.left.has(sha1)) f.sizes.set(sha1, n);
      }
      if (this.files.get(f.fileKey) === f) this.total(f);
    } catch {
      // An older server: the total is estimated as the images come
    }
  }

  private say(sha1s: string[]): void {
    for (const l of [...this.arrived]) {
      try {
        l(sha1s);
      } catch {
        /* a listener's trouble isn't the download's */
      }
    }
  }
}
