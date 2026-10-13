// The home page's hero: the editor itself. The chrome is the app's (ds TabBar, Rail, PageRow, LayerRow, PanelSection,
// NumericInput, ColorInput, EditorToolbar; the editor's own panel styles), the canvas is the real engine — select,
// move, resize, draw — loaded after the first paint over a still frame of the same file.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Button, IconButton } from "@/ds/components/Button";
import { EditorToolbar, groupOf, TOOLS, type EditorMode, type ToolGroupId, type ToolId } from "@/ds/components/EditorToolbar";
import { Toolbar as DSToolbar, ToolbarGroup, ToolButton } from "@/ds/components/Toolbar";
import { LayerRow, PageRow } from "@/ds/components/LayerRow";
import { MenuButton } from "@/ds/components/Menu";
import { Avatar } from "@/ds/components/Misc";
import { PanelSection } from "@/ds/components/PanelSection";
import { Rail, RailItem, RailSeparator } from "@/ds/components/Rail";
import { TabBar } from "@/ds/components/TabBar";
import { Tabs } from "@/ds/components/Tabs";
import { Icon } from "@/ds/icons/Icon";
import type { ToolName } from "@/engine/abi";
import type { Message, NodeChange } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";
import type { EngineStore } from "@/engine/EngineStore";
import { useCamera, useHover, useSelection, useTool } from "@/engine/hooks";
import panels from "@/editor/panels/Panels.module.css";
import { layerRows, withChildIds } from "../engine/layers";
import { loadLive, type LiveEngine } from "../engine/loadLive";
import { cancelWrite, write } from "../engine/write";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import { useSiteTheme } from "../runtime/theme";
import { DesignPanel } from "./DesignPanel";
import { heroDocument } from "./heroDocument";
import styles from "./hero.module.css";

const DOC = heroDocument();
const PAGE = "0:1";
const CANVAS_LIGHT = { r: 0xf5 / 255, g: 0xf5 / 255, b: 0xf5 / 255, a: 1 };
const CANVAS_DARK = { r: 0x1e / 255, g: 0x1e / 255, b: 0x1e / 255, a: 1 };

const ENGINE_TOOL: Partial<Record<ToolId, ToolName>> = {
  move: "MOVE", hand: "HAND", scale: "SCALE", frame: "FRAME", section: "SECTION", slice: "SLICE", rectangle: "RECTANGLE", line: "LINE",
  arrow: "ARROW", ellipse: "ELLIPSE", polygon: "POLYGON", star: "STAR", pen: "PEN", pencil: "PENCIL", brush: "BRUSH", text: "TEXT",
  "text-on-path": "TEXT_PATH", comment: "COMMENT", annotation: "ANNOTATION", measurement: "MEASUREMENT",
};
const TOOL_OF = Object.fromEntries(Object.entries(ENGINE_TOOL).map(([k, v]) => [v, k])) as Record<string, ToolId>;

/** The page's colour for a theme (Figma draws its default canvas grey in light and dark). */
const pageMessage = (dark: boolean): Message => ({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: [{ guid: PAGE, backgroundColor: dark ? CANVAS_DARK : CANVAS_LIGHT } as NodeChange] });

function useMedia(query: string): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const m = matchMedia(query);
    m.addEventListener("change", cb);
    return () => m.removeEventListener("change", cb);
  }, [query]);
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches, () => false);
}

export default function HeroScene() {
  const theme = useSiteTheme();
  const touch = useMedia("(pointer: coarse)");
  const narrow = useMedia("(max-width: 760px)");
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setCompact(e.contentRect.width < 620));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [live, setLive] = useState<LiveEngine | null>(null);
  const [store, setStore] = useState<EngineStore | null>(null);
  const [failed, setFailed] = useState(false);
  // On a phone the canvas waits for a tap (it would hold the page's scroll), and loads only then.
  const [engaged, setEngaged] = useState(false);
  const wantsEngine = !(touch && narrow) || engaged;

  useEffect(() => {
    if (!wantsEngine) return;
    let live = true;
    loadLive(engaged).then((m) => live && setLive(m), () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [wantsEngine, engaged]);

  const options = useMemo(() => ({ sessionID: 1, theme: theme === "dark" ? ("DARK" as const) : ("LIGHT" as const) }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const document = useMemo<Message>(() => ({ ...DOC.message, nodeChanges: DOC.message.nodeChanges.map((n) => (n.guid === PAGE ? { ...n, backgroundColor: theme === "dark" ? CANVAS_DARK : CANVAS_LIGHT } : n)) }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const onReady = useCallback(
    (engine: Engine) => {
      if (!live) return;
      const s = new live.EngineStore(engine);
      placeCamera(engine, viewRef.current);
      setStore(s);
      (window as { __wecraHero?: Engine }).__wecraHero = engine;
    },
    [live],
  );
  const onError = useCallback(() => setFailed(true), []);
  useEffect(() => () => store?.dispose(), [store]);

  // The theme: the engine's chrome (selection, guides) and the page's grey
  useEffect(() => {
    if (!store) return;
    store.engine.setTheme(theme === "dark" ? "DARK" : "LIGHT");
    store.engine.applyChanges(pageMessage(theme === "dark"), "system");
    if (import.meta.env.DEV && new URLSearchParams(location.search).has("still")) setTimeout(() => void saveStill(store.engine, theme), 2500);
  }, [store, theme]);

  // Wheel over the canvas scrolls the page until the visitor works in the canvas (a press in it); pinch always zooms it.
  const workingRef = useRef(false);
  useEffect(() => {
    const view = viewRef.current?.parentElement;
    if (!view) return;
    const onWheel = (e: WheelEvent) => {
      if (!workingRef.current && !e.ctrlKey && !e.metaKey) e.stopPropagation();
    };
    const onDown = () => (workingRef.current = true);
    const onLeave = () => (workingRef.current = false);
    view.addEventListener("wheel", onWheel, { capture: true, passive: true });
    view.addEventListener("pointerdown", onDown, { capture: true });
    view.addEventListener("pointerleave", onLeave);
    return () => {
      view.removeEventListener("wheel", onWheel, { capture: true });
      view.removeEventListener("pointerdown", onDown, { capture: true });
      view.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  const { cursor } = useDemo(rootRef, (run) => heroDemo(run, store), { idleMs: 9000, loopGapMs: 2600, startDelayMs: 1800 });

  const ready = !!store;
  const pageColor = theme === "dark" ? "#1E1E1E" : "#F5F5F5";
  return (
    <div ref={rootRef} className={styles.window} data-ready={ready || undefined} data-narrow={narrow || undefined}>
      <div className={styles.tabbar}>
        <TabBar tabs={[{ id: "launch", title: "Lumen — Launch" }]} active="launch" onActivate={() => {}} onClose={() => {}} onNew={() => {}} trailing={<IconButton icon="24.sidebar.closed" label="Panels" />} />
      </div>
      <div className={styles.body}>
        <div className={styles.canvasArea}>
          {!ready && <Still theme={theme} viewRef={viewRef} />}
          {live && wantsEngine && !failed && <live.EngineCanvas document={document} options={options} fit={false} onReady={onReady} onError={onError} style={{ position: "absolute", inset: 0 }} />}
        </div>
        <div className={styles.chrome}>
          <Rail className={styles.rail} labels={false}>
            <RailItem compact icon="24.figma" label="Main menu" active={false} />
            <RailSeparator />
            <RailItem icon="24.page" label="File" active />
            <RailItem icon="24.agents" label="Agents" active={false} />
            <RailItem icon="24.assets" label="Assets" active={false} />
            <RailItem icon="24.tools" label="Tools" active={false} />
          </Rail>
          <aside className={`${panels.left} ${styles.left}`} aria-label="Layers panel">
            <div className={panels.fileHeader}>
              <div className={panels.fileTitle}>
                <button type="button" className={panels.fileButton}>
                  <span>Lumen — Launch</span>
                  <Icon name="16.chevron.down" />
                </button>
                <span className={panels.fileLocation}>Drafts</span>
              </div>
              <IconButton icon="24.sidebar.closed" label="Minimize UI" />
            </div>
            <PanelSection title="Pages" className={panels.pages} actions={<IconButton icon="24.plus.small" label="Add new page" tone="secondary" />}>
              <div className={panels.pageList}>
                <PageRow id="0:1" name="Launch" current />
                <PageRow id="p2" name="Explorations" current={false} />
              </div>
            </PanelSection>
            <Layers store={store} />
          </aside>
          <div className={styles.view} ref={viewRef}>
            <Toolbar store={store} compact={compact} />
            {!ready && (touch && narrow && !engaged ? (
              <button type="button" className={styles.engage} onClick={() => setEngaged(true)}>
                <Icon name="24.move" /> Tap to edit
              </button>
            ) : failed ? (
              <p className={styles.status}>This browser can’t run the canvas (WebGL 2 is off).</p>
            ) : null)}
            {engaged && ready && (
              <button type="button" className={styles.release} onClick={() => setEngaged(false)}>
                Done
              </button>
            )}
          </div>
          <aside className={`${panels.right} ${styles.right}`} aria-label="Properties panel" data-panel="right">
            <div className={panels.rightHeader}>
              <MenuButton label="Account" entries={[{ id: "a", label: "Ada Park" }]} onSelect={() => {}} className={panels.account}>
                <Avatar name="Ada Park" size={28} />
                <span className={panels.accountMore}>
                  <Icon name="16.chevron.down" />
                </span>
              </MenuButton>
              <span className={panels.grow} />
              <span className={panels.present}>
                <IconButton icon="24.play" label="Present" size="large" />
                <MenuButton label="Present options" entries={[{ id: "p", label: "Present" }]} onSelect={() => {}} className={`${panels.chip} ${panels.presentChevron}`}>
                  <Icon name="16.chevron.down" />
                </MenuButton>
              </span>
              <Button variant="primary" size="large" className={panels.share}>
                Share
              </Button>
            </div>
            <RightTabs store={store} />
            <div className={panels.rightBody}>
              <DesignPanel store={store} pageColor={pageColor.slice(1)} />
            </div>
          </aside>
        </div>
        <DemoCursor cursor={cursor} />
      </div>
    </div>
  );
}

/** The world rectangle the still frame shows (both frames and a margin), and its file's scale. */
const STILL = { x: -40, y: -40, w: 1320, h: 640, scale: 2 };

/** The first view: the Home frame centred in what the panels leave (the toolbar's room kept), as large as fits. */
function firstView(view: DOMRect): { x: number; y: number; zoom: number } {
  const zoom = Math.max(0.18, Math.min(1, (view.width - 64) / 880, (view.height - 112) / 560));
  return { x: 440, y: 280 + 22 / zoom, zoom };
}

function placeCamera(engine: Engine, view: HTMLElement | null) {
  const canvas = engine.canvasElement;
  if (!view || !canvas) return engine.command("ZOOM_TO_FIT");
  const c = canvas.getBoundingClientRect();
  const v = view.getBoundingClientRect();
  engine.setViewportInsets(v.left - c.left, v.top - c.top, c.right - v.right, c.bottom - v.bottom);
  const at = firstView(v);
  engine.centerOn(at.x, at.y, at.zoom);
}

/**
 * The still frame until the engine runs: the same file, drawn by the engine and saved once (`public/stills`, made with
 * `?still` on the dev server), placed where the first view will draw it.
 */
function Still({ theme, viewRef }: { theme: "light" | "dark"; viewRef: React.RefObject<HTMLDivElement | null> }) {
  const [box, setBox] = useState<CSSProperties | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    const area = view?.parentElement?.parentElement;
    if (!view || !area) return;
    const place = () => {
      const v = view.getBoundingClientRect();
      const a = area.getBoundingClientRect();
      const at = firstView(v);
      const cx = v.left - a.left + v.width / 2;
      const cy = v.top - a.top + v.height / 2;
      setBox({ left: cx + (STILL.x - at.x) * at.zoom, top: cy + (STILL.y - at.y) * at.zoom, width: STILL.w * at.zoom, height: STILL.h * at.zoom });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(area);
    return () => ro.disconnect();
  }, [viewRef]);
  if (!box) return null;
  return <img className={styles.still} src={`/stills/hero-${theme}.webp`} alt="" style={box} draggable={false} onError={(e) => (e.currentTarget.style.display = "none")} />;
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

function Toolbar({ store, compact }: { store: EngineStore | null; compact: boolean }) {
  const [groups, setGroups] = useState<Partial<Record<ToolGroupId, ToolId>>>({});
  const [mode, setMode] = useState<EditorMode>("design");
  if (compact) return <CompactToolbar store={store} />;
  return store ? <LiveToolbar store={store} groups={groups} setGroups={setGroups} mode={mode} setMode={setMode} /> : <EditorToolbar floating tool="move" groupTools={groups} mode={mode} onMode={setMode} onTool={() => {}} />;
}

const COMPACT_TOOLS: ToolId[] = ["move", "frame", "rectangle", "ellipse", "pen", "text"];

/** A phone's width: the bottom toolbar's slots alone (the ds Toolbar and ToolButton the full one is made of). */
function CompactToolbar({ store }: { store: EngineStore | null }) {
  const engineTool = useMaybeTool(store);
  const tool = TOOL_OF[engineTool] ?? "move";
  return (
    <DSToolbar floating label="Tools">
      <ToolbarGroup>
        {COMPACT_TOOLS.map((t) => (
          <ToolButton
            key={t}
            icon={TOOLS[t].icon}
            label={TOOLS[t].label}
            shortcut={TOOLS[t].shortcut}
            active={tool === t}
            disabled={!store}
            onSelect={() => {
              store?.engine.setTool(ENGINE_TOOL[t]!);
            }}
          />
        ))}
      </ToolbarGroup>
    </DSToolbar>
  );
}

function useMaybeTool(store: EngineStore | null): string {
  const subscribe = useCallback((cb: () => void) => (store ? store.subscribe("tool", cb) : () => {}), [store]);
  return useSyncExternalStore(subscribe, () => store?.tool ?? "MOVE");
}

function LiveToolbar({ store, groups, setGroups, mode, setMode }: { store: EngineStore; groups: Partial<Record<ToolGroupId, ToolId>>; setGroups: (g: Partial<Record<ToolGroupId, ToolId>>) => void; mode: EditorMode; setMode: (m: EditorMode) => void }) {
  const engineTool = useTool(store);
  const tool = TOOL_OF[engineTool] ?? "move";
  return (
    <EditorToolbar
      floating
      tool={tool}
      groupTools={groups}
      mode={mode}
      onMode={setMode}
      disabledTools={["image", "comment", "annotation", "measurement"]}
      onTool={(t) => {
        const name = ENGINE_TOOL[t];
        if (!name) return;
        store.engine.setTool(name);
        setGroups({ ...groups, [groupOf(t, mode)]: t });
        store.engine.canvasElement?.focus({ preventScroll: true });
      }}
    />
  );
}

function RightTabs({ store }: { store: EngineStore | null }) {
  const [tab, setTab] = useState("design");
  return (
    <div className={panels.rightTabs}>
      <Tabs label="Properties" idBase="hero-right" value={tab} tabs={[{ value: "design", label: "Design", width: 53 }, { value: "prototype", label: "Prototype", width: 69 }]} onChange={setTab} />
      {store ? <Zoom store={store} /> : <span className={panels.zoom}>{"–"}</span>}
    </div>
  );
}

function Zoom({ store }: { store: EngineStore }) {
  const camera = useCamera(store);
  return (
    <MenuButton
      label="Zoom"
      className={panels.zoom}
      entries={[
        { id: "ZOOM_IN", label: "Zoom in", shortcut: "+" },
        { id: "ZOOM_OUT", label: "Zoom out", shortcut: "-" },
        { id: "ZOOM_TO_FIT", label: "Zoom to fit", shortcut: "⇧1" },
        { id: "ZOOM_TO_SELECTION", label: "Zoom to selection", shortcut: "⇧2" },
      ]}
      onSelect={(id) => store.engine.command(id as "ZOOM_IN")}
    >
      <span>{Math.round(camera.zoom * 100)}%</span>
      <Icon name="16.chevron.down" />
    </MenuButton>
  );
}

// ── Layers ────────────────────────────────────────────────────────────────────────────────────────────────────────

const STATIC_NODES = withChildIds(DOC.message.nodeChanges);

function Layers({ store }: { store: EngineStore | null }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([DOC.home]));
  const toggle = (id: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <PanelSection title="Layers" className={panels.layers} pad="none">
      <div className={`${panels.layerList} ${styles.layerList}`} role="tree" aria-label="Layers">
        {store ? <LiveRows store={store} expanded={expanded} toggle={toggle} /> : <Rows nodes={STATIC_NODES} expanded={expanded} toggle={toggle} />}
      </div>
    </PanelSection>
  );
}

function Rows({ nodes, expanded, toggle, selection = new Set<string>(), hover = null, store }: { nodes: readonly NodeChange[]; expanded: Set<string>; toggle: (id: string) => void; selection?: Set<string>; hover?: string | null; store?: EngineStore }) {
  const rows = layerRows(nodes, PAGE, expanded, selection);
  const engine = store?.engine;
  return (
    <>
      {rows.map((r) => (
        <LayerRow
          key={r.id}
          id={r.id}
          depth={r.depth}
          name={r.name}
          icon={r.icon}
          iconLabel={r.iconLabel}
          expanded={r.expanded}
          selected={r.selected}
          selectedAncestor={r.selectedAncestor}
          run={r.run}
          strong={r.strong}
          locked={r.locked}
          hidden={!r.visible}
          hovered={hover === r.id}
          onToggleExpand={() => toggle(r.id)}
          onToggleLock={engine ? () => write(engine, [r.id], { locked: !r.locked }, r.locked ? "Unlock" : "Lock") : undefined}
          onToggleVisible={engine ? () => write(engine, [r.id], { visible: !r.visible }, r.visible ? "Hide" : "Show") : undefined}
          onPointerDown={(e) => {
            if (!engine || e.button !== 0) return;
            const next = e.shiftKey || e.metaKey ? (selection.has(r.id) ? [...selection].filter((x) => x !== r.id) : [...selection, r.id]) : [r.id];
            engine.setSelection(next);
          }}
          onMouseEnter={engine ? () => engine.setHover([r.id]) : undefined}
          onMouseLeave={engine ? () => engine.setHover([]) : undefined}
        />
      ))}
    </>
  );
}

function LiveRows({ store, expanded, toggle }: { store: EngineStore; expanded: Set<string>; toggle: (id: string) => void }) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const a = store.subscribe("structure", bump);
    const b = store.engine.onDocumentChanged(bump);
    return () => {
      a();
      b();
    };
  }, [store]);
  const nodes = useMemo(() => store.engine.layerTree(PAGE), [store, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const selection = useSelection(store);
  const hover = useHover(store);
  const selected = useMemo(() => new Set(selection.refs), [selection]);
  return <Rows nodes={nodes} expanded={expanded} toggle={toggle} selection={selected} hover={hover} store={store} />;
}

// ── The guided demo ───────────────────────────────────────────────────────────────────────────────────────────────

/** Select the button and recolour it, open up the cards' gap, draw a frame — then undo, so the file is as it was. */
async function heroDemo(run: SceneRun, store: EngineStore | null) {
  if (!store) {
    await run.wait(1500);
    return;
  }
  const engine = store.engine;
  const canvas = engine.canvasElement;
  if (!canvas) return;
  let steps = 0;
  const undoAll = async () => {
    for (; steps > 0; steps--) {
      engine.command("UNDO");
      await run.wait(260);
    }
  };
  try {
    engine.setSelection([]);
    await run.wait(600);
    // 1. The "Pre-order" button, from the Layers panel
    const row = () => run.$(`[data-ds="LayerRow"][data-id="${DOC.buttons}"]`);
    await run.click(row(), { dx: -20 });
    engine.setSelection([DOC.buttons]);
    await run.wait(500);
    const primaryRow = run.$(`[data-ds="LayerRow"][data-id="${DOC.primary}"]`);
    await run.click(primaryRow, { dx: -20 });
    engine.setSelection([DOC.primary]);
    await run.wait(700);
    // 2. Its fill, typed in the panel
    const fill = run.$('[data-paint="fillPaints"] input');
    await run.click(fill);
    await run.wait(250);
    write(engine, [DOC.primary], { fillPaints: [{ type: "SOLID", color: { r: 0xff / 255, g: 0xa6 / 255, b: 0x29 / 255, a: 1 }, opacity: 1, visible: true }] }, "Fill");
    steps++;
    await run.wait(900);
    // 3. The feature cards' gap, scrubbed
    engine.setSelection([DOC.cards]);
    await run.wait(500);
    const gap = run.$('[data-field="gap"] [data-ds-scrub-handle], [data-field="gap"] svg');
    await run.move(gap);
    run.press(true);
    engine.setSpacingHighlight(1);
    for (let g = 16; g <= 40; g += 2) {
      write(engine, [DOC.cards], { stackSpacing: g }, "Gap", { final: g === 40, source: "scrub" });
      await run.move(run.at(gap, (g - 16) * 1.6), { ms: 40 });
    }
    steps++;
    run.press(false);
    await run.wait(900);
    engine.setSpacingHighlight(0);
    // 4. A frame, drawn on the canvas with the Frame tool
    const tool = run.$('[data-tool="frame"], button[aria-label^="Frame"]');
    await run.click(tool);
    engine.setTool("FRAME");
    const view = canvas.getBoundingClientRect();
    const root = run.root.getBoundingClientRect();
    const origin = engine.screenToWorld(0, 0);
    const zoom = engine.getCamera().zoom;
    const art = engine.readNode(DOC.art)?.transform;
    const x0 = ((art?.m02 ?? 500) + 28 - origin.x) * zoom;
    const y0 = ((art?.m12 ?? 96) + 150 - origin.y) * zoom;
    const x1 = x0 + 120 * zoom;
    const y1 = y0 + 96 * zoom;
    const toScene = (x: number, y: number) => ({ x: x + view.left - root.left, y: y + view.top - root.top });
    await run.move(toScene(x0, y0));
    run.press(true);
    engine.pointer(0, x0, y0, 0, 1, 0);
    for (let i = 1; i <= 12; i++) {
      const x = x0 + ((x1 - x0) * i) / 12;
      const y = y0 + ((y1 - y0) * i) / 12;
      engine.pointer(1, x, y, 0, 1, 0);
      await run.move(toScene(x, y), { ms: 30 });
    }
    engine.pointer(2, x1, y1, 0, 0, 0);
    run.press(false);
    steps++;
    await run.wait(1400);
    run.hide();
    await undoAll();
    engine.setSelection([]);
  } catch (e) {
    cancelWrite(engine);
    engine.setSpacingHighlight(0);
    if (store.tool !== "MOVE") engine.setTool("MOVE");
    throw e;
  }
}
