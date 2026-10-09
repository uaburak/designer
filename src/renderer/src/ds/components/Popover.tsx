import { capture } from "../util/pointer";
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { cx } from "../util/cx";
import { Portal } from "../overlay/Portal";
import { useDismiss } from "../overlay/useDismiss";
import { useFocusScope } from "../overlay/FocusTrap";
import { EDGE, place } from "../overlay/position";
import { size } from "../tokens";
import { STRINGS } from "../strings";

/** Live capture: popovers keep 16 from the window's bottom (they all end at 884 of 900). */
const BOTTOM = 16;
import { IconButton } from "./Button";
import styles from "./Popover.module.css";

/** `left`: flush against the anchor's left side, level with its top (live: the Shader fills browser beside the picker) */
export type PopoverPlacement = "left-of-panel" | "left" | "bottom-start" | "bottom" | "top" | "right";

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
  /**
   * `left-of-panel` only: pixels added to x. Live's colour picker, shader browsers and effect settings sit one further
   * left than the other panel popovers (popovers/fill-picker-*.txt, effect-settings-*.txt at 959; stroke, type, font,
   * auto layout, export, layout guide at 960): those pass -1.
   */
  offsetX?: number;
  /**
   * `left-of-panel` only: pixels added to the anchor's top. Live's Auto layout settings opens level with its 32 high row,
   * 4 above its button (popovers/autolayout-advanced-settings.txt: 481 for the button at 485): it passes -4.
   */
  offsetY?: number;
  /**
   * `left-of-panel` only: placed as if at least this tall (it may grow to it). Live's Text styles opens at 427 from its
   * button at 586, 165 high (popovers/typography-styles.txt): as if 457 high above the window's 16 bottom margin
   * (the reason — room kept for the list of text styles — is unverified).
   */
  reserveHeight?: number;
}

/**
 * A non-modal panel (contract §4.21): 13px corners, elevation 400, 240 wide.
 * `left-of-panel` (property popovers) opens left of the right panel, level
 * with the anchor row. Esc or a press outside closes it; focus goes to its
 * first field (not trapped: the canvas stays clickable).
 */
export function Popover({ anchor, placement = "left-of-panel", title, header, headerActions, onClose, draggable, width = size.popover, static: isStatic, children, label, offsetX = 0, offsetY = 0, reserveHeight = 0 }: PopoverProps) {
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
      // Live capture (popovers/*.txt, 1440 wide): flush with the panel's content (x 960 = 1200 − 240), level with the
      // anchor row, at most 16 from the window's bottom (every tall popover ends at 884).
      // (A rect anchor — a fill row's swatch — finds its panel by the point.)
      const holds = (el: Element) => {
        const b = el.getBoundingClientRect();
        return r.left + 1 >= b.left && r.left + 1 <= b.right && r.top + 1 >= b.top && r.top + 1 <= b.bottom;
      };
      const panelEl = anchor instanceof HTMLElement ? anchor.closest<HTMLElement>("[data-panel]") : ([...document.querySelectorAll<HTMLElement>("[data-panel]")].find(holds) ?? null);
      const left = panelEl ? panelEl.getBoundingClientRect().left + panelEl.clientLeft : r.left - 8;
      x = Math.max(EDGE, left - el.offsetWidth + offsetX);
      y = Math.max(EDGE, Math.min(r.top + offsetY, view.height - BOTTOM - Math.max(el.offsetHeight, reserveHeight)));
    } else if (placement === "left") {
      x = Math.max(EDGE, r.left - el.offsetWidth);
      y = Math.max(EDGE, Math.min(r.top + offsetY, view.height - BOTTOM - el.offsetHeight));
    } else {
      const side = placement === "bottom-start" ? "bottom" : placement;
      const p = place(r, { width: el.offsetWidth, height: el.offsetHeight }, view, side, placement === "bottom-start" ? "start" : "center", 8);
      x = p.x;
      y = p.y;
    }
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.visibility = "visible";
  }, [anchor, placement, isStatic, offsetX, reserveHeight]);
  // Live Figma: content that grows (another paint type, a tab) moves the popover up to stay on screen; shrinking
  // content leaves it where it is.
  useLayoutEffect(() => {
    const el = panel.current;
    if (isStatic || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (dragged.current || el.style.visibility !== "visible") return;
      const top = el.offsetTop;
      const over = top + el.offsetHeight - (window.innerHeight - BOTTOM);
      if (over > 0) el.style.top = `${Math.max(EDGE, top - over)}px`;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isStatic]);

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
