/**
 * The workspace's records and their in-memory index (docs/data.md §2–§4) — Figma's file-browser rules, independent of
 * where the records live. The store's `LocalWorkspace` (src/store/local/workspace.ts) persists them as JSON files;
 * the browser's dev store (src/renderer/src/store/devStore.ts) keeps them in memory. Mutations are run by the caller
 * on `queue`, one at a time; every listing and search runs against the index.
 */
import type { FileQuery, WorkspaceEvent } from "./repositories";
import { Emitter } from "./emitter";
import { StoreError } from "./protocol";
import { SerialQueue } from "./queue";
import {
  FOLDER_COLORS,
  isFileKey,
  MAX_FOLDER_DEPTH,
  MAX_RECENTS,
  type FileKey,
  type FileListItem,
  type FileMeta,
  type Folder,
  type FolderColor,
  type FolderId,
  type Hlc,
  type Prefs,
  type Workspace,
} from "./types";

/** Case- and diacritic-insensitive form used by search. */
export function searchKey(s: string): string {
  // Dotless ı has no decomposition: fold it too, so "calis" finds "Çalışma".
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("en-US").replace(/ı/g, "i");
}

export function defaultPrefs(): Prefs {
  return { recents: [], viewedAt: {}, starred: { files: [], folders: [] }, browse: { layout: "grid", sort: "last-viewed" }, _clk: {} };
}

/** Where the records go: each call writes one record (atomically, in the local store). */
export interface WorkspacePersistence {
  workspace(w: Workspace): Promise<void>;
  prefs(p: Prefs): Promise<void>;
  folder(f: Folder): Promise<void>;
  removeFolder(id: FolderId): Promise<void>;
  meta(m: FileMeta): Promise<void>;
}

export interface WorkspaceModelDeps {
  /** Stamps record fields for later last-writer-wins (data.md §1) */
  hlc: { now(): Hlc };
  clock: { now(): number };
  persist: WorkspacePersistence;
}

export class WorkspaceModel {
  readonly folders = new Map<FolderId, Folder>();
  readonly files = new Map<FileKey, FileMeta>();
  readonly events = new Emitter<WorkspaceEvent>();
  readonly queue = new SerialQueue();
  /** Bytes on disk per file (filled in by the file store) */
  sizeOf: (fileKey: FileKey) => number = () => 0;
  protected readonly hlc: { now(): Hlc };
  protected readonly clock: { now(): number };
  protected readonly persist: WorkspacePersistence;

  constructor(
    public workspace: Workspace,
    public prefs: Prefs,
    deps: WorkspaceModelDeps,
  ) {
    this.hlc = deps.hlc;
    this.clock = deps.clock;
    this.persist = deps.persist;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------------------------------------------

  protected stamp(clk: Record<string, string>, fields: string[]): void {
    const h = this.hlc.now();
    for (const f of fields) clk[f] = h;
  }

  saveWorkspace(): Promise<void> {
    return this.persist.workspace(this.workspace);
  }

  savePrefs(): Promise<void> {
    return this.persist.prefs(this.prefs);
  }

  saveFolder(f: Folder): Promise<void> {
    return this.persist.folder(f);
  }

  saveMeta(m: FileMeta): Promise<void> {
    return this.persist.meta(m);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------------------------------------------

  getMeta(fileKey: FileKey): FileMeta {
    const m = this.files.get(fileKey);
    if (!m) throw new StoreError("not-found", `no file ${fileKey}`);
    return m;
  }

  getFolder(id: FolderId): Folder {
    const f = this.folders.get(id);
    if (!f) throw new StoreError("not-found", `no folder ${id}`);
    return f;
  }

  /** The folder or one of its ancestors is in Trash. */
  isFolderTrashed(id: FolderId | null): boolean {
    for (let cur = id, guard = 0; cur && guard <= MAX_FOLDER_DEPTH + 1; guard++) {
      const f = this.folders.get(cur);
      if (!f) return false;
      if (f.trashedAt !== null) return true;
      cur = f.parentId;
    }
    return false;
  }

  isFileTrashed(m: FileMeta): boolean {
    return m.trashedAt !== null || this.isFolderTrashed(m.folderId);
  }

  /** Depth of a folder: 1 at the top level. */
  folderDepth(id: FolderId): number {
    let d = 0;
    for (let cur: FolderId | null = id; cur && d <= MAX_FOLDER_DEPTH + 1; d++) cur = this.folders.get(cur)?.parentId ?? null;
    return d;
  }

  /** The folder and every folder under it. */
  subtree(id: FolderId): FolderId[] {
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const f of this.folders.values()) if (f.parentId === out[i]) out.push(f.id);
    return out;
  }

  private subtreeHeight(id: FolderId): number {
    const kids = [...this.folders.values()].filter((f) => f.parentId === id);
    return 1 + Math.max(0, ...kids.map((k) => this.subtreeHeight(k.id)));
  }

  item(m: FileMeta): FileListItem {
    return { ...m, starred: this.prefs.starred.files.includes(m.fileKey), lastViewedAt: this.prefs.viewedAt[m.fileKey] ?? null, sizeBytes: this.sizeOf(m.fileKey) };
  }

  listFolders(): Folder[] {
    return [...this.folders.values()].map((f) => ({ ...f }));
  }

  listFiles(q: FileQuery): FileListItem[] {
    const live = (m: FileMeta) => !this.isFileTrashed(m);
    const byModified = (a: FileMeta, b: FileMeta) => b.updatedAt - a.updatedAt;
    switch (q.in) {
      case "recents": {
        const out: FileListItem[] = [];
        for (const r of this.prefs.recents) {
          const m = this.files.get(r.fileKey);
          if (m && live(m)) out.push(this.item(m));
        }
        return out;
      }
      case "drafts":
        return [...this.files.values()].filter((m) => m.folderId === null && live(m)).sort(byModified).map((m) => this.item(m));
      case "folder": {
        this.getFolder(q.folderId);
        if (this.isFolderTrashed(q.folderId)) return [];
        return [...this.files.values()].filter((m) => m.folderId === q.folderId && m.trashedAt === null).sort(byModified).map((m) => this.item(m));
      }
      case "starred":
        return this.prefs.starred.files.map((k) => this.files.get(k)).filter((m): m is FileMeta => !!m && live(m)).map((m) => this.item(m));
      case "trash":
        return [...this.files.values()].filter((m) => m.trashedAt !== null).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0)).map((m) => this.item(m));
      case "search": {
        const needle = searchKey(q.text.trim());
        if (!needle) return [];
        return [...this.files.values()].filter((m) => live(m) && searchKey(m.name).includes(needle)).sort(byModified).map((m) => this.item(m));
      }
    }
  }

  /** Folders whose name matches (for Home's search results), not trashed. */
  searchFolders(text: string): Folder[] {
    const needle = searchKey(text.trim());
    if (!needle) return [];
    return [...this.folders.values()].filter((f) => !this.isFolderTrashed(f.id) && searchKey(f.name).includes(needle));
  }

  getFile(fileKey: FileKey): FileListItem {
    return this.item(this.getMeta(fileKey));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Mutations (callers run them on `queue`)
  // ---------------------------------------------------------------------------------------------------------------

  async updateWorkspace(patch: Partial<Pick<Workspace, "teamName" | "defaultLibraries">>): Promise<Workspace> {
    const fields: string[] = [];
    if (patch.teamName !== undefined) {
      if (typeof patch.teamName !== "string" || !patch.teamName.trim()) throw new StoreError("invalid", "a team name can't be empty");
      this.workspace.teamName = patch.teamName.trim();
      fields.push("teamName");
    }
    if (patch.defaultLibraries !== undefined) {
      if (!Array.isArray(patch.defaultLibraries) || !patch.defaultLibraries.every(isFileKey)) throw new StoreError("invalid", "defaultLibraries must be file keys");
      this.workspace.defaultLibraries = [...new Set(patch.defaultLibraries)];
      fields.push("defaultLibraries");
    }
    this.stamp(this.workspace._clk, fields);
    await this.saveWorkspace();
    this.events.emit({ type: "workspace.updated", workspace: { ...this.workspace } });
    return { ...this.workspace };
  }

  async setOwnerUid(uid: string | null): Promise<void> {
    this.workspace.ownerUid = uid;
    this.stamp(this.workspace._clk, ["ownerUid"]);
    await this.saveWorkspace();
    this.events.emit({ type: "workspace.updated", workspace: { ...this.workspace } });
  }

  private async changePrefs(fields: (keyof Prefs)[], mutate: (p: Prefs) => void): Promise<Prefs> {
    mutate(this.prefs);
    this.stamp(this.prefs._clk, fields as string[]);
    await this.savePrefs();
    const prefs = structuredClone(this.prefs);
    this.events.emit({ type: "prefs.updated", prefs });
    return structuredClone(this.prefs);
  }

  async setBrowsePrefs(patch: Partial<Prefs["browse"]>): Promise<Prefs> {
    if (patch.layout !== undefined && !["grid", "list"].includes(patch.layout)) throw new StoreError("invalid", `bad layout ${patch.layout}`);
    if (patch.sort !== undefined && !["last-viewed", "last-modified", "alphabetical", "date-created"].includes(patch.sort)) throw new StoreError("invalid", `bad sort ${patch.sort}`);
    return this.changePrefs(["browse"], (p) => {
      p.browse = { ...p.browse, ...(patch.layout ? { layout: patch.layout } : {}), ...(patch.sort ? { sort: patch.sort } : {}) };
    });
  }

  private checkName(name: unknown, what: string): string {
    if (typeof name !== "string") throw new StoreError("invalid", `a ${what} name must be a string`);
    const n = name.trim();
    if (!n) throw new StoreError("invalid", `a ${what} name can't be empty`);
    if (n.length > 512) throw new StoreError("invalid", `a ${what} name is at most 512 characters`);
    return n;
  }

  private checkParent(parentId: FolderId | null): void {
    if (parentId === null) return;
    const p = this.getFolder(parentId);
    if (this.isFolderTrashed(p.id)) throw new StoreError("trashed", "That folder is in Trash");
  }

  async createFolder(input: { name: string; parentId: FolderId | null; color?: FolderColor }, id: FolderId): Promise<Folder> {
    const name = this.checkName(input.name, "folder");
    const parentId = input.parentId ?? null;
    this.checkParent(parentId);
    if (parentId && this.folderDepth(parentId) + 1 > MAX_FOLDER_DEPTH) throw new StoreError("invalid", `Folders can be nested ${MAX_FOLDER_DEPTH} levels deep`);
    const color = input.color ?? "none";
    if (!FOLDER_COLORS.includes(color)) throw new StoreError("invalid", `bad folder color ${color}`);
    const now = this.clock.now();
    const folder: Folder = { id, name, parentId, color, createdAt: now, updatedAt: now, trashedAt: null, _clk: {} };
    this.stamp(folder._clk, ["name", "parentId", "color", "createdAt", "updatedAt", "trashedAt"]);
    await this.saveFolder(folder);
    this.folders.set(id, folder);
    this.events.emit({ type: "folder.created", folder: { ...folder } });
    return { ...folder };
  }

  async updateFolder(id: FolderId, patch: Partial<Pick<Folder, "name" | "color" | "parentId">>): Promise<Folder> {
    const folder = this.getFolder(id);
    const next: Folder = { ...folder, _clk: { ...folder._clk } };
    const fields: string[] = [];
    if (patch.name !== undefined) {
      next.name = this.checkName(patch.name, "folder");
      fields.push("name");
    }
    if (patch.color !== undefined) {
      if (!FOLDER_COLORS.includes(patch.color)) throw new StoreError("invalid", `bad folder color ${patch.color}`);
      next.color = patch.color;
      fields.push("color");
    }
    if (patch.parentId !== undefined && patch.parentId !== folder.parentId) {
      const parentId = patch.parentId;
      if (parentId !== null) {
        this.checkParent(parentId);
        if (this.subtree(id).includes(parentId)) throw new StoreError("invalid", "A folder can't be moved into itself");
        if (this.folderDepth(parentId) + this.subtreeHeight(id) > MAX_FOLDER_DEPTH) throw new StoreError("invalid", `Folders can be nested ${MAX_FOLDER_DEPTH} levels deep`);
      }
      next.parentId = parentId;
      fields.push("parentId");
    }
    next.updatedAt = this.clock.now();
    fields.push("updatedAt");
    this.stamp(next._clk, fields);
    await this.saveFolder(next);
    this.folders.set(id, next);
    this.events.emit({ type: "folder.updated", folder: { ...next } });
    return { ...next };
  }

  /** Adds a new file's record (its directory and snapshot already exist). */
  async addFile(meta: FileMeta): Promise<FileMeta> {
    this.stamp(meta._clk, ["name", "folderId", "createdAt", "updatedAt", "trashedAt", "enabledLibraries", "library", "importedFrom"]);
    await this.saveMeta(meta);
    this.files.set(meta.fileKey, meta);
    this.events.emit({ type: "file.created", file: { ...meta } });
    return { ...meta };
  }

  /** Writes fields of a file's record, stamping their clocks; emits `file.updated` unless told otherwise. */
  async patchFile(fileKey: FileKey, patch: Partial<Omit<FileMeta, "fileKey" | "_clk">>, opts: { silent?: boolean } = {}): Promise<FileMeta> {
    const m = this.getMeta(fileKey);
    const next: FileMeta = { ...m, ...patch, _clk: { ...m._clk } };
    this.stamp(next._clk, Object.keys(patch));
    await this.saveMeta(next);
    this.files.set(fileKey, next);
    if (!opts.silent) this.events.emit({ type: "file.updated", file: { ...next } });
    return { ...next };
  }

  async renameFile(fileKey: FileKey, name: string): Promise<FileMeta> {
    const n = this.checkName(name, "file");
    const m = await this.patchFile(fileKey, { name: n }, { silent: true });
    this.events.emit({ type: "file.renamed", fileKey, name: n });
    return m;
  }

  async moveFiles(fileKeys: FileKey[], folderId: FolderId | null): Promise<void> {
    if (folderId !== null) this.checkParent(folderId);
    for (const k of fileKeys) this.getMeta(k);
    for (const k of fileKeys) {
      if (this.getMeta(k).folderId === folderId) continue;
      await this.patchFile(k, { folderId }, { silent: true });
      this.events.emit({ type: "file.moved", fileKey: k, folderId });
    }
  }

  /** Files hidden by trashing a folder: everything under it not trashed on its own. */
  private filesUnder(folderIds: FolderId[]): FileMeta[] {
    const set = new Set(folderIds);
    return [...this.files.values()].filter((m) => m.folderId !== null && set.has(m.folderId) && m.trashedAt === null);
  }

  /** Moves items to Trash. Returns every file that became hidden (directly or through a folder). */
  async trash(items: { files?: FileKey[]; folders?: FolderId[] }): Promise<{ files: { fileKey: FileKey; viaFolder: FolderId | null }[] }> {
    const now = this.clock.now();
    const hidden: { fileKey: FileKey; viaFolder: FolderId | null }[] = [];
    for (const id of items.folders ?? []) this.getFolder(id);
    for (const k of items.files ?? []) this.getMeta(k);
    for (const id of items.folders ?? []) {
      const f = this.getFolder(id);
      if (f.trashedAt !== null) continue;
      // Files that were visible until now (not already hidden by a trashed folder above or below).
      const newlyHidden = this.filesUnder(this.subtree(id)).filter((m) => !this.isFileTrashed(m));
      const next: Folder = { ...f, trashedAt: now, updatedAt: now, _clk: { ...f._clk } };
      this.stamp(next._clk, ["trashedAt", "updatedAt"]);
      await this.saveFolder(next);
      this.folders.set(id, next);
      this.events.emit({ type: "folder.trashed", folder: { ...next } });
      for (const m of newlyHidden) {
        hidden.push({ fileKey: m.fileKey, viaFolder: id });
        this.events.emit({ type: "file.trashed", fileKey: m.fileKey, viaFolder: id });
      }
    }
    for (const k of items.files ?? []) {
      const m = this.getMeta(k);
      if (m.trashedAt !== null) continue;
      const wasHidden = this.isFileTrashed(m);
      await this.patchFile(k, { trashedAt: now }, { silent: true });
      if (!wasHidden) {
        hidden.push({ fileKey: k, viaFolder: null });
        this.events.emit({ type: "file.trashed", fileKey: k, viaFolder: null });
      }
    }
    return { files: hidden };
  }

  /** Restores items from Trash: a file whose folder is gone or trashed goes to Drafts; a folder whose parent is goes to the top. */
  async restore(items: { files?: FileKey[]; folders?: FolderId[] }): Promise<{ files: FileKey[] }> {
    const shown: FileKey[] = [];
    for (const id of items.folders ?? []) this.getFolder(id);
    for (const k of items.files ?? []) this.getMeta(k);
    for (const id of items.folders ?? []) {
      const f = this.getFolder(id);
      if (f.trashedAt === null) continue;
      const parentOk = f.parentId === null || (this.folders.has(f.parentId) && !this.isFolderTrashed(f.parentId));
      const next: Folder = { ...f, trashedAt: null, parentId: parentOk ? f.parentId : null, updatedAt: this.clock.now(), _clk: { ...f._clk } };
      this.stamp(next._clk, parentOk ? ["trashedAt", "updatedAt"] : ["trashedAt", "updatedAt", "parentId"]);
      await this.saveFolder(next);
      this.folders.set(id, next);
      this.events.emit({ type: "folder.restored", folder: { ...next } });
      for (const m of this.filesUnder(this.subtree(id))) {
        if (this.isFileTrashed(m)) continue;
        shown.push(m.fileKey);
        this.events.emit({ type: "file.restored", file: { ...m } });
      }
    }
    for (const k of items.files ?? []) {
      const m = this.getMeta(k);
      if (m.trashedAt === null && !this.isFolderTrashed(m.folderId)) continue;
      const folderOk = m.folderId === null || (this.folders.has(m.folderId) && !this.isFolderTrashed(m.folderId));
      const restored = await this.patchFile(k, folderOk ? { trashedAt: null } : { trashedAt: null, folderId: null }, { silent: true });
      shown.push(k);
      this.events.emit({ type: "file.restored", file: restored });
    }
    return { files: shown };
  }

  /** What deleting these items forever removes; every item must be in Trash. */
  collectDeletion(items: { files?: FileKey[]; folders?: FolderId[] }): { files: FileKey[]; folders: FolderId[] } {
    const files = new Set<FileKey>();
    const folders = new Set<FolderId>();
    for (const k of items.files ?? []) {
      if (!this.isFileTrashed(this.getMeta(k))) throw new StoreError("invalid", "Only items in Trash can be deleted forever");
      files.add(k);
    }
    for (const id of items.folders ?? []) {
      this.getFolder(id);
      if (!this.isFolderTrashed(id)) throw new StoreError("invalid", "Only items in Trash can be deleted forever");
      for (const sub of this.subtree(id)) folders.add(sub);
    }
    for (const m of this.files.values()) if (m.folderId && folders.has(m.folderId)) files.add(m.fileKey);
    return { files: [...files], folders: [...folders] };
  }

  /** Everything Empty Trash deletes: trashed files and the top-most trashed folders. */
  trashContents(): { files: FileKey[]; folders: FolderId[] } {
    const files = [...this.files.values()].filter((m) => m.trashedAt !== null).map((m) => m.fileKey);
    const folders = [...this.folders.values()].filter((f) => f.trashedAt !== null && !this.isFolderTrashed(f.parentId)).map((f) => f.id);
    return { files, folders };
  }

  /** Drops a deleted file from the index and the prefs. */
  async forgetFile(fileKey: FileKey): Promise<void> {
    if (!this.files.delete(fileKey)) return;
    const inPrefs = this.prefs.recents.some((r) => r.fileKey === fileKey) || this.prefs.starred.files.includes(fileKey) || fileKey in this.prefs.viewedAt;
    if (inPrefs)
      await this.changePrefs(["recents", "starred", "viewedAt"], (p) => {
        p.recents = p.recents.filter((r) => r.fileKey !== fileKey);
        p.starred.files = p.starred.files.filter((k) => k !== fileKey);
        delete p.viewedAt[fileKey];
      });
    if (this.workspace.defaultLibraries.includes(fileKey)) await this.updateWorkspace({ defaultLibraries: this.workspace.defaultLibraries.filter((k) => k !== fileKey) });
    this.events.emit({ type: "file.deleted", fileKey });
  }

  async forgetFolder(id: FolderId): Promise<void> {
    if (!this.folders.delete(id)) return;
    await this.persist.removeFolder(id);
    if (this.prefs.starred.folders.includes(id))
      await this.changePrefs(["starred"], (p) => {
        p.starred.folders = p.starred.folders.filter((f) => f !== id);
      });
    this.events.emit({ type: "folder.deleted", folderId: id });
  }

  async setStarred(target: { fileKey: FileKey } | { folderId: FolderId }, starred: boolean): Promise<void> {
    if ("fileKey" in target) {
      this.getMeta(target.fileKey);
      const has = this.prefs.starred.files.includes(target.fileKey);
      if (has === starred) return;
      await this.changePrefs(["starred"], (p) => {
        p.starred.files = starred ? [...p.starred.files, target.fileKey] : p.starred.files.filter((k) => k !== target.fileKey);
      });
    } else {
      this.getFolder(target.folderId);
      const has = this.prefs.starred.folders.includes(target.folderId);
      if (has === starred) return;
      await this.changePrefs(["starred"], (p) => {
        p.starred.folders = starred ? [...p.starred.folders, target.folderId] : p.starred.folders.filter((k) => k !== target.folderId);
      });
    }
  }

  async recordViewed(fileKey: FileKey): Promise<void> {
    this.getMeta(fileKey);
    const now = this.clock.now();
    await this.changePrefs(["recents", "viewedAt"], (p) => {
      p.recents = [{ fileKey, viewedAt: now }, ...p.recents.filter((r) => r.fileKey !== fileKey)].slice(0, MAX_RECENTS);
      p.viewedAt[fileKey] = now;
    });
  }

  async removeFromRecents(fileKey: FileKey): Promise<void> {
    if (!this.prefs.recents.some((r) => r.fileKey === fileKey)) return;
    await this.changePrefs(["recents"], (p) => {
      p.recents = p.recents.filter((r) => r.fileKey !== fileKey);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Records written elsewhere (a sync pull, another page of the browser demo): taken as they are — clocks included,
  // nothing stamped — and announced with the events a local change would have sent.
  // ---------------------------------------------------------------------------------------------------------------

  async adoptWorkspace(w: Workspace, opts: { persist: boolean }): Promise<void> {
    this.workspace = { ...w };
    if (opts.persist) await this.saveWorkspace();
    this.events.emit({ type: "workspace.updated", workspace: { ...this.workspace } });
  }

  async adoptPrefs(p: Prefs, opts: { persist: boolean }): Promise<void> {
    this.prefs = { ...defaultPrefs(), ...structuredClone(p) };
    if (opts.persist) await this.savePrefs();
    this.events.emit({ type: "prefs.updated", prefs: structuredClone(this.prefs) });
  }

  async adoptFolder(f: Folder, opts: { persist: boolean }): Promise<void> {
    const prev = this.folders.get(f.id);
    if (opts.persist) await this.saveFolder(f);
    this.folders.set(f.id, { ...f });
    if (!prev) this.events.emit({ type: "folder.created", folder: { ...f } });
    else if (prev.trashedAt === null && f.trashedAt !== null) this.events.emit({ type: "folder.trashed", folder: { ...f } });
    else if (prev.trashedAt !== null && f.trashedAt === null) this.events.emit({ type: "folder.restored", folder: { ...f } });
    else this.events.emit({ type: "folder.updated", folder: { ...f } });
  }

  dropFolder(id: FolderId): void {
    if (this.folders.delete(id)) this.events.emit({ type: "folder.deleted", folderId: id });
  }

  /** A file's record; `isNew` when it was not in the index (its data must exist already). */
  async adoptMeta(m: FileMeta, opts: { persist: boolean }): Promise<void> {
    const prev = this.files.get(m.fileKey);
    if (opts.persist) await this.saveMeta(m);
    this.files.set(m.fileKey, { ...m });
    const k = m.fileKey;
    if (!prev) {
      this.events.emit({ type: "file.created", file: { ...m } });
      return;
    }
    if (prev.name !== m.name) this.events.emit({ type: "file.renamed", fileKey: k, name: m.name });
    if (prev.folderId !== m.folderId) this.events.emit({ type: "file.moved", fileKey: k, folderId: m.folderId });
    if (prev.trashedAt === null && m.trashedAt !== null) this.events.emit({ type: "file.trashed", fileKey: k, viaFolder: null });
    else if (prev.trashedAt !== null && m.trashedAt === null) this.events.emit({ type: "file.restored", file: { ...m } });
    this.events.emit({ type: "file.updated", file: { ...m } });
  }

  dropFile(fileKey: FileKey): void {
    if (this.files.delete(fileKey)) this.events.emit({ type: "file.deleted", fileKey });
  }

  /** Starred folders that are not in Trash, in starring order (Home's sidebar). */
  starredFolders(): Folder[] {
    return this.prefs.starred.folders.map((id) => this.folders.get(id)).filter((f): f is Folder => !!f && !this.isFolderTrashed(f.id));
  }
}

export function newMeta(fileKey: FileKey, name: string, folderId: FolderId | null, now: number): FileMeta {
  return {
    fileKey,
    name,
    editorType: "design",
    folderId,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    thumbnail: null,
    enabledLibraries: [],
    library: { status: "none", latestVersion: null },
    importedFrom: null,
    _clk: {},
  };
}
