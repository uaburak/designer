// Draw (watch-only): the page's one live engine (docs/site.md §2.4). A small file — a poster made of shapes and an
// empty frame — drawn and edited by the real engine as the demo drives it with synthesized pointer events: the Pen (click for corners, drag for curves, Enter or Esc to finish), the
// Pencil, the shape tools and Frame from the ds bottom toolbar, and the hero's Design panel (ds sections over the
// engine's flat API) to recolour and stroke what is selected. Until the engine runs, the same file is drawn as SVG.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { TOOLS, type ToolId } from "@/ds/components/EditorToolbar";
import { MenuButton } from "@/ds/components/Menu";
import { Tabs } from "@/ds/components/Tabs";
import { Toolbar, ToolbarGroup, ToolButton } from "@/ds/components/Toolbar";
import { Icon } from "@/ds/icons/Icon";
import type { ToolName } from "@/engine/abi";
import type { Message, NodeChange } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";
import type { EngineStore } from "@/engine/EngineStore";
import { useCamera, useTool } from "@/engine/hooks";
import panels from "@/editor/panels/Panels.module.css";
import { DesignPanel } from "../hero/DesignPanel";
import { loadLive, type LiveEngine } from "../engine/loadLive";
import { cancelWrite, write } from "../engine/write";
import { hex } from "../engine/doc";
import { Panel, SceneBody, SceneCanvas, SceneWindow } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import { useSiteTheme } from "../runtime/theme";
import { drawDocument, POSTER, type StillShape } from "./drawDocument";
import styles from "./draw.module.css";

const DOC = drawDocument();
const PAGE = "0:1";
const BUILT = new Set(DOC.message.nodeChanges.map((n) => n.guid));
const CANVAS_LIGHT = hex(0xf5f5f5);
const CANVAS_DARK = hex(0x1e1e1e);
const pageMessage = (dark: boolean): Message => ({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: [{ guid: PAGE, backgroundColor: dark ? CANVAS_DARK : CANVAS_LIGHT } as NodeChange] });

/** The tools offered here, in the bottom toolbar's order: move and region, shapes, then the drawing tools. */
const GROUPS: [ToolId, ToolName][][] = [
  [["move", "MOVE"], ["frame", "FRAME"]],
  [["rectangle", "RECTANGLE"], ["ellipse", "ELLIPSE"], ["line", "LINE"], ["star", "STAR"]],
  [["pen", "PEN"], ["pencil", "PENCIL"]],
];
const TOOL_OF: Record<string, ToolId> = Object.fromEntries(GROUPS.flat().map(([id, name]) => [name, id]));

/** Both frames and their labels, in world units. */
const WORLD = { x: POSTER.x, y: POSTER.y - 24, w: POSTER.w + 48 + 280, h: POSTER.h + 24 };
const TOOLBAR_ROOM = 64;

/** The first view for a canvas of w × h: both frames (the poster alone on a phone), centred over the toolbar. */
function firstView(w: number, h: number): { x: number; y: number; zoom: number } {
  const narrow = w < 560;
  const span = narrow ? POSTER.w : WORLD.w;
  const zoom = Math.max(0.2, Math.min(1, (w - (narrow ? 32 : 56)) / span, (h - TOOLBAR_ROOM - 72) / POSTER.h));
  const x = POSTER.x + span / 2;
  const y = POSTER.y + POSTER.h / 2 + TOOLBAR_ROOM / 2 / zoom - 8 / zoom;
  return { x, y, zoom };
}

export default function DrawScene() {
  const theme = useSiteTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<LiveEngine | null>(null);
  const [store, setStore] = useState<EngineStore | null>(null);
  const [failed, setFailed] = useState(false);

  // The engine loads after the first paint; until then (or where WebGL 2 is off) the still frame shows the file.
  useEffect(() => {
    let on = true;
    loadLive().then((m) => on && setLive(m), () => on && setFailed(true));
    return () => {
      on = false;
    };
  }, []);

  const options = useMemo(() => ({ sessionID: 1, theme: theme === "dark" ? ("DARK" as const) : ("LIGHT" as const) }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const document = useMemo<Message>(() => ({ ...DOC.message, nodeChanges: DOC.message.nodeChanges.map((n) => (n.guid === PAGE ? { ...n, backgroundColor: theme === "dark" ? CANVAS_DARK : CANVAS_LIGHT } : n)) }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const onReady = useCallback(
    (engine: Engine) => {
      if (!live) return;
      const r = canvasRef.current?.getBoundingClientRect();
      const at = firstView(r?.width ?? 800, r?.height ?? 500);
      engine.centerOn(at.x, at.y, at.zoom);
      setStore(new live.EngineStore(engine));
      (window as { __wecraDraw?: Engine }).__wecraDraw = engine;
    },
    [live],
  );
  const onError = useCallback(() => setFailed(true), []);
  useEffect(() => () => store?.dispose(), [store]);

  useEffect(() => {
    if (!store) return;
    store.engine.setTheme(theme === "dark" ? "DARK" : "LIGHT");
    store.engine.applyChanges(pageMessage(theme === "dark"), "system");
  }, [store, theme]);

  const { cursor } = useDemo(rootRef, (run) => drawDemo(run, store), { loopGapMs: 2200, startDelayMs: 1200 });

  const ready = !!store;
  return (
    <SceneWindow ref={rootRef} title="Sketches" className={styles.window} data-ready={ready || undefined}>
      <SceneBody>
        <SceneCanvas ref={canvasRef} className={styles.canvas}>
          {!ready && <Still canvasRef={canvasRef} />}
          {live && !failed && <live.EngineCanvas document={document} options={options} fit={false} onReady={onReady} onError={onError} style={{ position: "absolute", inset: 0 }} />}
          <DrawToolbar store={store} />
        </SceneCanvas>
        <Panel>
          <div className={panels.rightTabs}>
            <Tabs label="Properties" idBase="draw-right" value="design" tabs={[{ value: "design", label: "Design", width: 53 }, { value: "prototype", label: "Prototype", width: 69 }]} onChange={() => {}} />
            {store ? <Zoom store={store} /> : <span className={panels.zoom}>{"–"}</span>}
          </div>
          <div className={`${panels.rightBody} ${styles.panelBody}`}>
            <DesignPanel store={store} pageColor={theme === "dark" ? "1E1E1E" : "F5F5F5"} />
          </div>
        </Panel>
      </SceneBody>
      <DemoCursor cursor={cursor} />
    </SceneWindow>
  );
}

/** The bottom toolbar: the ds Toolbar and ToolButtons, each slot one of the engine's tools. */
function DrawToolbar({ store }: { store: EngineStore | null }) {
  return store ? <LiveToolbar store={store} /> : <ToolSlots tool="move" />;
}

function LiveToolbar({ store }: { store: EngineStore }) {
  return <ToolSlots tool={TOOL_OF[useTool(store)] ?? "move"} />;
}

/** The slots show the engine's tool; the demo picks them (the scene is watch-only). */
function ToolSlots({ tool }: { tool: ToolId }) {
  return (
    <Toolbar floating label="Tools" className={styles.toolbar}>
      {GROUPS.map((g, i) => (
        <ToolbarGroup key={i}>
          {g.map(([id]) => (
            <ToolButton key={id} icon={TOOLS[id].icon} label={TOOLS[id].label} shortcut={TOOLS[id].shortcut} active={tool === id} onSelect={() => {}} />
          ))}
        </ToolbarGroup>
      ))}
    </Toolbar>
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

/**
 * The still frame until the engine runs: the same shapes (drawDocument's list) as SVG, where the first view will draw
 * them — so the canvas doesn't jump when the engine takes over.
 */
function Still({ canvasRef }: { canvasRef: React.RefObject<HTMLDivElement | null> }) {
  const [box, setBox] = useState<{ style: CSSProperties; zoom: number } | null>(null);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      const at = firstView(r.width, r.height);
      setBox({
        zoom: at.zoom,
        style: { left: r.width / 2 + (WORLD.x - at.x) * at.zoom, top: r.height / 2 + (WORLD.y - at.y) * at.zoom, width: WORLD.w * at.zoom, height: WORLD.h * at.zoom },
      });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasRef]);
  if (!box) return null;
  const frames = DOC.still.filter((s) => s.kind === "frame");
  const names = ["Poster", "Sketch"];
  const label = 11 / box.zoom;
  return (
    <svg className={styles.still} style={box.style} viewBox={`${WORLD.x} ${WORLD.y} ${WORLD.w} ${WORLD.h}`} aria-hidden="true">
      <defs>
        <clipPath id="draw-still-clip">
          <rect x={POSTER.x} y={POSTER.y} width={POSTER.w} height={POSTER.h} />
        </clipPath>
      </defs>
      {frames.map((f, i) => (
        <g key={i}>
          <text x={f.x} y={f.y - 6 / box.zoom} className={styles.stillLabel} fontSize={label}>
            {names[i]}
          </text>
          <rect x={f.x} y={f.y} width={f.w} height={f.h} fill={f.fill} />
        </g>
      ))}
      <g clipPath="url(#draw-still-clip)">
        {DOC.still.filter((s) => s.clip).map((s, i) => (
          <StillShapeView key={i} s={s} />
        ))}
      </g>
    </svg>
  );
}

function StillShapeView({ s }: { s: StillShape }) {
  if (s.kind === "ellipse") return <ellipse cx={s.x + s.w / 2} cy={s.y + s.h / 2} rx={s.w / 2} ry={s.h / 2} fill={s.fill} />;
  if (s.kind === "star") {
    const pts: string[] = [];
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 0.42 : 1;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push(`${cx + Math.cos(a) * (s.w / 2) * r},${cy + Math.sin(a) * (s.h / 2) * r}`);
    }
    return <polygon points={pts.join(" ")} fill={s.fill} />;
  }
  return <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={s.r} fill={s.fill} />;
}

// ── The guided demo ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * In the empty frame: the Pen draws a wave (a corner, a curve dragged out, a corner, Enter), the Star tool drags out a
 * star, the Fill field recolours it — then every step is undone, so the file is as the visitor left it.
 */
async function drawDemo(run: SceneRun, store: EngineStore | null) {
  if (!store) {
    await run.wait(1500);
    return;
  }
  const engine = store.engine;
  const canvas = engine.canvasElement;
  if (!canvas) return;
  const made: string[] = [];
  let held: { x: number; y: number } | null = null;
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  // A world point → the canvas's px and the scene's (for the pointer)
  const pt = (wx: number, wy: number) => {
    const o = engine.screenToWorld(0, 0);
    const z = engine.getCamera().zoom;
    const x = (wx - o.x) * z;
    const y = (wy - o.y) * z;
    const c = canvas.getBoundingClientRect();
    const r = run.root.getBoundingClientRect();
    return { x, y, scene: { x: x + c.left - r.left, y: y + c.top - r.top } };
  };
  const tool = (label: string) => run.$(`[data-ds="ToolButton"] button[aria-label="${label}"]`);
  const press = async (wx: number, wy: number) => {
    const p = pt(wx, wy);
    await run.move(p.scene);
    run.press(true);
    engine.pointer(0, p.x, p.y, 0, 1, 0, 0.5, 1, 0, now());
    await run.wait(90);
    engine.pointer(2, p.x, p.y, 0, 0, 0, 0, 1, 0, now());
    run.press(false);
    await run.wait(220);
  };
  const drag = async (from: [number, number], to: [number, number], steps = 14) => {
    const a = pt(...from);
    await run.move(a.scene);
    run.press(true);
    engine.pointer(0, a.x, a.y, 0, 1, 0, 0.5, 1, 0, now());
    held = a;
    for (let i = 1; i <= steps; i++) {
      const p = pt(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
      engine.pointer(1, p.x, p.y, 0, 1, 0, 0.5, 1, 0, now());
      held = p;
      await run.move(p.scene, { ms: 28 });
    }
    const b = pt(...to);
    engine.pointer(2, b.x, b.y, 0, 0, 0, 0, 1, 0, now());
    held = null;
    run.press(false);
    await run.wait(260);
  };
  const keep = () => {
    for (const id of store.selection.refs) if (!made.includes(id) && !BUILT.has(id)) made.push(id);
  };

  try {
    engine.setSelection([]);
    await run.wait(500);
    // 1. The Pen: a corner, a curve, a corner — Enter
    await run.click(tool("Pen"));
    engine.setTool("PEN");
    await run.wait(300);
    // In the empty frame, or over the poster where a phone shows the poster alone (firstView)
    const sx = canvas.clientWidth < 560 ? POSTER.x + 280 : POSTER.x + POSTER.w + 48;
    await press(sx + 40, POSTER.y + 300);
    await drag([sx + 140, POSTER.y + 170], [sx + 200, POSTER.y + 170]);
    await press(sx + 240, POSTER.y + 300);
    engine.key("down", "Enter", "Enter", 0);
    engine.key("up", "Enter", "Enter", 0);
    keep();
    await run.wait(600);
    // Its stroke: blue and heavier, from the Stroke section
    const stroke = run.$('[data-paint="strokePaints"] input');
    if (stroke?.offsetParent) await run.click(stroke);
    const path = store.selection.refs;
    if (path.length) write(engine, path, { strokePaints: [{ type: "SOLID", color: hex(0x0d99ff), opacity: 1, visible: true }], strokeWeight: 4 }, "Stroke");
    await run.wait(900);
    // 2. A star, dragged out
    await run.click(tool("Star"));
    engine.setTool("STAR");
    await run.wait(250);
    await drag([sx + 104, POSTER.y + 40], [sx + 176, POSTER.y + 112], 12);
    keep();
    await run.wait(700);
    // 3. Its fill, typed in the Design panel
    const fill = run.$('[data-paint="fillPaints"] input');
    if (fill?.offsetParent) await run.click(fill);
    const star = store.selection.refs;
    if (star.length) write(engine, star, { fillPaints: [{ type: "SOLID", color: hex(0x9747ff), opacity: 1, visible: true }] }, "Fill");
    await run.wait(1500);
    run.hide();
    // 4. Undo it all
    for (let i = 0; i < 16 && made.some((id) => engine.readNode(id)); i++) {
      engine.command("UNDO");
      await run.wait(220);
    }
    engine.setSelection([]);
    await run.wait(600);
  } catch (e) {
    // Stopped mid-demo (scrolled away): finish what the demo had open and take its shapes back.
    cancelWrite(engine);
    const h = held as { x: number; y: number } | null;
    if (h) engine.pointer(2, h.x, h.y, 0, 0, 0, 0, 1, 0, now());
    keep();
    if (store.tool === "PEN") {
      engine.key("down", "Escape", "Escape", 0);
      engine.key("up", "Escape", "Escape", 0);
      keep();
    }
    if (store.tool !== "MOVE") engine.setTool("MOVE");
    for (let i = 0; i < 16 && made.some((id) => engine.readNode(id)); i++) engine.command("UNDO");
    throw e;
  }
}
