// "Try it" (docs/site.md §2): the one interactive tile. The real engine (EngineCanvas, loaded when the tile nears the
// viewport) opens a small file of frames, auto layout, text and shapes on the canvas's own grey; the app's bottom
// toolbar picks the tool. Until the engine runs, a still frame of the same file (drawn by the engine, public/stills)
// sits where the first view will draw it. The page keeps its scroll: the wheel scrolls the page (⌘ or Ctrl with the
// wheel, and a pinch, zoom the canvas), and on a touch phone the canvas waits for a tap.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { EditorToolbar, groupOf, TOOLS, type EditorMode, type ToolGroupId, type ToolId } from "@/ds/components/EditorToolbar";
import { Toolbar, ToolbarGroup, ToolButton } from "@/ds/components/Toolbar";
import type { ToolName } from "@/engine/abi";
import type { Message, NodeChange } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";
import type { EngineStore } from "@/engine/EngineStore";
import { loadLive, type LiveEngine } from "../engine/loadLive";
import { useSiteTheme } from "../runtime/theme";
import { tryDocument } from "./tryDocument";
import styles from "./try.module.css";

const DOC = tryDocument();
const PAGE = "0:1";
const CANVAS_LIGHT = { r: 0xf5 / 255, g: 0xf5 / 255, b: 0xf5 / 255, a: 1 };
const CANVAS_DARK = { r: 0x1e / 255, g: 0x1e / 255, b: 0x1e / 255, a: 1 };
/** The still's region of the page, and its scale (public/stills/try-*.webp, made with `?still` on the dev server). */
const STILL = { x: -40, y: -40, w: 1320, h: 640, scale: 2 };
/** Room kept under the file for the toolbar, px on screen. */
const TOOLBAR_ROOM = 64;

const ENGINE_TOOL: Partial<Record<ToolId, ToolName>> = {
  move: "MOVE", hand: "HAND", scale: "SCALE", frame: "FRAME", section: "SECTION", slice: "SLICE", rectangle: "RECTANGLE", line: "LINE",
  arrow: "ARROW", ellipse: "ELLIPSE", polygon: "POLYGON", star: "STAR", pen: "PEN", pencil: "PENCIL", text: "TEXT",
};
const TOOL_OF = Object.fromEntries(Object.entries(ENGINE_TOOL).map(([k, v]) => [v, k])) as Record<string, ToolId>;
const COMPACT_TOOLS: ToolId[] = ["move", "frame", "rectangle", "ellipse", "pen", "text"];

const pageMessage = (dark: boolean): Message => ({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: [{ guid: PAGE, backgroundColor: dark ? CANVAS_DARK : CANVAS_LIGHT } as NodeChange] });

/** The first view: the whole file, as large as fits (never above 100%), above the toolbar. */
function firstView(width: number, height: number) {
  const zoom = Math.max(0.2, Math.min(1, (width - 48) / STILL.w, (height - TOOLBAR_ROOM - 32) / STILL.h));
  const cx = STILL.x + STILL.w / 2;
  const cy = STILL.y + STILL.h / 2 + TOOLBAR_ROOM / 2 / zoom;
  return { cx, cy, zoom };
}

function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches, () => false);
}

function useTool(store: EngineStore | null): string {
  const subscribe = useCallback((cb: () => void) => (store ? store.subscribe("tool", cb) : () => {}), [store]);
  return useSyncExternalStore(subscribe, () => store?.tool ?? "MOVE");
}

export default function TryScene() {
  const theme = useSiteTheme();
  const touch = useMedia("(pointer: coarse)");
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [live, setLive] = useState<LiveEngine | null>(null);
  const [store, setStore] = useState<EngineStore | null>(null);
  const [failed, setFailed] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [groups, setGroups] = useState<Partial<Record<ToolGroupId, ToolId>>>({});
  const [mode, setMode] = useState<EditorMode>("design");
  const wantsEngine = !touch || engaged;

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!wantsEngine) return;
    let on = true;
    loadLive(engaged).then(
      (m) => on && setLive(m),
      () => on && setFailed(true),
    );
    return () => {
      on = false;
    };
  }, [wantsEngine, engaged]);

  const options = useMemo(() => ({ sessionID: 1, theme: theme === "dark" ? ("DARK" as const) : ("LIGHT" as const) }), []);
  const document = useMemo<Message>(() => ({ ...DOC.message, nodeChanges: DOC.message.nodeChanges.map((n) => (n.guid === PAGE ? { ...n, backgroundColor: theme === "dark" ? CANVAS_DARK : CANVAS_LIGHT } : n)) }), []);

  const place = useCallback((engine: Engine) => {
    const el = rootRef.current;
    if (!el) return;
    engine.setViewportInsets(0, 0, 0, 0);
    const v = firstView(el.clientWidth, el.clientHeight);
    engine.centerOn(v.cx, v.cy, v.zoom);
  }, []);

  const onReady = useCallback(
    (engine: Engine) => {
      if (!live) return;
      place(engine);
      // EngineCanvas focuses the canvas; the page keeps its keys (Space, arrows scroll) until the visitor clicks in
      engine.canvasElement?.blur();
      setStore(new live.EngineStore(engine));
    },
    [live, place],
  );
  const onError = useCallback(() => setFailed(true), []);
  useEffect(() => () => store?.dispose(), [store]);

  // The first view follows the tile's size until the visitor has worked in the canvas
  useEffect(() => {
    const engine = store?.engine;
    const root = rootRef.current;
    if (!engine || !root) return;
    let touched = false;
    const mark = () => (touched = true);
    root.addEventListener("pointerdown", mark, { capture: true });
    let queued = 0;
    const ro = new ResizeObserver(() => {
      if (touched || queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        if (!touched && !engine.destroyed) place(engine);
      });
    });
    ro.observe(root);
    return () => {
      cancelAnimationFrame(queued);
      ro.disconnect();
      root.removeEventListener("pointerdown", mark, { capture: true });
    };
  }, [store, place]);

  // The theme: the engine's chrome and the page's grey
  useEffect(() => {
    if (!store) return;
    store.engine.setTheme(theme === "dark" ? "DARK" : "LIGHT");
    store.engine.applyChanges(pageMessage(theme === "dark"), "system");
    if (import.meta.env.DEV && new URLSearchParams(location.search).has("still")) setTimeout(() => void saveStill(store.engine, theme), 2500);
  }, [store, theme]);

  // The wheel scrolls the page, also over the canvas; ⌘ / Ctrl with the wheel (and a pinch) zoom it
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, []);

  const tool = TOOL_OF[useTool(store)] ?? "move";
  const pick = (t: ToolId) => {
    const name = ENGINE_TOOL[t];
    if (!store || !name) return;
    store.engine.setTool(name);
    setGroups((g) => ({ ...g, [groupOf(t, mode)]: t }));
    store.engine.canvasElement?.focus({ preventScroll: true });
  };

  let still: CSSProperties | null = null;
  if (size && !store) {
    const v = firstView(size.w, size.h);
    still = { left: size.w / 2 + (STILL.x - v.cx) * v.zoom, top: size.h / 2 + (STILL.y - v.cy) * v.zoom, width: STILL.w * v.zoom, height: STILL.h * v.zoom };
  }
  const compact = !!size && size.w < 640;

  return (
    <div ref={rootRef} className={styles.root} data-ready={store ? "" : undefined}>
      {still && <img className={styles.still} src={`/stills/hero-${theme}.webp`} alt="" style={still} draggable={false} onError={(e) => (e.currentTarget.style.display = "none")} />}
      {live && wantsEngine && !failed && <live.EngineCanvas document={document} options={options} fit={false} onReady={onReady} onError={onError} style={{ position: "absolute", inset: 0 }} />}
      {!wantsEngine && (
        <button type="button" className={styles.engage} onClick={() => setEngaged(true)}>
          Tap to try the canvas
        </button>
      )}
      <div className={styles.toolbar}>
        {compact ? (
          <Toolbar floating label="Tools">
            <ToolbarGroup>
              {COMPACT_TOOLS.map((t) => (
                <ToolButton key={t} icon={TOOLS[t].icon} label={TOOLS[t].label} shortcut={TOOLS[t].shortcut} active={tool === t} disabled={!store} onSelect={() => pick(t)} />
              ))}
            </ToolbarGroup>
          </Toolbar>
        ) : (
          <EditorToolbar floating tool={tool} groupTools={groups} mode={mode} onMode={setMode} disabledModes={["draw", "motion", "dev"]} disabledTools={["image", "comment", "annotation", "measurement", "brush", "text-on-path"]} onTool={pick} />
        )}
      </div>
    </div>
  );
}

/** Dev only (`?still`): draws the still frame of each theme with the engine and saves it beside the site's files. */
async function saveStill(engine: Engine, theme: string) {
  const px = engine.renderRegionPixels({ page: PAGE, x: STILL.x, y: STILL.y, w: STILL.w, h: STILL.h, width: STILL.w * STILL.scale, height: STILL.h * STILL.scale });
  if (!px) return;
  const c = document.createElement("canvas");
  c.width = px.width;
  c.height = px.height;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/webp", 0.86));
  if (blob) await fetch(`/__still/hero-${theme}`, { method: "POST", body: blob });
}
