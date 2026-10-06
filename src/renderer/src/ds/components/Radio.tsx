import { useRef, type HTMLAttributes } from "react";
import { cx } from "../util/cx";
import { rovingTarget } from "../util/rovingFocus";
import { isMixed, type Mixed } from "../types";
import styles from "./Radio.module.css";

export type RadioOption = { value: string; label: string; disabled?: boolean };

export interface RadioGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  label: string;
  value: Mixed<string>;
  options: RadioOption[];
  onChange: (v: string) => void;
  orientation?: "vertical" | "horizontal";
  disabled?: boolean;
}

/** Radios (contract §4.12): 16 circles; arrows move and choose (roving tabindex), Tab enters at the chosen one. */
export function RadioGroup({ label, value, options, onChange, orientation = "vertical", disabled, className, ...rest }: RadioGroupProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = (i: number) => !disabled && !options[i].disabled;
  const chosen = isMixed(value) ? -1 : options.findIndex((o) => o.value === value);
  const firstEnabled = options.findIndex((_, i) => enabled(i));
  const tabStop = chosen >= 0 && enabled(chosen) ? chosen : firstEnabled;
  return (
    <div role="radiogroup" aria-label={label} aria-orientation={orientation} data-ds="RadioGroup" className={cx(styles.group, className)} {...rest}>
      {options.map((o, i) => (
        <label key={o.value} className={styles.root} data-disabled={!enabled(i) || undefined}>
          <button
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            disabled={!enabled(i)}
            tabIndex={i === tabStop ? 0 : -1}
            className={styles.radio}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const next = rovingTarget(e.key, options.length, enabled, i);
              if (next === null || next < 0) return;
              e.preventDefault();
              refs.current[next]?.focus();
              onChange(options[next].value);
            }}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}
