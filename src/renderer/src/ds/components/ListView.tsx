import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../util/cx";
import { Icon } from "../icons/Icon";
import styles from "./ListView.module.css";

export type ListColumn = {
  id: string;
  label: string;
  /** px, or any grid track ("1fr", "minmax(120px, 1fr)"); default "1fr" */
  width?: number | string;
  align?: "start" | "end";
  /** The header cell is a button that calls `onSort` */
  sortable?: boolean;
};

export type ListSort = { column: string; direction: "ascending" | "descending" };

/** The `grid-template-columns` shared by a list's header and rows. */
export function listTemplate(columns: readonly ListColumn[]): string {
  return columns.map((c) => (c.width === undefined ? "minmax(0, 1fr)" : typeof c.width === "number" ? `${c.width}px` : c.width)).join(" ");
}

/** The sort after clicking a column: the same column flips, another starts ascending (dates: descending — pass `firstDirection`). */
export function nextSort(sort: ListSort | null | undefined, column: string, firstDirection: ListSort["direction"] = "ascending"): ListSort {
  if (sort?.column === column) return { column, direction: sort.direction === "ascending" ? "descending" : "ascending" };
  return { column, direction: firstDirection };
}

export interface ListHeaderProps extends HTMLAttributes<HTMLDivElement> {
  columns: readonly ListColumn[];
  sort?: ListSort | null;
  /** A sortable column was clicked (compute the next sort with `nextSort`) */
  onSort?: (column: string) => void;
}

/**
 * The list view's column header (Home's list: Name, Location, Last modified):
 * 32 high, secondary 11px labels; a sortable column is a button with the
 * sort arrow beside the active one (`aria-sort`). Sticky at the top of a
 * scrolling list.
 */
export function ListHeader({ columns, sort, onSort, className, style, ...rest }: ListHeaderProps) {
  return (
    <div data-ds="ListHeader" role="row" className={cx(styles.header, className)} style={{ gridTemplateColumns: listTemplate(columns), ...style }} {...rest}>
      {columns.map((c) => {
        const active = sort?.column === c.id;
        const content = (
          <>
            <span className={styles.headerLabel}>{c.label}</span>
            {active && <Icon name={sort!.direction === "ascending" ? "16.arrow.up" : "16.arrow.down"} className={styles.sortIcon} />}
          </>
        );
        return (
          <div
            key={c.id}
            role="columnheader"
            aria-sort={active ? sort!.direction : c.sortable ? "none" : undefined}
            className={cx(styles.headerCell, c.align === "end" && styles.end)}
          >
            {c.sortable && onSort ? (
              <button type="button" className={cx(styles.sortButton, active && styles.sortActive)} onClick={() => onSort(c.id)}>
                {content}
              </button>
            ) : (
              content
            )}
          </div>
        );
      })}
    </div>
  );
}

export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> {
  id: string;
  columns: readonly ListColumn[];
  /** One node per column, by column id (missing ones are empty) */
  cells: Record<string, ReactNode>;
  selected?: boolean;
  /** Something dragged over it can be dropped in (a folder) */
  dropTarget?: boolean;
  /** Dimmed (a cut file, a trashed one in a mixed view) */
  muted?: boolean;
  onOpen?: () => void;
  onSelect?: (e: React.MouseEvent | React.KeyboardEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Gallery */
  forceHover?: boolean;
}

/**
 * One row of a list view (Home's list; contract §4.27: 40 high): cells on the
 * header's grid, the first in the primary text colour and the rest secondary.
 * Click selects (with its modifiers: pass the event on), double-click or
 * Enter opens, Space selects. Inside a `CollectionView` the arrows move
 * between rows.
 */
export function ListRow({ id, columns, cells, selected, dropTarget, muted, onOpen, onSelect, onContextMenu, forceHover, className, style, ...rest }: ListRowProps) {
  return (
    <div
      data-ds="ListRow"
      data-id={id}
      data-collection-item=""
      role="row"
      aria-selected={Boolean(selected)}
      tabIndex={0}
      data-drop-target={dropTarget || undefined}
      data-muted={muted || undefined}
      data-hover={forceHover || undefined}
      className={cx(styles.row, className)}
      style={{ gridTemplateColumns: listTemplate(columns), ...style }}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
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
      {columns.map((c, i) => (
        <div key={c.id} role="gridcell" className={cx(styles.cell, i === 0 && styles.first, c.align === "end" && styles.end)}>
          {cells[c.id]}
        </div>
      ))}
    </div>
  );
}
