import { Fragment, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../util/cx";
import { Icon, ICON_NAMES, type IconName } from "../icons/Icon";
import { MenuButton, type MenuEntry } from "./Menu";
import styles from "./Breadcrumb.module.css";

export type Crumb = {
  id: string;
  label: string;
  /** A 16/24 glyph by name, or a node (a FolderIcon, a FileKindIcon) */
  icon?: IconName | ReactNode;
};

export interface BreadcrumbProps extends Omit<HTMLAttributes<HTMLElement>, "onSelect"> {
  /** From the root to the current place; the last one is where you are */
  items: Crumb[];
  /** An ancestor was clicked (or picked from the collapsed "…" menu) */
  onNavigate: (id: string) => void;
  /** The current place's own menu (Figma's folder title chevron: Rename, Move…, Delete) */
  menu?: MenuEntry[];
  onMenuSelect?: (id: string) => void;
  /** More crumbs than this fold the middle ones into a "…" menu (default 4; the first and the last two stay) */
  maxItems?: number;
  /** Home's top bar uses body-large (13); panels use body-medium */
  size?: "default" | "large";
  label?: string;
}

function CrumbIcon({ icon }: { icon: IconName | ReactNode }) {
  return <span className={styles.icon}>{typeof icon === "string" && (ICON_NAMES as string[]).includes(icon) ? <Icon name={icon as IconName} /> : icon}</span>;
}

/**
 * Where you are (Home's top bar: "Team / Folder / Subfolder ⌄"): ancestors
 * are quiet buttons in the secondary text colour, parted by "/"; the current
 * place is primary and, with `menu`, opens its own menu. Long paths fold
 * their middle into "…". The last crumb carries `aria-current="page"`.
 */
export function Breadcrumb({ items, onNavigate, menu, onMenuSelect, maxItems = 4, size = "large", label = "Breadcrumb", className, ...rest }: BreadcrumbProps) {
  const fold = items.length > Math.max(3, maxItems);
  const hidden = fold ? items.slice(1, items.length - 2) : [];
  const shown: (Crumb | "…")[] = fold ? [items[0], "…", ...items.slice(-2)] : items;
  return (
    <nav data-ds="Breadcrumb" aria-label={label} className={cx(styles.root, size === "large" && styles.large, className)} {...rest}>
      <ol className={styles.list}>
        {shown.map((c, i) => {
          const last = i === shown.length - 1;
          return (
            <Fragment key={c === "…" ? "fold" : c.id}>
              {i > 0 && <li aria-hidden className={styles.separator}>/</li>}
              <li className={cx(styles.item, last && styles.currentItem)}>
                {c === "…" ? (
                  <MenuButton label="Show path" className={styles.crumb} entries={hidden.map((h) => ({ id: h.id, label: h.label }))} onSelect={onNavigate}>
                    …
                  </MenuButton>
                ) : last ? (
                  menu?.length ? (
                    <MenuButton label={`${c.label} menu`} className={cx(styles.crumb, styles.current)} entries={menu} onSelect={(id) => onMenuSelect?.(id)}>
                      {c.icon !== undefined && <CrumbIcon icon={c.icon} />}
                      <span className={styles.text} aria-current="page">{c.label}</span>
                      <span className={styles.chevron}><Icon name="16.chevron.down" /></span>
                    </MenuButton>
                  ) : (
                    <span className={cx(styles.crumb, styles.current, styles.static)} aria-current="page">
                      {c.icon !== undefined && <CrumbIcon icon={c.icon} />}
                      <span className={styles.text}>{c.label}</span>
                    </span>
                  )
                ) : (
                  <button type="button" className={styles.crumb} onClick={() => onNavigate(c.id)}>
                    {c.icon !== undefined && <CrumbIcon icon={c.icon} />}
                    <span className={cx(styles.text, styles.ancestor)}>{c.label}</span>
                  </button>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
