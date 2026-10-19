/**
 * The Prototype panel's easing graph, 200 × 200 (docs/motion.md §6.3; round 8i): progress across, the eased value up, the unit
 * square in the middle (0–1 both ways, 100 px a unit) so the back curves and springs overshoot into the space above
 * and below (y −0.5 … 1.5, the custom bezier's range). Any easing is drawn; a custom one is edited on it:
 *
 * - **Custom bezier**: its two handles dragged (x clamped to [0, 1], y to [−0.5, 1.5]); a click on a corner point puts
 *   its handle back on it (help: "the corner points reset the curve").
 * - **Custom spring**: the response played over the segment (normalised, §4.7) and one handle at its first peak, dragged
 *   up and down for the bounce — its height Figma's y = 2 − 2·ζ^0.87, here a quarter of it above the end value [ours:
 *   the graph is normalised, so ω₀ has no handle].
 *
 * A drag reports each move (`commit` false) and its release once (`commit` true). Used by the Prototype panel's
 * Interaction details (round 8j); Motion's easings use the Easing page's graph (EasingGraph.tsx) since 2026-10-19.
 */
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { capture } from "@/ds/util/pointer";
import { t, useT } from "@/i18n";
import { bezierOf, bounceAtHandle, easingAt, springHandle } from "@shared/motion/easing";
import type { MotionEasing } from "@shared/motion/types";
import styles from "./CurveEditor.module.css";

/** The graph's size and where the unit square sits in it. */
export const GRAPH_PX = 200;
const UNIT = 100;
const X0 = 50;
const Y0 = 150;
const toX = (p: number) => X0 + p * UNIT;
const toY = (v: number) => Y0 - v * UNIT;
const fromX = (x: number) => (x - X0) / UNIT;
const fromY = (y: number) => (Y0 - y) / UNIT;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

/** The curve as path data over the graph (a bezier exactly; anything else sampled). */
export function curvePath(e: MotionEasing): string {
  const b = bezierOf(e);
  if (b) return `M${toX(0)} ${toY(0)} C${toX(b[0])} ${toY(b[1])} ${toX(b[2])} ${toY(b[3])} ${toX(1)} ${toY(1)}`;
  if (e.type === "HOLD") return `M${toX(0)} ${toY(0)} H${toX(1)} V${toY(1)}`;
  const pts: string[] = [];
  for (let i = 0; i <= 80; i++) {
    const p = i / 80;
    pts.push(`${toX(p).toFixed(1)} ${toY(clamp(easingAt(e, p), -0.5, 1.5)).toFixed(1)}`);
  }
  return `M${pts.join(" L")}`;
}

/** The spring handle's place on the graph (the first peak across, Figma's height mapped above the end value). */
export function springHandlePoint(bounce: number): { x: number; y: number } {
  const h = springHandle(bounce);
  return { x: toX(h.x), y: toY(1 + h.y / 4) };
}

export function CurveEditor({ easing, editable, onChange }: { easing: MotionEasing; editable: boolean; onChange(e: MotionEasing, commit: boolean): void }) {
  useT();
  const svg = useRef<SVGSVGElement>(null);
  const bezier = easing.type === "CUSTOM_CUBIC_BEZIER" ? bezierOf(easing) : null;
  const spring = easing.type === "CUSTOM_SPRING" ? (easing.easingFunctionSpring?.bounce ?? 0.25) : null;

  // The pointer in graph units (the SVG may be drawn at another size than 200).
  const at = (ev: { clientX: number; clientY: number }) => {
    const r = svg.current?.getBoundingClientRect();
    const k = r && r.width > 0 ? GRAPH_PX / r.width : 1;
    return { x: (ev.clientX - (r?.left ?? 0)) * k, y: (ev.clientY - (r?.top ?? 0)) * k };
  };
  const drag = (e: ReactPointerEvent<SVGElement>, move: (p: { x: number; y: number }) => MotionEasing) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    capture(e.currentTarget, e.pointerId);
    let last = easing;
    const onMove = (ev: PointerEvent) => {
      last = move(at(ev));
      onChange(last, false);
    };
    const onUp = () => {
      onChange(last, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  const handle = (which: 1 | 2) => (p: { x: number; y: number }): MotionEasing => {
    const b = bezier ?? [0.5, 0, 0.5, 1];
    const x = r2(clamp(fromX(p.x), 0, 1));
    const y = r2(clamp(fromY(p.y), -0.5, 1.5));
    const next = which === 1 ? [x, y, b[2], b[3]] : [b[0], b[1], x, y];
    return { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: next[0], y1: next[1], x2: next[2], y2: next[3] } };
  };
  const reset = (which: 1 | 2) => {
    if (!bezier) return;
    const next = which === 1 ? [0, 0, bezier[2], bezier[3]] : [bezier[0], bezier[1], 1, 1];
    onChange({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: next[0], y1: next[1], x2: next[2], y2: next[3] } }, true);
  };

  const sp = spring !== null ? springHandlePoint(spring) : null;
  return (
    <svg ref={svg} className={styles.graph} viewBox={`0 0 ${GRAPH_PX} ${GRAPH_PX}`} width={GRAPH_PX} height={GRAPH_PX} role="img" aria-label={t("Easing curve")} data-easing-graph={easing.type}>
      <rect className={styles.unit} x={toX(0)} y={toY(1)} width={UNIT} height={UNIT} />
      <path className={styles.curve} d={curvePath(easing)} />
      {editable && bezier && (
        <>
          <line className={styles.handleLine} x1={toX(0)} y1={toY(0)} x2={toX(bezier[0])} y2={toY(bezier[1])} />
          <line className={styles.handleLine} x1={toX(1)} y1={toY(1)} x2={toX(bezier[2])} y2={toY(bezier[3])} />
          <rect className={styles.corner} x={toX(0) - 3} y={toY(0) - 3} width={6} height={6} data-corner="start" aria-label={t("Reset curve")} onClick={() => reset(1)} />
          <rect className={styles.corner} x={toX(1) - 3} y={toY(1) - 3} width={6} height={6} data-corner="end" aria-label={t("Reset curve")} onClick={() => reset(2)} />
          <circle className={styles.handle} cx={toX(bezier[0])} cy={toY(bezier[1])} r={5} data-handle="1" onPointerDown={(e) => drag(e, handle(1))} />
          <circle className={styles.handle} cx={toX(bezier[2])} cy={toY(bezier[3])} r={5} data-handle="2" onPointerDown={(e) => drag(e, handle(2))} />
        </>
      )}
      {editable && sp && (
        <>
          <line className={styles.handleLine} x1={sp.x} y1={toY(1)} x2={sp.x} y2={sp.y} />
          <circle
            className={styles.handle}
            cx={sp.x}
            cy={sp.y}
            r={5}
            data-handle="spring"
            onPointerDown={(e) =>
              drag(e, (p) => ({ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: bounceAtHandle(4 * (clamp(fromY(p.y), 1, 1.5) - 1)) } }))
            }
          />
        </>
      )}
    </svg>
  );
}
