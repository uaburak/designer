/**
 * The main area in an organization (docs/multiplayer.md §14; research docs/research/figma/R20-home-org.md, 1.png):
 * Drafts, All teams (with user groups at the right), a team (Folders / Members: audience and visibility, join or ask
 * to join, leave, transfer, delete / restore), a folder (Files / Members: Inherited or Limited, invite, create file /
 * folder, nested folders), the teams' trash, Resources, and search; libraries and fonts (orgLibraries.tsx: All teams ›
 * Libraries, a team's View settings, a library file's Library analytics) — over the store's `orgs` / `teams` / `projects`.
 * Files come in as in the local space (help.figma.com 360041003114): Design and Import in Drafts and folders, Import into
 * a chosen folder from a team page, `.fig` files dropped on the page or on a folder; cards drag onto folders to move.
 * A deleted organization (§14.17) shows its admins Restore instead.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Avatar, Badge, Banner, Breadcrumb, InlineEdit, Button, ContextMenu, EmptyState, FileCard, FileKindIcon, type FileCardProps, FolderCard, Icon, IconButton, ListHeader, ListRow, MenuButton, SegmentedControl, Select, Spinner, Tabs, TextInput, type ListColumn, type MenuEntry, type ToastOptions } from "@/ds";
import { intlLocale, t as tr, tp, useT } from "@/i18n";
import type * as O from "@shared/org/types";
import type { FileKey } from "@shared/store/types";
import { ConfirmDialog } from "./dialogs";
import { FILTER_LABEL, SORT_KEYS, SORT_LABEL, type FileFilter, type Location, type SortKey } from "./model";
import {
  GRANT_LABEL,
  INHERIT_LABEL,
  canAdminTeam,
  canEditFolder,
  canEditTeam,
  folderAccessLabel,
  folderUpdated,
  isSeatRefusal,
  memberRoleLabel,
  orgErrorText,
  orgFileSubtitle,
  PLAN_BADGE,
  seatCanCreateDesign,
  teamAccessChoice,
  teamAccessOptions,
  teamAccessPatch,
  teamAudience,
  teamSubtitle,
  viewSeatNotice,
  type TeamAccessChoice,
} from "./org";
import { AskToUpgradeDialog, DestinationDialog, IconDialog, NameDialog, TransferDialog, type Destination } from "./orgDialogs";
import { LibraryAnalytics } from "./libraryAnalytics";
import { OrgLibrariesDialog, TeamFontsDialog, TeamLibrariesDialog, TeamSettingsDialog } from "./orgLibraries";
import { TeamIcon, useIconSrc } from "./parts";
import type { OrgBackend } from "./storeAccess";
import { orgDestinations, type OrgPageState } from "./useOrgData";
import type { IntentHandlers, PrefetchTarget } from "./prefetch";
import styles from "./Files.module.css";

export interface OrgMainProps {
  org: OrgBackend;
  /** Prefetch on intent (prefetch.ts): a folder tile the pointer rests on or the keyboard focuses reads its page ahead */
  intent?: (target: PrefetchTarget) => IntentHandlers;
  orgId: string;
  info: O.OrgInfo | null;
  location: Location;
  page: OrgPageState;
  reload: () => void;
  go: (loc: Location) => void;
  nav: { canBack: boolean; canForward: boolean; back: () => void; forward: () => void };
  /** Opens a local copy in its tab (FileBrowser's openFile) */
  openFile: (fileKey: FileKey, title: string, newTab?: boolean) => void;
  /** A main file's branch count was clicked: its dropdown (branches.tsx; docs/data.md §15.9) */
  onBranches?: (e: React.MouseEvent<HTMLElement>, f: O.OrgFile) => void;
  toast: (o: ToastOptions) => void;
  now: number;
  /** The person's home org restricts external content and this org isn't it (docs/multiplayer.md §15.6, [F-external]):
   *  nothing is created here — no Design, New folder or Create team */
  noCreate?: boolean;
  /** An org gate (docs/governance.md §2.5: two-factor authentication for guests, the IP allowlist) shown instead of the content */
  blocked?: ReactNode;
  /** Above the content: the guest's access ending soon (§2.13) */
  banner?: ReactNode;
  /**
   * Import (help.figma.com 360041003114: "Create new" › Import, or files dragged in): `.fig` files from the computer into
   * the org's Drafts or a folder, through FileBrowser's import path. Absent: no Import.
   */
  onImport?: (at: OrgImportPlace) => void;
  onImportFiles?: (files: File[], at: OrgImportPlace) => void;
  /** The server's origin: a file's link is `<server>/f/<key>` (Copy link); absent: no Copy link */
  serverUrl?: string | null;
  /** Rename an org file through its local copy (the store renames it on the server too); absent: no Rename */
  renameFile?: (fileKey: FileKey, name: string) => Promise<unknown>;
  /** When this installation last opened a file (its local copy's Recents time), for All projects' order; absent: never */
  viewedAt?: (fileKey: FileKey) => number | null;
  /** Starred (Home's Starred, by the file's local copy); absent: no star on the cards */
  isStarred?: (fileKey: FileKey) => boolean;
  setStarred?: (fileKey: FileKey, starred: boolean) => Promise<unknown>;
  /** A local copy's card picture (the editor's thumbnail, as on local cards); absent or null: the server's, if any */
  localThumbnail?: (fileKey: FileKey) => Promise<string | null>;
  /** Home's filter, sort and view (the same prefs as the local pages): the controls at each page's header right */
  browse?: { layout: "grid" | "list"; sort: SortKey };
  onBrowse?: (patch: { layout?: "grid" | "list"; sort?: SortKey }) => void;
  filter?: FileFilter;
  onFilter?: (f: FileFilter) => void;
}

/** Where files can be added in an org: its Drafts or a folder (a team holds folders only) */
export type OrgImportPlace = { kind: "org-drafts" } | { kind: "project"; projectId: string };

/**
 * An org file's card with its thumbnail (Figma's file cover): its local copy's (the editor's own render, as local
 * cards show) when there is one, else the server's (`thumbnailUrl`, loaded through the store as icons are: the page
 * loads no network pictures). Looked up again whenever the page reloads.
 */
function OrgFileCard({ file, localThumbnail, loadedAt, ...card }: Omit<FileCardProps, "thumbnail"> & { file: O.OrgFile; localThumbnail?: (fileKey: FileKey) => Promise<string | null>; loadedAt: number }) {
  const [got, setGot] = useState<{ fileKey: FileKey; src: string | null } | null>(null);
  const fileKey = file.fileKey;
  useEffect(() => {
    if (!fileKey || !localThumbnail) return;
    let live = true;
    void localThumbnail(fileKey).then(
      (src) => live && setGot({ fileKey, src }),
      () => live && setGot({ fileKey, src: null }),
    );
    return () => {
      live = false;
    };
  }, [fileKey, localThumbnail, loadedAt]);
  const local = localThumbnail && got && got.fileKey === fileKey ? got.src : null;
  const remote = useIconSrc(local ? null : file.thumbnailUrl);
  return <FileCard {...card} thumbnail={local ?? remote ?? undefined} />;
}

/** An org card dragged in Home: files (by room key) or one folder */
const ORG_DRAG = "application/x-designer-org-items";
type Dragged = { files?: string[]; folder?: string };
/** Files from the computer (not a card of ours) */
const draggingFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes(ORG_DRAG);
const purgeDate = (at: number) => new Date(at).toLocaleDateString(intlLocale(), { month: "long", day: "numeric", year: "numeric" });

type Dialog =
  | { kind: "ask-upgrade" }
  | { kind: "create-team" }
  | { kind: "new-folder"; teamId: string; parentId: string | null }
  | { kind: "rename-folder"; project: O.ProjectSummary }
  | { kind: "create-group" }
  | { kind: "transfer"; team: O.TeamInfo; members: O.TeamMember[] }
  | { kind: "delete-team"; team: O.TeamSummary }
  | { kind: "leave-team"; team: O.TeamSummary }
  | { kind: "delete-folder"; project: O.ProjectSummary }
  | { kind: "move"; title: string; rows: Destination[]; files?: string[]; folder?: O.ProjectSummary }
  | { kind: "org-libraries" }
  | { kind: "library-analytics"; key: string; name: string }
  | { kind: "team-settings"; team: O.TeamInfo; canAdmin: boolean }
  | { kind: "rename-team"; team: O.TeamInfo }
  | { kind: "team-icon"; team: O.TeamInfo }
  | { kind: "team-libraries"; team: O.TeamInfo; canAdmin: boolean }
  | { kind: "team-fonts"; team: O.TeamInfo; canAdmin: boolean }
  | { kind: "import-to"; team: O.TeamInfo; rows: Destination[]; files?: File[] }
  | { kind: "rename-file"; file: O.OrgFile }
  | { kind: "delete-files"; files: O.OrgFile[] };

type Menu = { at: { x: number; y: number }; entries: MenuEntry[]; run: (id: string) => void };

const pageKey = (loc: Location) => JSON.stringify(loc);

export function OrgMain(props: OrgMainProps) {
  useT();
  const { org, orgId, info, location, page, reload, go, nav, openFile, onBranches, toast, now, noCreate = false, blocked, banner, onImport, onImportFiles, serverUrl, renameFile, viewedAt, isStarred, setStarred, localThumbnail, browse, onBrowse, filter = "all", onFilter } = props;
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"main" | "members">("main");
  const [tabFor, setTabFor] = useState("");
  const key = pageKey(location);
  if (tabFor !== key) {
    setTabFor(key);
    setTab(location.kind === "team" && location.tab === "members" ? "members" : "main");
    setSelected(null);
  }
  const current = page.ready && page.key === key;
  const data = current ? page.page : { kind: "none" as const };
  const orgName = info?.name ?? "";
  const seat = info?.seat ?? "view";
  const isAdmin = info?.role === "admin";
  const hasAnalytics = !!(org.analytics && org.orgLibraries);

  // Which files shown are published libraries (their context menu offers Library analytics; data.md §17.1)
  const [libraryKeys, setLibraryKeys] = useState<ReadonlySet<string>>(() => new Set());
  const showsFiles = data.kind === "project" || data.kind === "search";
  useEffect(() => {
    if (!hasAnalytics || !showsFiles) return;
    let live = true;
    org.orgLibraries!.list(orgId).then(
      (list) => live && setLibraryKeys(new Set(list.map((l) => l.key))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [org, orgId, hasAnalytics, showsFiles, key]);

  /** A write: its refusal is a toast ("Ask to upgrade" for a seat), then the lists read again. */
  const write = async <T,>(fn: () => Promise<T>, done?: string): Promise<T | undefined> => {
    try {
      const r = await fn();
      if (done) toast({ message: done });
      reload();
      return r;
    } catch (e) {
      if (isSeatRefusal(e)) setDialog({ kind: "ask-upgrade" });
      toast({ kind: "error", message: orgErrorText(e) });
      return undefined;
    }
  };

  const openOrgFile = async (f: O.OrgFile, newTab = false) => {
    try {
      // Early (Figma): the tab opens at once and shows the document coming down
      const fileKey = f.fileKey ?? (await org.openShared(f.key, { early: true })).fileKey;
      openFile(fileKey, f.name, newTab);
    } catch (e) {
      toast({ kind: "error", message: tr("Couldn’t open “{name}”: {error}", { name: f.name, error: orgErrorText(e) }) });
    }
  };

  const newDesignFile = async (projectId: string | null) => {
    if (!seatCanCreateDesign(seat)) {
      setDialog({ kind: "ask-upgrade" });
      return;
    }
    const made = await write(() => (projectId ? org.projects.createFile(projectId) : org.orgs.createDraft(orgId)));
    if (made) openFile(made.fileKey, made.file.name);
  };

  // --- Import and drops (help.figma.com 360041003114: a paid seat and "can edit" on the folder; anyone in their Drafts) ---

  const mayImport = !!onImport && !noCreate;
  /** `.fig` files into Drafts or a folder: picked (no `files`) or dropped. A View seat is asked to upgrade first. */
  const importTo = (at: OrgImportPlace, files?: File[]) => {
    if (!seatCanCreateDesign(seat)) {
      setDialog({ kind: "ask-upgrade" });
      return;
    }
    if (files) onImportFiles?.(files, at);
    else onImport?.(at);
  };
  const [dropOn, setDropOn] = useState<string | null>(null);
  const dragItem = (payload: Dragged) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(ORG_DRAG, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "move";
    },
  });
  /** A folder card takes `.fig` files (imported into it) and org cards (moved into it) */
  const folderDrop = (p: O.ProjectSummary) => {
    if (p.trashedAt !== null || !canEditFolder(p, info)) return {};
    return {
      onDragOver: (e: React.DragEvent) => {
        const files = draggingFiles(e);
        if (!(files ? mayImport : e.dataTransfer.types.includes(ORG_DRAG))) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = files ? "copy" : "move";
        if (dropOn !== p.id) setDropOn(p.id);
      },
      onDragLeave: () => setDropOn((cur) => (cur === p.id ? null : cur)),
      onDrop: (e: React.DragEvent) => {
        setDropOn(null);
        if (draggingFiles(e)) {
          if (!mayImport) return;
          e.preventDefault();
          e.stopPropagation();
          importTo({ kind: "project", projectId: p.id }, [...e.dataTransfer.files]);
          return;
        }
        const raw = e.dataTransfer.getData(ORG_DRAG);
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        let it: Dragged;
        try {
          it = JSON.parse(raw) as Dragged;
        } catch {
          return;
        }
        if (it.files?.length) void write(() => org.projects.moveFiles(it.files!, { projectId: p.id }), tr("Moved to {place}", { place: p.name }));
        else if (it.folder && it.folder !== p.id) void write(() => org.projects.move(it.folder!, { teamId: p.teamId, parentId: p.id }), tr("Moved to {place}", { place: p.name }));
      },
    };
  };
  /** The page's own drop: `.fig` files from the computer (null: none here) */
  const pageDrop = (onFiles: ((files: File[]) => void) | null) =>
    onFiles && mayImport
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!draggingFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          },
          onDrop: (e: React.DragEvent) => {
            if (!draggingFiles(e)) return;
            e.preventDefault();
            onFiles([...e.dataTransfer.files]);
          },
        }
      : {};

  const copyLink = (f: O.OrgFile) =>
    void (async () => {
      try {
        if (!navigator.clipboard) throw new Error("no clipboard");
        await navigator.clipboard.writeText(`${serverUrl!.replace(/\/+$/, "")}/f/${f.key}`);
        toast({ message: tr("Link copied to clipboard") });
      } catch {
        toast({ kind: "error", message: tr("Couldn’t copy the link") });
      }
    })();

  const moveFiles = async (files: O.OrgFile[]) => {
    const rows = await orgDestinations(org, orgId, { forFolder: false, isAdmin }).catch(() => [] as Destination[]);
    const here = files.length === 1 ? (files[0].projectId ?? "drafts") : null;
    setDialog({ kind: "move", title: files.length === 1 ? tr("Move {name}", { name: `“${files[0].name}”` }) : tr("Move {name}", { name: tp(files.length, "{n} file", "{n} files") }), rows: rows.map((r) => (r.id === here ? { ...r, disabled: true } : r)), files: files.map((f) => f.key) });
  };
  const moveFolder = async (p: O.ProjectSummary) => {
    const rows = await orgDestinations(org, orgId, { forFolder: true, exclude: p.id, isAdmin }).catch(() => [] as Destination[]);
    const here = p.parentId ?? `team:${p.teamId}`;
    setDialog({ kind: "move", title: tr("Move {name}", { name: `“${p.name}”` }), rows: rows.map((r) => (r.id === here ? { ...r, disabled: true } : r)), folder: p });
  };

  const fileMenu = (e: React.MouseEvent, f: O.OrgFile) => {
    e.preventDefault();
    setSelected(`file:${f.key}`);
    const inTrash = f.trashedAt !== null;
    const may = f.access.canManage || f.access.canEdit;
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      // Figma's file menu (docs/home.md "Menus"): Open, Open in new tab, Copy link · Rename, Move to… · Move to trash;
      // in the trash Restore and Delete forever (its owner and admins)
      entries: inTrash
        ? [{ id: "restore", label: tr("Restore"), disabled: !may }, "-", { id: "delete-forever", label: tr("Delete forever"), disabled: !f.access.canManage }]
        : [
            { id: "open", label: tr("Open") },
            { id: "open-new-tab", label: tr("Open in new tab") },
            ...(serverUrl ? ["-" as const, { id: "copy-link", label: tr("Copy link") }] : []),
            ...(hasAnalytics && libraryKeys.has(f.key) ? ["-" as const, { id: "library-analytics", label: tr("Library analytics") }] : []),
            "-",
            ...(renameFile ? [{ id: "rename", label: tr("Rename"), disabled: !may }] : []),
            { id: "move", label: tr("Move to…"), disabled: !may },
            "-",
            { id: "trash", label: tr("Move to trash"), disabled: !may },
          ],
      run: (id) => {
        if (id === "open") void openOrgFile(f);
        if (id === "open-new-tab") void openOrgFile(f, true);
        if (id === "copy-link") copyLink(f);
        if (id === "library-analytics") setDialog({ kind: "library-analytics", key: f.key, name: f.name });
        if (id === "rename") setDialog({ kind: "rename-file", file: f });
        if (id === "move") void moveFiles([f]);
        if (id === "trash") void write(() => org.projects.trashFiles([f.key]), tr("File moved to trash"));
        if (id === "restore") void write(() => org.projects.restoreFiles([f.key]), tr("File restored"));
        if (id === "delete-forever") setDialog({ kind: "delete-files", files: [f] });
      },
    });
  };
  const folderMenu = (e: React.MouseEvent, p: O.ProjectSummary) => {
    e.preventDefault();
    setSelected(`folder:${p.id}`);
    const may = canEditFolder(p, info);
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      entries:
        p.trashedAt !== null
          ? [{ id: "restore", label: tr("Restore") }, "-", { id: "delete-forever", label: tr("Delete forever") }]
          : [{ id: "open", label: tr("Open") }, "-", { id: "new-folder", label: tr("New folder"), disabled: !may }, { id: "rename", label: tr("Rename"), disabled: !may }, { id: "move", label: tr("Move to…"), disabled: !may }, "-", { id: "trash", label: tr("Move to trash"), disabled: !may }],
      run: (id) => {
        if (id === "open") go({ kind: "project", projectId: p.id });
        if (id === "new-folder") setDialog({ kind: "new-folder", teamId: p.teamId, parentId: p.id });
        if (id === "rename") setDialog({ kind: "rename-folder", project: p });
        if (id === "move") void moveFolder(p);
        if (id === "trash") void write(() => org.projects.trash(p.id), tr("Folder moved to trash"));
        if (id === "restore") void write(() => org.projects.restore(p.id), tr("Folder restored"));
        if (id === "delete-forever") setDialog({ kind: "delete-folder", project: p });
      },
    });
  };

  const join = async (t: O.TeamSummary) => {
    const r = await write(() => org.teams.join(t.id));
    if (r) toast({ message: r.status === "joined" ? tr("You joined {name}", { name: t.name }) : tr("Asked to join {name}", { name: t.name }) });
  };

  // --- the grid of folders and files ---

  /** Star an org file: its local copy carries the star (made first, as opening it does, when it has none) */
  const star = async (f: O.OrgFile, on: boolean) => {
    if (!setStarred) return;
    try {
      const fileKey = f.fileKey ?? (await org.openShared(f.key, { early: true })).fileKey;
      await setStarred(fileKey, on);
      reload();
    } catch (e) {
      toast({ kind: "error", message: orgErrorText(e) });
    }
  };
  // --- filter, sort and view (Figma's "All types", "Last modified", grid / list at a page's header right) ---

  const layout = browse?.layout ?? "grid";
  const sortKey = browse?.sort ?? "last-viewed";
  /** The files a page shows: the filter's kinds, in the sort's order (last viewed: opened or added, the latest first) */
  const arrange = (files: readonly O.OrgFile[]) => {
    const viewed = (f: O.OrgFile) => Math.max(f.createdAt, (f.fileKey && viewedAt?.(f.fileKey)) || 0);
    const by: (a: O.OrgFile, b: O.OrgFile) => number =
      sortKey === "alphabetical" ? (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : sortKey === "date-created" ? (a, b) => b.createdAt - a.createdAt : sortKey === "last-modified" ? (a, b) => b.updatedAt - a.updatedAt : (a, b) => viewed(b) - viewed(a);
    return files.filter((f) => filter === "all" || f.editorType === filter).sort(by);
  };
  const controls = (withFiles = true) => (
    <div className={styles.pageControls}>
      {withFiles && onFilter && <Select label={tr("Files shown")} variant="outlined" width="hug" value={filter} options={(["all", "design"] as FileFilter[]).map((f) => ({ value: f, label: tr(FILTER_LABEL[f]) }))} onChange={(v) => onFilter(v as FileFilter)} />}
      {withFiles && onBrowse && (
        <MenuButton label={tr("Sort")} entries={[{ header: tr("Sort by") }, ...SORT_KEYS.map((k) => ({ id: k, label: tr(SORT_LABEL[k]), checked: sortKey === k }))]} onSelect={(id) => onBrowse({ sort: id as SortKey })}>
          <span className={styles.sortLabel}>
            {tr(SORT_LABEL[sortKey])}
            <Icon name="16.chevron.down" />
          </span>
        </MenuButton>
      )}
      {onBrowse && (
        <SegmentedControl
          label={tr("View")}
          value={layout}
          onChange={(v) => onBrowse({ layout: v as "grid" | "list" })}
          options={[
            { value: "grid", icon: "24.view.grid", tooltip: tr("Grid view") },
            { value: "list", icon: "24.view.list", tooltip: tr("List view") },
          ]}
        />
      )}
    </div>
  );
  const listColumns = (place: boolean): ListColumn[] => [
    { id: "name", label: tr("Name"), width: "minmax(200px, 2fr)" },
    ...(place ? [{ id: "place", label: tr("Location"), width: "minmax(120px, 1fr)" }] : []),
    { id: "date", label: tr("Last modified"), width: "160px" },
  ];
  /** List view: a row per folder and file (name, where, edited) */
  const list = (folders: O.ProjectSummary[], files: O.OrgFile[], label: string, placeOf?: (f: O.OrgFile) => string) => {
    const columns = listColumns(!!placeOf);
    return (
      <div className={styles.orgList} role="listbox" aria-label={tr(label)}>
        <ListHeader columns={columns} />
        {folders.map((p) => (
          <ListRow key={p.id} id={`folder:${p.id}`} columns={columns} cells={{ name: <span className={styles.rowName}><Icon name="24.folder" />{p.name}</span>, date: folderUpdated(p, now) }} selected={selected === `folder:${p.id}`} onSelect={() => setSelected(`folder:${p.id}`)} onOpen={() => p.trashedAt === null && go({ kind: "project", projectId: p.id })} onContextMenu={(e) => folderMenu(e, p)} />
        ))}
        {files.map((f) => (
          <ListRow
            key={f.key}
            id={`file:${f.key}`}
            columns={columns}
            cells={{ name: <span className={styles.rowName}><FileKindIcon />{f.name}</span>, place: placeOf?.(f), date: orgFileSubtitle(f, now) }}
            selected={selected === `file:${f.key}`}
            onSelect={() => setSelected(`file:${f.key}`)}
            onOpen={() => (f.trashedAt === null ? void openOrgFile(f) : toast({ message: tr("Restore this file to open it") }))}
            onContextMenu={(e) => fileMenu(e, f)}
          />
        ))}
      </div>
    );
  };
  const grid = (folders: O.ProjectSummary[], files: O.OrgFile[], label: string, placeOf?: (f: O.OrgFile) => string) => layout === "list" ? list(folders, files, label, placeOf) : (
    <div className={styles.orgGrid} role="listbox" aria-label={tr(label)} onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
      {folders.map((p) => (
        <FolderCard
          key={p.id}
          id={`folder:${p.id}`}
          title={p.name}
          subtitle={folderUpdated(p, now)}
          selected={selected === `folder:${p.id}`}
          dropTarget={dropOn === p.id}
          onSelect={() => setSelected(`folder:${p.id}`)}
          onOpen={() => (p.trashedAt === null ? go({ kind: "project", projectId: p.id }) : toast({ message: tr("Restore this folder to open it") }))}
          onContextMenu={(e) => folderMenu(e, p)}
          {...(p.trashedAt === null ? props.intent?.({ kind: "project", projectId: p.id }) : undefined)}
          {...(p.trashedAt === null && canEditFolder(p, info) ? dragItem({ folder: p.id }) : {})}
          {...folderDrop(p)}
        />
      ))}
      {files.map((f) => (
        <div key={f.key} className={styles.dragWrap} {...(f.trashedAt === null && (f.access.canEdit || f.access.canManage) ? dragItem({ files: [f.key] }) : {})}>
          <OrgFileCard
            file={f}
            localThumbnail={localThumbnail}
            loadedAt={page.loadedAt}
            id={`file:${f.key}`}
            title={f.name}
            subtitle={orgFileSubtitle(f, now)}
            branches={f.branchCount && f.trashedAt === null && onBranches ? { count: f.branchCount, onMenu: (e) => onBranches(e, f) } : undefined}
            place={placeOf?.(f)}
            starred={!!f.fileKey && !!isStarred?.(f.fileKey)}
            onStar={setStarred && f.trashedAt === null ? (on) => void star(f, on) : undefined}
            selected={selected === `file:${f.key}`}
            onSelect={() => setSelected(`file:${f.key}`)}
            onOpen={() => (f.trashedAt === null ? void openOrgFile(f) : toast({ message: tr("Restore this file to open it") }))}
            onContextMenu={(e) => fileMenu(e, f)}
          />
        </div>
      ))}
    </div>
  );

  /** The page's blank area: its New / Import entries (as the local space's blankMenu) */
  const blankMenu = (e: React.MouseEvent, entries: MenuEntry[], run: (id: string) => void) => {
    if ((e.target as HTMLElement).closest('[data-ds="FileCard"], [data-ds="FolderCard"], button, input, a')) return;
    e.preventDefault();
    if (entries.length) setMenu({ at: { x: e.clientX, y: e.clientY }, entries, run });
  };
  const importButton = (onClick: () => void) => (
    <Button variant="tinted" size="large" icon="24.plus.small" tooltip={tr("Import .fig files")} onClick={onClick}>
      {tr("Import")}
    </Button>
  );

  const seatBanner = seat === "view" && info ? (
    <Banner tone="brand" className={styles.orgBanner} action={{ label: tr("Ask to upgrade"), onClick: () => setDialog({ kind: "ask-upgrade" }) }}>
      {viewSeatNotice(orgName)}
    </Banner>
  ) : null;

  // --- the pages ---

  let title: { items: { id: string; label: string }[]; onNavigate?: (id: string) => void } = { items: [{ id: location.kind, label: "" }] };
  let actions: ReactNode = null;
  let body: ReactNode = null;
  /** What the page's blank area does: a right-click menu and dropped `.fig` files */
  let blank: { entries: MenuEntry[]; run: (id: string) => void; onFiles: ((files: File[]) => void) | null } = { entries: [], run: () => {}, onFiles: null };
  /** Cards on the page, for the keyboard (⌫ moves the selected one to the trash) */
  let shown: { folders: O.ProjectSummary[]; files: O.OrgFile[] } = { folders: [], files: [] };

  const tabs = (main: string) => <Tabs className={styles.orgTabs} label={tr("Sections")} value={tab} tabs={[{ value: "main", label: main }, { value: "members", label: tr("Members") }]} onChange={(v) => setTab(v as "main" | "members")} />;

  const deleted = info?.deletedAt ? info : null;
  if (deleted) {
    // A deleted organization (§14.17): only its admins still see it, to restore it before it's deleted for good
    title = { items: [{ id: "deleted", label: orgName }] };
    body = (
      <EmptyState
        size="page"
        icon="24.trash.outline"
        title={tr("{name} was deleted", { name: orgName })}
        body={tr("Its teams, folders and files will be deleted for good on {date}. Until then, admins can restore it.", { date: purgeDate(deleted.purgeAt ?? deleted.deletedAt!) })}
        action={isAdmin ? { label: tr("Restore organization"), onClick: () => void write(() => org.orgs.restore(orgId), tr("{name} restored", { name: orgName })) } : undefined}
      />
    );
  } else switch (data.kind) {
    case "all-projects": {
      // Every file the person can open in the org shown, the last opened or added first (created or imported: its createdAt)
      title = { items: [{ id: "all-projects", label: tr("All projects") }] };
      const drafts: OrgImportPlace = { kind: "org-drafts" };
      actions = noCreate ? null : (
        <>
          <Button variant="tinted" size="large" className={styles.productPill} tooltip={tr("New design file")} onClick={() => void newDesignFile(null)}>
            <FileKindIcon />
            {tr("Design")}
          </Button>
          {mayImport && importButton(() => importTo(drafts))}
        </>
      );
      const files = arrange(data.files);
      shown = { folders: [], files };
      blank = noCreate
        ? blank
        : {
            entries: [{ id: "new-file", label: tr("New design file") }, ...(mayImport ? ["-" as const, { id: "import", label: tr("Import…") }] : [])],
            run: (id) => (id === "new-file" ? void newDesignFile(null) : id === "import" && importTo(drafts)),
            onFiles: (files) => importTo(drafts, files),
          };
      body = (
        <>
          {seatBanner}
          <div className={styles.teamHeader}>
            <div className={styles.headerTitleRow}>
              <h1 className={styles.teamTitle}>{tr("All projects")}</h1>
            </div>
            {controls()}
          </div>
          {files.length ? (
            grid([], files, "Files", (f) => (f.teamId ? (data.teamNames[f.teamId] ?? tr("Team")) : tr("Drafts")))
          ) : (
            <EmptyState size="page" icon="24.file" title={tr("No projects yet")} body={tr("Design files in {org}’s teams and your drafts show up here, the last opened or added first.", { org: orgName })} action={noCreate ? undefined : { label: tr("New design file"), onClick: () => void newDesignFile(null) }} />
          )}
        </>
      );
      break;
    }
    case "drafts": {
      title = { items: [{ id: "drafts", label: tr("Drafts") }] };
      const drafts: OrgImportPlace = { kind: "org-drafts" };
      actions = noCreate ? null : (
        <>
          <Button variant="tinted" size="large" className={styles.productPill} tooltip={tr("New design file")} onClick={() => void newDesignFile(null)}>
            <FileKindIcon />
            {tr("Design")}
          </Button>
          {mayImport && importButton(() => importTo(drafts))}
        </>
      );
      shown = { folders: [], files: data.files };
      blank = noCreate
        ? blank
        : {
            entries: [{ id: "new-file", label: tr("New design file") }, ...(mayImport ? ["-" as const, { id: "import", label: tr("Import…") }] : [])],
            run: (id) => (id === "new-file" ? void newDesignFile(null) : id === "import" && importTo(drafts)),
            onFiles: (files) => importTo(drafts, files),
          };
      body = (
        <>
          {seatBanner}
          {data.files.length ? (
            grid([], data.files, "Files")
          ) : (
            <EmptyState size="page" icon="24.file" title={tr("No files in drafts")} body={tr("Design files you create or import in {org} show up here until you move them into a folder.", { org: orgName })} action={noCreate ? undefined : { label: tr("New design file"), onClick: () => void newDesignFile(null) }} />
          )}
        </>
      );
      break;
    }
    case "teams": {
      title = { items: [{ id: "teams", label: tr("All teams") }] };
      const canCreate = !noCreate && (isAdmin || info?.settings.teamCreation !== "admins");
      actions = (
        <>
          {hasAnalytics && (
            <Button variant="secondary" size="large" icon="24.library" onClick={() => setDialog({ kind: "org-libraries" })}>
              {tr("Libraries")}
            </Button>
          )}
          {canCreate && (
            <Button variant="tinted" size="large" icon="24.plus.small" onClick={() => setDialog({ kind: "create-team" })}>
              {tr("Create team")}
            </Button>
          )}
        </>
      );
      const mine = data.teams.filter((t) => t.me && t.me.role);
      const others = data.teams.filter((t) => !(t.me && t.me.role));
      // A team as a folder (the owner's Home, 2026-10-14): the folder card, the team's icon in the glyph's places;
      // a click selects it, a double-click (or Enter) opens it — as a team's folders
      const teamCard = (t: O.TeamSummary) => (
        <div key={t.id} className={styles.teamTile} data-team-card={t.name} {...props.intent?.({ kind: "team", teamId: t.id })}>
          <FolderCard
            id={`team:${t.id}`}
            title={t.name}
            subtitle={`${teamSubtitle(t)} · ${teamAudience(t)}`}
            glyph={{ large: <TeamIcon name={t.name} src={t.icon} iconUrl={t.iconUrl} size={64} />, small: <TeamIcon name={t.name} src={t.icon} iconUrl={t.iconUrl} size={16} /> }}
            selected={selected === `team:${t.id}`}
            onSelect={() => setSelected(`team:${t.id}`)}
            onOpen={() => go({ kind: "team", teamId: t.id })}
          />
          {!(t.me && t.me.role) && <JoinButton team={t} onJoin={() => void join(t)} />}
        </div>
      );
      const teamColumns: ListColumn[] = [
        { id: "name", label: tr("Name"), width: "minmax(200px, 2fr)" },
        { id: "members", label: tr("Members"), width: "minmax(120px, 1fr)" },
        { id: "access", label: tr("Access"), width: "minmax(160px, 1fr)" },
      ];
      const teamsGrid = (teams: O.TeamSummary[], label: string) =>
        layout === "list" ? (
          <div className={styles.orgList} role="listbox" aria-label={tr(label)}>
            <ListHeader columns={teamColumns} />
            {teams.map((t) => (
              <ListRow key={t.id} id={`team:${t.id}`} data-team-card={t.name} columns={teamColumns} cells={{ name: <span className={styles.rowName}><TeamIcon name={t.name} src={t.icon} iconUrl={t.iconUrl} size={16} />{t.name}</span>, members: teamSubtitle(t), access: teamAudience(t) }} selected={selected === `team:${t.id}`} onSelect={() => setSelected(`team:${t.id}`)} onOpen={() => go({ kind: "team", teamId: t.id })} />
            ))}
          </div>
        ) : (
          <div className={styles.orgGrid} role="listbox" aria-label={tr(label)}>
            {teams.map(teamCard)}
          </div>
        );
      body = (
        <>
        {/* As a team's page (the owner's Home, 2026-10-14; Figma's folder and team headers): the org's icon, its name, the plan */}
        <div className={styles.teamHeader}>
          <span className={styles.roundIcon}>
            <TeamIcon name={orgName} iconUrl={info?.iconUrl ?? null} size={32} />
          </span>
          <div className={styles.headerTitleRow}>
            <h1 className={styles.teamTitle}>
              <EditableTitle value={orgName} onRename={isAdmin ? (name) => void write(() => org.orgs.update(orgId, { name }), tr("Organization renamed")) : undefined} />
            </h1>
            <Badge tone="brand" className={styles.headerBadge}>
              {tr(PLAN_BADGE)}
            </Badge>
            {isAdmin && <IconButton icon="24.settings.small" label={tr("Organization settings")} onClick={() => go({ kind: "admin" })} />}
          </div>
          {controls(false)}
        </div>
        <div className={styles.withAside}>
          <div className={styles.asideMain}>
            <h2 className={styles.sectionTitle}>{tr("Your teams")}</h2>
            {mine.length ? teamsGrid(mine, "Your teams") : <p className={styles.mutedText}>{tr("You’re not on any team yet.")}</p>}
            {others.length > 0 && (
              <>
                <h2 className={styles.sectionTitle}>{tr("Other teams")}</h2>
                {teamsGrid(others, "Other teams")}
              </>
            )}
          </div>
          <aside className={styles.aside} aria-label={tr("User groups")}>
            <div className={styles.asideHeader}>
              <h2 className={styles.sectionTitle}>{tr("User groups")}</h2>
              {(isAdmin || info?.settings.groupCreation !== "admins") && <IconButton icon="24.plus.small" label={tr("Create user group")} onClick={() => setDialog({ kind: "create-group" })} />}
            </div>
            {data.groups.length ? (
              <ul className={styles.groupList}>
                {data.groups.map((g) => (
                  <li key={g.id} className={styles.groupRow}>
                    <span className={styles.groupName}>{g.name}</span>
                    <span className={styles.mutedText}>{tp(g.memberCount, "{n} member", "{n} members")}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.mutedText}>{tr("Groups let you share with many people at once.")}</p>
            )}
          </aside>
        </div>
        </>
      );
      break;
    }
    case "team": {
      const t = data.team;
      const canEdit = canEditTeam(t, info);
      const canAdmin = canAdminTeam(t, info);
      title = { items: [{ id: "teams", label: tr("All teams") }, { id: t.id, label: t.name }], onNavigate: (id) => id === "teams" && go({ kind: "teams" }) };
      const creates = canEdit && !t.deletedAt && !noCreate;
      // A team holds projects directly on Home (the owner's Home, 2026-10-14): new and imported files go into the team's
      // first folder — made ("Projects") when it has none — so a team's access, sharing and moves work as for folders
      const projectsFolder = async (): Promise<string | null> => {
        const first = data.folders.find((f) => f.trashedAt === null);
        if (first) return first.id;
        const made = await write(() => org.projects.create(t.id, { name: "Projects" }));
        return made?.id ?? null;
      };
      const newProject = async () => {
        if (!seatCanCreateDesign(seat)) return setDialog({ kind: "ask-upgrade" });
        const at = await projectsFolder();
        if (at) await newDesignFile(at);
      };
      const importProjects = async (files?: File[]) => {
        if (!seatCanCreateDesign(seat)) return setDialog({ kind: "ask-upgrade" });
        const at = await projectsFolder();
        if (at) importTo({ kind: "project", projectId: at }, files);
      };
      const projects = arrange(data.files);
      actions =
        tab === "main" && creates ? (
          <>
            <Button variant="tinted" size="large" className={styles.productPill} tooltip={tr("New design file")} onClick={() => void newProject()}>
              <FileKindIcon />
              {tr("Design")}
            </Button>
            {mayImport && importButton(() => void importProjects())}
          </>
        ) : null;
      if (tab === "main") shown = { folders: [], files: projects };
      if (tab === "main" && creates)
        blank = {
          entries: [{ id: "new-file", label: tr("New design file") }, ...(mayImport ? ["-" as const, { id: "import", label: tr("Import…") }] : [])],
          run: (id) => (id === "new-file" ? void newProject() : id === "import" && void importProjects()),
          onFiles: (files) => void importProjects(files),
        };
      // The team's ⌄ menu (help.figma.com 14949911189399: Rename, Change icon — admins; "View settings" with About)
      const teamMenu: MenuEntry[] = [
        { id: "settings", label: tr("View settings") },
        { id: "members", label: tr("Members and access") },
        ...(canAdmin ? ["-" as const, { id: "rename", label: tr("Rename") }, { id: "icon", label: tr("Change icon") }, ...(t.iconUrl || t.icon ? [{ id: "remove-icon", label: tr("Remove icon") }] : [])] : []),
        "-" as const,
        ...(t.me?.owner ? [{ id: "transfer", label: tr("Transfer ownership…") }] : []),
        ...(t.me && !t.me.owner ? [{ id: "leave", label: tr("Leave team") }] : []),
        ...(canAdmin ? ["-" as const, { id: "delete", label: tr("Delete team…") }] : []),
      ];
      body = (
        <>
          <div className={styles.teamHeader}>
            <span className={styles.roundIcon}>
              <TeamIcon name={t.name} src={t.icon} iconUrl={t.iconUrl} size={32} />
            </span>
            <div className={styles.headerTitleRow}>
              <h1 className={styles.teamTitle}>
                <EditableTitle value={t.name} onRename={canAdmin && !t.deletedAt ? (name) => void write(() => org.teams.update(t.id, { name }), tr("Team renamed")) : undefined} />
              </h1>
            {!t.me?.role && !t.deletedAt && <JoinButton team={t} onJoin={() => void join(t)} />}
            {teamMenu.length > 0 && !t.deletedAt && (
              <MenuButton
                label={tr("Team settings")}
                className={styles.headerIcon}
                tooltip={tr("Team settings")}
                entries={teamMenu}
                onSelect={(id) => {
                  if (id === "settings") setDialog({ kind: "team-settings", team: t, canAdmin });
                  if (id === "members") setTab("members");
                  if (id === "rename") setDialog({ kind: "rename-team", team: t });
                  if (id === "icon") setDialog({ kind: "team-icon", team: t });
                  if (id === "remove-icon") void write(() => org.teams.removeIcon(t.id), tr("Icon removed"));
                  if (id === "transfer") setDialog({ kind: "transfer", team: t, members: data.members });
                  if (id === "leave") setDialog({ kind: "leave-team", team: t });
                  if (id === "delete") setDialog({ kind: "delete-team", team: t });
                }}
              >
                <Icon name="24.settings.small" />
              </MenuButton>
            )}
            </div>
            {controls(tab === "main")}
          </div>
          {t.deletedAt !== null && (
            <Banner tone="warning" className={styles.orgBanner} action={canAdmin ? { label: tr("Restore"), onClick: () => void write(() => org.teams.restore(t.id), tr("Team restored")) } : undefined}>
              {tr("This team was deleted.")}
            </Banner>
          )}
          {tabs(tr("Projects"))}
          {tab === "main" ? (
            projects.length ? (
              grid([], projects, "Projects")
            ) : (
              <EmptyState size="page" icon="24.file" title={tr("No projects yet")} body={tr("Design files you create or import in this team show up here. Everyone on the team can open them.")} action={creates ? { label: tr("New design file"), onClick: () => void newProject() } : undefined} />
            )
          ) : (
            <TeamMembers team={t} members={data.members} requests={data.requests} orgName={orgName} canEdit={canEdit} canAdmin={canAdmin} write={write} org={org} />
          )}
        </>
      );
      break;
    }
    case "project": {
      const p = data.project;
      const canEdit = canEditFolder(p, info);
      const teamName = data.team?.name ?? tr("Team");
      title = {
        items: [{ id: `team:${p.teamId}`, label: teamName }, ...p.path.map((x) => ({ id: x.id, label: x.name }))],
        onNavigate: (id) => go(id.startsWith("team:") ? { kind: "team", teamId: id.slice(5) } : { kind: "project", projectId: id }),
      };
      actions =
        tab === "main" && canEdit && !noCreate ? (
          <>
            {p.depth < 10 && (
              <Button variant="tinted" size="large" icon="24.plus.small" onClick={() => setDialog({ kind: "new-folder", teamId: p.teamId, parentId: p.id })}>
                {tr("New folder")}
              </Button>
            )}
            <Button variant="tinted" size="large" className={styles.productPill} tooltip={tr("New design file")} onClick={() => void newDesignFile(p.id)}>
              <FileKindIcon />
              {tr("Design")}
            </Button>
            {mayImport && importButton(() => importTo({ kind: "project", projectId: p.id }))}
          </>
        ) : null;
      if (tab === "main") shown = { folders: data.folders, files: data.files };
      if (tab === "main" && canEdit && !noCreate)
        blank = {
          entries: [{ id: "new-file", label: tr("New design file") }, ...(p.depth < 10 ? [{ id: "new-folder", label: tr("New folder") }] : []), ...(mayImport ? ["-" as const, { id: "import", label: tr("Import…") }] : [])],
          run: (id) => {
            if (id === "new-file") void newDesignFile(p.id);
            if (id === "new-folder") setDialog({ kind: "new-folder", teamId: p.teamId, parentId: p.id });
            if (id === "import") importTo({ kind: "project", projectId: p.id });
          },
          onFiles: (files) => importTo({ kind: "project", projectId: p.id }, files),
        };
      const parentName = p.path.length > 1 ? p.path[p.path.length - 2].name : teamName;
      body = (
        <>
          {seatBanner}
          {tabs(tr("Files"))}
          {tab === "main" ? (
            data.folders.length || data.files.length ? (
              grid(data.folders, data.files, "Files")
            ) : (
              <EmptyState size="page" icon="24.folder" title={tr("This folder is empty")} body={mayImport && canEdit ? tr("Create a design file here, import .fig files or drag them in, or move files in.") : tr("Create a design file here, or move files in.")} action={canEdit && !noCreate ? { label: tr("New design file"), onClick: () => void newDesignFile(p.id) } : undefined} />
            )
          ) : (
            <FolderMembers project={p} parentName={parentName} members={data.members} canEdit={canEdit} write={write} org={org} />
          )}
        </>
      );
      break;
    }
    case "trash":
      title = { items: [{ id: "trash", label: tr("Trash") }] };
      shown = { folders: data.teams.flatMap((g) => g.projects), files: [...data.drafts, ...data.teams.flatMap((g) => g.files)] };
      body = data.teams.length || data.drafts.length ? (
        <div className={styles.orgSections}>
          {data.drafts.length > 0 && (
            <section aria-label={tr("Drafts")}>
              <h2 className={styles.sectionTitle}>{tr("Drafts")}</h2>
              {grid([], data.drafts, "Drafts trash")}
            </section>
          )}
          {data.teams.map((g) => (
            <section key={g.team.id} aria-label={g.team.name}>
              <h2 className={styles.sectionTitle}>{g.team.name}</h2>
              {grid(g.projects, g.files, tr("{name} trash", { name: g.team.name }))}
            </section>
          ))}
        </div>
      ) : (
        <EmptyState size="page" icon="24.trash.outline" title={tr("Trash is empty")} body={tr("Files deleted from your drafts and folders and files deleted from your teams show up here. Restore them, or delete them forever.")} />
      );
      break;
    case "search": {
      title = { items: [{ id: "search", label: tr("Results for “{text}”", { text: data.text.trim() }) }] };
      const r = data.result;
      shown = { folders: r.projects, files: r.files };
      body =
        r.teams.length || r.projects.length || r.files.length ? (
          <div className={styles.orgSections}>
            {r.teams.length > 0 && (
              <section aria-label={tr("Teams")}>
                <h2 className={styles.sectionTitle}>{tr("Teams")}</h2>
                <div className={styles.teamGrid}>
                  {r.teams.map((t) => (
                    <button key={t.id} type="button" className={styles.teamCardMain} onClick={() => go({ kind: "team", teamId: t.id })}>
                      <TeamIcon name={t.name} src={t.icon} iconUrl={t.iconUrl} size={24} />
                      <span className={styles.teamCardName}>{t.name}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {(r.projects.length > 0 || r.files.length > 0) && (
              <section aria-label={tr("Folders and files")}>
                <h2 className={styles.sectionTitle}>{tr("Folders and files")}</h2>
                {grid(r.projects, r.files, "Results")}
              </section>
            )}
          </div>
        ) : (
          <EmptyState size="page" icon="24.search" title={tr("No results")} body={tr("Nothing in {org} matches “{text}”.", { org: orgName, text: data.text.trim() })} />
        );
      break;
    }
    case "none":
      if (location.kind === "resources") {
        title = { items: [{ id: "resources", label: tr("Resources") }] };
        body = <EmptyState size="page" icon="24.library" title={tr("Resources")} body={tr("Libraries, fonts, plugins and templates shared in {org} will show up here.", { org: orgName })} />;
      } else if (page.error && page.key === key) {
        title = { items: [{ id: location.kind, label: "" }] };
        body = <EmptyState size="page" icon="24.warning" title={tr("Couldn’t load this page")} body={page.error} action={{ label: tr("Try again"), onClick: reload }} />;
      } else body = <div className={`${styles.center} ${styles.pending}`} aria-busy><Spinner size={24} /></div>;
      break;
  }

  // .fig files dropped from Finder land in the org's Drafts or the folder shown (where the person may create files)
  const moveDialog = dialog?.kind === "move" ? dialog : null;
  /** ⌫ / Delete: the selected card to the trash (Home's keyboard, docs/home.md) */
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.key !== "Backspace" && e.key !== "Delete") || !selected || dialog || menu) return;
    if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
    const f = shown.files.find((x) => `file:${x.key}` === selected);
    const p = shown.folders.find((x) => `folder:${x.id}` === selected);
    if (f && f.trashedAt === null && (f.access.canEdit || f.access.canManage)) {
      e.preventDefault();
      void write(() => org.projects.trashFiles([f.key]), tr("File moved to trash"));
    } else if (p && p.trashedAt === null && canEditFolder(p, info)) {
      e.preventDefault();
      void write(() => org.projects.trash(p.id), tr("Folder moved to trash"));
    }
  };
  const blankArea = blank;
  return (
    <main
      className={styles.main}
      aria-label={title.items.at(-1)?.label || tr("Organization")}
    >
      <header className={styles.topbar}>
        <div className={styles.nav}>
          <IconButton icon="24.arrow.left" label={tr("Back")} tone="secondary" disabled={!nav.canBack} onClick={nav.back} />
          <IconButton icon="24.arrow.right" label={tr("Forward")} tone="secondary" disabled={!nav.canForward} onClick={nav.forward} />
        </div>
        <div className={styles.title}>{title.items[0]?.label ? <Breadcrumb items={title.items} onNavigate={(id) => title.onNavigate?.(id)} /> : null}</div>
        <div className={styles.create}>{blocked ? null : actions}</div>
      </header>
      {banner}
      {blocked ?? (
        <div className={styles.orgContent} onKeyDown={onKey} onContextMenu={(e) => blankMenu(e, blankArea.entries, blankArea.run)} {...pageDrop(blankArea.onFiles)}>
          {current || data.kind === "none" || deleted ? body : <div className={`${styles.center} ${styles.pending}`} aria-busy><Spinner size={24} /></div>}
        </div>
      )}
      {menu && <ContextMenu at={menu.at} entries={menu.entries} onSelect={menu.run} onClose={() => setMenu(null)} />}
      {dialog?.kind === "ask-upgrade" && (
        <AskToUpgradeDialog
          orgName={orgName}
          current={seat}
          onClose={() => setDialog(null)}
          onSend={(s, note) => {
            setDialog(null);
            void write(() => org.orgs.requestSeat(orgId, s, note || undefined), tr("Request sent"));
          }}
        />
      )}
      {dialog?.kind === "create-team" && (
        <NameDialog
          title={tr("Create team")}
          label={tr("Team name")}
          confirm={tr("Create team")}
          onClose={() => setDialog(null)}
          onDone={async (name) => {
            setDialog(null);
            const t = await write(() => org.teams.create(orgId, { name }));
            if (t) go({ kind: "team", teamId: t.id });
          }}
        />
      )}
      {dialog?.kind === "create-group" && (
        <NameDialog
          title={tr("Create user group")}
          label={tr("Group name")}
          confirm={tr("Create group")}
          description
          onClose={() => setDialog(null)}
          onDone={(name, description) => {
            setDialog(null);
            void write(() => org.orgs.createGroup(orgId, { name, ...(description ? { description } : {}) }));
          }}
        />
      )}
      {dialog?.kind === "new-folder" && (
        <NameDialog
          title={tr("New folder")}
          label={tr("Folder name")}
          confirm={tr("Create folder")}
          onClose={() => setDialog(null)}
          onDone={(name) => {
            const d = dialog;
            setDialog(null);
            void write(() => org.projects.create(d.teamId, { name, parentId: d.parentId }));
          }}
        />
      )}
      {dialog?.kind === "rename-folder" && (
        <NameDialog
          title={tr("Rename folder")}
          label={tr("Folder name")}
          confirm={tr("Rename")}
          initial={dialog.project.name}
          onClose={() => setDialog(null)}
          onDone={(name) => {
            const d = dialog;
            setDialog(null);
            void write(() => org.projects.update(d.project.id, { name }));
          }}
        />
      )}
      {dialog?.kind === "transfer" && (
        <TransferDialog
          team={dialog.team.name}
          members={dialog.members}
          onClose={() => setDialog(null)}
          onTransfer={(userId) => {
            const d = dialog;
            setDialog(null);
            void write(() => org.teams.transfer(d.team.id, userId), tr("Ownership transferred"));
          }}
        />
      )}
      {dialog?.kind === "leave-team" && (
        <ConfirmDialog
          title={tr("Leave {name}?", { name: dialog.team.name })}
          body={tr("You’ll lose access to the team’s folders and files unless they’re shared with you some other way.")}
          confirm={tr("Leave team")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const d = dialog;
            setDialog(null);
            const ok = await write(() => org.teams.leave(d.team.id).then(() => true), tr("You left {name}", { name: d.team.name }));
            if (ok) go({ kind: "teams" });
          }}
        />
      )}
      {dialog?.kind === "delete-team" && (
        <ConfirmDialog
          title={tr("Delete {name}?", { name: dialog.team.name })}
          body={tr("Its folders and files will be deleted with it. Admins can restore the team from Admin.")}
          confirm={tr("Delete team")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const d = dialog;
            setDialog(null);
            const ok = await write(() => org.teams.remove(d.team.id).then(() => true), tr("Team deleted"));
            if (ok) go({ kind: "teams" });
          }}
        />
      )}
      {dialog?.kind === "delete-folder" && (
        <ConfirmDialog
          title={tr("Delete forever?")}
          body={tr("“{name}” and everything in it will be deleted forever. You can’t undo this.", { name: dialog.project.name })}
          confirm={tr("Delete forever")}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            const d = dialog;
            setDialog(null);
            void write(() => org.projects.deleteForever(d.project.id));
          }}
        />
      )}
      {dialog?.kind === "org-libraries" && hasAnalytics && <OrgLibrariesDialog org={org} orgId={orgId} onClose={() => setDialog(null)} onOpenLibrary={(lib) => setDialog({ kind: "library-analytics", ...lib })} />}
      {dialog?.kind === "library-analytics" && hasAnalytics && (
        <LibraryAnalytics store={{ analytics: org.analytics!, orgLibraries: org.orgLibraries! }} libraryKey={dialog.key} name={dialog.name} orgId={orgId} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "team-settings" && (
        <TeamSettingsDialog
          team={dialog.team}
          libraries={!!org.orgLibraries}
          fonts={!!org.fonts}
          onClose={() => setDialog(null)}
          onLibraries={() => setDialog({ ...dialog, kind: "team-libraries" })}
          onFonts={() => setDialog({ ...dialog, kind: "team-fonts" })}
          onDescription={dialog.canAdmin ? async (description) => {
            const team = await write(() => org.teams.update(dialog.team.id, { description }), tr("Description saved"));
            if (team) setDialog({ ...dialog, team });
          } : undefined}
        />
      )}
      {dialog?.kind === "rename-team" && (
        <NameDialog
          title={tr("Rename team")}
          label={tr("Team name")}
          confirm={tr("Rename")}
          initial={dialog.team.name}
          onClose={() => setDialog(null)}
          onDone={(name) => {
            const d = dialog;
            setDialog(null);
            void write(() => org.teams.update(d.team.id, { name }));
          }}
        />
      )}
      {dialog?.kind === "team-icon" && (
        <IconDialog
          name={dialog.team.name}
          iconUrl={dialog.team.iconUrl}
          src={dialog.team.icon}
          onClose={() => setDialog(null)}
          onSave={async (image) => {
            if (await write(() => org.teams.setIcon(dialog.team.id, image), tr("Icon changed"))) setDialog(null);
          }}
          onRemove={async () => {
            if (await write(() => org.teams.removeIcon(dialog.team.id), tr("Icon removed"))) setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "team-libraries" && org.orgLibraries && <TeamLibrariesDialog org={org} orgId={orgId} team={dialog.team} canManage={dialog.canAdmin} toast={toast} onClose={() => setDialog(null)} />}
      {dialog?.kind === "team-fonts" && org.fonts && <TeamFontsDialog fonts={org.fonts} orgId={orgId} team={dialog.team} canManage={dialog.canAdmin} toast={toast} onClose={() => setDialog(null)} />}
      {dialog?.kind === "import-to" && (
        <DestinationDialog
          title={tr("Import to a folder in {name}", { name: dialog.team.name })}
          confirm={tr("Import")}
          sections={[{ title: dialog.team.name, rows: dialog.rows }]}
          onClose={() => setDialog(null)}
          onMove={(dest) => {
            const d = dialog;
            setDialog(null);
            importTo({ kind: "project", projectId: dest.id }, d.files);
          }}
        />
      )}
      {dialog?.kind === "rename-file" && renameFile && (
        <NameDialog
          title={tr("Rename file")}
          label={tr("File name")}
          confirm={tr("Rename")}
          initial={dialog.file.name}
          onClose={() => setDialog(null)}
          onDone={(name) => {
            const f = dialog.file;
            setDialog(null);
            void write(async () => renameFile(f.fileKey ?? (await org.openShared(f.key)).fileKey, name), tr("File renamed"));
          }}
        />
      )}
      {dialog?.kind === "delete-files" && (
        <ConfirmDialog
          title={tr("Delete forever?")}
          body={dialog.files.length === 1 ? tr("“{name}” will be deleted forever for everyone it’s shared with. You can’t undo this.", { name: dialog.files[0].name }) : tr("{name} will be deleted forever. You can’t undo this.", { name: tp(dialog.files.length, "{n} file", "{n} files") })}
          confirm={tr("Delete forever")}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            const d = dialog;
            setDialog(null);
            void write(() => org.projects.deleteFilesForever(d.files.map((f) => f.key)), d.files.length === 1 ? tr("File deleted") : tr("Files deleted"));
          }}
        />
      )}
      {moveDialog && (
        <DestinationDialog
          title={moveDialog.title}
          sections={[{ title: orgName, rows: moveDialog.rows }]}
          onClose={() => setDialog(null)}
          onMove={(dest) => {
            setDialog(null);
            if (moveDialog.files) void write(() => org.projects.moveFiles(moveDialog.files!, { projectId: dest.kind === "drafts" ? null : dest.id }), moveDialog.files.length === 1 ? tr("Moved to {place}", { place: dest.label }) : tr("Moved {n} files to {place}", { n: moveDialog.files.length, place: dest.label }));
            else if (moveDialog.folder && dest.teamId) void write(() => org.projects.move(moveDialog.folder!.id, { teamId: dest.teamId!, parentId: dest.kind === "team" ? null : dest.id }), tr("Moved to {place}", { place: dest.label }));
          }}
        />
      )}
    </main>
  );
}

/** "Join team" when the team's audience lets you in, "Ask to join" for a Visible team, "Requested" once asked (360039957674). */
function JoinButton({ team, onJoin }: { team: O.TeamSummary; onJoin: () => void }) {
  useT();
  if (team.me?.requested) {
    return (
      <Button variant="secondary" disabled>
        {tr("Requested")}
      </Button>
    );
  }
  return (
    <Button variant={team.orgAccess !== "none" ? "primary" : "secondary"} onClick={onJoin}>
      {team.orgAccess !== "none" ? tr("Join team") : tr("Ask to join")}
    </Button>
  );
}

type Write = <T>(fn: () => Promise<T>, done?: string) => Promise<T | undefined>;

/** An invite row: an email and can edit / can view. */
function InviteRow({ onInvite }: { onInvite: (email: string, role: O.GrantRole) => void }) {
  useT();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<O.GrantRole>("editor");
  const ok = /.+@.+/.test(email.trim());
  const send = () => {
    if (!ok) return;
    onInvite(email.trim(), role);
    setEmail("");
  };
  return (
    <div className={styles.inviteRow}>
      <TextInput className={styles.inviteEmail} label={tr("Email")} placeholder={tr("Add people by email")} size="large" value={email} onChange={setEmail} onExit={(r) => r === "enter" && send()} />
      <Select label={tr("Permission")} width="hug" value={role} options={(["editor", "viewer"] as const).map((r) => ({ value: r, label: tr(GRANT_LABEL[r]) }))} onChange={(v) => setRole(v as O.GrantRole)} />
      <Button variant="primary" size="large" disabled={!ok} onClick={send}>
        {tr("Invite")}
      </Button>
    </div>
  );
}

function PersonCell({ m }: { m: Pick<O.TeamMember, "person" | "group" | "email" | "pending"> }) {
  useT();
  const name = m.person?.name ?? m.group?.name ?? m.email ?? "";
  return (
    <span className={styles.memberWho}>
      <Avatar name={name || "?"} src={m.person?.picture ?? undefined} />
      <span className={styles.memberText}>
        <span className={styles.memberName}>{name}</span>
        <span className={styles.mutedText}>{m.group ? tp(m.group.memberCount, "{n} member", "{n} members") : m.pending ? tr("Invited") : (m.person?.email ?? m.email ?? "")}</span>
      </span>
    </span>
  );
}

function TeamMembers({ team, members, requests, orgName, canEdit, canAdmin, write, org }: { team: O.TeamInfo; members: O.TeamMember[]; requests: O.JoinRequest[]; orgName: string; canEdit: boolean; canAdmin: boolean; write: Write; org: OrgBackend }) {
  useT();
  return (
    <div className={styles.membersPane}>
      {canAdmin && (
        <div className={styles.accessRow}>
          <span className={styles.accessLabel}>{tr("Who has access")}</span>
          <Select label={tr("Who has access")} width="hug" value={teamAccessChoice(team)} options={teamAccessOptions(orgName)} onChange={(v) => void write(() => org.teams.update(team.id, teamAccessPatch(v as TeamAccessChoice)))} />
        </div>
      )}
      {canEdit && <InviteRow onInvite={(email, role) => void write(() => org.teams.invite(team.id, { email, role }), tr("Invited {email}", { email }))} />}
      {requests.length > 0 && (
        <section aria-label={tr("Requests to join")}>
          <h2 className={styles.sectionTitle}>{tr("Requests to join")}</h2>
          <ul className={styles.memberList}>
            {requests.map((r) => (
              <li key={r.userId} className={styles.memberRow}>
                <PersonCell m={{ person: r.person, group: null, email: r.person.email, pending: false }} />
                <Button variant="secondary" onClick={() => void write(() => org.teams.answerRequest(team.id, r.userId, false))}>
                  {tr("Decline")}
                </Button>
                <Button variant="primary" onClick={() => void write(() => org.teams.answerRequest(team.id, r.userId, true))}>
                  {tr("Approve")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ul className={styles.memberList} aria-label={tr("Members")}>
        {members.map((m) => (
          <li key={m.principal} className={styles.memberRow}>
            <PersonCell m={m} />
            {canAdmin && !m.owner ? (
              <Select
                label={tr("{name}’s permission", { name: m.person?.name ?? m.email ?? tr("Member") })}
                variant="ghost"
                width="hug"
                value={m.admin ? "admin" : m.role}
                options={[{ value: "admin", label: tr("admin") }, { value: "editor", label: tr("can edit") }, { value: "viewer", label: tr("can view") }, "-", { value: "remove", label: tr("Remove") }]}
                onChange={(v) => {
                  if (v === "remove") void write(() => org.teams.removeMember(team.id, m.principal));
                  else void write(() => org.teams.setMember(team.id, m.principal, v === "admin" ? { admin: true, role: "editor" } : { admin: false, role: v as O.GrantRole }));
                }}
              />
            ) : (
              <span className={styles.memberRole}>{memberRoleLabel(m)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FolderMembers({ project, parentName, members, canEdit, write, org }: { project: O.ProjectInfo; parentName: string; members: O.ProjectMember[]; canEdit: boolean; write: Write; org: OrgBackend }) {
  useT();
  return (
    <div className={styles.membersPane}>
      <div className={styles.accessRow}>
        <span className={styles.accessLabel}>{folderAccessLabel(project.access, parentName, project.name)}</span>
        {canEdit && (
          <Select
            label={tr("Access")}
            width="hug"
            value={project.access}
            options={(["inherited", "limited"] as const).map((a) => ({ value: a, label: tr(INHERIT_LABEL[a]), hint: folderAccessLabel(a, parentName, project.name) }))}
            onChange={(v) => void write(() => org.projects.update(project.id, { access: v as O.InheritMode }))}
          />
        )}
      </div>
      {canEdit && <InviteRow onInvite={(email, role) => void write(() => org.projects.invite(project.id, { email, role }), tr("Invited {email}", { email }))} />}
      <ul className={styles.memberList} aria-label={tr("Members")}>
        {members.map((m) => (
          <li key={m.principal} className={styles.memberRow}>
            <PersonCell m={m} />
            {canEdit && !m.inherited && !m.owner ? (
              <Select
                label={tr("{name}’s permission", { name: m.person?.name ?? m.email ?? tr("Member") })}
                variant="ghost"
                width="hug"
                value={m.role}
                options={[{ value: "editor", label: tr("can edit") }, { value: "viewer", label: tr("can view") }, "-", { value: "remove", label: tr("Remove") }]}
                onChange={(v) => void write(() => (v === "remove" ? org.projects.removeMember(project.id, m.principal) : org.projects.setMember(project.id, m.principal, v as O.GrantRole)))}
              />
            ) : (
              <span className={styles.memberRole}>
                {memberRoleLabel(m)}
                {m.inherited ? ` · ${tr("from team")}` : ""}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A page's name (an org's, a team's): a double-click renames it in place when `onRename` is given */
function EditableTitle({ value, onRename }: { value: string; onRename?: (name: string) => void }) {
  useT();
  const [editing, setEditing] = useState(false);
  return (
    <InlineEdit
      label={tr("Rename")}
      value={value}
      editing={editing}
      editOnDoubleClick={!!onRename}
      onEditingChange={(on) => setEditing(on && !!onRename)}
      onCommit={(name) => {
        setEditing(false);
        onRename?.(name);
      }}
      onCancel={() => setEditing(false)}
      onExit={() => setEditing(false)}
    />
  );
}
