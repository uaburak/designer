import { useRef, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../util/cx";
import { Icon, type IconName } from "../icons/Icon";
import type { ExitReason } from "../types";
import { STRINGS } from "../strings";
import { TextInput } from "./TextInput";
import styles from "./LayerRow.module.css";

export interface LayerRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "onDoubleClick" | "onPointerDown"> {
  id: string;
  depth: number;
  name: string;
  /** The layer type's 16 glyph */
  icon: IconName;
  kind?: "default" | "component" | "instance";
  /** Inside a component or an instance (or one itself): the selection highlights in the component purple */
  tone?: "default" | "component";
  /** undefined: a leaf (no chevron) */
  expanded?: boolean;
  selected?: boolean;
  /** Inside a selected layer: the paler fill */
  selectedAncestor?: boolean;
  /** Hovered on the canvas */
  hovered?: boolean;
  locked?: boolean;
  hidden?: boolean;
  /** Top-level frames, sections, components */
  strong?: boolean;
  renaming?: boolean;
  /** Contiguous selection: which part of the block this row is (computed by the list) */
  run?: "start" | "middle" | "end" | "single";
  /** Drag-and-drop indicator */
  drop?: "before" | "after" | "inside";
  onToggleExpand?: (alt: boolean) => void;
  onToggleLock?: () => void;
  onToggleVisible?: () => void;
  /** The new name, or null (cancelled); `exit` says how (Tab renames the next row in Figma) */
  onRename?: (name: string | null, exit: ExitReason) => void;
  /** Enter on the focused row: the editor starts renaming it */
  onRequestRename?: () => void;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

/** The inline rename: a ghost field; reports the new name (null when unchanged or cancelled) and how it was left. */
function RenameField({ value, onDone, className }: { value: string; onDone: (name: string | null, exit: ExitReason) => void; className?: string }) {
  const committed = useRef<string | null>(null);
  return (
    <TextInput
      className={className}
      variant="ghost"
      label={STRINGS.rename}
      value={value}
      autoFocus
      onCommit={(v) => {
        committed.current = v.trim() ? v : null;
      }}
      onExit={(r) => onDone(r === "escape" ? null : committed.current, r)}
    />
  );
}

/**
 * A layer in the tree (contract §4.17): pitch 24; a 5px-cornered highlight
 * inset 8; inside it 4, depth × 16, the chevron (16), the type glyph (16) +
 * 4, the name, lock and eye (24 each, on hover — kept while on). Components
 * and instances in purple; hidden layers faded. Enter on a focused row
 * starts the rename (the editor drives `renaming`).
 */
export function LayerRow({ id, depth, name, icon, kind = "default", tone = "default", expanded, selected, selectedAncestor, hovered, locked, hidden, strong, renaming, run, drop, onToggleExpand, onToggleLock, onToggleVisible, onRename, onRequestRename, onPointerDown, onDoubleClick, className, style, ...rest }: LayerRowProps) {
  return (
    <div
      role="treeitem"
      data-ds="LayerRow"
      data-id={id}
      aria-level={depth + 1}
      aria-selected={Boolean(selected)}
      aria-expanded={expanded}
      data-selected-ancestor={selectedAncestor && !selected ? "" : undefined}
      data-hover={hovered || undefined}
      data-run={selected || selectedAncestor ? run : undefined}
      data-drop={drop}
      data-tone={tone === "component" ? "component" : undefined}
      className={cx(styles.row, kind !== "default" && styles.component, hidden && styles.hiddenLayer, strong && styles.strong, className)}
      style={{ ...style, ["--drop-indent" as string]: `${8 + 4 + depth * 16 + 16}px` }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        if (renaming) return;
        if (e.key === "Enter" && onRequestRename) {
          e.preventDefault();
          onRequestRename();
        }
      }}
      {...rest}
    >
      <div className={styles.box}>
        <span style={{ width: depth * 16, flex: "none" }} />
        {expanded === undefined ? (
          <span className={styles.leaf} />
        ) : (
          <button type="button" tabIndex={-1} aria-label={expanded ? STRINGS.collapse : STRINGS.expand} aria-expanded={expanded} className={styles.chevron} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onToggleExpand?.(e.altKey); }}>
            <Icon name="16.chevron.down" />
          </button>
        )}
        <span className={styles.type}><Icon name={icon} size={16} /></span>
        {renaming ? (
          <RenameField className={styles.rename} value={name} onDone={(n, r) => onRename?.(n, r)} />
        ) : (
          <span className={styles.name}>{name}</span>
        )}
        {!renaming && (onToggleLock || onToggleVisible) && (
          <span className={styles.tail}>
            {onToggleLock && (
              <button type="button" tabIndex={-1} className={styles.cell} aria-label={locked ? STRINGS.unlock : STRINGS.lock} aria-pressed={Boolean(locked)} data-on={locked || undefined} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onToggleLock(); }}>
                <Icon name={locked ? "16.lock.locked" : "16.lock.unlocked"} />
              </button>
            )}
            {onToggleVisible && (
              <button type="button" tabIndex={-1} className={styles.cell} aria-label={hidden ? STRINGS.show : STRINGS.hide} aria-pressed={Boolean(hidden)} data-on={hidden || undefined} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onToggleVisible(); }}>
                <Icon name={hidden ? "16.hidden" : "16.visible"} />
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

export interface PageRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> {
  id: string;
  name: string;
  current: boolean;
  renaming?: boolean;
  /** A name of dashes: drawn as a 1px line */
  divider?: boolean;
  onRename?: (name: string | null) => void;
  onSelect?: () => void;
  trailing?: ReactNode;
  hovered?: boolean;
}

/** A page (contract §4.18): a 24 highlight on a 32 pitch, the current one bg-secondary; double click renames. */
export function PageRow({ id, name, current, renaming, divider, onRename, onSelect, trailing, hovered, className, ...rest }: PageRowProps) {
  return (
    <div
      role="option"
      data-ds="PageRow"
      data-id={id}
      aria-selected={current}
      data-hover={hovered || undefined}
      className={cx(styles.row, styles.page, className)}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onSelect?.();
        }
      }}
      {...rest}
    >
      <div className={styles.box}>
        {divider ? (
          <span className={styles.divider} aria-label={name} />
        ) : renaming ? (
          <RenameField className={styles.rename} value={name} onDone={(n) => onRename?.(n)} />
        ) : (
          <span className={styles.name}>{name}</span>
        )}
        {trailing && <span className={styles.tail}>{trailing}</span>}
      </div>
    </div>
  );
}
