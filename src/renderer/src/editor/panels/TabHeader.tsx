/**
 * The header a navigation-bar tab other than File puts at the top of the left sidebar (live: "Assets" / "Tools"
 * 13 / 550 at 16, 16; a 48 header and its line; actions 12 from the right edge, e.g. Assets' Libraries at 204, 12).
 */
import type { ReactNode } from "react";
import { IconButton } from "@/ds";
import styles from "./Panels.module.css";

/** `back`: a page inside the tab (an Agents chat) — a back chevron before the title, which is then that page's. */
export function TabHeader({ title, actions, back }: { title: string; actions?: ReactNode; back?: { label: string; onClick: () => void } }) {
  return (
    <div className={styles.tabHeader} data-tab-header={title} data-tab-back={back ? "" : undefined}>
      {back && <IconButton icon="24.chevron.left" label={back.label} tone="secondary" className={styles.tabBack} onClick={back.onClick} data-tab-header-back="" />}
      <h2 className={styles.tabTitle}>{title}</h2>
      {actions && <div className={styles.tabActions}>{actions}</div>}
    </div>
  );
}
