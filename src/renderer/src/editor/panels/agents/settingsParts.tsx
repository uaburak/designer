/** Agent settings' building blocks (AgentSettings.tsx, aiSettings.tsx): the list's groups and rows, a page's blocks and fields. */
import type { KeyboardEvent, ReactNode } from "react";
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

/**
 * Agent settings' look in the panel (PanelSettings.tsx): a small label (and its action) over flat rows on the panel's
 * background — no box, no lines between rows — and an optional note under them.
 */
export function SettingsGroup({ label, action, note, children, ...data }: { label?: string; action?: ReactNode; note?: ReactNode; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <section className={styles.mSection} {...data}>
      {(label || action) && (
        <div className={styles.mSectionHead}>
          {label && <h3 className={styles.popSectionLabel}>{label}</h3>}
          {action}
        </div>
      )}
      <div className={styles.mList} data-settings-list="">{children}</div>
      {note && <p className={styles.mNote}>{note}</p>}
    </section>
  );
}

/** A row that opens a page: its icon, its name, a chevron. */
export function NavRow({ icon, title, onClick, ...data }: { icon: IconName; title: string; onClick: () => void } & Record<`data-${string}`, string | undefined>) {
  return (
    <button type="button" className={cx(styles.mRow, styles.mRowNav, styles.mRowLink)} onClick={onClick} {...data}>
      <span className={styles.mRowIcon}><Icon name={icon} /></span>
      <span className={styles.mRowText}>
        <span className={styles.mRowTitle}>{title}</span>
      </span>
      <span className={styles.rowChevron}><Icon name="16.chevron.right" /></span>
    </button>
  );
}

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * A row of a SettingsGroup: its mark or icon, its name (and one secondary line under it), what it holds at the right.
 * `onClick`: the whole row opens its detail (a chevron at the end); the controls in it work without opening it.
 */
export function SettingsRow({ icon, mark, title, badge, desc, dim, onClick, chevron = true, children, ...data }: { icon?: IconName; mark?: ReactNode; title: ReactNode; badge?: ReactNode; desc?: ReactNode; dim?: boolean; onClick?: () => void; chevron?: boolean; children?: ReactNode } & Record<`data-${string}`, string | undefined>) {
  const link = onClick
    ? {
        role: "button",
        tabIndex: 0,
        onClick,
        onKeyDown: (e: KeyboardEvent) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          onClick();
        },
        "data-settings-link": "",
      }
    : {};
  return (
    <div className={cx(styles.mRow, onClick && styles.mRowLink, dim && styles.mRowDim)} {...link} {...data}>
      {(mark || icon) && <span className={styles.mRowIcon}>{mark ?? <Icon name={icon!} />}</span>}
      <span className={styles.mRowText}>
        <span className={styles.mRowLine}>
          <span className={styles.mRowTitle}>{title}</span>
          {badge}
        </span>
        {desc && <span className={styles.mRowDesc}>{desc}</span>}
      </span>
      {children && (
        <span className={styles.mRowEnd} onClick={stop} onKeyDown={stop}>
          {children}
        </span>
      )}
      {onClick && chevron && <span className={styles.rowChevron}><Icon name="16.chevron.right" /></span>}
    </div>
  );
}
