import { Children, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../util/cx";
import { Icon } from "../icons/Icon";
import styles from "./PanelSection.module.css";

export interface PanelSectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: string;
  /** Icon buttons at the right (24 each, no gap) */
  actions?: ReactNode;
  /** No fills / strokes / effects: the title in text-secondary, only "+" should be passed as an action */
  empty?: boolean;
  /** A chevron before the title folds it (Pages) */
  collapsible?: boolean;
  open?: boolean;
  /** `alt`: Alt-click (fold all) */
  onOpenChange?: (open: boolean, alt: boolean) => void;
  pad?: "none" | "default" | "large";
  children?: ReactNode;
}

/** A panel section (contract §4.15): a 40px header (title at x+16, actions 8 from the right), its rows, a line under it. */
export function PanelSection({ title, actions, empty, collapsible, open = true, onOpenChange, pad = "default", children, className, ...rest }: PanelSectionProps) {
  const showBody = !collapsible || open;
  // Rows only: `{cond && <Row />}` that rendered nothing doesn't count (no bottom padding: a 41 high section).
  const hasBody = showBody && Children.toArray(children).length > 0;
  return (
    <section
      data-ds="PanelSection"
      aria-label={title}
      className={cx(styles.section, collapsible && styles.collapsible, collapsible && !open && styles.closed, empty && styles.empty, hasBody && pad === "default" && styles.padDefault, hasBody && pad === "large" && styles.padLarge, className)}
      {...rest}
    >
      <div className={styles.header}>
        {collapsible ? (
          <button type="button" className={styles.toggle} aria-expanded={open} onClick={(e) => onOpenChange?.(!open, e.altKey)}>
            <span className={styles.chevron}><Icon name="16.chevron.down" /></span>
            <span className={styles.title}>{title}</span>
          </button>
        ) : (
          <span className={styles.title}>{title}</span>
        )}
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      {showBody && children}
    </section>
  );
}
