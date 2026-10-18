/**
 * Branches (docs/data.md §15.5): the `branches` repository over a store's files — create, list, rename, archive,
 * restore, the main-changed notice, merge previews (the three-way merge of src/shared/merge, cached ~10 minutes, one
 * per branch and direction), Update from main, Merge, and reviews. Local files keep `branch/branch.json` and
 * `branch/base.kiwi` beside the branch's journal; branches of shared (room) files go through the server's
 * `/branches/…` routes (§15.7, `RemoteBranches`).
 *
 * No Node or DOM imports: the desktop store (LocalStore, `localHost.ts`) and the browser's dev store (MemoryStore)
 * both run it over a `BranchHost`.
 */
import { decodeMessage, encodeMessage, SCHEMA_BINARY } from "../../shared/schema/codec";
import { messageImageHashes, NodeTable } from "../../shared/schema/patch";
import { ABSENT, mergeTables, MergeInvalidError, type Conflict, type MergeResult, type Resolutions, type Side } from "../../shared/merge";
import type { BranchEvent, BranchesRepository, BranchRecord, BranchReview, MergePreview } from "../../shared/merge/branches";
import { StoreError } from "../../shared/store/protocol";
import type { FileChange, OpenedFile, Unsubscribe, WorkspaceEvent } from "../../shared/store/repositories";
import type { FileBranch, FileKey, FileMeta, VersionId, VersionRecord } from "../../shared/store/types";
import type { RemoteBranches } from "./remote";
import { t as tr } from "../../shared/i18n";

/** Session numbers a branch reserves on its main file at a time (docs/data.md §15.2) */
export const SESSION_BLOCK = 4096;
/** A merge preview stays valid this long */
export const PREVIEW_TTL_MS = 10 * 60 * 1000;
/** At most this many previews (three tables each) are held */
export const MAX_PREVIEWS = 4;
/** The main-changed notice is sent at most this often per branch */
export const MAIN_CHANGED_THROTTLE_MS = 1000;
/** A shared branch's preview waits this long for the copies to catch up with their rooms, then shows what they hold */
export const PREVIEW_CATCH_UP_MS = 5000;

/** What the store gives the service. */
export interface BranchHost {
  now(): number;
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void;
  getMeta(fileKey: FileKey): FileMeta | null;
  metas(): FileMeta[];
  patchMeta(fileKey: FileKey, patch: Partial<Pick<FileMeta, "name" | "branch">>): Promise<FileMeta>;
  /** Journal fsync'ed */
  flush(fileKey: FileKey): Promise<void>;
  headTable(fileKey: FileKey): Promise<{ table: NodeTable; seq: number }>;
  headSeq(fileKey: FileKey): Promise<number>;
  addVersion(fileKey: FileKey, input: { kind: VersionRecord["kind"]; title: string | null; description: string | null }): Promise<VersionRecord>;
  /** A store batch (sessionID 0), refused with `stale` unless the head is still `expectSeq`; open editors get it as remote changes */
  appendSystem(fileKey: FileKey, message: Uint8Array, opts: { kind: "merge" | "update"; label: string; expectSeq: number; blobRefsAdded: string[] }): Promise<number>;
  /** Reserves `size` session numbers on a file; the first one */
  reserveSessionBlock(fileKey: FileKey, size: number): Promise<number>;
  /**
   * A new file holding `fromFileKey`'s version `versionId` as it is (same GUIDs, keys and bookkeeping), with `meta`'s
   * name, folder, libraries and `branch`; its sessions start at `sessions.start` and its block ends at `sessions.end`.
   */
  createBranchFile(input: { fromFileKey: FileKey; versionId: VersionId; name: string; folderId: FileMeta["folderId"]; enabledLibraries: FileKey[]; branch: FileBranch; sessions: { start: number; end: number } }): Promise<FileMeta>;
  /** branch.json */
  loadRecord(branchFileKey: FileKey): Promise<BranchRecord | null>;
  saveRecord(record: BranchRecord): Promise<void>;
  /** base.kiwi: main's version (at create) or a snapshot Message (at Update from main) */
  writeBaseFromVersion(branchFileKey: FileKey, mainFileKey: FileKey, versionId: VersionId): Promise<void>;
  writeBase(branchFileKey: FileKey, snapshot: Uint8Array): Promise<void>;
  readBase(branchFileKey: FileKey): Promise<NodeTable>;
  /** The library version a copy was taken at (merge rule 8): the version whose manifest has the asset at that hash */
  libraryVersionOf?(libraryKey: string, assetKey: string, versionHash: string): Promise<number | null>;
  /** Journal changes (main-changed notices) and the workspace's (renames of a branch file) */
  readonly fileChanges: { on(listener: (c: FileChange) => void): Unsubscribe };
  readonly workspaceEvents?: { on(listener: (e: WorkspaceEvent) => void): Unsubscribe };
  /** The signed-in person (null: the local user) */
  user(): { id: string | null; name: string | null };
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Shared mains (§15.7): the server's routes, and the files' links; absent → local branches only */
  remote?: RemoteBranches | null;
}

interface CachedPreview {
  /** Library copies' version numbers, looked up once (merge rule 8) */
  versions: Map<string, number | null>;
  previewId: string;
  branchFileKey: FileKey;
  direction: "merge" | "update";
  base: NodeTable;
  main: NodeTable;
  branch: NodeTable;
  mainHeadSeq: number;
  branchHeadSeq: number;
  resolutions: Resolutions;
  at: number;
}

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function randomId(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ID_ALPHABET[b % 62];
  return s;
}

/** Conflict values as they travel (structured clone has no symbols): ABSENT → undefined. */
function wireValue(v: unknown): unknown {
  return v === ABSENT ? undefined : v;
}
function wireConflict(c: Conflict): Conflict {
  return { ...c, base: wireValue(c.base), main: wireValue(c.main), branch: wireValue(c.branch) };
}

const cleanName = (name: unknown): string => {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) throw new StoreError("invalid", tr("A branch needs a name"));
  if (n.length > 256) throw new StoreError("invalid", tr("That name is too long"));
  return n;
};

export class BranchService {
  private records = new Map<FileKey, BranchRecord>();
  private loaded: Promise<void> | null = null;
  private readonly listeners = new Set<(e: BranchEvent) => void>();
  private readonly previews = new Map<string, CachedPreview>();
  private readonly throttle = new Map<FileKey, { last: number; timer: unknown; seq: number }>();
  /** Serializes the writes of one branch (and its main's merge) */
  private chain = new Map<FileKey, Promise<unknown>>();
  private offs: Unsubscribe[] = [];

  constructor(private readonly host: BranchHost) {
    this.offs.push(host.fileChanges.on((c) => this.onFileChange(c)));
    if (host.workspaceEvents) this.offs.push(host.workspaceEvents.on((e) => this.onWorkspace(e)));
  }

  close(): void {
    for (const off of this.offs) off();
    for (const t of this.throttle.values()) if (t.timer) this.host.clearTimeout(t.timer);
    this.throttle.clear();
    this.previews.clear();
  }

  onEvent(listener: (e: BranchEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: BranchEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        this.host.log("warn", "a branch listener failed", err);
      }
    }
  }

  /** Loads every local branch's record (once). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      for (const m of this.host.metas()) {
        if (!m.branch) continue;
        try {
          const r = await this.host.loadRecord(m.fileKey);
          if (r) this.records.set(m.fileKey, r);
        } catch (e) {
          this.host.log("warn", `branch ${m.fileKey}: its record couldn't be read`, e);
        }
      }
    })();
    return this.loaded;
  }

  /** A file deleted for good: its record goes. */
  forget(fileKey: FileKey): void {
    this.records.delete(fileKey);
    for (const [id, p] of this.previews) if (p.branchFileKey === fileKey) this.previews.delete(id);
  }

  private serial<T>(key: FileKey, fn: () => Promise<T>): Promise<T> {
    const prev = this.chain.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.chain.set(key, tail);
    void tail.then(() => {
      if (this.chain.get(key) === tail) this.chain.delete(key);
    });
    return run;
  }

  private async record(branchFileKey: FileKey): Promise<BranchRecord> {
    await this.load();
    const r = this.records.get(branchFileKey);
    if (!r) throw new StoreError("not-found", tr("No such branch"));
    return r;
  }

  private async save(r: BranchRecord): Promise<BranchRecord> {
    await this.host.saveRecord(r);
    this.records.set(r.branchFileKey, r);
    const m = this.host.getMeta(r.branchFileKey);
    const want: FileBranch = { mainFileKey: r.mainFileKey, name: r.name, status: r.status };
    if (m && (m.branch?.name !== want.name || m.branch?.status !== want.status || m.branch?.mainFileKey !== want.mainFileKey || m.name !== r.name)) {
      await this.host.patchMeta(r.branchFileKey, { name: r.name, branch: want });
    }
    return structuredClone(r);
  }

  private mainMeta(fileKey: FileKey): FileMeta {
    const m = this.host.getMeta(fileKey);
    if (!m) throw new StoreError("not-found", tr("No such file"));
    return m;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------------------------------------------------

  private onFileChange(c: FileChange): void {
    if (!this.loaded) return;
    for (const r of this.records.values()) {
      if (r.mainFileKey !== c.fileKey || r.status !== "active") continue;
      this.mainChanged(r.branchFileKey, c.seq);
    }
  }

  /** "branch.main-changed", at most once a second per branch (the last seq always goes out). */
  private mainChanged(branchFileKey: FileKey, seq: number): void {
    const now = this.host.now();
    let t = this.throttle.get(branchFileKey);
    if (!t) this.throttle.set(branchFileKey, (t = { last: 0, timer: null, seq }));
    t.seq = seq;
    if (t.timer) return;
    const send = () => {
      t!.timer = null;
      t!.last = this.host.now();
      this.emit({ type: "branch.main-changed", branchFileKey, mainHeadSeq: t!.seq });
    };
    if (now - t.last >= MAIN_CHANGED_THROTTLE_MS) send();
    else t.timer = this.host.setTimeout(send, MAIN_CHANGED_THROTTLE_MS - (now - t.last));
  }

  private onWorkspace(e: WorkspaceEvent): void {
    if (e.type === "file.deleted") return this.forget(e.fileKey);
    if (e.type !== "file.renamed") return;
    const r = this.records.get(e.fileKey);
    if (!r || r.name === e.name) return;
    // The branch's file renamed (its title in the editor): the branch is renamed with it.
    void this.serial(r.branchFileKey, async () => {
      const next = await this.save({ ...r, name: e.name });
      this.emit({ type: "branch.updated", branch: next });
    }).catch((err) => this.host.log("warn", `branch ${e.fileKey}: rename failed`, err));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Create, list, rename, archive, restore
  // -------------------------------------------------------------------------------------------------------------------

  async create(mainFileKey: FileKey, name: string): Promise<BranchRecord> {
    const n = cleanName(name);
    await this.load();
    const main = this.mainMeta(mainFileKey);
    if (main.branch) throw new StoreError("invalid", tr("A branch can't have branches of its own"));
    if (main.trashedAt !== null) throw new StoreError("trashed", tr("This file is in Trash"));
    const remote = this.host.remote;
    if (remote && (await remote.isShared(mainFileKey))) return this.createShared(mainFileKey, n);
    return this.serial(mainFileKey, async () => {
      await this.host.flush(mainFileKey);
      // 1–2. A "branch" version on main: the branch point.
      const v = await this.host.addVersion(mainFileKey, { kind: "branch", title: n, description: null });
      // 5. The GUID block (reserved first, so the copy's sessions start in it).
      const start = await this.host.reserveSessionBlock(mainFileKey, SESSION_BLOCK);
      // 3. The copy: the version's snapshot as it is (identity kept).
      const meta = await this.host.createBranchFile({
        fromFileKey: mainFileKey,
        versionId: v.id,
        name: n,
        folderId: main.folderId,
        enabledLibraries: [...main.enabledLibraries],
        branch: { mainFileKey, name: n, status: "active" },
        sessions: { start, end: start + SESSION_BLOCK },
      });
      // 4. base.kiwi and branch.json.
      await this.host.writeBaseFromVersion(meta.fileKey, mainFileKey, v.id);
      const user = this.host.user();
      const now = this.host.now();
      const rec: BranchRecord = {
        branchFileKey: meta.fileKey,
        mainFileKey,
        mainKey: null,
        branchKey: null,
        name: n,
        createdBy: { id: user.id, name: user.name },
        createdAt: now,
        status: "active",
        base: { mainSeq: v.seq, mainVersionId: v.id, at: now },
        mainSeenSeq: v.seq,
        archivedAt: null,
        mergedAt: null,
        mergedBy: null,
        mergeVersionId: null,
        review: null,
      };
      const saved = await this.save(rec);
      await this.host.addVersion(meta.fileKey, { kind: "branch", title: null, description: null });
      this.emit({ type: "branch.updated", branch: saved });
      return saved;
    });
  }

  /** A shared main's branch (§15.7): registered on the server, its room made from the branch point, linked here. */
  private async createShared(mainFileKey: FileKey, name: string): Promise<BranchRecord> {
    const remote = this.host.remote!;
    return this.serial(mainFileKey, async () => {
      await this.host.flush(mainFileKey);
      const v = await this.host.addVersion(mainFileKey, { kind: "branch", title: name, description: null });
      const start = await this.host.reserveSessionBlock(mainFileKey, SESSION_BLOCK);
      const meta = await this.host.createBranchFile({
        fromFileKey: mainFileKey,
        versionId: v.id,
        name,
        folderId: this.mainMeta(mainFileKey).folderId,
        enabledLibraries: [...this.mainMeta(mainFileKey).enabledLibraries],
        branch: { mainFileKey, name, status: "active" },
        // The room hands out sessions for shared files; the local block is still reserved so local GUIDs never collide.
        sessions: { start, end: start + SESSION_BLOCK },
      });
      await this.host.writeBaseFromVersion(meta.fileKey, mainFileKey, v.id);
      const base = await this.host.readBase(meta.fileKey);
      const snapshot = encodeMessage(base.toMessage());
      const { record: rec } = await remote.create({ mainFileKey, branchFileKey: meta.fileKey, name, snapshot });
      const saved = await this.save({ ...rec, base: { ...rec.base, mainVersionId: v.id } });
      await this.host.addVersion(meta.fileKey, { kind: "branch", title: null, description: null });
      this.emit({ type: "branch.updated", branch: saved });
      return saved;
    });
  }

  async list(mainFileKey: FileKey, tab: "active" | "archived" | "yours"): Promise<BranchRecord[]> {
    await this.load();
    this.mainMeta(mainFileKey);
    if (tab !== "active" && tab !== "archived" && tab !== "yours") throw new StoreError("invalid", `bad tab ${String(tab)}`);
    const remote = this.host.remote;
    if (remote && (await remote.isShared(mainFileKey))) {
      const rows = await remote.list(mainFileKey, tab);
      // Keep what the server says on the local copies' records.
      for (const r of rows) {
        const local = r.branchFileKey ? this.records.get(r.branchFileKey) : undefined;
        if (local) this.records.set(r.branchFileKey, { ...local, ...r, base: { ...r.base, mainVersionId: local.base.mainVersionId } });
        // A branch someone else made, opened here from Home (its room's local copy): taken in as a branch.
        else if (r.branchFileKey && this.host.getMeta(r.branchFileKey) && remote.canAdopt) await this.adopt(r).catch((e) => this.host.log("warn", `branch ${r.branchFileKey}: couldn't be taken in`, e));
      }
      return rows;
    }
    const me = this.host.user().id;
    const out = [...this.records.values()].filter((r) => {
      if (r.mainFileKey !== mainFileKey) return false;
      if (tab === "active") return r.status === "active";
      if (tab === "archived") return r.status !== "active";
      return r.createdBy.id === me;
    });
    return out.sort((a, b) => b.createdAt - a.createdAt).map((r) => structuredClone(r));
  }

  /**
   * A shared branch whose local copy was made from its room (opened from Home: `multiplayer.openShared` of the branch's
   * key) rather than by "Create branch" here: its base comes from the room, its record and `FileMeta.branch` are
   * written, and from then on it is a branch like one made here.
   */
  private adopt(r: BranchRecord): Promise<void> {
    return this.serial(r.branchFileKey, async () => {
      if (this.records.has(r.branchFileKey) || !r.branchKey) return;
      await this.host.writeBase(r.branchFileKey, await this.host.remote!.base(r.branchKey));
      await this.save(structuredClone(r));
    });
  }

  async get(branchFileKey: FileKey): Promise<BranchRecord | null> {
    await this.load();
    const r = this.records.get(branchFileKey);
    return r ? structuredClone(r) : null;
  }

  private async patch(branchFileKey: FileKey, change: (r: BranchRecord) => BranchRecord, remotePatch?: { name?: string; status?: "archived" | "active" }): Promise<BranchRecord> {
    return this.serial(branchFileKey, async () => {
      const r = await this.record(branchFileKey);
      let next = change(structuredClone(r));
      if (r.branchKey && remotePatch && this.host.remote) next = { ...next, ...(await this.host.remote.patch(r, remotePatch)), branchFileKey: r.branchFileKey, base: next.base };
      const saved = await this.save(next);
      this.emit({ type: "branch.updated", branch: saved });
      return saved;
    });
  }

  rename(branchFileKey: FileKey, name: string): Promise<BranchRecord> {
    const n = cleanName(name);
    return this.patch(branchFileKey, (r) => ({ ...r, name: n }), { name: n });
  }

  archive(branchFileKey: FileKey): Promise<BranchRecord> {
    return this.patch(
      branchFileKey,
      (r) => {
        if (r.status === "merged") return r;
        return { ...r, status: "archived", archivedAt: r.archivedAt ?? this.host.now() };
      },
      { status: "archived" },
    );
  }

  restore(branchFileKey: FileKey): Promise<BranchRecord> {
    return this.patch(
      branchFileKey,
      (r) => {
        if (r.status === "merged") throw new StoreError("invalid", tr("A merged branch can't be restored. Duplicate it instead."));
        return { ...r, status: "active", archivedAt: null };
      },
      { status: "active" },
    );
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The notice, previews, Update from main, Merge
  // -------------------------------------------------------------------------------------------------------------------

  async mainStatus(branchFileKey: FileKey): Promise<{ changed: boolean; mainHeadSeq: number; baseSeq: number }> {
    const r = await this.record(branchFileKey);
    // A shared main's seqs are its room's (§15.7); a local one's, its journal's.
    const mainHeadSeq = r.branchKey && this.host.remote ? await this.host.remote.roomSeq(r.mainFileKey) : await this.host.headSeq(r.mainFileKey);
    return { changed: mainHeadSeq !== r.base.mainSeq, mainHeadSeq, baseSeq: r.base.mainSeq };
  }

  private active(r: BranchRecord): void {
    if (r.status !== "active") throw new StoreError("invalid", r.status === "merged" ? tr("This branch was merged") : tr("This branch is archived"));
  }

  /** The three tables of a merge now: base, main's head, the branch's head (both flushed). */
  private async sides(r: BranchRecord): Promise<{ base: NodeTable; main: NodeTable; branch: NodeTable; mainHeadSeq: number; branchHeadSeq: number }> {
    // A shared branch's preview reads main's and the branch's copies as their rooms have them (main's room joined if
    // this tab isn't in it); offline, it shows what the copies hold — the merge itself then refuses (`catchUp`).
    if (r.branchKey && this.host.remote) (await this.catchUpBoth(r, PREVIEW_CATCH_UP_MS).catch((e) => (this.host.log("info", "branch preview: the copies aren't caught up", e), null)))?.();
    await Promise.all([this.host.flush(r.mainFileKey), this.host.flush(r.branchFileKey)]);
    const [base, main, branch] = await Promise.all([this.host.readBase(r.branchFileKey), this.host.headTable(r.mainFileKey), this.host.headTable(r.branchFileKey)]);
    return { base, main: main.table, branch: branch.table, mainHeadSeq: main.seq, branchHeadSeq: branch.seq };
  }

  /** Both copies of a shared branch caught up with their rooms (`RemoteBranches.catchUp`); resolves with the release */
  private async catchUpBoth(r: BranchRecord, timeoutMs?: number): Promise<() => void> {
    const remote = this.host.remote!;
    const releases: (() => void)[] = [];
    const releaseAll = () => releases.forEach((f) => f());
    try {
      const got = await Promise.allSettled([remote.catchUp(r.mainFileKey, timeoutMs), remote.catchUp(r.branchFileKey, timeoutMs)]);
      for (const g of got) if (g.status === "fulfilled") releases.push(g.value);
      const failed = got.find((g): g is PromiseRejectedResult => g.status === "rejected");
      if (failed) throw failed.reason;
    } catch (e) {
      releaseAll();
      throw e;
    }
    return releaseAll;
  }

  /** The version numbers of the library copies main and the branch hold at different versions (merge rule 8). */
  private async copyVersions(main: NodeTable, branch: NodeTable): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (!this.host.libraryVersionOf) return out;
    for (const [k, m] of main.nodes) {
      if (!m.sourceLibraryKey || !m.version) continue;
      const b = branch.nodes.get(k);
      if (!b?.version || b.version === m.version) continue;
      for (const h of [m.version, b.version]) {
        const id = `${m.sourceLibraryKey}\u0000${m.key ?? ""}\u0000${h}`;
        if (!out.has(id)) out.set(id, await this.host.libraryVersionOf(m.sourceLibraryKey, m.key ?? "", h).catch(() => null));
      }
    }
    return out;
  }

  private run(p: Pick<CachedPreview, "base" | "main" | "branch" | "direction" | "versions">, resolutions: Resolutions) {
    try {
      return mergeTables({ base: p.base, main: p.main, branch: p.branch, direction: p.direction, resolutions }, { libraryVersion: (l, k, h) => p.versions.get(`${l}\u0000${k}\u0000${h}`) ?? null });
    } catch (e) {
      if (e instanceof MergeInvalidError) throw new StoreError("invalid", e.message, { guids: e.guids });
      throw e;
    }
  }

  private toPreview(p: CachedPreview, result: MergeResult): MergePreview {
    return {
      previewId: p.previewId,
      direction: p.direction,
      mainHeadSeq: p.mainHeadSeq,
      branchHeadSeq: p.branchHeadSeq,
      chunks: result.chunks,
      conflicts: result.conflicts.map(wireConflict),
      unresolved: result.unresolved,
      stats: result.stats,
    };
  }

  private sweepPreviews(): void {
    const now = this.host.now();
    for (const [id, p] of this.previews) if (now - p.at > PREVIEW_TTL_MS) this.previews.delete(id);
    while (this.previews.size > MAX_PREVIEWS) this.previews.delete(this.previews.keys().next().value!);
  }

  async preview(branchFileKey: FileKey, direction: "merge" | "update", resolutions: Resolutions = {}): Promise<MergePreview> {
    if (direction !== "merge" && direction !== "update") throw new StoreError("invalid", `bad direction ${String(direction)}`);
    const res = checkResolutions(resolutions);
    // One at a time per branch, in call order: each replaces the one before (below), so the last one asked for is the
    // one kept — two at once (a window opened twice) used to finish in either order, and the window then held an id
    // the service had already dropped ("This preview has expired", Preview unavailable on both sides).
    return this.serial(branchFileKey, async () => {
      const r = await this.record(branchFileKey);
      this.active(r);
      const sides = await this.sides(r);
      // One preview per branch and direction.
      for (const [id, p] of this.previews) if (p.branchFileKey === branchFileKey && p.direction === direction) this.previews.delete(id);
      const versions = await this.copyVersions(sides.main, sides.branch);
      const cached: CachedPreview = { previewId: randomId(22), branchFileKey, direction, ...sides, versions, resolutions: res, at: this.host.now() };
      const { result } = this.run(cached, res);
      this.previews.set(cached.previewId, cached);
      this.sweepPreviews();
      return this.toPreview(cached, result);
    });
  }

  private cached(previewId: string): CachedPreview {
    this.sweepPreviews();
    const p = this.previews.get(previewId);
    if (!p) throw new StoreError("stale", tr("This preview has expired. Review the changes again."));
    return p;
  }

  async openSide(previewId: string, side: "base" | "main" | "branch" | "merged"): Promise<OpenedFile> {
    const p = this.cached(previewId);
    const r = await this.record(p.branchFileKey);
    let table: NodeTable;
    let seq: number;
    switch (side) {
      case "base":
        table = p.base;
        seq = r.base.mainSeq;
        break;
      case "main":
        table = p.main;
        seq = p.mainHeadSeq;
        break;
      case "branch":
        table = p.branch;
        seq = p.branchHeadSeq;
        break;
      case "merged":
        table = this.run(p, p.resolutions).merged.toTable();
        seq = p.direction === "merge" ? p.mainHeadSeq : p.branchHeadSeq;
        break;
      default:
        throw new StoreError("invalid", `bad side ${String(side)}`);
    }
    const metaKey = side === "branch" || (side === "merged" && p.direction === "update") ? r.branchFileKey : r.mainFileKey;
    const meta = this.host.getMeta(metaKey) ?? this.mainMeta(r.branchFileKey);
    // Without derived data: the Compare view loads it with `mergedDocument` (snapshot + journal, derived dropped).
    return viewOf(meta, encodeMessage(table.toMessage()), seq, 0);
  }

  /** The preview's merge again, with the final resolutions, after checking that neither head moved. */
  private async final(branchFileKey: FileKey, previewId: string, direction: "merge" | "update", resolutions: Resolutions) {
    const p = this.cached(previewId);
    if (p.branchFileKey !== branchFileKey || p.direction !== direction) throw new StoreError("stale", tr("This preview is for another change. Review the changes again."));
    const r = await this.record(branchFileKey);
    this.active(r);
    await Promise.all([this.host.flush(r.mainFileKey), this.host.flush(r.branchFileKey)]);
    const [mainSeq, branchSeq] = await Promise.all([this.host.headSeq(r.mainFileKey), this.host.headSeq(r.branchFileKey)]);
    if (mainSeq !== p.mainHeadSeq || branchSeq !== p.branchHeadSeq) {
      this.previews.delete(previewId);
      throw new StoreError("stale", tr("The files changed since the preview. Review the changes again."));
    }
    const out = this.run(p, checkResolutions(resolutions));
    if (out.result.unresolved.length) throw new StoreError("invalid", tr("Resolve every conflict first"), { unresolved: out.result.unresolved });
    return { p, r, result: out.result };
  }

  async applyUpdate(branchFileKey: FileKey, input: { previewId: string; resolutions: Resolutions }): Promise<BranchRecord> {
    return this.serial(branchFileKey, () => this.caughtUp(branchFileKey, async () => {
      const { p, r, result } = await this.final(branchFileKey, input?.previewId, "update", input?.resolutions ?? {});
      const batch = result.batch;
      if (r.branchKey && this.host.remote) return this.applyUpdateShared(p, r, encodeMessage(batch));
      // Savepoints on both files first (Figma's, atlas 16 §3.2: restoring the branch's takes the update back).
      await this.host.addVersion(branchFileKey, { kind: "autosave", title: null, description: null });
      await this.host.addVersion(r.mainFileKey, { kind: "autosave", title: null, description: null });
      if (batch.nodeChanges?.length) {
        await this.host.appendSystem(branchFileKey, encodeMessage(batch), { kind: "update", label: "Updated from main", expectSeq: p.branchHeadSeq, blobRefsAdded: [...messageImageHashes(batch)] });
      }
      await this.host.addVersion(branchFileKey, { kind: "update", title: null, description: null });
      // The base becomes main's head as merged.
      await this.host.writeBase(branchFileKey, encodeMessage(p.main.toMessage()));
      const next: BranchRecord = { ...r, base: { mainSeq: p.mainHeadSeq, mainVersionId: null, at: this.host.now() }, mainSeenSeq: p.mainHeadSeq };
      this.previews.delete(p.previewId);
      const saved = await this.save(next);
      this.emit({ type: "branch.updated", branch: saved });
      return saved;
    }));
  }

  async merge(branchFileKey: FileKey, input: { previewId: string; resolutions: Resolutions; title?: string; description?: string }): Promise<{ branch: BranchRecord; version: VersionRecord }> {
    const r0 = await this.record(branchFileKey);
    return this.serial(r0.mainFileKey, () =>
      this.serial(branchFileKey, () => this.caughtUp(branchFileKey, async () => {
        const { p, r, result } = await this.final(branchFileKey, input?.previewId, "merge", input?.resolutions ?? {});
        const title = typeof input?.title === "string" && input.title.trim() ? input.title.trim() : r.name;
        const description = typeof input?.description === "string" && input.description.trim() ? input.description.trim() : null;
        if (r.branchKey && this.host.remote) return this.mergeShared(p, r, encodeMessage(result.batch), title, description);
        // 4. The pre-merge checkpoints on both files (Figma's savepoints; restoring main's undoes the merge).
        const before = await this.host.addVersion(r.mainFileKey, { kind: "autosave", title: null, description: null });
        await this.host.addVersion(branchFileKey, { kind: "autosave", title: null, description: null });
        // 5. One batch on main.
        const batch = result.batch;
        if (batch.nodeChanges?.length) {
          await this.host.appendSystem(r.mainFileKey, encodeMessage(batch), { kind: "merge", label: `Merged ${r.name}`, expectSeq: p.mainHeadSeq, blobRefsAdded: [...messageImageHashes(batch)] });
        }
        // 6. Main's "Branch merged" version; 7. the branch's, and its record.
        const version = await this.host.addVersion(r.mainFileKey, { kind: "merge", title, description });
        await this.host.addVersion(branchFileKey, { kind: "merge", title, description });
        const now = this.host.now();
        const me = this.host.user();
        const next: BranchRecord = { ...r, status: "merged", mergedAt: now, mergedBy: me.id, mergeVersionId: version.id, preMergeVersionId: before.id, archivedAt: r.archivedAt ?? now };
        this.previews.delete(p.previewId);
        const saved = await this.save(next);
        this.emit({ type: "branch.merged", branch: saved });
        return { branch: saved, version };
      })),
    );
  }

  /**
   * Runs a shared branch's merge or update with both copies caught up with their rooms (§15.5 step 1) — main's room
   * joined for it when this client isn't in it (a browser tab with only the branch open) — so `final` compares the
   * preview with the rooms' documents; `offline` after CATCH_UP_TIMEOUT_MS instead of waiting forever. Local branches:
   * `fn` as it is.
   */
  private async caughtUp<T>(branchFileKey: FileKey, fn: () => Promise<T>): Promise<T> {
    const r = await this.record(branchFileKey);
    if (!r.branchKey || !this.host.remote) return fn();
    const release = await this.catchUpBoth(r);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * The rooms' seqs of both local copies, caught up (`caughtUp`, §15.5 step 1) and still holding exactly the documents
   * the preview read — a frame that landed since is `stale` — so the server's head check is exact.
   */
  private async roomSeqs(r: BranchRecord, p: CachedPreview): Promise<{ mainSeq: number; branchSeq: number }> {
    const remote = this.host.remote!;
    if (!(await remote.caughtUp(r.mainFileKey)) || !(await remote.caughtUp(r.branchFileKey))) throw new StoreError("offline", tr("Couldn’t reach this file’s room. Check your connection and try again."));
    const seqs = { mainSeq: await remote.roomSeq(r.mainFileKey), branchSeq: await remote.roomSeq(r.branchFileKey) };
    const [mainHead, branchHead] = await Promise.all([this.host.headSeq(r.mainFileKey), this.host.headSeq(r.branchFileKey)]);
    if (mainHead !== p.mainHeadSeq || branchHead !== p.branchHeadSeq) {
      this.previews.delete(p.previewId);
      throw new StoreError("stale", tr("The files changed since the preview. Review the changes again."));
    }
    return seqs;
  }

  /** Update from main of a shared branch: one call; the frame comes back to the branch's copy through its link. */
  private async applyUpdateShared(p: CachedPreview, r: BranchRecord, batch: Uint8Array): Promise<BranchRecord> {
    const remote = this.host.remote!;
    const seqs = await this.roomSeqs(r, p);
    const base = encodeMessage(p.main.toMessage());
    const res = await remote.update(r, { ...seqs, base, batch });
    await this.host.writeBase(r.branchFileKey, base);
    this.previews.delete(p.previewId);
    const saved = await this.save({ ...res.record, branchFileKey: r.branchFileKey, base: { ...res.record.base, at: this.host.now() } });
    this.emit({ type: "branch.updated", branch: saved });
    return saved;
  }

  /** Merge of a shared branch: one call (freeze, pre-merge autosave, frame, versions on both rooms). */
  private async mergeShared(p: CachedPreview, r: BranchRecord, batch: Uint8Array, title: string, description: string | null): Promise<{ branch: BranchRecord; version: VersionRecord }> {
    const remote = this.host.remote!;
    const seqs = await this.roomSeqs(r, p);
    const res = await remote.merge(r, { ...seqs, title, ...(description ? { description } : {}), batch });
    const version = await remote.version(r.mainFileKey, res.versionId).catch(
      (): VersionRecord => ({ id: res.versionId, kind: "merge", title, description, createdAt: this.host.now(), seq: res.mainSeq, sizeBytes: 0, blobRefs: [], restoredFrom: null, libraryVersion: null }),
    );
    this.previews.delete(p.previewId);
    const saved = await this.save({ ...res.record, branchFileKey: r.branchFileKey, base: r.base });
    this.emit({ type: "branch.merged", branch: saved });
    return { branch: saved, version };
  }

  /**
   * Undo merge: the branch as it was before its merge — active, its review and base kept — so it can be changed and
   * merged again. Main's own going back is the editor's restore of `preMergeVersionId`. Local merges only (a shared
   * one is the server's: Phase 6).
   */
  async undoMerge(branchFileKey: FileKey): Promise<BranchRecord> {
    return this.serial(branchFileKey, async () => {
      const r = await this.record(branchFileKey);
      if (r.status !== "merged") throw new StoreError("invalid", tr("This branch wasn't merged"));
      if (r.branchKey || !r.preMergeVersionId) throw new StoreError("invalid", tr("This merge can't be undone"));
      const saved = await this.save({ ...r, status: "active", mergedAt: null, mergedBy: null, mergeVersionId: null, preMergeVersionId: null, archivedAt: null });
      this.emit({ type: "branch.updated", branch: saved });
      return saved;
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------------------------------------------------

  async requestReview(branchFileKey: FileKey, input: { reviewerIds: string[]; description: string }): Promise<BranchReview> {
    const ids = Array.isArray(input?.reviewerIds) ? [...new Set(input.reviewerIds.filter((x): x is string => typeof x === "string" && !!x))] : [];
    const description = typeof input?.description === "string" ? input.description.trim() : "";
    return this.serial(branchFileKey, async () => {
      const r = await this.record(branchFileKey);
      this.active(r);
      let review: BranchReview;
      if (r.branchKey && this.host.remote) review = await this.host.remote.requestReview(r, ids, description);
      else {
        const now = this.host.now();
        // "Request another review": the same review, reopened with every verdict pending.
        const prev = r.review && r.review.state !== "closed" ? r.review : null;
        review = {
          id: prev?.id ?? randomId(16),
          state: "in-review",
          requestedBy: this.host.user().id,
          description: description || prev?.description || "",
          createdAt: prev?.createdAt ?? now,
          reviewers: (ids.length ? ids : (prev?.reviewers.map((x) => x.userId) ?? [])).map((userId) => ({ userId, name: prev?.reviewers.find((x) => x.userId === userId)?.name ?? null, verdict: "pending" as const, comment: "", at: null })),
        };
      }
      const saved = await this.save({ ...r, review });
      this.emit({ type: "branch.updated", branch: saved });
      return structuredClone(review);
    });
  }

  async answerReview(branchFileKey: FileKey, input: { verdict: "approved" | "changes-suggested"; comment?: string }): Promise<BranchReview> {
    const verdict = input?.verdict;
    if (verdict !== "approved" && verdict !== "changes-suggested") throw new StoreError("invalid", `bad verdict ${String(verdict)}`);
    const comment = typeof input?.comment === "string" ? input.comment.trim() : "";
    return this.serial(branchFileKey, async () => {
      const r = await this.record(branchFileKey);
      if (!r.review || r.review.state === "closed") throw new StoreError("invalid", tr("No review was requested"));
      let review: BranchReview;
      if (r.branchKey && this.host.remote) review = await this.host.remote.answerReview(r, verdict, comment);
      else {
        const me = this.host.user();
        const id = me.id ?? "local";
        const reviewers = r.review.reviewers.some((x) => x.userId === id) ? r.review.reviewers : [...r.review.reviewers, { userId: id, name: me.name, verdict: "pending" as const, comment: "", at: null }];
        review = {
          ...r.review,
          // The review's state is the latest verdict.
          state: verdict,
          reviewers: reviewers.map((x) => (x.userId === id ? { ...x, verdict, comment, at: this.host.now() } : x)),
        };
      }
      const saved = await this.save({ ...r, review });
      this.emit({ type: "branch.updated", branch: saved });
      return structuredClone(review);
    });
  }

  /** The next GUID block of a branch that ran out of its own (FileStore asks; docs/data.md §15.2). */
  async nextSessionBlock(branchFileKey: FileKey): Promise<{ start: number; end: number } | null> {
    await this.load();
    const r = this.records.get(branchFileKey);
    if (!r) return null;
    const start = await this.host.reserveSessionBlock(r.mainFileKey, SESSION_BLOCK);
    return { start, end: start + SESSION_BLOCK };
  }

  /** Publishing is main's (docs/data.md §15.5). */
  checkCanPublish(fileKey: FileKey): void {
    if (this.host.getMeta(fileKey)?.branch) throw new StoreError("branch-cannot-publish", tr("Libraries are published from the main file. Merge this branch first."));
  }

  /** Archived and merged branches open read-only. */
  openMode(fileKey: FileKey, mode: "edit" | "view"): "edit" | "view" {
    const b = this.host.getMeta(fileKey)?.branch;
    return mode === "edit" && b && b.status !== "active" ? "view" : mode;
  }

  /** The repository, as StoreApi serves it. */
  repository(): BranchesRepository {
    return {
      create: (mainFileKey, name) => this.create(mainFileKey, name),
      list: (mainFileKey, tab) => this.list(mainFileKey, tab),
      get: (branchFileKey) => this.get(branchFileKey),
      rename: (branchFileKey, name) => this.rename(branchFileKey, name),
      archive: (branchFileKey) => this.archive(branchFileKey),
      restore: (branchFileKey) => this.restore(branchFileKey),
      mainStatus: (branchFileKey) => this.mainStatus(branchFileKey),
      preview: (branchFileKey, direction, resolutions) => this.preview(branchFileKey, direction, resolutions ?? {}),
      openSide: (previewId, side) => this.openSide(previewId, side),
      applyUpdate: (branchFileKey, input) => this.applyUpdate(branchFileKey, input),
      merge: (branchFileKey, input) => this.merge(branchFileKey, input),
      requestReview: (branchFileKey, input) => this.requestReview(branchFileKey, input),
      answerReview: (branchFileKey, input) => this.answerReview(branchFileKey, input),
      undoMerge: (branchFileKey) => this.undoMerge(branchFileKey),
      watch: (listener) => this.onEvent(listener),
    };
  }
}

function checkResolutions(res: unknown): Resolutions {
  if (res == null) return {};
  if (typeof res !== "object" || Array.isArray(res)) throw new StoreError("invalid", "Resolutions are a map of conflict ids to sides");
  const out: Resolutions = {};
  for (const [k, v] of Object.entries(res as Record<string, unknown>)) {
    if (v !== "main" && v !== "branch") throw new StoreError("invalid", `bad side for ${k}`);
    out[k] = v as Side;
  }
  return out;
}

/** A read-only OpenedFile over a snapshot (Compare changes' sides). */
export function viewOf(meta: FileMeta, snapshot: Uint8Array, seq: number, derivedDataVersion: number, schema?: Uint8Array): OpenedFile {
  return {
    meta: { ...meta },
    mode: "view",
    sessionID: 0,
    schema: schema ?? SCHEMA_BINARY.slice(),
    snapshot,
    snapshotSeq: seq,
    derivedDataVersion,
    journal: [],
    headSeq: seq,
    ui: null,
    recovery: null,
  };
}

/** A snapshot Message's table (tests, hosts). */
export const tableOf = (snapshot: Uint8Array): NodeTable => NodeTable.fromMessage(decodeMessage(snapshot));

/**
 * The library version a copy was taken at (merge rule 8): the newest version of `libraryKey` whose manifest has asset
 * `assetKey` at `versionHash` (the last 200 versions looked at); null when none has.
 */
export async function libraryVersionOf(reg: { getRecord(lib: FileKey): Promise<{ latestVersion: number } | null> | { latestVersion: number } | null; getVersion(lib: FileKey, version?: number): Promise<{ assets: { key: string; versionHash: string }[] }> }, libraryKey: string, assetKey: string, versionHash: string): Promise<number | null> {
  const r = await reg.getRecord(libraryKey);
  if (!r) return null;
  for (let v = r.latestVersion; v >= 1 && v > r.latestVersion - 200; v--) {
    const ver = await reg.getVersion(libraryKey, v).catch(() => null);
    if (ver?.assets.some((a) => a.key === assetKey && a.versionHash === versionHash)) return v;
  }
  return null;
}
