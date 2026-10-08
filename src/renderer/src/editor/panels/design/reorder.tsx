/**
 * Dragging a fill, stroke or export row to another place (Figma: the row's grip on hover, at its left edge): the
 * rows are the container's `[data-reorder-row]` children in display order; a line shows where the row goes; the
 * drop calls `onMove(from, to)` in display indices (`to`: the index the row ends up at).
 */
import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "@/ds";
import styles from "./Design.module.css";

/** Where a row dragged from `from` lands for a pointer at `y`, given the rows' vertical extents (display order). */
export function dropIndex(rows: readonly { top: number; bottom: number }[], from: number, y: number): number {
  let to = rows.length - 1;
  for (let i = 0; i < rows.length; i++) {
    if (y < (rows[i].top + rows[i].bottom) / 2) {
      to = i;
      break;
    }
  }
  // Below its own middle, a row moving down lands after the rows it passed.
  if (to > from && y < (rows[to].top + rows[to].bottom) / 2) to -= 1;
  return Math.max(0, Math.min(rows.length - 1, to));
}

/** Moves the item at `from` to `to` (both indices in the same order). */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

export function useReorder(onMove: (from: number, to: number) => void) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number; line: number | null } | null>(null);
  const extents = () => [...(container?.querySelectorAll<HTMLElement>("[data-reorder-row]") ?? [])].map((el) => el.getBoundingClientRect());
  const grip = (index: number) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDrag({ from: index, to: index, line: null });
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      if (!drag || drag.from !== index) return;
      const to = dropIndex(extents(), index, e.clientY);
      if (to === drag.to) return;
      const rows = extents();
      const box = container?.getBoundingClientRect();
      const r = rows[to];
      // The line where the row goes (px within the container).
      setDrag({ from: index, to, line: to === index || !r || !box ? null : (to > index ? r.bottom : r.top) - box.top });
    },
    onPointerUp: () => {
      if (drag && drag.from === index && drag.to !== drag.from) onMove(drag.from, drag.to);
      setDrag(null);
    },
    onPointerCancel: () => setDrag(null),
  });
  return { container: setContainer, grip, dragging: drag?.from ?? null, line: drag?.line ?? null };
}

/** The row's grip: shown while the row is hovered, at its left edge. */
export function Grip(props: ReturnType<ReturnType<typeof useReorder>["grip"]>) {
  return (
    <span className={styles.grip} aria-hidden data-reorder-grip="" {...props}>
      <Icon name="16.drag" />
    </span>
  );
}
