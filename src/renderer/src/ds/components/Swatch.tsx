import type { HTMLAttributes } from "react";
import { cx } from "../util/cx";
import { normalizeHex, withOpacity } from "../util/color";
import styles from "./Swatch.module.css";

export interface SwatchProps extends HTMLAttributes<HTMLSpanElement> {
  /** "#rrggbb" or any CSS colour (then `opacity` is ignored) */
  color: string;
  /** 0–100; below 100 the right half shows it over the checkerboard */
  opacity?: number;
  shape?: "square" | "round";
  size?: 14 | 16;
  mixed?: boolean;
}

/** A colour chit (contract §4.6): 14 square radius 2 (fields) or 16 round (styles list), a translucent hairline. */
export function Swatch({ color, opacity = 100, shape = "square", size, mixed, className, style, ...rest }: SwatchProps) {
  const hex = normalizeHex(color);
  const dims = size ? { width: size, height: size } : undefined;
  return (
    <span data-ds="Swatch" aria-hidden className={cx(styles.swatch, shape === "round" && styles.round, mixed && styles.mixed, className)} style={{ ...dims, ...style }} {...rest}>
      {mixed ? null : hex && opacity < 100 ? (
        <>
          <span className={styles.solid} style={{ background: hex }} />
          <span className={styles.alpha} style={{ background: withOpacity(hex, opacity) }} />
        </>
      ) : (
        <span className={styles.fill} style={{ background: hex ?? color }} />
      )}
    </span>
  );
}

/** The brief's name for Swatch. */
export const ColorSwatch = Swatch;
