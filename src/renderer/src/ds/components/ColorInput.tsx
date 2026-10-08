import { useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../util/cx";
import { hexDigits, normalizeHex } from "../util/color";
import { selectAllOnClick } from "../util/selectAll";
import { isMixed, type ChangeInfo, type Mixed } from "../types";
import { STRINGS } from "../strings";
import { NumericInput } from "./NumericInput";
import { Swatch } from "./Swatch";
import styles from "./Field.module.css";

export interface ColorInputProps extends Omit<HTMLAttributes<HTMLDivElement>, "color"> {
  label: string;
  /** "#rrggbb" */
  color: Mixed<string>;
  /** 0–100 */
  opacity: Mixed<number>;
  onColor: (hex: string, info: ChangeInfo) => void;
  /** Without it there is no opacity part */
  onOpacity?: (o: number, info: ChangeInfo) => void;
  /** The swatch's accessible name (Figma: "Solid color hex: D9D9D9"); default "<label>: pick colour" */
  swatchLabel?: string;
  /** The swatch clicked: open the ColorPicker there */
  onSwatchClick?: (anchor: DOMRect) => void;
  /** Replaces the swatch (a variable chip) */
  swatch?: ReactNode;
  /**
   * A paint that isn't a solid colour: this text ("Linear", "Image") instead of the hex field, opening the picker
   * like the swatch; `color` is then the swatch's CSS background (a gradient, an image)
   */
  valueLabel?: string;
  disabled?: boolean;
}

/**
 * Figma's fill row (contract §4.6): the swatch cell, the hex as six upper-case
 * digits (3 or 6 typed, with or without #, or a CSS colour name; anything
 * else reverts), a line in the panel colour, the opacity with its %.
 */
export function ColorInput({ label, color, opacity, onColor, onOpacity, onSwatchClick, swatchLabel, swatch, valueLabel, disabled, className, ...rest }: ColorInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const mixedColor = isMixed(color);
  const commit = (raw: string) => {
    const typed = draft !== null && !cancelled.current;
    cancelled.current = false;
    setDraft(null);
    if (!typed) return;
    const hex = normalizeHex(raw);
    if (hex && (mixedColor || hex !== color.toLowerCase())) onColor(hex, { final: true, source: "type" });
  };
  return (
    <div data-ds="ColorInput" data-disabled={disabled || undefined} className={cx(styles.field, className)} {...rest}>
      {swatch ?? (
        <button type="button" className={styles.swatchCell} aria-label={swatchLabel ?? `${label}: pick colour`} disabled={disabled} onClick={(e) => onSwatchClick?.(e.currentTarget.getBoundingClientRect())}>
          <Swatch color={mixedColor ? "#000000" : color} opacity={isMixed(opacity) ? 100 : opacity} mixed={mixedColor} />
        </button>
      )}
      {valueLabel !== undefined ? (
        <button
          type="button"
          aria-label={`${label}: ${valueLabel}`}
          disabled={disabled}
          className={cx(styles.input, styles.valueLabel)}
          onClick={(e) => onSwatchClick?.((e.currentTarget.parentElement ?? e.currentTarget).getBoundingClientRect())}
        >
          {valueLabel}
        </button>
      ) : (
      <input
        aria-label={label}
        disabled={disabled}
        value={draft ?? (mixedColor ? "" : hexDigits(color))}
        placeholder={mixedColor ? STRINGS.mixed : undefined}
        spellCheck={false}
        {...selectAllOnClick}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        className={cx(styles.input, !mixedColor && styles.upper, styles.tabular, mixedColor && styles.mixed)}
      />
      )}
      {onOpacity && (
        <span className={styles.opacity}>
          <NumericInput bare label={`${label} opacity`} prefix={undefined} value={opacity} min={0} max={100} precision={0} unit="%" disabled={disabled} onChange={onOpacity} />
        </span>
      )}
    </div>
  );
}
