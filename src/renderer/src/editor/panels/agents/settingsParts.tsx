/** Agent settings' building blocks (AgentSettings.tsx, aiSettings.tsx): the list's groups and rows, a page's blocks and fields. */
import type { ReactNode } from "react";
import { Icon, cx, tooltipProps, type IconName } from "@/ds";
import styles from "./Agents.module.css";

export const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.group} aria-label={title}>
      <h3 className={styles.groupTitle}>{title}</h3>
      <div role="list">{children}</div>
    </section>
  );
}

/** `mark`: drawn in the icon's place (an agent's own logo) */
type RowProps = { icon: IconName; mark?: ReactNode; label: string; badge?: ReactNode; status?: string; on?: boolean; dim?: boolean; onClick: () => void; statusProps?: Record<string, string> } & Record<`data-${string}`, string | undefined>;

export function Row({ icon, mark, label, badge, status, on, dim, onClick, statusProps, ...data }: RowProps) {
  return (
    <div role="listitem" className={styles.rowItem}>
      <button type="button" className={cx(styles.row, dim && styles.rowDim)} onClick={onClick} {...data}>
        <span className={cx(styles.rowIcon, mark !== undefined && styles.rowMark)}>{mark ?? <Icon name={icon} />}</span>
        <span className={styles.rowLabel}>{label}</span>
        {badge}
        {status && (
          <span className={styles.rowStatus}>
            {on && <span className={cx(styles.dot, styles.dotOn)} />}
            <span {...statusProps}>{status}</span>
          </span>
        )}
        <span className={styles.rowChevron}><Icon name="16.chevron.right" /></span>
      </button>
    </div>
  );
}

/** A labelled line of an item's page: "Status  ● Connected". */
export function Field({ label, children, ...data }: { label: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <div className={styles.field} {...data}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldValue}>{children}</span>
    </div>
  );
}

/**
 * A path on this computer, read whole however narrow the page: the home folder as "~", the middle cut, never its
 * last part ("~/.local/bi…/antigravity"); the whole path in its tooltip, and selectable to copy.
 */
export function PathText({ path }: { path: string }) {
  const shown = path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
  const cut = shown.lastIndexOf("/", shown.length - 2);
  const head = cut > 0 ? shown.slice(0, cut) : "";
  const tail = cut > 0 ? shown.slice(cut) : shown;
  return (
    <span className={styles.path} data-path={path} {...tooltipProps(path)}>
      {head && <span className={styles.pathHead}>{head}</span>}
      <span className={styles.pathTail}>{tail}</span>
    </span>
  );
}

export function Block({ title, children, ...data }: { title?: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <section className={styles.block} {...data}>
      {title && <h3 className={styles.blockTitle}>{title}</h3>}
      {children}
    </section>
  );
}
