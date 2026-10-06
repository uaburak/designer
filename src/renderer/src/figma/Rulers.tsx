/** Figma's rulers along the canvas's top and left: ticks at the view's zoom, the selection's span in blue. */

import { memo, useEffect, useRef } from "react";
import type { CanvasView } from "./view";
import type { Rect } from "./Canvas";

/** The rulers' thickness. */
export const RULER = 20;

/** One ruler drawn: its ticks at the view's zoom, the selection's span in blue (as Figma's). */
function drawRuler(canvas: HTMLCanvasElement | null, view: CanvasView, length: number, vertical: boolean, selected: Rect | null) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  const step = steps.find((st) => st * view.zoom >= 60) ?? 5000;
  canvas.width = (vertical ? RULER : length) * dpr;
  canvas.height = (vertical ? length : RULER) * dpr;
  const g = canvas.getContext("2d");
  if (!g) return;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, length, length);
  // The strip on the panel's own background (the editor's tokens), a hairline along its inner edge — as Figma's rulers.
  const tokens = getComputedStyle(canvas);
  const token = (name: string, fallback: string) => tokens.getPropertyValue(name).trim() || fallback;
  g.fillStyle = token("--f-bg", "#ffffff");
  g.fillRect(0, 0, length, length);
  g.fillStyle = token("--f-border", "#e6e6e6");
  if (vertical) g.fillRect(RULER - 1, 0, 1, length);
  else g.fillRect(0, RULER - 1, length, 1);
  g.font = "9px Inter, ui-sans-serif, system-ui";
  const origin = vertical ? view.y : view.x;
  const span = selected ? { from: (vertical ? selected.y : selected.x) - RULER, size: vertical ? selected.h : selected.w } : null;
  if (span) {
    g.fillStyle = "rgba(13, 153, 255, 0.12)";
    if (vertical) g.fillRect(0, span.from, RULER, span.size);
    else g.fillRect(span.from, 0, span.size, RULER);
  }
  g.fillStyle = token("--f-text-tertiary", "#b3b3b3");
  g.strokeStyle = token("--f-border", "#e6e6e6");
  const first = Math.floor(-origin / view.zoom / step) * step;
  for (let v = first; v * view.zoom + origin < length; v += step) {
    const at = Math.round(v * view.zoom + origin) + 0.5;
    g.beginPath();
    if (vertical) { g.moveTo(RULER - 6, at); g.lineTo(RULER, at); } else { g.moveTo(at, RULER - 6); g.lineTo(at, RULER); }
    g.stroke();
    if (vertical) {
      g.save();
      g.translate(4, at - 3);
      g.rotate(-Math.PI / 2);
      g.fillText(String(v), 0, 8);
      g.restore();
    } else g.fillText(String(v), at + 3, 9);
  }
  if (span) {
    const a = Math.round((span.from - origin) / view.zoom);
    const b = Math.round((span.from + span.size - origin) / view.zoom);
    g.fillStyle = "#0d99ff";
    g.font = "600 9px Inter, ui-sans-serif, system-ui";
    if (vertical) {
      for (const [val, at] of [[a, span.from], [b, span.from + span.size]] as const) {
        g.save();
        g.translate(4, at - 3);
        g.rotate(-Math.PI / 2);
        g.fillText(String(val), 0, 8);
        g.restore();
      }
    } else {
      g.fillText(String(a), span.from - g.measureText(String(a)).width - 3, 9);
      g.fillText(String(b), span.from + span.size + 3, 9);
    }
  }
}

/** Figma's rulers: a strip along the top and the left. */
export const Rulers = memo(function Rulers({ view, width, height, selected }: { view: CanvasView; width: number; height: number; selected: Rect | null }) {
  const top = useRef<HTMLCanvasElement>(null);
  const left = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    drawRuler(top.current, view, width, false, selected);
    drawRuler(left.current, view, height, true, selected);
  }, [view, width, height, selected]);
  return (
    <>
      <canvas ref={top} aria-hidden className="pointer-events-none absolute top-0 z-20" style={{ left: RULER, width: width, height: RULER }} />
      <canvas ref={left} aria-hidden className="pointer-events-none absolute left-0 z-20" style={{ top: RULER, width: RULER, height: height }} />
      <div aria-hidden className="pointer-events-none absolute left-0 top-0 z-20 bg-[var(--f-bg)] border-r border-b border-[var(--f-border)]" style={{ width: RULER, height: RULER }} />
    </>
  );
});
