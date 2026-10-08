import { capture } from "../util/pointer";
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { cx } from "../util/cx";
import { Portal } from "../overlay/Portal";
import { useDismiss } from "../overlay/useDismiss";
import { useFocusScope } from "../overlay/FocusTrap";
import { EDGE, place } from "../overlay/position";
import { size } from "../tokens";
import { STRINGS } from "../strings";
import { IconButton } from "./Button";
import styles from "./Popover.module.css";

export type PopoverPlacement = "left-of-panel" | "bottom-start" | "bottom" | "top" | "right";

export interface PopoverProps {
  anchor: DOMRect | HTMLElement | null;
  placement?: PopoverPlacement;
  /** With a title it is a FloatingPanel: a 40px header, draggable by it */
  title?: string;
  /** A header of its own instead of the title (the ColorPicker's tabs); × still closes */
  header?: ReactNode;
  headerActions?: ReactNode;
  onClose: () => void;
  /** default: true when titled */
  draggable?: boolean;
  width?: number;
  static?: boolean;
  children?: ReactNode;
  /** Accessible name without a title */
  label?: string;
}

/**
 * A non-modal panel (contract §4.21): 13px corners, elevation 400, 240 wide.
 * `left-of-panel` (property popovers) opens left of the right panel, level
 * with the anchor row. Esc or a press outside closes it; focus goes to its
 * first field (not trapped: the canvas stays clickable).
 */
export function Popover({ anchor, placement = "left-of-panel", title, header, headerActions, onClose, draggable, width = size.popover, static: isStatic, children, label }: PopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const dragged = useRef(false);
  // A press on the anchor is the trigger's own (it toggles the popover): not "outside".
  useDismiss(panel, onClose, { enabled: !isStatic, ignore: anchor instanceof HTMLElement ? anchor : null });
  useFocusScope(panel, { enabled: !isStatic });
  useLayoutEffect(() => {
    const el = panel.current;
    if (isStatic || !el || !anchor || dragged.current) return;
    const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
    const view = { width: window.innerWidth, height: window.innerHeight };
    let x: number;
    let y: number;
    if (placement === "left-of-panel") {
      // The right panel's left edge: the anchor's panel (closest [data-panel]) or the anchor itself.
      const panelEl = anchor instanceof HTMLElement ? anchor.closest<HTMLElement>("[data-panel]") : null;
      const left = panelEl ? panelEl.getBoundingClientRect().left : r.left;
      x = Math.max(EDGE, left - el.offsetWidth - 8);
      y = Math.max(EDGE, Math.min(r.top, view.height - EDGE - el.offsetHeight));
    } else {
      const side = placement === "bottom-start" ? "bottom" : placement;
      const p = place(r, { width: el.offsetWidth, height: el.offsetHeight }, view, side, placement === "bottom-start" ? "start" : "center", 8);
      x = p.x;
      y = p.y;
    }
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.visibility = "visible";
  }, [anchor, placement, isStatic]);

  const canDrag = (draggable ?? Boolean(title || header)) && !isStatic;
  const box = (
    <div
      ref={panel}
      role="dialog"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : label}
      tabIndex={-1}
      data-ds="Popover"
      className={cx(styles.popover, isStatic && styles.static)}
      style={{ width, ...(isStatic ? null : { left: 0, top: 0, visibility: "hidden" as const }) }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {(title || header) && (
        <div
          className={cx(styles.header, canDrag && styles.draggable)}
          onPointerDown={(e) => {
            const el = panel.current;
            // (A press in an overlay the header opened — a Select's list — bubbles here through the portal: not a drag.)
            if (!canDrag || !el || e.button !== 0 || !e.currentTarget.contains(e.target as Node) || (e.target as Element).closest("button,input,[role=tab],[role=combobox]")) return;
            capture(e.currentTarget, e.pointerId);
            const start = { x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop };
            const move = (ev: PointerEvent) => {
              dragged.current = true;
              el.style.left = `${start.left + ev.clientX - start.x}px`;
              el.style.top = `${start.top + ev.clientY - start.y}px`;
            };
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        >
          {header ? <div className={styles.headerContent}>{header}</div> : <h2 id={titleId} className={styles.title}>{title}</h2>}
          {headerActions}
          <IconButton icon="24.close.small" label={STRINGS.close} tooltip={false} onClick={onClose} />
        </div>
      )}
      <div className={styles.body}>{children}</div>
    </div>
  );
  if (isStatic) return box;
  return <Portal anchor={anchor instanceof HTMLElement ? anchor : null}>{box}</Portal>;
}

/** A Popover with a header (the contract's FloatingPanel). */
export function FloatingPanel(props: PopoverProps & { title: string }) {
  return <Popover {...props} />;
}
