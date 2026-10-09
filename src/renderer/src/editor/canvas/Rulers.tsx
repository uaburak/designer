/**
 * The rulers (⇧R): 20px along the canvas's top and left, drawn on two 2D
 * canvases when the camera, the selection, its nodes or the theme change —
 * never through React state per frame. At 100% a label every 50; with a
 * selection the ruler's 0 moves to its top-level frame's corner, the
 * selection's span is a band with its edges labelled in blue, and the labels
 * near those edges fade (docs/research/visual-diff.md, model/rulers.ts).
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { PointerType, Status } from "@/engine/abi";
import { modifiersOf } from "@/engine/CanvasController";
import { canvasChrome, canvasChromeMetrics, text, useTheme, type ThemeName } from "@/ds";
import { useEditor, type EditorController } from "../controller";
import { useUI } from "../hooks";
import { pageBounds, topLevelOf, worldTransform } from "../actions";
import { labelAlpha, rulerLabel, rulerTicks, toScreen, type RulerAxis } from "../model/rulers";
import styles from "./Canvas.module.css";

const T = canvasChromeMetrics.ruler.thickness;
const TICK = canvasChromeMetrics.ruler.tick;
const FONT = `${text["body-ruler"].weight} ${text["body-ruler"].size}px "Inter Variable", Inter, system-ui, sans-serif`;

interface Palette {
  bg: string;
  tick: string;
  text: string;
  band: string;
  edge: string;
  border: string;
}

function palette(theme: ThemeName, el: Element): Palette {
  const i = theme === "light" ? 0 : 1;
  return {
    bg: canvasChrome.rulerBg[i],
    tick: canvasChrome.rulerTick[i],
    text: canvasChrome.rulerText[i],
    band: canvasChrome.rulerSelectionBand[i],
    edge: canvasChrome.rulerSelectionText[i],
    border: getComputedStyle(el).getPropertyValue("--figma-color-border").trim() || canvasChrome.rulerTick[i],
  };
}

/** Sizes a canvas's backing store to its CSS box × DPR and returns its 2D context in CSS px. */
function prepare(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

interface Span {
  /** Page units, on this axis */
  from: number;
  to: number;
}

/**
 * One ruler, drawn along its length (the left one is drawn rotated, so both
 * read as "along"): background, the selection band, ticks + labels (faded
 * near the edges' labels), the edge labels, the line against the canvas.
 */
function drawRuler(ctx: CanvasRenderingContext2D, length: number, axis: RulerAxis, span: Span | null, p: Palette, start: number) {
  ctx.clearRect(0, 0, length, T);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, length, T);
  const edges: { at: number; label: string }[] = [];
  if (span) {
    const a = Math.round(toScreen(axis, span.from - axis.origin));
    const b = Math.round(toScreen(axis, span.to - axis.origin));
    ctx.fillStyle = p.band;
    ctx.fillRect(a, 0, Math.max(1, b - a), T);
    edges.push({ at: a, label: rulerLabel(span.from - axis.origin) }, { at: b, label: rulerLabel(span.to - axis.origin) });
  }
  ctx.font = FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const centers = edges.map((e) => e.at);
  for (const v of rulerTicks(axis, length)) {
    const x = Math.round(toScreen(axis, v)) + 0.5;
    if (x < start) continue;
    const alpha = labelAlpha(x, centers);
    ctx.fillStyle = p.tick;
    ctx.fillRect(x - 0.5, T - TICK, 1, TICK);
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.text;
    ctx.fillText(rulerLabel(v), x, 11);
    ctx.globalAlpha = 1;
  }
  for (const e of edges) {
    if (e.at < start - 20) continue;
    ctx.fillStyle = p.edge;
    ctx.fillRect(e.at, T - TICK, 1, TICK);
    ctx.fillText(e.label, e.at + 0.5, 11);
  }
  ctx.fillStyle = p.border;
  ctx.fillRect(0, T - 1, length, 1);
}

function draw(ed: EditorController, top: HTMLCanvasElement, left: HTMLCanvasElement, theme: ThemeName) {
  if (ed.engine.destroyed) return;
  const area = top.parentElement;
  if (!area) return;
  const w = area.clientWidth;
  const h = area.clientHeight;
  const cam = ed.store.camera;
  // The rulers sit at the visible part's edges; the camera is the whole canvas's (it spans the window, under the panels).
  const c = ed.canvas?.getBoundingClientRect();
  const a = area.getBoundingClientRect();
  const dx = c ? a.left - c.left : 0;
  const dy = c ? a.top - c.top : 0;
  const p = palette(theme, area);
  // The ruler's 0: the selection's top-level frame (its page-space corner), else the page's origin.
  const sel = ed.selection;
  let ox = 0;
  let oy = 0;
  const box = sel.length ? pageBounds(ed, sel) : null;
  if (sel.length) {
    const tops = new Set(sel.map((id) => topLevelOf(ed, id)?.guid));
    const frame = tops.size === 1 ? topLevelOf(ed, sel[0]) : null;
    if (frame && frame.type === "FRAME" && !frame.resizeToFit) {
      const m = worldTransform(ed, frame);
      ox = m.m02;
      oy = m.m12;
    }
  }
  const tctx = prepare(top, w, T);
  if (tctx) drawRuler(tctx, w, { offset: cam.x - dx, zoom: cam.zoom, origin: ox }, box ? { from: box.x, to: box.x + box.w } : null, p, T);
  const lctx = prepare(left, T, h);
  if (lctx) drawLeft(lctx, h, { offset: cam.y - dy, zoom: cam.zoom, origin: oy }, box ? { from: box.y, to: box.y + box.h } : null, p);
}

/** The left ruler: like the top one, along y; labels turned to read upwards (Figma's). */
function drawLeft(ctx: CanvasRenderingContext2D, length: number, axis: RulerAxis, span: Span | null, p: Palette) {
  ctx.clearRect(0, 0, T, length);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, T, length);
  const edges: { at: number; label: string }[] = [];
  if (span) {
    const a = Math.round(toScreen(axis, span.from - axis.origin));
    const b = Math.round(toScreen(axis, span.to - axis.origin));
    ctx.fillStyle = p.band;
    ctx.fillRect(0, a, T, Math.max(1, b - a));
    edges.push({ at: a, label: rulerLabel(span.from - axis.origin) }, { at: b, label: rulerLabel(span.to - axis.origin) });
  }
  ctx.font = FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const centers = edges.map((e) => e.at);
  const label = (s: string, y: number) => {
    ctx.save();
    ctx.translate(11, y);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(s, 0, 0);
    ctx.restore();
  };
  for (const v of rulerTicks(axis, length)) {
    const y = Math.round(toScreen(axis, v)) + 0.5;
    if (y < T) continue;
    ctx.fillStyle = p.tick;
    ctx.fillRect(T - TICK, y - 0.5, TICK, 1);
    const alpha = labelAlpha(y, centers);
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.text;
    label(rulerLabel(v), y);
    ctx.globalAlpha = 1;
  }
  for (const e of edges) {
    if (e.at < 0) continue;
    ctx.fillStyle = p.edge;
    ctx.fillRect(T - TICK, e.at, TICK, 1);
    label(e.label, e.at + 0.5);
  }
  ctx.fillStyle = p.border;
  ctx.fillRect(T - 1, 0, 1, length);
}

/**
 * A press on a ruler drags a guide out of it (round 8; help.figma.com "Add guides to the canvas or frames"): the top
 * ruler's guides are horizontal, the left one's vertical. The engine owns the guide (engine_start_guide); the pointer's
 * moves and release go to it in canvas px; let go over a ruler, it goes.
 */
export function guideDrag(ed: EditorController, axis: "X" | "Y", e: ReactPointerEvent<HTMLCanvasElement>): void {
  const canvas = ed.canvas;
  if (!canvas || e.button !== 0) return;
  const at = (ev: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top] as const;
  };
  const [x, y] = at(e);
  if (ed.engine.startGuide(axis, x, y, T) !== Status.OK) return;
  e.preventDefault();
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const send = (type: number, ev: PointerEvent) => {
    const [px, py] = at(ev);
    ed.engine.pointer(type, px, py, 0, ev.buttons, modifiersOf(ev), ev.pressure, 1, 0, ev.timeStamp);
  };
  const onMove = (ev: PointerEvent) => send(PointerType.MOVE, ev);
  const done = (ev: PointerEvent) => {
    send(ev.type === "pointercancel" ? PointerType.CANCEL : PointerType.UP, ev);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", done);
    el.removeEventListener("pointercancel", done);
    ed.focusCanvas();
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", done);
  el.addEventListener("pointercancel", done);
}

export function Rulers() {
  const ed = useEditor();
  const on = useUI((s) => s.rulers);
  const { resolved } = useTheme();
  const top = useRef<HTMLCanvasElement>(null);
  const left = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const t = top.current;
    const l = left.current;
    if (!on || !t || !l) return;
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        draw(ed, t, l, resolved);
      });
    };
    const offs = [ed.store.subscribe("camera", schedule), ed.store.subscribe("selection", schedule), ed.store.subscribe("page", schedule), ed.engine.on("NODES_CHANGED", schedule)];
    // The rulers take presses (guides), so a wheel over them goes on to the canvas.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      ed.canvas?.dispatchEvent(new WheelEvent("wheel", e));
    };
    t.addEventListener("wheel", wheel, { passive: false });
    l.addEventListener("wheel", wheel, { passive: false });
    offs.push(() => t.removeEventListener("wheel", wheel), () => l.removeEventListener("wheel", wheel));
    // A panel resized: drawn in the same frame (the observer runs before paint), so the ticks never lag the canvas.
    const ro = new ResizeObserver(() => draw(ed, t, l, resolved));
    if (t.parentElement) ro.observe(t.parentElement);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      offs.forEach((off) => off());
      ro.disconnect();
    };
  }, [ed, on, resolved]);
  if (!on) return null;
  return (
    <>
      <canvas ref={top} className={styles.rulerTop} aria-hidden data-ruler="top" onPointerDown={(e) => guideDrag(ed, "Y", e)} />
      <canvas ref={left} className={styles.rulerLeft} aria-hidden data-ruler="left" onPointerDown={(e) => guideDrag(ed, "X", e)} />
      <div className={styles.rulerCorner} aria-hidden />
    </>
  );
}
