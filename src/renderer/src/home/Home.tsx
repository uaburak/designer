import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import type { ProjectMeta } from "@/types/project";
import { deleteProject, errorText, listProjects, reorderProjects, restoreProject, trashProject, unpublishProject } from "@/lib/firestore";
import { SITE_URL } from "@/lib/siteConfig";
import { cn } from "@/lib/utils";
import { ContextMenu, keys, type MenuEntry } from "@/components/admin/ContextMenu";
import { fi } from "@/components/admin/figmaIcons";
import { useTheme } from "@/context/ThemeContext";
import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon, ClockIcon, FileIcon, FolderIcon, GlobeIcon, GridIcon, ListIcon, PlusIcon, SearchIcon, TrashIcon } from "@/app/icons";
import { openExternal } from "@/app/native";
import { Button, IconButton, Modal, Spinner } from "@/app/ui";
import { publishSaved } from "./actions";
import { DeleteForeverDialog, DuplicateDialog } from "./dialogs";
import { FileCard, FileRow } from "./FileCard";
import { LibraryView } from "./Library";
import { forgetOpened, setBrowse, setStarred, useBrowse, useRecents, useStarred, type Filter, type Sort } from "./prefs";
import { Sidebar, type ViewKind } from "./Sidebar";

/**
 * Home — Figma's file browser for the site's projects: the views on the
 * left, the files of the one picked as cards (or a list). A click opens a
 * file in a tab; ⌘/⇧-click selects; the right click, ⌫, ⌘A and Enter work on
 * the selection. Moving to the trash takes a project off the site and out of
 * the lists (Undo brings it back); the trash deletes for good.
 */

interface Props {
  user: User;
  /** Home is the tab in front */
  visible: boolean;
  /** The projects open in tabs */
  openTabs: ReadonlySet<string>;
  /** A tab saved at (ms): the list is read again */
  savedAt: number;
  onOpen: (slug: string, title?: string) => void;
  /** The CV's editor, in its tab */
  onOpenCv: () => void;
  onNewProject: () => void;
  onSignOut: () => void;
}

const VIEW_KEY = "designer-home-view";
const TITLES: Record<ViewKind, string> = { recents: "Recents", published: "Published", drafts: "Drafts", all: "All projects", library: "Library", trash: "Trash", search: "Search" };
const FILTERS: Record<Filter, string> = { all: "All projects", published: "Published", drafts: "Drafts", changed: "Changed since published" };
const SORTS: Record<Sort, string> = { modified: "Last modified", opened: "Last opened", created: "Date created", name: "Alphabetical", order: "Site order" };

const fold = (text: string) => text.toLocaleLowerCase("tr").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");

const passes = (filter: Filter) => (p: ProjectMeta) =>
  filter === "all" || (filter === "published" ? p.published : filter === "drafts" ? !p.published : p.published && p.changedSincePublish);

type Dialog = { kind: "duplicate"; project: ProjectMeta } | { kind: "delete"; projects: ProjectMeta[] } | { kind: "unpublish"; project: ProjectMeta };

export function Home({ user, visible, openTabs, savedAt, onOpen, onOpenCv, onNewProject, onSignOut }: Props) {
  const [view, setViewState] = useState<ViewKind>(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY) as ViewKind | null;
      return saved && saved in TITLES && saved !== "search" ? saved : "recents";
    } catch {
      return "recents";
    }
  });
  const [past, setPast] = useState<ViewKind[]>([]);
  const [future, setFuture] = useState<ViewKind[]>([]);
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [toast, setToast] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null);
  const [drag, setDrag] = useState<{ slug: string; over: string | null; side: "before" | "after" } | null>(null);
  const browse = useBrowse();
  const recents = useRecents();
  const starredSlugs = useStarred();
  const { preference, setPreference } = useTheme();

  // ── The list, read when Home comes to the front, after a save in a tab, when the window comes back ──
  const load = useCallback(
    () =>
      listProjects().then(
        (list) => {
          setProjects(list);
          setLoadError("");
        },
        (err) => {
          setLoadError(errorText(err));
          setProjects((p) => p ?? []);
        }
      ),
    []
  );
  useEffect(() => {
    if (visible) void load();
  }, [visible, savedAt, load]);
  useEffect(() => {
    if (!visible) return;
    const again = () => document.visibilityState === "visible" && void load();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [visible, load]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), toast.action ? 6000 : 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const setView = useCallback((next: ViewKind) => {
    setQuery("");
    setSelected(new Set());
    setViewState((prev) => {
      if (prev !== next) {
        setPast((p) => [...p, prev].slice(-30));
        setFuture([]);
      }
      return next;
    });
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* this launch */
    }
  }, []);
  const back = () => {
    const prev = past[past.length - 1];
    if (!prev) return;
    setPast(past.slice(0, -1));
    setFuture([view, ...future]);
    setViewState(prev);
    setSelected(new Set());
  };
  const forward = () => {
    const [next, ...rest] = future;
    if (!next) return;
    setFuture(rest);
    setPast([...past, view]);
    setViewState(next);
    setSelected(new Set());
  };

  // ── What is shown ──
  const shownView: ViewKind = query.trim() ? "search" : view;
  const bySlug = useMemo(() => new Map((projects ?? []).map((p) => [p.slug, p])), [projects]);
  const alive = useMemo(() => (projects ?? []).filter((p) => !p.trashedAt), [projects]);
  const trashed = useMemo(() => (projects ?? []).filter((p) => p.trashedAt), [projects]);
  const sortable = shownView !== "recents" && shownView !== "trash" && shownView !== "library";
  const filterable = shownView === "all" || shownView === "search" || shownView === "recents";
  const sort: Sort = sortable ? browse.sort : shownView === "recents" ? "opened" : "modified";
  const reorderable = shownView === "all" && browse.filter === "all" && sort === "order";

  const shown = useMemo(() => {
    let list: ProjectMeta[];
    switch (shownView) {
      case "recents":
        list = recents.map((r) => bySlug.get(r.slug)).filter((p): p is ProjectMeta => Boolean(p && !p.trashedAt));
        break;
      case "published":
        list = alive.filter((p) => p.published);
        break;
      case "drafts":
        list = alive.filter((p) => !p.published);
        break;
      case "trash":
        list = [...trashed].sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
        break;
      case "search": {
        const q = fold(query.trim());
        list = alive.filter((p) => fold(`${p.title} ${p.slug} ${p.category} ${p.year} ${p.company ?? ""}`).includes(q));
        break;
      }
      case "library":
        return [];
      default:
        list = alive;
    }
    if (filterable) list = list.filter(passes(browse.filter));
    if (!sortable) return list;
    const opened = new Map(recents.map((r) => [r.slug, r.at]));
    const by: Record<Sort, (a: ProjectMeta, b: ProjectMeta) => number> = {
      modified: (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
      opened: (a, b) => (opened.get(b.slug) ?? 0) - (opened.get(a.slug) ?? 0),
      created: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
      name: (a, b) => (a.title || a.slug).localeCompare(b.title || b.slug, "tr"),
      order: (a, b) => a.order - b.order || a.slug.localeCompare(b.slug),
    };
    return [...list].sort(by[sort]);
  }, [shownView, recents, bySlug, alive, trashed, query, filterable, browse.filter, sortable, sort]);

  const starredProjects = useMemo(() => starredSlugs.map((s) => bySlug.get(s)).filter((p): p is ProjectMeta => Boolean(p && !p.trashedAt)), [starredSlugs, bySlug]);
  const counts = useMemo(() => ({ drafts: alive.filter((p) => !p.published).length, trash: trashed.length }), [alive, trashed]);
  const taken = useMemo(() => new Set((projects ?? []).map((p) => p.slug)), [projects]);

  // ── Actions ──
  const say = (text: string, action?: { label: string; run: () => void }) => setToast({ text, action });
  const patchLocal = (slugs: string[], patch: Partial<ProjectMeta>) => setProjects((list) => list?.map((p) => (slugs.includes(p.slug) ? { ...p, ...patch } : p)) ?? list);

  const restore = useCallback(async (slugs: string[]) => {
    patchLocal(slugs, { trashedAt: null });
    setSelected(new Set());
    try {
      await Promise.all(slugs.map(restoreProject));
      say(slugs.length === 1 ? "Restored — it’s a draft again" : `${slugs.length} projects restored as drafts`);
    } catch (err) {
      say(`Couldn’t restore: ${errorText(err)}`);
    }
    void load();
  }, [load]);

  const trash = useCallback(async (slugs: string[]) => {
    if (!slugs.length) return;
    patchLocal(slugs, { trashedAt: Date.now(), published: false });
    setSelected(new Set());
    try {
      await Promise.all(slugs.map(trashProject));
      const one = slugs.length === 1 ? bySlug.get(slugs[0]) : null;
      say(one ? `“${one.title || one.slug}” moved to trash` : `${slugs.length} projects moved to trash`, { label: "Undo", run: () => void restore(slugs) });
    } catch (err) {
      say(`Couldn’t move to trash: ${errorText(err)}`);
    }
    void load();
  }, [bySlug, load, restore]);

  const publish = useCallback(async (project: ProjectMeta) => {
    say(`Publishing “${project.title || project.slug}”…`);
    try {
      await publishSaved(project.slug);
      say(`“${project.title || project.slug}” is on the site`, { label: "View", run: () => openExternal(`${SITE_URL}/projects/${project.slug}`) });
    } catch (err) {
      say(`Couldn’t publish: ${errorText(err)}`);
    }
    void load();
  }, [load]);

  const unpublish = useCallback(async (project: ProjectMeta) => {
    patchLocal([project.slug], { published: false });
    try {
      await unpublishProject(project.slug);
      say(`“${project.title || project.slug}” is off the site — its draft stays`);
    } catch (err) {
      say(`Couldn’t unpublish: ${errorText(err)}`);
    }
    void load();
  }, [load]);

  /** The new order: each project's place as listed — the site's lists follow. Put back when it can't be written. */
  const reorder = useCallback(async (moving: string, target: string, side: "before" | "after") => {
    if (moving === target) return;
    const list = [...alive].sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
    const item = list.find((p) => p.slug === moving);
    if (!item) return;
    const rest = list.filter((p) => p.slug !== moving);
    const at = rest.findIndex((p) => p.slug === target) + (side === "after" ? 1 : 0);
    rest.splice(at, 0, item);
    const before = projects;
    const order = new Map(rest.map((p, i) => [p.slug, i + 1]));
    setProjects((all) => all?.map((p) => (order.has(p.slug) ? { ...p, order: order.get(p.slug)! } : p)) ?? all);
    try {
      await reorderProjects(rest);
    } catch (err) {
      setProjects(before);
      say(`Couldn’t save the order: ${errorText(err)}`);
    }
  }, [alive, projects]);

  // ── Picking ──
  const press = useCallback((slug: string, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setSelected((sel) => {
        const next = new Set(sel);
        if (next.has(slug)) next.delete(slug);
        else next.add(slug);
        return next;
      });
      anchor.current = slug;
      return;
    }
    if (e.shiftKey && anchor.current) {
      const a = shown.findIndex((p) => p.slug === anchor.current);
      const b = shown.findIndex((p) => p.slug === slug);
      if (a >= 0 && b >= 0) {
        setSelected(new Set(shown.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.slug)));
        return;
      }
    }
    anchor.current = slug;
    // The trash's files don't open: they are restored first.
    if (shownView === "trash") return setSelected(new Set([slug]));
    setSelected(new Set());
    onOpen(slug, bySlug.get(slug)?.title);
  }, [shown, shownView, onOpen, bySlug]);

  const projectMenu = useCallback((slug: string, e: React.MouseEvent) => {
    const slugs = selected.has(slug) ? [...selected] : [slug];
    if (!selected.has(slug)) setSelected(new Set([slug]));
    const list = slugs.map((s) => bySlug.get(s)).filter((p): p is ProjectMeta => Boolean(p));
    const one = list.length === 1 ? list[0] : null;
    const many = list.length > 1 ? ` ${list.length} projects` : "";
    const allStarred = slugs.every((s) => starredSlugs.includes(s));
    const entries: MenuEntry[] = list.some((p) => p.trashedAt)
      ? [
          { label: `Restore${many}`, onSelect: () => void restore(slugs) },
          "-",
          { label: `Delete${many} forever…`, onSelect: () => setDialog({ kind: "delete", projects: list }) },
        ]
      : [
          { label: one ? "Open" : `Open${many}`, onSelect: () => list.forEach((p) => onOpen(p.slug, p.title)) },
          ...(one
            ? [
                { label: "View on site", disabled: !one.published, onSelect: () => openExternal(`${SITE_URL}/projects/${one.slug}`) },
                { label: "Copy link", onSelect: () => void navigator.clipboard?.writeText(`${SITE_URL}/projects/${one.slug}`).then(() => say("Link copied")) },
              ]
            : []),
          "-",
          { label: allStarred ? "Remove from starred" : "Add to starred", onSelect: () => setStarred(slugs, !allStarred) },
          ...(shownView === "recents" ? [{ label: "Remove from recents", onSelect: () => forgetOpened(slugs) }] : []),
          ...(one
            ? [
                "-" as const,
                { label: !one.published ? "Publish" : one.changedSincePublish ? "Update on site" : "Publish again", hint: openTabs.has(one.slug) ? "as saved" : undefined, onSelect: () => void publish(one) },
                ...(one.published ? [{ label: "Unpublish…", onSelect: () => setDialog({ kind: "unpublish", project: one }) }] : []),
                { label: "Duplicate…", onSelect: () => setDialog({ kind: "duplicate", project: one }) },
              ]
            : []),
          "-",
          { label: `Move${many} to trash`, shortcut: keys("backspace"), onSelect: () => void trash(slugs) },
        ];
    setMenu({ x: e.clientX, y: e.clientY, entries });
  }, [selected, bySlug, starredSlugs, restore, onOpen, shownView, openTabs, publish, trash]);

  // ── Keys, while Home is in front (not while typing in the search) ──
  const keyState = useRef({ shown, selected, shownView, trash, bySlug, onOpen });
  useLayoutEffect(() => {
    keyState.current = { shown, selected, shownView, trash, bySlug, onOpen };
  });
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true], [role=dialog], [role=menu]")) return;
      const { shown: list, selected: sel, shownView: v, trash: toTrash, bySlug: map, onOpen: open } = keyState.current;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.code === "KeyA") {
        e.preventDefault();
        setSelected(new Set(list.map((p) => p.slug)));
      } else if (e.key === "Escape") {
        setSelected(new Set());
      } else if ((e.key === "Backspace" || e.key === "Delete") && sel.size) {
        e.preventDefault();
        if (v === "trash") setDialog({ kind: "delete", projects: [...sel].map((s) => map.get(s)).filter((p): p is ProjectMeta => Boolean(p)) });
        else void toTrash([...sel]);
      } else if (e.key === "Enter" && sel.size && v !== "trash") {
        e.preventDefault();
        [...sel].forEach((s) => open(s, map.get(s)?.title));
      } else if (mod && e.code === "KeyF") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>("[data-home-search]")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  // ── Menus of the header and the account ──
  const under = (el: HTMLElement, entries: MenuEntry[], align: "left" | "right" = "left") => {
    const r = el.getBoundingClientRect();
    setMenu({ x: align === "left" ? r.left : r.right - 208, y: r.bottom + 4, entries });
  };
  const accountMenu = (el: HTMLElement) =>
    under(el, [
      { label: user.displayName ?? user.email ?? "Signed in", hint: user.displayName ? user.email ?? undefined : undefined, disabled: true },
      "-",
      { label: "Theme", items: (["system", "light", "dark"] as const).map((t) => ({ label: t === "system" ? "Use system setting" : t === "light" ? "Light" : "Dark", checked: preference === t, onSelect: () => setPreference(t) })) },
      { label: "Open burakkoc.net", onSelect: () => openExternal(SITE_URL) },
      "-",
      { label: "Sign out", onSelect: onSignOut },
    ]);
  const titleMenu = (el: HTMLElement) =>
    under(el, [
      { label: "New project…", shortcut: keys("mod", "n"), onSelect: onNewProject },
      { label: "Refresh", onSelect: () => void load() },
      ...(view === "trash" ? ["-" as const, { label: "Empty trash…", disabled: !trashed.length, onSelect: () => setDialog({ kind: "delete", projects: trashed }) }] : []),
    ]);
  const filterMenu = (el: HTMLElement) => under(el, (Object.keys(FILTERS) as Filter[]).map((f) => ({ label: FILTERS[f], checked: browse.filter === f, onSelect: () => setBrowse({ filter: f }) })), "right");
  const sortMenu = (el: HTMLElement) => under(el, (Object.keys(SORTS) as Sort[]).map((s) => ({ label: SORTS[s], checked: sort === s, onSelect: () => setBrowse({ sort: s }) })), "right");

  // ── Drag to reorder (Site order) ──
  const dragProps = {
    draggable: reorderable,
    onDragStart: (slug: string) => setDrag({ slug, over: null, side: "before" }),
    onDragOver: (slug: string, e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const side: "before" | "after" = browse.layout === "grid" ? (e.clientX < r.left + r.width / 2 ? "before" : "after") : e.clientY < r.top + r.height / 2 ? "before" : "after";
      if (drag.over !== slug || drag.side !== side) setDrag({ ...drag, over: slug, side });
    },
    onDrop: (slug: string) => {
      if (drag) void reorder(drag.slug, slug, drag.side);
      setDrag(null);
    },
    onDragEnd: () => setDrag(null),
  };

  const icon = { recents: <ClockIcon />, published: <GlobeIcon />, drafts: <FileIcon />, all: <GridIcon />, library: null, trash: <TrashIcon />, search: <SearchIcon /> }[shownView];

  return (
    <div className="flex h-full bg-[var(--f-bg)] text-[var(--f-text)]">
      <Sidebar
        user={user}
        view={view}
        query={query}
        onQuery={setQuery}
        onView={setView}
        starred={starredProjects}
        counts={counts}
        onOpen={(slug) => onOpen(slug, bySlug.get(slug)?.title)}
        onOpenCv={onOpenCv}
        onAccountMenu={accountMenu}
        onStarredMenu={projectMenu}
      />
      <main className="flex flex-col flex-1 min-w-0">
        {/* The top: back and forward, where it is, Create */}
        <div className="flex items-center gap-1 h-12 shrink-0 pl-4 pr-4 border-b border-[var(--f-border)] select-none">
          <IconButton label="Back" disabled={!past.length} onClick={back}>
            <ArrowLeftIcon />
          </IconButton>
          <IconButton label="Forward" disabled={!future.length} onClick={forward}>
            <ArrowRightIcon />
          </IconButton>
          <span className="ml-1 min-w-0 truncate text-[13px] leading-5 text-[var(--f-text)]">
            burakkoc.net
            {shownView !== "all" && <span className="text-[var(--f-text-secondary)]"> / {shownView === "search" ? `Search “${query.trim()}”` : TITLES[shownView]}</span>}
          </span>
          <div className="flex-1" />
          <div className="flex items-center rounded-[6px] bg-[var(--f-bg-brand)] text-white">
            <button type="button" onClick={onNewProject} className="flex items-center gap-1.5 h-8 pl-2 pr-2.5 rounded-l-[6px] text-[13px] font-[500] leading-5 hover:bg-white/10">
              <PlusIcon size={20} />
              Create
            </button>
            <span className="w-px h-8 bg-white/25" />
            <button
              type="button"
              aria-label="Create menu"
              onClick={(e) =>
                under(e.currentTarget, [
                  { label: "New project…", shortcut: keys("mod", "n"), onSelect: onNewProject },
                  ...(selected.size === 1 && bySlug.get([...selected][0]) && !bySlug.get([...selected][0])!.trashedAt
                    ? [{ label: `Duplicate “${bySlug.get([...selected][0])!.title}”…`, onSelect: () => setDialog({ kind: "duplicate", project: bySlug.get([...selected][0])! }) }]
                    : []),
                ], "right")
              }
              className="flex items-center justify-center w-8 h-8 rounded-r-[6px] hover:bg-white/10"
            >
              <ChevronDownIcon />
            </button>
          </div>
          <Button className="ml-2" onClick={() => openExternal(SITE_URL)}>View site</Button>
        </div>

        {/* The view */}
        <div
          className="flex-1 min-h-0 overflow-y-auto"
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest("[role=button], [role=row], button, input")) setSelected(new Set());
          }}
        >
          <div className="px-8 pt-6 pb-24">
            <div className="flex items-center gap-3 h-10 mb-6 select-none">
              {shownView === "library" ? <FolderIcon size={32} className="shrink-0 text-[#9ab0cc]" /> : <span className="flex shrink-0 items-center justify-center w-8 h-8 text-[var(--f-icon)] [&>svg]:w-8 [&>svg]:h-8">{icon}</span>}
              <button type="button" aria-haspopup="menu" onClick={(e) => titleMenu(e.currentTarget)} className="flex items-center gap-1.5 min-w-0 h-10 px-2 -ml-1 rounded-[6px] hover:bg-[var(--f-bg-hover)]">
                <h1 className="min-w-0 truncate text-[24px] font-[600] leading-8 tracking-[-0.02em]">{shownView === "search" ? `“${query.trim()}”` : TITLES[shownView]}</h1>
                <span className="text-[var(--f-icon-secondary)]">
                  <ChevronDownIcon />
                </span>
              </button>
              <div className="flex-1" />
              {shownView !== "library" && (
                <>
                  {filterable && <Pill label={FILTERS[browse.filter]} onClick={filterMenu} />}
                  {sortable && <Pill label={SORTS[sort]} onClick={sortMenu} />}
                  {shownView === "trash" && <span className="text-[11px] text-[var(--f-text-secondary)]">Off the site and out of the lists — restore them, or delete them for good.</span>}
                  <div className="flex items-center ml-1">
                    <IconButton label="Grid" active={browse.layout === "grid"} onClick={() => setBrowse({ layout: "grid" })} className="w-7 h-7">
                      <GridIcon size={20} />
                    </IconButton>
                    <IconButton label="List" active={browse.layout === "list"} onClick={() => setBrowse({ layout: "list" })} className="w-7 h-7">
                      <ListIcon size={20} />
                    </IconButton>
                  </div>
                </>
              )}
            </div>

            {loadError && (
              <div role="alert" className="flex items-center gap-3 mb-6 px-3 py-2 rounded-[8px] border border-[#f24822]/40 bg-[#f24822]/10 text-[12px] leading-4">
                <span className="flex-1">Couldn’t load the projects: {loadError}</span>
                <Button size="small" onClick={() => void load()}>Try again</Button>
              </div>
            )}

            {shownView === "library" ? (
              <LibraryView />
            ) : projects === null ? (
              <div className="flex justify-center pt-24">
                <Spinner />
              </div>
            ) : shown.length === 0 ? (
              <Empty view={shownView} filtered={filterable && browse.filter !== "all"} onNew={onNewProject} onAll={() => setView("all")} />
            ) : browse.layout === "grid" ? (
              <div className="grid gap-8" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
                {shown.map((p) => (
                  <FileCard key={p.slug} project={p} selected={selected.has(p.slug)} starred={starredSlugs.includes(p.slug)} open={openTabs.has(p.slug)} when={shownView === "trash" ? "trashed" : "edited"} dropSide={drag && drag.over === p.slug && drag.slug !== p.slug ? drag.side : null} onPress={press} onMenu={projectMenu} {...dragProps} />
                ))}
              </div>
            ) : (
              <div role="table" className="flex flex-col">
                <div role="row" className="grid grid-cols-[minmax(0,1fr)_96px_150px_150px] gap-4 h-8 px-2 items-center text-[11px] leading-4 text-[var(--f-text-secondary)] border-b border-[var(--f-border)] mb-1 select-none">
                  <span>Name</span>
                  <span>Site</span>
                  <span>{shownView === "trash" ? "Deleted" : "Last edited"}</span>
                  <span>Created</span>
                </div>
                {shown.map((p) => (
                  <FileRow key={p.slug} project={p} selected={selected.has(p.slug)} starred={starredSlugs.includes(p.slug)} open={openTabs.has(p.slug)} when={shownView === "trash" ? "trashed" : "edited"} dropSide={drag && drag.over === p.slug && drag.slug !== p.slug ? drag.side : null} onPress={press} onMenu={projectMenu} {...dragProps} />
                ))}
              </div>
            )}
            {reorderable && shown.length > 1 && <p className="mt-8 text-[11px] leading-4 text-[var(--f-text-tertiary)] select-none">Drag the files to change the order the site lists them in.</p>}
          </div>
        </div>
      </main>

      {menu && <ContextMenu at={menu} entries={menu.entries} onClose={() => setMenu(null)} />}

      {dialog?.kind === "duplicate" && (
        <DuplicateDialog
          project={dialog.project}
          taken={taken}
          onClose={() => setDialog(null)}
          onDone={(slug, title) => {
            setDialog(null);
            void load();
            say(`Duplicated as “${title}”`, { label: "Open", run: () => onOpen(slug, title) });
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteForeverDialog
          projects={dialog.projects}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const slugs = dialog.projects.map((p) => p.slug);
            for (const slug of slugs) await deleteProject(slug);
            setStarred(slugs, false);
            forgetOpened(slugs);
            setDialog(null);
            setSelected(new Set());
            say(slugs.length === 1 ? "Deleted forever" : `${slugs.length} projects deleted forever`);
            void load();
          }}
        />
      )}
      {dialog?.kind === "unpublish" && (
        <Modal
          title="Unpublish?"
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                kind="primary"
                autoFocus
                onClick={() => {
                  const project = dialog.project;
                  setDialog(null);
                  void unpublish(project);
                }}
              >
                Unpublish
              </Button>
            </>
          }
        >
          <p>
            Take <strong className="font-[600]">“{dialog.project.title || dialog.project.slug}”</strong> off the site? Its draft stays here — publish it again any time.
          </p>
        </Modal>
      )}

      {toast && (
        <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[90] flex items-center gap-3 h-10 pl-4 pr-1.5 rounded-[9px] bg-[var(--f-bg-menu)] text-white text-[11px] leading-4 shadow-[0_2px_12px_rgba(0,0,0,0.3)] select-none" style={{ marginLeft: 120 }}>
          <span className={cn(!toast.action && "pr-2.5")}>{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action?.run();
                setToast(null);
              }}
              className="h-7 px-2.5 rounded-[5px] bg-white/10 hover:bg-white/20 font-[500]"
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A small menu button of the header (the filter, the sort): its value and a chevron. */
function Pill({ label, onClick }: { label: string; onClick: (el: HTMLElement) => void }) {
  return (
    <button type="button" aria-haspopup="menu" onClick={(e) => onClick(e.currentTarget)} className="flex items-center gap-0.5 h-7 pl-2 pr-1 rounded-[6px] border border-[var(--f-border)] text-[11px] leading-4 text-[var(--f-text)] hover:bg-[var(--f-bg-hover)] whitespace-nowrap">
      {label}
      <span className="text-[var(--f-icon-secondary)]">{fi("16.chevron.down")}</span>
    </button>
  );
}

function Empty({ view, filtered, onNew, onAll }: { view: ViewKind; filtered: boolean; onNew: () => void; onAll: () => void }) {
  const [title, text] = filtered
    ? ["Nothing here with this filter", "Pick “All projects” in the filter to see every one."]
    : view === "recents"
      ? ["No recent files", "The projects you open show up here."]
      : view === "published"
        ? ["Nothing published yet", "Open a project and press Publish to put it on burakkoc.net."]
        : view === "drafts"
          ? ["No drafts", "Every project is on the site."]
          : view === "trash"
            ? ["Trash is empty", "Projects moved to trash wait here until they’re deleted for good."]
            : view === "search"
              ? ["No matches", "Try a title, a slug, a category or a year."]
              : ["No projects yet", "Create the first one — it starts as a draft."];
  return (
    <div className="flex flex-col items-center justify-center gap-1 pt-24 pb-12 text-center select-none">
      <p className="text-[13px] font-[600] leading-5">{title}</p>
      <p className="text-[11px] leading-4 text-[var(--f-text-secondary)]">{text}</p>
      {(view === "all" || view === "drafts") && !filtered && (
        <Button kind="primary" className="mt-4" onClick={onNew}>
          New project
        </Button>
      )}
      {view === "recents" && (
        <Button className="mt-4" onClick={onAll}>
          Browse all projects
        </Button>
      )}
    </div>
  );
}
