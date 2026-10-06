import { useId, useRef, type ReactNode, type RefObject } from "react";
import { cx } from "../util/cx";
import { Portal } from "../overlay/Portal";
import { useFocusScope } from "../overlay/FocusTrap";
import { STRINGS } from "../strings";
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
}

/**
 * A modal dialog (contract §4.20): the scrim; a 13px-cornered panel with a
 * 48px header (title, ×), the body, a footer of large buttons. Focus is
 * trapped and comes back on close; Esc closes; Enter activates the primary
 * button (not from a text area or a menu). No open animation.
 */
export function Dialog({ title, size = "small", open, onClose, footer, children, initialFocus, closeOnScrim = true, static: isStatic }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusScope(panel, { trap: true, initialFocus, enabled: open && !isStatic });
  if (!open) return null;
  const box = (
    <div
      ref={panel}
      role="dialog"
      aria-modal={!isStatic}
      aria-labelledby={titleId}
      tabIndex={-1}
      data-ds="Dialog"
      className={cx(styles.dialog, styles[size], isStatic && styles.static)}
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
      <div className={styles.header}>
        <h2 id={titleId} className={styles.title}>{title}</h2>
        <IconButton icon="24.close.small" label={STRINGS.close} tooltip={false} onClick={onClose} />
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
