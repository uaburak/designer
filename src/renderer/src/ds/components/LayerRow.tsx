import { useRef, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../util/cx";
import { Icon, type IconName } from "../icons/Icon";
import { tooltipProps } from "../overlay/TooltipManager";
import type { ExitReason } from "../types";
import { STRINGS } from "../strings";
import { size, space } from "../tokens";
import { textWidth } from "../util/textWidth";
import { TextInput } from "./TextInput";
import styles from "./LayerRow.module.css";

export interface LayerRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "onDoubleClick" | "onPointerDown"> {
  id: string;
  depth: number;
  name: string;
  /** The layer type's 16 glyph */
  icon: IconName;
  /** The glyph's name (live: img [Frame], [Auto layout], [Component]…), read out and in its tooltip */
  iconLabel?: string;
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
function RenameField({ value, onDone, className, label = STRINGS.rename }: { value: string; onDone: (name: string | null, exit: ExitReason) => void; className?: string; label?: string }) {
  const committed = useRef<string | null>(null);
  return (
    <TextInput
      className={className}
      variant="ghost"
      label={label}
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
 * The lock / eye cells the name leaves room for, at rest (a persistent lock takes both cells' room, a persistent
 * closed eye its own) and while the row is hovered (every cell the row has).
 */
export function tailCells({ locked, hidden, lock, visible }: { locked?: boolean; hidden?: boolean; lock: boolean; visible: boolean }): { rest: number; hover: number } {
  const hover = lock ? 2 : visible ? 1 : 0;
  return { rest: locked && lock ? 2 : hidden && visible ? 1 : 0, hover };
}

/**
 * Between a layer name's end and the lock when the list is scrolled to its end (the owner's capture of Figma,
 * docs/research/layers-polish/39.png: 26.5 there, our measure of the name rounds differently — one cell's room).
 */
export const LAYER_NAME_END = size.control;

/**
 * A layer row's full extent (Figma: the Layers list scrolls sideways only when a row doesn't fit; scrolled to the
 * end, its whole name shows, then the lock and the eye): the inset, 4, depth × 24, the chevron, the glyph + 8, the
 * name, `LAYER_NAME_END`, the two cells and the inset. `name` is its width or its text (measured in the row's type).
 */
export function layerRowExtent(depth: number, name: number | string): number {
  const nameWidth = typeof name === "number" ? name : textWidth(name, "body-medium-regular");
  return size["row-inset"] + space["1"] + depth * size["layer-indent"] + 16 + 16 + space["2"] + nameWidth + LAYER_NAME_END + 2 * size.control + size["row-inset"];
}

/**
 * The width a list of layer rows scrolls to: its widest row's extent (rounded up), 0 when it has none — the list
 * never narrower than its view (the rows fill it; it doesn't scroll sideways while every row fits).
 */
export function layerListWidth(rows: readonly { depth: number; name: string | null }[]): number {
  let w = 0;
  for (const r of rows) if (r.name !== null) w = Math.max(w, layerRowExtent(r.depth, r.name));
  return Math.ceil(w);
}

/**
 * A layer in the tree (contract §4.17, measured on Figma live): pitch 32; a 24 highlight (radius 5) inset 8 across
 * and 4 down — a run of highlighted rows fills the pitch between them (the highlight is drawn under the content, so a
 * row's content never moves: every row is 32 with its content on the same line) —; inside it 4, depth × 24, the
 * chevron (16), the type glyph (16) + 8, the name, then lock and eye (24 each, flush right; on hover — kept while
 * on). The name takes the room to the highlight's right edge and fades out there (a mask, over any highlight); the
 * cells showing (hovered, or a lock / closed eye kept on) move the fade left by their width. A list whose rows are
 * wider than it (`layerListWidth`: the widest row's full extent) scrolls sideways; the cells stick to its visible
 * right edge and it sets `--layer-clip-right` (how much of the row lies past that edge) so the fade sits there too. The glyph is secondary
 * unless the row is selected or a top-level frame; components and instances in purple; hidden layers faded. Enter
 * belongs to the list (select the children), not the row.
 */
export function LayerRow({ id, depth, name, icon, iconLabel, kind = "default", tone = "default", expanded, selected, selectedAncestor, hovered, locked, hidden, strong, renaming, run, drop, onToggleExpand, onToggleLock, onToggleVisible, onRename, onPointerDown, onDoubleClick, className, style, ...rest }: LayerRowProps) {
  const cells = renaming ? { rest: 0, hover: 0 } : tailCells({ locked, hidden, lock: !!onToggleLock, visible: !!onToggleVisible });
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
      style={{ ...style, ["--depth" as string]: depth, ["--tail-rest" as string]: cells.rest, ["--tail-hover" as string]: cells.hover }}
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
        <span className={styles.type} role={iconLabel ? "img" : undefined} aria-label={iconLabel} {...tooltipProps(iconLabel)}><Icon name={icon} size={16} /></span>
        {renaming ? (
          <RenameField className={styles.rename} value={name} onDone={(n, r) => onRename?.(n, r)} />
        ) : (
          <span className={styles.name} data-layer-name="">{name}</span>
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

/**
 * A page (contract §4.18; live left/pages-add-page-rename.txt): a 224 × 24 button, 8 in, 8 apart; the current one
 * bg-secondary and its name 550; double click renames.
 */
export function PageRow({ id, name, current, renaming, divider, onRename, onSelect, trailing, hovered, className, ...rest }: PageRowProps) {
  return (
    <div
      role="button"
      data-ds="PageRow"
      data-id={id}
      aria-current={current ? "page" : undefined}
      data-hover={hovered || undefined}
      data-divider={divider && !renaming ? "" : undefined}
      className={cx(styles.page, className)}
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
      {divider && !renaming ? (
        <span className={styles.divider} aria-label={name} />
      ) : renaming ? (
        <RenameField className={styles.rename} label="Page name" value={name} onDone={(n) => onRename?.(n)} />
      ) : (
        <span className={styles.name}>{name}</span>
      )}
      {trailing && <span className={styles.tail}>{trailing}</span>}
    </div>
  );
}
