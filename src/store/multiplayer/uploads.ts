/**
 * The store's uploads as the upload panel shows them (docs/multiplayer.md §5.1): one entry per file going up — a share,
 * a move into an org folder, a new org file, a branch — with its bytes sent of its total and its state. Progress is
 * counted as the request bodies are read (`countingBody`) and said at most every UPLOAD_EVENT_MS; a change of state is
 * said at once. Imports nothing from Node or the DOM (both stores run it).
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

  /** The upload of this file still going or failed (a resumed one continues its entry) */
  of(fileKey: FileKey): string | null {
    for (const [id, e] of this.items) if (e.p.fileKey === fileKey && e.p.state !== "done") return id;
    return null;
  }

  get inFlight(): number {
    let n = 0;
    for (const e of this.items.values()) if (uploadInFlight(e.p)) n++;
    return n;
  }

  /** A file starts going up (queued); a file with an entry not done yet continues it from 0 */
  begin(input: { fileKey: FileKey; name: string; destination?: string }, controls: UploadControls | null = null): string {
    const existing = this.of(input.fileKey);
    if (existing) {
      const e = this.items.get(existing)!;
      e.p = { ...e.p, name: input.name || e.p.name, destination: input.destination || e.p.destination, bytesSent: 0, state: "queued" };
      delete e.p.error;
      delete e.p.attempt;
      delete e.p.endedAt;
      if (controls) {
        e.controls = controls;
        e.p.retryable = !!controls.retry;
      }
      this.flush(e);
      return existing;
    }
    const id = `up_${this.clock.now().toString(36)}_${(++this.n).toString(36)}`;
    const e: Entry = { p: { id, fileKey: input.fileKey, name: input.name, destination: input.destination ?? "", bytesSent: 0, bytesTotal: 0, state: "queued", startedAt: this.clock.now(), retryable: !!controls?.retry }, controls, lastEmit: 0, timer: null };
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
    if (moved) return this.flush(e);
    this.throttled(e);
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
    this.flush(e);
  }

  failed(id: string, message: string): void {
    const e = this.items.get(id);
    if (!e) return;
    e.p = { ...e.p, state: "failed", error: message, endedAt: this.clock.now() };
    delete e.p.attempt;
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
