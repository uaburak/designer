import { useRef, type HTMLAttributes } from "react";
import { cx } from "../util/cx";
import { rovingTarget } from "../util/rovingFocus";
import { Icon, type IconName } from "../icons/Icon";
import { tooltipProps } from "../overlay/TooltipManager";
import { isMixed, type Mixed } from "../types";
import styles from "./SegmentedControl.module.css";

export type SegmentOption = { value: string; label?: string; icon?: IconName; tooltip?: string; shortcut?: string; disabled?: boolean };

export interface SegmentedControlProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  label: string;
  value: Mixed<string>;
  options: SegmentOption[];
  onChange: (v: string) => void;
  /** panel: #383838 track; toolbar: #444 (the mode group) */
  tone?: "panel" | "toolbar";
  fullWidth?: boolean;
  disabled?: boolean;
}

/**
 * Figma's segmented control (contract §4.13): a 24px track with no padding;
 * the chosen segment fills it — panel colour, hairline, radius 5. Mixed: none
 * chosen. ← → move and choose; Tab enters at the chosen one.
 */
export function SegmentedControl({ label, value, options, onChange, tone = "panel", fullWidth, disabled, className, ...rest }: SegmentedControlProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = (i: number) => !disabled && !options[i].disabled;
  const chosen = isMixed(value) ? -1 : options.findIndex((o) => o.value === value);
  const tabStop = chosen >= 0 ? chosen : options.findIndex((_, i) => enabled(i));
  return (
    <div role="radiogroup" aria-label={label} data-ds="SegmentedControl" data-disabled={disabled || undefined} className={cx(styles.root, tone === "toolbar" && styles.toolbar, fullWidth && styles.full, className)} {...rest}>
      {options.map((o, i) => {
        const iconOnly = Boolean(o.icon && !o.label);
        const name = o.label ?? o.tooltip ?? o.value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            aria-label={iconOnly ? name : undefined}
            disabled={!enabled(i)}
            tabIndex={i === tabStop ? 0 : -1}
            className={cx(styles.segment, iconOnly && styles.iconOnly)}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const next = rovingTarget(e.key, options.length, enabled, i, "horizontal");
              if (next === null || next < 0) return;
              e.preventDefault();
              refs.current[next]?.focus();
              onChange(options[next].value);
            }}
            {...tooltipProps(o.tooltip ?? (iconOnly ? name : undefined), o.shortcut, tone === "toolbar" ? "top" : "bottom")}
          >
            {o.icon && <Icon name={o.icon} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
