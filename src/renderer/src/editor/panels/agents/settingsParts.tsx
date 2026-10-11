/** Agent settings' building blocks (AgentSettings.tsx, aiSettings.tsx): the list's groups and rows, a page's blocks and fields. */
import type { ReactNode } from "react";
import { Icon, cx, type IconName } from "@/ds";
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

type RowProps = { icon: IconName; label: string; status?: string; on?: boolean; dim?: boolean; onClick: () => void; statusProps?: Record<string, string> } & Record<`data-${string}`, string | undefined>;

export function Row({ icon, label, status, on, dim, onClick, statusProps, ...data }: RowProps) {
  return (
    <div role="listitem" className={styles.rowItem}>
      <button type="button" className={cx(styles.row, dim && styles.rowDim)} onClick={onClick} {...data}>
        <span className={styles.rowIcon}><Icon name={icon} /></span>
        <span className={styles.rowLabel}>{label}</span>
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

export function Block({ title, children, ...data }: { title?: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <section className={styles.block} {...data}>
      {title && <h3 className={styles.blockTitle}>{title}</h3>}
      {children}
    </section>
  );
}
