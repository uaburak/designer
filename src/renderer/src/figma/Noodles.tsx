import { useEffect, useRef, useState } from "react";
import { FigmaIcon } from "@/components/admin/figmaIcons";
import type { Rect } from "./Canvas";

/**
 * Figma's prototype noodles, over the canvas (the Prototype tab): each
 * connection a curve from its layer to its frame — blue, a variant's change
 * purple with its trigger's name on it — the selected layer's own in full
 * colour; the selected layer's handle (a +) on its right edge, dragged onto
 * a frame to connect it; a connection's end dragged onto another frame to
 * move it, or off any to take it away; the flows' starting points, each
 * with its play button. Drawn in the screen's units (the canvas's lines).
 */

export interface Link {
  source: string;
  id: string;
  from: Rect;
  to: Rect;
  /** A variant's change (Change to): purple, its trigger written on it */
  change: boolean;
  label: string;
}

const BLUE = "#0d99ff";
const PURPLE = "#9747ff";
type Point = { x: number; y: number };

/** The curve between two boxes, as Figma draws it: out of the source's side facing the target, into the target's facing side. */
function curve(a: Rect, b: Rect | Point) {
  const box: Rect = "w" in b ? b : { x: b.x, y: b.y, w: 0, h: 0 };
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  let p0: Point, p1: Point, n0: Point, n1: Point;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const right = dx >= 0;
    p0 = { x: right ? a.x + a.w : a.x, y: ac.y };
    p1 = { x: right ? box.x : box.x + box.w, y: bc.y };
    n0 = { x: right ? 1 : -1, y: 0 };
    n1 = { x: right ? -1 : 1, y: 0 };
  } else {
    const down = dy >= 0;
    p0 = { x: ac.x, y: down ? a.y + a.h : a.y };
    p1 = { x: bc.x, y: down ? box.y : box.y + box.h };
    n0 = { x: 0, y: down ? 1 : -1 };
    n1 = { x: 0, y: down ? -1 : 1 };
  }
  const k = Math.max(24, Math.hypot(p1.x - p0.x, p1.y - p0.y) * 0.4);
  const c0 = { x: p0.x + n0.x * k, y: p0.y + n0.y * k };
  const c1 = { x: p1.x + n1.x * k, y: p1.y + n1.y * k };
  const mid = { x: (p0.x + 3 * c0.x + 3 * c1.x + p1.x) / 8, y: (p0.y + 3 * c0.y + 3 * c1.y + p1.y) / 8 };
  // The arrowhead: two strokes back from the end, along where the curve comes from.
  const back = { x: n1.x * 9, y: n1.y * 9 };
  const side = { x: -n1.y * 6, y: n1.x * 6 };
  const arrow = `M${p1.x + back.x + side.x} ${p1.y + back.y + side.y}L${p1.x} ${p1.y}L${p1.x + back.x - side.x} ${p1.y + back.y - side.y}`;
  return { d: `M${p0.x} ${p0.y}C${c0.x} ${c0.y} ${c1.x} ${c1.y} ${p1.x} ${p1.y}`, p0, p1, mid, arrow };
}

export function Noodles({ links, flows, toScreen, selected, handle, viewport, findTarget, onConnect, onRetarget, onOpenReaction, onPlayFlow }: {
  links: Link[];
  flows: { id: string; name: string; rect: Rect }[];
  /** A world rect on the screen (the view's pan and zoom) */
  toScreen: (r: Rect) => Rect;
  /** The selected layers (their connections in full colour) */
  selected: readonly string[];
  /** The selected layer and its box on the screen: where its handle sits */
  handle: { id: string; box: Rect } | null;
  viewport: React.RefObject<HTMLDivElement | null>;
  /** What a connection from `source` would go to under the pointer (a frame, a variant of its set) — its box on the screen */
  findTarget: (clientX: number, clientY: number, source: string) => { id: string; rect: Rect } | null;
  onConnect?: (sourceId: string, targetId: string) => void;
  onRetarget?: (sourceId: string, reactionId: string, targetId: string | null) => void;
  onOpenReaction?: (sourceId: string, reactionId: string) => void;
  onPlayFlow?: (frameId: string) => void;
}) {
  // A connection being drawn (from the handle) or moved (its end): from where, to the pointer, over what.
  const [wire, setWire] = useState<{ source: string; from: Rect; to: Point; target: { id: string; rect: Rect } | null; reaction?: string } | null>(null);
  const live = useRef(wire);
  useEffect(() => {
    live.current = wire;
  });

  const startWire = (e: React.PointerEvent, source: string, from: Rect, reaction?: string) => {
    e.preventDefault();
    e.stopPropagation();
    const vp = viewport.current?.getBoundingClientRect();
    if (!vp) return;
    const at = (ev: PointerEvent | React.PointerEvent): Point => ({ x: ev.clientX - vp.left, y: ev.clientY - vp.top });
    setWire({ source, from, to: at(e), target: null, reaction });
    const move = (ev: PointerEvent) => setWire((w) => (w ? { ...w, to: at(ev), target: findTarget(ev.clientX, ev.clientY, source) } : w));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const target = findTarget(ev.clientX, ev.clientY, source);
      const w = live.current;
      setWire(null);
      if (!w) return;
      if (w.reaction) onRetarget?.(source, w.reaction, target?.id ?? null);
      else if (target) onConnect?.(source, target.id);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const shownLinks = links.map((l) => ({ ...l, from: toScreen(l.from), to: toScreen(l.to) }));
  return (
    <>
      <svg aria-hidden className="pointer-events-none absolute inset-0 z-10 w-full h-full overflow-visible">
        {shownLinks.map((l) => {
          if (wire?.reaction === l.id) return null;
          const c = curve(l.from, l.to);
          const mine = selected.includes(l.source);
          const color = l.change ? PURPLE : BLUE;
          const opacity = mine || !selected.length ? 1 : 0.35;
          return (
            <g key={`${l.source}:${l.id}`} opacity={opacity}>
              {/* A wide invisible stroke: the curve is easy to click. */}
              <path d={c.d} fill="none" stroke="transparent" strokeWidth={12} style={{ pointerEvents: "stroke", cursor: "pointer" }} data-canvas-ui="" data-picker-anchor="" onPointerDown={(e) => { e.stopPropagation(); onOpenReaction?.(l.source, l.id); }} />
              <path d={c.d} fill="none" stroke={color} strokeWidth={mine ? 2 : 1.5} />
              <path d={c.arrow} fill="none" stroke={color} strokeWidth={mine ? 2 : 1.5} strokeLinecap="round" strokeLinejoin="round" />
              <circle cx={c.p0.x} cy={c.p0.y} r={4} fill="#ffffff" stroke={color} strokeWidth={1.5} />
              {/* Its end: dragged onto another frame it goes there, off any it goes. */}
              <circle cx={c.p1.x} cy={c.p1.y} r={7} fill="transparent" style={{ pointerEvents: "all", cursor: "grab" }} data-canvas-ui="" onPointerDown={(e) => startWire(e, l.source, l.from, l.id)} />
            </g>
          );
        })}
        {wire && (() => {
          const c = curve(wire.from, wire.target?.rect ?? wire.to);
          return (
            <g>
              {wire.target && <rect x={wire.target.rect.x} y={wire.target.rect.y} width={wire.target.rect.w} height={wire.target.rect.h} fill="none" stroke={BLUE} strokeWidth={2} />}
              <path d={c.d} fill="none" stroke={BLUE} strokeWidth={2} />
              <path d={c.arrow} fill="none" stroke={BLUE} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </g>
          );
        })()}
      </svg>
      {/* A variant's change: its trigger on the curve (Figma's purple pill). */}
      {shownLinks.filter((l) => l.change && wire?.reaction !== l.id).map((l) => {
        const c = curve(l.from, l.to);
        return (
          <button
            key={`label:${l.source}:${l.id}`}
            type="button"
            data-canvas-ui=""
            data-picker-anchor=""
            onPointerDown={(e) => { e.stopPropagation(); onOpenReaction?.(l.source, l.id); }}
            className="absolute z-10 -translate-x-1/2 -translate-y-1/2 h-6 px-2 rounded-[5px] text-[11px] font-medium leading-6 whitespace-nowrap cursor-pointer"
            style={{ left: c.mid.x, top: c.mid.y, background: "#e4ccff", color: "#2c0059", opacity: selected.includes(l.source) || !selected.length ? 1 : 0.5 }}
          >
            {l.label}
          </button>
        );
      })}
      {/* The flows' starting points: their names at their frames' top left, each playing its flow. */}
      {flows.map((f) => {
        const r = toScreen(f.rect);
        return (
          <button
            key={`flow:${f.id}`}
            type="button"
            data-canvas-ui=""
            title={`Present ${f.name}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onPlayFlow?.(f.id)}
            className="absolute z-10 flex items-center gap-1.5 h-6 pl-2 pr-1.5 rounded-l-[4px] text-[11px] font-semibold leading-6 whitespace-nowrap cursor-pointer -translate-x-full"
            style={{ left: r.x, top: r.y, background: "#bde3ff", color: "#000000" }}
          >
            {f.name}
            <FigmaIcon name="24.play.small" size={16} />
          </button>
        );
      })}
      {/* The selected layer's handle: a + on its right edge, dragged onto a frame. */}
      {handle && !wire && (
        <button
          type="button"
          data-canvas-ui=""
          aria-label="Add a connection"
          title="Drag onto a frame to connect it"
          onPointerDown={(e) => startWire(e, handle.id, handle.box)}
          className="absolute z-20 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center w-4 h-4 rounded-full bg-white border-2 cursor-crosshair"
          style={{ left: handle.box.x + handle.box.w, top: handle.box.y + handle.box.h / 2, borderColor: BLUE, color: BLUE }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden><path d="M4 1v6M1 4h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      )}
    </>
  );
}
