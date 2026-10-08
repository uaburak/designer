/**
 * Assets (the navigation bar's Assets tab, ⌥2; Figma 2026, measured live — docs/research/figma/live/left/rail-assets*):
 * the tab's header ("Assets", Libraries — its blue dot: an enabled library has updates), "Search all libraries"
 * and "Libraries and settings" (Grid / List, the Libraries modal). At the top, "All libraries": a card per library
 * ("Created in this file" — the file's own components —, then each enabled library) with its component count, and
 * "Add more libraries". A card opens its library: Back, the path ("Created in this file / Capture"), its pages; a
 * page shows its components (96 tiles two to a row, or a list), grouped by the top-level frame they sit in. A search
 * lists the matches of every library (of the one open, "Search in this library"). A click inserts an instance in
 * the middle of the view; a drag drops one where it is let go. A set shows once and inserts its default variant (its
 * tile counts its variants). A library component is inserted as an instance of its read-only copy. Right click on a
 * local component: Go to main component, Hide when publishing.
 */
import { useEffect, useRef, useState } from "react";
import { Banner, ContextMenu, EmptyState, Icon, IconButton, SearchField, showToast, type MenuEntry } from "@/ds";
import type { Pixels } from "@/engine/codec";
import type { LibraryAsset } from "../../../../shared/store/types";
import { useEditor, type EditorController } from "../controller";
import { goToComponent, insertInstance } from "../components";
import { engineMethod } from "../engineCompat";
import { useLibraries, useUI } from "../hooks";
import { insertLibraryComponent, isHiddenWhenPublishing, setHiddenWhenPublishing } from "../libraries";
import { assetLabel, groupAssets, searchAssets, type ComponentAsset } from "../model/components";
import { useComponentAssets } from "./design/ComponentPicker";
import { RemoteThumb } from "./libraries/Thumbs";
import { TabHeader } from "./TabHeader";
import lstyles from "./libraries/Libraries.module.css";
import styles from "./Assets.module.css";

/** A grid tile (live: 96 × 96) */
const TILE = 96;

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

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function Assets() {
  const ed = useEditor();
  const local = useComponentAssets();
  const libs = useLibraries();
  const [query, setQuery] = useState("");
  const view = useUI((s) => s.assetsView);
  const at = useUI((s) => s.assetsAt ?? null);
  const [drag, setDrag] = useState<{ asset: Item; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; asset: Item } | null>(null);
  const [settings, setSettings] = useState<{ x: number; y: number } | null>(null);
  const settingsButton = useRef<HTMLDivElement>(null);
  const pending = libs.on ? ed.libraries.pendingCount() : 0;

  const sections: Section[] = [];
  if (local.length) sections.push({ key: "local", title: "Created in this file", items: local, pages: ed.store.pages.map((p) => p.guid) });
  for (const lib of libs.enabled) {
    const manifest = libs.manifests.get(lib);
    if (!manifest) continue;
    const name = libs.names.get(lib) ?? "Library";
    const items = remoteItems(lib, name, manifest.assets);
    if (!items.length) continue; // a library of styles and variables only: nothing to list here
    sections.push({ key: `lib:${lib}`, title: name, items, pages: [...new Set(items.map((i) => i.page))], library: lib });
  }
  const open = at ? sections.find((s) => s.key === at.section) : undefined;
  const go = (next: { section: string; page?: string } | null) => {
    setQuery("");
    ed.ui.set({ assetsAt: next });
  };

  const place = (a: Item, point?: { x: number; y: number }) => {
    if (a.library && a.remote) {
      void insertLibraryComponent(ed, a.library, a.remote, point)
        .then((made) => {
          if (!made) showToast({ message: "The instance couldn't be inserted" });
          else ed.focusCanvas();
        })
        .catch(() => showToast({ message: "The library component couldn't be loaded", kind: "error" }));
      return;
    }
    const made = insertInstance(ed, a.target, point);
    if (!made) showToast({ message: "The instance couldn't be inserted" });
    else ed.focusCanvas();
  };

  const onPointerDown = (e: React.PointerEvent, a: Item) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      dragging = true;
      setDrag({ asset: a, x: ev.clientX, y: ev.clientY });
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

  /** A component as a tile or a row. */
  const asset = (a: Item, sectionTitle: string) => (
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
        if (a.library) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, asset: a });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          place(a);
        }
      }}
    >
      {view === "grid" ? (
        <>
          <span className={styles.tileBox}>
            {a.remote ? <RemoteThumb asset={a.remote} size={TILE} className={styles.remoteThumb} /> : <Thumb asset={a} size={TILE} />}
            {a.kind === "set" && (a.variantCount ?? 0) > 0 && (
              <span className={styles.variants} aria-label={`Includes ${a.variantCount} variants`}>
                {a.variantCount}
              </span>
            )}
          </span>
          <span className={styles.tileName}>{assetLabel(a.name)}</span>
        </>
      ) : (
        <>
          <Icon name={a.kind === "set" ? "16.component.set" : "16.component"} className={styles.glyph} />
          <span className={styles.rowName}>{assetLabel(a.name)}</span>
        </>
      )}
    </button>
  );

  /** A list of components, under the frames they sit in. */
  const items = (list: Item[], section: Section) =>
    groupAssets(list, section.pages).map((g) =>
      g.frames.map((f) => (
        <div key={`${g.page}/${f.frame ?? ""}`} role="group" aria-label={f.frameName ?? g.pageName}>
          {f.frame && <div className={styles.frameName}>{f.frameName}</div>}
          <div className={view === "grid" ? styles.grid : styles.list}>{(f.items as Item[]).map((a) => asset(a, section.title))}</div>
        </div>
      ))
    );

  const settingsEntries: MenuEntry[] = [
    { id: "grid", label: "Grid", checked: view === "grid" },
    { id: "list", label: "List", checked: view === "list" },
    "-",
    { id: "libraries", label: "Manage libraries…", disabled: !libs.on },
  ];

  let body: React.ReactNode;
  if (!sections.length) {
    body = (
      <EmptyState
        icon="24.component"
        title="No components yet"
        body={libs.on ? "Components you create in this file and the libraries you add show up here. Select layers and press ⌥⌘K." : "Components you create in this file show up here. Select layers and press ⌥⌘K."}
        action={libs.on ? { label: "Browse libraries", onClick: () => openLibraries() } : undefined}
      />
    );
  } else if (query) {
    const scope = open ? [open] : sections;
    const found = scope.map((s) => ({ s, list: searchAssets(s.items, query) as Item[] })).filter((x) => x.list.length);
    body = (
      <div className={styles.scroll} role="tree" aria-label="Assets">
        {!found.length && <div className={styles.none}>No results for “{query}”</div>}
        {found.map(({ s, list }) => (
          <div key={s.key} role="group" aria-label={s.title} data-assets-section={s.title}>
            <div className={styles.heading}>{s.title}</div>
            {items(list, s)}
          </div>
        ))}
      </div>
    );
  } else if (!open) {
    body = (
      <div className={styles.scroll} data-all-libraries="">
        <div className={styles.heading}>All libraries</div>
        {sections.map((s) => (
          <button key={s.key} type="button" className={styles.card} data-library-card={s.title} onClick={() => go({ section: s.key })}>
            <span className={styles.cardThumb}>
              {s.items[0] && (s.items[0].remote ? <RemoteThumb asset={s.items[0].remote} size={TILE} className={styles.remoteThumb} /> : <Thumb asset={s.items[0]} size={TILE} />)}
            </span>
            <span className={styles.cardTitle}>{s.title}</span>
            <span className={styles.cardCount}>{plural(s.items.length, "component")}</span>
          </button>
        ))}
        {libs.on && (
          <button type="button" className={styles.addMore} onClick={() => openLibraries()}>
            Add more libraries
          </button>
        )}
      </div>
    );
  } else {
    const groups = groupAssets(open.items, open.pages);
    const page = at?.page ? groups.find((g) => g.page === at.page) : undefined;
    body = (
      <div className={styles.scroll} role="tree" aria-label={open.title} data-assets-section={open.title}>
        <div className={styles.path}>
          <IconButton icon="24.arrow.left" label="Back" tone="secondary" onClick={() => go(page ? { section: open.key } : null)} />
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
    <div className={styles.assets} data-assets="">
      <TabHeader
        title="Assets"
        actions={
          libs.on ? (
            <span className={lstyles.libButton}>
              <IconButton icon="24.library" label={pending ? "Review library updates" : "Libraries"} tone="secondary" data-libraries-button="" onClick={() => openLibraries(pending ? "updates" : "libraries")} />
              {pending > 0 && <span className={lstyles.badge} data-updates-badge="" aria-hidden />}
            </span>
          ) : undefined
        }
      />
      <div className={styles.toolbar}>
        <SearchField className={styles.search} value={query} onChange={setQuery} placeholder={open ? "Search in this library" : "Search all libraries"} label={open ? "Search in this library" : "Search all libraries"} />
        <div ref={settingsButton} style={{ display: "contents" }}>
          <IconButton
            icon="24.adjust.small"
            label="Libraries and settings"
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
        <Banner tone="brand" icon="24.library" className={lstyles.updatesBanner} action={{ label: "Review", onClick: () => openLibraries("updates") }}>
          {pending === 1 ? "1 library update available" : `${pending} library updates available`}
        </Banner>
      )}
      {body}
      {drag && (
        <div className={styles.ghost} style={{ left: drag.x, top: drag.y }} aria-hidden>
          <Icon name={drag.asset.kind === "set" ? "16.component.set" : "16.component"} className={styles.glyph} />
          <span>{assetLabel(drag.asset.name)}</span>
        </div>
      )}
      {menu && <AssetMenu ed={ed} at={menu} asset={menu.asset} onClose={() => setMenu(null)} />}
      {settings && (
        <ContextMenu
          at={settings}
          entries={settingsEntries}
          label="Libraries and settings"
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

/** Right click on a local component: Go to main component, Hide when publishing (Figma's, R5). */
function AssetMenu({ ed, at, asset, onClose }: { ed: EditorController; at: { x: number; y: number }; asset: Item; onClose: () => void }) {
  const hidden = isHiddenWhenPublishing(ed, asset.id);
  const byName = /^[._]/.test(asset.name);
  return (
    <ContextMenu
      at={at}
      label={asset.name}
      entries={[
        { id: "go", label: "Go to main component" },
        "-",
        { id: "hide", label: "Hide when publishing", checked: hidden || byName, disabled: byName || !ed.libraries.get().on, hint: byName ? "Name starts with _ or ." : undefined },
      ]}
      onSelect={(id) => {
        if (id === "go") {
          ed.ui.set({ railTab: "file" });
          goToComponent(ed, asset.id);
        } else if (id === "hide") setHiddenWhenPublishing(ed, asset.id, !hidden);
        onClose();
      }}
      onClose={onClose}
    />
  );
}

/** A component's thumbnail when the engine renders nodes; the glyph otherwise (shown until the canvas is drawn). */
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
      <Icon name={asset.kind === "set" ? "16.component.set" : "16.component"} size={24} className={styles.glyph} />
    </span>
  );
}
