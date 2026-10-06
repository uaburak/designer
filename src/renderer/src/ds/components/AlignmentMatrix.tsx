import { useRef, useState, type HTMLAttributes } from "react";
import { cx } from "../util/cx";
import styles from "./AlignmentMatrix.module.css";

/** Figma's names (kiwi `stackPrimaryAlignItems` / `stackCounterAlignItems`). */
export type AxisAlign = "MIN" | "CENTER" | "MAX";
export type PrimaryAlign = AxisAlign | "SPACE_BETWEEN";
export type Alignment = { primary: PrimaryAlign; counter: AxisAlign };

const AXIS: AxisAlign[] = ["MIN", "CENTER", "MAX"];
const NAMES = { MIN: ["top", "left"], CENTER: ["center", "center"], MAX: ["bottom", "right"] } as const;

/** A cell (column, row) → the alignment it sets, for a layout direction (pure). */
export function cellAlignment(direction: "horizontal" | "vertical", col: number, row: number, current: PrimaryAlign): Alignment {
  const spaced = current === "SPACE_BETWEEN";
  if (direction === "horizontal") return { primary: spaced ? "SPACE_BETWEEN" : AXIS[col], counter: AXIS[row] };
  return { primary: spaced ? "SPACE_BETWEEN" : AXIS[row], counter: AXIS[col] };
}

/** Is a cell the selected one? With space-between, the whole row (horizontal) or column (vertical) of the counter alignment is. */
export function cellSelected(direction: "horizontal" | "vertical", col: number, row: number, value: Alignment): boolean {
  const counter = AXIS.indexOf(value.counter);
  if (value.primary === "SPACE_BETWEEN") return direction === "horizontal" ? row === counter : col === counter;
  const primary = AXIS.indexOf(value.primary);
  return direction === "horizontal" ? col === primary && row === counter : row === primary && col === counter;
}

/**
 * The cell's glyph: three bars (children) of 6, 10 and 4px — upright for a
 * horizontal layout, lying for a vertical one — aligned on the counter
 * axis. With space-between, each cell of the row draws one bar.
 */
function Glyph({ direction, counter, single }: { direction: "horizontal" | "vertical"; counter: AxisAlign; single?: number }) {
  const lengths = [6, 10, 4];
  const bars = single === undefined ? [0, 1, 2] : [single];
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className={styles.glyph} fill="currentColor">
      {bars.map((i) => {
        const len = lengths[i];
        const along = single === undefined ? 3.5 + i * 4.5 : 7;
        const start = counter === "MIN" ? 3 : counter === "MAX" ? 13 - len : 8 - len / 2;
        return direction === "horizontal" ? <rect key={i} x={along} y={start} width={2} height={len} rx={1} /> : <rect key={i} x={start} y={along} width={len} height={2} rx={1} />;
      })}
    </svg>
  );
}

export interface AlignmentMatrixProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  /** The auto layout's direction (wrap lays out horizontally) */
  direction: "horizontal" | "vertical";
  value: Alignment;
  onChange: (next: Alignment) => void;
  disabled?: boolean;
  label?: string;
}

/**
 * Figma's auto-layout alignment box (88 × 56, a 3 × 3 grid): the chosen
 * cell shows the children's bars in blue, hovered cells preview them, the
 * others are dots. With space-between ("Auto" gap) a whole row (or column)
 * is chosen and only the counter-axis alignment changes. Keys: arrows move
 * the choice (one tab stop).
 */
export function AlignmentMatrix({ direction, value, onChange, disabled, label = "Alignment", className, ...rest }: AlignmentMatrixProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const spaced = value.primary === "SPACE_BETWEEN";
  const counter = AXIS.indexOf(value.counter);
  const primary = spaced ? 0 : AXIS.indexOf(value.primary as AxisAlign);
  const [selCol, selRow] = direction === "horizontal" ? [primary, counter] : [counter, primary];
  const choose = (col: number, row: number) => onChange(cellAlignment(direction, col, row, value.primary));
  const name = (col: number, row: number) => {
    const a = cellAlignment(direction, col, row, value.primary);
    const [v, h] = direction === "horizontal" ? [a.counter, a.primary] : [a.primary, a.counter];
    const vertical = v === "SPACE_BETWEEN" ? "spaced" : NAMES[v][0];
    const horizontal = h === "SPACE_BETWEEN" ? "spaced" : NAMES[h][1];
    return vertical === "center" && horizontal === "center" ? "Align center" : `Align ${vertical} ${horizontal}`;
  };
  return (
    <div role="radiogroup" aria-label={label} data-ds="AlignmentMatrix" data-disabled={disabled || undefined} className={cx(styles.matrix, className)} onPointerLeave={() => setHover(null)} {...rest}>
      {[0, 1, 2].map((row) =>
        [0, 1, 2].map((col) => {
          const checked = cellSelected(direction, col, row, value);
          // With space-between, hovering previews the whole row (column) under the pointer
          const previewed = !checked && hover !== null && (spaced ? (direction === "horizontal" ? hover[1] === row : hover[0] === col) : hover[0] === col && hover[1] === row);
          const single = spaced ? (direction === "horizontal" ? col : row) : undefined;
          const tabStop = col === selCol && row === selRow;
          return (
            <button
              key={`${col}-${row}`}
              ref={(el) => {
                refs.current[row * 3 + col] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={name(col, row)}
              disabled={disabled}
              tabIndex={tabStop ? 0 : -1}
              data-preview={previewed || undefined}
              className={styles.cell}
              onPointerEnter={() => setHover([col, row])}
              onClick={() => choose(col, row)}
              onKeyDown={(e) => {
                const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
                const step = d[e.key];
                if (!step) return;
                e.preventDefault();
                const c = Math.min(2, Math.max(0, col + step[0]));
                const r = Math.min(2, Math.max(0, row + step[1]));
                choose(c, r);
                refs.current[r * 3 + c]?.focus();
              }}
            >
              <span className={styles.dot} />
              <Glyph direction={direction} counter={direction === "horizontal" ? AXIS[row] : AXIS[col]} single={single} />
            </button>
          );
        })
      )}
    </div>
  );
}
