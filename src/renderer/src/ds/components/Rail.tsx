import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../util/cx";
import { rovingTarget } from "../util/rovingFocus";
import { Icon, type IconName } from "../icons/Icon";
import { tooltipProps } from "../overlay/TooltipManager";
import styles from "./Rail.module.css";

/** The editor's left rail (contract §4.25): 48 wide, 32 items at a 40 pitch, 16×1 separators; ↑ ↓ move focus. */
export function Rail({ children, label = "Navigation", className, ...rest }: { children: ReactNode; label?: string } & HTMLAttributes<HTMLElement>) {
  return (
    <nav
      aria-label={label}
      data-ds="Rail"
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

export interface RailItemProps {
  icon: IconName;
  label: string;
  shortcut?: string;
  active: boolean;
  onClick?: () => void;
  forceHover?: boolean;
}

/** A rail tile: the current one bg-selected (#394360 dark); its name as a tooltip to the right. */
export function RailItem({ icon, label, shortcut, active, onClick, forceHover }: RailItemProps) {
  return (
    <button type="button" data-ds="RailItem" aria-label={label} aria-current={active || undefined} data-hover={forceHover || undefined} className={styles.item} onClick={onClick} {...tooltipProps(label, shortcut, "right")}>
      <Icon name={icon} />
    </button>
  );
}
