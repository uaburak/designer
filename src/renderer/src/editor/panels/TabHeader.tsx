/**
 * The header a navigation-bar tab other than File puts at the top of the left sidebar (live: "Assets" / "Tools"
 * 13 / 550 at 16, 16; a 48 header and its line; actions 12 from the right edge, e.g. Assets' Libraries at 204, 12).
 */
import type { ReactNode } from "react";
import { IconButton, SearchField } from "@/ds";
import styles from "./Panels.module.css";

/**
 * `back`: a page inside the tab (an Agents chat) — a back chevron before the title, which is then that page's.
 * `search`: drawn in the title's place (a tab's list searching: Agents' chats, Assets, Brands — TabSearch).
 */
export function TabHeader({ title, actions, back, search }: { title: string; actions?: ReactNode; back?: { label: string; onClick: () => void }; search?: ReactNode }) {
  return (
    <div className={styles.tabHeader} data-tab-header={title} data-tab-back={back ? "" : undefined} data-tab-searching={search ? "" : undefined}>
      {back && <IconButton icon="24.chevron.left" label={back.label} tone="secondary" className={styles.tabBack} onClick={back.onClick} data-tab-header-back="" />}
      {search ?? <h2 className={styles.tabTitle}>{title}</h2>}
      {actions && <div className={styles.tabActions}>{actions}</div>}
    </div>
  );
}

/** The search icon a tab's header shows until its search opens (Agents' list, Assets, Brands). */
export function TabSearchButton({ label, onOpen }: { label: string; onOpen: () => void }) {
  return <IconButton icon="24.search.small" label={label} tone="secondary" onClick={onOpen} data-tab-search-open="" />;
}

/**
 * The search in a tab's header, over its title: focused when it opens; Esc closes it (its query cleared), and so
 * does leaving it empty.
 */
export function TabSearch({ value, onChange, label, placeholder = label, onClose, autoFocus = true }: { value: string; onChange: (query: string) => void; label: string; placeholder?: string; onClose: () => void; autoFocus?: boolean }) {
  return (
    <SearchField
      className={styles.tabSearch}
      autoFocus={autoFocus}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      label={label}
      onKeyDownCapture={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onChange("");
        onClose();
      }}
      onBlur={(e) => {
        if (!value && !e.currentTarget.contains(e.relatedTarget as Node | null)) onClose();
      }}
      data-tab-search=""
    />
  );
}
