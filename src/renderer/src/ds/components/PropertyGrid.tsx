import { Children, createContext, useContext, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../util/cx";
import styles from "./PropertyGrid.module.css";

const Labels = createContext(false);

/**
 * The right panel's grid (contract §4.16): two field columns (88 each at
 * 240, growing with the panel), an 8 gap, a 24 icon column; 16 in, 8 from the
 * right. `labels`: Figma's "Additional labels" (View menu, on by default) —
 * each row's label above it, 9px/500 at 70% (Figma's live panel).
 */
export function PropertyGrid({ labels = false, children, className, ...rest }: { labels?: boolean; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <Labels.Provider value={labels}>
      <div data-ds="PropertyGrid" className={cx(styles.grid, className)} {...rest}>{children}</div>
    </Labels.Provider>
  );
}

/** Whether the grid shows its rows' labels (Figma's "Additional labels"). */
export const useGridLabels = () => useContext(Labels);

export interface PropertyRowProps extends HTMLAttributes<HTMLDivElement> {
  /** One cell per field column; with span 2, one field over both (184 at 240) */
  children: ReactNode;
  span?: 1 | 2;
  /** The 24px column (a toggle, detach); two nodes: the second sits in a 24 column before it (180 at 240) */
  action?: ReactNode;
  /** A second action, before `action` (Stroke's "Advanced stroke settings" before "Individual strokes") */
  action2?: ReactNode;
  /** Shown when the grid has `labels`: one over the row */
  label?: string;
  /**
   * One label per field column (Figma's "Opacity" / "Corner radius", "Alignment" / "Gap"): a row with two labels
   * sits 2px lower than one with a single label, as Figma lays them out. A single string with `double` does the same.
   */
  labels?: readonly (string | undefined)[];
  /** The row's field columns (CSS grid-template-columns) when they aren't the two 88s: Stroke's 76 / 72 */
  columns?: string;
}

export function PropertyRow({ children, span = 1, action, action2, label, labels: columnLabels, columns, className, style, ...rest }: PropertyRowProps) {
  const labels = useContext(Labels);
  const cells = Children.toArray(children);
  const template: CSSProperties | undefined = columns ? ({ "--ds-row-columns": columns } as CSSProperties) : undefined;
  const double = !!columnLabels && columnLabels.length > 1;
  return (
    <>
      {labels && (label || columnLabels) && (
        <div className={cx(styles.labelRow, double && styles.double, columns && styles.custom)} style={template} aria-hidden>
          {columnLabels ? (
            columnLabels.map((l, i) => (
              <span key={i} className={styles.label}>
                {l}
              </span>
            ))
          ) : (
            <span className={cx(styles.label, styles.labelSpan)}>{label}</span>
          )}
        </div>
      )}
      <div data-ds="PropertyRow" className={cx(styles.row, columns && styles.custom, action2 !== undefined && styles.twoActions, className)} style={{ ...template, ...style }} {...rest}>
        {span === 2 ? <div className={cx(styles.cell, styles.span2)}>{children}</div> : cells.map((c, i) => <div key={i} className={styles.cell}>{c}</div>)}
        {action2 !== undefined && <div className={cx(styles.action, styles.action2)}>{action2}</div>}
        {action && <div className={cx(styles.action, styles.actionLast)}>{action}</div>}
      </div>
    </>
  );
}
