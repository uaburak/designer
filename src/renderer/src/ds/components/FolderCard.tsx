import type { HTMLAttributes } from "react";
import { cx } from "../util/cx";
import { Icon } from "../icons/Icon";
import { STRINGS } from "../strings";
import { IconButton } from "./Button";
import { InlineEdit } from "./InlineEdit";
import styles from "./FolderCard.module.css";

export interface FolderCardProps extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect" | "title" | "color"> {
  id: string;
  title: string;
  /** "3 files" */
  subtitle: string;
  /** Up to four of its files' thumbnail URLs (the most recent first) */
  thumbnails?: string[];
  /** The folder's own colour (user data: any CSS colour); default the secondary icon colour */
  color?: string;
  starred?: boolean;
  selected?: boolean;
  renaming?: boolean;
  /** Files dragged over it can be dropped in */
  dropTarget?: boolean;
  onOpen?: () => void;
  onSelect?: (e: React.MouseEvent | React.KeyboardEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** The rename ended: the new name, or null (cancelled or unchanged) */
  onRename?: (name: string | null) => void;
  onStar?: (starred: boolean) => void;
  forceHover?: boolean;
}

/** A folder's glyph in its colour, at any size (cards, rows, the sidebar). */
export function FolderGlyph({ color, size = 24 }: { color?: string; size?: 16 | 24 | 48 }) {
  return <Icon name="24.folder" size={size} className={styles.glyph} style={color ? { color } : undefined} />;
}

/**
 * A folder in Home's grid (same frame as FileCard: 268×213, radius 9): the
 * thumbnail area shows up to four of its files in a 2×2 grid, or the folder
 * glyph in its colour when it is empty; the footer has the glyph, the name
 * and "N files". Double-click or Enter opens, Space selects; a drop target
 * gets the selection ring. `renaming` swaps the name for an InlineEdit.
 */
export function FolderCard({ id, title, subtitle, thumbnails = [], color, starred, selected, renaming, dropTarget, onOpen, onSelect, onContextMenu, onRename, onStar, forceHover, className, ...rest }: FolderCardProps) {
  const shown = thumbnails.slice(0, 4);
  return (
    <div
      role="option"
      data-ds="FolderCard"
      data-id={id}
      data-collection-item=""
      aria-selected={Boolean(selected)}
      aria-label={title}
      tabIndex={0}
      data-hover={forceHover || undefined}
      data-drop-target={dropTarget || undefined}
      className={cx(styles.card, className)}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (renaming || e.target !== e.currentTarget) return;
        if (e.key === "Enter") {
          e.preventDefault();
          onOpen?.();
        } else if (e.key === " ") {
          e.preventDefault();
          onSelect?.(e);
        }
      }}
      {...rest}
    >
      <div className={styles.thumb}>
        {shown.length ? (
          <div className={styles.previews} data-count={shown.length}>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={styles.preview}>{shown[i] && <img src={shown[i]} alt="" draggable={false} />}</span>
            ))}
          </div>
        ) : (
          <FolderGlyph color={color} size={48} />
        )}
        {onStar && (
          <span className={styles.star} data-on={starred || undefined}>
            <IconButton icon={starred ? "24.star" : "24.star.outline"} label={starred ? "Unstar" : "Star"} tooltip={false} onClick={(e) => { e.stopPropagation(); onStar(!starred); }} />
          </span>
        )}
      </div>
      <div className={styles.footer}>
        <FolderGlyph color={color} />
        <span className={styles.meta}>
          <InlineEdit className={styles.title} label={STRINGS.rename} value={title} editing={Boolean(renaming)} onCommit={(n) => onRename?.(n)} onCancel={() => onRename?.(null)} />
          <span className={styles.subtitle}>{subtitle}</span>
        </span>
      </div>
    </div>
  );
}
