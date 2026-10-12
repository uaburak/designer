/**
 * The image tools over the canvas (docs/ai.md §4): the sweep over the layers a run works on (the agents' placeholder
 * look, with the run's progress), Select area's lasso (drawn in the layer's units, so it follows pan and zoom), and
 * Expand's frame with its blue handles. Canvas chrome: never the document's, never in undo. Rendered into the canvas's
 * own box (a portal), positioned from the camera.
 */
import { useCallback, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { Guid } from "@/engine/codec";
import { useEditor } from "../controller";
import { useStoreSlice } from "../uiStore";
import type { ImageTools } from "./controller";
import { cssMatrix, pageMatrix, toLayer, toScreen } from "./geometry";
import { insetsForAspect, type Insets, type Point } from "./pixels";
import styles from "./ImageTools.module.css";

/** Re-renders on camera and page changes. */
function useCameraVersion(): number {
  const ed = useEditor();
  const ref = useRef(0);
  const subscribe = useCallback(
    (cb: () => void) => {
      const bump = () => {
        ref.current++;
        cb();
      };
      const offs = [ed.store.subscribe("camera", bump), ed.store.subscribe("page", bump), ed.store.subscribe("selection", bump)];
      return () => offs.forEach((off) => off());
    },
    [ed]
  );
  return useSyncExternalStore(subscribe, () => ref.current);
}

function Sweep({ id, progress }: { id: Guid; progress?: number }) {
  const ed = useEditor();
  useCameraVersion();
  const node = ed.engine.readNode(id);
  if (!node?.size) return null;
  const cam = ed.store.camera;
  return (
    <div className={styles.sweep} data-image-tool-sweep={id} style={{ transform: cssMatrix(pageMatrix(ed, id), cam), width: node.size.x * cam.zoom, height: node.size.y * cam.zoom }}>
      {progress !== undefined && <div className={styles.progress} style={{ width: `${Math.round(progress * 100)}%` }} />}
    </div>
  );
}

function Lasso({ tools, target }: { tools: ImageTools; target: Guid }) {
  const ed = useEditor();
  useCameraVersion();
  const lasso = useStoreSlice(tools.state, (s) => s.lasso);
  const [drawing, setDrawing] = useState<Point[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const m = pageMatrix(ed, target);
  const cam = ed.store.camera;
  const local = (e: ReactPointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return toLayer(m, cam, { x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const pts = drawing ?? lasso;
  const d = pts.length ? `M ${pts.map((p) => toScreen(m, cam, p)).map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ")} Z` : "";
  return (
    <div
      ref={box}
      className={styles.lassoLayer}
      data-image-lasso=""
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrawing([local(e)]);
      }}
      onPointerMove={(e) => {
        if (!drawing) return;
        const p = local(e);
        const last = drawing[drawing.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) * cam.zoom >= 2) setDrawing([...drawing, p]);
      }}
      onPointerUp={() => {
        if (drawing) tools.state.set({ lasso: drawing.length >= 3 ? drawing : [] });
        setDrawing(null);
      }}
    >
      <svg aria-hidden>{d && <path className={styles.lassoPath} d={d} />}</svg>
    </div>
  );
}

const SIDES: { key: string; x: number; y: number; moves: (keyof Insets)[] }[] = [
  { key: "nw", x: 0, y: 0, moves: ["left", "top"] },
  { key: "n", x: 0.5, y: 0, moves: ["top"] },
  { key: "ne", x: 1, y: 0, moves: ["right", "top"] },
  { key: "e", x: 1, y: 0.5, moves: ["right"] },
  { key: "se", x: 1, y: 1, moves: ["right", "bottom"] },
  { key: "s", x: 0.5, y: 1, moves: ["bottom"] },
  { key: "sw", x: 0, y: 1, moves: ["left", "bottom"] },
  { key: "w", x: 0, y: 0.5, moves: ["left"] },
];

/** Expand's aspect ratios (Figma has a dropdown; its options aren't published — ours). */
export const EXPAND_ASPECTS: { value: string; label: string; ratio: number | null }[] = [
  { value: "freeform", label: "Freeform", ratio: null },
  { value: "1:1", label: "1:1", ratio: 1 },
  { value: "4:3", label: "4:3", ratio: 4 / 3 },
  { value: "3:4", label: "3:4", ratio: 3 / 4 },
  { value: "16:9", label: "16:9", ratio: 16 / 9 },
  { value: "9:16", label: "9:16", ratio: 9 / 16 },
];

export const padForAspect = (size: { x: number; y: number }, aspect: string): Insets => insetsForAspect(size.x, size.y, EXPAND_ASPECTS.find((a) => a.value === aspect)?.ratio ?? null);

function Expand({ tools, target }: { tools: ImageTools; target: Guid }) {
  const ed = useEditor();
  useCameraVersion();
  const pad = useStoreSlice(tools.state, (s) => s.pad);
  const node = ed.engine.readNode(target);
  const drag = useRef<{ x: number; y: number; pad: Insets; moves: (keyof Insets)[] } | null>(null);
  if (!node?.size) return null;
  const cam = ed.store.camera;
  const m = pageMatrix(ed, target);
  const z = cam.zoom;
  const w = node.size.x + pad.left + pad.right, h = node.size.y + pad.top + pad.bottom;
  return (
    <div className={styles.expandBox} data-image-expand="" style={{ transform: cssMatrix(m, cam), width: node.size.x * z, height: node.size.y * z }}>
      <div className={styles.expandFrame} style={{ left: -pad.left * z, top: -pad.top * z, width: w * z, height: h * z }}>
        {SIDES.map((s) => (
          <div
            key={s.key}
            className={styles.handle}
            data-expand-handle={s.key}
            style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, cursor: `${s.key}-resize` }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, y: e.clientY, pad, moves: s.moves };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              // Screen delta → the layer's axes (its rotation undone), in its units.
              const dx = (e.clientX - d.x) / z, dy = (e.clientY - d.y) / z;
              const sx = Math.hypot(m[0], m[3]) || 1, sy = Math.hypot(m[1], m[4]) || 1;
              const lx = (m[0] / sx) * dx + (m[3] / sx) * dy, ly = (m[1] / sy) * dx + (m[4] / sy) * dy;
              const next = { ...d.pad };
              if (d.moves.includes("left")) next.left = Math.max(0, Math.round(d.pad.left - lx));
              if (d.moves.includes("right")) next.right = Math.max(0, Math.round(d.pad.right + lx));
              if (d.moves.includes("top")) next.top = Math.max(0, Math.round(d.pad.top - ly));
              if (d.moves.includes("bottom")) next.bottom = Math.max(0, Math.round(d.pad.bottom + ly));
              tools.state.set({ pad: next, aspect: "freeform" });
            }}
            onPointerUp={() => (drag.current = null)}
          />
        ))}
      </div>
    </div>
  );
}

export function ImageCanvasOverlays({ tools }: { tools: ImageTools }) {
  const ed = useEditor();
  const busy = useStoreSlice(tools.state, (s) => s.busy);
  const mode = useStoreSlice(tools.state, (s) => s.mode);
  const target = useStoreSlice(tools.state, (s) => s.target);
  // The canvas's own box (the editor sets `canvas` before any tool can open).
  const host = ed.canvas?.parentElement ?? null;
  if (!host) return null;
  return createPortal(
    <>
      {busy && (
        <div className={styles.layer} aria-hidden>
          {busy.ids.map((id) => (
            <Sweep key={id} id={id} progress={busy.progress} />
          ))}
        </div>
      )}
      {!busy && mode === "select-area" && target && <Lasso tools={tools} target={target} />}
      {!busy && mode === "expand" && target && (
        <div className={styles.layer}>
          <Expand tools={tools} target={target} />
        </div>
      )}
    </>,
    host
  );
}
