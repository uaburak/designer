import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../util/cx";
import { initials } from "../util/geometry";
import { Icon, type IconName } from "../icons/Icon";
import { Button, IconButton } from "./Button";
import { showToast } from "./Toast";
import styles from "./Misc.module.css";

export type BadgeTone = "default" | "brand" | "component" | "danger" | "warning" | "success";

/** A 16px label (contract §4.29): tinted by tone; `count` uses body-small. */
export function Badge({ tone = "default", count, children, className, ...rest }: { tone?: BadgeTone; count?: boolean; children: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  return <span data-ds="Badge" className={cx(styles.badge, tone !== "default" && styles[tone], count && styles.count, className)} {...rest}>{children}</span>;
}

export { initials };

/** A person (contract §4.30): a photo, or initials in white on the brand blue. */
export function Avatar({ name, src, size = 24 }: { name: string; src?: string; size?: 16 | 24 | 32 }) {
  return (
    <span data-ds="Avatar" role="img" aria-label={name} className={cx(styles.avatar, styles[`a${size}`], src && styles.withImage)}>
      {src ? <img src={src} alt="" /> : initials(name, size === 16 ? 1 : 2)}
    </span>
  );
}

/** Nothing here yet (contract §4.32): an icon in a 48 circle, a title, a line, a secondary action. */
export function EmptyState({ icon, title, body, action, size = "panel" }: { icon?: IconName; title: string; body?: string; action?: { label: string; onClick: () => void }; size?: "panel" | "page" }) {
  return (
    <div data-ds="EmptyState" className={cx(styles.empty, size === "page" && styles.page)}>
      {icon && <span className={styles.emptyIcon}><Icon name={icon} /></span>}
      <span className={styles.emptyTitle}>{title}</span>
      {body && <span className={styles.emptyBody}>{body}</span>}
      {action && (
        <span className={styles.emptyAction} style={{ marginTop: 12 }}>
          <Button variant="secondary" onClick={action.onClick}>{action.label}</Button>
        </span>
      )}
    </div>
  );
}

export function Divider({ orientation = "horizontal", inset = 0, className }: { orientation?: "horizontal" | "vertical"; inset?: number; className?: string }) {
  return <hr data-ds="Divider" aria-orientation={orientation} className={cx(styles.divider, styles[orientation], className)} style={inset ? (orientation === "horizontal" ? { marginLeft: inset, marginRight: inset } : { marginTop: inset, marginBottom: inset }) : undefined} />;
}

/** An inline shortcut (format it with keys()). */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd data-ds="Kbd" className={styles.kbd}>{children}</kbd>;
}

/** Code to inspect and copy (contract §4.34). */
export function CodeBlock({ code, label = "Copy" }: { code: string; label?: string }) {
  return (
    <div data-ds="CodeBlock" className={styles.codeWrap}>
      <pre className={styles.code}>{code}</pre>
      <span className={styles.codeCopy}>
        <IconButton
          icon="24.copy.small"
          label={label}
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => showToast({ message: "Copied to clipboard" }));
          }}
        />
      </span>
    </div>
  );
}
