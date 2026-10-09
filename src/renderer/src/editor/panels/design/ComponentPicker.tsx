/**
 * The instance swap menu (live popovers/instance-header-swap-menu.txt, instance-swap-property-picker.txt): a 240 × 441
 * popover over the panel (its right edge 40 from the panel's), its top at the trigger's bottom — "Swap instance" (the
 * header's name) or "Choose instance" (an Instance swap property), "Search in this library", the library ("Created in
 * this file") with Settings (List / Grid), then the library browsed by page and folder: a level's header ("‹ Capture",
 * "‹ Icon") over its components — a 40 thumbnail, the name at 64 — then its folders (frames and slash names, "Icon"
 * for Icon/Heart, Icon/Star). It opens at the current component's level. Preferred components (an Instance swap
 * property's) come first under "Preferred" (help "Explore component properties"; unverified look). A search lists the
 * library's matches flat.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon, MenuButton, Popover, Select, cx, type MenuEntry } from "@/ds";
import type { Guid, Pixels } from "@/engine/codec";
import { useEditor } from "../../controller";
import { engineMethod } from "../../engineCompat";
import { assetLabel, isPreferred, searchAssets, type ComponentAsset } from "../../model/components";
import styles from "./ComponentPicker.module.css";

export interface ComponentPickerProps {
  anchor: HTMLElement | DOMRect | null;
  /** "Swap instance" (the instance's name), "Choose instance" (an Instance swap property) */
  title?: string;
  /** The component (or a variant of the set) shown as current */
  current?: Guid | null;
  /** Component keys listed first, under "Preferred" */
  preferredKeys?: readonly string[];
  /** A slot's "Add instances": with preferred components, the list starts filtered to them (Preferred / All) */
  preferredFilter?: boolean;
  /** Components not offered (the instance's own ancestors, which would nest it in itself) */
  exclude?: ReadonlySet<Guid>;
  onPick: (asset: ComponentAsset) => void;
  onClose: () => void;
}

/** The file's components, re-read after document changes. */
export function useComponentAssets(): ComponentAsset[] {
  const ed = useEditor();
  const version = useSyncExternalStore(ed.components.subscribe, ed.components.getVersion);
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

/** A component's thumbnail in a 40 box (the engine's render; the glyph until there is one). */
function Thumb({ asset, size }: { asset: ComponentAsset; size: number }) {
  const ed = useEditor();
  const ref = useRef<HTMLCanvasElement>(null);
  const render = engineMethod<(o: { node: string; maxSize: number }) => Pixels | null>(ed.engine, "renderNodeThumbnailPixels");
  useEffect(() => {
    const c = ref.current;
    if (!c || !render) return;
    const px = render({ node: asset.target, maxSize: size * Math.max(1, Math.round(window.devicePixelRatio || 1)) });
    if (!px) return;
    c.width = px.width;
    c.height = px.height;
    c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
    c.dataset.drawn = "";
  }, [render, asset.target, size]);
  return (
    <span className={styles.thumb}>
      {render && <canvas ref={ref} className={styles.thumbCanvas} />}
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

export function ComponentPicker({ anchor, title = "Swap instance", current, preferredKeys, preferredFilter, exclude, onPick, onClose }: ComponentPickerProps) {
  const ed = useEditor();
  const assets = useComponentAssets();
  const [place] = useState(() => placeOf(anchor));
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState(view);
  const filterable = !!preferredFilter && !!preferredKeys?.length;
  const [onlyPreferred, setOnlyPreferred] = useState(filterable);
  const offered = useMemo(() => assets.filter((a) => !exclude?.has(a.id) && !exclude?.has(a.target)), [assets, exclude]);
  const currentAsset = current ? ed.components.assetOf(current) : null;
  const [level, setLevel] = useState<PickerLevel>(() => startLevel(offered, currentAsset ? (offered.find((a) => a.id === currentAsset.id) ?? null) : null));
  const pages = ed.store.pages.map((p) => ({ guid: p.guid, name: p.name }));
  const preferred = preferredKeys?.length ? offered.filter((a) => preferredKeys.some((k) => isPreferred(a, k))) : [];
  const found = query.trim() ? searchAssets(offered, query) : null;
  const contents = levelContents(offered, level, pages);
  const levelName = level.path.length ? level.path[level.path.length - 1] : (pages.find((p) => p.guid === level.page)?.name ?? "");
  const pick = (a: ComponentAsset) => {
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
    { id: "list", label: "List", checked: mode === "list" },
    { id: "grid", label: "Grid", checked: mode === "grid" },
  ];
  const library: MenuEntry[] = [{ id: "local", label: "Created in this file", checked: true }];
  const list = (items: ComponentAsset[]) => <div className={cx(mode === "grid" && styles.grid)}>{items.map(item)}</div>;
  return (
    <Popover anchor={place} placement={place instanceof DOMRect ? "left" : "left-of-panel"} title={title} width={240} onClose={onClose} label={title}>
      <div className={styles.picker} data-component-picker="">
        <div className={styles.search}>
          <Icon name="24.search.small" className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            aria-label="Search in this library"
            placeholder="Search in this library"
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
          <span className={styles.hidden}>Swap instance</span>
          {/* (Named by its text, as live: no label of its own) */}
          <MenuButton label="" entries={library} className={styles.library} onSelect={() => setLevel(startLevel(offered, null))}>
            <span className={styles.libraryName}>Created in this file</span>
            <Icon name="16.chevron.down" />
          </MenuButton>
          <MenuButton
            label="Settings"
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
        {filterable && (
          <div className={styles.filter}>
            <Select
              label="Filter"
              value={onlyPreferred ? "preferred" : "all"}
              options={[
                { value: "preferred", label: "Preferred" },
                { value: "all", label: "All components" },
              ]}
              onChange={(v) => setOnlyPreferred(v === "preferred")}
            />
          </div>
        )}
        <div className={styles.list} role="menu">
          {found ? (
            found.length ? list(found) : <div className={styles.empty}>{`No results for “${query.trim()}”`}</div>
          ) : (
            <>
              {preferred.length > 0 && (
                <>
                  <div className={styles.heading}>
                    <span className={styles.headingName}>Preferred</span>
                  </div>
                  {list(preferred)}
                </>
              )}
              {!(onlyPreferred && filterable) && (
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
                  {!contents.items.length && !contents.folders.length && <div className={styles.empty}>No components in this file</div>}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Popover>
  );
}
