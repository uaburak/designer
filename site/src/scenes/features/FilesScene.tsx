// Files and Home: Figma's file browser as the app draws it (files/Sidebar.tsx, FileBrowser.tsx, ItemsView.tsx) — the
// ds TabBar, SidebarItem, SearchField, Breadcrumb, Select, SegmentedControl, CollectionView, FolderCard, FileCard and
// ListRow in the app's own Home styles (files/Files.module.css), over a small workspace kept in this scene's state.
// Search filters as you type; stars, selection, folders, Trash and the grid/list switch all work.
import { useMemo, useRef, useState } from "react";
import { Breadcrumb } from "@/ds/components/Breadcrumb";
import { Button, IconButton } from "@/ds/components/Button";
import { CollectionView } from "@/ds/components/CollectionView";
import { FileCard, FileKindIcon } from "@/ds/components/FileCard";
import { FolderCard, FolderGlyph } from "@/ds/components/FolderCard";
import { ListHeader, ListRow, type ListColumn } from "@/ds/components/ListView";
import { Avatar } from "@/ds/components/Misc";
import { SearchField } from "@/ds/components/SearchField";
import { SegmentedControl } from "@/ds/components/SegmentedControl";
import { Select } from "@/ds/components/Select";
import { SidebarDivider, SidebarHeader, SidebarItem } from "@/ds/components/SidebarItem";
import { TabBar } from "@/ds/components/TabBar";
import { Icon } from "@/ds/icons/Icon";
import { FOLDER_COLOR_VARS, type FolderColorId } from "@/ds/util/folderColor";
import { formatEdited, timeAgo } from "@/ds/util/time";
import home from "@/files/Files.module.css";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import { THUMBS } from "./thumbnails";
import styles from "./files.module.css";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface File {
  id: string;
  name: string;
  thumb: string;
  folder: string | null;
  edited: number;
  viewed: number;
  starred: boolean;
  trashed?: number;
}
interface Folder {
  id: string;
  name: string;
  color: FolderColorId;
  starred: boolean;
}

const FILES: File[] = [
  { id: "f1", name: "Lumen — Launch", thumb: THUMBS.launch, folder: null, edited: 34 * MIN, viewed: 2 * MIN, starred: true },
  { id: "f2", name: "Mobile app", thumb: THUMBS.mobile, folder: null, edited: 3 * HOUR, viewed: 40 * MIN, starred: false },
  { id: "f3", name: "Design system", thumb: THUMBS.system, folder: null, edited: 1 * DAY, viewed: 3 * HOUR, starred: false },
  { id: "f4", name: "Landing page", thumb: THUMBS.landing, folder: null, edited: 3 * DAY, viewed: 1 * DAY, starred: false },
  { id: "f5", name: "Icons", thumb: THUMBS.icons, folder: null, edited: 6 * DAY, viewed: 2 * DAY, starred: false },
  { id: "f6", name: "Wireframes", thumb: THUMBS.wireframes, folder: "d2", edited: 12 * DAY, viewed: 9 * DAY, starred: false },
  { id: "f7", name: "Brand guidelines", thumb: THUMBS.brand, folder: "d1", edited: 2 * DAY, viewed: 5 * HOUR, starred: false },
  { id: "f8", name: "Pitch deck", thumb: THUMBS.pitch, folder: "d1", edited: 8 * DAY, viewed: 4 * DAY, starred: false },
  { id: "f9", name: "Moodboard", thumb: THUMBS.moodboard, folder: null, edited: 40 * DAY, viewed: 30 * DAY, starred: false, trashed: 2 * DAY },
];
const FOLDERS: Folder[] = [
  { id: "d1", name: "Clients", color: "blue", starred: true },
  { id: "d2", name: "Archive", color: "none", starred: false },
];

type Place = { kind: "recents" } | { kind: "drafts" } | { kind: "folders" } | { kind: "trash" } | { kind: "folder"; id: string };
type Item = { kind: "folder"; folder: Folder; count: number } | { kind: "file"; file: File };
const itemId = (i: Item) => (i.kind === "folder" ? i.folder.id : i.file.id);

const FIRST = { files: FILES, folders: FOLDERS, place: { kind: "drafts" } as Place, layout: "grid" as "grid" | "list", search: "", selected: new Set<string>(), sort: "modified" };

export default function FilesScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [now] = useState(() => Date.now());
  const [files, setFiles] = useState(FIRST.files);
  const [folders, setFolders] = useState(FIRST.folders);
  const [place, setPlace] = useState<Place>(FIRST.place);
  const [layout, setLayout] = useState(FIRST.layout);
  const [search, setSearch] = useState(FIRST.search);
  const [selected, setSelected] = useState<Set<string>>(FIRST.selected);
  const [sort, setSort] = useState(FIRST.sort);
  const [starredOpen, setStarredOpen] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  const reset = () => {
    setFiles(FIRST.files);
    setFolders(FIRST.folders);
    setPlace(FIRST.place);
    setLayout(FIRST.layout);
    setSearch("");
    setSelected(new Set());
    setSort("modified");
    setHover(null);
  };
  const go = (p: Place) => {
    setPlace(p);
    setSelected(new Set());
    setSearch("");
  };

  const at = (ago: number) => now - ago;
  const items = useMemo<Item[]>(() => {
    const q = search.trim().toLowerCase();
    const live = files.filter((f) => !f.trashed);
    const count = (id: string) => live.filter((f) => f.folder === id).length;
    let list: Item[];
    if (q) {
      // Search looks through every folder (Figma's search results), files and folders by name
      list = [
        ...folders.filter((d) => d.name.toLowerCase().includes(q)).map((folder) => ({ kind: "folder" as const, folder, count: count(folder.id) })),
        ...live.filter((f) => f.name.toLowerCase().includes(q)).map((file) => ({ kind: "file" as const, file })),
      ];
    } else if (place.kind === "folders") list = folders.map((folder) => ({ kind: "folder", folder, count: count(folder.id) }));
    else if (place.kind === "trash") list = files.filter((f) => f.trashed).map((file) => ({ kind: "file", file }));
    else if (place.kind === "recents") list = [...live].sort((a, b) => a.viewed - b.viewed).map((file) => ({ kind: "file", file }));
    else {
      const folder = place.kind === "folder" ? place.id : null;
      list = live.filter((f) => f.folder === folder).map((file) => ({ kind: "file", file }));
    }
    if (sort === "name") list.sort((a, b) => (a.kind === b.kind ? (a.kind === "folder" ? a.folder.name : a.file.name).localeCompare(b.kind === "folder" ? b.folder.name : b.file.name) : a.kind === "folder" ? -1 : 1));
    else if (place.kind !== "recents" || q) list.sort((a, b) => (a.kind === "folder" ? -1 : b.kind === "folder" ? 1 : a.file.edited - b.file.edited));
    return list;
  }, [files, folders, place, search, sort]);

  const title = search.trim() ? "Search" : place.kind === "recents" ? "Recents" : place.kind === "drafts" ? "Drafts" : place.kind === "folders" ? "All folders" : place.kind === "trash" ? "Trash" : (folders.find((d) => d.id === place.id)?.name ?? "");
  const crumbs = place.kind === "folder" && !search.trim() ? [{ id: "folders", label: "All folders" }, { id: place.id, label: title }] : [{ id: "here", label: title }];

  const star = (it: Item, on: boolean) => {
    if (it.kind === "file") setFiles((fs) => fs.map((f) => (f.id === it.file.id ? { ...f, starred: on } : f)));
    else setFolders((ds) => ds.map((d) => (d.id === it.folder.id ? { ...d, starred: on } : d)));
  };
  const click = (e: React.MouseEvent | React.KeyboardEvent, id: string) => {
    e.stopPropagation();
    setSelected((s) => {
      if (!(e.shiftKey || e.metaKey || e.ctrlKey)) return new Set([id]);
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const open = (it: Item) => {
    if (it.kind === "folder") go({ kind: "folder", id: it.folder.id });
  };

  const inTrash = place.kind === "trash" && !search.trim();
  const columns: ListColumn[] = [
    { id: "name", label: "Name" },
    { id: "date", label: inTrash ? "Deleted" : place.kind === "recents" ? "Last viewed" : "Last modified", width: "minmax(0, 160px)" },
    { id: "place", label: "Location", width: "minmax(0, 140px)" },
  ];
  const placeOf = (f: File) => (f.folder ? (folders.find((d) => d.id === f.folder)?.name ?? "") : "Drafts");
  const subtitle = (f: File) => (f.trashed ? `Deleted ${timeAgo(at(f.trashed), now)}` : place.kind === "recents" && !search.trim() ? `Viewed ${timeAgo(at(f.viewed), now)}` : formatEdited(at(f.edited), now));
  const nameCell = (name: string, icon: React.ReactNode, starred: boolean) => (
    <span className={home.rowName}>
      {icon}
      <span className={home.rowTitle}>{name}</span>
      {starred && (
        <span className={home.rowStar} aria-label="Starred">
          <Icon name="24.star" />
        </span>
      )}
    </span>
  );

  const children = items.map((it) => {
    const id = itemId(it);
    const events = { selected: selected.has(id), onSelect: (e: React.MouseEvent | React.KeyboardEvent) => click(e, id), onOpen: () => open(it), forceHover: hover === id };
    if (it.kind === "folder") {
      const d = it.folder;
      if (layout === "list") return <ListRow key={id} id={id} columns={columns} cells={{ name: nameCell(d.name, <FolderGlyph color={FOLDER_COLOR_VARS[d.color]} />, d.starred), date: it.count === 1 ? "1 file" : `${it.count} files`, place: "All folders" }} {...events} />;
      const thumbs = files.filter((f) => f.folder === d.id && !f.trashed).map((f) => f.thumb);
      return <FolderCard key={id} id={id} title={d.name} subtitle={it.count === 1 ? "1 file" : `${it.count} files`} color={FOLDER_COLOR_VARS[d.color]} thumbnails={thumbs} starred={d.starred} onStar={(on) => star(it, on)} {...events} />;
    }
    const f = it.file;
    if (layout === "list") return <ListRow key={id} id={id} columns={columns} cells={{ name: nameCell(f.name, <span className={home.kindCell}><FileKindIcon /></span>, f.starred), date: timeAgo(at(f.trashed ?? (place.kind === "recents" ? f.viewed : f.edited)), now), place: placeOf(f) }} muted={!!f.trashed} {...events} />;
    return <FileCard key={id} id={id} title={f.name} subtitle={subtitle(f)} thumbnail={f.thumb} starred={f.starred} onStar={f.trashed ? undefined : (on) => star(it, on)} {...events} />;
  });

  const { cursor } = useDemo(rootRef, (run) => filesDemo(run, { setSearch, setHover, setLayout, star: (id, on) => setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, starred: on } : f))), select: (id) => setSelected(new Set(id ? [id] : [])) }), { onStart: reset});

  const is = (k: Place["kind"]) => place.kind === k && !search.trim();
  return (
    <div ref={rootRef} className={styles.window}>
      <div className={styles.tabbar}>
        <TabBar tabs={[{ id: "f1", title: "Lumen — Launch" }]} active="home" onActivate={() => {}} onClose={() => {}} onNew={() => {}} />
      </div>
      <div className={`${home.app} ${styles.app}`}>
        <nav className={`${home.sidebar} ${styles.sidebar}`} aria-label="File browser">
          <div className={home.accountRow}>
            <div className={home.account}>
              <Avatar name="Ada Park" />
              <span className={home.accountName}>Ada Park</span>
              <Icon name="16.chevron.down" />
            </div>
            <IconButton icon="24.bell" label="Notifications" />
          </div>
          <div className={home.search} data-demo="search">
            <SearchField value={search} onChange={setSearch} size="large" placeholder="Search" onExit={(r) => r === "escape" && setSearch("")} />
          </div>
          <div className={home.navGroup}>
            <SidebarItem icon="24.recent" label="Recents" selected={is("recents")} onClick={() => go({ kind: "recents" })} />
          </div>
          <SidebarDivider />
          <div className={home.team}>
            <Avatar name="Ada Park" size={16} />
            <span className={home.teamName}>Ada’s team</span>
          </div>
          <div className={home.navGroup}>
            <SidebarItem icon="24.file" label="Drafts" selected={is("drafts")} onClick={() => go({ kind: "drafts" })} />
            <SidebarItem icon="24.view.grid" label="All folders" selected={is("folders")} onClick={() => go({ kind: "folders" })} />
            {folders.map((d) => (
              <SidebarItem key={d.id} icon={<FolderGlyph color={FOLDER_COLOR_VARS[d.color]} size={16} />} label={d.name} indent={1} selected={place.kind === "folder" && place.id === d.id && !search.trim()} onClick={() => go({ kind: "folder", id: d.id })} />
            ))}
            <SidebarItem icon="24.trash.outline" label="Trash" selected={is("trash")} onClick={() => go({ kind: "trash" })} />
          </div>
          <SidebarDivider />
          <SidebarHeader title="Starred" open={starredOpen} onOpenChange={setStarredOpen} />
          {starredOpen && (
            <div className={home.navGroup} data-demo="starred">
              {folders.filter((d) => d.starred).map((d) => (
                <SidebarItem key={d.id} icon={<FolderGlyph color={FOLDER_COLOR_VARS[d.color]} size={16} />} label={d.name} onClick={() => go({ kind: "folder", id: d.id })} />
              ))}
              {files.filter((f) => f.starred && !f.trashed).map((f) => (
                <SidebarItem key={f.id} icon={<FileKindIcon />} label={f.name} onClick={() => setSelected(new Set([f.id]))} />
              ))}
            </div>
          )}
        </nav>
        <main className={home.main}>
          <div className={home.topbar}>
            <div className={home.nav}>
              <IconButton icon="24.arrow.left" label="Back" tone="secondary" disabled={place.kind !== "folder"} onClick={() => go({ kind: "folders" })} />
              <IconButton icon="24.arrow.right" label="Forward" tone="secondary" disabled />
            </div>
            <div className={home.title}>
              <Breadcrumb items={crumbs} onNavigate={(id) => id === "folders" && go({ kind: "folders" })} />
            </div>
            <div className={styles.topSearch} data-demo="search">
              <SearchField value={search} onChange={setSearch} placeholder="Search" onExit={(r) => r === "escape" && setSearch("")} />
            </div>
            <div className={`${home.create} ${styles.create}`}>
              <Button variant="tinted" icon="24.figma">
                Design
              </Button>
              <Button variant="tinted" icon="24.plus.small">
                Import
              </Button>
            </div>
          </div>
          <div className={home.filters}>
            <span className={home.grow} />
            <Select label="Files shown" variant="ghost" width="hug" value="all" options={[{ value: "all", label: "All files" }, { value: "design", label: "Design files" }]} onChange={() => {}} />
            <Select label="Sort" variant="ghost" width="hug" value={sort} options={[{ value: "modified", label: "Last modified" }, { value: "name", label: "Alphabetical" }]} onChange={setSort} />
            <SegmentedControl
              label="View"
              data-demo="layout"
              value={layout}
              onChange={(v) => setLayout(v as "grid" | "list")}
              options={[
                { value: "grid", icon: "24.view.grid", tooltip: "Grid view" },
                { value: "list", icon: "24.view.list", tooltip: "List view" },
              ]}
            />
          </div>
          <div className={`${home.content} ${styles.content}`} onClick={() => setSelected(new Set())}>
            {items.length ? (
              <CollectionView
                className={home.collection}
                layout={layout}
                label={place.kind === "folders" ? "Folders" : "Files"}
                header={layout === "list" ? <ListHeader columns={columns} /> : undefined}
                onClearSelection={() => setSelected(new Set())}
                onSelectAll={() => setSelected(new Set(items.map(itemId)))}
              >
                {children}
              </CollectionView>
            ) : (
              <div className={home.empty}>
                <p className={styles.emptyText}>{search.trim() ? `No results for “${search.trim()}”` : place.kind === "trash" ? "Trash is empty" : "No files yet"}</p>
              </div>
            )}
          </div>
        </main>
      </div>
      <DemoCursor cursor={cursor} />
    </div>
  );
}

interface FilesActions {
  setSearch: (s: string) => void;
  setHover: (id: string | null) => void;
  setLayout: (l: "grid" | "list") => void;
  star: (id: string, on: boolean) => void;
  select: (id: string | null) => void;
}

/** Search for "land" as you would type it, star the landing page from its card, clear the search, switch to the list. */
async function filesDemo(run: SceneRun, a: FilesActions) {
  try {
    await filesSteps(run, a);
  } catch (e) {
    // Touched mid-demo: no half-typed search or forced hover left behind
    a.setSearch("");
    a.setHover(null);
    throw e;
  }
}

async function filesSteps(run: SceneRun, a: FilesActions) {
  await run.wait(700);
  const field = [...run.root.querySelectorAll<HTMLElement>('[data-demo="search"] input')].find((el) => el.offsetParent !== null) ?? null;
  await run.click(field);
  for (const [i] of [..."land"].entries()) {
    a.setSearch("land".slice(0, i + 1));
    await run.wait(170);
  }
  await run.wait(700);
  const card = () => run.$('[data-ds="FileCard"][data-id="f4"]');
  await run.move(card(), { dy: -20 });
  a.setHover("f4");
  await run.wait(400);
  await run.click(run.$('[data-ds="FileCard"][data-id="f4"] button[aria-label="Star"]'));
  a.star("f4", true);
  await run.wait(500);
  a.select("f4");
  a.setHover(null);
  await run.wait(900);
  // Clear the search: Drafts again, the new star in the sidebar
  await run.click(field);
  a.setSearch("");
  a.select(null);
  await run.wait(700);
  await run.move(run.$('[data-demo="starred"]'));
  await run.wait(900);
  await run.click(run.$('[data-demo="layout"] [role="radio"]:nth-child(2), [data-demo="layout"] button:nth-child(2)'));
  a.setLayout("list");
  await run.wait(1800);
  await run.click(run.$('[data-demo="layout"] [role="radio"]:nth-child(1), [data-demo="layout"] button:nth-child(1)'));
  a.setLayout("grid");
  run.hide();
  await run.wait(900);
}
