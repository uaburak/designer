/**
 * The Replicator (docs/data.md §8.2, §12.5): runs in the store while Firebase sync is on and moves changes between
 * `LocalAdapter` (always authoritative) and Firestore. Every 2 s while there is work:
 *
 *   records  — dirty workspace/prefs/folder/file records merged with their remote copies (field-level LWW on _clk);
 *              every 15th pass (and the first) the remote collections are read and newer fields adopted locally;
 *   push     — for each file with new frames after `sync.pushedSeq`: the frames (not the `remote` ones, which came
 *              from Firestore) go through FirestoreAdapter.pushNodes; a file never pushed, or whose unpushed frames
 *              were compacted away, pushes its whole head first (as of its last edit's time);
 *   pull     — for files open in an editor (and, on the first pass, those viewed in the last 7 days): node documents
 *              after `sync.pullCursor`, kept where newer than the local clocks, appended as one `remote` frame that
 *              reaches the editor as `file.changes` (applied without an undo entry).
 *
 * Failures back off from 2 s to 5 min. Off unless `userData/firebase/config.json` exists AND main turned sync on
 * (`startSync(store, { enabled })`); with no config, nothing here is even loaded.
 */
import { codec, DOCUMENT_FORMAT_VERSION, SCHEMA_BINARY, SCHEMA_SHA1, type Message } from "../../shared/schema/document.generated";
import { Emitter } from "../../shared/store/emitter";
import type { WorkspaceEvent } from "../../shared/store/repositories";
import type { FileKey, FileMeta, Folder, Hlc, Prefs, Workspace } from "../../shared/store/types";
import { join } from "node:path";
import type { Timers } from "../local/fileStore";
import { formatHlc } from "../local/ids";
import { previewsOf, type LocalStore } from "../localStore";
import { FileClocks } from "./clocks";
import { loadFirebaseDrivers, type FirebaseDrivers } from "./drivers";
import { FirestoreAdapter } from "./firestoreAdapter";
import { mergeRecord } from "./lww";

export const SYNC_INTERVAL_MS = 2000;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;
/** Remote records are read every this many passes (~30 s) */
export const RECORD_PULL_EVERY = 15;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export interface SyncStatus {
  state: "idle" | "syncing" | "offline";
  /** Files with local frames not pushed yet */
  pending: FileKey[];
  lastError: string | null;
  lastSyncedAt: number | null;
}

export interface ReplicatorOptions {
  store: LocalStore;
  adapter: FirestoreAdapter;
  timers?: Timers;
  intervalMs?: number;
}

type RecordKey = "workspace" | "prefs" | `folder:${string}` | `file:${string}`;

export class Replicator {
  readonly status = new Emitter<SyncStatus>();
  private readonly store: LocalStore;
  private readonly adapter: FirestoreAdapter;
  private readonly timers: Timers;
  private readonly interval: number;
  private readonly dirtyFiles = new Set<FileKey>();
  private readonly dirtyRecords = new Set<RecordKey>();
  private readonly clocks = new Map<FileKey, FileClocks>();
  private offs: (() => void)[] = [];
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private passes = 0;
  private backoff = 0;
  private adopting = false;
  private stopped = true;
  private lastError: string | null = null;
  private lastSyncedAt: number | null = null;

  constructor(opts: ReplicatorOptions) {
    this.store = opts.store;
    this.adapter = opts.adapter;
    this.timers = opts.timers ?? opts.store.timers;
    this.interval = opts.intervalMs ?? SYNC_INTERVAL_MS;
  }

  /** Starts the loop: everything is dirty on the first pass. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const ws = this.store.ws;
    this.dirtyRecords.add("workspace").add("prefs");
    for (const id of ws.folders.keys()) this.dirtyRecords.add(`folder:${id}`);
    for (const k of ws.files.keys()) {
      this.dirtyRecords.add(`file:${k}`);
      this.dirtyFiles.add(k);
    }
    this.offs.push(
      this.store.fileChanges.on((c) => {
        if (c.kind !== "remote") this.dirtyFiles.add(c.fileKey);
      }),
      this.store.workspaceEvents.on((e) => this.onWorkspaceEvent(e)),
    );
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.store.replicator === this) this.store.previewStorage = null;
    for (const off of this.offs.splice(0)) off();
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
    for (const c of this.clocks.values()) await c.save().catch(() => {});
  }

  private onWorkspaceEvent(e: WorkspaceEvent): void {
    if (this.adopting) return;
    switch (e.type) {
      case "workspace.updated":
        this.dirtyRecords.add("workspace");
        break;
      case "prefs.updated":
        this.dirtyRecords.add("prefs");
        break;
      case "folder.created":
      case "folder.updated":
      case "folder.trashed":
      case "folder.restored":
        this.dirtyRecords.add(`folder:${e.folder.id}`);
        break;
      case "file.created":
      case "file.updated":
      case "file.restored":
        this.dirtyRecords.add(`file:${e.file.fileKey}`);
        if (e.type === "file.created") this.dirtyFiles.add(e.file.fileKey);
        break;
      case "file.renamed":
      case "file.moved":
      case "file.trashed":
        this.dirtyRecords.add(`file:${e.fileKey}`);
        break;
    }
  }

  private schedule(ms: number): void {
    if (this.stopped || this.timer) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.pass();
    }, ms);
  }

  private emitStatus(state: SyncStatus["state"]): void {
    this.status.emit({ state, pending: [...this.dirtyFiles], lastError: this.lastError, lastSyncedAt: this.lastSyncedAt });
  }

  private async pass(): Promise<void> {
    if (this.running) return;
    this.running = (async () => {
      try {
        await this.runOnce();
        this.backoff = 0;
        this.lastError = null;
        this.lastSyncedAt = this.store.clock.now();
        this.emitStatus("idle");
      } catch (e) {
        this.backoff = Math.min(this.backoff ? this.backoff * 2 : this.interval, MAX_BACKOFF_MS);
        this.lastError = (e as Error)?.message ?? String(e);
        this.store.log("warn", `sync failed; retrying in ${Math.round(this.backoff / 1000)} s`, e);
        this.emitStatus("offline");
      }
    })();
    await this.running;
    this.running = null;
    this.schedule(this.backoff || this.interval);
  }

  /** One pass: records, then push, then pull. Throws on the first failure (the loop backs off). */
  async runOnce(): Promise<void> {
    const first = this.passes++ === 0;
    this.emitStatus("syncing");
    await this.pushRecords();
    if (first || this.passes % RECORD_PULL_EVERY === 0) await this.pullRecords();
    for (const k of [...this.dirtyFiles]) {
      if (!this.store.ws.files.has(k)) {
        this.dirtyFiles.delete(k);
        continue;
      }
      this.dirtyFiles.delete(k);
      try {
        await this.pushFile(k);
      } catch (e) {
        this.dirtyFiles.add(k);
        throw e;
      }
    }
    const pulls = new Set(this.store.files.openFiles().filter((f) => f.sessions > 0).map((f) => f.fileKey));
    if (first) {
      const now = this.store.clock.now();
      for (const [k, at] of Object.entries(this.store.ws.prefs.viewedAt)) if (now - at < RECENT_MS && this.store.ws.files.has(k)) pulls.add(k);
    }
    for (const k of pulls) await this.pullFile(k);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------------------------------------------------

  private async adopt(fn: () => Promise<void>): Promise<void> {
    this.adopting = true;
    try {
      await this.store.ws.queue.run(fn);
    } finally {
      this.adopting = false;
    }
  }

  private async pushRecords(): Promise<void> {
    const ws = this.store.ws;
    const p = this.adapter.paths;
    for (const key of [...this.dirtyRecords]) {
      this.dirtyRecords.delete(key);
      try {
        if (key === "workspace") {
          const r = await this.adapter.syncRecord<Workspace>(p.workspace, { ...ws.workspace });
          if (r.pulled.length) await this.adopt(() => ws.adoptWorkspace(r.merged, { persist: true }));
        } else if (key === "prefs") {
          const r = await this.adapter.syncRecord<Prefs>(p.prefs, structuredClone(ws.prefs));
          if (r.pulled.length) await this.adopt(() => ws.adoptPrefs(r.merged, { persist: true }));
        } else if (key.startsWith("folder:")) {
          const f = ws.folders.get(key.slice(7));
          if (!f) continue;
          const r = await this.adapter.syncRecord<Folder>(p.folder(f.id), { ...f });
          if (r.pulled.length) await this.adopt(() => ws.adoptFolder(r.merged, { persist: true }));
        } else {
          const m = ws.files.get(key.slice(5));
          if (!m) continue;
          const r = await this.adapter.syncRecord<FileMeta>(p.fileMeta(m.fileKey), { ...m });
          if (r.pulled.length) await this.adopt(() => ws.adoptMeta(r.merged, { persist: true }));
        }
      } catch (e) {
        this.dirtyRecords.add(key);
        throw e;
      }
    }
  }

  private async pullRecords(): Promise<void> {
    const ws = this.store.ws;
    const p = this.adapter.paths;
    const merge = async <T extends { _clk: Record<string, Hlc> }>(local: T | null, remote: T | null, apply: (merged: T) => Promise<void>, dirty: RecordKey) => {
      if (!remote?._clk) return;
      if (!local) return apply(remote);
      const r = mergeRecord(local, remote);
      if (r.pullFields.length) await apply(r.merged);
      if (r.pushFields.length) this.dirtyRecords.add(dirty);
    };
    await merge(ws.workspace, await this.adapter.getRecord<Workspace>(p.workspace), (w) => this.adopt(() => ws.adoptWorkspace(w, { persist: true })), "workspace");
    await merge(ws.prefs, await this.adapter.getRecord<Prefs>(p.prefs), (x) => this.adopt(() => ws.adoptPrefs(x, { persist: true })), "prefs");
    for (const f of await this.adapter.listRecords<Folder>(p.folders)) {
      if (!f?.id) continue;
      await merge(ws.folders.get(f.id) ?? null, f, (x) => this.adopt(() => ws.adoptFolder(x, { persist: true })), `folder:${f.id}`);
    }
    for (const m of await this.adapter.listRecords<FileMeta>(p.fileMetas)) {
      if (!m?.fileKey) continue;
      const local = ws.files.get(m.fileKey);
      if (!local) {
        this.store.log("debug", `sync: ${m.fileKey} exists only remotely (downloading files isn't built yet)`);
        continue;
      }
      await merge(local, m, (x) => this.adopt(() => ws.adoptMeta(x, { persist: true })), `file:${m.fileKey}`);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------------------------------------------------

  private async clocksOf(fileKey: FileKey): Promise<FileClocks> {
    let c = this.clocks.get(fileKey);
    if (!c) this.clocks.set(fileKey, (c = await FileClocks.load(join(this.store.dirs.files, fileKey), this.store.dirs.tmp)));
    return c;
  }

  /** Pushes a file's frames after `pushedSeq` (its whole head first when it never synced or frames were compacted away). */
  async pushFile(fileKey: FileKey): Promise<void> {
    const files = this.store.files;
    const meta = this.store.ws.getMeta(fileKey);
    const state = await files.syncState(fileKey);
    const pushedSeq = state?.pushedSeq ?? 0;
    const frames = await files.framesSince(fileKey, pushedSeq);
    const headSeq = frames.length ? frames[frames.length - 1].seq : (files.headSeq(fileKey) ?? pushedSeq);
    if (state && headSeq <= pushedSeq) return;
    const gap = !state || (frames.length ? frames[0].seq > pushedSeq + 1 : headSeq > pushedSeq);
    const batch: { hlc: Hlc; message: Message }[] = [];
    if (gap) {
      const { table } = await files.headTable(fileKey);
      // The head as of the file's creation (first push) or last edit (frames gone): later frames' stamps win over it.
      const at = state ? meta.updatedAt : meta.createdAt;
      batch.push({ hlc: formatHlc(at, 0, this.store.deviceOrdinal), message: table.toMessage() });
      await this.adapter.ensureFileDoc(fileKey, { documentFormatVersion: DOCUMENT_FORMAT_VERSION, schemaSha1: SCHEMA_SHA1, createdAt: meta.createdAt });
      await this.adapter.uploadSchema(SCHEMA_SHA1, SCHEMA_BINARY);
    }
    for (const f of frames) if (f.kind !== "remote") batch.push({ hlc: f.hlc, message: codec.decodeMessage(f.message) });
    const clocks = await this.clocksOf(fileKey);
    if (batch.length) await this.adapter.pushNodes(fileKey, batch, clocks);
    await clocks.save();
    await files.setSyncState(fileKey, { pushedSeq: Math.max(headSeq, pushedSeq), pullCursor: state?.pullCursor ?? null });
  }

  /** Pulls a file's remote changes since `pullCursor` into one `remote` frame. */
  async pullFile(fileKey: FileKey): Promise<void> {
    const files = this.store.files;
    const state = await files.syncState(fileKey);
    if (!state) {
      // Never pushed from here: push first, so the remote has this file's head and the clocks know it.
      this.dirtyFiles.add(fileKey);
      return;
    }
    const clocks = await this.clocksOf(fileKey);
    let table: Set<string> | null = null;
    const exists = async (guid: string) => {
      table ??= new Set((await files.headTable(fileKey)).table.nodes.keys());
      return table.has(guid);
    };
    const r = await this.adapter.pullNodes(fileKey, state.pullCursor, clocks, exists);
    for (const h of r.stamps) this.store.hlc.observe(h);
    let pushedSeq = state.pushedSeq;
    if (r.message) {
      const ack = await files.appendRemote(fileKey, codec.encodeMessage(r.message));
      // The remote frame is Firestore's already; if nothing local was waiting, there's nothing new to push.
      if (pushedSeq === ack.seq - 1) pushedSeq = ack.seq;
    }
    await clocks.save();
    await files.setSyncState(fileKey, { pushedSeq, pullCursor: r.cursor });
  }
}

export interface StartSyncOptions {
  /** Main's `settings.sync.enabled` */
  enabled: boolean;
  /** A Google ID token main obtained (§12.3); or `uid` when already signed in (tests) */
  idToken?: string;
  uid?: string;
  /** Default: the Firebase SDK, loaded lazily from the store's config */
  drivers?: FirebaseDrivers;
  intervalMs?: number;
}

/**
 * Turns sync on when it may run: a valid `firebase/config.json` AND `enabled`. Returns null (and loads nothing)
 * otherwise. The replicator is kept on `store.replicator` and stopped by `store.shutdown()`.
 */
export async function startSync(store: LocalStore, opts: StartSyncOptions): Promise<Replicator | null> {
  if (!store.sync || !opts.enabled) return null;
  const drivers = opts.drivers ?? (await loadFirebaseDrivers(store.sync));
  const uid = opts.idToken ? (await drivers.signIn(opts.idToken)).uid : opts.uid;
  if (!uid) {
    store.log("warn", "sync is on but nobody is signed in; it stays off");
    return null;
  }
  if (store.ws.workspace.ownerUid === null) await store.ws.queue.run(() => store.ws.setOwnerUid(uid));
  const adapter = new FirestoreAdapter({ firestore: drivers.firestore, storage: drivers.storage, wid: store.ws.workspace.wid, uid, deviceOrdinal: store.deviceOrdinal, blobs: store.blobs });
  const r = new Replicator({ store, adapter, intervalMs: opts.intervalMs });
  await store.replicator?.stop();
  store.replicator = r;
  // Developer previews publish to the same project's Storage while sync runs (docs/data.md §13).
  store.previewStorage = drivers.storage;
  // Expired developer previews leave Storage now (the viewer refuses them already).
  void previewsOf(store)
    .sweepExpired()
    .then((ids) => ids.length && store.log("info", `swept ${ids.length} expired preview(s)`))
    .catch((e: unknown) => store.log("warn", `couldn't sweep expired previews: ${(e as Error).message}`));
  r.start();
  return r;
}
