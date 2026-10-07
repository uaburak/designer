/**
 * Assets (the rail's second tab, ⌥2; UI3): the file's local components under
 * "Created in this file", grouped by page and then by the top-level frame
 * they sit in, with a search and a grid / list switch. A click inserts an
 * instance in the middle of the view; a drag drops one where it is let go
 * (in the innermost frame there). A set shows once and inserts its default
 * (top-left) variant. Thumbnails come from the engine when it can render a
 * node (`renderNodeThumbnailPixels`); until then each tile shows the glyph.
 */
import { useEffect, useRef, useState } from "react";
import { EmptyState, Icon, IconButton, SearchField, cx, showToast } from "@/ds";
import type { Pixels } from "@/engine/codec";
import { useEditor, type EditorController } from "../controller";
import { insertInstance } from "../components";
import { engineMethod } from "../engineCompat";
import { useUI } from "../hooks";
import { assetLabel, groupAssets, searchAssets, type ComponentAsset } from "../model/components";
import { useComponentAssets } from "./design/ComponentPicker";
import styles from "./Assets.module.css";

const THUMB = 72;

export function Assets() {
  const ed = useEditor();
  const assets = useComponentAssets();
  const [query, setQuery] = useState("");
  const view = useUI((s) => s.assetsView);
  const closed = useUI((s) => s.assetsClosed);
  const [drag, setDrag] = useState<{ asset: ComponentAsset; x: number; y: number } | null>(null);
  const found = searchAssets(assets, query);
  const groups = groupAssets(found, ed.engine.pages().map((p) => p.guid));
  const toggle = (key: string) =>
    ed.ui.set((s) => {
      const next = new Set(s.assetsClosed);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { assetsClosed: next };
    });

  const onPointerDown = (e: React.PointerEvent, a: ComponentAsset) => {
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
      if (!dragging) return place(ed, a);
      const r = ed.canvas?.getBoundingClientRect();
      if (r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) place(ed, a, { x: ev.clientX - r.left, y: ev.clientY - r.top });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className={styles.assets} data-assets="">
      <div className={styles.toolbar}>
        <SearchField className={styles.search} value={query} onChange={setQuery} placeholder="Search assets" />
        <IconButton
          icon={view === "grid" ? "24.list-view" : "24.view.grid"}
          label={view === "grid" ? "Show as list" : "Show as grid"}
          tone="secondary"
          onClick={() => ed.ui.set({ assetsView: view === "grid" ? "list" : "grid" })}
        />
      </div>
      {assets.length === 0 ? (
        <EmptyState icon="24.component" title="No components yet" body="Components you create in this file show up here. Select layers and press ⌥⌘K." />
      ) : (
        <div className={styles.scroll} role="tree" aria-label="Assets">
          <div className={styles.heading}>Created in this file</div>
          {groups.length === 0 && <div className={styles.none}>No results for “{query}”</div>}
          {groups.map((g) => {
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
                            {f.items.map((a) => (
                              <button
                                key={a.id}
                                type="button"
                                role="treeitem"
                                data-asset={a.id}
                                className={view === "grid" ? styles.tile : styles.row}
                                aria-label={a.name}
                                title={a.description ? `${a.name}\n${a.description}` : a.name}
                                onPointerDown={(e) => onPointerDown(e, a)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    place(ed, a);
                                  }
                                }}
                              >
                                {view === "grid" ? (
                                  <>
                                    <Thumb asset={a} />
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
      )}
      {drag && (
        <div className={styles.ghost} style={{ left: drag.x, top: drag.y }} aria-hidden>
          <Icon name={drag.asset.kind === "set" ? "16.component.set" : "16.component"} className={styles.glyph} />
          <span>{assetLabel(drag.asset.name)}</span>
        </div>
      )}
    </div>
  );
}

function place(ed: EditorController, a: ComponentAsset, at?: { x: number; y: number }) {
  const made = insertInstance(ed, a.target, at);
  if (!made) showToast({ message: "The instance couldn't be inserted" });
  else ed.focusCanvas();
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
