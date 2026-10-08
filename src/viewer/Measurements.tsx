/**
 * Dev Mode's hover measurements: with a layer selected, hovering another shows the distances between the two as red
 * lines with their values (no ⌥ needed in Dev Mode; help.figma.com "Guide to inspecting"). Drawn over the canvas in
 * CSS pixels from the page boxes the viewer reads; the engine draws the selection and hover outlines itself.
 */
import { useMemo } from "react";
import { useCamera, useHover, useSelection } from "@/engine/hooks";
import { num } from "./inspect/model";
import { redlines } from "./inspect/measure";
import { useViewer } from "./context";
import styles from "./Viewer.module.css";

const LABEL_H = 16;

export function Measurements() {
  const { store, doc } = useViewer();
  const selection = useSelection(store);
  const hover = useHover(store);
  const camera = useCamera(store);
  const lines = useMemo(() => {
    if (!hover || !selection.refs.length || selection.refs.includes(hover)) return [];
    const s = doc.unionBox(selection.refs);
    const h = doc.pageBox(hover);
    return s && h ? redlines(s, h) : [];
  }, [doc, selection.refs, hover]);
  if (!lines.length) return null;
  const sx = (x: number) => x * camera.zoom + camera.x;
  const sy = (y: number) => y * camera.zoom + camera.y;
  return (
    <svg className={styles.measure} aria-hidden data-measurements={lines.filter((l) => !l.guide).map((l) => num(l.value)).join(",")}>
      {lines.map((l, i) => {
        const x1 = sx(l.x1);
        const y1 = sy(l.y1);
        const x2 = sx(l.x2);
        const y2 = sy(l.y2);
        if (l.guide) return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={styles.measureGuide} />;
        const text = num(l.value);
        const w = Math.max(20, text.length * 7 + 8);
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        const vertical = Math.abs(x1 - x2) < Math.abs(y1 - y2);
        const lx = vertical ? mx + 4 : mx - w / 2;
        const ly = vertical ? my - LABEL_H / 2 : my + 4;
        return (
          <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} className={styles.measureLine} />
            {vertical ? (
              <>
                <line x1={x1 - 3} y1={y1} x2={x1 + 3} y2={y1} className={styles.measureLine} />
                <line x1={x2 - 3} y1={y2} x2={x2 + 3} y2={y2} className={styles.measureLine} />
              </>
            ) : (
              <>
                <line x1={x1} y1={y1 - 3} x2={x1} y2={y1 + 3} className={styles.measureLine} />
                <line x1={x2} y1={y2 - 3} x2={x2} y2={y2 + 3} className={styles.measureLine} />
              </>
            )}
            <rect x={lx} y={ly} width={w} height={LABEL_H} rx={2} className={styles.measureLabel} />
            <text x={lx + w / 2} y={ly + LABEL_H / 2} className={styles.measureText}>
              {text}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
