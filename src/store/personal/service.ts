/**
 * Personal Drafts in the cloud (docs/cloud.md §2, Wecra 1.1): the person's Drafts are server files (`GET /me/drafts`),
 * and the local workspace is their cache.
 *
 * - **Records.** Every draft has a local record (`FileMeta.cloud {uid, key}`), so Home's Drafts, Trash, Recents,
 *   Starred and search keep working from the workspace index. A draft never opened here (or evicted) is a record with
 *   no document (`cloud.remote`): opening it downloads its room's snapshot into the record (`MultiplayerService
 *   .linkInto`). A draft opened is a linked copy — edits go through its room, offline edits wait in the journal (§5).
 * - **New files** (Design, Duplicate, Import, a version duplicated) are drafts from the start: the record says
 *   `pendingCreate` with a reserved room key, and the store registers it (`POST /me/drafts`) and uploads its document
 *   through the upload path (`MultiplayerService.shareTo`, the upload panel) — at once when online, else when the
 *   server is reached again.
 * - **Sync.** `refresh()` lists the Drafts and the trash and makes the records say what the server says (names,
 *   trash; new drafts from elsewhere as records; drafts deleted elsewhere go). Writes on a registered draft go to the
 *   server first (rename, trash, restore, delete forever) and fail `offline` without it.
 * - **Cache.** Documents of cached drafts are bounded (default 5 GB, `cloud.json`); over the bound the least recently
 *   opened go first — never one open, with edits the room hasn't acknowledged, or still uploading.
 * - **Migration (1.1).** At a sign-in, every local file of the workspace that isn't a draft yet (a pre-1.1 local file)
 *   becomes a draft of that account: its local folder's path becomes a prefix of its name ("KOC / Logo", Drafts being
 *   flat), it is marked `pendingCreate`, and registered like a new file. Nothing local is deleted; a file whose upload
 *   didn't finish stays a pending draft and goes again at the next start — idempotent (the reserved key makes a
 *   repeated `POST /me/drafts` answer the same draft). A file shared before 1.1 by its owner is already on the server
 *   (migration 0023 made it a draft): its record just becomes the draft's.
 * - **Accounts.** Records carry the account (`cloud.uid`); listings show the signed-in account's only and links join
 *   rooms with their own account's session (`LinkRecord.uid`) — each account its own Drafts and cache namespace.
 *
 * No Node or DOM imports (the host gives the disk).
 */
import { StoreError } from "../../shared/store/protocol";
import { Emitter } from "../../shared/store/emitter";
import type { Unsubscribe } from "../../shared/store/repositories";
import type { FileKey, FileMeta } from "../../shared/store/types";
import { DEFAULT_CACHE_LIMIT_BYTES, type CacheInfo, type CloudEvent, type CloudFile, type CloudRepository, type CloudStatus, type PersonalFile } from "../../shared/store/cloud";
import { isCanceled, isGone, type MultiplayerService } from "../multiplayer/service";
import { t as tr } from "../../shared/i18n";

/** What the store gives the service. */
export interface PersonalHost {
  metas(): Iterable<FileMeta>;
  getMeta(fileKey: FileKey): FileMeta | null;
  /** Writes these fields of the record (Home hears of it) */
  patchMeta(fileKey: FileKey, patch: Partial<Omit<FileMeta, "fileKey" | "_clk">>): Promise<void>;
  /** A record with no document: a draft listed by the server, never downloaded here */
  addRemote(input: { name: string; createdAt: number; updatedAt: number; trashedAt: number | null; cloud: CloudFile; editorType?: FileMeta["editorType"] }): Promise<FileMeta>;
  /** The record and everything of it go (the draft was deleted on the server) */
  forget(fileKey: FileKey): Promise<void>;
  /** The document goes; the record and its thumbnail stay */
  dropDocument(fileKey: FileKey): Promise<void>;
  /** Bytes the file's document takes here (journal, snapshots, versions, its images) */
  documentSize(fileKey: FileKey): Promise<number>;
  /** An edit session has it open */
  isOpen(fileKey: FileKey): boolean;
  /** A published library (its consumers read it here): kept */
  isLibrary(fileKey: FileKey): boolean;
  /** When it was last opened here (Recents' viewedAt), null never */
  lastOpened(fileKey: FileKey): number | null;
  /** In the trash, itself or through its folder: when it went (null: not) */
  trashedAt(meta: FileMeta): number | null;
  /** The names of its local folder and the folders above it, outermost first */
  folderPath(meta: FileMeta): string[];
  /** Listings show this account's drafts (null: signed out) */
  setAccount(uid: string | null): void;
  /** The file's document at its journal head (kiwi Message) and the head's seq */
  headSnapshot(fileKey: FileKey): Promise<Uint8Array>;
  headSeq(fileKey: FileKey): Promise<number>;
  /** cloud.json */
  load(): Promise<unknown>;
  save(state: CloudState): Promise<void>;
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** cloud.json */
export interface CloudState {
  v: 1;
  limitBytes: number;
}

/** The smallest bound Settings may set */
export const MIN_CACHE_LIMIT_BYTES = 256 * 1024 ** 2;
/** Tries again to reach the server (pending registrations, a refresh that failed) this often while something waits */
export const RETRY_MS = 60_000;
/** Eviction runs this long after a file closes or a download (several at once make one pass) */
export const EVICT_DELAY_MS = 2_000;

const offlineError = (name: string) => new StoreError("offline", `“${name}” isn't available offline. Connect to the internet to open it.`);

export class PersonalService {
  readonly events = new Emitter<CloudEvent>();
  private uid: string | null = null;
  private online = false;
  private checked = false;
  private syncedAt: number | null = null;
  private migration: CloudStatus["migration"] = null;
  private state: CloudState | null = null;
  private registering = new Map<FileKey, Promise<boolean>>();
  private filling = new Map<FileKey, Promise<void>>();
  private refreshing: Promise<CloudStatus> | null = null;
  private retryTimer: unknown = null;
  private evictTimer: unknown = null;
  private closed = false;
  private offs: Unsubscribe[] = [];
  /** Bumped by every session change: work started for one account stops for the next */
  private generation = 0;

  constructor(
    private mp: MultiplayerService,
    private host: PersonalHost,
    notices?: { onReconnect?(listener: () => void): Unsubscribe },
    /** `defaultLimitBytes`: the cache's bound until Settings sets one (default DEFAULT_CACHE_LIMIT_BYTES, 5 GB; the web
     *  app's 1 GB, docs/cloud.md §7) */
    private opts: { enabled?: boolean; defaultLimitBytes?: number } = {},
  ) {
    if (notices?.onReconnect) this.offs.push(notices.onReconnect(() => void this.sync()));
  }

  /** The signed-in account (null signed out) */
  get account(): string | null {
    return this.uid;
  }

  /**
   * Main handed over a session (or none): listings follow the account at once; then, signed in, the migration of local
   * files, the Drafts from the server, pending registrations and the cache's bound.
   */
  async sessionChanged(): Promise<void> {
    if (this.opts.enabled === false) return;
    const uid = this.mp.signedIn ? this.mp.userId : null;
    // The same account again (a new token, main repeating the session): one more sync, nothing reset
    if (uid && uid === this.uid) return this.sync();
    this.generation++;
    this.uid = uid;
    this.online = false;
    this.checked = false;
    this.host.setAccount(uid);
    this.emitStatus();
    if (!uid) return;
    await this.sync();
  }

  private syncing: Promise<void> | null = null;
  private syncAgain = false;

  /** One sync at a time; asked for while one runs, another follows it */
  private sync(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.syncAgain = false;
        await this.syncOnce();
      } while (this.syncAgain && !this.closed);
    })().finally(() => (this.syncing = null));
    return this.syncing;
  }

  /** Resolves when no sync, registration or download is under way (tests) */
  async idle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const busy = [this.syncing, this.refreshing, ...this.registering.values(), ...this.filling.values()].filter((p): p is Promise<never> => !!p);
      if (!busy.length) return;
      await Promise.allSettled(busy);
    }
  }

  /** Migration, refresh, registrations, eviction — each step on its own (one failing doesn't stop the others) */
  private async syncOnce(): Promise<void> {
    if (!this.uid || this.closed) return;
    const gen = this.generation;
    await this.migrate().catch((e) => this.host.log("warn", "cloud: migrating local files failed", e));
    if (gen !== this.generation) return;
    await this.refresh().catch(() => {});
    if (gen !== this.generation) return;
    await this.registerPending().catch((e) => this.host.log("warn", "cloud: registering drafts failed", e));
    this.scheduleEvict(0);
  }

  // --- new files and the migration -----------------------------------------------------------------------------------

  /**
   * A new file's record while signed in becomes a draft of the account (docs/cloud.md §2): `pendingCreate` until the
   * server has it. Org copies and branches stay as they are. Returns the record (changed in place).
   */
  asDraft(meta: FileMeta): FileMeta {
    if (this.uid && !meta.space && !meta.branch) meta.cloud = { uid: this.uid, key: this.mp.newRoomKey(meta.fileKey), pendingCreate: true };
    return meta;
  }

  /** A new draft's record was added: it is registered now (in the background; the upload panel shows it) */
  created(fileKey: FileKey): void {
    const meta = this.host.getMeta(fileKey);
    if (meta?.cloud?.pendingCreate) void this.register(fileKey);
  }

  /** Local files not drafts yet (the 1.1 migration): marked as pending drafts of the account, then registered */
  private async migrate(): Promise<void> {
    const uid = this.uid;
    if (!uid) return;
    for (const meta of [...this.host.metas()]) {
      if (meta.cloud || meta.space || meta.branch) continue;
      const link = await this.mp.linkInfo(meta.fileKey);
      // Another person's file opened by its link stays theirs ("Shared with me")
      if (link && link.role !== "owner") continue;
      const prefix = this.host.folderPath(meta);
      const name = [...prefix, meta.name].join(" / ");
      const trashedAt = this.host.trashedAt(meta);
      if (link) {
        // Shared by its owner before 1.1: on the server already, a draft since migration 0023
        if (link.uid && link.uid !== uid) continue;
        await this.mp.claimLink(meta.fileKey);
        await this.host.patchMeta(meta.fileKey, { cloud: { uid, key: link.key }, folderId: null, trashedAt, ...(name !== meta.name ? { name } : {}) });
        if (name !== meta.name) await this.mp.renameRemote(meta.fileKey, name);
        continue;
      }
      await this.host.patchMeta(meta.fileKey, { cloud: { uid, key: this.mp.newRoomKey(meta.fileKey), pendingCreate: true }, folderId: null, trashedAt, name });
    }
  }

  /** Every pending draft of the account, one at a time (the upload panel lists them as they go) */
  private async registerPending(): Promise<void> {
    const pending = [...this.host.metas()].filter((m) => m.cloud?.pendingCreate && m.cloud.uid === this.uid);
    if (!pending.length) return;
    const gen = this.generation;
    this.migration = { total: pending.length, done: 0, failed: 0 };
    this.emitStatus();
    for (const m of pending) {
      if (gen !== this.generation || this.closed) return;
      const ok = await this.register(m.fileKey);
      if (this.migration) {
        if (ok) this.migration.done++;
        else this.migration.failed++;
      }
      this.emitStatus();
      // Offline: the rest wait for the next try
      if (!ok && !this.online) break;
    }
    if (this.migration && this.migration.done === this.migration.total) this.migration = null;
    this.emitStatus();
    if ([...this.host.metas()].some((m) => m.cloud?.pendingCreate && m.cloud.uid === this.uid)) this.scheduleRetry();
  }

  /** Registers a pending draft (`POST /me/drafts` with its reserved key) and uploads its document. True once registered. */
  register(fileKey: FileKey): Promise<boolean> {
    const had = this.registering.get(fileKey);
    if (had) return had;
    const p = this.registerNow(fileKey).finally(() => this.registering.delete(fileKey));
    this.registering.set(fileKey, p);
    return p;
  }

  private async registerNow(fileKey: FileKey): Promise<boolean> {
    const meta = this.host.getMeta(fileKey);
    const uid = this.uid;
    if (!meta?.cloud?.pendingCreate || !uid || meta.cloud.uid !== uid || !this.mp.signedIn) return false;
    const link = await this.mp.linkInfo(fileKey);
    if (link) {
      // Registered before, the record not told (a quit between the two): the link finishes any upload itself
      await this.host.patchMeta(fileKey, { cloud: { uid, key: link.key } });
      return true;
    }
    let key = meta.cloud.key;
    if (!key) {
      key = this.mp.newRoomKey(fileKey);
      await this.host.patchMeta(fileKey, { cloud: { ...meta.cloud, key } });
    }
    const room = key;
    try {
      const head = await this.host.headSeq(fileKey);
      const snapshot = await this.host.headSnapshot(fileKey);
      await this.mp.shareTo(
        fileKey,
        { snapshot, headSeq: head },
        async (k, name) => {
          // A Social file is a draft of its own kind (docs/social.md §27)
          const kind = this.host.getMeta(fileKey)?.editorType === "buzz" ? { editorType: "buzz" } : {};
          const answer = await this.mp.call("POST", "/me/drafts", { key: k, name, ...kind });
          // On the server from here: no longer pending, whatever happens to the upload (its link finishes it)
          await this.host.patchMeta(fileKey, { cloud: { uid, key: k } });
          return answer;
        },
        room,
      );
      this.online = true;
    } catch (e) {
      const registered = !this.host.getMeta(fileKey)?.cloud?.pendingCreate;
      if (!registered) {
        if (e instanceof StoreError && e.code === "offline") this.online = false;
        // Someone else's key (never in practice): the next try reserves another
        else if (e instanceof StoreError && e.code === "conflict") await this.host.patchMeta(fileKey, { cloud: { uid, key: null, pendingCreate: true } });
        if (!isCanceled(e)) this.host.log("warn", `cloud: “${meta.name}” isn't registered yet`, e);
        this.emitStatus();
        return false;
      }
      // Registered, its upload not finished: the link goes on with it
    }
    // A file in the trash when it was registered (the migration of a local Trash) goes to the server's trash too
    if (this.host.getMeta(fileKey)?.trashedAt != null) await this.mp.call("POST", `/files/${room}/trash`).catch(() => {});
    this.emitStatus();
    return true;
  }

  // --- the server's Drafts -------------------------------------------------------------------------------------------

  /** Lists the Drafts and the trash from the server and makes the records say the same */
  refresh(): Promise<CloudStatus> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshNow().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refreshNow(): Promise<CloudStatus> {
    const uid = this.uid;
    if (!uid || !this.mp.signedIn) return this.status();
    const gen = this.generation;
    let live: PersonalFile[];
    let trashed: PersonalFile[];
    try {
      [live, trashed] = await Promise.all([this.list(false), this.list(true)]);
    } catch (e) {
      if (gen === this.generation && e instanceof StoreError && e.code === "offline") {
        this.online = false;
        this.checked = true;
        this.emitStatus();
        this.scheduleRetry();
      }
      throw e;
    }
    if (gen !== this.generation) return this.status();
    this.online = true;
    this.checked = true;
    const listed = new Map<string, PersonalFile>();
    for (const f of [...live, ...trashed]) listed.set(f.key, f);
    const mine = new Map<string, FileMeta>();
    // Drafts registering now (or whose answer was lost): their own registration finishes them
    const reserved = new Set<string>();
    for (const m of this.host.metas()) {
      if (m.cloud?.uid !== uid || !m.cloud.key) continue;
      if (m.cloud.pendingCreate) reserved.add(m.cloud.key);
      else mine.set(m.cloud.key, m);
    }
    for (const f of listed.values()) {
      if (reserved.has(f.key)) continue;
      const m = mine.get(f.key);
      if (m) {
        const patch: Partial<FileMeta> = {};
        if (m.name !== f.name) patch.name = f.name;
        if ((m.trashedAt ?? null) !== (f.trashedAt ?? null)) patch.trashedAt = f.trashedAt;
        if (f.updatedAt > m.updatedAt && m.cloud?.remote) patch.updatedAt = f.updatedAt;
        // The file's kind (docs/social.md §27): a Social file elsewhere is one here; a Social file here the server still
        // calls a Design draft (registered before drafts kept their kind) is told so — best effort.
        if (f.editorType === "buzz" && m.editorType !== "buzz") patch.editorType = "buzz";
        else if (m.editorType === "buzz" && f.editorType === "design") void this.mp.call("PATCH", `/files/${f.key}`, { editorType: "buzz" }).catch(() => {});
        if (Object.keys(patch).length) await this.host.patchMeta(m.fileKey, patch);
        continue;
      }
      // A copy linked to it whose record doesn't say so yet
      const copy = await this.mp.linkedCopy(f.key);
      const cm = copy ? this.host.getMeta(copy) : null;
      if (cm && !cm.space) {
        await this.host.patchMeta(cm.fileKey, { cloud: { uid, key: f.key }, name: f.name, trashedAt: f.trashedAt, folderId: null });
        continue;
      }
      await this.host.addRemote({ name: f.name, createdAt: f.createdAt, updatedAt: f.updatedAt, trashedAt: f.trashedAt, cloud: { uid, key: f.key, remote: true }, ...(f.editorType === "buzz" ? { editorType: "buzz" as const } : {}) });
    }
    // Records of drafts the server no longer lists: deleted, moved into an org, or no longer the person's
    for (const [key, m] of mine) {
      if (listed.has(key) || gen !== this.generation) continue;
      await this.gone(m, key).catch((e) => this.host.log("warn", `cloud: couldn't check ${key}`, e));
    }
    this.syncedAt = this.host.now();
    this.emitStatus();
    return this.status();
  }

  private async list(trashed: boolean): Promise<PersonalFile[]> {
    const { files } = await this.mp.call<{ files: PersonalFile[] }>("GET", `/me/drafts${trashed ? "?trashed=1" : ""}`);
    return Array.isArray(files) ? files.filter((f) => f && typeof f.key === "string") : [];
  }

  /** A draft not listed: asked about once — gone for good, in an org now, or someone else's now */
  private async gone(m: FileMeta, key: string): Promise<void> {
    let info: { space?: string | null; org?: { id: string; teamId: string | null; projectId: string | null } | null; role?: string } | null = null;
    try {
      info = await this.mp.call("GET", `/files/${key}`);
    } catch (e) {
      if (!isGone(e)) throw e;
    }
    if (!info) {
      // Deleted on the server (elsewhere, or the 30 days of its trash): it goes here too, unless it is open
      if (this.host.isOpen(m.fileKey)) return;
      await this.mp.unlink(m.fileKey);
      await this.host.forget(m.fileKey);
      return;
    }
    if (info.org) {
      await this.host.patchMeta(m.fileKey, { cloud: null, space: { orgId: info.org.id, key, teamId: info.org.teamId ?? null, projectId: info.org.projectId ?? null }, folderId: null });
      return;
    }
    // Ownership given away: the copy stays as a shared file of the new owner's
    if (info.role !== "owner") await this.host.patchMeta(m.fileKey, { cloud: null });
  }

  // --- opening, writes ------------------------------------------------------------------------------------------------

  /** Before a file's document is read (open, duplicate, export): a draft with no document here downloads it */
  ensureLocal(fileKey: FileKey): Promise<void> {
    const meta = this.host.getMeta(fileKey);
    if (!meta?.cloud?.remote) return Promise.resolve();
    const had = this.filling.get(fileKey);
    if (had) return had;
    const p = this.fill(meta).finally(() => this.filling.delete(fileKey));
    this.filling.set(fileKey, p);
    return p;
  }

  private async fill(meta: FileMeta): Promise<void> {
    const cloud = meta.cloud!;
    if (!this.mp.signedIn || !cloud.key) throw offlineError(meta.name);
    try {
      await this.mp.linkInto(meta.fileKey, cloud.key, "owner");
    } catch (e) {
      if (e instanceof StoreError && e.code === "offline") {
        this.online = false;
        this.checked = true;
        this.emitStatus();
        throw offlineError(meta.name);
      }
      throw e;
    }
    await this.host.patchMeta(meta.fileKey, { cloud: { uid: cloud.uid, key: cloud.key } });
    this.online = true;
    this.scheduleEvict();
  }

  /** The registered drafts among these files (pending ones change only here) */
  private registered(fileKeys: FileKey[]): { fileKey: FileKey; key: string; name: string }[] {
    const out: { fileKey: FileKey; key: string; name: string }[] = [];
    for (const k of fileKeys) {
      const m = this.host.getMeta(k);
      if (m?.cloud?.key && !m.cloud.pendingCreate) out.push({ fileKey: k, key: m.cloud.key, name: m.name });
    }
    return out;
  }

  /** Rename a draft: the server first (offline: refused), then the record */
  async renameFirst(fileKey: FileKey, name: string): Promise<void> {
    const [d] = this.registered([fileKey]);
    if (!d) return;
    await this.mp.call("PATCH", `/files/${d.key}`, { name: name.trim() });
  }

  /** A draft's kind changed (Convert this file, docs/social.md §18.1, §27): the server first; offline, refused */
  async kindFirst(fileKey: FileKey, editorType: FileMeta["editorType"]): Promise<void> {
    const [d] = this.registered([fileKey]);
    if (!d) return;
    await this.mp.call("PATCH", `/files/${d.key}`, { editorType });
  }

  /** Trash or restore drafts: the server first (each one; offline: refused before anything changed here) */
  async trashFirst(fileKeys: FileKey[], trash: boolean): Promise<void> {
    for (const d of this.registered(fileKeys)) {
      const m = this.host.getMeta(d.fileKey);
      if ((m?.trashedAt != null) === trash) continue;
      await this.mp.call("POST", `/files/${d.key}/${trash ? "trash" : "restore"}`).catch((e: unknown) => {
        // Already so on the server (another device): the record follows
        if (!(e instanceof StoreError && e.code === "conflict")) throw e;
      });
    }
  }

  /** Delete drafts forever: on the server first; their links go with them */
  async deleteFirst(fileKeys: FileKey[]): Promise<void> {
    for (const d of this.registered(fileKeys)) {
      await this.mp.call("DELETE", `/files/${d.key}`).catch((e: unknown) => {
        if (!isGone(e)) throw e;
      });
      await this.mp.unlink(d.fileKey);
    }
  }

  /** A file closed: the cache's bound is checked soon */
  closed_(fileKey: FileKey): void {
    if (this.host.getMeta(fileKey)?.cloud) this.scheduleEvict();
  }

  // --- the cache -----------------------------------------------------------------------------------------------------

  private async loadState(): Promise<CloudState> {
    if (this.state) return this.state;
    const raw = (await this.host.load().catch(() => null)) as Partial<CloudState> | null;
    const limit = Number(raw?.limitBytes);
    this.state = { v: 1, limitBytes: Number.isFinite(limit) && limit > 0 ? limit : (this.opts.defaultLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES) };
    return this.state;
  }

  /** Cached drafts (a document here, registered): what eviction may take */
  private cached(): FileMeta[] {
    return [...this.host.metas()].filter((m) => !!m.cloud?.key && !m.cloud.remote && !m.cloud.pendingCreate);
  }

  /** Kept now: open, a library, a link with an upload not finished or edits its room hasn't acknowledged, no link */
  private async pinned(m: FileMeta): Promise<boolean> {
    if (this.host.isOpen(m.fileKey) || this.host.isLibrary(m.fileKey)) return true;
    const link = await this.mp.linkInfo(m.fileKey);
    if (!link || link.pendingUpload || link.uploading) return true;
    const sync = await this.mp.syncState(m.fileKey);
    return !sync || sync.unsent > 0;
  }

  async cacheInfo(): Promise<CacheInfo> {
    const { limitBytes } = await this.loadState();
    let usedBytes = 0;
    let pinned = 0;
    const cached = this.cached();
    for (const m of cached) {
      usedBytes += await this.host.documentSize(m.fileKey).catch(() => 0);
      if (await this.pinned(m).catch(() => true)) pinned++;
    }
    return { usedBytes, limitBytes, files: cached.length, pinned };
  }

  async setCacheLimit(bytes: number): Promise<CacheInfo> {
    if (!Number.isFinite(bytes) || bytes < MIN_CACHE_LIMIT_BYTES) throw new StoreError("invalid", tr("The cache is at least 256 MB"));
    const st = await this.loadState();
    st.limitBytes = Math.floor(bytes);
    await this.host.save({ ...st });
    await this.evict(false);
    return this.emitCache();
  }

  async clearCache(): Promise<CacheInfo> {
    await this.evict(true);
    return this.emitCache();
  }

  /**
   * Over the bound (or `all`), cached drafts go least recently opened first, pinned ones skipped. Their records stay
   * (`remote`): listed in Home, downloaded when opened.
   */
  async evict(all: boolean): Promise<number> {
    const { limitBytes } = await this.loadState();
    const entries: { m: FileMeta; size: number; at: number }[] = [];
    let used = 0;
    for (const m of this.cached()) {
      const size = await this.host.documentSize(m.fileKey).catch(() => 0);
      used += size;
      entries.push({ m, size, at: this.host.lastOpened(m.fileKey) ?? 0 });
    }
    if (!all && used <= limitBytes) return 0;
    entries.sort((a, b) => a.at - b.at);
    let n = 0;
    for (const e of entries) {
      if (!all && used <= limitBytes) break;
      if (await this.pinned(e.m).catch(() => true)) continue;
      const cloud = e.m.cloud!;
      await this.mp.unlink(e.m.fileKey);
      await this.host.dropDocument(e.m.fileKey);
      await this.host.patchMeta(e.m.fileKey, { cloud: { uid: cloud.uid, key: cloud.key, remote: true } });
      used -= e.size;
      n++;
    }
    if (n) this.host.log("info", `cloud: evicted ${n} file${n === 1 ? "" : "s"} from the cache`);
    return n;
  }

  private scheduleEvict(ms = EVICT_DELAY_MS): void {
    if (this.closed || this.evictTimer) return;
    this.evictTimer = this.host.setTimeout(() => {
      this.evictTimer = null;
      void this.evict(false)
        .then(async (n) => void (n && (await this.emitCache())))
        .catch((e) => this.host.log("warn", "cloud: eviction failed", e));
    }, ms);
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer || !this.uid) return;
    this.retryTimer = this.host.setTimeout(() => {
      this.retryTimer = null;
      void this.sync();
    }, RETRY_MS);
  }

  // --- status, the repository ----------------------------------------------------------------------------------------

  status(): CloudStatus {
    return { uid: this.uid, online: this.online, checked: this.checked, syncedAt: this.syncedAt, migration: this.migration ? { ...this.migration } : null };
  }

  private emitStatus(): void {
    this.events.emit({ type: "status", status: this.status() });
  }

  private async emitCache(): Promise<CacheInfo> {
    const cache = await this.cacheInfo();
    this.events.emit({ type: "cache", cache });
    return cache;
  }

  repository(): CloudRepository {
    return {
      status: async () => this.status(),
      refresh: async () => {
        await this.refresh().catch(() => {});
        void this.registerPending().catch(() => {});
        return this.status();
      },
      cacheInfo: () => this.cacheInfo(),
      setCacheLimit: (bytes) => this.setCacheLimit(Number(bytes)),
      clearCache: () => this.clearCache(),
      watch: (listener) => this.events.on(listener),
    };
  }

  close(): void {
    this.closed = true;
    this.generation++;
    for (const off of this.offs) off();
    if (this.retryTimer) this.host.clearTimeout(this.retryTimer);
    if (this.evictTimer) this.host.clearTimeout(this.evictTimer);
    this.retryTimer = this.evictTimer = null;
  }
}
