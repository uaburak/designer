import { capture, release } from "../util/pointer";
import { useRef, type HTMLAttributes } from "react";
import { cx } from "../util/cx";
import { size } from "../tokens";
import type { ChangeInfo } from "../types";
import styles from "./ResizeHandle.module.css";

export interface ResizeHandleProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  /** Which edge of its (position: relative) panel */
  side: "left" | "right";
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
  const sign = side === "right" ? 1 : -1;
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
      aria-hidden
      className={cx(styles.handle, styles[side], className)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        capture(e.currentTarget, e.pointerId);
        drag.current = { x: e.clientX, start: value, last: value };
        document.documentElement.setAttribute("data-cursor", "col-resize");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const next = clamp(d.start + sign * (e.clientX - d.x));
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
