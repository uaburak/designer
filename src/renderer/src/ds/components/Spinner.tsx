import { cx } from "../util/cx";
import { STRINGS } from "../strings";
import styles from "./Spinner.module.css";

/** A ring with a turning 90° arc (contract §4.31): 2px stroke (1.5 at 16), the track at 25%. */
export function Spinner({ size = 16, tone = "default", label = STRINGS.loading, className }: { size?: 16 | 24 | 32; tone?: "default" | "onbrand"; label?: string; className?: string }) {
  const w = size === 16 ? 1.5 : 2;
  const r = size / 2 - w / 2 - 1;
  const c = size / 2;
  return (
    <svg data-ds="Spinner" className={cx(styles.spinner, tone === "onbrand" && styles.onbrand, className)} width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" role="status" aria-label={label}>
      <circle cx={c} cy={c} r={r} stroke="currentColor" strokeOpacity={0.25} strokeWidth={w} />
      <path d={`M${c} ${c - r}A${r} ${r} 0 0 1 ${c + r} ${c}`} stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
    </svg>
  );
}
