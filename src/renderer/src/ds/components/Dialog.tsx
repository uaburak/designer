import { useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { cx } from "../util/cx";
import { Portal } from "../overlay/Portal";
import { useFocusScope } from "../overlay/FocusTrap";
import { startHeaderDrag } from "../overlay/drag";
import { STRINGS } from "../strings";
import { t, useT } from "@/i18n";
import { IconButton } from "./Button";
import styles from "./Dialog.module.css";

export interface DialogProps {
  title: string;
  /** 320 / 480 / 640 */
  size?: "small" | "medium" | "large";
  open: boolean;
  onClose: () => void;
  footer?: ReactNode;
  children?: ReactNode;
  /** Else `[data-autofocus]`, else the first field, else the panel. Enter clicks the primary (or destructive) Button. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** default true */
  closeOnScrim?: boolean;
  /** Drawn in place, no scrim (the Gallery) */
  static?: boolean;
  /**
   * Figma's draggable modals (Manage libraries, Export): moved by the header, kept in the window, centred again when
   * reopened (`startHeaderDrag`).
   */
  draggable?: boolean;
  /** `small`: a 40 high header with an 11 / 550 title (live Manage libraries; Figma's draggable modals) */
  header?: "default" | "small";
  /** A class on the panel (a dialog's own size) */
  className?: string;
}

/**
 * A modal dialog (contract §4.20): the scrim; a 13px-cornered panel with a
 * 48px header (title, ×), the body, a footer of large buttons. Focus is
 * trapped and comes back on close; Esc closes; Enter activates the primary
 * button (not from a text area or a menu). No open animation.
 */
export function Dialog({ title, size = "small", open, onClose, footer, children, initialFocus, closeOnScrim = true, static: isStatic, draggable = false, header = "default", className }: DialogProps) {
  useT();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusScope(panel, { trap: true, initialFocus, enabled: open && !isStatic });
  // A drag's offset from the centred place (a translate: the scrim keeps centring it); dropped when it closes.
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setOffset(null);
  }
  if (!open) return null;
  const canDrag = draggable && !isStatic;
  const box = (
    <div
      ref={panel}
      role="dialog"
      aria-modal={!isStatic}
      aria-labelledby={titleId}
      tabIndex={-1}
      data-ds="Dialog"
      className={cx(styles.dialog, styles[size], isStatic && styles.static, className)}
      style={offset ? { translate: `${offset.x}px ${offset.y}px` } : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        } else if (e.key === "Enter" && !(e.target as Element).closest("textarea,[role=menu],[role=listbox],button")) {
          const primary = panel.current?.querySelector<HTMLButtonElement>('[data-autofocus]:not(:disabled),[data-ds="Button"][data-variant="primary"]:not(:disabled),[data-ds="Button"][data-variant="destructive"]:not(:disabled)');
          if (primary) {
            e.preventDefault();
            primary.click();
          }
        }
      }}
    >
      <div
        className={cx(styles.header, header === "small" && styles.headerSmall, canDrag && styles.draggable)}
        onPointerDown={(e) => {
          const el = panel.current;
          if (!canDrag || !el) return;
          const r = el.getBoundingClientRect();
          const base = { x: r.left - (offset?.x ?? 0), y: r.top - (offset?.y ?? 0) };
          startHeaderDrag(e, el, (x, y) => setOffset({ x: x - base.x, y: y - base.y }));
        }}
      >
        <h2 id={titleId} className={styles.title}>{title}</h2>
        <IconButton icon="24.close.small" label={t(STRINGS.close)} tooltip={false} onClick={onClose} />
      </div>
      {children !== undefined && <div className={styles.body}>{children}</div>}
      {footer && <div className={styles.footer}>{footer}</div>}
    </div>
  );
  if (isStatic) return box;
  return (
    <Portal>
      <div className={styles.scrim} onPointerDown={(e) => closeOnScrim && e.target === e.currentTarget && onClose()}>
        {box}
      </div>
    </Portal>
  );
}
