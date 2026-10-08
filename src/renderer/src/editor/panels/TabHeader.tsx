/**
 * The header a navigation-bar tab other than File puts at the top of the left sidebar (live: "Assets" / "Tools"
 * 13 / 550 at 16, 16; a 48 header and its line; actions 12 from the right edge, e.g. Assets' Libraries at 204, 12).
 */
import type { ReactNode } from "react";
import styles from "./Panels.module.css";

export function TabHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className={styles.tabHeader} data-tab-header={title}>
      <h2 className={styles.tabTitle}>{title}</h2>
      {actions && <div className={styles.tabActions}>{actions}</div>}
    </div>
  );
}
