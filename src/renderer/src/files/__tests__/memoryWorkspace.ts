/**
 * An in-memory WorkspaceRepository with the store's file-browser semantics (docs/data.md §4): Drafts, nested folders,
 * Recents, Starred, Trash (a trashed folder hides its contents; restore falls back to Drafts / the top level),
 * search, and the same watch events. Home's tests run on it, and `?files` in a plain browser uses it when the data
 * layer's dev store isn't there.
 */
import type { FileQuery, Unsubscribe, WorkspaceEvent, WorkspaceRepository } from "@shared/store/repositories";
import { MAX_FOLDER_DEPTH, MAX_RECENTS, type FileKey, type FileListItem, type FileMeta, type Folder, type FolderColor, type FolderId, type Prefs, type Workspace } from "@shared/store/types";
import { searchKey } from "../model";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const randomId = (n: number) => Array.from({ length: n }, () => BASE62[Math.floor(Math.random() * 62)]).join("");

class MemoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface MemoryWorkspaceOptions {
  teamName?: string;
  now?: () => number;
  /** Event delivery: sync in tests, a microtask by default (as the RPC client's) */
  sync?: boolean;
}

/** Extra calls the browser fallback offers where the real store needs main (a path). */
export interface MemoryExtras {
  /** `.fig` import from bytes (the memory store only records the file; it doesn't decode it) */
  importFig(name: string, folderId: FolderId | null): Promise<FileMeta>;
  /** Demo thumbnails (data: URLs), keyed by file */
  thumbnails: Map<FileKey, string>;
}

export class MemoryWorkspace implements WorkspaceRepository, MemoryExtras {
  private workspace: Workspace;
  private prefs: Prefs;
  private readonly folders = new Map<FolderId, Folder>();
  private readonly files = new Map<FileKey, FileMeta>();
  private readonly listeners = new Set<(e: WorkspaceEvent) => void>();
  readonly thumbnails = new Map<FileKey, string>();
  private readonly now: () => number;
  private readonly sync: boolean;
  private last = 0;

  constructor(opts: MemoryWorkspaceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sync = opts.sync ?? false;
    const t = this.now();
    this.workspace = { wid: randomId(16), formatVersion: 1, teamName: opts.teamName ?? "My team", createdAt: t, defaultLibraries: [], ownerUid: null, _clk: {} };
    this.prefs = { recents: [], viewedAt: {}, starred: { files: [], folders: [] }, browse: { layout: "grid", sort: "last-viewed" }, _clk: {} };
  }

  /** Strictly increasing time, so orderings are stable within one millisecond. */
  private tick(): number {
    this.last = Math.max(this.now(), this.last + 1);
    return this.last;
  }

  private emit(e: WorkspaceEvent) {
    const deliver = () => this.listeners.forEach((l) => l(structuredClone(e)));
    if (this.sync) deliver();
    else queueMicrotask(deliver);
  }

  private meta(fileKey: FileKey): FileMeta {
    const m = this.files.get(fileKey);
    if (!m) throw new MemoryError("not-found", "That file doesn't exist");
    return m;
  }

  private folder(id: FolderId): Folder {
    const f = this.folders.get(id);
    if (!f) throw new MemoryError("not-found", "That folder doesn't exist");
    return f;
  }

  private folderTrashed(id: FolderId | null): boolean {
    for (let cur = id, guard = 0; cur && guard <= MAX_FOLDER_DEPTH + 1; guard++) {
      const f = this.folders.get(cur);
      if (!f) return false;
      if (f.trashedAt !== null) return true;
      cur = f.parentId;
    }
    return false;
  }

  private fileTrashed(m: FileMeta) {
    return m.trashedAt !== null || this.folderTrashed(m.folderId);
  }

  private depth(id: FolderId): number {
    let d = 0;
    for (let cur: FolderId | null = id; cur && d <= MAX_FOLDER_DEPTH + 1; d++) cur = this.folders.get(cur)?.parentId ?? null;
    return d;
  }

  private subtree(id: FolderId): FolderId[] {
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const f of this.folders.values()) if (f.parentId === out[i]) out.push(f.id);
    return out;
  }

  private height(id: FolderId): number {
    const kids = [...this.folders.values()].filter((f) => f.parentId === id);
    return 1 + Math.max(0, ...kids.map((k) => this.height(k.id)));
  }

  private item(m: FileMeta): FileListItem {
    return { ...structuredClone(m), starred: this.prefs.starred.files.includes(m.fileKey), lastViewedAt: this.prefs.viewedAt[m.fileKey] ?? null, sizeBytes: 0 };
  }

  private checkName(name: string, what: string): string {
    const n = String(name ?? "").trim();
    if (!n) throw new MemoryError("invalid", `A ${what} needs a name`);
    return n.slice(0, 255);
  }

  private checkParent(parentId: FolderId | null) {
    if (parentId === null) return;
    this.folder(parentId);
    if (this.folderTrashed(parentId)) throw new MemoryError("trashed", "That folder is in Trash");
  }

  private changedPrefs() {
    this.emit({ type: "prefs.updated", prefs: structuredClone(this.prefs) });
  }

  // --- WorkspaceRepository ---

  async getWorkspace() {
    return structuredClone(this.workspace);
  }

  async updateWorkspace(patch: Partial<Pick<Workspace, "teamName" | "defaultLibraries">>) {
    this.workspace = { ...this.workspace, ...patch };
    this.emit({ type: "workspace.updated", workspace: structuredClone(this.workspace) });
    return structuredClone(this.workspace);
  }

  async getPrefs() {
    return structuredClone(this.prefs);
  }

  async setBrowsePrefs(patch: Partial<Prefs["browse"]>) {
    this.prefs = { ...this.prefs, browse: { ...this.prefs.browse, ...patch } };
    this.changedPrefs();
    return structuredClone(this.prefs);
  }

  async listFolders() {
    return [...this.folders.values()].map((f) => structuredClone(f));
  }

  async createFolder(input: { name: string; parentId: FolderId | null; color?: FolderColor }) {
    const name = this.checkName(input.name, "folder");
    const parentId = input.parentId ?? null;
    this.checkParent(parentId);
    if (parentId && this.depth(parentId) + 1 > MAX_FOLDER_DEPTH) throw new MemoryError("invalid", `Folders can be nested ${MAX_FOLDER_DEPTH} levels deep`);
    const t = this.tick();
    const folder: Folder = { id: randomId(16), name, parentId, color: input.color ?? "none", createdAt: t, updatedAt: t, trashedAt: null, _clk: {} };
    this.folders.set(folder.id, folder);
    this.emit({ type: "folder.created", folder: structuredClone(folder) });
    return structuredClone(folder);
  }

  async updateFolder(id: FolderId, patch: Partial<Pick<Folder, "name" | "color" | "parentId">>) {
    const f = this.folder(id);
    const next: Folder = { ...f };
    if (patch.name !== undefined) next.name = this.checkName(patch.name, "folder");
    if (patch.color !== undefined) next.color = patch.color;
    if (patch.parentId !== undefined && patch.parentId !== f.parentId) {
      if (patch.parentId !== null) {
        this.checkParent(patch.parentId);
        if (this.subtree(id).includes(patch.parentId)) throw new MemoryError("invalid", "A folder can't be moved into itself");
        if (this.depth(patch.parentId) + this.height(id) > MAX_FOLDER_DEPTH) throw new MemoryError("invalid", `Folders can be nested ${MAX_FOLDER_DEPTH} levels deep`);
      }
      next.parentId = patch.parentId;
    }
    next.updatedAt = this.tick();
    this.folders.set(id, next);
    this.emit({ type: "folder.updated", folder: structuredClone(next) });
    return structuredClone(next);
  }

  async listFiles(q: FileQuery): Promise<FileListItem[]> {
    const live = (m: FileMeta) => !this.fileTrashed(m);
    const byModified = (a: FileMeta, b: FileMeta) => b.updatedAt - a.updatedAt;
    const all = [...this.files.values()];
    switch (q.in) {
      case "recents":
        return this.prefs.recents.map((r) => this.files.get(r.fileKey)).filter((m): m is FileMeta => !!m && live(m)).map((m) => this.item(m));
      case "drafts":
        return all.filter((m) => m.folderId === null && live(m)).sort(byModified).map((m) => this.item(m));
      case "folder":
        this.folder(q.folderId);
        if (this.folderTrashed(q.folderId)) return [];
        return all.filter((m) => m.folderId === q.folderId && m.trashedAt === null).sort(byModified).map((m) => this.item(m));
      case "starred":
        return this.prefs.starred.files.map((k) => this.files.get(k)).filter((m): m is FileMeta => !!m && live(m)).map((m) => this.item(m));
      case "trash":
        return all.filter((m) => m.trashedAt !== null).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0)).map((m) => this.item(m));
      case "search": {
        const needle = searchKey(q.text.trim());
        if (!needle) return [];
        return all.filter((m) => live(m) && searchKey(m.name).includes(needle)).sort(byModified).map((m) => this.item(m));
      }
    }
  }

  async getFile(fileKey: FileKey) {
    return this.item(this.meta(fileKey));
  }

  private add(input: { name?: string; folderId: FolderId | null; createdAt?: number; updatedAt?: number; importedFrom?: FileMeta["importedFrom"] }): FileMeta {
    this.checkParent(input.folderId);
    const t = this.tick();
    const meta: FileMeta = {
      fileKey: randomId(22),
      name: input.name?.trim() || "Untitled",
      editorType: "design",
      folderId: input.folderId,
      createdAt: input.createdAt ?? t,
      updatedAt: input.updatedAt ?? t,
      trashedAt: null,
      thumbnail: null,
      enabledLibraries: [...this.workspace.defaultLibraries],
      library: { status: "none", latestVersion: null },
      importedFrom: input.importedFrom ?? null,
      _clk: {},
    };
    this.files.set(meta.fileKey, meta);
    this.emit({ type: "file.created", file: structuredClone(meta) });
    return structuredClone(meta);
  }

  async createFile(input: { name?: string; folderId: FolderId | null }) {
    return this.add(input);
  }

  async duplicateFile(fileKey: FileKey) {
    const m = this.meta(fileKey);
    const folderOk = m.folderId === null || !this.folderTrashed(m.folderId);
    const copy = this.add({ name: `${m.name} (Copy)`, folderId: folderOk ? m.folderId : null });
    const thumb = this.thumbnails.get(fileKey);
    if (thumb) {
      this.thumbnails.set(copy.fileKey, thumb);
      const withThumb = { ...this.meta(copy.fileKey), thumbnail: m.thumbnail };
      this.files.set(copy.fileKey, withThumb);
      return structuredClone(withThumb);
    }
    return copy;
  }

  async renameFile(fileKey: FileKey, name: string) {
    const m = this.meta(fileKey);
    const next = { ...m, name: this.checkName(name, "file") };
    this.files.set(fileKey, next);
    this.emit({ type: "file.renamed", fileKey, name: next.name });
    return structuredClone(next);
  }

  async moveFiles(fileKeys: FileKey[], folderId: FolderId | null) {
    this.checkParent(folderId);
    for (const k of fileKeys) this.meta(k);
    for (const k of fileKeys) {
      const m = this.meta(k);
      if (m.folderId === folderId) continue;
      this.files.set(k, { ...m, folderId });
      this.emit({ type: "file.moved", fileKey: k, folderId });
    }
  }

  private filesUnder(ids: FolderId[]) {
    const set = new Set(ids);
    return [...this.files.values()].filter((m) => m.folderId !== null && set.has(m.folderId) && m.trashedAt === null);
  }

  async trash(items: { files?: FileKey[]; folders?: FolderId[] }) {
    const t = this.tick();
    for (const id of items.folders ?? []) this.folder(id);
    for (const k of items.files ?? []) this.meta(k);
    for (const id of items.folders ?? []) {
      const f = this.folder(id);
      if (f.trashedAt !== null) continue;
      const hidden = this.filesUnder(this.subtree(id)).filter((m) => !this.fileTrashed(m));
      const next = { ...f, trashedAt: t, updatedAt: t };
      this.folders.set(id, next);
      this.emit({ type: "folder.trashed", folder: structuredClone(next) });
      for (const m of hidden) this.emit({ type: "file.trashed", fileKey: m.fileKey, viaFolder: id });
    }
    for (const k of items.files ?? []) {
      const m = this.meta(k);
      if (m.trashedAt !== null) continue;
      const wasHidden = this.fileTrashed(m);
      this.files.set(k, { ...m, trashedAt: t });
      if (!wasHidden) this.emit({ type: "file.trashed", fileKey: k, viaFolder: null });
    }
  }

  async restore(items: { files?: FileKey[]; folders?: FolderId[] }) {
    for (const id of items.folders ?? []) this.folder(id);
    for (const k of items.files ?? []) this.meta(k);
    for (const id of items.folders ?? []) {
      const f = this.folder(id);
      if (f.trashedAt === null) continue;
      const parentOk = f.parentId === null || (this.folders.has(f.parentId) && !this.folderTrashed(f.parentId));
      const next = { ...f, trashedAt: null, parentId: parentOk ? f.parentId : null, updatedAt: this.tick() };
      this.folders.set(id, next);
      this.emit({ type: "folder.restored", folder: structuredClone(next) });
      for (const m of this.filesUnder(this.subtree(id))) if (!this.fileTrashed(m)) this.emit({ type: "file.restored", file: structuredClone(m) });
    }
    for (const k of items.files ?? []) {
      const m = this.meta(k);
      if (m.trashedAt === null && !this.folderTrashed(m.folderId)) continue;
      const folderOk = m.folderId === null || (this.folders.has(m.folderId) && !this.folderTrashed(m.folderId));
      const next = { ...m, trashedAt: null, folderId: folderOk ? m.folderId : null };
      this.files.set(k, next);
      this.emit({ type: "file.restored", file: structuredClone(next) });
    }
  }

  private forgetFile(k: FileKey) {
    if (!this.files.delete(k)) return;
    this.thumbnails.delete(k);
    this.prefs.recents = this.prefs.recents.filter((r) => r.fileKey !== k);
    this.prefs.starred.files = this.prefs.starred.files.filter((x) => x !== k);
    delete this.prefs.viewedAt[k];
    this.emit({ type: "file.deleted", fileKey: k });
  }

  private forgetFolder(id: FolderId) {
    if (!this.folders.delete(id)) return;
    this.prefs.starred.folders = this.prefs.starred.folders.filter((x) => x !== id);
    this.emit({ type: "folder.deleted", folderId: id });
  }

  async deleteForever(items: { files?: FileKey[]; folders?: FolderId[] }) {
    const files = new Set<FileKey>();
    const folders = new Set<FolderId>();
    for (const k of items.files ?? []) {
      if (!this.fileTrashed(this.meta(k))) throw new MemoryError("invalid", "Only items in Trash can be deleted forever");
      files.add(k);
    }
    for (const id of items.folders ?? []) {
      this.folder(id);
      if (!this.folderTrashed(id)) throw new MemoryError("invalid", "Only items in Trash can be deleted forever");
      for (const s of this.subtree(id)) folders.add(s);
    }
    for (const m of this.files.values()) if (m.folderId && folders.has(m.folderId)) files.add(m.fileKey);
    for (const k of files) this.forgetFile(k);
    for (const id of folders) this.forgetFolder(id);
    this.changedPrefs();
  }

  async emptyTrash() {
    const files = [...this.files.values()].filter((m) => m.trashedAt !== null).map((m) => m.fileKey);
    const folders = [...this.folders.values()].filter((f) => f.trashedAt !== null && !this.folderTrashed(f.parentId)).map((f) => f.id);
    await this.deleteForever({ files, folders });
  }

  async setStarred(target: { fileKey: FileKey } | { folderId: FolderId }, starred: boolean) {
    const s = this.prefs.starred;
    if ("fileKey" in target) {
      this.meta(target.fileKey);
      if (s.files.includes(target.fileKey) === starred) return;
      s.files = starred ? [...s.files, target.fileKey] : s.files.filter((k) => k !== target.fileKey);
    } else {
      this.folder(target.folderId);
      if (s.folders.includes(target.folderId) === starred) return;
      s.folders = starred ? [...s.folders, target.folderId] : s.folders.filter((k) => k !== target.folderId);
    }
    this.changedPrefs();
  }

  async recordViewed(fileKey: FileKey) {
    this.meta(fileKey);
    const t = this.tick();
    this.prefs.recents = [{ fileKey, viewedAt: t }, ...this.prefs.recents.filter((r) => r.fileKey !== fileKey)].slice(0, MAX_RECENTS);
    this.prefs.viewedAt[fileKey] = t;
    this.changedPrefs();
  }

  async removeFromRecents(fileKey: FileKey) {
    if (!this.prefs.recents.some((r) => r.fileKey === fileKey)) return;
    this.prefs.recents = this.prefs.recents.filter((r) => r.fileKey !== fileKey);
    this.changedPrefs();
  }

  watch(listener: (e: WorkspaceEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- MemoryExtras ---

  async importFig(name: string, folderId: FolderId | null) {
    const base = name.replace(/\.fig$/i, "").trim() || "Untitled";
    return this.add({ name: base, folderId, importedFrom: { kind: "fig", name } });
  }

  /** Test/demo setup: a file with given times, optionally viewed/starred/with a thumbnail. */
  seedFile(input: { name: string; folderId?: FolderId | null; createdAt?: number; updatedAt?: number; viewedAt?: number; starred?: boolean; trashedAt?: number; thumbnail?: string }): FileMeta {
    const meta = this.add({ name: input.name, folderId: input.folderId ?? null, createdAt: input.createdAt, updatedAt: input.updatedAt });
    const m = this.meta(meta.fileKey);
    if (input.trashedAt !== undefined) m.trashedAt = input.trashedAt;
    if (input.thumbnail) {
      this.thumbnails.set(m.fileKey, input.thumbnail);
      m.thumbnail = { version: 1, width: 800, height: 450 };
    }
    if (input.viewedAt !== undefined) {
      this.prefs.viewedAt[m.fileKey] = input.viewedAt;
      this.prefs.recents = [...this.prefs.recents, { fileKey: m.fileKey, viewedAt: input.viewedAt }].sort((a, b) => b.viewedAt - a.viewedAt).slice(0, MAX_RECENTS);
    }
    if (input.starred) this.prefs.starred.files.push(m.fileKey);
    return structuredClone(m);
  }

  seedFolder(input: { name: string; parentId?: FolderId | null; color?: FolderColor; createdAt?: number; starred?: boolean; trashedAt?: number }): Folder {
    const t = input.createdAt ?? this.tick();
    const folder: Folder = { id: randomId(16), name: input.name, parentId: input.parentId ?? null, color: input.color ?? "none", createdAt: t, updatedAt: t, trashedAt: input.trashedAt ?? null, _clk: {} };
    this.folders.set(folder.id, folder);
    if (input.starred) this.prefs.starred.folders.push(folder.id);
    return structuredClone(folder);
  }
}
