/**
 * Figma's file browser on the store (docs/home.md): the sidebar, the top bar, the filter row and the items, with
 * selection, keyboard, context menus, dialogs and toasts. All data comes from `backend.workspace` and comes back
 * through its watch.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Breadcrumb, Button, ContextMenu, EmptyState, Icon, IconButton, MenuButton, SegmentedControl, Select, Spinner, showToast, type MenuEntry, type ToastOptions } from "@/ds";
import { keys } from "@/ds/util/keys";
import type { FileKey, FileListItem, Folder, FolderId, Prefs } from "@shared/store/types";
import * as act from "./actions";
import { ConfirmDialog, MoveDialog, NewFolderDialog } from "./dialogs";
import { importWithShell, newDesignFile, onReveal, onShellCommand, openFile, pickFigFiles, saveLocalCopy, setMenuState, type OpenDeps } from "./desktop";
import { ItemsView } from "./ItemsView";
import { allFoldersMenu, blankMenu, itemMenu, trashMenu } from "./menus";
import {
  EMPTY_SELECTION,
  FILTER_LABEL,
  FolderIndex,
  SORT_KEYS,
  SORT_LABEL,
  canCreateFiles,
  canCreateFolders,
  clickSelect,
  contextSelect,
  countLabel,
  fileItemId,
  folderItemId,
  listItems,
  locationTitle,
  marqueeSelect,
  moveFocus,
  newFileFolder,
  newFolderParent,
  orderLabels,
  pruneSelection,
  sameLocation,
  selectAll,
  selectedTargets,
  type FileFilter,
  type Item,
  type Location,
  type Selection,
  type SortKey,
  type SortOrder,
} from "./model";
import { Sidebar, type DropApi } from "./Sidebar";
import type { FilesBackend } from "./storeAccess";
import { useWorkspaceData } from "./useWorkspaceData";
import styles from "./Files.module.css";

export interface FileBrowserProps {
  backend: FilesBackend;
  initialLocation?: Location;
  /** Navigation in a browser (tests replace it) */
  openDeps?: OpenDeps;
  /** Toasts (tests replace it) */
  toast?: (o: ToastOptions) => void;
}

type DialogState = { kind: "new-folder"; parentId: FolderId | null } | { kind: "move"; targets: act.Targets } | { kind: "delete-forever"; targets: act.Targets } | { kind: "empty-trash" };
type MenuState = { at: { x: number; y: number }; entries: MenuEntry[]; run: (id: string) => void };

const DRAG_TYPE = "application/x-designer-items";
const DEFAULT_BROWSE: Prefs["browse"] = { layout: "grid", sort: "last-viewed" };
const NO_TARGETS: act.Targets = { files: [], folders: [] };

const ownerOf = (teamName: string) => teamName.replace(/['’]s team$/i, "").trim() || teamName;

/** Items per row of the grid (1 in the list). */
function gridColumns(): number {
  const cells = [...document.querySelectorAll<HTMLElement>("[data-collection-item]")];
  const top = cells[0]?.getBoundingClientRect().top;
  return Math.max(1, cells.filter((c) => c.getBoundingClientRect().top === top).length);
}

const itemElement = (id: string) => document.querySelector<HTMLElement>(`[data-collection-item][data-id="${CSS.escape(id)}"]`);
const focusItem = (id: string) => {
  const el = itemElement(id);
  el?.focus({ preventScroll: true });
  el?.scrollIntoView?.({ block: "nearest" });
};

export function FileBrowser({ backend, initialLocation = { kind: "recents" }, openDeps, toast = showToast }: FileBrowserProps) {
  const repo = backend.workspace;
  const [nav, setNav] = useState<{ stack: Location[]; index: number }>({ stack: [initialLocation], index: 0 });
  const location = nav.stack[nav.index];
  const [search, setSearch] = useState("");
  const { data, reload, setPrefs } = useWorkspaceData(repo, location);
  const folders = useMemo(() => new FolderIndex(data.folders), [data.folders]);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [order, setOrder] = useState<SortOrder>("default");
  const [filter, setFilter] = useState<FileFilter>("all");
  const [starredOpen, setStarredOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<FolderId>>(() => new Set());
  const [tick, setTick] = useState(() => Date.now());

  // "Edited 3 minutes ago" moves on.
  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const now = Math.max(tick, data.loadedAt);

  const browse = data.prefs?.browse ?? DEFAULT_BROWSE;
  const current = !!data.location && sameLocation(data.location, location);
  const starredFolderIds = useMemo(() => data.prefs?.starred.folders ?? [], [data.prefs]);
  const items = useMemo(
    () => (current ? listItems({ location, folders, files: data.files, counts: data.counts, starredFolders: starredFolderIds, sort: browse.sort, order, filter }) : []),
    [current, location, folders, data.files, data.counts, starredFolderIds, browse.sort, order, filter],
  );
  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const sel = useMemo(() => pruneSelection(selection, ids), [selection, ids]);
  const selected = useMemo(() => new Set(sel.ids), [sel]);
  const known = useMemo(() => [...data.files, ...data.starredFiles], [data.files, data.starredFiles]);
  const ctx: act.ActionContext = useMemo(() => ({ repo, folders, known, toast }), [repo, folders, known, toast]);
  const deps: OpenDeps = useMemo(() => ({ workspace: repo, ...openDeps }), [repo, openDeps]);

  // --- navigation ---

  const go = useCallback(
    (loc: Location) => {
      setNav((n) => {
        if (sameLocation(n.stack[n.index], loc)) return n;
        return { stack: [...n.stack.slice(0, n.index + 1), loc], index: n.index + 1 };
      });
      if (loc.kind !== "search") setSearch("");
      if (loc.kind === "folder") {
        const path = folders.path(loc.folderId).slice(0, -1);
        if (path.length) setExpanded((s) => new Set([...s, ...path.map((f) => f.id)]));
      }
      setSelection(EMPTY_SELECTION);
      setRenaming(null);
    },
    [folders],
  );
  const back = () => {
    setNav((n) => ({ ...n, index: Math.max(0, n.index - 1) }));
    setSelection(EMPTY_SELECTION);
  };
  const forward = () => {
    setNav((n) => ({ ...n, index: Math.min(n.stack.length - 1, n.index + 1) }));
    setSelection(EMPTY_SELECTION);
  };

  const onSearch = (text: string) => {
    setSearch(text);
    if (text.trim()) {
      setNav((n) => {
        const cur = n.stack[n.index];
        if (cur.kind === "search") return { stack: [...n.stack.slice(0, n.index), { kind: "search", text }], index: n.index };
        return { stack: [...n.stack.slice(0, n.index + 1), { kind: "search", text }], index: n.index + 1 };
      });
      setSelection(EMPTY_SELECTION);
    } else leaveSearch();
  };
  const leaveSearch = () => {
    setSearch("");
    setNav((n) => (n.stack[n.index].kind === "search" ? { stack: n.stack.slice(0, n.index), index: Math.max(0, n.index - 1) } : n));
  };

  const setBrowse = (patch: Partial<Prefs["browse"]>) => {
    if (data.prefs) setPrefs({ ...data.prefs, browse: { ...data.prefs.browse, ...patch } });
    repo.setBrowsePrefs(patch).then(setPrefs, (e) => toast({ kind: "error", message: act.errorText(e) }));
  };

  // --- opening and creating ---

  const openFiles = useCallback(
    (keys: FileKey[], newTab = false) => {
      keys.forEach((k, i) => void openFile(k, { newTab: newTab || i > 0, title: known.find((f) => f.fileKey === k)?.name }, deps).catch((e) => toast({ kind: "error", message: act.errorText(e) })));
    },
    [deps, toast, known],
  );

  const open = (item: Item) => {
    if (location.kind === "trash") {
      toast({ message: item.kind === "file" ? "Restore this file to open it" : "Restore this folder to open it" });
      return;
    }
    if (item.kind === "folder") go({ kind: "folder", folderId: item.folder.id });
    else openFiles([item.file.fileKey]);
  };

  const openSelection = (t: act.Targets) => {
    if (location.kind === "trash") return;
    if (t.folders.length === 1 && !t.files.length) go({ kind: "folder", folderId: t.folders[0] });
    else if (t.files.length) openFiles(t.files);
  };

  const newFile = async () => {
    try {
      await newDesignFile(newFileFolder(location), repo, deps);
    } catch (e) {
      toast({ kind: "error", message: act.errorText(e) });
    }
  };

  /** `.fig` files from a file input or dropped from Finder, into a folder (null: Drafts), through the store's `importFigBytes`. */
  const importFiles = async (files: File[], folderId: FolderId | null) => {
    if (!files.length) return;
    if (!backend.importFigBytes) {
      toast({ kind: "error", message: "Importing .fig files needs the desktop app" });
      return;
    }
    const figs = files.filter((f) => /\.fig$/i.test(f.name));
    if (figs.length < files.length) toast({ kind: "error", message: "Only .fig files can be imported" });
    const done: string[] = [];
    for (const file of figs) {
      try {
        const meta = await backend.importFigBytes(file, folderId);
        done.push(meta.name);
      } catch (e) {
        toast({ kind: "error", message: `Couldn’t import “${file.name}”: ${act.errorText(e)}` });
      }
    }
    if (done.length) toast({ kind: "success", message: done.length === 1 ? `Imported “${done[0]}”` : `Imported ${done.length} files` });
  };

  const doImport = async () => {
    const folderId = newFileFolder(location);
    try {
      const viaShell = await importWithShell(folderId);
      if (viaShell) {
        if (viaShell.files.length) toast({ kind: "success", message: viaShell.files.length === 1 ? `Imported “${viaShell.files[0].name}”` : `Imported ${viaShell.files.length} files` });
        for (const f of viaShell.failed) toast({ kind: "error", message: `Couldn’t import “${f.path.split(/[\\/]/).pop()}”: ${f.error}` });
        return;
      }
      await importFiles(await pickFigFiles(), folderId);
    } catch (e) {
      toast({ kind: "error", message: act.errorText(e) });
    }
  };

  // --- commands on items ---

  const targetsName = (t: act.Targets): string => {
    if (t.files.length + t.folders.length !== 1) return countLabel(t).subject.toLowerCase();
    if (t.files.length) return `“${known.find((f) => f.fileKey === t.files[0])?.name ?? "file"}”`;
    return `“${folders.get(t.folders[0])?.name ?? "folder"}”`;
  };

  const trashSelected = (t: act.Targets) => {
    if (!t.files.length && !t.folders.length) return;
    if (location.kind === "trash") setDialog({ kind: "delete-forever", targets: t });
    else {
      void act.moveToTrash(ctx, t);
      setSelection(EMPTY_SELECTION);
    }
  };

  const run = async (id: string, t: act.Targets, from?: Folder) => {
    if (id.startsWith("color:")) {
      if (t.folders[0]) await act.setFolderColor(ctx, t.folders[0], id.slice(6) as Folder["color"]);
      return;
    }
    switch (id) {
      case "open":
        return openSelection(t);
      case "open-new-tab":
        return openFiles(t.files, true);
      case "copy-link": {
        const link = t.files[0] ? `designerv2://file/${t.files[0]}` : `designerv2://folder/${t.folders[0]}`;
        await navigator.clipboard?.writeText(link).then(
          () => toast({ message: "Link copied to clipboard" }),
          () => toast({ kind: "error", message: "Couldn’t copy the link" }),
        );
        return;
      }
      case "star":
      case "unstar":
        for (const k of t.files) await act.setStarred(ctx, { fileKey: k }, id === "star");
        for (const f of t.folders) await act.setStarred(ctx, { folderId: f }, id === "star");
        return;
      case "duplicate": {
        const copies = await act.duplicate(ctx, t.files);
        if (copies.length) setSelection({ ids: copies.map(fileItemId), anchor: fileItemId(copies[0]) });
        return;
      }
      case "rename":
        if (t.files.length + t.folders.length !== 1) return;
        if (from && !ids.includes(folderItemId(from.id))) {
          // A sidebar folder that isn't on screen: go where it is shown, then rename it there.
          go(from.parentId ? { kind: "folder", folderId: from.parentId } : { kind: "folders" });
        }
        setSelection({ ids: [t.files[0] ? fileItemId(t.files[0]) : folderItemId(t.folders[0])], anchor: null });
        setRenaming(t.files[0] ? fileItemId(t.files[0]) : folderItemId(t.folders[0]));
        return;
      case "move":
        return setDialog({ kind: "move", targets: t });
      case "remove-from-recents":
        await act.removeFromRecents(ctx, t.files);
        return;
      case "trash":
        return trashSelected(t);
      case "restore":
        await act.restore(ctx, t);
        setSelection(EMPTY_SELECTION);
        return;
      case "delete-forever":
        return setDialog({ kind: "delete-forever", targets: t });
      case "new-folder":
        return setDialog({ kind: "new-folder", parentId: t.folders.length === 1 ? t.folders[0] : newFolderParent(location) });
      case "new-file":
        return void newFile();
      case "import":
        return void doImport();
      case "empty-trash":
        return setDialog({ kind: "empty-trash" });
    }
  };

  const menuFor = (e: React.MouseEvent, entries: MenuEntry[], t: act.Targets, from?: Folder) => {
    e.preventDefault();
    e.stopPropagation();
    if (!entries.length) return;
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      entries,
      run: (id) => void run(id, t, from),
    });
  };

  const starredFolderSet = useMemo(() => new Set(starredFolderIds), [starredFolderIds]);
  const itemsMenu = (e: React.MouseEvent, item: Item) => {
    const next = contextSelect(sel, ids, item.id);
    setSelection(next);
    const t = selectedTargets(next.ids);
    const byKey = new Map(items.filter((i) => i.kind === "file").map((i) => [i.file.fileKey, i.file] as const));
    const allStarred = t.files.every((k) => byKey.get(k)?.starred) && t.folders.every((f) => starredFolderSet.has(f));
    menuFor(e, itemMenu({ location, files: t.files.length, folders: t.folders.length, allStarred, color: t.folders.length === 1 && !t.files.length ? folders.get(t.folders[0])?.color : undefined }), t);
  };
  const sidebarFolderMenu = (e: React.MouseEvent, f: Folder) =>
    menuFor(e, itemMenu({ location: { kind: "folders" }, files: 0, folders: 1, allStarred: starredFolderSet.has(f.id), color: f.color }), { files: [], folders: [f.id] }, f);
  const sidebarFileMenu = (e: React.MouseEvent, f: FileListItem) => menuFor(e, itemMenu({ location: { kind: "starred" }, files: 1, folders: 0, allStarred: f.starred }), { files: [f.fileKey], folders: [] });

  const rename = (item: Item, name: string | null) => {
    setRenaming(null);
    if (name === null) return;
    if (item.kind === "file" && name.trim() !== item.file.name) void act.renameFile(ctx, item.file.fileKey, name);
    if (item.kind === "folder" && name.trim() !== item.folder.name) void act.renameFolder(ctx, item.folder.id, name);
  };

  // --- drag and drop (move into folders) ---

  const dnd: DropApi = {
    accepts: (e) => e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes("Files"),
    drop: (e, dest) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) {
        void importFiles([...e.dataTransfer.files], dest);
        return;
      }
      let dragged: string[] = [];
      try {
        dragged = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as string[];
      } catch {
        return;
      }
      const t = selectedTargets(dragged);
      // Drafts hold files only; a folder never goes into itself (the store refuses that too).
      const move = { files: t.files, folders: dest === null ? [] : t.folders.filter((f) => !folders.subtree(f).has(dest)) };
      if (move.files.length || move.folders.length) void act.moveTo(ctx, move, dest);
    },
  };
  const onDragItems = (e: React.DragEvent, item: Item) => {
    const next = selected.has(item.id) ? sel : clickSelect(sel, ids, item.id);
    setSelection(next);
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(next.ids));
    e.dataTransfer.effectAllowed = "move";
  };
  const [dropOn, setDropOn] = useState<FolderId | null>(null);
  const folderDrop = (id: FolderId) =>
    location.kind === "trash"
      ? {}
      : {
          onDragOver: (e: React.DragEvent) => {
            if (!dnd.accepts(e) || selected.has(folderItemId(id))) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = e.dataTransfer.types.includes("Files") ? "copy" : "move";
            if (dropOn !== id) setDropOn(id);
          },
          onDragLeave: () => setDropOn((cur) => (cur === id ? null : cur)),
          onDrop: (e: React.DragEvent) => {
            setDropOn(null);
            if (!dnd.accepts(e)) return;
            e.preventDefault();
            e.stopPropagation();
            dnd.drop(e, id);
          },
        };

  // --- keyboard (and the shell's Edit menu) ---

  const handleKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || dialog || menu || renaming) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('input,textarea,[contenteditable="true"],#ds-overlays,[role="dialog"]')) return;
    const mod = e.metaKey || e.ctrlKey;
    const t = selectedTargets(sel.ids);
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelection(selectAll(ids));
    } else if (e.key === "Escape") {
      if (sel.ids.length) setSelection(EMPTY_SELECTION);
    } else if (e.key === "Enter") {
      if (!sel.ids.length) return;
      e.preventDefault();
      openSelection(t);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      if (!sel.ids.length) return;
      e.preventDefault();
      trashSelected(t);
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      if (!ids.length) return;
      e.preventDefault();
      const from = sel.ids.length ? (sel.ids.includes(sel.anchor ?? "") && e.shiftKey ? sel.ids[sel.ids.length - 1] : (sel.anchor ?? sel.ids[0])) : null;
      const cols = browse.layout === "list" ? 1 : gridColumns();
      const next = moveFocus(ids, from, e.key as "ArrowLeft", cols);
      if (!next) return;
      setSelection(e.shiftKey ? clickSelect(sel, ids, next, { shift: true }) : { ids: [next], anchor: next });
      requestAnimationFrame(() => focusItem(next));
    }
  };
  /** Shows a file where it lives (Drafts or its folder), selected. */
  const reveal = async (fileKey: FileKey) => {
    try {
      const f = await repo.getFile(fileKey);
      go(f.trashedAt !== null ? { kind: "trash" } : f.folderId ? { kind: "folder", folderId: f.folderId } : { kind: "drafts" });
      setSelection({ ids: [fileItemId(fileKey)], anchor: fileItemId(fileKey) });
      requestAnimationFrame(() => requestAnimationFrame(() => focusItem(fileItemId(fileKey))));
    } catch (e) {
      toast({ kind: "error", message: act.errorText(e) });
    }
  };

  const keyRef = useRef(handleKey);
  const commandRef = useRef<(id: string) => void>(() => {});
  const revealRef = useRef<(fileKey: FileKey) => void>(() => {});
  useLayoutEffect(() => {
    keyRef.current = handleKey;
    commandRef.current = (id) => {
      const t = selectedTargets(sel.ids);
      const one = t.files.length + t.folders.length === 1;
      switch (id) {
        case "edit.select-all":
          return setSelection(selectAll(ids));
        case "edit.delete":
        case "file.delete":
          return trashSelected(t);
        case "file.new":
          return void newFile();
        case "file.import":
          return void doImport();
        case "file.duplicate":
          return void run("duplicate", t);
        case "file.rename":
          return one ? void run("rename", t) : undefined;
        case "file.move":
          return t.files.length || t.folders.length ? void run("move", t) : undefined;
        case "file.save-local-copy":
          if (t.files.length === 1) void saveLocalCopy(t.files[0]).catch((e) => toast({ kind: "error", message: act.errorText(e) }));
          return;
      }
    };
    revealRef.current = (fileKey) => void reveal(fileKey);
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    document.addEventListener("keydown", onKey);
    const off = onShellCommand((id) => commandRef.current(id));
    const offReveal = onReveal((k) => revealRef.current(k));
    return () => {
      document.removeEventListener("keydown", onKey);
      off();
      offReveal();
    };
  }, []);

  // The menu bar's Home commands follow the selection.
  const selFiles = selectedTargets(sel.ids);
  const inTrash = location.kind === "trash";
  const menuEnabled = JSON.stringify({
    "edit.select-all": ids.length > 0,
    "edit.delete": sel.ids.length > 0,
    "file.delete": sel.ids.length > 0,
    "file.duplicate": !inTrash && selFiles.files.length > 0 && !selFiles.folders.length,
    "file.rename": !inTrash && sel.ids.length === 1,
    "file.move": !inTrash && sel.ids.length > 0,
    "file.save-local-copy": !inTrash && selFiles.files.length === 1 && !selFiles.folders.length,
  });
  useEffect(() => setMenuState(JSON.parse(menuEnabled) as Record<string, boolean>), [menuEnabled]);

  // --- what shows ---

  const title = locationTitle(location, data.folders);
  const workspaceName = data.workspace?.teamName ?? "";
  const trashEmpty = location.kind === "trash" && current && items.length === 0;
  const folderGone = location.kind === "folder" && data.ready && (!folders.get(location.folderId) || folders.hidden(location.folderId));

  const empty = (): React.ReactNode => {
    if (folderGone) return <EmptyState size="page" icon="24.folder" title="This folder is in trash or was deleted" action={{ label: "Go to All folders", onClick: () => go({ kind: "folders" }) }} />;
    if (data.error) return <EmptyState size="page" icon="24.file" title="Couldn’t load files" body={data.error} action={{ label: "Try again", onClick: reload }} />;
    switch (location.kind) {
      case "recents":
        return <EmptyState size="page" icon="24.recent" title="No recent files" body="Files you open will show up here." action={{ label: "New design file", onClick: () => void newFile() }} />;
      case "drafts":
        return <EmptyState size="page" icon="24.file" title="No files in drafts" body="Design files you create show up here until you move them into a folder." action={{ label: "New design file", onClick: () => void newFile() }} />;
      case "folders":
        return <EmptyState size="page" icon="24.folder" title="No folders yet" body="Use folders to keep related files together." action={{ label: "New folder", onClick: () => setDialog({ kind: "new-folder", parentId: null }) }} />;
      case "folder":
        return <EmptyState size="page" icon="24.folder" title="This folder is empty" body="Create a design file here, or drag files in." action={{ label: "New design file", onClick: () => void newFile() }} />;
      case "starred":
        return <EmptyState size="page" icon="24.star.outline" title="Nothing starred yet" body="Star files and folders to find them quickly." />;
      case "trash":
        return <EmptyState size="page" icon="24.trash.outline" title="Trash is empty" body="Files and folders you delete show up here. Restore them or delete them forever." />;
      case "search":
        return <EmptyState size="page" icon="24.search" title="No results" body={`Nothing matches “${location.text.trim()}”.`} />;
    }
  };

  const crumbs = location.kind === "folder" ? folders.path(location.folderId) : [];
  const currentFolder = location.kind === "folder" && !folderGone ? folders.get(location.folderId) : undefined;
  const sortEntries: MenuEntry[] = [
    { header: "Sort by" },
    ...SORT_KEYS.map((k) => ({ id: `sort:${k}`, label: SORT_LABEL[k], checked: browse.sort === k })),
    "-",
    { header: "Order" },
    ...(["default", "reversed"] as SortOrder[]).map((o) => ({ id: `order:${o}`, label: orderLabels(browse.sort)[o], checked: order === o })),
  ];
  const moveDialog = dialog?.kind === "move" ? dialog : null;
  const moveExclude = useMemo(() => {
    const s = new Set<FolderId>();
    for (const f of moveDialog?.targets.folders ?? []) for (const id of folders.subtree(f)) s.add(id);
    return s;
  }, [moveDialog, folders]);

  return (
    <div className={styles.app} data-files-app="">
      <Sidebar
        ownerName={ownerOf(workspaceName)}
        teamName={workspaceName}
        location={location}
        search={search}
        onSearch={onSearch}
        onSearchExit={leaveSearch}
        go={go}
        folders={folders}
        expanded={expanded}
        onToggle={(id) => setExpanded((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])))}
        starredFolders={starredFolderIds.map((id) => folders.get(id)).filter((f): f is Folder => !!f && !folders.hidden(f.id))}
        starredFiles={data.starredFiles}
        starredOpen={starredOpen}
        onStarredOpen={setStarredOpen}
        onOpenFile={(k) => openFiles([k])}
        onFolderMenu={sidebarFolderMenu}
        onFileMenu={sidebarFileMenu}
        onAllFoldersMenu={(e) => menuFor(e, allFoldersMenu(), NO_TARGETS)}
        onTrashMenu={(e) => menuFor(e, trashMenu(false), NO_TARGETS)}
        dnd={dnd}
      />
      <main
        className={styles.main}
        aria-label={title}
        onDragOver={(e) => {
          // .fig files from Finder: into the folder shown, or Drafts
          if (!e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes(DRAG_TYPE) || !canCreateFiles(location) || folderGone) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes(DRAG_TYPE) || !canCreateFiles(location) || folderGone) return;
          e.preventDefault();
          void importFiles([...e.dataTransfer.files], newFileFolder(location));
        }}
      >
        <header className={styles.topbar}>
          <div className={styles.nav}>
            <IconButton icon="24.arrow.left" label="Back" tone="secondary" disabled={nav.index === 0} onClick={back} />
            <IconButton icon="24.arrow.right" label="Forward" tone="secondary" disabled={nav.index >= nav.stack.length - 1} onClick={forward} />
          </div>
          <div className={styles.title}>
            <Breadcrumb
              items={[
                ...(crumbs.length ? [{ id: "folders", label: "All folders" }] : []),
                ...(crumbs.length ? crumbs.map((f) => ({ id: f.id, label: f.name })) : [{ id: location.kind, label: title }]),
              ]}
              onNavigate={(id) => go(id === "folders" ? { kind: "folders" } : { kind: "folder", folderId: id })}
              menu={currentFolder ? itemMenu({ location: { kind: "folders" }, files: 0, folders: 1, allStarred: starredFolderSet.has(currentFolder.id), color: currentFolder.color }) : undefined}
              onMenuSelect={(id) => currentFolder && void run(id, { files: [], folders: [currentFolder.id] }, currentFolder)}
            />
          </div>
          <div className={styles.create}>
            {canCreateFolders(location) && !folderGone && (
              <Button variant="tinted" size="large" icon="24.plus.small" onClick={() => setDialog({ kind: "new-folder", parentId: newFolderParent(location) })}>
                New folder
              </Button>
            )}
            {canCreateFiles(location) && !folderGone && (
              <>
                <Button variant="tinted" size="large" icon="24.design" tooltip="New design file" shortcut={keys(["mod", "n"])} onClick={() => void newFile()}>
                  Design
                </Button>
                <Button variant="tinted" size="large" icon="24.plus.small" tooltip="Import .fig files" onClick={() => void doImport()}>
                  Import
                </Button>
              </>
            )}
            {location.kind === "trash" && (
              <Button variant="secondary" size="large" disabled={trashEmpty} onClick={() => setDialog({ kind: "empty-trash" })}>
                Empty trash
              </Button>
            )}
          </div>
        </header>
        <div className={styles.filters}>
          <span className={styles.grow} />
          {location.kind !== "folders" && (
            <Select label="Files shown" variant="ghost" width="hug" value={filter} options={(["all", "design"] as FileFilter[]).map((f) => ({ value: f, label: FILTER_LABEL[f] }))} onChange={(v) => setFilter(v as FileFilter)} />
          )}
          {location.kind !== "trash" && (
            <MenuButton
              label="Sort"
              entries={sortEntries}
              onSelect={(id) => {
                if (id.startsWith("sort:")) {
                  setBrowse({ sort: id.slice(5) as SortKey });
                  setOrder("default");
                } else if (id.startsWith("order:")) setOrder(id.slice(6) as SortOrder);
              }}
            >
              <span className={styles.sortLabel}>
                {SORT_LABEL[browse.sort]}
                <Icon name="16.chevron.down" />
              </span>
            </MenuButton>
          )}
          <SegmentedControl
            label="View"
            value={browse.layout}
            onChange={(v) => setBrowse({ layout: v as Prefs["browse"]["layout"] })}
            options={[
              { value: "grid", icon: "24.view.grid", tooltip: "Grid view" },
              { value: "list", icon: "24.view.list", tooltip: "List view" },
            ]}
          />
        </div>
        {!data.ready || (!current && !data.error) ? (
          <div className={styles.center} aria-busy>
            <Spinner size={24} />
          </div>
        ) : items.length === 0 || data.error || folderGone ? (
          <div
            className={styles.empty}
            onContextMenu={(e) => menuFor(e, blankMenu(location, trashEmpty), NO_TARGETS)}
          >
            {empty()}
          </div>
        ) : (
          <ItemsView
            items={items}
            layout={browse.layout}
            location={location}
            sort={browse.sort}
            order={order}
            folders={folders}
            selected={selected}
            renaming={renaming}
            now={now}
            previews={data.previews}
            starredFolders={starredFolderSet}
            thumbnailUrl={backend.thumbnailUrl}
            onItemClick={(e, item) => setSelection(clickSelect(sel, ids, item.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey }))}
            onOpen={open}
            onItemMenu={itemsMenu}
            onBlankMenu={(e) => {
              setSelection(EMPTY_SELECTION);
              menuFor(e, blankMenu(location, trashEmpty), NO_TARGETS);
            }}
            onNavigate={(id, extend) => setSelection(extend ? clickSelect(sel, ids, id, { shift: true }) : { ids: [id], anchor: id })}
            onSelectAll={() => setSelection(selectAll(ids))}
            onClearSelection={() => setSelection(EMPTY_SELECTION)}
            onDelete={() => trashSelected(selectedTargets(sel.ids))}
            onMarquee={(hits, additive) => setSelection((cur) => marqueeSelect(additive ? cur : EMPTY_SELECTION, ids, hits, additive))}
            onRename={rename}
            onStar={(item, on) => void act.setStarred(ctx, item.kind === "file" ? { fileKey: item.file.fileKey } : { folderId: item.folder.id }, on)}
            onSortColumn={(column) => {
              const isName = browse.sort === "alphabetical";
              if ((column === "name") === isName) setOrder((o) => (o === "default" ? "reversed" : "default"));
              else {
                setBrowse({ sort: column === "name" ? "alphabetical" : "last-modified" });
                setOrder("default");
              }
            }}
            onDragItems={onDragItems}
            dropOn={dropOn}
            folderDrop={folderDrop}
          />
        )}
      </main>
      {menu && <ContextMenu at={menu.at} entries={menu.entries} onSelect={menu.run} onClose={() => setMenu(null)} />}
      {dialog?.kind === "new-folder" && (
        <NewFolderDialog
          onClose={() => setDialog(null)}
          onCreate={async (name) => {
            setDialog(null);
            const id = await act.createFolder(ctx, name, dialog.parentId);
            if (id) {
              if (dialog.parentId) setExpanded((s) => new Set([...s, dialog.parentId!]));
              setSelection({ ids: [folderItemId(id)], anchor: folderItemId(id) });
            }
          }}
        />
      )}
      {moveDialog && (
        <MoveDialog
          title={`Move ${targetsName(moveDialog.targets)}`}
          folders={folders}
          forFolders={moveDialog.targets.folders.length > 0 && !moveDialog.targets.files.length}
          exclude={moveExclude}
          current={commonParent(moveDialog.targets, known, folders)}
          onClose={() => setDialog(null)}
          onMove={(dest) => {
            setDialog(null);
            const t = moveDialog.targets;
            void act.moveTo(ctx, dest === null ? { files: t.files, folders: t.files.length ? [] : t.folders } : t, dest);
          }}
        />
      )}
      {dialog?.kind === "delete-forever" && (
        <ConfirmDialog
          title="Delete forever?"
          body={`${capitalize(targetsName(dialog.targets))} will be deleted forever. You can’t undo this.`}
          confirm="Delete forever"
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            setSelection(EMPTY_SELECTION);
            void act.deleteForever(ctx, dialog.targets);
          }}
        />
      )}
      {dialog?.kind === "empty-trash" && (
        <ConfirmDialog
          title="Empty trash?"
          body="Everything in trash will be deleted forever. You can’t undo this."
          confirm="Empty trash"
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            setSelection(EMPTY_SELECTION);
            void act.emptyTrash(ctx);
          }}
        />
      )}
    </div>
  );
}

const capitalize = (s: string) => (s.startsWith("“") ? s : s.charAt(0).toUpperCase() + s.slice(1));

/** Where the moved items are now, when they all share one place (that destination is disabled in the dialog). */
function commonParent(t: act.Targets, known: readonly FileListItem[], folders: FolderIndex): FolderId | null | undefined {
  const places = new Set<FolderId | null | undefined>([...t.files.map((k) => known.find((f) => f.fileKey === k)?.folderId), ...t.folders.map((id) => folders.get(id)?.parentId)]);
  return places.size === 1 ? [...places][0] : undefined;
}
