import { useRef } from "react";
import { Icon } from "../icons/Icon";
import { STRINGS } from "../strings";
import { IconButton } from "./Button";
import { TextInput } from "./TextInput";
import styles from "./FileCard.module.css";

export interface FileCardProps {
  id: string;
  title: string;
  /** "Edited 2 hours ago" */
  subtitle: string;
  /** A thumbnail URL */
  thumbnail?: string;
  starred?: boolean;
  selected?: boolean;
  renaming?: boolean;
  onOpen?: () => void;
  onSelect?: (e: React.MouseEvent | React.KeyboardEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onRename?: (name: string | null) => void;
  onStar?: (starred: boolean) => void;
  forceHover?: boolean;
}

function CardRename({ value, onDone }: { value: string; onDone: (name: string | null) => void }) {
  const committed = useRef<string | null>(null);
  return <TextInput label={STRINGS.rename} value={value} autoFocus onCommit={(v) => (committed.current = v.trim() ? v : null)} onExit={(r) => onDone(r === "escape" ? null : committed.current)} />;
}

/** A file's kind as Figma marks it in Home (cards, rows, the sidebar): a 16px brand square with the design glyph in white. */
export function FileKindIcon({ size = 16 }: { size?: 16 | 20 | 24 }) {
  return (
    <span data-ds="FileKindIcon" className={styles.kindBadge} style={{ width: size, height: size }} aria-hidden>
      <Icon name="16.design" size={Math.round(size * 0.75)} />
    </span>
  );
}

/**
 * Home's file card (contract §4.27; footer as measured on Figma's 2026 file
 * browser): 268×213, radius 9; a 16:9 thumbnail; the kind badge 16px in,
 * then — 12px on — the title (11/550) over when it was edited (11, secondary;
 * `formatEdited`). Enter opens, Space selects.
 */
export function FileCard({ id, title, subtitle, thumbnail, starred, selected, renaming, onOpen, onSelect, onContextMenu, onRename, onStar, forceHover }: FileCardProps) {
  return (
    <div
      role="option"
      data-ds="FileCard"
      data-id={id}
      data-collection-item=""
      aria-selected={Boolean(selected)}
      aria-label={title}
      tabIndex={0}
      data-hover={forceHover || undefined}
      className={styles.card}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (renaming) return;
        if (e.key === "Enter") {
          e.preventDefault();
          onOpen?.();
        } else if (e.key === " ") {
          e.preventDefault();
          onSelect?.(e);
        }
      }}
    >
      <div className={styles.thumb}>
        {thumbnail && <img src={thumbnail} alt="" draggable={false} />}
        {onStar && (
          <span className={styles.star} data-on={starred || undefined}>
            <IconButton icon={starred ? "24.star" : "24.star.outline"} label={starred ? "Unstar" : "Star"} tooltip={false} onClick={(e) => { e.stopPropagation(); onStar(!starred); }} />
          </span>
        )}
      </div>
      <div className={styles.footer}>
        <FileKindIcon />
        <span className={styles.meta}>
          {renaming ? <CardRename value={title} onDone={(n) => onRename?.(n)} /> : <span className={styles.title}>{title}</span>}
          <span className={styles.subtitle}>{subtitle}</span>
        </span>
      </div>
    </div>
  );
}

/** The list view's row (40 high, same data). */
export function FileRow({ id, title, subtitle, selected, onOpen, onSelect, onContextMenu }: Pick<FileCardProps, "id" | "title" | "subtitle" | "selected" | "onOpen" | "onSelect" | "onContextMenu">) {
  return (
    <div role="option" data-ds="FileRow" data-id={id} data-collection-item="" aria-selected={Boolean(selected)} tabIndex={0} className={styles.row} onClick={onSelect} onDoubleClick={onOpen} onContextMenu={onContextMenu} onKeyDown={(e) => e.key === "Enter" && onOpen?.()}>
      <FileKindIcon />
      <span className={styles.rowTitle}>{title}</span>
      <span className={styles.subtitle}>{subtitle}</span>
    </div>
  );
}
