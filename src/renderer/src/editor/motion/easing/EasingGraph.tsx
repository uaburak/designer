/**
 * The Easing page's 208 × 208 graph (docs/motion.md §6.14; Figma's, 2026-10-18/motion-easing.txt and the owner's
 * capture owner-2026-10-19/figma-motion-easing-panel.webp):
 *
 * - **Curve**: time across, the eased value up; the curve white from (0, 0) to (1, 1), the two faint guide lines at 0
 *   and 1, the playhead's place in the segment as a vertical line (Figma's capture: 589 ms of 0–725 ms), two blue
 *   handles — a line from each end to a ring knob — dragged freely (x 0–1; y as far as the graph reaches: the graph is
 *   fitted again on release, so a curve may overshoot as far as wanted, as Figma's). Dragging a named curve makes it a
 *   Custom bezier. Hold is drawn as its step, not edited.
 * - **Spring**: the response over the segment (normalised, §4.7 — our spring duration logic), the guideline at the
 *   target, a knob at the first peak dragged up and down for the bounce.
 *
 * Hovering a preset in the popover shows its curve here, with a dot tracing it (the hover preview [ours], kept from the
 * old Easing popover). A drag reports each move (`commit` false) and its release (`commit` true).
 */
import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { capture } from "@/ds/util/pointer";
import { t, useT } from "@/i18n";
import { bezierOf, easingCss } from "@shared/motion/easing";
import type { MotionEasing } from "@shared/motion/types";
import { GRAPH, SPRING_X0, SPRING_X1, SPRING_Y1, bounceForPeak, curveLayout, curvePathOf, isSpring, springPathOf, springPeak, springX, springY, type CurveLayout } from "./easingMaths";
import styles from "./EasingPage.module.css";

const r2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface EasingGraphProps {
  /** null: Mixed (the guides only) */
  easing: MotionEasing | null;
  /** "spring": the spring view (also for a Mixed selection of springs) */
  kind: "bezier" | "spring";
  /** A hovered preset: drawn instead, with the tracing dot */
  preview?: MotionEasing | null;
  /** The playhead's place in the segment (0–1), or null outside it */
  playhead?: number | null;
  onChange(e: MotionEasing, commit: boolean): void;
}

export function EasingGraph({ easing, kind, preview, playhead, onChange }: EasingGraphProps) {
  useT();
  const svg = useRef<SVGSVGElement>(null);
  // While a handle drags, the layout stays the one it started with (the graph refits on release).
  const [frozen, setFrozen] = useState<CurveLayout | null>(null);
  const shown = preview ?? easing;
  const bezier = shown ? bezierOf(shown) : null;
  const layout = frozen ?? curveLayout(bezier);
  const editable = !preview && !!easing;

  const at = (ev: { clientX: number; clientY: number }) => {
    const r = svg.current?.getBoundingClientRect();
    const k = r && r.width > 0 ? GRAPH / r.width : 1;
    return { x: (ev.clientX - (r?.left ?? 0)) * k, y: (ev.clientY - (r?.top ?? 0)) * k };
  };
  const drag = (e: ReactPointerEvent<SVGElement>, move: (p: { x: number; y: number }) => MotionEasing, hold?: CurveLayout) => {
    if (e.button !== 0 || !easing) return;
    e.preventDefault();
    e.stopPropagation();
    capture(e.currentTarget, e.pointerId);
    if (hold) setFrozen(hold);
    let last: MotionEasing | null = null;
    const onMove = (ev: PointerEvent) => {
      last = move(at(ev));
      onChange(last, false);
    };
    const onUp = () => {
      if (last) onChange(last, true);
      setFrozen(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  const handle = (which: 1 | 2, lay: CurveLayout) => (p: { x: number; y: number }): MotionEasing => {
    const b = (easing && bezierOf(easing)) ?? [0.5, 0, 0.5, 1];
    const x = r2(clamp(lay.p(p.x), 0, 1));
    const y = r2(lay.v(clamp(p.y, 0, GRAPH)));
    const n = which === 1 ? [x, y, b[2], b[3]] : [b[0], b[1], x, y];
    return { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: n[0], y1: n[1], x2: n[2], y2: n[3] } };
  };

  const springView = kind === "spring" || (!!shown && isSpring(shown));
  const dot = preview ? (springView ? { x0: springX(0), x1: springX(1), y0: springY(0), y1: springY(1) } : { x0: layout.x(0), x1: layout.x(1), y0: layout.y(0), y1: layout.y(1) }) : null;
  return (
    <svg ref={svg} className={styles.graph} viewBox={`0 0 ${GRAPH} ${GRAPH}`} width={GRAPH} height={GRAPH} role="img" aria-label={t("Easing curve")} data-easing-graph={shown?.type ?? "MIXED"} data-graph-kind={springView ? "spring" : "curve"}>
      {springView ? (
        <>
          <line className={styles.guide} x1={SPRING_X0} y1={SPRING_Y1} x2={SPRING_X1} y2={SPRING_Y1} data-guideline />
          {playhead != null && <line className={styles.guide} x1={springX(playhead)} y1={0} x2={springX(playhead)} y2={GRAPH} data-graph-playhead />}
          {shown && <path className={styles.curve} d={springPathOf(shown)} />}
          {shown &&
            (() => {
              const pk = springPeak(shown);
              return (
                <circle
                  className={styles.knob}
                  cx={springX(pk.p)}
                  cy={springY(pk.v)}
                  r={4}
                  data-handle="spring"
                  onPointerDown={editable ? (e) => drag(e, (p) => ({ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: bounceForPeak((springY(0) - clamp(p.y, 0, GRAPH)) / (springY(0) - springY(1))) } })) : undefined}
                />
              );
            })()}
        </>
      ) : (
        <>
          <line className={styles.guide} x1={layout.x(0)} y1={layout.y(0)} x2={layout.x(1)} y2={layout.y(0)} />
          <line className={styles.guide} x1={layout.x(0)} y1={layout.y(1)} x2={layout.x(1)} y2={layout.y(1)} />
          {playhead != null && <line className={styles.guide} x1={layout.x(playhead)} y1={0} x2={layout.x(playhead)} y2={GRAPH} data-graph-playhead />}
          {shown && <path className={styles.curve} d={curvePathOf(shown, layout)} />}
          {bezier && shown?.type !== "HOLD" && (
            <>
              <line className={styles.handleLine} x1={layout.x(0)} y1={layout.y(0)} x2={layout.x(bezier[0])} y2={layout.y(bezier[1])} />
              <line className={styles.handleLine} x1={layout.x(1)} y1={layout.y(1)} x2={layout.x(bezier[2])} y2={layout.y(bezier[3])} />
              <circle className={styles.knob} cx={layout.x(bezier[0])} cy={layout.y(bezier[1])} r={4} data-handle="1" onPointerDown={editable ? (e) => drag(e, handle(1, layout), layout) : undefined} />
              <circle className={styles.knob} cx={layout.x(bezier[2])} cy={layout.y(bezier[3])} r={4} data-handle="2" onPointerDown={editable ? (e) => drag(e, handle(2, layout), layout) : undefined} />
            </>
          )}
        </>
      )}
      {preview && dot && (
        // The hover preview [ours]: across in time, up with the curve's own timing function.
        <g key={JSON.stringify(preview)} className={styles.traceX} style={{ "--trace-x0": `${dot.x0}px`, "--trace-x1": `${dot.x1}px` } as CSSProperties} aria-hidden data-easing-preview={preview.type}>
          <circle className={styles.traceDot} r={3} style={{ "--trace-y0": `${dot.y0}px`, "--trace-y1": `${dot.y1}px`, animationTimingFunction: easingCss(preview) } as CSSProperties} />
        </g>
      )}
    </svg>
  );
}
