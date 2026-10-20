/**
 * The instance swap menu (live popovers/instance-header-swap-menu.txt, instance-swap-property-picker.txt): a 240 × 441
 * popover over the panel (its right edge 40 from the panel's), its top at the trigger's bottom — "Swap instance" (the
 * header's name) or "Choose instance" (an Instance swap property), "Search in this library", the library ("Created in
 * this file") with Settings (List / Grid), then the library browsed by page and folder: a level's header ("‹ Capture",
 * "‹ Icon") over its components — a 40 thumbnail, the name at 64 — then its folders (frames and slash names, "Icon"
 * for Icon/Heart, Icon/Star). It opens at the current component's level. The library field picks Figma's section (atlas 10
 * §7.1): Preferred (a property's preferred components), Recently used, the library — opening on Preferred when there
 * are any, else the library, else Recently used. A search lists the section's matches flat, best first, one per name.
 * The libraries added to the file follow as sections of their own (their published components, by name; a pick brings
 * the copy in first), and "Browse libraries" opens the Libraries modal (atlas 12 §5.4's "Instance swap > Browse
 * libraries link").
 */
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon, MenuButton, Popover, cx, type MenuEntry } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor } from "../../controller";
import { useAssetThumbnail } from "../../assetThumbs";
import { addRecentComponent, recentComponents } from "../../recentComponents";
import { assetLabel, isPreferred, searchAssets, type ComponentAsset } from "../../model/components";
import { useLibraries } from "../../hooks";
import { ensureCopy } from "../../libraries";
import type { LibraryAsset } from "../../../../../shared/store/types";
import { RemoteThumb } from "../libraries/Thumbs";
import { LazyBlock, blocksOf } from "../LazyBlock";
import { t, useT } from "@/i18n";
import styles from "./ComponentPicker.module.css";

export interface ComponentPickerProps {
  anchor: HTMLElement | DOMRect | null;
  /** "Swap instance" (the instance's name), "Choose instance" (an Instance swap property) */
  title?: string;
  /** The component (or a variant of the set) shown as current */
  current?: Guid | null;
  /** Component keys of the "Preferred" section (where the picker opens) */
  preferredKeys?: readonly string[];
  /** Components not offered (the instance's own ancestors, which would nest it in itself) */
  exclude?: ReadonlySet<Guid>;
  onPick: (asset: ComponentAsset) => void;
  onClose: () => void;
}

/** The file's components, re-read after document changes. */
export function useComponentAssets(): ComponentAsset[] {
  const ed = useEditor();
  const version = useSyncExternalStore(ed.components.subscribeAssets, ed.components.getAssetsVersion);
  return useMemo(() => {
    void version;
    return ed.components.assets();
  }, [ed, version]);
}

/** Where an asset sits in the library: its page, then its top-level frame and the folders of its slash name. */
export function assetPath(a: ComponentAsset): string[] {
  const folders = a.name
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, -1);
  return [...(a.frameName ? [a.frameName] : []), ...folders];
}

export type PickerLevel = { page: Guid | null; path: string[] };

/** What a level shows: its components (by name), then its folders (by name); the root shows the pages. */
export function levelContents(assets: readonly ComponentAsset[], level: PickerLevel, pages: readonly { guid: Guid; name: string }[]): { items: ComponentAsset[]; folders: { name: string; level: PickerLevel }[] } {
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  if (level.page === null) {
    const used = new Set(assets.map((a) => a.page));
    return { items: [], folders: pages.filter((p) => used.has(p.guid)).map((p) => ({ name: p.name, level: { page: p.guid, path: [] } })) };
  }
  const items: ComponentAsset[] = [];
  const folders = new Set<string>();
  for (const a of assets) {
    if (a.page !== level.page) continue;
    const path = assetPath(a);
    if (path.length < level.path.length || level.path.some((s, i) => path[i] !== s)) continue;
    if (path.length === level.path.length) items.push(a);
    else folders.add(path[level.path.length]);
  }
  items.sort((a, b) => collator.compare(assetLabel(a.name), assetLabel(b.name)));
  return { items, folders: [...folders].sort(collator.compare).map((name) => ({ name, level: { page: level.page, path: [...level.path, name] } })) };
}

/** The level a picker opens at: the current component's, else the only page's, else the library's pages. */
export function startLevel(assets: readonly ComponentAsset[], current: ComponentAsset | null): PickerLevel {
  if (current) return { page: current.page, path: assetPath(current) };
  const pages = [...new Set(assets.map((a) => a.page))];
  return pages.length === 1 ? { page: pages[0], path: [] } : { page: null, path: [] };
}

/** Figma's sections of the swap picker (atlas 10 §7.1): Preferred, Recently used, this file's library, an added library. */
export type PickerSection = "preferred" | "recent" | "file" | `lib:${string}`;

/** An added library's components the picker lists (published, listed, not a set's variants), by name. */
export function libraryComponents(assets: readonly LibraryAsset[]): LibraryAsset[] {
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  return assets.filter((a) => (a.kind === "COMPONENT" || a.kind === "COMPONENT_SET") && !a.dependencyOnly && !a.componentSetKey).sort((a, b) => collator.compare(a.name, b.name));
}

/**
 * Figma's starting section: Preferred when the property has preferred values; else the library of the current
 * component when it has items (this file's, for a swap); else Recently used.
 */
export function startSection(preferredCount: number, libraryCount: number): PickerSection {
  if (preferredCount > 0) return "preferred";
  return libraryCount > 0 ? "file" : "recent";
}

/** Search results as Figma lists them: one per name, the best match kept. */
export function uniqueByName<T extends { name: string }>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  return list.filter((a) => !seen.has(a.name) && !!seen.add(a.name));
}

let view: "list" | "grid" = "list";

/**
 * Open / close state for a popover placed by a rect (not its trigger): a press on the trigger while it is open closes
 * it (the press is "outside") and the click that follows must not open it again.
 */
export function usePopoverToggle<T>(): [T | null, (value: T) => void, () => void] {
  const [open, setOpen] = useState<T | null>(null);
  const closedAt = useRef(0);
  const toggle = (value: T) => {
    if (performance.now() - closedAt.current < 300) return;
    setOpen((o) => (o ? null : value));
  };
  const close = () => {
    closedAt.current = performance.now();
    setOpen(null);
  };
  return [open, toggle, close];
}

/** A component's thumbnail in a 40 box (the engine's render, from the thumbnail cache once on screen; the glyph until there is one). */
function Thumb({ asset, size }: { asset: ComponentAsset; size: number }) {
  const ed = useEditor();
  const ref = useRef<HTMLCanvasElement>(null);
  useAssetThumbnail(ed, ref, asset.target, size * Math.max(1, Math.round(window.devicePixelRatio || 1)));
  return (
    <span className={styles.thumb}>
      {ed.thumbnails?.available && <canvas ref={ref} className={styles.thumbCanvas} />}
      <Icon name={asset.kind === "set" ? "16.component.set" : "16.component"} className={styles.glyph} />
    </span>
  );
}

/** The panel's right edge less 40 for the picker's right edge, the trigger's bottom for its top (live 1160, 117 / 237). */
function placeOf(anchor: HTMLElement | DOMRect | null): DOMRect | HTMLElement | null {
  if (!(anchor instanceof HTMLElement)) return anchor;
  const r = anchor.getBoundingClientRect();
  const panel = anchor.closest<HTMLElement>('[data-panel="right"]')?.getBoundingClientRect();
  const right = panel ? panel.right - 40 : window.innerWidth - 40;
  return new DOMRect(right, r.bottom, 0, 0);
}

/** Items mounted per block (48 tall rows, or 64 tiles three to a row 8 apart). */
const PICKER_BLOCK = 30;

export function ComponentPicker({ anchor, title: titleProp, current, preferredKeys, exclude, onPick, onClose }: ComponentPickerProps) {
  useT();
  const title = titleProp ?? t("Swap instance");
  const ed = useEditor();
  const assets = useComponentAssets();
  const libraries = useLibraries();
  const [place] = useState(() => placeOf(anchor));
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState(view);
  const offered = useMemo(() => assets.filter((a) => !exclude?.has(a.id) && !exclude?.has(a.target)), [assets, exclude]);
  const currentAsset = current ? ed.components.assetOf(current) : null;
  const [level, setLevel] = useState<PickerLevel>(() => startLevel(offered, currentAsset ? (offered.find((a) => a.id === currentAsset.id) ?? null) : null));
  const storePages = ed.store.pages;
  const pages = useMemo(() => storePages.map((p) => ({ guid: p.guid, name: p.name })), [storePages]);
  const preferred = useMemo(() => (preferredKeys?.length ? offered.filter((a) => preferredKeys.some((k) => isPreferred(a, k))) : []), [offered, preferredKeys]);
  const file = (ed.source as { fileKey?: string }).fileKey ?? "";
  const recent = useMemo(() => recentComponents(file).flatMap((id) => offered.find((a) => a.id === id) ?? []), [file, offered]);
  const [section, setSection] = useState<PickerSection>(() => startSection(preferred.length, offered.length));
  // Figma searches the section's scope (Preferred: its components; Recently used: every library's; the library: its
  // own), de-duplicated by name.
  const scope = section === "preferred" ? preferred : offered;
  const found = useMemo(() => (query.trim() ? uniqueByName(searchAssets(scope, query)) : null), [scope, query]);
  const contents = useMemo(() => levelContents(offered, level, pages), [offered, level, pages]);
  const levelName = level.path.length ? level.path[level.path.length - 1] : (pages.find((p) => p.guid === level.page)?.name ?? "");
  const pick = (a: ComponentAsset) => {
    addRecentComponent(file, a.id);
    onPick(a);
    onClose();
  };
  const item = (a: ComponentAsset) => {
    const on = currentAsset?.id === a.id;
    const label = assetLabel(a.name);
    return (
      <button
        key={a.id}
        type="button"
        role="menuitemradio"
        aria-checked={on}
        aria-label={mode === "grid" ? label : undefined}
        data-asset={a.id}
        className={cx(styles.item, mode === "grid" && styles.tile)}
        onClick={() => pick(a)}
      >
        <Thumb asset={a} size={mode === "grid" ? 64 : 40} />
        {mode === "list" && <span className={styles.name}>{label}</span>}
      </button>
    );
  };
  const folder = (f: { name: string; level: PickerLevel }) => (
    <button key={f.name} type="button" className={styles.folder} data-folder={f.name} onClick={() => setLevel(f.level)}>
      <Icon name="24.folder" className={styles.folderIcon} />
      <span className={styles.name}>{f.name}</span>
    </button>
  );
  const settings: MenuEntry[] = [
    { id: "list", label: t("List"), checked: mode === "list" },
    { id: "grid", label: t("Grid"), checked: mode === "grid" },
  ];
  const added = libraries.enabled.filter((lib) => libraries.manifests.has(lib));
  const sectionLabel = (id: PickerSection): string => (id === "preferred" ? t("Preferred") : id === "recent" ? t("Recently used") : id === "file" ? t("Created in this file") : (libraries.names.get(id.slice(4)) ?? t("Library")));
  const library: MenuEntry[] = [...(preferred.length ? (["preferred"] as const) : []), "recent" as const, "file" as const, ...added.map((lib) => `lib:${lib}` as const)].map((id) => ({ id, label: sectionLabel(id), checked: section === id }));
  // An added library's components; a pick brings its copy in (a system change), then the caller's step uses it.
  const libKey = section.startsWith("lib:") ? section.slice(4) : null;
  const remote = libKey ? libraryComponents(libraries.manifests.get(libKey)?.assets ?? []) : [];
  const remoteFound = libKey && query.trim() ? remote.filter((a) => a.name.toLowerCase().includes(query.trim().toLowerCase())) : remote;
  const pickRemote = async (lib: string, a: LibraryAsset) => {
    const id = await ensureCopy(ed, lib, a.key);
    if (!id) return;
    const set = a.kind === "COMPONENT_SET";
    const target = set ? (ed.engine.readNode(id, { childIds: true })?.childIds?.[0] ?? id) : id;
    onPick({ id, name: a.name, kind: set ? "set" : "component", target, page: "", pageName: "", frame: null, frameName: null, description: a.description, key: a.key });
    onClose();
  };
  const remoteItem = (lib: string, a: LibraryAsset) => (
    <button key={a.key} type="button" role="menuitem" aria-label={mode === "grid" ? assetLabel(a.name) : undefined} data-library-asset={a.name} className={cx(styles.item, mode === "grid" && styles.tile)} onClick={() => void pickRemote(lib, a)}>
      <RemoteThumb asset={a} size={mode === "grid" ? 64 : 40} />
      {mode === "list" && <span className={styles.name}>{assetLabel(a.name)}</span>}
    </button>
  );
  const placeholder = section === "preferred" ? t("Search preferred") : section === "recent" ? t("Search all libraries") : t("Search in this library");
  // A long list (a search over every component, a page of icons) is mounted a block at a time (LazyBlock.tsx).
  const list = (items: ComponentAsset[]) =>
    blocksOf(items, PICKER_BLOCK).map((b, i) => (
      <LazyBlock key={i} eager={i === 0} height={mode === "grid" ? Math.ceil(b.length / 3) * (64 + 8) : b.length * 48}>
        {() => <div className={cx(mode === "grid" && styles.grid)}>{b.map(item)}</div>}
      </LazyBlock>
    ));
  return (
    <Popover anchor={place} placement={place instanceof DOMRect ? "left" : "left-of-panel"} title={title} width={240} onClose={onClose} label={title}>
      <div className={styles.picker} data-component-picker="">
        <div className={styles.search}>
          <Icon name="24.search.small" className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            aria-label={placeholder}
            placeholder={placeholder}
            value={query}
            autoFocus
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape" || query) e.stopPropagation();
              if (e.key === "Escape" && query) setQuery("");
            }}
          />
        </div>
        <div className={styles.libraryRow}>
          <span className={styles.hidden}>{t("Swap instance")}</span>
          {/* (Named by its text, as live: no label of its own) */}
          <MenuButton
            label=""
            entries={library}
            className={styles.library}
            onSelect={(id) => {
              setSection(id as PickerSection);
              if (id === "file") setLevel(startLevel(offered, null));
            }}
          >
            <span className={styles.libraryName}>{sectionLabel(section)}</span>
            <Icon name="16.chevron.down" />
          </MenuButton>
          <MenuButton
            label={t("Settings")}
            entries={settings}
            className={styles.settings}
            align="end"
            onSelect={(id) => {
              view = id === "grid" ? "grid" : "list";
              setMode(view);
            }}
          >
            <Icon name="24.settings.small" />
          </MenuButton>
        </div>
        <div className={styles.list} role="menu">
          {libKey ? (
            remoteFound.length ? <div className={cx(mode === "grid" && styles.grid)}>{remoteFound.map((a) => remoteItem(libKey, a))}</div> : <div className={styles.empty}>{query.trim() ? t("No results for “{query}”", { query: query.trim() }) : t("No components in this library")}</div>
          ) : found ? (
            found.length ? list(found) : <div className={styles.empty}>{t("No results for “{query}”", { query: query.trim() })}</div>
          ) : section === "preferred" ? (
            list(preferred)
          ) : section === "recent" ? (
            recent.length ? list(recent) : <div className={styles.empty}>{t("No recently used components")}</div>
          ) : (
            <>
              {level.page !== null && (
                // The level's name with ‹: a click goes up (to the folder above, the page, the library's pages).
                <button type="button" className={cx(styles.heading, styles.up)} data-level={levelName} onClick={() => setLevel(level.path.length ? { page: level.page, path: level.path.slice(0, -1) } : { page: null, path: [] })}>
                  <Icon name="24.chevron.right" className={styles.back} />
                  <span className={styles.headingName}>{levelName}</span>
                </button>
              )}
              {list(contents.items)}
              {contents.folders.length > 0 && <div className={styles.folders}>{contents.folders.map(folder)}</div>}
              {!contents.items.length && !contents.folders.length && <div className={styles.empty}>{t("No components in this file")}</div>}
            </>
          )}
        </div>
        {libraries.on && (
          <button
            type="button"
            className={styles.browse}
            data-browse-libraries=""
            onClick={() => {
              onClose();
              ed.ui.set({ librariesDialog: { tab: "libraries" } });
            }}
          >
            {t("Browse libraries")}
          </button>
        )}
      </div>
    </Popover>
  );
}
