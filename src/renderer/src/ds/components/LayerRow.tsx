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
  /** Inside a component or an instance (or one itself): the hover cells in the component purple */
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
  /** Pressed (not clicked): a drag from the cell goes on over the rows above or below it (Figma) */
  onToggleLock?: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onToggleVisible?: (e: React.PointerEvent<HTMLButtonElement>) => void;
  /** The new name, or null (cancelled); `exit` says how (Tab renames the next row in Figma) */
  onRename?: (name: string | null, exit: ExitReason) => void;
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

/** A lock / eye cell (Figma's labels): acts on press, so a drag from it goes on over other rows; never takes the focus. */
function Cell({ kind, on, onPress }: { kind: "lock" | "visible"; on: boolean; onPress: (e: React.PointerEvent<HTMLButtonElement>) => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className={styles.cell}
      data-cell={kind}
      aria-label={kind === "lock" ? STRINGS.toggleLocking : STRINGS.toggleVisibility}
      aria-pressed={on}
      data-on={on || undefined}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.button === 0) onPress(e);
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Icon name={kind === "lock" ? (on ? "16.lock.locked" : "16.lock.unlocked") : on ? "16.hidden" : "16.visible"} />
    </button>
  );
}

/**
 * A layer in the tree (contract §4.17, measured on Figma live): pitch 32; a 24 highlight (radius 5) inset 8 across
 * and 4 down — a run of highlighted rows fills the pitch between them —; inside it 4, depth × 24, the chevron (16),
 * the type glyph (16) + 8, the name, then lock and eye (24 each, flush right; on hover — kept while on). The glyph is
 * secondary unless the row is selected or a top-level frame; components and instances in purple; hidden layers
 * faded. Enter belongs to the list (select the children), not the row.
 */
export function LayerRow({ id, depth, name, icon, kind = "default", tone = "default", expanded, selected, selectedAncestor, hovered, locked, hidden, strong, renaming, run, drop, onToggleExpand, onToggleLock, onToggleVisible, onRename, onPointerDown, onDoubleClick, className, style, ...rest }: LayerRowProps) {
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
      style={{ ...style, ["--depth" as string]: depth }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      {...rest}
    >
      <div className={styles.box}>
        <span className={styles.indent} />
        {expanded === undefined ? (
          <span className={styles.leaf} />
        ) : (
          <button type="button" tabIndex={-1} aria-label={expanded ? STRINGS.collapse : STRINGS.expand} aria-expanded={expanded} className={styles.chevron} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onToggleExpand?.(e.altKey); }}>
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
            {onToggleLock ? <Cell kind="lock" on={Boolean(locked)} onPress={onToggleLock} /> : <span className={styles.cellSlot} />}
            {onToggleVisible && <Cell kind="visible" on={Boolean(hidden)} onPress={onToggleVisible} />}
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
  /** An empty page named with a leading dash: drawn as a 1px line, not a page to go to */
  divider?: boolean;
  onRename?: (name: string | null) => void;
  onSelect?: () => void;
  trailing?: ReactNode;
  hovered?: boolean;
}

/** A page (contract §4.18): a 24 highlight on a 32 pitch, the current one bg-secondary and its name 550; double click renames. */
export function PageRow({ id, name, current, renaming, divider, onRename, onSelect, trailing, hovered, className, ...rest }: PageRowProps) {
  return (
    <div
      role="option"
      data-ds="PageRow"
      data-id={id}
      aria-selected={current}
      data-hover={hovered || undefined}
      data-divider={divider && !renaming ? "" : undefined}
      className={cx(styles.row, styles.page, className)}
      onClick={divider ? undefined : onSelect}
      onKeyDown={(e) => {
        if (divider || renaming) return;
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onSelect?.();
        }
      }}
      {...rest}
    >
      <div className={styles.box}>
        {divider && !renaming ? (
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
