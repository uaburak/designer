import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cx } from "../util/cx";
import { rovingTarget } from "../util/rovingFocus";
import { Icon, type IconName } from "../icons/Icon";
import { tooltipProps } from "../overlay/TooltipManager";
import styles from "./Rail.module.css";

/**
 * The editor's navigation bar (contract §4.25, Figma 2026, measured live): 56 wide and a 1px line; the Figma menu
 * (a 32 tile at 12, 8), then tabs as 56 × 56 buttons — a 32 tile and, with View › Additional labels, the tab's
 * name under it (9/14) —, 16 separators with a 24 line; notifications at the bottom. ↑ ↓ move focus.
 */
export function Rail({ children, label = "Navigation", labels = true, className, ...rest }: { children: ReactNode; label?: string; labels?: boolean } & HTMLAttributes<HTMLElement>) {
  return (
    <nav
      aria-label={label}
      data-ds="Rail"
      data-labels={labels ? "" : undefined}
      className={cx(styles.rail, className)}
      onKeyDown={(e) => {
        const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-ds="RailItem"]')];
        const from = items.indexOf(document.activeElement as HTMLElement);
        if (from < 0) return;
        const next = rovingTarget(e.key, items.length, () => true, from, "vertical");
        if (next === null || next < 0) return;
        e.preventDefault();
        items[next].focus();
      }}
      {...rest}
    >
      {children}
    </nav>
  );
}

export function RailSeparator() {
  return <span role="separator" className={styles.separator} />;
}

/** Pushes what follows to the bottom of the bar (the file notifications). */
export function RailSpacer() {
  return <span className={styles.spacer} aria-hidden />;
}

export interface RailItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "onClick" | "children"> {
  icon: IconName;
  label: string;
  shortcut?: string;
  active: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  forceHover?: boolean;
  /** The Figma menu and the notifications: the tile alone, never a label */
  compact?: boolean;
  /** A blue dot on the tile (library updates) */
  badge?: boolean;
  /** Notifications: the tooltip's text when it says more than the label */
  tooltip?: string;
}

/** A tab: its tile (bg-selected and the brand icon while current) and, with labels on, its name under it; the name as a tooltip to the right. */
export function RailItem({ icon, label, shortcut, active, onClick, forceHover, compact, badge, tooltip, className, ...rest }: RailItemProps) {
  return (
    <button
      type="button"
      data-ds="RailItem"
      aria-label={label}
      aria-current={active || undefined}
      data-hover={forceHover || undefined}
      className={cx(styles.item, compact && styles.compact, className)}
      onClick={onClick}
      {...tooltipProps(tooltip ?? label, shortcut, "right")}
      {...rest}
    >
      <span className={styles.tile}>
        <Icon name={icon} />
        {badge && <span className={styles.badge} data-rail-badge="" />}
      </span>
      {!compact && <span className={styles.label}>{label}</span>}
    </button>
  );
}
