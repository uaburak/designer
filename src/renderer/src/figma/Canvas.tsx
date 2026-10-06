import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FigmaIcon } from "@/components/admin/figmaIcons";
import { DesignSystemStyle } from "@/components/project/designSystem";
import { MIN_ZOOM, clampZoom, fitView, zoomAround, type CanvasTool, type CanvasView, type ZoomActions } from "./view";
import { actionOf, findNode, getNode, isFrameLike, isLocked, numberOf, topmost, walk, type FigmaDocument, type FrameNode, type SceneNode } from "./model";
import { TRIGGER_SHORT } from "@/components/project/interactions";
import { Noodles, type Link } from "./Noodles";
import { fillsCss } from "./css";
import { MotionStyle, NodeView, PAGE_CSS, RenderProvider, type RenderContext } from "./NodeView";
import { descentOf, glyphLines, isComponentish, pathAt, pickFrom } from "./picking";
import { RULER, Rulers } from "./Rulers";

/**
 * Figma's canvas: endless, the file's nodes drawn on it at the view's pan and
 * zoom (a CSS transform — nothing is laid out again while it moves). Over
 * it, at the screen's scale, the lines: the selection's box and handles, the
 * hover outline, top-level frames' names, the size, the marquee, the smart
 * guides, the rulers.
 *
 * Picking, as Figma's: a click selects a top-level node — or, inside a
 * top-level frame, one of its direct children; inside the selection a click
 * goes one level deeper; ⌘ picks the innermost layer at once. Dragging a
 * selection moves it (into another frame, if it is let go there; along an
 * auto layout, it reorders); the handles size it; the tools draw into the
 * frame under the pointer; a drag on the empty canvas (or in a frame's empty
 * area) is a marquee.
 *
 * With `pageId` it is the Page Editor's view: that frame alone, drawn as the
 * site's page — at its own width, centred, scaled down only when the view is
 * narrower than it — and scrolled up and down like a page. Everything else
 * (picking, dragging, the handles, the menus) is the canvas's.
 */

export type Rect = { x: number; y: number; w: number; h: number };
type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const ALL_HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const HANDLE_CURSOR: Record<Handle, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };
const DRAW_TOOLS = new Set<CanvasTool>(["frame", "rectangle", "ellipse", "line", "text"]);

export interface CanvasProps {
  doc: FigmaDocument;
  render: RenderContext;
  selection: readonly string[];
  onSelect: (ids: string[]) => void;
  view: CanvasView;
  onView: (update: (view: CanvasView) => CanvasView) => void;
  tool: CanvasTool;
  /** Nodes moved: each to its new place in its parent (canvas px) */
  onMove: (moves: { id: string; x: number; y: number }[], copy?: boolean) => void;
  /** A node let go in another frame (null: on the canvas), at its place there — `index` inside an auto layout; `copy`: dragged with ⌥, the original stays */
  onReparent: (id: string, parentId: string | null, x: number, y: number, index?: number, copy?: boolean) => void;
  /** A node of an auto layout let go at another place in it */
  onReorder: (id: string, index: number) => void;
  /** A node sized: its rect in its parent now, and which axes changed */
  onResize: (id: string, rect: Rect, changed: { x: boolean; y: boolean }) => void;
  /** An auto layout frame's padding or gap changed from its handles on the canvas */
  onLayoutEdit?: (id: string, patch: Partial<FrameNode>) => void;
  /** A padding or gap field focused in the panel: its strips highlighted here */
  layoutFocus?: { pads?: PadSide[]; gap?: boolean } | null;
  /** (The tool is set by the editor's keys and toolbar.) */
  onTool?: (tool: CanvasTool) => void;
  /** Drawn with a tool into `parentId` (null: the canvas), at `rect` in it; `clicked`: no drag (a default size); `index`: its place in an auto layout's flow */
  onDraw: (tool: CanvasTool, parentId: string | null, rect: Rect, clicked: boolean, index?: number) => void;
  /** A double click: a text starts typing, a frame opens (the layer under the pointer) */
  onDoubleClick: (id: string) => void;
  onContextMenu: (id: string | null, e: React.MouseEvent) => void;
  /** The + under a selected component set (Figma's): a variant added to it */
  onAddVariant?: (setId: string) => void;
  /** The Prototype tab: the connections drawn (Figma's noodles), the selected layer's handle that makes one, the flows' starting points */
  prototyping?: boolean;
  /** A connection drawn from a layer to a frame (or to another variant of its set) */
  onConnect?: (sourceId: string, targetId: string) => void;
  /** A connection's end moved to another frame — or off any (null): the connection goes */
  onRetarget?: (sourceId: string, reactionId: string, targetId: string | null) => void;
  /** A connection clicked: its interaction opened (at the screen point) */
  onOpenReaction?: (sourceId: string, reactionId: string) => void;
  /** A flow's starting point's play button */
  onPlayFlow?: (frameId: string) => void;
  zoomActionsRef?: React.RefObject<ZoomActions | null>;
  rulers?: boolean;
  /** The canvas's own colour (Figma's page background) */
  background?: string;
  /** The Page Editor: only this frame (the site's page) is drawn, as a page that scrolls — no pan, no zoom of one's own */
  pageId?: string | null;
  /** The Page Editor's preview width (a tablet's, a phone's): the page drawn that wide, as the site lays it out there — its own when unset */
  previewWidth?: number | null;
  /** Hold the right button and drag to pan (a plain right click still opens the menu) */
  rightMousePan?: boolean;
  /** The horizontal wheel zooms around the pointer */
  horizontalScrollZoom?: boolean;
  /** …right out, left in */
  horizontalScrollZoomReversed?: boolean;
}

/** The room under the page's end in the Page Editor (the toolbar floats over it). */
const PAGE_END_ROOM = 96;
/** How far from its track's ends the page's scrollbar stays, and its least length. */
const SCROLL_INSET = 8;
const SCROLL_MIN = 40;

/**
 * The Page Editor's view: the page at its own width — 100%, or as much as
 * fits the view's width — centred, scrolled by `y`, never past its ends (a
 * page not measured yet keeps its scroll). `page`: its size in its own px.
 */
function pageViewOf(v: CanvasView, size: { width: number; height: number }, page: { width: number; height: number }): CanvasView {
  const zoom = page.width > 0 && size.width > 0 ? Math.min(1, size.width / page.width) : 1;
  const x = Math.max(0, Math.round((size.width - page.width * zoom) / 2));
  const least = page.height > 0 ? Math.min(0, size.height - page.height * zoom - PAGE_END_ROOM) : -Infinity;
  // The view's width changed the scale: what was at the top stays there.
  const from = v.zoom > 0 && v.zoom !== zoom ? v.y * (zoom / v.zoom) : v.y;
  const y = Math.min(0, Math.max(least, from));
  return v.zoom === zoom && v.x === x && v.y === y ? v : { zoom, x, y };
}

/** Figma's measurement red. */
const MEASURE = "#f24822";
/** Figma's pink: the gap handles between an auto layout's children. */
const GAP_COLOR = "#ff24bd";

type PadSide = "top" | "right" | "bottom" | "left";
/** What a layout handle stands for: one side's padding, or the gap between the children. */
type LayoutTarget = { kind: "pad"; side: PadSide } | { kind: "gap" };
const OPPOSITE: Record<PadSide, PadSide> = { top: "bottom", bottom: "top", left: "right", right: "left" };
const PAD_KEY: Record<PadSide, "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft"> = { top: "paddingTop", right: "paddingRight", bottom: "paddingBottom", left: "paddingLeft" };

/** Figma's ⌥ measurement: both boxes outlined in red, the gaps between them drawn as red lines with their distance (canvas px). */
function Measure({ a, b, zoom }: { a: Rect; b: Rect; zoom: number }) {
  const lines: { x: number; y: number; w: number; h: number; label: number }[] = [];
  // Along x: the gap between their nearer vertical edges, at the height where they overlap (or a's middle).
  const gapX = b.x >= a.x + a.w ? { from: a.x + a.w, to: b.x } : a.x >= b.x + b.w ? { from: b.x + b.w, to: a.x } : null;
  const gapY = b.y >= a.y + a.h ? { from: a.y + a.h, to: b.y } : a.y >= b.y + b.h ? { from: b.y + b.h, to: a.y } : null;
  const midY = Math.max(a.y, b.y) < Math.min(a.y + a.h, b.y + b.h) ? (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2 : b.y + b.h / 2;
  const midX = Math.max(a.x, b.x) < Math.min(a.x + a.w, b.x + b.w) ? (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2 : b.x + b.w / 2;
  if (gapX && gapX.to - gapX.from > 0.5) lines.push({ x: gapX.from, y: midY, w: gapX.to - gapX.from, h: 0, label: Math.round((gapX.to - gapX.from) / zoom) });
  if (gapY && gapY.to - gapY.from > 0.5) lines.push({ x: midX, y: gapY.from, w: 0, h: gapY.to - gapY.from, label: Math.round((gapY.to - gapY.from) / zoom) });
  return (
    <>
      <div aria-hidden className="pointer-events-none absolute border" style={{ left: b.x, top: b.y, width: b.w, height: b.h, borderColor: MEASURE }} />
      {lines.map((l, i) => (
        <div key={i} aria-hidden className="pointer-events-none absolute" style={{ left: l.x, top: l.y, width: l.w || 1, height: l.h || 1, background: MEASURE, transform: l.w ? "translateY(-0.5px)" : "translateX(-0.5px)" }}>
          <span className="absolute px-1 rounded-[3px] text-[11px] font-medium leading-4 text-white tabular-nums whitespace-nowrap" style={{ background: MEASURE, left: l.w ? l.w / 2 : 4, top: l.h ? l.h / 2 : 4, transform: l.w ? "translate(-50%, 0)" : "translate(0, -50%)" }}>
            {l.label}
          </span>
        </div>
      ))}
    </>
  );
}

/** The world's probe: a 1000px span whose drawn width is the zoom. */
const PROBE = 1000;

const rectOf = (el: Element, base: DOMRect): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
};

/** The world: the nodes at their places — memoized, so a pan or a zoom redraws nothing in it. */
const World = memo(function World({ doc, render }: { doc: FigmaDocument; render: RenderContext }) {
  return (
    <RenderProvider value={render}>
      {doc.nodes.map((node) => (
        <NodeView key={node.id} node={node} parentLayout="none" />
      ))}
    </RenderProvider>
  );
});

export function Canvas({ doc: file, render, selection, onSelect, view: given, onView, tool, onMove, onReparent, onReorder, onResize, onLayoutEdit, layoutFocus, onDraw, onDoubleClick, onContextMenu, onAddVariant, prototyping = false, onConnect, onRetarget, onOpenReaction, onPlayFlow, zoomActionsRef, rulers = true, background, pageId = null, previewWidth = null, rightMousePan = false, horizontalScrollZoom = false, horizontalScrollZoomReversed = false }: CanvasProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const paged = pageId !== null;
  const [space, setSpace] = useState(false);
  const [dragging, setDragging] = useState<"pan" | "move" | "resize" | "draw" | "marquee" | "layout" | null>(null);
  // The padding / gap handles: the one hovered, the one dragged (with its value, for the badge), the one typed into.
  const [layoutHover, setLayoutHover] = useState<LayoutTarget | null>(null);
  const [layoutDrag, setLayoutDrag] = useState<{ target: LayoutTarget; value: number; all: boolean; both: boolean } | null>(null);
  const [layoutEdit, setLayoutEdit] = useState<{ target: LayoutTarget; value: string } | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [drawRect, setDrawRect] = useState<Rect | null>(null);
  const [guides, setGuides] = useState<{ axis: "x" | "y"; at: number }[]>([]);
  // Where a dragged node would land: the frame's box (none for the canvas) and the line along an auto layout.
  const [drop, setDrop] = useState<{ rect: Rect | null; line?: Rect } | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  // The Page Editor: the page frame alone, at the canvas's origin, at its own width.
  const doc = useMemo<FigmaDocument>(() => {
    if (pageId === null) return file;
    const page = file.nodes.find((n) => n.id === pageId && isFrameLike(n));
    // (A preview width draws it that wide — the model's own width stays.)
    return { ...file, nodes: page ? [{ ...page, x: 0, y: 0, rotation: undefined, sizingH: undefined, ...(previewWidth ? { width: previewWidth } : {}) }] : [] };
  }, [file, pageId, previewWidth]);
  const pageNode = paged ? doc.nodes[0] ?? null : null;
  const pageWidth = pageNode?.width ?? 0;
  // Its height as drawn (measured with the lines, every frame).
  const [pageHeight, setPageHeight] = useState(0);
  const measuredHeight = useRef(0);
  const view = useMemo(() => (paged ? pageViewOf(given, size, { width: pageWidth, height: pageHeight }) : given), [paged, given, size, pageWidth, pageHeight]);
  // The editor's own copy of the view follows (it places what is pasted or put in with it).
  useEffect(() => {
    if (paged && view !== given) onView(() => view);
  }, [paged, view, given, onView]);
  const dims = useRef({ size, page: { width: pageWidth, height: pageHeight } });
  useEffect(() => {
    dims.current = { size, page: { width: pageWidth, height: pageHeight } };
  });
  /** The view changed from here: a page's stays a page's (its scale, centred, within its ends). */
  const setView = useCallback((update: (view: CanvasView) => CanvasView) => {
    onView(paged ? (v) => pageViewOf(update(v), dims.current.size, dims.current.page) : update);
  }, [onView, paged]);
  const [shown, setShown] = useState<{ boxes: Rect[]; hover: Rect | null; hoverPurple: boolean; hoverText: boolean; underlines: (Rect & { purple: boolean })[]; parent: Rect | null; labels: { id: string; name: string; rect: Rect; kind: string }[]; measure: { a: Rect; b: Rect } | null; origins: Rect[]; kids: Rect[]; links: Link[]; flows: { id: string; name: string; rect: Rect }[] }>({ boxes: [], hover: null, hoverPurple: false, hoverText: false, underlines: [], parent: null, labels: [], measure: null, origins: [], kids: [], links: [], flows: [] });

  const probe = useRef<HTMLSpanElement>(null);
  // ⌥ held: a copy drag's ghosts follow the pointer (the originals stay), and distances to what is hovered are measured in red, as Figma's.
  const [alt, setAlt] = useState(false);
  const altRef = useRef(false);
  useEffect(() => { altRef.current = alt; }, [alt]);
  // The selected layers' elements marked, for what only shows on a selected layer (a grid's cells).
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    w.querySelectorAll("[data-layer-selected]").forEach((el) => el.removeAttribute("data-layer-selected"));
    for (const id of selection) w.querySelector(`[data-node-id="${CSS.escape(id)}"]`)?.setAttribute("data-layer-selected", "");
  }, [selection, doc]);
  const ghosts = useRef<Map<string, HTMLElement>>(new Map());
  const [copying, setCopying] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Alt") setAlt(true); };
    const up = (e: KeyboardEvent) => { if (e.key === "Alt") setAlt(false); };
    const clear = () => setAlt(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", clear); };
  }, []);
  const hovered = useRef<HTMLElement | null>(null);
  const latest = useRef({ view, selection, tool, space, doc, dragging, pageId, prototyping });
  useEffect(() => {
    latest.current = { view, selection, tool, space, doc, dragging, pageId, prototyping };
  });

  // The viewport's size (the rulers, fitting).
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const r = viewport.current!.getBoundingClientRect();
    const { view: v } = latest.current;
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  }, []);
  /** An element's rect in canvas px. */
  const canvasRect = useCallback((el: Element): Rect => {
    const base = viewport.current!.getBoundingClientRect();
    const { view: v } = latest.current;
    const r = el.getBoundingClientRect();
    return { x: (r.left - base.left - v.x) / v.zoom, y: (r.top - base.top - v.y) / v.zoom, w: r.width / v.zoom, h: r.height / v.zoom };
  }, []);
  const elOf = useCallback((id: string) => world.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`) ?? null, []);
  /**
   * An element's rect in the world's own units (canvas px), read against the
   * world as it is drawn right now — its probe's width says the zoom — so the
   * lines over the canvas can be drawn from the same view as the world itself.
   */
  const worldRect = useCallback((el: Element | DOMRect): Rect => {
    const w = world.current!;
    const wr = w.getBoundingClientRect();
    const pw = probe.current?.getBoundingClientRect().width ?? 0;
    const z = pw > 0 ? pw / PROBE : latest.current.view.zoom;
    const r = el instanceof Element ? el.getBoundingClientRect() : el;
    return { x: (r.left - wr.left) / z, y: (r.top - wr.top) / z, w: r.width / z, h: r.height / z };
  }, []);

  // Crisp at rest: a GPU layer whose scale keeps changing is no longer re-rastered by Chrome — it blows the old bitmap up
  // (the canvas turns into one as soon as it holds an iframe, a backdrop blur…). While the zoom moves, the world is
  // marked as a moving layer (cheap, smooth); 150ms after it stops, the mark goes and Chrome draws it again at that scale.
  // The world stays scaled by transform all along — nothing is laid out again, nothing jumps.
  const zoomSettle = useRef<number | null>(null);
  const firstZoom = useRef(true);
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    if (firstZoom.current) { firstZoom.current = false; return; }
    w.style.willChange = "transform";
    if (zoomSettle.current !== null) window.clearTimeout(zoomSettle.current);
    zoomSettle.current = window.setTimeout(() => {
      zoomSettle.current = null;
      w.style.willChange = "";
    }, 150);
  }, [view.zoom]);
  useEffect(() => () => { if (zoomSettle.current !== null) window.clearTimeout(zoomSettle.current); }, []);

  // What the lines over the canvas follow may have moved: measured again on the next frame. (Set by every render, the pointer, the wheel,
  // the keys — and, at most every 250ms, for what moves on its own: a picture loading, a font arriving.)
  const remeasure = useRef(true);
  useEffect(() => {
    remeasure.current = true;
  });
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    const mark = () => { remeasure.current = true; };
    window.addEventListener("pointermove", mark, { passive: true });
    vp.addEventListener("wheel", mark, { passive: true });
    window.addEventListener("keydown", mark, { passive: true });
    window.addEventListener("pointerup", mark, { passive: true });
    return () => {
      window.removeEventListener("pointermove", mark);
      vp.removeEventListener("wheel", mark);
      window.removeEventListener("keydown", mark);
      window.removeEventListener("pointerup", mark);
    };
  }, []);
  // The lines over the canvas follow what they outline — measured in canvas units, so a pan or a zoom never leaves them behind.
  useEffect(() => {
    let raf = 0;
    let last = "";
    let measuredAt = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const vp = viewport.current;
      const w = world.current;
      if (!vp || !w) return;
      if (!remeasure.current && now - measuredAt < 250) return;
      remeasure.current = false;
      measuredAt = now;
      const { selection: sel, doc: d } = latest.current;
      const elFor = (id: string) => ghosts.current.get(id) ?? elOf(id);
      const boxes = sel.map((id) => elFor(id)).filter((el): el is HTMLElement => Boolean(el)).map((el) => worldRect(el));
      const over = hovered.current?.isConnected ? hovered.current : w.querySelector("[data-layer-hover]");
      const overId = (over as HTMLElement | null)?.dataset.nodeId ?? "";
      const hover = over && !sel.includes(overId) ? worldRect(over) : null;
      const hoverPurple = hover ? isComponentish(overId, d.nodes) : false;
      // Figma's text outline: a small line right under the glyphs of a hovered or selected text — one per line.
      const hoverText = !!hover && (over as HTMLElement).dataset.nodeType === "text";
      const underlines: (Rect & { purple: boolean })[] = [];
      const editingNow = document.querySelector("[data-editing]");
      const lined: { el: HTMLElement | null | undefined; purple: boolean }[] = [
        { el: hoverText ? (over as HTMLElement) : null, purple: hoverPurple },
        ...sel.map((id) => ({ el: elFor(id), purple: isComponentish(id, d.nodes) })),
      ];
      for (const { el, purple } of lined) {
        if (!el || el.dataset.nodeType !== "text" || el === editingNow || el.closest("[data-editing]")) continue;
        // On the baseline: the tails of a y or a g reach below it.
        const descent = descentOf(el);
        for (const r of glyphLines(el)) {
          const rect = worldRect(r);
          underlines.push({ x: rect.x, y: rect.y + rect.h - descent, w: rect.w, h: 0, purple });
        }
      }
      // Figma's red measurement: a copy drag measures the ghost against its original; ⌥ over another layer measures the selection against it.
      let measure: { a: Rect; b: Rect } | null = null;
      const ghost = sel.length === 1 ? ghosts.current.get(sel[0]) : undefined;
      const original = sel.length === 1 ? elOf(sel[0]) : null;
      if (ghost && original) measure = { a: worldRect(original), b: worldRect(ghost) };
      else if (altRef.current && hover && boxes.length === 1) measure = { a: boxes[0], b: hover };
      // A copy drag: the originals stay outlined in red too.
      const origins = [...ghosts.current.keys()].map((id) => elOf(id)).filter((el): el is HTMLElement => Boolean(el)).map((el) => worldRect(el));
      // The frame holding a single selected layer: outlined faintly.
      let parent: Rect | null = null;
      if (sel.length === 1) {
        const found = sel[0].includes("/") ? null : findNode(d.nodes, sel[0]);
        const pel = found?.parent ? elOf(found.parent.id) : null;
        if (pel) parent = worldRect(pel);
      }
      // (A page has no name over it: it starts at the view's top.)
      const labels = latest.current.pageId !== null ? [] : d.nodes.flatMap((n) => {
        const el = elOf(n.id);
        if (!el || !isFrameLike(n)) return [];
        return [{ id: n.id, name: n.name, rect: worldRect(el), kind: n.type }];
      });
      if (latest.current.pageId !== null) {
        // All that is drawn of it: what reaches past a fixed height too, unless it clips it.
        const pel = elOf(latest.current.pageId);
        const height = pel ? (pel.style.overflow === "hidden" ? pel.offsetHeight : Math.max(pel.offsetHeight, pel.scrollHeight)) : 0;
        if (height !== measuredHeight.current) {
          measuredHeight.current = height;
          setPageHeight(height);
        }
      }
      // A selected auto layout frame's children in its flow, for the gap handles between them.
      let kids: Rect[] = [];
      if (sel.length === 1 && !sel[0].includes("/")) {
        const n = getNode(d.nodes, sel[0]);
        if (n && isFrameLike(n) && n.layoutMode !== "none") {
          kids = n.children.filter((c) => c.visible !== false && !c.absolute).map((c) => elOf(c.id)).filter((el): el is HTMLElement => Boolean(el)).map((el) => worldRect(el));
        }
      }
      // The Prototype tab: every connection on the page (from its layer to its frame or variant), and where the flows start.
      const links: Link[] = [];
      const flows: { id: string; name: string; rect: Rect }[] = [];
      if (latest.current.prototyping) {
        walk(d.nodes, (n, parentNode) => {
          if (!parentNode && isFrameLike(n) && n.flowStart) {
            const el = elOf(n.id);
            if (el) flows.push({ id: n.id, name: n.flowStart, rect: worldRect(el) });
          }
          for (const r of n.reactions ?? []) {
            const action = actionOf(r);
            if (action !== "navigate" && action !== "change" && action !== "scroll") continue;
            const from = elOf(n.id);
            const to = r.target ? elOf(r.target) : null;
            if (!from || !to) continue;
            links.push({ source: n.id, id: r.id, from: worldRect(from), to: worldRect(to), change: action === "change", label: TRIGGER_SHORT[r.trigger] });
          }
        });
      }
      const next = { boxes, hover, hoverPurple, hoverText, underlines, parent, labels, measure, origins, kids, links, flows };
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      setShown(next);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [elOf, worldRect]);

  // The wheel moves the view; with ⌘ / Ctrl (a pinch) it zooms around the pointer.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    // A run of wheel events (less than 250ms apart): whether any of them moved vertically — a trackpad's two fingers always
    // wander up and down a little, a mouse's horizontal wheel is purely horizontal. Only a run that stayed horizontal is the mouse's:
    // its first 45ms are held back to be sure, then zoomed together (a trackpad's run pans, nothing zoomed before it showed itself).
    const run: { at: number; vertical: boolean; decided: "zoom" | "pan" | null; held: { dx: number; x: number; y: number; unit: number }[]; timer: number | null } = { at: 0, vertical: false, decided: null, held: [], timer: null };
    const zoomBy = (dx: number, x: number, y: number, unit: number) => {
      const factor = Math.exp((horizontalScrollZoomReversed ? -dx : dx) * unit);
      setView((v) => zoomAround(v, v.zoom * factor, { x, y }));
    };
    /** The held events given up as a pan (what they were: a trackpad's start). */
    const panHeld = () => {
      const dx = run.held.reduce((sum, h) => sum + h.dx, 0);
      run.held = [];
      if (dx) setView((v) => ({ ...v, x: v.x - dx }));
    };
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest("[role=menu]")) return;
      e.preventDefault();
      const now = e.timeStamp;
      if (now - run.at > 250) {
        if (run.timer !== null) window.clearTimeout(run.timer);
        run.timer = null;
        run.held = [];
        run.vertical = false;
        run.decided = null;
      }
      run.at = now;
      if (e.deltaY !== 0 && !run.vertical) {
        run.vertical = true;
        run.decided = "pan";
        if (run.timer !== null) { window.clearTimeout(run.timer); run.timer = null; }
        panHeld();
      }
      const r = el.getBoundingClientRect();
      if (paged) {
        // A page scrolls up and down; a pinch zooms nothing.
        if (e.ctrlKey || e.metaKey) return;
        const by = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        setView((v) => ({ ...v, y: v.y - by }));
      } else if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01));
        setView((v) => zoomAround(v, v.zoom * factor, { x: e.clientX - r.left, y: e.clientY - r.top }));
      } else if (horizontalScrollZoom && !e.shiftKey && e.deltaX !== 0 && e.deltaY === 0 && run.decided !== "pan" && e.deltaMode !== 2) {
        const hit = { dx: e.deltaX, x: e.clientX - r.left, y: e.clientY - r.top, unit: e.deltaMode === 1 ? 0.05 : 0.01 };
        if (run.decided === "zoom") return zoomBy(hit.dx, hit.x, hit.y, hit.unit);
        run.held.push(hit);
        if (run.timer === null) {
          run.timer = window.setTimeout(() => {
            run.timer = null;
            if (run.vertical) return panHeld();
            run.decided = "zoom";
            run.held.splice(0).forEach((h) => zoomBy(h.dx, h.x, h.y, h.unit));
          }, 45);
        }
      } else {
        const sideways = e.shiftKey && !e.deltaX;
        setView((v) => ({ ...v, x: v.x - (sideways ? e.deltaY : e.deltaX), y: v.y - (sideways ? 0 : e.deltaY) }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setView, paged, horizontalScrollZoom, horizontalScrollZoomReversed]);

  // A page's keys: Page Up / Down, Home, End.
  useEffect(() => {
    if (!paged) return;
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector("[role=menu], [role=dialog]")) return;
      const step = Math.max(80, dims.current.size.height - 80);
      const to = e.key === "PageDown" ? (y: number) => y - step : e.key === "PageUp" ? (y: number) => y + step : e.key === "Home" ? () => 0 : e.key === "End" ? () => -Infinity : null;
      if (!to) return;
      e.preventDefault();
      setView((v) => ({ ...v, y: to(v.y) }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paged, setView]);

  // ── Zoom actions, for the chrome and the keys ──
  const boundsOf = useCallback((els: Element[]): Rect | null => {
    if (!els.length) return null;
    const rects = els.map((el) => canvasRect(el));
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    const right = Math.max(...rects.map((r) => r.x + r.w));
    const bottom = Math.max(...rects.map((r) => r.y + r.h));
    return { x, y, w: right - x, h: bottom - y };
  }, [canvasRect]);
  const zoomActions = useMemo<ZoomActions>(() => ({
    zoomTo: (zoom) => {
      if (!paged) setView((v) => zoomAround(v, clampZoom(zoom), { x: size.width / 2, y: size.height / 2 }));
    },
    fitAll: () => {
      // A page: back to its top.
      if (paged) return setView((v) => ({ ...v, y: 0 }));
      // The layers drawn — not what else the world holds (the zoom probe, a 1000px span at the origin; styles), which would widen the bounds.
      const bounds = boundsOf(Array.from(world.current?.children ?? []).filter((el) => el.hasAttribute("data-node-id")));
      if (bounds) setView(() => fitView(bounds, size.width, size.height));
    },
    fitSelection: () => {
      const els = latest.current.selection.map((id) => elOf(id)).filter((el): el is HTMLElement => Boolean(el));
      const bounds = boundsOf(els);
      if (paged) {
        // A page: scrolled to it — nothing moves when it is all in sight; what is taller than the view starts near its top.
        if (!bounds) return;
        const room = size.height - PAGE_END_ROOM;
        setView((v) => {
          const top = bounds.y * v.zoom + v.y;
          const tall = bounds.h * v.zoom;
          if (top >= 0 && top + tall <= room) return v;
          return { ...v, y: (tall > room - 48 ? 24 : (room - tall) / 2) - bounds.y * v.zoom };
        });
        return;
      }
      if (bounds) setView(() => fitView(bounds, size.width, size.height, false));
      else zoomActions.fitAll();
    },
  }), [setView, paged, size, boundsOf, elOf]);
  useEffect(() => {
    if (zoomActionsRef) zoomActionsRef.current = zoomActions;
    return () => { if (zoomActionsRef) zoomActionsRef.current = null; };
  }, [zoomActions, zoomActionsRef]);

  // Space held: the hand.
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement as HTMLElement | null;
      return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
    };
    const down = (e: KeyboardEvent) => { if (e.key === " " && !typing() && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setSpace(true); } };
    const up = (e: KeyboardEvent) => { if (e.key === " ") setSpace(false); };
    const blur = () => setSpace(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, []);

  /**
   * Follows the pointer until it lets go, then `end` — also when the press is
   * lost (the system took the pointer, the window lost the focus) or Esc is
   * pressed: the drag ends where it was, nothing stays stuck to the pointer.
   */
  const follow = (kind: NonNullable<typeof dragging>, move: (e: PointerEvent) => void, end: (e: PointerEvent) => void) => {
    setDragging(kind);
    let last: PointerEvent | null = null;
    const onMovePointer = (e: PointerEvent) => {
      last = e;
      move(e);
    };
    const stop = (e: PointerEvent | null) => {
      window.removeEventListener("pointermove", onMovePointer);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onKey, true);
      setDragging(null);
      end(e ?? last ?? new PointerEvent("pointerup"));
    };
    const onUp = (e: PointerEvent) => stop(e);
    const onCancel = () => stop(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      stop(null);
    };
    window.addEventListener("pointermove", onMovePointer);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onKey, true);
  };

  /**
   * An element's own box in canvas px — its place and size as laid out, before
   * its rotation and flip (they turn it around its centre): the centre of
   * what is drawn, its own width and height.
   */
  const ownBox = useCallback((el: HTMLElement): Rect => {
    const r = canvasRect(el);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
  }, [canvasRect]);

  const startPan = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, view: latest.current.view };
    follow("pan", (ev) => setView(() => ({ ...start.view, x: start.view.x + ev.clientX - start.x, y: start.view.y + ev.clientY - start.y })), () => {});
  };

  /**
   * The right button held and dragged pans (past 4px); let go without moving,
   * it is a right click: its menu opens. The menu is held back while the
   * button is down — some systems ask for it on the press — and not opened
   * after a pan, whenever they ask.
   */
  const rightPress = useRef<{ down: boolean; panned: boolean; held: { id: string | null; e: React.MouseEvent } | null; quiet: boolean }>({ down: false, panned: false, held: null, quiet: false });
  const startRightPan = (e: React.PointerEvent) => {
    const press = rightPress.current;
    press.down = true;
    press.panned = false;
    press.held = null;
    const start = { x: e.clientX, y: e.clientY, view: latest.current.view };
    const onMovePointer = (ev: PointerEvent) => {
      if (!press.panned && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      if (!press.panned) { press.panned = true; setDragging("pan"); }
      setView(() => ({ ...start.view, x: start.view.x + ev.clientX - start.x, y: start.view.y + ev.clientY - start.y }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMovePointer);
      window.removeEventListener("pointerup", onUp);
      press.down = false;
      if (press.panned) {
        setDragging(null);
        // The system's menu request may come after the release: it is not to open one.
        press.quiet = true;
        window.setTimeout(() => { press.quiet = false; }, 150);
      } else if (press.held) {
        // Not a pan: the menu that was held back opens now.
        onContextMenu(press.held.id, press.held.e);
      }
      press.held = null;
    };
    window.addEventListener("pointermove", onMovePointer);
    window.addEventListener("pointerup", onUp);
  };

  /** The other top-level nodes' edges and centers (canvas px), to snap a lone move to. */
  const snapTargets = (excluded: Set<string>) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const n of latest.current.doc.nodes) {
      if (excluded.has(n.id)) continue;
      const el = elOf(n.id);
      if (!el) continue;
      const r = canvasRect(el);
      xs.push(r.x, r.x + r.w / 2, r.x + r.w);
      ys.push(r.y, r.y + r.h / 2, r.y + r.h);
    }
    return { xs, ys };
  };

  /** The frame under the pointer that could take a dropped node — none of `excluded` or what is inside them. */
  const frameUnder = (clientX: number, clientY: number, excluded: Set<string>): { id: string | null; el: HTMLElement | null } => {
    const w = world.current!;
    // Off every frame: the canvas — or, in the Page Editor, the page itself (there is nothing beside it to put a layer on).
    const root = latest.current.pageId;
    const rootEl = root !== null && !excluded.has(root) ? elOf(root) : null;
    const none = rootEl ? { id: root, el: rootEl } : { id: null, el: null };
    const els = document.elementsFromPoint(clientX, clientY);
    for (const el of els) {
      const node = (el as HTMLElement).closest?.<HTMLElement>("[data-node-id]");
      if (!node || !w.contains(node)) continue;
      // Every frame from it up: the innermost one that isn't excluded.
      let cur: HTMLElement | null = node;
      while (cur && w.contains(cur)) {
        const id = cur.dataset.nodeId!;
        const model = id.includes("/") ? null : getNode(latest.current.doc.nodes, id);
        const inside = pathAt(cur, w, latest.current.doc).some((p) => excluded.has(p.id));
        if (model && (model.type === "frame" || model.type === "component") && !inside && !isLocked(latest.current.doc.nodes, id)) return { id, el: cur };
        cur = cur.parentElement?.closest<HTMLElement>("[data-node-id]") ?? null;
      }
      return none;
    }
    return none;
  };

  /** Where, among an auto layout frame's children, a point lands. */
  const indexIn = (frameEl: HTMLElement, frameId: string, clientX: number, clientY: number, excluded: Set<string>): number => {
    const frame = getNode(latest.current.doc.nodes, frameId);
    if (!frame || !isFrameLike(frame) || frame.layoutMode === "none") return -1;
    const horizontal = frame.layoutMode === "horizontal";
    const kids = frame.children.filter((c) => !excluded.has(c.id));
    let index = kids.length;
    for (let i = 0; i < kids.length; i++) {
      const el = frameEl.querySelector<HTMLElement>(`:scope > [data-node-id="${CSS.escape(kids[i].id)}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const mid = horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
      if ((horizontal ? clientX : clientY) < mid) { index = i; break; }
    }
    return index;
  };

  const startMove = (e: React.PointerEvent, primaryId: string) => {
    const { doc: d, selection: sel } = latest.current;
    const ids = sel.includes(primaryId) ? sel : [primaryId];
    const tops = topmost(d.nodes, ids.filter((id) => !id.includes("/")));
    // (The Page Editor's page stays where it is; a locked layer too.)
    if (!tops.length || tops.some((t) => t.node.id === latest.current.pageId || isLocked(d.nodes, t.node.id))) return;
    const excluded = new Set(tops.map((t) => t.node.id));
    const els = tops.map((t) => ({ found: t, el: elOf(t.node.id)! })).filter((t) => t.el);
    const start = { x: e.clientX, y: e.clientY };
    // ⌥, at any moment of the drag: a ghost of each layer follows the pointer and the layer itself stays (Figma's copy drag); let go of ⌥ and the layer moves again.
    let copy = false;
    let ghostEls: HTMLElement[] = [];
    const originals = els.map(({ el }) => el);
    let delta: { dx: number; dy: number } | null = null;
    const place = (list: HTMLElement[]) => {
      for (const el of list) {
        el.style.translate = delta ? `${delta.dx}px ${delta.dy}px` : "";
        el.style.pointerEvents = delta ? "none" : "";
        el.style.zIndex = delta ? "1000" : "";
      }
    };
    const rest = (list: HTMLElement[]) => { for (const el of list) { el.style.translate = ""; el.style.pointerEvents = ""; el.style.zIndex = ""; } };
    const setCopy = (on: boolean) => {
      if (on === copy) return;
      copy = on;
      setCopying(on);
      if (on) {
        rest(originals);
        ghostEls = els.map(({ found, el }) => {
          const ghost = el.cloneNode(true) as HTMLElement;
          ghost.dataset.dragClone = found.node.id;
          ghost.style.position = "absolute";
          ghost.style.left = `${el.offsetLeft}px`;
          ghost.style.top = `${el.offsetTop}px`;
          ghost.style.width = `${el.offsetWidth}px`;
          ghost.style.height = `${el.offsetHeight}px`;
          ghost.style.margin = "0";
          ghost.style.flex = "none";
          el.after(ghost);
          ghosts.current.set(found.node.id, ghost);
          return ghost;
        });
        place(ghostEls);
      } else {
        ghostEls.forEach((g) => g.remove());
        ghostEls = [];
        ghosts.current.clear();
        place(originals);
      }
    };
    const onAlt = (ev: KeyboardEvent) => { if (ev.key === "Alt") setCopy(ev.type === "keydown"); };
    window.addEventListener("keydown", onAlt);
    window.addEventListener("keyup", onAlt);
    if (e.altKey) setCopy(true);
    const single = els.length === 1 ? els[0] : null;
    const snap = single ? snapTargets(excluded) : null;
    const singleRect = single ? canvasRect(single.el) : null;
    let target: { id: string | null; el: HTMLElement | null } | null = null;
    follow(
      "move",
      (ev) => {
        const zoom = latest.current.view.zoom;
        if (!delta && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
        let dx = (ev.clientX - start.x) / zoom;
        let dy = (ev.clientY - start.y) / zoom;
        const nextGuides: { axis: "x" | "y"; at: number }[] = [];
        if (snap && singleRect && !ev.altKey) {
          const threshold = 6 / zoom;
          const rx = singleRect.x + dx;
          const ry = singleRect.y + dy;
          let bestX: { diff: number; at: number } | null = null;
          for (const edge of [rx, rx + singleRect.w / 2, rx + singleRect.w])
            for (const at of snap.xs) {
              const diff = at - edge;
              if (Math.abs(diff) <= threshold && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) bestX = { diff, at };
            }
          if (bestX) { dx += bestX.diff; nextGuides.push({ axis: "x", at: bestX.at }); }
          let bestY: { diff: number; at: number } | null = null;
          for (const edge of [ry, ry + singleRect.h / 2, ry + singleRect.h])
            for (const at of snap.ys) {
              const diff = at - edge;
              if (Math.abs(diff) <= threshold && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) bestY = { diff, at };
            }
          if (bestY) { dy += bestY.diff; nextGuides.push({ axis: "y", at: bestY.at }); }
        }
        if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        delta = { dx: Math.round(dx), dy: Math.round(dy) };
        setGuides(nextGuides);
        setCopy(ev.altKey);
        place(copy ? ghostEls : originals);
        // Where it would land: the frame under the pointer, and its place along an auto layout.
        if (single) {
          target = frameUnder(ev.clientX, ev.clientY, excluded);
          const parentId = single.found.parent?.id ?? null;
          if (target.id && target.el) {
            const index = indexIn(target.el, target.id, ev.clientX, ev.clientY, excluded);
            const frame = getNode(latest.current.doc.nodes, target.id);
            const base = viewport.current!.getBoundingClientRect();
            let line: Rect | undefined;
            if (frame && isFrameLike(frame) && frame.layoutMode !== "none") {
              const kids = frame.children.filter((c) => !excluded.has(c.id));
              const horizontal = frame.layoutMode === "horizontal";
              const at = kids[index] ? target.el.querySelector<HTMLElement>(`:scope > [data-node-id="${CSS.escape(kids[index].id)}"]`) : null;
              const before = kids[index - 1] ? target.el.querySelector<HTMLElement>(`:scope > [data-node-id="${CSS.escape(kids[index - 1].id)}"]`) : null;
              const ref = at ?? before;
              if (ref) {
                const r = rectOf(ref, base);
                line = horizontal ? { x: at ? r.x - 2 : r.x + r.w, y: r.y, w: 2, h: r.h } : { x: r.x, y: at ? r.y - 2 : r.y + r.h, w: r.w, h: 2 };
              }
            }
            setDrop(target.id !== parentId || line ? { rect: rectOf(target.el, base), line } : null);
          } else setDrop(parentId ? { rect: null } : null);
        }
      },
      (ev) => {
        setGuides([]);
        setDrop(null);
        window.removeEventListener("keydown", onAlt);
        window.removeEventListener("keyup", onAlt);
        ghostEls.forEach((g) => g.remove());
        ghostEls = [];
        ghosts.current.clear();
        setCopying(false);
        rest(originals);
        if (!delta) return;
        const d2 = latest.current.doc;
        if (single && target) {
          const found = findNode(d2.nodes, single.found.node.id);
          if (!found) return;
          const parentId = found.parent?.id ?? null;
          const targetFrame = target.id ? getNode(d2.nodes, target.id) : null;
          const targetAuto = targetFrame && isFrameLike(targetFrame) && targetFrame.layoutMode !== "none";
          // Its own box (a rotated layer's too: not the bounds of what is drawn), moved.
          const rect = ownBox(single.el);
          const moved = { x: rect.x + delta.dx, y: rect.y + delta.dy };
          if (target.id === parentId) {
            if (targetAuto && target.el && isFrameLike(targetFrame)) {
              const index = indexIn(target.el, target.id!, ev.clientX, ev.clientY, excluded);
              if (!copy) return onReorder(found.node.id, index);
              // The layer stays: the copy's place among all its siblings (the place found leaves the layer out).
              const kids = targetFrame.children.filter((c) => !excluded.has(c.id));
              const at = index < kids.length ? targetFrame.children.findIndex((c) => c.id === kids[index].id) : targetFrame.children.length;
              return onReparent(found.node.id, target.id, 0, 0, at, true);
            }
            // In the same parent: its own place, moved (exact, whatever the parent's turn).
            return onMove([{ id: found.node.id, x: Math.round(found.node.x + delta.dx), y: Math.round(found.node.y + delta.dy) }], copy);
          }
          const origin = target.el ? ownBox(target.el) : { x: 0, y: 0 };
          const index = targetAuto && target.el ? indexIn(target.el, target.id!, ev.clientX, ev.clientY, excluded) : undefined;
          return onReparent(found.node.id, target.id, Math.round(moved.x - origin.x), Math.round(moved.y - origin.y), index, copy);
        }
        // Each in its own parent: its own place, moved.
        onMove(
          els.map(({ found }) => ({ id: found.node.id, x: Math.round(found.node.x + delta!.dx), y: Math.round(found.node.y + delta!.dy) })),
          copy
        );
      }
    );
  };

  const startResize = (e: React.PointerEvent, handle: Handle) => {
    e.preventDefault();
    e.stopPropagation();
    const id = latest.current.selection[0];
    const el = id ? elOf(id) : null;
    const found = id ? findNode(latest.current.doc.nodes, id) : null;
    if (!id || !el || !found) return;
    // Its own box (before its turn) and the turn: the pointer's move is read along its own sides, so a rotated layer grows along them.
    const from = ownBox(el);
    const turn = ((found.node.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const flip = { x: found.node.flipH ? -1 : 1, y: found.node.flipV ? -1 : 1 };
    const parentEl = found.parent ? elOf(found.parent.id) : null;
    const origin = parentEl ? ownBox(parentEl) : { x: 0, y: 0 };
    const start = { x: e.clientX, y: e.clientY };
    const changed = { x: handle.includes("e") || handle.includes("w"), y: handle.includes("n") || handle.includes("s") };
    const ratio = from.w > 0 && from.h > 0 ? from.w / from.h : 1;
    const inAuto = Boolean(found.parent && found.parent.layoutMode !== "none" && !found.node.absolute);
    // The drag is previewed on the element (its size and place written on it) and given to the model once, on release:
    // every model change draws the whole file again. What was written on it is put back before (React sets the rest).
    const saved = { width: el.style.width, height: el.style.height, left: el.style.left, top: el.style.top, flex: el.style.flex, maxWidth: el.style.maxWidth, maxHeight: el.style.maxHeight, minWidth: el.style.minWidth, minHeight: el.style.minHeight };
    let result: { rect: Rect } | null = null;
    follow(
      "resize",
      (ev) => {
        const zoom = latest.current.view.zoom;
        const sx = (ev.clientX - start.x) / zoom;
        const sy = (ev.clientY - start.y) / zoom;
        // Along its own sides (its turn undone, a flipped side mirrored).
        const dx = (sx * cos + sy * sin) * flip.x;
        const dy = (-sx * sin + sy * cos) * flip.y;
        const centred = ev.altKey;
        const k = centred ? 2 : 1;
        let w = from.w;
        let h = from.h;
        if (handle.includes("e")) w = from.w + k * dx;
        if (handle.includes("w")) w = from.w - k * dx;
        if (handle.includes("s")) h = from.h + k * dy;
        if (handle.includes("n")) h = from.h - k * dy;
        // ⇧ on a corner, or the node's own constrained proportions: W and H change together.
        if ((ev.shiftKey && changed.x && changed.y) || found.node.lockAspect) {
          if (changed.x) h = w / ratio;
          else w = h * ratio;
        }
        w = Math.max(1, Math.round(w));
        h = Math.max(found.node.type === "line" ? 0 : 1, Math.round(h));
        // The side across from the handle stays where it is (the centre, with ⌥): the centre moves by half the growth, along its sides.
        const gx = centred ? 0 : ((w - from.w) / 2) * (handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0) * flip.x;
        const gy = centred ? 0 : ((h - from.h) / 2) * (handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0) * flip.y;
        const cx = from.x + from.w / 2 + gx * cos - gy * sin;
        const cy = from.y + from.h / 2 + gx * sin + gy * cos;
        const rect = { x: Math.round(cx - w / 2 - origin.x), y: Math.round(cy - h / 2 - origin.y), w, h };
        result = { rect };
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.style.flex = "none";
        el.style.maxWidth = el.style.maxHeight = el.style.minWidth = el.style.minHeight = "none";
        if (!inAuto) {
          el.style.left = `${rect.x}px`;
          el.style.top = `${rect.y}px`;
        }
      },
      () => {
        Object.assign(el.style, saved);
        if (result) onResize(id, result.rect, changed);
      }
    );
  };

  const startDraw = (e: React.PointerEvent) => {
    e.preventDefault();
    const drawing = latest.current.tool;
    const start = toCanvas(e.clientX, e.clientY);
    const under = frameUnder(e.clientX, e.clientY, new Set());
    const origin = under.el ? canvasRect(under.el) : { x: 0, y: 0 };
    let rect: Rect = { x: start.x, y: start.y, w: 0, h: 0 };
    // A line: from where it was pressed to the pointer (its direction kept — ⇧: by 45°).
    let vec = { dx: 0, dy: 0 };
    follow(
      "draw",
      (ev) => {
        const at = toCanvas(ev.clientX, ev.clientY);
        let w = at.x - start.x;
        let h = at.y - start.y;
        if (drawing === "line") {
          if (ev.shiftKey) {
            const length = Math.hypot(w, h);
            const angle = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4);
            w = Math.cos(angle) * length;
            h = Math.sin(angle) * length;
          }
          vec = { dx: w, dy: h };
        } else if (ev.shiftKey) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
        rect = { x: Math.min(start.x, start.x + w), y: Math.min(start.y, start.y + h), w: Math.abs(w), h: Math.abs(h) };
        setDrawRect(rect);
      },
      () => {
        setDrawRect(null);
        const zoom = latest.current.view.zoom;
        const clicked = rect.w * zoom < 3 && rect.h * zoom < 3;
        // Into an auto layout: at the pointer's place in its flow (Figma's), not at its end.
        const index = under.id && under.el ? (() => { const i = indexIn(under.el, under.id, e.clientX, e.clientY, new Set()); return i >= 0 ? i : undefined; })() : undefined;
        if (drawing === "line" && !clicked) {
          // Its start and its vector (signed): the editor turns it into a line of that length at that angle.
          return onDraw(drawing, under.id, { x: Math.round(start.x - origin.x), y: Math.round(start.y - origin.y), w: Math.round(vec.dx), h: Math.round(vec.dy) }, false, index);
        }
        const r = clicked ? { x: start.x, y: start.y, w: 100, h: 100 } : rect;
        onDraw(drawing, under.id, { x: Math.round(r.x - origin.x), y: Math.round(r.y - origin.y), w: Math.max(1, Math.round(r.w)), h: Math.max(drawing === "line" ? 0 : 1, Math.round(r.h)) }, clicked, index);
      }
    );
  };

  /** A drag on the empty canvas, or in a frame's empty area: what it lands on (the frame's direct children there) is the selection. */
  const startMarquee = (e: React.PointerEvent, within: { id: string; el: HTMLElement } | null) => {
    const start = toCanvas(e.clientX, e.clientY);
    let box: Rect = { x: start.x, y: start.y, w: 0, h: 0 };
    const additive = e.shiftKey;
    const before = latest.current.selection;
    // What the box takes, as Figma's: a layer it touches — whole, it is selected; a frame it only crosses opens up, its layers inside are taken instead.
    // (Only the canvas's top-level frames open up, as in Figma; a frame inside one is taken whole when the box touches it.)
    const hitsIn = (list: SceneNode[], topLevel: boolean): string[] =>
      list.flatMap((n) => {
        if (n.locked || n.visible === false) return [];
        const el = elOf(n.id);
        if (!el) return [];
        const r = canvasRect(el);
        const touches = r.x < box.x + box.w && r.x + r.w > box.x && r.y < box.y + box.h && r.y + r.h > box.y;
        if (!touches) return [];
        const whole = r.x >= box.x && r.y >= box.y && r.x + r.w <= box.x + box.w && r.y + r.h <= box.y + box.h;
        const container = topLevel && isFrameLike(n) && n.type !== "instance" && n.children.length > 0;
        if (whole || !container) return [n.id];
        return hitsIn(n.children, false);
      });
    let lastHits = "";
    const select = (hits: string[]) => onSelect(additive ? Array.from(new Set([...before, ...hits])) : hits);
    follow(
      "marquee",
      (ev) => {
        const at = toCanvas(ev.clientX, ev.clientY);
        box = { x: Math.min(start.x, at.x), y: Math.min(start.y, at.y), w: Math.abs(at.x - start.x), h: Math.abs(at.y - start.y) };
        setMarquee(box);
        // Selected as the box grows, not only when it is let go.
        if (box.w < 2 && box.h < 2) return;
        const d = latest.current.doc;
        const candidates: SceneNode[] = within ? (getNode(d.nodes, within.id) as { children?: SceneNode[] } | null)?.children ?? [] : d.nodes;
        const hits = hitsIn(candidates, !within);
        const key = hits.join(",");
        if (key !== lastHits) { lastHits = key; select(hits); }
      },
      () => {
        setMarquee(null);
        if (box.w < 2 && box.h < 2) {
          // A click: the frame itself, or nothing.
          if (within) onSelect(additive ? [...before, within.id] : [within.id]);
          else if (!additive) onSelect([]);
          return;
        }
        const d = latest.current.doc;
        const candidates: SceneNode[] = within ? (getNode(d.nodes, within.id) as { children?: SceneNode[] } | null)?.children ?? [] : d.nodes;
        select(hitsIn(candidates, !within));
      }
    );
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as Element;
    if (target.closest("[data-editing], [data-canvas-ui]")) return;
    const { tool: current, space: hand, doc: d, selection: sel } = latest.current;
    if (e.button === 1 || (e.button === 0 && (hand || current === "hand"))) return startPan(e);
    if (e.button === 2 && rightMousePan && !paged) return startRightPan(e);
    if (e.button !== 0) return;
    if (DRAW_TOOLS.has(current)) return startDraw(e);
    const path = pathAt(target, world.current!, d, { x: e.clientX, y: e.clientY });
    const picked = pickFrom(path, sel, e.metaKey || e.ctrlKey, world.current);
    // The empty canvas, or a top-level frame's own area (not one of its children): a marquee — a click selects the frame.
    const hit = target.closest<HTMLElement>("[data-node-id]");
    const onTopFrame = path.length === 1 && (hit === path[0].el || (hit?.dataset.nodeType === "text" && hit.parentElement?.closest("[data-node-id]") === path[0].el)) && !sel.includes(path[0].id) && !e.metaKey && !e.ctrlKey;
    if (!picked || onTopFrame) return startMarquee(e, onTopFrame ? path[0] : null);
    if (e.shiftKey) {
      onSelect(sel.includes(picked.id) ? sel.filter((id) => id !== picked.id) : [...sel, picked.id]);
      return;
    }
    // The Page Editor's page, already selected: a drag on it is a marquee over its layers (it can't be moved).
    if (picked.id === latest.current.pageId) return startMarquee(e, picked);
    if (!sel.includes(picked.id)) onSelect([picked.id]);
    if (!picked.id.includes("/")) startMove(e, picked.id);
  };

  const onDoubleClickCanvas = (e: React.MouseEvent) => {
    const target = e.target as Element;
    if (target.closest("[data-editing], [data-canvas-ui]")) return;
    const { doc: d, selection: sel } = latest.current;
    const path = pathAt(target, world.current!, d, { x: e.clientX, y: e.clientY });
    if (!path.length) return;
    // Each press already went one level down (pickFrom): the double click acts on what its second press picked —
    // it never goes a level further, or that level would be skipped.
    const at = [...path].reverse().find((p) => sel.includes(p.id)) ?? pickFrom(path, sel, false, world.current);
    if (at) onDoubleClick(at.id);
  };

  /** A top-level frame's name over it: a press selects it — and a drag moves it. */
  const labelDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.shiftKey) {
      const sel = latest.current.selection;
      onSelect(sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]);
      return;
    }
    if (!latest.current.selection.includes(id)) onSelect([id]);
    // A locked frame: picked, not moved.
    if (!getNode(latest.current.doc.nodes, id)?.locked) startMove(e, id);
  };

  // The lines, at the screen's scale — from the same view the world is drawn with.
  const S = (r: Rect): Rect => ({ x: view.x + r.x * view.zoom, y: view.y + r.y * view.zoom, w: r.w * view.zoom, h: r.h * view.zoom });
  /**
   * What a connection from `sourceId` goes to under the pointer, as Figma's:
   * inside a component set, another of its variants (Change to); else a
   * top-level frame other than its own (Navigate to). Its box on the screen.
   */
  const linkTarget = (clientX: number, clientY: number, sourceId: string): { id: string; rect: Rect } | null => {
    const w = world.current;
    const { doc: d, view: v } = latest.current;
    if (!w) return null;
    const onScreen = (el: Element): Rect => { const r = worldRect(el); return { x: v.x + r.x * v.zoom, y: v.y + r.y * v.zoom, w: r.w * v.zoom, h: r.h * v.zoom }; };
    const hit = document.elementsFromPoint(clientX, clientY).find((el): el is HTMLElement => el instanceof HTMLElement && Boolean(el.dataset.nodeId) && w.contains(el));
    if (!hit) return null;
    const source = findNode(d.nodes, sourceId.split("/")[0]);
    const set = source?.path.map((id) => getNode(d.nodes, id)).find((n): n is FrameNode => n?.type === "componentSet") ?? null;
    if (set) {
      for (let el: HTMLElement | null = hit; el && w.contains(el); el = el.parentElement?.closest<HTMLElement>("[data-node-id]") ?? null) {
        const id = el.dataset.nodeId!;
        if (set.children.some((c) => c.id === id)) return { id, rect: onScreen(el) };
      }
    }
    const top = findNode(d.nodes, hit.dataset.nodeId!.split("/")[0])?.path[0];
    if (!top || top === source?.path[0]) return null;
    const node = getNode(d.nodes, top);
    const el = elOf(top);
    return node && isFrameLike(node) && node.type !== "componentSet" && el ? { id: top, rect: onScreen(el) } : null;
  };
  const boxes = shown.boxes.map(S);
  const hoverBox = shown.hover ? S(shown.hover) : null;
  // A hovered text is drawn as its underline only (Figma's), not as a box.
  const hoverIsText = shown.hoverText;
  const parentBox = shown.parent ? S(shown.parent) : null;
  const box = boxes.length === 1 ? boxes[0] : null;
  const selectedSetNode = selection.length === 1 && !selection[0].includes("/") ? getNode(doc.nodes, selection[0]) : null;
  const selectedSet = selectedSetNode?.type === "componentSet" ? { id: selectedSetNode.id, count: selectedSetNode.children.filter((c) => c.type === "component").length } : null;
  const multiBounds = boxes.length > 1
    ? (() => {
        const x = Math.min(...boxes.map((b) => b.x));
        const y = Math.min(...boxes.map((b) => b.y));
        return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
      })()
    : null;
  const selectedNode = selection.length === 1 && !selection[0].includes("/") ? getNode(doc.nodes, selection[0]) : null;
  const purple = selection.some((id) => isComponentish(id, doc.nodes));
  const tone = purple ? "var(--edit-component)" : "var(--edit-accent)";
  const resizable = selectedNode && !selectedNode.locked && selectedNode.id !== pageId;
  // ── Figma's layout handles: a selected auto layout frame's padding (blue, at each edge) and gap (pink, between its children) ──
  const layoutFrame = onLayoutEdit && box && selectedNode && isFrameLike(selectedNode) && (selectedNode.layoutMode === "vertical" || selectedNode.layoutMode === "horizontal") && !selectedNode.locked && !DRAW_TOOLS.has(tool) && (dragging === null || dragging === "layout") ? selectedNode : null;
  const modelPads = layoutFrame ? { top: numberOf(layoutFrame.paddingTop, render.byId), right: numberOf(layoutFrame.paddingRight, render.byId), bottom: numberOf(layoutFrame.paddingBottom, render.byId), left: numberOf(layoutFrame.paddingLeft, render.byId) } : null;
  // While a handle is dragged the model waits (the drag previews in the DOM): the strips follow the dragged value.
  const pads = modelPads && layoutDrag?.target.kind === "pad"
    ? (() => { const t = layoutDrag.target as { kind: "pad"; side: PadSide }; const sides: PadSide[] = layoutDrag.all ? ["top", "right", "bottom", "left"] : layoutDrag.both ? [t.side, OPPOSITE[t.side]] : [t.side]; const next = { ...modelPads }; for (const s of sides) next[s] = layoutDrag.value; return next; })()
    : modelPads;
  const flowH = layoutFrame?.layoutMode === "horizontal";
  const kids = layoutFrame ? shown.kids.map(S) : [];
  /** A padding side's strip (screen px) and its handle's point: in the middle of the strip (just inside the edge when there is none), as Figma's. */
  const padGeometry = (side: PadSide) => {
    const b = box!;
    const z = view.zoom;
    const p = pads![side] * z;
    const mid = Math.max(p / 2, 6);
    if (side === "top") return { region: { x: b.x, y: b.y, w: b.w, h: p }, at: { x: b.x + b.w / 2, y: b.y + mid }, across: true };
    if (side === "bottom") return { region: { x: b.x, y: b.y + b.h - p, w: b.w, h: p }, at: { x: b.x + b.w / 2, y: b.y + b.h - mid }, across: true };
    if (side === "left") return { region: { x: b.x, y: b.y, w: p, h: b.h }, at: { x: b.x + mid, y: b.y + b.h / 2 }, across: false };
    return { region: { x: b.x + b.w - p, y: b.y, w: p, h: b.h }, at: { x: b.x + b.w - mid, y: b.y + b.h / 2 }, across: false };
  };
  /** The gaps between consecutive children in the flow (the same row, when wrapping): their strips and handle points. */
  const gapGeometry = () => {
    if (!layoutFrame || !pads || layoutFrame.primaryAlign === "spaceBetween") return [];
    const b = box!;
    const z = view.zoom;
    const out: { region: Rect; at: { x: number; y: number } }[] = [];
    for (let i = 0; i + 1 < kids.length; i++) {
      const a = kids[i];
      const c = kids[i + 1];
      if (flowH) {
        if (c.x < a.x + a.w - 1) continue;
        const region = { x: a.x + a.w, y: b.y + pads.top * z, w: Math.max(0, c.x - (a.x + a.w)), h: Math.max(0, b.h - (pads.top + pads.bottom) * z) };
        out.push({ region, at: { x: region.x + region.w / 2, y: region.y + region.h / 2 } });
      } else {
        if (c.y < a.y + a.h - 1) continue;
        const region = { x: b.x + pads.left * z, y: a.y + a.h, w: Math.max(0, b.w - (pads.left + pads.right) * z), h: Math.max(0, c.y - (a.y + a.h)) };
        out.push({ region, at: { x: region.x + region.w / 2, y: region.y + region.h / 2 } });
      }
    }
    return out;
  };
  const gaps = layoutFrame ? gapGeometry() : [];
  const layoutActive = layoutDrag?.target ?? layoutHover;
  const padShown = (side: PadSide) => Boolean(layoutFocus?.pads?.includes(side)) || (!!layoutActive && layoutActive.kind === "pad" && (layoutActive.side === side || (layoutDrag?.both && OPPOSITE[layoutActive.side] === side) || Boolean(layoutDrag?.all)));
  const gapShown = Boolean(layoutFocus?.gap) || (!!layoutActive && layoutActive.kind === "gap");
  const applyLayout = (target: LayoutTarget, value: number, both = false, all = false) => {
    if (!layoutFrame) return;
    if (target.kind === "gap") return onLayoutEdit!(layoutFrame.id, { itemSpacing: { value } });
    const sides: PadSide[] = all ? ["top", "right", "bottom", "left"] : both ? [target.side, OPPOSITE[target.side]] : [target.side];
    const patch: Partial<FrameNode> = {};
    for (const s of sides) patch[PAD_KEY[s]] = { value };
    onLayoutEdit!(layoutFrame.id, patch);
  };
  /**
   * A handle dragged: the padding (⌥: with its opposite; ⇧⌥: all four) or
   * the gap follows the pointer — drawn straight into the frame's element
   * while it moves (the whole document would be too slow to re-render at
   * every step), written to the model once it is let go. A click opens the
   * value to type.
   */
  const startLayoutDrag = (e: React.PointerEvent, target: LayoutTarget) => {
    if (e.button !== 0 || !layoutFrame || !pads) return;
    e.preventDefault();
    e.stopPropagation();
    const frame = layoutFrame;
    const el = elOf(frame.id);
    // The element's own inline values (React's), put back once the drag ends — the model's render then writes what changed.
    const saved = el ? { top: el.style.paddingTop, right: el.style.paddingRight, bottom: el.style.paddingBottom, left: el.style.paddingLeft, columnGap: el.style.columnGap, rowGap: el.style.rowGap } : null;
    const start = { x: e.clientX, y: e.clientY };
    const from = target.kind === "gap" ? numberOf(frame.itemSpacing, render.byId) : pads[target.side];
    const modelSides = { ...pads };
    let value = from;
    let both = false;
    let all = false;
    let moved = false;
    const preview = () => {
      if (!el) return;
      if (target.kind === "gap") {
        if (flowH) el.style.columnGap = `${value}px`;
        else el.style.rowGap = `${value}px`;
        return;
      }
      const sides: PadSide[] = all ? ["top", "right", "bottom", "left"] : both ? [target.side, OPPOSITE[target.side]] : [target.side];
      for (const s of ["top", "right", "bottom", "left"] as PadSide[]) el.style[PAD_KEY[s]] = `${sides.includes(s) ? value : modelSides[s]}px`;
    };
    setLayoutEdit(null);
    setLayoutDrag({ target, value, both, all });
    follow(
      "layout",
      (ev) => {
        const zoom = latest.current.view.zoom;
        const dx = (ev.clientX - start.x) / zoom;
        const dy = (ev.clientY - start.y) / zoom;
        if (Math.abs(ev.clientX - start.x) > 2 || Math.abs(ev.clientY - start.y) > 2) moved = true;
        if (!moved) return;
        // A padding's handle sits in its strip: pulled outward (up for the top, down for the bottom…) the padding grows, as Figma's.
        const d = target.kind === "gap" ? (flowH ? dx : dy) : target.side === "top" ? -dy : target.side === "bottom" ? dy : target.side === "left" ? -dx : dx;
        value = Math.max(0, Math.round(from + d));
        both = ev.altKey && !ev.shiftKey;
        all = ev.altKey && ev.shiftKey;
        preview();
        setLayoutDrag({ target, value, both, all });
      },
      () => {
        setLayoutDrag(null);
        if (el && saved) {
          // The preview comes off (never by removing a longhand: the gap is React's shorthand, taking one off would zero it); the model's render then writes what changed.
          el.style.paddingTop = saved.top;
          el.style.paddingRight = saved.right;
          el.style.paddingBottom = saved.bottom;
          el.style.paddingLeft = saved.left;
          el.style.columnGap = saved.columnGap;
          el.style.rowGap = saved.rowGap;
        }
        if (moved) applyLayout(target, value, both, all);
        else setLayoutEdit({ target, value: String(value) });
      }
    );
  };
  const commitLayoutEdit = () => {
    if (!layoutEdit) return;
    const n = Number(layoutEdit.value.replace(",", "."));
    if (Number.isFinite(n)) applyLayout(layoutEdit.target, Math.max(0, Math.round(n)));
    setLayoutEdit(null);
  };
  /** Where a handle's badge or field sits: outside the frame, past the handle. */
  const layoutPoint = (target: LayoutTarget) => {
    if (target.kind === "gap") {
      const g = gaps[0];
      return g ? g.at : null;
    }
    return padGeometry(target.side).at;
  };
  const cursor = dragging === "pan" || (dragging === null && (space || tool === "hand")) ? (dragging === "pan" ? "grabbing" : "grab") : tool === "text" ? "text" : DRAW_TOOLS.has(tool) ? "crosshair" : undefined;
  const ruled = rulers && !paged;
  const inset = ruled ? RULER : 0;
  // (The same objects while nothing they say changes: the rulers redraw only then.)
  const rulerView = useMemo(() => ({ ...view, x: view.x - inset, y: view.y - inset }), [view, inset]);
  const selectedSpan = box ?? multiBounds;
  const spanKey = selectedSpan ? `${selectedSpan.x},${selectedSpan.y},${selectedSpan.w},${selectedSpan.h}` : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by its numbers
  const rulerSelected = useMemo(() => selectedSpan, [spanKey]);
  // The page's scrollbar: what is in sight of the page (and the room under it), along the view's right edge.
  const scrollbar = (() => {
    if (!paged) return null;
    const content = pageHeight * view.zoom + PAGE_END_ROOM;
    const track = size.height - SCROLL_INSET * 2;
    if (!pageHeight || content <= size.height + 1 || track <= SCROLL_MIN) return null;
    const length = Math.max(SCROLL_MIN, (size.height / content) * track);
    const range = content - size.height;
    return { length, range, travel: track - length, offset: SCROLL_INSET + (Math.min(range, -view.y) / range) * (track - length) };
  })();
  const startScroll = (e: React.PointerEvent) => {
    if (e.button !== 0 || !scrollbar || scrollbar.travel <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { at: e.clientY, y: view.y };
    const { range, travel } = scrollbar;
    // Dragged: it stays in sight even when the pointer leaves the canvas (see EDITOR_CSS).
    const bar = e.currentTarget as HTMLElement;
    bar.setAttribute("data-dragging", "");
    const move = (ev: PointerEvent) => setView((v) => ({ ...v, y: start.y - ((ev.clientY - start.at) / travel) * range }));
    const up = () => {
      bar.removeAttribute("data-dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={viewport}
      data-figma-canvas=""
      className="absolute inset-0 overflow-hidden select-none touch-none"
      style={{ cursor, background: background ?? "var(--edit-canvas, #f5f5f5)" }}
      onPointerDownCapture={() => {
        // A press on the canvas takes the focus off a panel field (its padding / gap highlight goes with it), as Figma's.
        const active = document.activeElement as HTMLElement | null;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA") && !viewport.current?.contains(active)) active.blur();
      }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClickCanvas}
      onPointerMove={(e) => {
        if (dragging || DRAW_TOOLS.has(tool)) { hovered.current = null; return; }
        // On every move, not only on entering an element: within a text's box, its glyphs and the empty rest hit different layers.
        const path = pathAt(e.target as Element, world.current!, doc, { x: e.clientX, y: e.clientY });
        hovered.current = pickFrom(path, selection, e.metaKey || e.ctrlKey, world.current)?.el ?? null;
      }}
      onPointerLeave={() => { hovered.current = null; }}
      onContextMenu={(e) => {
        const target = e.target as Element;
        if (target.closest("[data-editing]")) return;
        const press = rightPress.current;
        // After a pan: no menu.
        if (rightMousePan && press.quiet) { e.preventDefault(); return; }
        const path = pathAt(target, world.current!, doc, { x: e.clientX, y: e.clientY });
        const inSelection = path.find((p) => selection.includes(p.id));
        const id = inSelection ? inSelection.id : pickFrom(path, selection, false, world.current)?.id ?? null;
        // The button is still down: it may become a pan — the menu waits for its release.
        if (rightMousePan && press.down) { e.preventDefault(); e.persist(); press.held = { id, e }; return; }
        onContextMenu(id, e);
      }}
      onClickCapture={(e) => { if ((e.target as Element).closest("a[href]")) e.preventDefault(); }}
      onDragStart={(e) => e.preventDefault()}
    >
      {/* Figma's pixel grid past 800%. */}
      {view.zoom >= 8 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: "linear-gradient(to right, rgba(0,0,0,0.12) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,0.12) 1px, transparent 1px)",
            backgroundSize: `${view.zoom}px ${view.zoom}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
        />
      )}
      {/* The world: the nodes at their places, the view's pan (translate) and zoom (scale) on it. The site's variables apply in it. */}
      <div className="absolute left-0 top-0" style={{ transform: `translate(${view.x}px, ${view.y}px)` }}>
        <div ref={world} data-design-scope="" className="absolute left-0 top-0 origin-top-left" style={{ transform: `scale(${view.zoom})` }}>
          <span ref={probe} data-zoom-probe="" aria-hidden className="pointer-events-none absolute left-0 top-0 h-0" style={{ width: PROBE }} />
          <DesignSystemStyle />
          <MotionStyle />
          {/* The Page Editor: the page's own fill behind and around it, as far as the view goes — the site's page has no canvas beside it. */}
          {pageNode && <div data-page-backdrop="" aria-hidden className="pointer-events-none absolute" style={{ left: -view.x / view.zoom, top: -view.y / view.zoom, width: size.width / view.zoom, height: size.height / view.zoom, ...fillsCss(pageNode.fills, render.byId) }} />}
          {paged ? (
            // The Page Editor: the page in the site's own container (its width the preview's) — the site's narrow-screen rules apply in it.
            <div data-canvas-page="" className="absolute left-0 top-0" style={{ width: pageWidth, "--page-lift": "0px" } as React.CSSProperties}>
              <style>{PAGE_CSS}</style>
              <div data-page-lift="" className="relative">
                <World doc={doc} render={render} />
              </div>
            </div>
          ) : (
            <World doc={doc} render={render} />
          )}
        </div>
      </div>

      {/* ── The lines over the canvas ── */}
      {shown.labels.map(({ rect: r, ...label }) => (
        <div
          key={label.id}
          data-canvas-ui=""
          onPointerDown={(e) => labelDown(e, label.id)}
          onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick(label.id); }}
          style={{ left: S(r).x, top: S(r).y - 18, maxWidth: Math.max(40, S(r).w) }}
          className={cn(
            "absolute flex items-center gap-1 h-4 text-[11px] leading-4 whitespace-nowrap overflow-hidden cursor-default",
            label.kind === "component" || label.kind === "componentSet" ? "text-[var(--edit-component)]" : selection.includes(label.id) ? "text-[var(--edit-accent)]" : "text-[var(--text-subtitle)] hover:text-[var(--edit-accent)]"
          )}
        >
          {(label.kind === "component" || label.kind === "componentSet") && <FigmaIcon name="16.component" size={12} />}
          <span className="truncate">{label.name}</span>
        </div>
      ))}
      {parentBox && !dragging && (
        <div aria-hidden className="pointer-events-none absolute border border-[var(--edit-accent)] opacity-25" style={{ left: parentBox.x, top: parentBox.y, width: parentBox.w, height: parentBox.h }} />
      )}
      {shown.underlines.length > 0 && !dragging && shown.underlines.map((u, i) => {
        const r = S(u);
        return <div key={i} aria-hidden className="pointer-events-none absolute" style={{ left: r.x, top: r.y - 1, width: r.w, height: 2, background: u.purple ? "var(--edit-component)" : "var(--edit-accent)" }} />;
      })}
      {hoverBox && !hoverIsText && !dragging && (!box || JSON.stringify(hoverBox) !== JSON.stringify(box)) && (
        <div aria-hidden className="pointer-events-none absolute border-2 opacity-70" style={{ borderColor: shown.hoverPurple ? "var(--edit-component)" : "var(--edit-accent)", left: hoverBox.x, top: hoverBox.y, width: hoverBox.w, height: hoverBox.h }} />
      )}
      {boxes.map((b, i) => (
        <div key={i} aria-hidden className="pointer-events-none absolute border" style={{ left: b.x, top: b.y, width: b.w, height: b.h, borderColor: shown.measure || copying ? MEASURE : tone }} />
      ))}
      {copying && shown.origins.map((o, i) => {
        const r = S(o);
        return <div key={`o${i}`} aria-hidden className="pointer-events-none absolute border" style={{ left: r.x, top: r.y, width: r.w, height: r.h, borderColor: MEASURE }} />;
      })}
      {shown.measure && <Measure a={S(shown.measure.a)} b={S(shown.measure.b)} zoom={view.zoom} />}
      {multiBounds && (
        <div aria-hidden className="pointer-events-none absolute border border-dashed" style={{ left: multiBounds.x, top: multiBounds.y, width: multiBounds.w, height: multiBounds.h, borderColor: tone }} />
      )}
      {drop && dragging === "move" && (
        <>
          {drop.rect && <div aria-hidden className="pointer-events-none absolute border-2 border-[var(--edit-accent)]" style={{ left: drop.rect.x, top: drop.rect.y, width: drop.rect.w, height: drop.rect.h }} />}
          {drop.line && <div aria-hidden className="pointer-events-none absolute bg-[var(--edit-accent)] rounded-full" style={{ left: drop.line.x, top: drop.line.y, width: drop.line.w, height: drop.line.h }} />}
        </>
      )}
      {marquee && (
        <div aria-hidden className="pointer-events-none absolute border border-[var(--edit-accent)] bg-[color-mix(in_srgb,var(--edit-accent)_12%,transparent)]" style={{ left: view.x + marquee.x * view.zoom, top: view.y + marquee.y * view.zoom, width: marquee.w * view.zoom, height: marquee.h * view.zoom }} />
      )}
      {guides.map((g, i) =>
        g.axis === "x" ? (
          <div key={`gx${i}`} aria-hidden className="pointer-events-none absolute top-0 bottom-0 w-px" style={{ left: view.x + g.at * view.zoom, background: "var(--edit-snap, #ff00ff)" }} />
        ) : (
          <div key={`gy${i}`} aria-hidden className="pointer-events-none absolute left-0 right-0 h-px" style={{ top: view.y + g.at * view.zoom, background: "var(--edit-snap, #ff00ff)" }} />
        )
      )}
      {/* ── Padding and gap handles (Figma's): hover shows the strip, a drag changes it, a click opens the value ── */}
      {layoutFrame && pads && (
        <>
          {(["top", "right", "bottom", "left"] as PadSide[]).map((side) => {
            const g = padGeometry(side);
            const on = padShown(side);
            return (
              <span key={side}>
                {on && g.region.w > 0 && g.region.h > 0 && (
                  <span aria-hidden className="pointer-events-none absolute" style={{ left: g.region.x, top: g.region.y, width: g.region.w, height: g.region.h, background: "repeating-linear-gradient(-45deg, rgba(13,153,255,0.32) 0 2px, rgba(13,153,255,0.08) 2px 7px)" }} />
                )}
                <span
                  data-canvas-ui=""
                  role="slider"
                  aria-label={`${side} padding`}
                  aria-valuenow={pads[side]}
                  onPointerDown={(e) => startLayoutDrag(e, { kind: "pad", side })}
                  onPointerEnter={() => setLayoutHover({ kind: "pad", side })}
                  onPointerLeave={() => setLayoutHover((h) => (h && h.kind === "pad" && h.side === side ? null : h))}
                  className="absolute flex items-center justify-center -translate-x-1/2 -translate-y-1/2"
                  style={{ left: g.at.x, top: g.at.y, width: g.across ? 22 : 12, height: g.across ? 12 : 22, cursor: g.across ? "ns-resize" : "ew-resize" }}
                >
                  <span className="rounded-full" style={{ width: g.across ? 14 : 2, height: g.across ? 2 : 14, background: on ? "var(--edit-accent, #0d99ff)" : "color-mix(in srgb, var(--edit-accent, #0d99ff) 70%, transparent)" }} />
                </span>
              </span>
            );
          })}
          {gaps.map((g, i) => {
            const on = gapShown;
            return (
              <span key={`gap${i}`}>
                {on && g.region.w > 0 && g.region.h > 0 && (
                  <span aria-hidden className="pointer-events-none absolute" style={{ left: g.region.x, top: g.region.y, width: g.region.w, height: g.region.h, boxShadow: `inset 0 0 0 1px ${GAP_COLOR}`, background: "rgba(255,36,189,0.06)" }} />
                )}
                <span
                  data-canvas-ui=""
                  role="slider"
                  aria-label="Gap"
                  aria-valuenow={numberOf(layoutFrame.itemSpacing, render.byId)}
                  onPointerDown={(e) => startLayoutDrag(e, { kind: "gap" })}
                  onPointerEnter={() => setLayoutHover({ kind: "gap" })}
                  onPointerLeave={() => setLayoutHover((h) => (h && h.kind === "gap" ? null : h))}
                  className="absolute flex items-center justify-center -translate-x-1/2 -translate-y-1/2"
                  style={{ left: g.at.x, top: g.at.y, width: flowH ? 12 : 22, height: flowH ? 22 : 12, cursor: flowH ? "ew-resize" : "ns-resize" }}
                >
                  <span className="rounded-full" style={{ width: flowH ? 2 : 14, height: flowH ? 14 : 2, background: GAP_COLOR, opacity: on ? 1 : 0.8 }} />
                </span>
              </span>
            );
          })}
          {/* The value's badge: over the handle while it is hovered or dragged (Figma's). */}
          {layoutActive && !layoutEdit && (() => {
            const at = layoutPoint(layoutActive);
            if (!at) return null;
            const value = layoutDrag ? layoutDrag.value : layoutActive.kind === "gap" ? numberOf(layoutFrame.itemSpacing, render.byId) : pads[layoutActive.side];
            return (
              <span aria-hidden className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 px-1.5 h-5 rounded-[4px] text-[11px] font-medium leading-5 text-white tabular-nums whitespace-nowrap" style={{ left: at.x, top: at.y - 18, background: layoutActive.kind === "gap" ? GAP_COLOR : "var(--edit-accent, #0d99ff)" }}>
                {value}
              </span>
            );
          })()}
          {layoutEdit && (() => {
            const at = layoutPoint(layoutEdit.target);
            if (!at) return null;
            const t = layoutEdit.target;
            const dx = t.kind === "pad" && t.side === "left" ? -52 : t.kind === "pad" && t.side === "right" ? 52 : 0;
            const dy = t.kind === "gap" ? -32 : t.side === "top" ? -32 : t.side === "bottom" ? 32 : 0;
            const icon = t.kind === "gap" ? (flowH ? "al.spacing-horizontal" : "al.spacing-vertical") : "al.padding-sides";
            return (
              <span data-canvas-ui="" className="absolute -translate-x-1/2 -translate-y-1/2 flex items-center gap-1 h-8 pl-1.5 pr-2 rounded-[8px] bg-[var(--f-bg-menu,#1e1e1e)] text-white shadow-[0_4px_12px_rgba(0,0,0,0.3)]" style={{ left: at.x + dx, top: at.y + dy }} onPointerDown={(e) => e.stopPropagation()}>
                <span className="flex items-center text-white/70"><FigmaIcon name={icon} size={16} /></span>
                <input
                  autoFocus
                  aria-label={t.kind === "gap" ? "Gap" : `${t.side} padding`}
                  value={layoutEdit.value}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setLayoutEdit({ target: t, value: e.target.value })}
                  onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commitLayoutEdit(); if (e.key === "Escape") setLayoutEdit(null); }}
                  onBlur={commitLayoutEdit}
                  className="w-11 h-6 px-1.5 rounded-[3px] bg-white/10 text-[11px] leading-4 text-white outline-none tabular-nums selection:bg-[var(--edit-accent,#0d99ff)]"
                />
              </span>
            );
          })()}
        </>
      )}
      {box && resizable && dragging !== "move" &&
        ALL_HANDLES.map((handle) => (
          <span
            key={handle}
            data-canvas-ui=""
            onPointerDown={(e) => e.button === 0 && startResize(e, handle)}
            className="absolute w-2 h-2 -ml-1 -mt-1 bg-white border rounded-[1px]"
            style={{ left: box.x + (handle.includes("w") ? 0 : handle.includes("e") ? box.w : box.w / 2), top: box.y + (handle.includes("n") ? 0 : handle.includes("s") ? box.h : box.h / 2), borderColor: tone, cursor: HANDLE_CURSOR[handle] }}
          />
        ))}
      {prototyping && (
        <Noodles
          links={shown.links}
          flows={shown.flows}
          toScreen={S}
          selected={selection}
          handle={!dragging && box && selection.length === 1 && !selection[0].includes("/") ? { id: selection[0], box } : null}
          viewport={viewport}
          findTarget={linkTarget}
          onConnect={onConnect}
          onRetarget={onRetarget}
          onOpenReaction={onOpenReaction}
          onPlayFlow={onPlayFlow}
        />
      )}
      {/* A component set selected, as Figma's: under it how many variants it has (in the size's place), and a + adding one. */}
      {box && dragging !== "resize" && selectedSet && (
        <>
          <span aria-hidden className="pointer-events-none absolute -translate-x-1/2 px-1.5 rounded-[3px] text-[11px] font-medium leading-4 text-white whitespace-nowrap" style={{ left: box.x + box.w / 2, top: box.y + box.h + 6, background: tone }}>
            {selectedSet.count} {selectedSet.count === 1 ? "Variant" : "Variants"}
          </span>
          {onAddVariant && (
            <button
              type="button"
              data-canvas-ui=""
              aria-label="Add variant"
              title="Add variant"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onAddVariant(selectedSet.id)}
              className="absolute -translate-x-1/2 flex items-center justify-center w-5 h-5 rounded-[4px] text-white cursor-pointer hover:brightness-110"
              style={{ left: box.x + box.w / 2, top: box.y + box.h + 28, background: tone }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          )}
        </>
      )}
      {(box ?? multiBounds) && dragging !== "resize" && !(box && selectedSet) && (
        <span aria-hidden className="pointer-events-none absolute -translate-x-1/2 px-1 rounded-[3px] text-[11px] font-medium leading-4 text-white tabular-nums whitespace-nowrap" style={{ left: (box ?? multiBounds)!.x + (box ?? multiBounds)!.w / 2, top: (box ?? multiBounds)!.y + (box ?? multiBounds)!.h + 6, background: tone }}>
          {Math.round((box ?? multiBounds)!.w / view.zoom)} × {Math.round((box ?? multiBounds)!.h / view.zoom)}
        </span>
      )}
      {drawRect && (
        <div aria-hidden className="pointer-events-none absolute border border-[var(--edit-accent)]" style={{ left: view.x + drawRect.x * view.zoom, top: view.y + drawRect.y * view.zoom, width: drawRect.w * view.zoom, height: drawRect.h * view.zoom }} />
      )}
      {ruled && <Rulers view={rulerView} width={size.width - inset} height={size.height - inset} selected={rulerSelected} />}
      {scrollbar && (
        <span
          data-canvas-ui=""
          data-page-scrollbar=""
          aria-hidden
          onPointerDown={startScroll}
          className="absolute right-0 z-20 flex justify-center w-3 cursor-default"
          style={{ top: scrollbar.offset, height: scrollbar.length }}
        >
          <span className="w-[5px] h-full rounded-full bg-[var(--f-text-tertiary)]" />
        </span>
      )}
    </div>
  );
}

export { DRAW_TOOLS };
export type { CanvasTool, CanvasView };
export { MIN_ZOOM };
export type CanvasChild = ReactNode;
