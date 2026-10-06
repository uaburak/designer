/**
 * The file browser's pure model (docs/home.md): where Home is, what it lists and in which order, the selection,
 * and Figma's words for each. No React, no store calls: FilesApp feeds it the store's records.
 */
import { timeAgo } from "@/ds/util/time";
import type { FileQuery } from "@shared/store/repositories";
import type { FileKey, FileListItem, Folder, FolderId, Prefs } from "@shared/store/types";

// ---------------------------------------------------------------------------------------------------------------------
// Where Home is
// ---------------------------------------------------------------------------------------------------------------------

export type Location =
  | { kind: "recents" }
  | { kind: "drafts" }
  | { kind: "folders" }
  | { kind: "folder"; folderId: FolderId }
  | { kind: "starred" }
  | { kind: "trash" }
  | { kind: "search"; text: string };

export const sameLocation = (a: Location, b: Location): boolean =>
  a.kind === b.kind && (a.kind !== "folder" || a.folderId === (b as { folderId: FolderId }).folderId) && (a.kind !== "search" || a.text === (b as { text: string }).text);

/** The store query behind a location (All folders lists folders only). */
export function fileQuery(loc: Location): FileQuery | null {
  switch (loc.kind) {
    case "recents":
      return { in: "recents" };
    case "drafts":
      return { in: "drafts" };
    case "folders":
      return null;
    case "folder":
      return { in: "folder", folderId: loc.folderId };
    case "starred":
      return { in: "starred" };
    case "trash":
      return { in: "trash" };
    case "search":
      return loc.text.trim() ? { in: "search", text: loc.text } : null;
  }
}

/** The top bar's title. */
export function locationTitle(loc: Location, folders: readonly Folder[]): string {
  switch (loc.kind) {
    case "recents":
      return "Recents";
    case "drafts":
      return "Drafts";
    case "folders":
      return "All folders";
    case "folder":
      return folders.find((f) => f.id === loc.folderId)?.name ?? "Folder";
    case "starred":
      return "Starred";
    case "trash":
      return "Trash";
    case "search":
      return `Results for “${loc.text.trim()}”`;
  }
}

/** Where a new design file goes from here: the folder shown, else Drafts (docs/data.md §4). */
export const newFileFolder = (loc: Location): FolderId | null => (loc.kind === "folder" ? loc.folderId : null);

/** Where a new folder goes from here: inside the folder shown, else the top level. */
export const newFolderParent = (loc: Location): FolderId | null => (loc.kind === "folder" ? loc.folderId : null);

/** Locations that can create files / folders / import. */
export const canCreateFiles = (loc: Location) => loc.kind === "recents" || loc.kind === "drafts" || loc.kind === "folder";
export const canCreateFolders = (loc: Location) => loc.kind === "folders" || loc.kind === "folder";

// ---------------------------------------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------------------------------------

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

export class FolderIndex {
  readonly byId = new Map<FolderId, Folder>();
  private readonly kids = new Map<FolderId | null, Folder[]>();

  constructor(readonly all: readonly Folder[]) {
    for (const f of all) this.byId.set(f.id, f);
    for (const f of all) {
      const list = this.kids.get(f.parentId) ?? [];
      list.push(f);
      this.kids.set(f.parentId, list);
    }
    for (const list of this.kids.values()) list.sort(byName);
  }

  get(id: FolderId | null | undefined): Folder | undefined {
    return id ? this.byId.get(id) : undefined;
  }

  /** In Trash itself or under a trashed folder (or its parent is gone). */
  hidden(id: FolderId): boolean {
    for (let cur: FolderId | null = id, guard = 0; cur && guard < 32; guard++) {
      const f = this.byId.get(cur);
      if (!f || f.trashedAt !== null) return true;
      cur = f.parentId;
    }
    return false;
  }

  /** Live child folders, by name. */
  children(parentId: FolderId | null): Folder[] {
    return (this.kids.get(parentId) ?? []).filter((f) => f.trashedAt === null && (parentId === null || !this.hidden(parentId)));
  }

  /** Root first, the folder last. */
  path(id: FolderId): Folder[] {
    const out: Folder[] = [];
    for (let cur: FolderId | null = id, guard = 0; cur && guard < 32; guard++) {
      const f = this.byId.get(cur);
      if (!f) break;
      out.unshift(f);
      cur = f.parentId;
    }
    return out;
  }

  /** The folder and every folder under it. */
  subtree(id: FolderId): Set<FolderId> {
    const out = new Set<FolderId>([id]);
    const queue = [id];
    while (queue.length) {
      for (const k of this.kids.get(queue.shift()!) ?? []) {
        if (out.has(k.id)) continue;
        out.add(k.id);
        queue.push(k.id);
      }
    }
    return out;
  }

  /** Depth: 1 at the top level. */
  depth(id: FolderId): number {
    return this.path(id).length;
  }

  /** The folders Trash lists: trashed ones whose parent isn't (the top-most of each trashed branch). */
  trashed(): Folder[] {
    return this.all.filter((f) => f.trashedAt !== null && !(f.parentId && this.hidden(f.parentId)));
  }

  /** Live folders whose name matches (case- and diacritic-insensitive, as the store's search). */
  search(text: string): Folder[] {
    const needle = searchKey(text.trim());
    if (!needle) return [];
    return this.all.filter((f) => !this.hidden(f.id) && searchKey(f.name).includes(needle)).sort(byName);
  }

  /** Every live folder in tree order with its depth (the Move dialog's list). */
  flatten(exclude?: Set<FolderId>): { folder: Folder; depth: number }[] {
    const out: { folder: Folder; depth: number }[] = [];
    const walk = (parent: FolderId | null, depth: number) => {
      for (const f of this.children(parent)) {
        if (exclude?.has(f.id)) continue;
        out.push({ folder: f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 1);
    return out;
  }
}

/** Case- and diacritic-insensitive key (docs/data.md §4 Search). */
export const searchKey = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

// ---------------------------------------------------------------------------------------------------------------------
// Items, sorting, filtering
// ---------------------------------------------------------------------------------------------------------------------

export type SortKey = Prefs["browse"]["sort"];
export type Layout = Prefs["browse"]["layout"];
/** "default": newest first (dates), A to Z (alphabetical) */
export type SortOrder = "default" | "reversed";
export type FileFilter = "all" | "design";

export const SORT_LABEL: Record<SortKey, string> = {
  alphabetical: "Alphabetical",
  "date-created": "Date created",
  "last-viewed": "Last viewed",
  "last-modified": "Last modified",
};
export const SORT_KEYS: SortKey[] = ["alphabetical", "date-created", "last-viewed", "last-modified"];
export const orderLabels = (sort: SortKey): Record<SortOrder, string> => (sort === "alphabetical" ? { default: "A to Z", reversed: "Z to A" } : { default: "Newest first", reversed: "Oldest first" });
export const FILTER_LABEL: Record<FileFilter, string> = { all: "All files", design: "Design files" };

export type FileItem = { kind: "file"; id: string; file: FileListItem };
export type FolderItem = { kind: "folder"; id: string; folder: Folder; fileCount: number | null };
export type Item = FileItem | FolderItem;

export const fileItemId = (k: FileKey) => `file:${k}`;
export const folderItemId = (id: FolderId) => `folder:${id}`;
export const parseItemId = (id: string): { kind: "file"; fileKey: FileKey } | { kind: "folder"; folderId: FolderId } | null => {
  if (id.startsWith("file:")) return { kind: "file", fileKey: id.slice(5) };
  if (id.startsWith("folder:")) return { kind: "folder", folderId: id.slice(7) };
  return null;
};

const fileTime = (f: FileListItem, sort: SortKey): number => {
  switch (sort) {
    case "last-viewed":
      return f.lastViewedAt ?? 0;
    case "date-created":
      return f.createdAt;
    default:
      return f.updatedAt;
  }
};
const folderTime = (f: Folder, sort: SortKey): number => (sort === "date-created" ? f.createdAt : f.updatedAt);

/** Files in the chosen order; ties fall back to last modified, then name, then key (stable). */
export function sortFiles(files: readonly FileListItem[], sort: SortKey, order: SortOrder = "default"): FileListItem[] {
  const sign = order === "reversed" ? -1 : 1;
  return [...files].sort((a, b) => {
    let d = 0;
    if (sort === "alphabetical") d = byName(a, b);
    else d = fileTime(b, sort) - fileTime(a, sort) || b.updatedAt - a.updatedAt;
    return sign * d || byName(a, b) || (a.fileKey < b.fileKey ? -1 : a.fileKey > b.fileKey ? 1 : 0);
  });
}

export function sortFolders(folders: readonly Folder[], sort: SortKey, order: SortOrder = "default"): Folder[] {
  const sign = order === "reversed" ? -1 : 1;
  return [...folders].sort((a, b) => {
    const d = sort === "alphabetical" ? byName(a, b) : folderTime(b, sort) - folderTime(a, sort);
    return sign * d || byName(a, b) || (a.id < b.id ? -1 : 1);
  });
}

/** Trash lists what was deleted last first, whatever the sort. */
export function sortTrash(files: readonly FileListItem[], folders: readonly Folder[]): { files: FileListItem[]; folders: Folder[] } {
  return {
    files: [...files].sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0) || byName(a, b)),
    folders: [...folders].sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0) || byName(a, b)),
  };
}

/** Every file is a design file here; the filter is Figma's (FigJam/Slides don't exist in this app). */
export const filterFiles = (files: readonly FileListItem[], filter: FileFilter): FileListItem[] => (filter === "design" ? files.filter((f) => f.editorType === "design") : [...files]);

export interface ListInput {
  location: Location;
  folders: FolderIndex;
  files: readonly FileListItem[];
  counts?: Readonly<Record<FolderId, number>>;
  starredFolders?: readonly FolderId[];
  sort: SortKey;
  order: SortOrder;
  filter: FileFilter;
}

/** What the main area shows, folders first, in display order. */
export function listItems({ location, folders, files, counts = {}, starredFolders = [], sort, order, filter }: ListInput): Item[] {
  const folderItem = (f: Folder): FolderItem => ({ kind: "folder", id: folderItemId(f.id), folder: f, fileCount: counts[f.id] ?? null });
  const fileItem = (f: FileListItem): FileItem => ({ kind: "file", id: fileItemId(f.fileKey), file: f });
  let shownFolders: Folder[] = [];
  switch (location.kind) {
    case "folders":
      shownFolders = folders.children(null);
      break;
    case "folder":
      shownFolders = folders.children(location.folderId);
      break;
    case "starred":
      shownFolders = starredFolders.map((id) => folders.get(id)).filter((f): f is Folder => !!f && !folders.hidden(f.id));
      break;
    case "search":
      shownFolders = folders.search(location.text);
      break;
    case "trash": {
      const t = sortTrash(files, folders.trashed());
      return [...t.folders.map(folderItem), ...filterFiles(t.files, filter).map(fileItem)];
    }
  }
  // Recents keeps the order files were viewed in unless another sort is chosen (Figma's Recents is by last viewed).
  return [...sortFolders(shownFolders, sort, order).map(folderItem), ...sortFiles(filterFiles(files, filter), sort, order).map(fileItem)];
}

/** A card's second line: "Edited 3 hours ago" ("Deleted 2 days ago" in Trash). */
export function fileSubtitle(f: FileListItem, now = Date.now()): string {
  if (f.trashedAt !== null) return `Deleted ${timeAgo(f.trashedAt, now)}`;
  return `Edited ${timeAgo(f.updatedAt, now)}`;
}

export function folderSubtitle(item: FolderItem, now = Date.now()): string {
  if (item.folder.trashedAt !== null) return `Deleted ${timeAgo(item.folder.trashedAt, now)}`;
  if (item.fileCount === null) return "";
  return plural(item.fileCount, "file");
}

/** The list view's date column for the chosen sort. */
export function dateColumn(sort: SortKey): { label: string; value: (f: FileListItem) => number | null } {
  switch (sort) {
    case "last-viewed":
      return { label: "Last viewed", value: (f) => f.lastViewedAt };
    case "date-created":
      return { label: "Created", value: (f) => f.createdAt };
    default:
      return { label: "Last modified", value: (f) => f.updatedAt };
  }
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Untitled" → "Untitled (Copy)"; names are trimmed; empty means no change. */
export const cleanName = (name: string): string | null => {
  const n = name.trim();
  return n ? n : null;
};

// ---------------------------------------------------------------------------------------------------------------------
// Selection (Finder/Figma: click, ⇧ range from the anchor, ⌘ toggle, ⌘A, marquee)
// ---------------------------------------------------------------------------------------------------------------------

export interface Selection {
  /** In display order */
  ids: string[];
  /** Where ⇧ ranges start */
  anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { ids: [], anchor: null };

const inOrder = (order: readonly string[], ids: Iterable<string>) => {
  const set = new Set(ids);
  return order.filter((id) => set.has(id));
};

export function clickSelect(sel: Selection, order: readonly string[], id: string, mods: { shift?: boolean; meta?: boolean } = {}): Selection {
  if (!order.includes(id)) return sel;
  if (mods.shift) {
    const anchor = sel.anchor && order.includes(sel.anchor) ? sel.anchor : id;
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return { ids: inOrder(order, mods.meta ? [...sel.ids, ...range] : range), anchor };
  }
  if (mods.meta) {
    const has = sel.ids.includes(id);
    return { ids: inOrder(order, has ? sel.ids.filter((x) => x !== id) : [...sel.ids, id]), anchor: id };
  }
  return { ids: [id], anchor: id };
}

/** A right-click: keeps a selection that contains the item, else selects just it. */
export const contextSelect = (sel: Selection, order: readonly string[], id: string): Selection => (sel.ids.includes(id) ? sel : clickSelect(sel, order, id));

export const selectAll = (order: readonly string[]): Selection => ({ ids: [...order], anchor: order[0] ?? null });

/** Drops what is no longer listed. */
export function pruneSelection(sel: Selection, order: readonly string[]): Selection {
  const ids = inOrder(order, sel.ids);
  if (ids.length === sel.ids.length && (!sel.anchor || order.includes(sel.anchor))) return sel;
  return { ids, anchor: sel.anchor && order.includes(sel.anchor) ? sel.anchor : (ids[0] ?? null) };
}

/** The marquee's result: what it covers, plus what was selected before when ⇧/⌘ was held. */
export function marqueeSelect(base: Selection, order: readonly string[], hits: readonly string[], additive: boolean): Selection {
  const ids = inOrder(order, additive ? [...base.ids, ...hits] : hits);
  return { ids, anchor: hits.length ? inOrder(order, hits)[0] : additive ? base.anchor : null };
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export const intersects = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
export const rectFrom = (x0: number, y0: number, x1: number, y1: number): Rect => ({ left: Math.min(x0, x1), top: Math.min(y0, y1), right: Math.max(x0, x1), bottom: Math.max(y0, y1) });

/** Arrow keys in the grid (`columns` per row) or the list (1). */
export function moveFocus(order: readonly string[], current: string | null, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End", columns: number): string | null {
  if (!order.length) return null;
  const i = current ? order.indexOf(current) : -1;
  if (i < 0) return key === "End" || key === "ArrowUp" || key === "ArrowLeft" ? order[order.length - 1] : order[0];
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -Math.max(1, columns), ArrowDown: Math.max(1, columns), Home: -order.length, End: order.length }[key];
  return order[Math.min(order.length - 1, Math.max(0, i + step))];
}

/** The selection split by kind. */
export function selectedTargets(ids: readonly string[]): { files: FileKey[]; folders: FolderId[] } {
  const files: FileKey[] = [];
  const folders: FolderId[] = [];
  for (const id of ids) {
    const p = parseItemId(id);
    if (p?.kind === "file") files.push(p.fileKey);
    else if (p?.kind === "folder") folders.push(p.folderId);
  }
  return { files, folders };
}

/** "File moved to trash", "3 files moved to trash", "2 items moved to trash". */
export function countLabel(t: { files: readonly unknown[]; folders: readonly unknown[] }): { subject: string; n: number } {
  const n = t.files.length + t.folders.length;
  if (!t.folders.length) return { subject: n === 1 ? "File" : plural(n, "file"), n };
  if (!t.files.length) return { subject: n === 1 ? "Folder" : plural(n, "folder"), n };
  return { subject: plural(n, "item"), n };
}
