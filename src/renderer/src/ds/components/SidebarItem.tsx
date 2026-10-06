import type { ReactNode } from "react";
import { Icon, ICON_NAMES, type IconName } from "../icons/Icon";
import styles from "./SidebarItem.module.css";

export interface SidebarItemProps {
  /** A 24 glyph by name, or a node (a FileKindIcon, a folder) centred in the 24 cell */
  icon: IconName | ReactNode;
  label: string;
  selected?: boolean;
  count?: number;
  /** 16 per level (projects under a team) */
  indent?: number;
  trailing?: ReactNode;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  dropTarget?: boolean;
  forceHover?: boolean;
}

/** Home's sidebar entry (contract §4.26; measured on Figma's 2026 file browser): a 28 highlight on a 32 pitch, inset 8; the 24 icon cell 4 in, the label 8 after it (x 44), body-large. */
export function SidebarItem({ icon, label, selected, count, indent = 0, trailing, onClick, onContextMenu, dropTarget, forceHover }: SidebarItemProps) {
  return (
    <button
      type="button"
      data-ds="SidebarItem"
      aria-current={selected ? "page" : undefined}
      data-drop-target={dropTarget || undefined}
      data-hover={forceHover || undefined}
      className={styles.item}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className={styles.box} style={indent ? { paddingLeft: 8 + indent * 16 } : undefined}>
        <span className={styles.icon}>{typeof icon === "string" && (ICON_NAMES as string[]).includes(icon) ? <Icon name={icon as IconName} /> : icon}</span>
        <span className={styles.label}>{label}</span>
        {count !== undefined && <span className={styles.count}>{count}</span>}
        {trailing}
      </span>
    </button>
  );
}

/** A sidebar group's title ("Starred"); with `onOpenChange` it folds (a chevron in the inset, as Figma's). */
export function SidebarHeader({ title, action, open, onOpenChange }: { title: string; action?: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  if (!onOpenChange) {
    return (
      <div data-ds="SidebarHeader" className={styles.header}>
        <span className={styles.headerTitle}>{title}</span>
        {action}
      </div>
    );
  }
  return (
    <div data-ds="SidebarHeader" style={{ display: "flex", alignItems: "center" }}>
      <button type="button" className={`${styles.header} ${styles.headerToggle}`} aria-expanded={open !== false} onClick={() => onOpenChange(open === false)}>
        <span className={styles.headerChevron}><Icon name="16.chevron.down" /></span>
        <span className={styles.headerTitle}>{title}</span>
      </button>
      {action}
    </div>
  );
}

/** The line between the sidebar's groups. */
export function SidebarDivider() {
  return <div role="separator" className={styles.divider} />;
}

/** A folder's glyph for sidebar rows (filled, as Figma's). */
export function FolderIcon() {
  return <Icon name="24.folder" className={styles.folder} />;
}
