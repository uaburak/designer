import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../util/cx";
import { Icon, type IconName } from "../icons/Icon";
import { STRINGS } from "../strings";
import { Button, IconButton } from "./Button";
import styles from "./Banner.module.css";

export type BannerTone = "default" | "brand" | "warning" | "danger";

export interface BannerProps extends HTMLAttributes<HTMLDivElement> {
  tone?: BannerTone;
  /** Default: info for default/brand, warning for warning/danger; null for none */
  icon?: IconName | null;
  children: ReactNode;
  /** A text button at the end ("Empty trash", "Update") */
  action?: { label: string; onClick: () => void };
  /** Shows the × */
  onDismiss?: () => void;
}

/**
 * A notice inside a page or panel (Home's Trash: "Files in trash are…";
 * a library update): a tinted strip, radius 5, body-medium text with an
 * optional action and ×. Not a toast — it stays until the page changes.
 * `role="status"` (danger: `alert`).
 */
export function Banner({ tone = "default", icon, children, action, onDismiss, className, ...rest }: BannerProps) {
  const glyph = icon === null ? null : icon ?? (tone === "warning" || tone === "danger" ? "24.warning" : "24.info");
  return (
    <div data-ds="Banner" data-tone={tone} role={tone === "danger" ? "alert" : "status"} className={cx(styles.banner, styles[tone], className)} {...rest}>
      {glyph && <span className={styles.icon}><Icon name={glyph} /></span>}
      <span className={styles.text}>{children}</span>
      {action && <Button variant="ghost" className={styles.action} onClick={action.onClick}>{action.label}</Button>}
      {onDismiss && <IconButton icon="24.close.small" label={STRINGS.dismiss} tooltip={false} onClick={onDismiss} />}
    </div>
  );
}
