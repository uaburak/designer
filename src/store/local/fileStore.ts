/**
 * Per-file storage (docs/data.md §5–§6): one actor per file directory, with a serial queue.
 *
 *   files/<key>/store.json              FileStoreState (local only; rarely written, never per append)
 *   files/<key>/snapshot-<seq>.kiwi     head snapshot (+ the previous generation until the next compaction)
 *   files/<key>/journal-<baseSeq>.log   journal segments; at most one is open for appends
 *   files/<key>/versions/               index.json + <VersionId>.kiwi (hard links of snapshots)
 *   files/<key>/thumbnail.png, ui.json
 *
 * Appends are acknowledged after `write()`, fdatasync'ed at most 1 s later (immediately on flush). Open recovers from
 * a torn tail (truncate at the last good frame), a damaged head snapshot (the previous generation) and worse (the
 * newest version), and never writes over data it could not read.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { codec, DOCUMENT_FORMAT_VERSION, SCHEMA_BINARY, SCHEMA_SHA1 } from "../../shared/schema/document.generated";
import { RESERVED_SESSION_LIMIT, sessionIdFor, splitSessionId } from "../../shared/schema/guid";
import { messageImageHashes, NodeTable } from "../../shared/schema/patch";
import { restoreDiff } from "../../shared/store/assetIdentity";
import { StoreError } from "../../shared/store/protocol";
import type { FileChange, OpenedFile } from "../../shared/store/repositories";
import { isSha1, MAX_BATCH_BYTES, type AppendAck, type ChangeBatch, type FileKey, type FileUiState, type VersionId, type VersionRecord } from "../../shared/store/types";
import type { Compactor } from "../compactor";
import { nodeCodecs, own } from "../kiwi/codecs";
import { decodeWithSchema } from "../kiwi/schemas";
import { pngSize } from "./blobs";
import { Emitter } from "./emitter";
import { atomicWrite, ensureDir, exists, fileSize, linkOrCopy, readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { newVersionId, type Clock, type HlcClock } from "./ids";
import { encodeFrame, scanSegment, segmentName, SegmentWriter, snapshotName, type Frame, type SegmentHeader } from "./journal";
import { SerialQueue } from "./queue";
import { currentMessage, currentMessageBytes, encodeSnapshot, readSnapshotFile, type ReadSnapshot, type SchemaRegistry } from "./snapshot";
import { CHECKPOINT_INTERVAL_MS, CHECKPOINT_MAX_WAIT_MS, CHECKPOINT_QUIET_MS, thinVersions } from "./versions";
import type { LocalWorkspace, Log, WorkspaceDirs } from "./workspace";

// ---------------------------------------------------------------------------------------------------------------------
// store.json
// ---------------------------------------------------------------------------------------------------------------------

export interface Generation {
  snapshot: string;
  snapshotSeq: number;
  segments: string[];
}

export interface FileStoreState {
  formatVersion: 1;
  documentFormatVersion: number;
  head: Generation & { previous: Generation | null };
  /** sessionID = (deviceOrdinal << 20) | nextLocal++ on every edit-mode open; lastBatchSeq pruned to 64 sessions */
  sessions: { nextLocal: number; lastBatchSeq: Record<string, number> };
  checkpoint: { lastAt: number | null; editedSince: boolean };
  thumbnail: { seq: number | null };
  /** Images referenced by the head snapshot ∪ journal (exact at each compaction, a superset in between) */
  blobRefs: string[];
  sync: { pushedSeq: number; pullCursor: string | null } | null;
}

function newState(snapshot: string, blobRefs: string[]): FileStoreState {
  return {
    formatVersion: 1,
    documentFormatVersion: DOCUMENT_FORMAT_VERSION,
    head: { snapshot, snapshotSeq: 0, segments: [], previous: null },
    sessions: { nextLocal: 1, lastBatchSeq: {} },
    checkpoint: { lastAt: null, editedSince: false },
    thumbnail: { seq: null },
    blobRefs,
    sync: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Thresholds (docs/data.md §5.4–5.5)
// ---------------------------------------------------------------------------------------------------------------------

export const SYNC_INTERVAL_MS = 1000;
export const UPDATED_AT_DEBOUNCE_MS = 5000;
export const COMPACT_SEGMENT_BYTES = 8 * 1024 * 1024;
export const COMPACT_SEGMENT_FRAMES = 5000;
export const COMPACT_ON_CLOSE_BYTES = 512 * 1024;
export const COMPACT_ON_OPEN_BYTES = 8 * 1024 * 1024;
export const COMPACT_MIN_INTERVAL_MS = 60_000;
const MAX_REMEMBERED_SESSIONS = 64;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Who holds an edit session: the RPC connection (opaque here). */
export type SessionOwner = object;

interface FrameRef {
  seq: number;
  segment: string;
  offset: number;
  size: number;
}

interface Head {
  state: FileStoreState;
  lastSeq: number;
  writer: SegmentWriter | null;
  /** Frames after the head snapshot (and after previous.snapshotSeq while the previous generation is kept) */
  frames: FrameRef[];
  journalBytes: number;
  journalFrames: number;
  acks: Map<string, AppendAck>;
  lastAckOf: Map<number, AppendAck>;
  lastBatchSeq: Map<number, number>;
  /** Schema of each head segment, by name */
  segmentSchemas: Map<string, string>;
  recovery: OpenedFile["recovery"];
  /** Blob refs added since the last compaction started */
  pendingRefs: Set<string>;
  stateDirty: boolean;
}

class FileActor {
  readonly queue = new SerialQueue();
  head: Head | null = null;
  readonly sessions = new Map<number, { owner: SessionOwner; tabId?: string }>();
  compacting: Promise<boolean> | null = null;
  lastCompactionAt = 0;
  syncTimer: unknown = null;
  updatedAtTimer: unknown = null;
  checkpointTimer: unknown = null;
  checkpointDueSince = 0;
  sizeBytes: number | null = null;
  constructor(
    readonly key: FileKey,
    readonly dir: string,
  ) {}
}

export interface FileStoreDeps {
  dirs: WorkspaceDirs;
  workspace: LocalWorkspace;
  schemas: SchemaRegistry;
  hlc: HlcClock;
  clock: Clock;
  deviceOrdinal: number;
  compactor: Compactor;
  log: Log;
  timers?: Timers;
}

export class FileStore {
  readonly changes = new Emitter<FileChange>();
  private readonly actors = new Map<FileKey, FileActor>();
  private readonly timers: Timers;
  private readonly background = new Set<Promise<unknown>>();
  private closing = false;

  constructor(private readonly d: FileStoreDeps) {
    this.timers = d.timers ?? realTimers;
  }

  /** Runs work off the caller's path (fsync tick, compaction, checkpoint), logging failures; `idle()` awaits it. */
  private track(what: string, p: Promise<unknown>): void {
    const tracked = p.catch((e) => this.d.log("error", what, e)).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  /** Resolves when no background work is left and every file's queue is empty (tests, shutdown). */
  async idle(): Promise<void> {
    for (let round = 0; round < 100; round++) {
      await Promise.all([...this.background]);
      await Promise.all([...this.actors.values()].map((a) => Promise.all([a.queue.idle(), a.compacting?.catch(() => false)])));
      if (!this.background.size && [...this.actors.values()].every((a) => !a.queue.busy && !a.compacting)) return;
    }
  }

  private actor(fileKey: FileKey): FileActor {
    let a = this.actors.get(fileKey);
    if (!a) {
      a = new FileActor(fileKey, join(this.d.dirs.files, fileKey));
      this.actors.set(fileKey, a);
    }
    return a;
  }

  private path(a: FileActor, name: string): string {
    return join(a.dir, name);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------------------------------------------------

  /** Writes a new file directory: the snapshot at seq 0 (a raw Message in the current schema) and store.json. */
  async createFile(fileKey: FileKey, message: Uint8Array, blobRefs?: string[]): Promise<void> {
    const dir = join(this.d.dirs.files, fileKey);
    await ensureDir(join(dir, "versions"));
    const name = snapshotName(0);
    await atomicWrite(this.d.dirs.tmp, join(dir, name), encodeSnapshot(message));
    const refs = blobRefs ?? [...messageImageHashes(codec.decodeMessage(message))];
    await writeJsonAtomic(this.d.dirs.tmp, join(dir, "store.json"), newState(name, refs.sort()));
  }

  /** A new file from an existing snapshot file (duplicate, duplicate version): linked or copied as its seq-0 snapshot. */
  async createFileFromSnapshot(fileKey: FileKey, snapshotPath: string, blobRefs: string[]): Promise<void> {
    const dir = join(this.d.dirs.files, fileKey);
    await ensureDir(join(dir, "versions"));
    const name = snapshotName(0);
    await linkOrCopy(snapshotPath, join(dir, name));
    await writeJsonAtomic(this.d.dirs.tmp, join(dir, "store.json"), newState(name, [...blobRefs].sort()));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Loading and recovery (§5.6)
  // -------------------------------------------------------------------------------------------------------------------

  private async readState(a: FileActor): Promise<FileStoreState> {
    const s = await readJsonOrNull<FileStoreState>(this.path(a, "store.json"));
    if (s?.head?.snapshot) return s;
    // store.json is gone or damaged: rebuild it from the directory (newest snapshot, the segments after it).
    const names = await fsp.readdir(a.dir).catch(() => [] as string[]);
    const snaps = names.filter((n) => /^snapshot-\d{12}\.kiwi$/.test(n)).sort();
    if (!snaps.length) throw new StoreError("corrupt", `file ${a.key} has no snapshot`);
    const snap = snaps[snaps.length - 1];
    const seq = Number(snap.slice(9, 21));
    const segments = names.filter((n) => /^journal-\d{12}\.log$/.test(n) && Number(n.slice(8, 20)) > seq).sort();
    this.d.log("warn", `rebuilt store.json of ${a.key} from its directory`);
    const st = newState(snap, []);
    st.head.snapshotSeq = seq;
    st.head.segments = segments;
    st.sessions.nextLocal = 1 + (await this.maxSessionCounter(a, segments));
    return st;
  }

  private async maxSessionCounter(a: FileActor, segments: string[]): Promise<number> {
    let max = 0;
    for (const s of segments) {
      try {
        const scan = scanSegment(new Uint8Array(await fsp.readFile(this.path(a, s))), nodeCodecs.inflateRaw);
        for (const f of scan.frames) if (splitSessionId(f.sessionID).deviceOrdinal === this.d.deviceOrdinal) max = Math.max(max, splitSessionId(f.sessionID).n);
      } catch {
        /* unreadable: ignored */
      }
    }
    return max;
  }

  private async saveState(a: FileActor, h: Head): Promise<void> {
    // Remember the newest 64 sessions' last batchSeq (Map order = least recently used first).
    const entries = [...h.lastBatchSeq.entries()].slice(-MAX_REMEMBERED_SESSIONS);
    h.state.sessions.lastBatchSeq = Object.fromEntries(entries.map(([k, v]) => [String(k), v]));
    h.state.blobRefs = [...new Set([...h.state.blobRefs, ...h.pendingRefs])].sort();
    await writeJsonAtomic(this.d.dirs.tmp, this.path(a, "store.json"), h.state);
    h.stateDirty = false;
  }

  private async readSegment(a: FileActor, name: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fsp.readFile(this.path(a, name)));
    } catch {
      return null;
    }
  }

  /** Loads the head once per actor: snapshot check, journal scan, truncation of a torn tail, fallbacks. */
  private async loaded(a: FileActor): Promise<Head> {
    if (a.head) return a.head;
    if (!(await exists(a.dir))) throw new StoreError("not-found", `no file ${a.key}`);
    const state = await this.readState(a);
    const rec: { truncatedBytes: number; droppedFrames: number; fellBackTo: "previous-snapshot" | "version" | null } = { truncatedBytes: 0, droppedFrames: 0, fellBackTo: null };
    const fall = (to: "previous-snapshot" | "version") => {
      rec.fellBackTo = to;
    };

    // 1. A snapshot that decodes: the head, else the previous generation (+ its segments), else the newest version.
    let gen: Generation = { snapshot: state.head.snapshot, snapshotSeq: state.head.snapshotSeq, segments: [...state.head.segments] };
    let snapOk = await this.snapshotReadable(this.path(a, gen.snapshot));
    if (!snapOk && state.head.previous) {
      const p = state.head.previous;
      if (await this.snapshotReadable(this.path(a, p.snapshot))) {
        this.d.log("warn", `${a.key}: head snapshot ${gen.snapshot} is damaged; recovering from ${p.snapshot}`);
        await this.setAside(a, gen.snapshot, "damaged");
        gen = { snapshot: p.snapshot, snapshotSeq: p.snapshotSeq, segments: [...p.segments, ...state.head.segments] };
        state.head.previous = null;
        snapOk = true;
        fall("previous-snapshot");
      }
    }
    if (!snapOk) {
      const versions = await this.readVersionIndex(a);
      for (const v of versions) {
        const vp = join(a.dir, "versions", `${v.id}.kiwi`);
        if (!(await this.snapshotReadable(vp))) continue;
        // Keep seqs unique: the restored snapshot takes the highest seq ever written.
        const top = Math.max(v.seq, await this.highestSeq(a, [...state.head.segments, ...(state.head.previous?.segments ?? [])]));
        const name = snapshotName(top);
        this.d.log("error", `${a.key}: no readable snapshot; recovering from version ${v.id} (${new Date(v.createdAt).toISOString()})`);
        for (const s of [state.head.snapshot, ...state.head.segments, ...(state.head.previous ? [state.head.previous.snapshot, ...state.head.previous.segments] : [])]) await this.setAside(a, s, "damaged");
        await linkOrCopy(vp, this.path(a, name));
        gen = { snapshot: name, snapshotSeq: top, segments: [] };
        state.head.previous = null;
        snapOk = true;
        fall("version");
        break;
      }
    }
    if (!snapOk) throw new StoreError("corrupt", "This file couldn't be read");

    // 2. Adopt segments written but not yet listed (a crash between creating a segment and saving store.json).
    const listed = new Set(gen.segments);
    for (const n of (await fsp.readdir(a.dir)).filter((n) => /^journal-\d{12}\.log$/.test(n)).sort()) {
      if (listed.has(n) || Number(n.slice(8, 20)) <= gen.snapshotSeq) continue;
      if (rec.fellBackTo === "version") continue;
      gen.segments.push(n);
      listed.add(n);
    }
    gen.segments.sort();

    // 3. Scan the segments in order; the first bad or short frame ends the readable journal.
    const h: Head = {
      state,
      lastSeq: gen.snapshotSeq,
      writer: null,
      frames: [],
      journalBytes: 0,
      journalFrames: 0,
      acks: new Map(),
      lastAckOf: new Map(),
      lastBatchSeq: new Map(Object.entries(state.sessions.lastBatchSeq ?? {}).map(([k, v]) => [Number(k), v])),
      segmentSchemas: new Map(),
      recovery: null,
      pendingRefs: new Set(),
      stateDirty: false,
    };
    const keep: string[] = [];
    let broken = false;
    let truncatedBytes = 0;
    let droppedFrames = 0;
    let lastScan: { name: string; goodLength: number; frames: number; header: SegmentHeader } | null = null;
    for (const name of gen.segments) {
      const bytes = await this.readSegment(a, name);
      if (broken || !bytes) {
        if (bytes) {
          try {
            droppedFrames += scanSegment(bytes, nodeCodecs.inflateRaw).frames.length;
          } catch {
            /* not even a header */
          }
          await this.setAside(a, name, "dropped");
        }
        broken = true;
        continue;
      }
      let scan;
      try {
        scan = scanSegment(bytes, nodeCodecs.inflateRaw, h.lastSeq + 1);
      } catch {
        // No readable header: nothing in it can be trusted.
        await this.setAside(a, name, "damaged");
        broken = true;
        truncatedBytes += bytes.length;
        continue;
      }
      for (const f of scan.frames) this.indexFrame(h, name, f);
      h.segmentSchemas.set(name, scan.header.schemaSha1);
      keep.push(name);
      h.journalBytes += scan.goodLength;
      h.journalFrames += scan.frames.length;
      lastScan = { name, goodLength: scan.goodLength, frames: scan.frames.length, header: scan.header };
      if (scan.badBytes) {
        if (scan.droppedFrames) await fsp.copyFile(this.path(a, name), this.path(a, `${name}.damaged-${this.d.clock.now()}`)).catch(() => {});
        truncatedBytes += scan.badBytes;
        droppedFrames += scan.droppedFrames;
        broken = true;
        // Truncate in place at the last good frame (the readable prefix stays where it is).
        const fh = await fsp.open(this.path(a, name), "r+");
        try {
          await fh.truncate(scan.goodLength);
          await fh.datasync();
        } finally {
          await fh.close();
        }
      }
    }
    if (truncatedBytes || droppedFrames) {
      rec.truncatedBytes = truncatedBytes;
      rec.droppedFrames = droppedFrames;
      this.d.log("warn", `${a.key}: recovered the journal (truncated ${truncatedBytes} bytes, dropped ${droppedFrames} frames)`);
    }
    const recovery: OpenedFile["recovery"] = rec.truncatedBytes || rec.droppedFrames || rec.fellBackTo ? { ...rec } : null;
    h.recovery = recovery;
    const segmentsChanged = keep.join() !== state.head.segments.join();
    state.head.snapshot = gen.snapshot;
    state.head.snapshotSeq = gen.snapshotSeq;
    state.head.segments = keep;
    // The last segment stays open for appends if it was written with the current schema.
    if (lastScan && lastScan.header.schemaSha1 === SCHEMA_SHA1 && keep[keep.length - 1] === lastScan.name) {
      h.writer = SegmentWriter.reopen(this.path(a, lastScan.name), lastScan.header, lastScan.goodLength, lastScan.frames);
    }
    if (state.sessions.nextLocal < 1) state.sessions.nextLocal = 1;
    a.head = h;
    if (recovery || segmentsChanged) await this.saveState(a, h);
    return h;
  }

  private indexFrame(h: Head, segment: string, f: Pick<Frame, "seq" | "sessionID" | "batchSeq" | "hlc" | "offset" | "size">): void {
    h.frames.push({ seq: f.seq, segment, offset: f.offset, size: f.size });
    h.lastSeq = f.seq;
    const ack = { seq: f.seq, hlc: f.hlc };
    h.acks.set(`${f.sessionID}:${f.batchSeq}`, ack);
    h.lastAckOf.set(f.sessionID, ack);
    if ((h.lastBatchSeq.get(f.sessionID) ?? 0) < f.batchSeq) {
      h.lastBatchSeq.delete(f.sessionID);
      h.lastBatchSeq.set(f.sessionID, f.batchSeq);
    }
  }

  private async snapshotReadable(path: string): Promise<boolean> {
    try {
      const s = await readSnapshotFile(path);
      // Data written with another schema must convert; a decode failure means damage.
      if (!s.current) currentMessage(s);
      return true;
    } catch {
      return false;
    }
  }

  private async highestSeq(a: FileActor, segments: string[]): Promise<number> {
    let max = 0;
    for (const s of segments) {
      const n = Number(/^journal-(\d{12})\.log$/.exec(s)?.[1] ?? 0);
      max = Math.max(max, n);
      const bytes = await this.readSegment(a, s);
      if (!bytes) continue;
      try {
        const scan = scanSegment(bytes, nodeCodecs.inflateRaw);
        if (scan.frames.length) max = Math.max(max, scan.frames[scan.frames.length - 1].seq);
      } catch {
        /* skip */
      }
    }
    return max;
  }

  /** Renames a file out of the way (never deletes what could not be read). */
  private async setAside(a: FileActor, name: string, why: "damaged" | "dropped"): Promise<void> {
    const from = this.path(a, name);
    if (!(await exists(from))) return;
    await fsp.rename(from, this.path(a, `${name}.${why}-${this.d.clock.now()}`)).catch(() => {});
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------------------------------------------------

  async open(fileKey: FileKey, opts: { mode: "edit" | "view"; tabId?: string }, owner: SessionOwner): Promise<OpenedFile> {
    if (this.closing) throw new StoreError("shutting-down", "The store is shutting down");
    const meta = this.d.workspace.getMeta(fileKey);
    if (opts.mode === "edit" && this.d.workspace.isFileTrashed(meta)) throw new StoreError("trashed", "This file is in Trash");
    const a = this.actor(fileKey);
    let h: Head;
    try {
      h = await a.queue.run(() => this.loaded(a));
    } catch (e) {
      if (opts.mode === "view" && e instanceof StoreError && e.code === "corrupt") return this.openNewestReadableVersion(a);
      throw e;
    }
    if (h.journalBytes > COMPACT_ON_OPEN_BYTES) await this.compactNow(a, true).catch((e) => this.d.log("error", `${fileKey}: compaction on open failed`, e));
    return a.queue.run(async () => {
      let sessionID = 0;
      if (opts.mode === "edit") {
        const live = [...a.sessions.values()][0];
        if (live) throw new StoreError("already-open", "This file is already open for editing", { tabId: live.tabId ?? null });
        const n = h.state.sessions.nextLocal;
        if (n >= RESERVED_SESSION_LIMIT) throw new StoreError("io", "This file has run out of session ids");
        sessionID = sessionIdFor(this.d.deviceOrdinal, n);
        h.state.sessions.nextLocal = n + 1;
        await this.saveState(a, h); // persisted before replying (§5.6 step 5)
        a.sessions.set(sessionID, { owner, tabId: opts.tabId });
      }
      return this.openedFile(a, h, opts.mode, sessionID);
    });
  }

  private async openedFile(a: FileActor, h: Head, mode: "edit" | "view", sessionID: number): Promise<OpenedFile> {
    const snap = await readSnapshotFile(this.path(a, h.state.head.snapshot));
    const journal: OpenedFile["journal"] = [];
    for (const f of await this.readFrames(a, h, h.state.head.snapshotSeq)) journal.push({ seq: f.seq, kind: f.kind, message: f.message });
    const ui = await readJsonOrNull<FileUiState>(this.path(a, "ui.json"));
    return {
      meta: { ...this.d.workspace.getMeta(a.key) },
      mode,
      sessionID,
      schema: own(SCHEMA_BINARY),
      snapshot: currentMessageBytes(snap),
      snapshotSeq: h.state.head.snapshotSeq,
      journal,
      headSeq: h.lastSeq,
      ui,
      recovery: h.recovery,
    };
  }

  private async openNewestReadableVersion(a: FileActor): Promise<OpenedFile> {
    for (const v of await this.readVersionIndex(a)) {
      try {
        const opened = await this.openVersionFile(a, v);
        return { ...opened, recovery: { truncatedBytes: 0, droppedFrames: 0, fellBackTo: "version" } };
      } catch {
        /* try older */
      }
    }
    throw new StoreError("corrupt", "This file couldn't be read");
  }

  /** Frames with seq > fromSeq, as current-schema messages (converted when a segment used another schema). */
  private async readFrames(a: FileActor, h: Head, fromSeq: number): Promise<Frame[]> {
    const out: Frame[] = [];
    const wanted = h.frames.filter((f) => f.seq > fromSeq);
    const bySegment = new Map<string, FrameRef[]>();
    for (const f of wanted) {
      let l = bySegment.get(f.segment);
      if (!l) bySegment.set(f.segment, (l = []));
      l.push(f);
    }
    for (const [segment, refs] of bySegment) {
      const bytes = await this.readSegment(a, segment);
      if (!bytes) throw new StoreError("io", `journal segment ${segment} is missing`);
      const scan = scanSegment(bytes, nodeCodecs.inflateRaw);
      const schemaSha1 = h.segmentSchemas.get(segment) ?? scan.header.schemaSha1;
      const foreign = schemaSha1 === SCHEMA_SHA1 ? null : await this.d.schemas.get(schemaSha1);
      const want = new Set(refs.map((r) => r.seq));
      for (const f of scan.frames) {
        if (!want.has(f.seq)) continue;
        out.push({ ...f, message: foreign ? codec.encodeMessage(decodeWithSchema(foreign, f.message).message) : own(f.message) });
      }
    }
    return out.sort((x, y) => x.seq - y.seq);
  }

  async reattach(fileKey: FileKey, sessionID: number, lastAckedBatchSeq: number, owner: SessionOwner): Promise<{ headSeq: number }> {
    if (this.closing) throw new StoreError("shutting-down", "The store is shutting down");
    const a = this.actor(fileKey);
    return a.queue.run(async () => {
      const h = await this.loaded(a);
      const { deviceOrdinal, n } = splitSessionId(sessionID);
      if (deviceOrdinal !== this.d.deviceOrdinal || n < 1 || n >= h.state.sessions.nextLocal) throw new StoreError("invalid", `session ${sessionID} was never opened for this file`);
      const live = [...a.sessions.entries()].find(([sid]) => sid !== sessionID);
      if (live) throw new StoreError("already-open", "This file is already open for editing", { tabId: live[1].tabId ?? null });
      const prev = a.sessions.get(sessionID);
      a.sessions.set(sessionID, { owner, tabId: prev?.tabId });
      if ((h.lastBatchSeq.get(sessionID) ?? 0) < lastAckedBatchSeq) this.d.log("warn", `${fileKey}: session ${sessionID} acked batch ${lastAckedBatchSeq} the journal lacks`);
      return { headSeq: h.lastSeq };
    });
  }

  /** Appends one batch (§5.4): dedupe, seq + HLC, one write, ack; fsync within 1 s; broadcast; triggers. */
  async append(fileKey: FileKey, batch: ChangeBatch, owner: SessionOwner): Promise<AppendAck> {
    if (this.closing) throw new StoreError("shutting-down", "The store is shutting down");
    if (!batch || !(batch.message instanceof Uint8Array)) throw new StoreError("invalid", "a batch needs a message");
    if (batch.message.length > MAX_BATCH_BYTES) throw new StoreError("too-large", "This change is too large to save");
    if (!Number.isInteger(batch.batchSeq) || batch.batchSeq < 1) throw new StoreError("invalid", `bad batchSeq ${batch.batchSeq}`);
    const a = this.actor(fileKey);
    return a.queue.run(async () => {
      const h = await this.loaded(a);
      const session = a.sessions.get(batch.sessionID);
      if (!session) throw new StoreError("read-only", "This file isn't open for editing in this session");
      if (session.owner !== owner) throw new StoreError("forbidden", "This session belongs to another view");
      const last = h.lastBatchSeq.get(batch.sessionID) ?? 0;
      if (batch.batchSeq <= last) {
        const ack = h.acks.get(`${batch.sessionID}:${batch.batchSeq}`) ?? h.lastAckOf.get(batch.sessionID);
        if (ack) return { ...ack };
      }
      const seq = h.lastSeq + 1;
      const hlc = this.d.hlc.now();
      if (!h.writer) await this.openSegment(a, h, seq);
      const frame = encodeFrame({ seq, sessionID: batch.sessionID, batchSeq: batch.batchSeq, wallClock: batch.wallClock ?? this.d.clock.now(), hlc, kind: batch.kind, label: batch.label ?? "" }, batch.message, nodeCodecs.deflateRaw);
      const offset = h.writer!.size;
      h.writer!.append(frame);
      const ack: AppendAck = { seq, hlc };
      h.frames.push({ seq, segment: segmentName(h.writer!.header.baseSeq), offset, size: frame.length });
      h.lastSeq = seq;
      h.journalBytes += frame.length;
      h.journalFrames++;
      h.acks.set(`${batch.sessionID}:${batch.batchSeq}`, ack);
      h.lastAckOf.set(batch.sessionID, ack);
      h.lastBatchSeq.delete(batch.sessionID);
      h.lastBatchSeq.set(batch.sessionID, batch.batchSeq);
      if (a.sizeBytes !== null) a.sizeBytes += frame.length;
      const refs = (batch.blobRefsAdded ?? []).filter(isSha1);
      if (refs.some((r) => !h.state.blobRefs.includes(r) && !h.pendingRefs.has(r))) {
        for (const r of refs) h.pendingRefs.add(r);
        h.stateDirty = true; // blob refs are persisted with the next fsync, so GC never misses them
      }
      if (!h.state.checkpoint.editedSince) {
        h.state.checkpoint.editedSince = true;
        h.state.checkpoint.lastAt ??= this.d.clock.now();
        h.stateDirty = true;
      }
      this.scheduleSync(a);
      this.changes.emit({ fileKey, seq, sessionID: batch.sessionID, kind: batch.kind, message: batch.message });
      this.bumpUpdatedAt(a);
      this.afterAppend(a, h);
      return ack;
    });
  }

  private async openSegment(a: FileActor, h: Head, baseSeq: number): Promise<void> {
    const name = segmentName(baseSeq);
    const header: SegmentHeader = { formatVersion: 1, documentFormatVersion: DOCUMENT_FORMAT_VERSION, schemaSha1: SCHEMA_SHA1, baseSeq, createdAt: this.d.clock.now() };
    const path = this.path(a, name);
    if (await exists(path)) {
      // A leftover from a crash right after creating it: keep it only if it holds frames (then it was adopted at load).
      const scan = scanSegment(new Uint8Array(await fsp.readFile(path)), nodeCodecs.inflateRaw);
      if (scan.frames.length) throw new StoreError("io", `segment ${name} already holds frames`);
      await fsp.rm(path, { force: true });
    }
    h.writer = SegmentWriter.create(path, header);
    h.segmentSchemas.set(name, SCHEMA_SHA1);
    h.journalBytes += h.writer.size;
    h.state.head.segments.push(name);
    // The segment must be listed before anything in it is acknowledged.
    await this.saveState(a, h);
  }

  private scheduleSync(a: FileActor): void {
    if (a.syncTimer) return;
    a.syncTimer = this.timers.setTimeout(() => {
      a.syncTimer = null;
      this.track(`${a.key}: fdatasync failed`, a.queue.run(() => this.syncNow(a)));
    }, SYNC_INTERVAL_MS);
  }

  private async syncNow(a: FileActor): Promise<void> {
    const h = a.head;
    if (!h) return;
    await h.writer?.sync();
    if (h.stateDirty) await this.saveState(a, h);
  }

  private bumpUpdatedAt(a: FileActor): void {
    if (a.updatedAtTimer) return;
    a.updatedAtTimer = this.timers.setTimeout(() => {
      a.updatedAtTimer = null;
      const ws = this.d.workspace;
      if (!ws.files.has(a.key)) return;
      this.track(`${a.key}: updatedAt`, ws.queue.run(() => ws.patchFile(a.key, { updatedAt: this.d.clock.now() })));
    }, UPDATED_AT_DEBOUNCE_MS);
  }

  private afterAppend(a: FileActor, h: Head): void {
    const w = h.writer;
    const now = this.d.clock.now();
    if (w && (w.size > COMPACT_SEGMENT_BYTES || w.frames > COMPACT_SEGMENT_FRAMES) && now - a.lastCompactionAt >= COMPACT_MIN_INTERVAL_MS) {
      this.track(`${a.key}: compaction failed`, this.compactNow(a, false));
    }
    const cp = h.state.checkpoint;
    if (cp.editedSince && cp.lastAt !== null && now - cp.lastAt >= CHECKPOINT_INTERVAL_MS) this.scheduleCheckpoint(a);
  }

  /** A due checkpoint runs after 2 s without appends, at most 60 s after it became due. */
  private scheduleCheckpoint(a: FileActor): void {
    const now = this.d.clock.now();
    if (!a.checkpointDueSince) a.checkpointDueSince = now;
    if (a.checkpointTimer) this.timers.clearTimeout(a.checkpointTimer);
    const wait = Math.max(0, Math.min(CHECKPOINT_QUIET_MS, a.checkpointDueSince + CHECKPOINT_MAX_WAIT_MS - now));
    a.checkpointTimer = this.timers.setTimeout(() => {
      a.checkpointTimer = null;
      a.checkpointDueSince = 0;
      this.track(`${a.key}: checkpoint failed`, this.checkpoint(a.key));
    }, wait);
  }

  async flush(fileKey: FileKey): Promise<void> {
    const a = this.actors.get(fileKey);
    if (!a) {
      this.d.workspace.getMeta(fileKey);
      return;
    }
    await a.queue.run(() => this.syncNow(a));
  }

  async close(fileKey: FileKey, sessionID: number): Promise<void> {
    const a = this.actors.get(fileKey);
    if (!a || !a.sessions.has(sessionID)) return;
    await a.queue.run(async () => {
      a.sessions.delete(sessionID);
      await this.syncNow(a);
      if (a.head?.stateDirty) await this.saveState(a, a.head);
    });
    const h = a.head;
    if (!a.sessions.size && h && h.journalBytes > COMPACT_ON_CLOSE_BYTES && this.d.clock.now() - a.lastCompactionAt >= COMPACT_MIN_INTERVAL_MS) {
      this.track(`${fileKey}: compaction on close failed`, this.compactNow(a, false));
    }
  }

  /** The port that held these sessions closed (tab closed or crashed). */
  async endSessionsOf(owner: SessionOwner): Promise<void> {
    for (const a of this.actors.values()) for (const [sid, s] of [...a.sessions]) if (s.owner === owner) await this.close(a.key, sid);
  }

  /** Who has the file open for editing (the tab to activate instead). */
  editSessions(fileKey: FileKey): { sessionID: number; tabId?: string }[] {
    return [...(this.actors.get(fileKey)?.sessions.entries() ?? [])].map(([sessionID, s]) => ({ sessionID, tabId: s.tabId }));
  }

  /** Frames after `fromSeq` for a subscriber catching up (as far back as the kept generations reach). */
  async backlog(fileKey: FileKey, fromSeq: number): Promise<FileChange[]> {
    const a = this.actor(fileKey);
    return a.queue.run(async () => {
      const h = await this.loaded(a);
      if (fromSeq >= h.lastSeq) return [];
      const frames = await this.readFrames(a, h, fromSeq);
      return frames.map((f) => ({ fileKey, seq: f.seq, sessionID: f.sessionID, kind: f.kind, message: f.message }));
    });
  }

  headSeq(fileKey: FileKey): number | null {
    return this.actors.get(fileKey)?.head?.lastSeq ?? null;
  }

  /** Frames after `seq` with their HLCs (the Replicator's push, docs/data.md §12.5). */
  async framesSince(fileKey: FileKey, seq: number): Promise<Frame[]> {
    const a = this.actor(fileKey);
    return a.queue.run(async () => this.readFrames(a, await this.loaded(a), seq));
  }

  /**
   * A frame the store writes itself (kind "remote": pulled from Firestore). No session: it is broadcast to the open
   * editor as `file.changes`, which applies it with APPLY_REMOTE (no undo entry).
   */
  async appendRemote(fileKey: FileKey, message: Uint8Array): Promise<AppendAck> {
    if (this.closing) throw new StoreError("shutting-down", "The store is shutting down");
    const a = this.actor(fileKey);
    return a.queue.run(async () => {
      const h = await this.loaded(a);
      const seq = h.lastSeq + 1;
      const hlc = this.d.hlc.now();
      if (!h.writer) await this.openSegment(a, h, seq);
      const frame = encodeFrame({ seq, sessionID: 0, batchSeq: 0, wallClock: this.d.clock.now(), hlc, kind: "remote", label: "" }, message, nodeCodecs.deflateRaw);
      const offset = h.writer!.size;
      h.writer!.append(frame);
      h.frames.push({ seq, segment: segmentName(h.writer!.header.baseSeq), offset, size: frame.length });
      h.lastSeq = seq;
      h.journalBytes += frame.length;
      h.journalFrames++;
      this.scheduleSync(a);
      this.changes.emit({ fileKey, seq, sessionID: 0, kind: "remote", message });
      return { seq, hlc };
    });
  }

  /** store.json's `sync` (pushedSeq, pullCursor). */
  async syncState(fileKey: FileKey): Promise<FileStoreState["sync"]> {
    const a = this.actor(fileKey);
    return a.queue.run(async () => (await this.loaded(a)).state.sync);
  }

  async setSyncState(fileKey: FileKey, sync: NonNullable<FileStoreState["sync"]>): Promise<void> {
    const a = this.actor(fileKey);
    await a.queue.run(async () => {
      const h = await this.loaded(a);
      h.state.sync = sync;
      await this.saveState(a, h);
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Compaction (§5.5)
  // -------------------------------------------------------------------------------------------------------------------

  /** Compacts now (force: even below the thresholds and the rate limit). True when a new snapshot was written. */
  async compact(fileKey: FileKey, opts: { force?: boolean } = {}): Promise<boolean> {
    return this.compactNow(this.actor(fileKey), opts.force ?? true);
  }

  private compactNow(a: FileActor, force: boolean): Promise<boolean> {
    if (a.compacting) return a.compacting;
    const run = async (): Promise<boolean> => {
      if (!force && this.d.clock.now() - a.lastCompactionAt < COMPACT_MIN_INTERVAL_MS) return false;
      // Phase 1 (in the queue): close the open segment so the worker reads a closed set; appends start a new one.
      const plan = await a.queue.run(async () => {
        const h = await this.loaded(a);
        if (h.lastSeq === h.state.head.snapshotSeq) return null;
        if (h.writer) {
          await h.writer.close();
          h.writer = null;
        }
        return { h, snapshot: h.state.head.snapshot, snapshotSeq: h.state.head.snapshotSeq, segments: [...h.state.head.segments], upTo: h.lastSeq, refsBefore: new Set(h.pendingRefs) };
      });
      if (!plan) return false;
      // Phase 2 (off the queue): merge in the worker.
      const out = await this.d.compactor.compact({
        snapshotPath: this.path(a, plan.snapshot),
        snapshotSeq: plan.snapshotSeq,
        segmentPaths: plan.segments.map((s) => this.path(a, s)),
        schemasDir: this.d.dirs.schemas,
        upTo: plan.upTo,
      });
      if (out.anomalies.missing || out.anomalies.invalidClears || out.anomalies.badBlobRefs) this.d.log("warn", `${a.key}: compaction merged with anomalies`, out.anomalies);
      // Phase 3 (in the queue): write the snapshot, then store.json, then drop the generation before `previous`.
      await a.queue.run(async () => {
        const h = plan.h;
        if (a.head !== h) return; // the actor was reset meanwhile (deleted)
        const name = snapshotName(plan.upTo);
        await atomicWrite(this.d.dirs.tmp, this.path(a, name), new Uint8Array(out.snapshot));
        const old = h.state.head;
        const remaining = old.segments.filter((s) => !plan.segments.includes(s));
        const stale = old.previous ? [old.previous.snapshot, ...old.previous.segments] : [];
        h.state.head = { snapshot: name, snapshotSeq: plan.upTo, segments: remaining, previous: { snapshot: old.snapshot, snapshotSeq: old.snapshotSeq, segments: plan.segments } };
        const added = [...h.pendingRefs].filter((r) => !plan.refsBefore.has(r));
        h.state.blobRefs = [...new Set([...out.blobRefs, ...added])].sort();
        h.pendingRefs = new Set(added);
        await this.saveState(a, h);
        const live = new Set([name, ...remaining, old.snapshot, ...plan.segments]);
        for (const f of stale) if (!live.has(f)) await fsp.rm(this.path(a, f), { force: true });
        // Only frames after the previous snapshot stay reachable for subscribers.
        h.frames = h.frames.filter((f) => f.seq > old.snapshotSeq);
        h.journalBytes = 0;
        h.journalFrames = 0;
        for (const s of remaining) h.journalBytes += await fileSize(this.path(a, s));
        h.journalFrames = h.frames.filter((f) => f.seq > plan.upTo).length;
        a.lastCompactionAt = this.d.clock.now();
        a.sizeBytes = null;
      });
      return true;
    };
    a.compacting = run().finally(() => {
      a.compacting = null;
    });
    return a.compacting;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Versions (§6)
  // -------------------------------------------------------------------------------------------------------------------

  private versionsDir(a: FileActor): string {
    return join(a.dir, "versions");
  }

  private async readVersionIndex(a: FileActor): Promise<VersionRecord[]> {
    return (await readJsonOrNull<VersionRecord[]>(join(this.versionsDir(a), "index.json"))) ?? [];
  }

  private async writeVersionIndex(a: FileActor, records: VersionRecord[]): Promise<void> {
    await ensureDir(this.versionsDir(a));
    await writeJsonAtomic(this.d.dirs.tmp, join(this.versionsDir(a), "index.json"), records);
  }

  async listVersions(fileKey: FileKey): Promise<VersionRecord[]> {
    this.d.workspace.getMeta(fileKey);
    return this.readVersionIndex(this.actor(fileKey));
  }

  /**
   * Records the head as a version: compacts (so a snapshot exists at the head seq), then hard-links that snapshot
   * into versions/<id>.kiwi. Snapshots are immutable, so the version survives later compactions for free.
   */
  async addVersion(fileKey: FileKey, input: Omit<VersionRecord, "id" | "createdAt" | "seq" | "sizeBytes" | "blobRefs">): Promise<VersionRecord> {
    const a = this.actor(fileKey);
    await this.compactNow(a, true);
    return a.queue.run(async () => {
      const h = await this.loaded(a);
      if (h.lastSeq !== h.state.head.snapshotSeq) {
        // Appends arrived after the compaction: the version is the snapshot's point, which is still a real state.
        this.d.log("debug", `${fileKey}: version at seq ${h.state.head.snapshotSeq}, head is at ${h.lastSeq}`);
      }
      const id: VersionId = newVersionId();
      const src = this.path(a, h.state.head.snapshot);
      await ensureDir(this.versionsDir(a));
      await linkOrCopy(src, join(this.versionsDir(a), `${id}.kiwi`));
      const rec: VersionRecord = {
        ...input,
        id,
        createdAt: this.d.clock.now(),
        seq: h.state.head.snapshotSeq,
        sizeBytes: await fileSize(src),
        blobRefs: [...h.state.blobRefs],
      };
      const records = [rec, ...(await this.readVersionIndex(a))];
      await this.writeVersionIndex(a, await this.thin(a, records));
      return rec;
    });
  }

  private async thin(a: FileActor, records: VersionRecord[]): Promise<VersionRecord[]> {
    const { keep, drop } = thinVersions(records, this.d.clock.now());
    for (const r of drop) await fsp.rm(join(this.versionsDir(a), `${r.id}.kiwi`), { force: true });
    return keep;
  }

  /** Thins every file's versions (at store start). */
  async thinAll(fileKeys: FileKey[]): Promise<void> {
    for (const k of fileKeys) {
      const a = this.actor(k);
      await a.queue.run(async () => {
        const records = await this.readVersionIndex(a);
        if (!records.length) return;
        const kept = await this.thin(a, records);
        if (kept.length !== records.length) await this.writeVersionIndex(a, kept);
      });
    }
  }

  /** The autosave checkpoint (§6). */
  async checkpoint(fileKey: FileKey): Promise<VersionRecord | null> {
    const a = this.actor(fileKey);
    const h = await a.queue.run(() => this.loaded(a));
    if (!h.state.checkpoint.editedSince) return null;
    const rec = await this.addVersion(fileKey, { kind: "autosave", title: null, description: null, restoredFrom: null, libraryVersion: null });
    await a.queue.run(async () => {
      h.state.checkpoint = { lastAt: this.d.clock.now(), editedSince: h.lastSeq > rec.seq };
      await this.saveState(a, h);
    });
    return rec;
  }

  async updateVersion(fileKey: FileKey, id: VersionId, patch: { title?: string; description?: string }): Promise<VersionRecord> {
    const a = this.actor(fileKey);
    return a.queue.run(async () => {
      const records = await this.readVersionIndex(a);
      const i = records.findIndex((r) => r.id === id);
      if (i < 0) throw new StoreError("not-found", `no version ${id}`);
      const r = { ...records[i] };
      if (patch.title !== undefined) r.title = patch.title.trim() || null;
      if (patch.description !== undefined) r.description = patch.description.trim() || null;
      // "Name this version": a named autosave is kept forever.
      if (r.kind === "autosave" && r.title) r.kind = "named";
      records[i] = r;
      await this.writeVersionIndex(a, records);
      return r;
    });
  }

  async getVersion(fileKey: FileKey, id: VersionId): Promise<{ record: VersionRecord; path: string }> {
    const a = this.actor(fileKey);
    const r = (await this.readVersionIndex(a)).find((v) => v.id === id);
    if (!r) throw new StoreError("not-found", `no version ${id}`);
    return { record: r, path: join(this.versionsDir(a), `${id}.kiwi`) };
  }

  private async openVersionFile(a: FileActor, v: VersionRecord): Promise<OpenedFile> {
    const snap = await readSnapshotFile(join(this.versionsDir(a), `${v.id}.kiwi`));
    return {
      meta: { ...this.d.workspace.getMeta(a.key) },
      mode: "view",
      sessionID: 0,
      schema: own(SCHEMA_BINARY),
      snapshot: currentMessageBytes(snap),
      snapshotSeq: v.seq,
      journal: [],
      headSeq: v.seq,
      ui: null,
      recovery: null,
    };
  }

  async openVersion(fileKey: FileKey, id: VersionId): Promise<OpenedFile> {
    this.d.workspace.getMeta(fileKey);
    const a = this.actor(fileKey);
    const { record } = await this.getVersion(fileKey, id);
    return this.openVersionFile(a, record);
  }

  /** The head as a node table: snapshot + every frame after it. */
  async headTable(fileKey: FileKey): Promise<{ table: NodeTable; seq: number }> {
    const a = this.actor(fileKey);
    return a.queue.run(async () => {
      const h = await this.loaded(a);
      const snap = await readSnapshotFile(this.path(a, h.state.head.snapshot));
      const table = NodeTable.fromMessage(currentMessage(snap));
      for (const f of await this.readFrames(a, h, h.state.head.snapshotSeq)) table.apply(codec.decodeMessage(f.message));
      return { table, seq: h.lastSeq };
    });
  }

  /**
   * The NODE_CHANGES message that turns the head into the version (non-destructive restore, §6); local assets keep
   * their library bookkeeping (`restoreDiff`, src/shared/store/assetIdentity.ts).
   */
  async restoreDiff(fileKey: FileKey, id: VersionId): Promise<Uint8Array> {
    const { path } = await this.getVersion(fileKey, id);
    const target = NodeTable.fromMessage(currentMessage(await readSnapshotFile(path)));
    const { table } = await this.headTable(fileKey);
    return codec.encodeMessage(restoreDiff(table, target));
  }

  /** The head snapshot file after a flush and a compaction (Save Local Copy, duplicate). */
  async compactedHead(fileKey: FileKey): Promise<{ path: string; seq: number; blobRefs: string[] }> {
    const a = this.actor(fileKey);
    await this.flush(fileKey);
    await this.compactNow(a, true);
    return a.queue.run(async () => {
      const h = await this.loaded(a);
      return { path: this.path(a, h.state.head.snapshot), seq: h.state.head.snapshotSeq, blobRefs: [...new Set([...h.state.blobRefs, ...h.pendingRefs])] };
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Thumbnails and UI state (§5.7)
  // -------------------------------------------------------------------------------------------------------------------

  async saveThumbnail(fileKey: FileKey, png: Uint8Array, size: { width: number; height: number }): Promise<void> {
    if (!(png instanceof Uint8Array)) throw new StoreError("invalid", "a thumbnail is PNG bytes");
    const dims = pngSize(png);
    if (!dims) throw new StoreError("invalid", "a thumbnail must be a PNG");
    if (dims.width > 800 || dims.height > 600) throw new StoreError("invalid", "a thumbnail fits inside 800×600");
    const a = this.actor(fileKey);
    const meta = this.d.workspace.getMeta(fileKey);
    await a.queue.run(async () => {
      await atomicWrite(this.d.dirs.tmp, this.path(a, "thumbnail.png"), png);
      const h = a.head;
      if (h) {
        h.state.thumbnail.seq = h.lastSeq;
        h.stateDirty = true;
      }
    });
    const ws = this.d.workspace;
    await ws.queue.run(() => ws.patchFile(fileKey, { thumbnail: { version: (meta.thumbnail?.version ?? 0) + 1, width: size.width ?? dims.width, height: size.height ?? dims.height } }));
  }

  async setUiState(fileKey: FileKey, patch: Partial<FileUiState>): Promise<void> {
    this.d.workspace.getMeta(fileKey);
    const a = this.actor(fileKey);
    await a.queue.run(async () => {
      const cur = (await readJsonOrNull<FileUiState>(this.path(a, "ui.json"))) ?? { currentPageId: null, pages: {}, leftPanelWidth: 240, rightPanelWidth: 240 };
      const next: FileUiState = { ...cur, ...patch, pages: { ...cur.pages, ...(patch.pages ?? {}) } };
      await writeJsonAtomic(this.d.dirs.tmp, this.path(a, "ui.json"), next);
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Deletion, GC support, sizes, shutdown
  // -------------------------------------------------------------------------------------------------------------------

  /** Delete forever: rename the directory into .trash-pending, then remove it in the background. */
  async deleteFileData(fileKey: FileKey): Promise<void> {
    const a = this.actor(fileKey);
    await a.queue.run(async () => {
      for (const t of [a.syncTimer, a.updatedAtTimer, a.checkpointTimer]) if (t) this.timers.clearTimeout(t);
      await a.head?.writer?.close().catch(() => {});
      a.head = null;
      a.sessions.clear();
      const pending = join(this.d.dirs.trashPending, `${fileKey}-${this.d.clock.now()}`);
      if (await exists(a.dir)) await fsp.rename(a.dir, pending);
      void fsp.rm(pending, { recursive: true, force: true }).catch((e) => this.d.log("warn", `could not remove ${pending}`, e));
    });
    this.actors.delete(fileKey);
  }

  /** Every blob a file or one of its versions references (GC live set). */
  async blobRefsOf(fileKey: FileKey): Promise<string[]> {
    const a = this.actor(fileKey);
    const refs = new Set<string>();
    const h = a.head;
    if (h) {
      for (const r of h.state.blobRefs) refs.add(r);
      for (const r of h.pendingRefs) refs.add(r);
    } else {
      const s = await readJsonOrNull<FileStoreState>(this.path(a, "store.json"));
      for (const r of s?.blobRefs ?? []) refs.add(r);
    }
    for (const v of await this.readVersionIndex(a)) for (const r of v.blobRefs) refs.add(r);
    return [...refs];
  }

  async sizeOf(fileKey: FileKey): Promise<number> {
    const a = this.actor(fileKey);
    if (a.sizeBytes === null) {
      let total = 0;
      for (const n of await fsp.readdir(a.dir).catch(() => [] as string[])) if (!n.includes(".damaged") && !n.includes(".dropped")) total += await fileSize(join(a.dir, n));
      a.sizeBytes = total;
    }
    return a.sizeBytes;
  }

  cachedSize(fileKey: FileKey): number {
    return this.actors.get(fileKey)?.sizeBytes ?? 0;
  }

  openFiles(): { fileKey: FileKey; sessions: number; headSeq: number }[] {
    return [...this.actors.values()].filter((a) => a.head).map((a) => ({ fileKey: a.key, sessions: a.sessions.size, headSeq: a.head!.lastSeq }));
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.actors.values()].map((a) => (a.head ? a.queue.run(() => this.syncNow(a)) : Promise.resolve())));
  }

  /** Stop accepting appends, fsync everything, let a running compaction finish. */
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.background]);
    await Promise.all([...this.actors.values()].map((a) => a.compacting?.catch(() => false)));
    for (const a of this.actors.values()) {
      for (const t of [a.syncTimer, a.updatedAtTimer, a.checkpointTimer]) if (t) this.timers.clearTimeout(t);
      await a.queue.run(async () => {
        const h = a.head;
        if (!h) return;
        await h.writer?.close();
        h.writer = null;
        await this.saveState(a, h);
      });
    }
  }

  /** Snapshot of a file at its head, as a ReadSnapshot (for export of a file never opened). */
  async readHeadSnapshot(fileKey: FileKey): Promise<ReadSnapshot> {
    const { path } = await this.compactedHead(fileKey);
    return readSnapshotFile(path);
  }
}
