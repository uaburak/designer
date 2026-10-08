import { useEffect, useRef, type HTMLAttributes } from "react";
import { cx } from "../util/cx";
import { Icon } from "../icons/Icon";
import { isMixed, type Mixed } from "../types";
import styles from "./Checkbox.module.css";

export interface CheckboxProps extends Omit<HTMLAttributes<HTMLLabelElement>, "onChange"> {
  label: string;
  checked: Mixed<boolean>;
  onChange: (c: boolean) => void;
  disabled?: boolean;
  /** The label stays the accessible name */
  hideLabel?: boolean;
  /** brand (default): blue when on; panel: the Design panel's grey box with a white check, radius 2 (Figma's live "Clip content") */
  tone?: "brand" | "panel";
}

/** Figma's checkbox (contract §4.10): 16px, radius 5; brand fill with the check (or a dash when mixed). Space toggles; mixed → checked. */
export function Checkbox({ label, checked, onChange, disabled, hideLabel, tone = "brand", className, ...rest }: CheckboxProps) {
  const input = useRef<HTMLInputElement>(null);
  const mixed = isMixed(checked);
  useEffect(() => {
    if (input.current) input.current.indeterminate = mixed;
  }, [mixed]);
  const on = mixed || checked === true;
  return (
    <label data-ds="Checkbox" data-disabled={disabled || undefined} className={cx(styles.root, tone === "panel" && styles.panel, className)} {...rest}>
      <span className={styles.box} data-on={on || undefined}>
        <input ref={input} type="checkbox" className={styles.input} checked={checked === true} aria-checked={mixed ? "mixed" : checked === true} aria-label={hideLabel ? label : undefined} disabled={disabled} onChange={() => onChange(checked !== true)} />
        {checked === true && <Icon name="16.check" />}
        {mixed && <span className={styles.dash} />}
        {!on && <span className={styles.ghost}><Icon name="16.check" /></span>}
      </span>
      {!hideLabel && <span>{label}</span>}
    </label>
  );
}
