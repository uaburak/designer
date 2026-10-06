import { Children, createContext, useContext, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../util/cx";
import styles from "./PropertyGrid.module.css";

const Labels = createContext(false);

/**
 * The right panel's grid (contract §4.16): two field columns (88 each at
 * 240, growing with the panel), an 8 gap, a 24 icon column; 16 in, 8 from the
 * right. `labels`: Figma's "Property labels" — each row's label above it.
 */
export function PropertyGrid({ labels = false, children, className, ...rest }: { labels?: boolean; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <Labels.Provider value={labels}>
      <div data-ds="PropertyGrid" className={cx(styles.grid, className)} {...rest}>{children}</div>
    </Labels.Provider>
  );
}

export interface PropertyRowProps extends HTMLAttributes<HTMLDivElement> {
  /** One cell per field column; with span 2, one field over both (184 at 240) */
  children: ReactNode;
  span?: 1 | 2;
  /** The 24px column (a toggle, detach) */
  action?: ReactNode;
  /** Shown when the grid has `labels` */
  label?: string;
}

export function PropertyRow({ children, span = 1, action, label, className, ...rest }: PropertyRowProps) {
  const labels = useContext(Labels);
  const cells = Children.toArray(children);
  return (
    <>
      {labels && label && <div className={styles.label}>{label}</div>}
      <div data-ds="PropertyRow" className={cx(styles.row, className)} {...rest}>
        {span === 2 ? <div className={cx(styles.cell, styles.span2)}>{children}</div> : cells.map((c, i) => <div key={i} className={styles.cell}>{c}</div>)}
        {action && <div className={styles.action}>{action}</div>}
      </div>
    </>
  );
}
