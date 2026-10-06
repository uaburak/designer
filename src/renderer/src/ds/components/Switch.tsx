import type { ButtonHTMLAttributes } from "react";
import { cx } from "../util/cx";
import styles from "./Switch.module.css";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  label: string;
  checked: boolean;
  onChange: (c: boolean) => void;
  disabled?: boolean;
  /** Show the label beside it (default: the label is only the accessible name) */
  showLabel?: boolean;
}

/** Figma's toggle (contract §4.11): a 28×16 track, a 14×10 oval knob; on, the brand blue. Space / Enter toggle. */
export function Switch({ label, checked, onChange, disabled, showLabel, className, ...rest }: SwitchProps) {
  const track = (
    <button type="button" role="switch" data-ds="Switch" aria-checked={checked} aria-label={label} disabled={disabled} className={cx(styles.track, !showLabel && className)} onClick={() => onChange(!checked)} {...rest}>
      <span className={styles.knob} />
    </button>
  );
  if (!showLabel) return track;
  return (
    <label className={cx(styles.root, className)}>
      {track}
      <span aria-hidden>{label}</span>
    </label>
  );
}
