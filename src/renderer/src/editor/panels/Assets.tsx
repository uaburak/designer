/**
 * Assets (the rail's second tab, ⌥2; UI3): a search across every section, the list / grid switch and the
 * Libraries button (its blue dot: an enabled library has updates). "Created in this file" — the file's local
 * components grouped by page and then by the top-level frame they sit in — then a section per enabled library,
 * grouped the same way by where each component sits in its library (file › page › frame), with the published
 * thumbnails. A click inserts an instance in the middle of the view; a drag drops one where it is let go (in the
 * innermost frame there). A set shows once and inserts its default (top-left) variant. A library component is
 * inserted as an instance of its read-only copy (brought in, with what it needs, in the same step). Right click on
 * a local component: Hide when publishing, Go to main component.
 */
import { useEffect, useRef, useState } from "react";
import { Banner, ContextMenu, EmptyState, Icon, IconButton, SearchField, cx, showToast } from "@/ds";
import type { Pixels } from "@/engine/codec";
import type { LibraryAsset } from "../../../../shared/store/types";
import { useEditor, type EditorController } from "../controller";
import { goToComponent, insertInstance } from "../components";
import { engineMethod } from "../engineCompat";
import { useLibraries, useUI } from "../hooks";
import { insertLibraryComponent, isHiddenWhenPublishing, setHiddenWhenPublishing } from "../libraries";
import { assetLabel, groupAssets, searchAssets, type AssetGroup, type ComponentAsset } from "../model/components";
import { useComponentAssets } from "./design/ComponentPicker";
import { RemoteThumb } from "./libraries/Thumbs";
import lstyles from "./libraries/Libraries.module.css";
import styles from "./Assets.module.css";

const THUMB = 72;

/** A component of an enabled library, in the local assets' shape (grouped and searched the same way). */
type Item = ComponentAsset & { library?: string; remote?: LibraryAsset };

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
  const ed = useEditor();
  const local = useComponentAssets();
  const libs = useLibraries();
  const [query, setQuery] = useState("");
  const view = useUI((s) => s.assetsView);
  const closed = useUI((s) => s.assetsClosed);
  const [drag, setDrag] = useState<{ asset: Item; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; asset: Item } | null>(null);
  const pending = libs.on ? ed.libraries.pendingCount() : 0;
  const toggle = (key: string) =>
    ed.ui.set((s) => {
      const next = new Set(s.assetsClosed);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { assetsClosed: next };
    });

  const sections: { key: string; title: string; groups: AssetGroup[]; total: number; library?: string }[] = [];
  const localFound = searchAssets(local, query);
  if (local.length)
    sections.push({
      key: "local",
      title: "Created in this file",
      groups: groupAssets(localFound, ed.store.pages.map((p) => p.guid)),
      total: local.length,
    });
  for (const lib of libs.enabled) {
    const manifest = libs.manifests.get(lib);
    if (!manifest) continue;
    const name = libs.names.get(lib) ?? "Library";
    const items = remoteItems(lib, name, manifest.assets);
    if (!items.length) continue; // a library of styles and variables only: nothing to list here
    const found = searchAssets(items, query) as Item[];
    const order = [...new Set(items.map((i) => i.page))];
    sections.push({ key: `lib:${lib}`, title: name, groups: groupAssets(found, order), total: items.length, library: lib });
  }

  const place = (a: Item, at?: { x: number; y: number }) => {
    if (a.library && a.remote) {
      void insertLibraryComponent(ed, a.library, a.remote, at)
        .then((made) => {
          if (!made) showToast({ message: "The instance couldn't be inserted" });
          else ed.focusCanvas();
        })
        .catch(() => showToast({ message: "The library component couldn't be loaded", kind: "error" }));
      return;
    }
    const made = insertInstance(ed, a.target, at);
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
  const nothing = sections.length === 0;
  const noResults = !nothing && query !== "" && sections.every((s) => s.groups.length === 0);

  return (
    <div className={styles.assets} data-assets="">
      <div className={styles.toolbar}>
        <SearchField className={styles.search} value={query} onChange={setQuery} placeholder={libs.enabled.length ? "Search all libraries" : "Search assets"} />
        <IconButton
          icon={view === "grid" ? "24.list-view" : "24.view.grid"}
          label={view === "grid" ? "Show as list" : "Show as grid"}
          tone="secondary"
          onClick={() => ed.ui.set({ assetsView: view === "grid" ? "list" : "grid" })}
        />
        {libs.on && (
          <span className={lstyles.libButton}>
            <IconButton icon="24.library" label={pending ? "Libraries (updates available)" : "Libraries"} tone="secondary" data-libraries-button="" onClick={() => openLibraries(pending ? "updates" : "libraries")} />
            {pending > 0 && <span className={lstyles.badge} data-updates-badge="" aria-hidden />}
          </span>
        )}
      </div>
      {pending > 0 && (
        <Banner tone="brand" icon="24.library" className={lstyles.updatesBanner} action={{ label: "Review", onClick: () => openLibraries("updates") }}>
          {pending === 1 ? "1 library update available" : `${pending} library updates available`}
        </Banner>
      )}
      {nothing ? (
        <EmptyState
          icon="24.component"
          title="No components yet"
          body={libs.on ? "Components you create in this file and the libraries you add show up here. Select layers and press ⌥⌘K." : "Components you create in this file show up here. Select layers and press ⌥⌘K."}
          action={libs.on ? { label: "Browse libraries", onClick: () => openLibraries() } : undefined}
        />
      ) : (
        <div className={styles.scroll} role="tree" aria-label="Assets">
          {noResults && <div className={styles.none}>No results for “{query}”</div>}
          {sections.map((section) => {
            const sectionKey = `section:${section.key}`;
            const sectionOpen = query !== "" || !closed.has(sectionKey);
            if (query !== "" && section.groups.length === 0) return null;
            return (
              <div key={section.key} role="group" aria-label={section.title} data-assets-section={section.title}>
                <button type="button" className={cx(styles.heading, styles.headingButton)} aria-expanded={sectionOpen} onClick={() => toggle(sectionKey)}>
                  <span className={styles.groupName}>{section.title}</span>
                  {section.library && <span className={styles.count}>{section.total}</span>}
                </button>
                {sectionOpen &&
                  section.groups.map((g) => {
                    const pageKey = `page:${g.page}`;
                    const pageOpen = query !== "" || !closed.has(pageKey);
                    return (
                      <div key={g.page} role="group" aria-label={g.pageName}>
                        <button type="button" className={styles.group} aria-expanded={pageOpen} onClick={() => toggle(pageKey)}>
                          <Icon name="16.chevron.down" className={cx(styles.caret, !pageOpen && styles.caretClosed)} />
                          <span className={styles.groupName}>{g.pageName}</span>
                        </button>
                        {pageOpen &&
                          g.frames.map((f) => {
                            const frameKey = `frame:${f.frame ?? g.page}`;
                            const frameOpen = !f.frame || query !== "" || !closed.has(frameKey);
                            return (
                              <div key={frameKey}>
                                {f.frame && (
                                  <button type="button" className={cx(styles.group, styles.subgroup)} aria-expanded={frameOpen} onClick={() => toggle(frameKey)}>
                                    <Icon name="16.chevron.down" className={cx(styles.caret, !frameOpen && styles.caretClosed)} />
                                    <span className={styles.groupName}>{f.frameName}</span>
                                  </button>
                                )}
                                {frameOpen && (
                                  <div className={view === "grid" ? styles.grid : styles.list}>
                                    {(f.items as Item[]).map((a) => (
                                      <button
                                        key={a.id}
                                        type="button"
                                        role="treeitem"
                                        data-asset={a.id}
                                        data-asset-name={a.name}
                                        data-library={a.library ? section.title : undefined}
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
                                            {a.remote ? <RemoteThumb asset={a.remote} size={THUMB} className={styles.remoteThumb} /> : <Thumb asset={a} />}
                                            <span className={styles.tileName}>{assetLabel(a.name)}</span>
                                          </>
                                        ) : (
                                          <>
                                            <Icon name={a.kind === "set" ? "16.component.set" : "16.component"} className={styles.glyph} />
                                            <span className={styles.rowName}>{assetLabel(a.name)}</span>
                                          </>
                                        )}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      )}
      {drag && (
        <div className={styles.ghost} style={{ left: drag.x, top: drag.y }} aria-hidden>
          <Icon name={drag.asset.kind === "set" ? "16.component.set" : "16.component"} className={styles.glyph} />
          <span>{assetLabel(drag.asset.name)}</span>
        </div>
      )}
      {menu && <AssetMenu ed={ed} at={menu} asset={menu.asset} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Right click on a local component: Hide when publishing (Figma's, R5), Go to main component. */
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
function Thumb({ asset }: { asset: ComponentAsset }) {
  const ed = useEditor();
  const ref = useRef<HTMLCanvasElement>(null);
  const render = engineMethod<(o: { node: string; maxSize: number }) => Pixels | null>(ed.engine, "renderNodeThumbnailPixels");
  useEffect(() => {
    const c = ref.current;
    if (!c || !render) return;
    const px = render({ node: asset.target, maxSize: THUMB * Math.max(1, Math.round(window.devicePixelRatio || 1)) });
    if (!px) return;
    c.width = px.width;
    c.height = px.height;
    c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
    c.dataset.drawn = "";
  }, [render, asset.target]);
  return (
    <span className={styles.thumb}>
      {render && <canvas ref={ref} className={styles.thumbCanvas} />}
      <Icon name={asset.kind === "set" ? "16.component.set" : "16.component"} size={24} className={styles.glyph} />
    </span>
  );
}
