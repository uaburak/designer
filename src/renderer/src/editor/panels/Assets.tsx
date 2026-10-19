/**
 * Assets (the navigation bar's Assets tab, ⌥2; Figma 2026, measured live — docs/research/figma/live/left/rail-assets*):
 * the tab's header ("Assets", Libraries — its blue dot: an enabled library has updates), "Search all libraries"
 * and "Libraries and settings" (Grid / List, the Libraries modal). At the top, "All libraries": a card per library
 * ("Created in this file" — the file's own components —, then each enabled library) with its component count, and
 * "Add more libraries". A card opens its library: Back, the path ("Created in this file / Capture"), its pages; a
 * page shows its components (96 tiles two to a row, or a list), grouped by the top-level frame they sit in. A search
 * lists the matches of every library (of the one open, "Search in this library"). A click inserts an instance in
 * the middle of the view; a drag drops one where it is let go. Under a search's matches, "Similar" lists the components
 * visual search finds for it (docs/ai.md §6) — once its models are on this computer. A set shows once and inserts its default variant (its
 * tile counts its variants). A library component is inserted as an instance of its read-only copy. Right click on a
 * local component: Go to main component, Hide when publishing.
 */
import { useEffect, useRef, useState } from "react";
import { Banner, Button, ContextMenu, EmptyState, IS_MAC, Icon, IconButton, Popover, SearchField, showToast, type MenuEntry } from "@/ds";
import type { Pixels } from "@/engine/codec";
import type { LibraryAsset } from "../../../../shared/store/types";
import { useEditor, type EditorController } from "../controller";
import { goToComponent, insertInstance } from "../components";
import { engineMethod } from "../engineCompat";
import { useLibraries, useUI } from "../hooks";
import { insertLibraryComponent, isHiddenWhenPublishing, librariesButtonLabel, setHiddenWhenPublishing } from "../libraries";
import { addRecentComponent } from "../recentComponents";
import { zoomTo } from "../actions";
import { viewRect } from "../canvas/viewInsets";
import { assetLabel, groupAssets, searchAssets, tileGrid, tileLayoutOf, type ComponentAsset } from "../model/components";
import { useComponentAssets } from "./design/ComponentPicker";
import { ApprovedMark } from "./libraries/LibrariesDialog";
import { RemoteThumb } from "./libraries/Thumbs";
import { SimilarAssets, useSimilarComponents } from "../search/Similar";
import { TabHeader } from "./TabHeader";
import lstyles from "./libraries/Libraries.module.css";
import styles from "./Assets.module.css";
import { t, tp, useT } from "@/i18n";

/** A grid tile at Figma's 240 px panel (live: 96 × 96; `tileGrid` sizes them for the panel's width) */
const TILE = 96;
/** A list row's thumbnail (Figma's list view: 40 × 40) */
const LIST_THUMB = 40;

/** A component of an enabled library, in the local assets' shape (grouped and searched the same way). */
type Item = ComponentAsset & { library?: string; remote?: LibraryAsset };

/** A library as Assets lists it: the file's own components, or an enabled library's. */
interface Section {
  key: string;
  title: string;
  items: Item[];
  /** Page order */
  pages: string[];
  library?: string;
}

function remoteItems(lib: string, libName: string, assets: readonly LibraryAsset[]): Item[] {
  return assets
    .filter((a) => !a.dependencyOnly && !a.componentSetKey && (a.kind === "COMPONENT" || a.kind === "COMPONENT_SET"))
    .map((a) => {
      const pageName = a.containingFrame?.pageName ?? libName;
      const frameName = a.containingFrame?.frameName ?? null;
      return {
        id: `${lib}/${a.key}`,
        name: a.name,
        kind: a.kind === "COMPONENT_SET" ? ("set" as const) : ("component" as const),
        target: a.key,
        page: `${lib}/${pageName}`,
        pageName,
        frame: frameName ? `${lib}/${pageName}/${frameName}` : null,
        frameName,
        description: a.description,
        key: a.key,
        library: lib,
        remote: a,
      };
    });
}

export function Assets() {
  useT();
  const ed = useEditor();
  const local = useComponentAssets();
  const libs = useLibraries();
  const [query, setQuery] = useState("");
  const view = useUI((s) => s.assetsView);
  const at = useUI((s) => s.assetsAt ?? null);
  const [drag, setDrag] = useState<{ asset: Item; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; asset: Item; anchor: HTMLElement } | null>(null);
  const [details, setDetails] = useState<{ asset: Item; anchor: DOMRect | HTMLElement } | null>(null);
  const [settings, setSettings] = useState<{ x: number; y: number } | null>(null);
  const settingsButton = useRef<HTMLDivElement>(null);
  // Figma sizes the grid from the sidebar's width (atlas 10 §8.2): two 96 tiles at 240, three from 409.
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(240);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 240));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pending = libs.on ? ed.libraries.pendingCount() : 0;

  const sections: Section[] = [];
  if (local.length) sections.push({ key: "local", title: t("Created in this file"), items: local, pages: ed.store.pages.map((p) => p.guid) });
  for (const lib of libs.enabled) {
    const manifest = libs.manifests.get(lib);
    if (!manifest) continue;
    const name = libs.names.get(lib) ?? t("Library");
    const items = remoteItems(lib, name, manifest.assets);
    if (!items.length) continue; // a library of styles and variables only: nothing to list here
    sections.push({ key: `lib:${lib}`, title: name, items, pages: [...new Set(items.map((i) => i.page))], library: lib });
  }
  const open = at ? sections.find((s) => s.key === at.section) : undefined;
  // A search: the exact matches of every library (of the open one), then "Similar" (visual search, docs/ai.md §6)
  const here = (ed.source as { fileKey?: string }).fileKey;
  const found = query ? (open ? [open] : sections).map((s) => ({ s, list: searchAssets(s.items, query) as Item[] })).filter((x) => x.list.length) : [];
  const listed = found.flatMap(({ list }) => list.map((a) => (a.remote && a.library ? { fileKey: a.library, nodeId: a.remote.guid } : { fileKey: here ?? "", nodeId: a.id })));
  const similar = useSimilarComponents(query, listed, open ? (open.library ?? here) : undefined);
  const go = (next: { section: string; page?: string } | null) => {
    setQuery("");
    ed.ui.set({ assetsAt: next });
  };

  const place = (a: Item, point?: { x: number; y: number }) => {
    // Figma: every insert joins the user's recents (the swap picker's "Recently used").
    addRecentComponent(here ?? "", a.id);
    if (a.library && a.remote) {
      void insertLibraryComponent(ed, a.library, a.remote, point)
        .then((made) => {
          if (!made) showToast({ message: t("The instance couldn't be inserted") });
          else ed.focusCanvas();
        })
        .catch(() => showToast({ message: t("The library component couldn't be loaded"), kind: "error" }));
      return;
    }
    const made = insertInstance(ed, a.target, point);
    if (!made) showToast({ message: t("The instance couldn't be inserted") });
    else ed.focusCanvas();
  };

  const onPointerDown = (e: React.PointerEvent, a: Item) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let fitted = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      dragging = true;
      setDrag({ asset: a, x: ev.clientX, y: ev.clientY });
      const view = viewRect(ed.canvas);
      if (!fitted && view && ev.clientX >= view.left && ev.clientX <= view.right && ev.clientY >= view.top && ev.clientY <= view.bottom) {
        // Figma (atlas 10 §8.5): a component larger than the view, coming onto the canvas, zooms out to
        // min(view w / w, view h / h) × 0.5 — only ever out. (A library component's size isn't known before it loads.)
        fitted = true;
        const size = a.remote ? null : sizeOf(a);
        const zoom = ed.engine.getCamera().zoom;
        if (size && (size.x * zoom > view.width || size.y * zoom > view.height)) {
          const fit = Math.min((view.width / size.x) * 0.5, (view.height / size.y) * 0.5);
          if (fit < zoom) zoomTo(ed, fit);
        }
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (!dragging) return place(a);
      const r = ed.canvas?.getBoundingClientRect();
      if (r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) place(a, { x: ev.clientX - r.left, y: ev.clientY - r.top });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const openLibraries = (tab: "libraries" | "updates" = "libraries") => ed.ui.set({ librariesDialog: { tab } });

  /** An item's size for the tile layout: a library thumbnail's (its aspect), else the component's own. */
  const sizeOf = (a: Item): { x: number; y: number } | null => {
    if (a.remote) return a.remote.thumbnail ? { x: a.remote.thumbnail.width, y: a.remote.thumbnail.height } : null;
    return (ed.engine.readNode(a.target, { fields: ["size"] }) as { size?: { x: number; y: number } } | null)?.size ?? null;
  };

  /** A component as a tile (`box`: its size in the grid) or a row. */
  const asset = (a: Item, sectionTitle: string, box: { width: number; height: number } = { width: TILE, height: TILE }) => (
    <button
      key={a.id}
      type="button"
      role="treeitem"
      data-asset={a.id}
      data-asset-name={a.name}
      data-library={a.library ? sectionTitle : undefined}
      className={view === "grid" ? styles.tile : styles.row}
      aria-label={a.name}
      title={a.description ? `${a.name}\n${a.description}` : a.name}
      onPointerDown={(e) => onPointerDown(e, a)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, asset: a, anchor: e.currentTarget });
      }}
      onKeyDown={(e) => {
        // Figma's tile: ⌘Enter (Ctrl+Enter) views the details, Enter or Space inserts.
        if (e.key === "Enter" && (IS_MAC ? e.metaKey : e.ctrlKey)) {
          e.preventDefault();
          setDetails({ asset: a, anchor: besidePanel(e.currentTarget, root.current) });
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          place(a);
        }
      }}
    >
      {view === "grid" ? (
        <>
          <span className={styles.tileBox} style={{ width: box.width, height: box.height }}>
            {a.remote ? <RemoteThumb asset={a.remote} size={Math.max(box.width, box.height)} className={styles.remoteThumb} /> : <Thumb asset={a} size={box.width} height={box.height} />}
            {/* Live (left-rail-assets-components): no variant count on a set's tile — read out only */}
            {a.kind === "set" && (a.variantCount ?? 0) > 0 && <span className={styles.srOnly}>{tp(a.variantCount ?? 0, "Includes {n} variant", "Includes {n} variants")}</span>}
          </span>
          <span className={styles.tileName}>{assetLabel(a.name)}</span>
          {/* Live: each tile's hint for assistive tech */}
          <span className={styles.srOnly}>{IS_MAC ? t("Press Enter or Space to insert. Press Command+Enter to view details.") : t("Press Enter or Space to insert. Press Ctrl+Enter to view details.")}</span>
        </>
      ) : (
        <>
          {/* Figma's list view: a 40 × 40 thumbnail before the name */}
          <span className={styles.rowThumb}>{a.remote ? <RemoteThumb asset={a.remote} size={LIST_THUMB} className={styles.remoteThumb} /> : <Thumb asset={a} size={LIST_THUMB} />}</span>
          <span className={styles.rowName}>{assetLabel(a.name)}</span>
        </>
      )}
    </button>
  );

  /**
   * Components as Figma's grid — its layout from the items' sizes (WIDE when all are 3× wider than tall, else NORMAL:
   * the Assets grid has no SMALL), its columns and tile size from the panel's width — or as the list.
   */
  const tiles = (list: Item[], section: Section) => {
    if (view !== "grid") return <div className={styles.list}>{list.map((a) => asset(a, section.title))}</div>;
    const layout = tileLayoutOf(list.map(sizeOf), false);
    const grid = tileGrid(layout, width);
    return (
      <div className={styles.grid} data-tile-layout={layout} style={{ gridTemplateColumns: `repeat(${grid.columns}, ${grid.width}px)` }}>
        {list.map((a) => asset(a, section.title, grid))}
      </div>
    );
  };

  /** A list of components, under the frames they sit in. */
  const items = (list: Item[], section: Section) =>
    groupAssets(list, section.pages).map((g) =>
      g.frames.map((f) => (
        <div key={`${g.page}/${f.frame ?? ""}`} role="group" aria-label={f.frameName ?? g.pageName}>
          {f.frame && <div className={styles.frameName}>{f.frameName}</div>}
          {tiles(f.items as Item[], section)}
        </div>
      ))
    );

  const settingsEntries: MenuEntry[] = [
    { id: "grid", label: t("Grid"), checked: view === "grid" },
    { id: "list", label: t("List"), checked: view === "list" },
    "-",
    { id: "libraries", label: t("Manage libraries…"), disabled: !libs.on },
  ];

  let body: React.ReactNode;
  if (!sections.length) {
    body = (
      <EmptyState
        icon="24.component"
        title={t("No components yet")}
        body={libs.on ? t("Components you create in this file and the libraries you add show up here. Select layers and press ⌥⌘K.") : t("Components you create in this file show up here. Select layers and press ⌥⌘K.")}
        action={libs.on ? { label: t("Browse libraries"), onClick: () => openLibraries() } : undefined}
      />
    );
  } else if (query) {
    body = (
      <div className={styles.scroll} role="tree" aria-label={t("Assets")}>
        {!found.length && !similar.length && <div className={styles.none}>{t("No results for “{query}”", { query })}</div>}
        {found.map(({ s, list }) => (
          <div key={s.key} role="group" aria-label={s.title} data-assets-section={s.title}>
            <div className={styles.heading}>{s.title}</div>
            {/* Figma's search: the matches best first, not regrouped by frame */}
            {tiles(list, s)}
          </div>
        ))}
        <SimilarAssets ed={ed} hits={similar} view={view} styles={styles} />
      </div>
    );
  } else if (!open) {
    body = (
      <div className={styles.scroll} data-all-libraries="">
        <div className={styles.allHeading}>{t("All libraries")}</div>
        {sections.map((s) => (
          <button key={s.key} type="button" className={styles.card} data-library-card={s.title} onClick={() => go({ section: s.key })}>
            <span className={styles.cardThumb}>
              {s.items[0] && (s.items[0].remote ? <RemoteThumb asset={s.items[0].remote} size={TILE} className={styles.remoteThumb} /> : <Thumb asset={s.items[0]} size={TILE} />)}
            </span>
            <span className={styles.cardName}>
              <span className={styles.cardTitle}>{s.title}</span>
              {/* "An approved library shows a check mark next to its name … in the Assets panel" (help, §16.1) */}
              {s.library && <ApprovedMark entry={libs.available.find((e) => e.fileKey === s.library)} orgName={libs.org?.orgName ?? null} />}
            </span>
            <span className={styles.cardCount}>{tp(s.items.length, "{n} component", "{n} components")}</span>
          </button>
        ))}
        {/* Live: always offered (the Libraries modal says what this file can add) */}
        <button type="button" className={styles.addMore} onClick={() => openLibraries()}>
          {t("Add more libraries")}
        </button>
      </div>
    );
  } else {
    const groups = groupAssets(open.items, open.pages);
    const page = at?.page ? groups.find((g) => g.page === at.page) : undefined;
    body = (
      <div className={styles.scroll} role="tree" aria-label={open.title} data-assets-section={open.title}>
        <div className={styles.path}>
          <IconButton icon="24.arrow.left" label={t("Back")} tone="secondary" onClick={() => go(page ? { section: open.key } : null)} />
          <button type="button" className={styles.crumb} onClick={() => go({ section: open.key })}>
            {open.title}
          </button>
          {page && (
            <>
              <span className={styles.slash}>/</span>
              <span className={styles.crumbHere}>{page.pageName}</span>
            </>
          )}
        </div>
        {page
          ? items(page.frames.flatMap((f) => f.items) as Item[], open)
          : groups.map((g) => {
              const first = g.frames[0]?.items[0] as Item | undefined;
              return (
                <button key={g.page} type="button" className={styles.pageRow} data-asset-page={g.pageName} onClick={() => go({ section: open.key, page: g.page })}>
                  <span className={styles.pageThumb}>{first && (first.remote ? <RemoteThumb asset={first.remote} size={58} className={styles.remoteThumb} /> : <Thumb asset={first} size={58} />)}</span>
                  <span className={styles.pageName}>{g.pageName}</span>
                </button>
              );
            })}
      </div>
    );
  }

  return (
    <div ref={root} className={styles.assets} data-assets="">
      <TabHeader
        title={t("Assets")}
        actions={
          // Live (rail-assets.txt): Libraries at 204, 12 — its blue dot while an enabled library has updates.
          <span className={lstyles.libButton}>
            <IconButton icon="24.library.this-file" label={t(librariesButtonLabel(ed))} tone="secondary" data-libraries-button="" onClick={() => openLibraries(pending ? "updates" : "libraries")} />
            {pending > 0 && <span className={lstyles.badge} data-updates-badge="" aria-hidden />}
          </span>
        }
      />
      <div className={styles.toolbar}>
        {/* Live: a library opened focuses "Search in this library" */}
        <SearchField key={open ? open.key : ""} autoFocus={!!open} data-assets-search="" className={styles.search} value={query} onChange={setQuery} placeholder={open ? t("Search in this library") : t("Search all libraries")} label={open ? t("Search in this library") : t("Search all libraries")} />
        <div ref={settingsButton} style={{ display: "contents" }}>
          <IconButton
            icon="24.libraries-settings"
            label={t("Libraries and settings")}
            tone="secondary"
            onClick={(e) => {
              if (settings) return setSettings(null);
              const r = e.currentTarget.getBoundingClientRect();
              setSettings({ x: r.left, y: r.bottom + 4 });
            }}
          />
        </div>
      </div>
      {pending > 0 && (
        <Banner tone="brand" icon="24.library" className={lstyles.updatesBanner} action={{ label: t("Review"), onClick: () => openLibraries("updates") }}>
          {tp(pending, "{n} library update available", "{n} library updates available")}
        </Banner>
      )}
      {body}
      {drag && (
        <div className={styles.ghost} style={{ left: drag.x, top: drag.y }} aria-hidden>
          <Icon name={drag.asset.kind === "set" ? "16.component.set" : "16.component"} className={styles.glyph} />
          <span>{assetLabel(drag.asset.name)}</span>
        </div>
      )}
      {menu && <AssetMenu ed={ed} at={menu} asset={menu.asset} detailsOpen={details?.asset.id === menu.asset.id} onDetails={() => setDetails({ asset: menu.asset, anchor: besidePanel(menu.anchor, root.current) })} onClose={() => setMenu(null)} />}
      {details && (
        <AssetDetails
          asset={details.asset}
          anchor={details.anchor}
          onInsert={() => {
            place(details.asset);
            setDetails(null);
          }}
          onClose={() => setDetails(null)}
        />
      )}
      {settings && (
        <ContextMenu
          at={settings}
          entries={settingsEntries}
          label={t("Libraries and settings")}
          ignore={settingsButton}
          onSelect={(id) => {
            if (id === "grid" || id === "list") ed.ui.set({ assetsView: id });
            else if (id === "libraries") openLibraries();
          }}
          onClose={() => setSettings(null)}
        />
      )}
    </div>
  );
}

/**
 * Right click on a component: Go to main component, Hide when publishing (Figma's, R5) for a local one, then View
 * details (atlas 10 §8.4; disabled while its details are open). A library's component has View details only.
 */
function AssetMenu({ ed, at, asset, detailsOpen, onDetails, onClose }: { ed: EditorController; at: { x: number; y: number }; asset: Item; detailsOpen: boolean; onDetails: () => void; onClose: () => void }) {
  useT();
  const hidden = isHiddenWhenPublishing(ed, asset.id);
  const byName = /^[._]/.test(asset.name);
  const details: MenuEntry = { id: "details", label: t("View details"), disabled: detailsOpen };
  return (
    <ContextMenu
      at={at}
      label={asset.name}
      entries={
        asset.library
          ? [details]
          : [
              { id: "go", label: t("Go to main component") },
              "-",
              { id: "hide", label: t("Hide when publishing"), checked: hidden || byName, disabled: byName || !ed.libraries.get().on, hint: byName ? t("Name starts with _ or .") : undefined },
              "-",
              details,
            ]
      }
      onSelect={(id) => {
        if (id === "go") {
          ed.ui.set({ railTab: "file" });
          goToComponent(ed, asset.id);
        } else if (id === "hide") setHiddenWhenPublishing(ed, asset.id, !hidden);
        else if (id === "details") onDetails();
        onClose();
      }}
      onClose={onClose}
    />
  );
}

/** Where the details open: beside the panel (its right edge), level with the tile — over the canvas, not the grid. */
function besidePanel(tile: HTMLElement, panel: HTMLElement | null): DOMRect | HTMLElement {
  if (!panel) return tile;
  const t = tile.getBoundingClientRect();
  return new DOMRect(panel.getBoundingClientRect().right, t.top, 0, t.height);
}

/** Figma collapses a long description after six lines (Show more / Show less). */
const DESCRIPTION_LINES = 6;

/**
 * A component's details (Figma's ComponentFlyoutModal, atlas 10 §8.4): its name (14 px, cut with an ellipsis, the
 * whole name as its tooltip), "N variants" for a set, the description — collapsed after six lines with Show more /
 * Show less — and Insert instance. The playground of properties, the update banner and the author line are not built.
 */
function AssetDetails({ asset, anchor, onInsert, onClose }: { asset: Item; anchor: DOMRect | HTMLElement; onInsert: () => void; onClose: () => void }) {
  useT();
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const text = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = text.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [asset.description]);
  const variants = asset.variantCount ?? 0;
  return (
    <Popover anchor={anchor} placement="right" width={240} onClose={onClose} label={asset.name}>
      <div className={styles.details} data-asset-details={asset.id}>
        <div className={styles.detailsName} title={asset.name}>
          {assetLabel(asset.name)}
        </div>
        {asset.kind === "set" && variants > 1 && <div className={styles.detailsMeta}>{tp(variants, "{n} variant", "{n} variants")}</div>}
        {asset.description && (
          <>
            <div ref={text} className={styles.detailsDescription} style={open ? undefined : { WebkitLineClamp: DESCRIPTION_LINES }} data-clamped={open ? undefined : ""}>
              {asset.description}
            </div>
            {(long || open) && (
              <Button variant="link" className={styles.detailsMore} onClick={() => setOpen(!open)}>
                {open ? t("Show less") : t("Show more")}
              </Button>
            )}
          </>
        )}
        <Button variant="primary" className={styles.detailsInsert} onClick={onInsert}>
          {t("Insert instance")}
        </Button>
      </div>
    </Popover>
  );
}

/** A component's thumbnail when the engine renders nodes; the glyph otherwise (shown until the canvas is drawn). */
function Thumb({ asset, size, height = size }: { asset: ComponentAsset; size: number; height?: number }) {
  const ed = useEditor();
  const ref = useRef<HTMLCanvasElement>(null);
  const render = engineMethod<(o: { node: string; maxSize: number }) => Pixels | null>(ed.engine, "renderNodeThumbnailPixels");
  useEffect(() => {
    const c = ref.current;
    if (!c || !render) return;
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const px = render({ node: asset.target, maxSize: Math.max(size, height) * dpr });
    if (!px) return;
    c.width = px.width;
    c.height = px.height;
    c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
    // Live (img/left-rail-assets-components.jpg): a component at its own size, only a big one scaled down to fit (8 in
    // from a 96 tile's edges, 4 in a smaller one's) — a 20 px icon stays 20 px.
    const n = ed.engine.readNode(asset.target, { fields: ["size"] }) as { size?: { x: number; y: number } } | null;
    const inset = Math.min(size, height) >= TILE ? 16 : 8;
    if (n?.size && n.size.x > 0 && n.size.y > 0) {
      const fit = Math.min(1, (size - inset) / n.size.x, (height - inset) / n.size.y);
      c.style.width = `${Math.max(1, n.size.x * fit)}px`;
      c.style.height = `${Math.max(1, n.size.y * fit)}px`;
    }
    c.dataset.drawn = "";
  }, [render, asset.target, size, height, ed]);
  return (
    <span className={styles.thumb}>
      {render && <canvas ref={ref} className={styles.thumbCanvas} />}
      <Icon name={asset.kind === "set" ? "16.component.set" : "16.component"} size={24} className={styles.glyph} />
    </span>
  );
}
