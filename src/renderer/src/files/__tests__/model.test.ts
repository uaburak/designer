import { describe, expect, it } from "vitest";
import type { FileListItem, Folder } from "@shared/store/types";
import { blankMenu, itemMenu } from "../menus";
import {
  EMPTY_SELECTION,
  FolderIndex,
  clickSelect,
  contextSelect,
  countLabel,
  fileQuery,
  fileSubtitle,
  listItems,
  locationTitle,
  marqueeSelect,
  moveFocus,
  orderLabels,
  pruneSelection,
  searchKey,
  selectAll,
  selectedTargets,
  sortFiles,
  sortFolders,
} from "../model";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 6, 12);

let n = 0;
const file = (name: string, o: Partial<FileListItem> = {}): FileListItem => ({
  fileKey: `k${String(++n).padStart(21, "0")}`,
  name,
  editorType: "design",
  folderId: null,
  createdAt: NOW - 10 * DAY,
  updatedAt: NOW - DAY,
  trashedAt: null,
  thumbnail: null,
  enabledLibraries: [],
  library: { status: "none", latestVersion: null },
  importedFrom: null,
  _clk: {},
  starred: false,
  lastViewedAt: null,
  sizeBytes: 0,
  ...o,
});
const folder = (id: string, name: string, o: Partial<Folder> = {}): Folder => ({ id, name, parentId: null, color: "none", createdAt: NOW - 30 * DAY, updatedAt: NOW - 2 * DAY, trashedAt: null, _clk: {}, ...o });

describe("sorting", () => {
  const a = file("Banana", { updatedAt: NOW - 3 * DAY, createdAt: NOW - 1 * DAY, lastViewedAt: NOW - 5 * DAY });
  const b = file("apple", { updatedAt: NOW - 1 * DAY, createdAt: NOW - 9 * DAY, lastViewedAt: null });
  const c = file("Cherry 10", { updatedAt: NOW - 2 * DAY, createdAt: NOW - 5 * DAY, lastViewedAt: NOW - 1 * DAY });
  const d = file("Cherry 9", { updatedAt: NOW - 4 * DAY, createdAt: NOW - 7 * DAY, lastViewedAt: NOW - 2 * DAY });
  const names = (l: FileListItem[]) => l.map((f) => f.name);

  it("last modified: newest first", () => {
    expect(names(sortFiles([a, b, c, d], "last-modified"))).toEqual(["apple", "Cherry 10", "Banana", "Cherry 9"]);
  });
  it("last viewed: never-viewed files last", () => {
    expect(names(sortFiles([a, b, c, d], "last-viewed"))).toEqual(["Cherry 10", "Cherry 9", "Banana", "apple"]);
  });
  it("alphabetical: case-insensitive, numbers in numeric order", () => {
    expect(names(sortFiles([a, b, c, d], "alphabetical"))).toEqual(["apple", "Banana", "Cherry 9", "Cherry 10"]);
    expect(names(sortFiles([a, b, c, d], "alphabetical", "reversed"))).toEqual(["Cherry 10", "Cherry 9", "Banana", "apple"]);
  });
  it("date created, and reversed (oldest first)", () => {
    expect(names(sortFiles([a, b, c, d], "date-created"))).toEqual(["Banana", "Cherry 10", "Cherry 9", "apple"]);
    expect(names(sortFiles([a, b, c, d], "date-created", "reversed"))).toEqual(["apple", "Cherry 9", "Cherry 10", "Banana"]);
  });
  it("folders sort by name or by their own dates", () => {
    const f1 = folder("f1", "Zeta", { updatedAt: NOW });
    const f2 = folder("f2", "alpha", { updatedAt: NOW - DAY });
    expect(sortFolders([f1, f2], "alphabetical").map((f) => f.name)).toEqual(["alpha", "Zeta"]);
    expect(sortFolders([f2, f1], "last-modified").map((f) => f.name)).toEqual(["Zeta", "alpha"]);
  });
  it("order labels follow Figma: A to Z for names, Newest first for dates", () => {
    expect(orderLabels("alphabetical")).toEqual({ default: "A to Z", reversed: "Z to A" });
    expect(orderLabels("last-viewed").reversed).toBe("Oldest first");
  });
});

describe("folders", () => {
  const root = folder("r", "Clients");
  const kid = folder("k", "Atlas", { parentId: "r" });
  const grand = folder("g", "Old", { parentId: "k" });
  const gone = folder("t", "Trashed", { trashedAt: NOW - DAY });
  const under = folder("u", "Under trashed", { parentId: "t" });
  const idx = new FolderIndex([root, kid, grand, gone, under]);

  it("children, paths, subtrees", () => {
    expect(idx.children(null).map((f) => f.name)).toEqual(["Clients"]);
    expect(idx.children("r").map((f) => f.name)).toEqual(["Atlas"]);
    expect(idx.path("g").map((f) => f.name)).toEqual(["Clients", "Atlas", "Old"]);
    expect([...idx.subtree("r")].sort()).toEqual(["g", "k", "r"]);
  });
  it("a trashed folder hides everything under it; Trash lists only the top one", () => {
    expect(idx.hidden("u")).toBe(true);
    expect(idx.hidden("g")).toBe(false);
    expect(idx.trashed().map((f) => f.id)).toEqual(["t"]);
  });
  it("searches names without case or diacritics", () => {
    expect(searchKey("Çağrı Şükür")).toBe("cagrı sukur");
    expect(new FolderIndex([folder("x", "Résumé")]).search("resu").map((f) => f.id)).toEqual(["x"]);
    expect(idx.search("under")).toEqual([]);
  });
  it("flattens the live tree for the Move dialog, leaving out a moved folder's own branch", () => {
    expect(idx.flatten().map((r) => `${r.depth}:${r.folder.name}`)).toEqual(["1:Clients", "2:Atlas", "3:Old"]);
    expect(idx.flatten(idx.subtree("k")).map((r) => r.folder.name)).toEqual(["Clients"]);
  });
});

describe("locations and items", () => {
  const f1 = folder("f1", "Brand");
  const f2 = folder("f2", "Sub", { parentId: "f1" });
  const idx = new FolderIndex([f1, f2]);
  const files = [file("Logo", { folderId: "f1" }), file("Icons", { folderId: "f1", editorType: "design" })];

  it("maps locations to store queries and titles", () => {
    expect(fileQuery({ kind: "drafts" })).toEqual({ in: "drafts" });
    expect(fileQuery({ kind: "folders" })).toBeNull();
    expect(fileQuery({ kind: "search", text: "  " })).toBeNull();
    expect(locationTitle({ kind: "folder", folderId: "f1" }, [f1])).toBe("Brand");
    expect(locationTitle({ kind: "folders" }, [])).toBe("All folders");
    expect(locationTitle({ kind: "search", text: " logo " }, [])).toBe("Results for “logo”");
  });
  it("a folder lists its subfolders first, then its files", () => {
    const items = listItems({ location: { kind: "folder", folderId: "f1" }, folders: idx, files, counts: { f2: 3 }, sort: "alphabetical", order: "default", filter: "all" });
    expect(items.map((i) => (i.kind === "folder" ? `folder:${i.folder.name}:${i.fileCount}` : `file:${i.file.name}`))).toEqual(["folder:Sub:3", "file:Icons", "file:Logo"]);
  });
  it("All folders lists the top level; Starred lists starred folders that aren't trashed", () => {
    expect(listItems({ location: { kind: "folders" }, folders: idx, files: [], sort: "last-viewed", order: "default", filter: "all" }).map((i) => i.id)).toEqual(["folder:f1"]);
    const withTrash = new FolderIndex([f1, folder("t", "Gone", { trashedAt: NOW })]);
    expect(listItems({ location: { kind: "starred" }, folders: withTrash, files: [], starredFolders: ["t", "f1"], sort: "last-viewed", order: "default", filter: "all" }).map((i) => i.id)).toEqual(["folder:f1"]);
  });
  it("Trash: last deleted first, whatever the sort", () => {
    const t = [file("Old", { trashedAt: NOW - 3 * DAY }), file("New", { trashedAt: NOW - DAY })];
    const items = listItems({ location: { kind: "trash" }, folders: new FolderIndex([folder("x", "Gone", { trashedAt: NOW - 2 * DAY })]), files: t, sort: "alphabetical", order: "default", filter: "all" });
    expect(items.map((i) => (i.kind === "file" ? i.file.name : i.folder.name))).toEqual(["Gone", "New", "Old"]);
  });
  it("subtitles in Figma's words", () => {
    expect(fileSubtitle(file("A", { updatedAt: NOW - 34 * 60_000 }), NOW)).toBe("Edited 34 minutes ago");
    expect(fileSubtitle(file("A", { trashedAt: NOW - 2 * DAY }), NOW)).toBe("Deleted 2 days ago");
  });
});

describe("selection", () => {
  const order = ["a", "b", "c", "d", "e"];
  it("click selects one; ⌘ toggles; ⇧ selects the range from the anchor", () => {
    let s = clickSelect(EMPTY_SELECTION, order, "b");
    expect(s).toEqual({ ids: ["b"], anchor: "b" });
    s = clickSelect(s, order, "d", { shift: true });
    expect(s.ids).toEqual(["b", "c", "d"]);
    s = clickSelect(s, order, "a", { shift: true });
    expect(s.ids).toEqual(["a", "b"]);
    s = clickSelect(s, order, "e", { meta: true });
    expect(s).toEqual({ ids: ["a", "b", "e"], anchor: "e" });
    s = clickSelect(s, order, "a", { meta: true });
    expect(s.ids).toEqual(["b", "e"]);
  });
  it("⌘⇧ adds a range to what is selected", () => {
    const s = clickSelect({ ids: ["a"], anchor: "c" }, order, "e", { shift: true, meta: true });
    expect(s.ids).toEqual(["a", "c", "d", "e"]);
  });
  it("right-click keeps a selection that holds the item, else picks it", () => {
    const s = { ids: ["b", "c"], anchor: "b" };
    expect(contextSelect(s, order, "c")).toBe(s);
    expect(contextSelect(s, order, "e").ids).toEqual(["e"]);
  });
  it("⌘A, pruning, marquee", () => {
    expect(selectAll(order).ids).toEqual(order);
    expect(pruneSelection({ ids: ["a", "x", "c"], anchor: "x" }, order)).toEqual({ ids: ["a", "c"], anchor: "a" });
    expect(marqueeSelect({ ids: ["a"], anchor: "a" }, order, ["d", "c"], true).ids).toEqual(["a", "c", "d"]);
    expect(marqueeSelect({ ids: ["a"], anchor: "a" }, order, ["d"], false).ids).toEqual(["d"]);
  });
  it("arrow keys move by one, or by a row in the grid, and stop at the ends", () => {
    expect(moveFocus(order, "b", "ArrowRight", 2)).toBe("c");
    expect(moveFocus(order, "b", "ArrowDown", 2)).toBe("d");
    expect(moveFocus(order, "e", "ArrowDown", 2)).toBe("e");
    expect(moveFocus(order, "a", "ArrowUp", 2)).toBe("a");
    expect(moveFocus(order, null, "ArrowDown", 2)).toBe("a");
    expect(moveFocus(order, "c", "End", 2)).toBe("e");
  });
  it("splits ids by kind and names them", () => {
    const t = selectedTargets(["file:A", "folder:B", "file:C"]);
    expect(t).toEqual({ files: ["A", "C"], folders: ["B"] });
    expect(countLabel(t).subject).toBe("3 items");
    expect(countLabel({ files: ["A"], folders: [] }).subject).toBe("File");
    expect(countLabel({ files: ["A", "B"], folders: [] }).subject).toBe("2 files");
  });
});

describe("menus", () => {
  const labels = (entries: ReturnType<typeof itemMenu>) => entries.map((e) => (e === "-" ? "-" : "header" in e ? `#${e.header}` : e.label));
  it("a file: Figma's order and words", () => {
    expect(labels(itemMenu({ location: { kind: "drafts" }, files: 1, folders: 0, allStarred: false }))).toEqual(["Open", "Open in new tab", "-", "Copy link", "-", "Add to starred", "-", "Duplicate", "Rename", "Move to folder…", "-", "Move to trash"]);
  });
  it("Recents adds Remove from recents; starred files offer Remove from starred", () => {
    const l = labels(itemMenu({ location: { kind: "recents" }, files: 1, folders: 0, allStarred: true }));
    expect(l).toContain("Remove from recents");
    expect(l).toContain("Remove from starred");
  });
  it("a folder: New folder, Change color with named colours, the current one checked", () => {
    const m = itemMenu({ location: { kind: "folders" }, files: 0, folders: 1, allStarred: false, color: "green" });
    expect(labels(m)).toEqual(["Open", "-", "New folder", "Add to starred", "-", "Rename", "Change color", "Move to folder…", "-", "Move to trash"]);
    const color = m.find((e) => e !== "-" && !("header" in e) && e.label === "Change color");
    const sub = color && color !== "-" && !("header" in color) ? color.items ?? [] : [];
    expect(labels(sub)).toEqual(["No color", "Red", "Orange", "Yellow", "Green", "Teal", "Blue", "Purple", "Pink", "Gray"]);
    expect(sub.find((e) => e !== "-" && !("header" in e) && e.checked)).toMatchObject({ label: "Green" });
  });
  it("several items: Rename is off", () => {
    const m = itemMenu({ location: { kind: "drafts" }, files: 2, folders: 0, allStarred: false });
    expect(m.find((e) => e !== "-" && !("header" in e) && e.label === "Rename")).toMatchObject({ disabled: true });
  });
  it("Trash: Restore and Delete forever; the empty area offers Empty trash", () => {
    expect(labels(itemMenu({ location: { kind: "trash" }, files: 1, folders: 1, allStarred: false }))).toEqual(["Restore", "-", "Delete forever"]);
    expect(labels(blankMenu({ kind: "trash" }, false))).toEqual(["Empty trash…"]);
    expect(labels(blankMenu({ kind: "drafts" }, false))).toEqual(["New design file", "-", "Import…"]);
  });
});
