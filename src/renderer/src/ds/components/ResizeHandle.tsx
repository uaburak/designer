import { capture, release } from "../util/pointer";
import { useRef, type HTMLAttributes } from "react";
import { cx } from "../util/cx";
import { size } from "../tokens";
import type { ChangeInfo } from "../types";
import styles from "./ResizeHandle.module.css";

export interface ResizeHandleProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  /** Which edge of its (position: relative) panel; "bottom": a section's lower edge (the Pages list), dragged up and down */
  side: "left" | "right" | "bottom";
  value: number;
  min?: number;
  max?: number;
  /** Double click resets to it */
  defaultValue?: number;
  /** `final: false` while dragging, one `final: true` on release */
  onChange: (px: number, info: ChangeInfo) => void;
}

/**
 * A panel's resize edge (contract §4.19): an invisible 8px hit area centred
 * on its border, col-resize (forced over the whole page while dragging);
 * drag to resize, double click to reset. No keyboard and no hover look, as
 * Figma's.
 */
export function ResizeHandle({ side, value, min = size["panel-min"], max = size["panel-max"], defaultValue = size.panel, onChange, className, ...rest }: ResizeHandleProps) {
  const drag = useRef<{ x: number; start: number; last: number } | null>(null);
  const sign = side === "left" ? -1 : 1;
  const vertical = side === "bottom";
  const cursor = vertical ? "row-resize" : "col-resize";
  const at = (e: { clientX: number; clientY: number }) => (vertical ? e.clientY : e.clientX);
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));
  const end = (el: HTMLElement, id: number) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    release(el, id);
    document.documentElement.removeAttribute("data-cursor");
    onChange(d.last, { final: true, source: "drag" });
  };
  return (
    <div
      data-ds="ResizeHandle"
      // Live (left/rail-assets.txt, layers-row-hover.txt): "slider [Resize handle]", 8 across the panel's edge.
      role="slider"
      aria-label="Resize handle"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      className={cx(styles.handle, styles[side], className)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        capture(e.currentTarget, e.pointerId);
        drag.current = { x: at(e), start: value, last: value };
        document.documentElement.setAttribute("data-cursor", cursor);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const next = clamp(d.start + sign * (at(e) - d.x));
        if (next !== d.last) {
          d.last = next;
          onChange(next, { final: false, source: "drag" });
        }
      }}
      onPointerUp={(e) => end(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => end(e.currentTarget, e.pointerId)}
      onDoubleClick={() => onChange(defaultValue, { final: true, source: "drag" })}
      {...rest}
    />
  );
}
