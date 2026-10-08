import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../util/cx";
import { Icon, type IconName } from "../icons/Icon";
import { tooltipProps } from "../overlay/TooltipManager";
import { isMixed, type ControlSize, type Mixed, type Placement } from "../types";
import { Spinner } from "./Spinner";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "destructive" | "destructive-secondary" | "ghost" | "link" | "tinted";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant: ButtonVariant;
  /** default 24px (panels), large 32px (Share, dialogs, Home) */
  size?: ControlSize;
  /** A 24 glyph before the label (padding-left 4) */
  icon?: IconName;
  children: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
  type?: "button" | "submit";
  tooltip?: string;
  shortcut?: string;
}

/** Figma's text button (contract §4.1): 5px corners, body-medium; primary / secondary / destructive / ghost / link / tinted. */
export function Button({ variant, size = "default", icon, children, loading, fullWidth, type = "button", tooltip, shortcut, disabled, className, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      data-ds="Button"
      data-variant={variant}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(styles.button, styles[variant], size === "large" && styles.large, icon && styles.withIcon, fullWidth && styles.full, loading && styles.loading, className)}
      {...tooltipProps(tooltip, shortcut)}
      {...rest}
    >
      <span className={styles.label}>
        {icon && <Icon name={icon} />}
        {children}
      </span>
      {loading && <span className={styles.spinner}><Spinner size={16} tone={variant === "primary" || variant === "destructive" ? "onbrand" : "default"} /></span>}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children"> {
  icon: IconName;
  /** aria-label and tooltip */
  label: string;
  shortcut?: string;
  size?: ControlSize;
  tone?: "default" | "secondary";
  tooltipPlacement?: Placement;
  /** false: no tooltip (the label stays the accessible name); a string: that tooltip (Figma: "Remove auto layout" says "Toggle auto layout") */
  tooltip?: boolean | string;
}

/** A square icon button (contract §4.2): 24 in panels, 32 in the tab bar, rail, toolbar. */
export function IconButton({ icon, label, shortcut, size = "default", tone = "default", tooltipPlacement, tooltip = true, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      data-ds="IconButton"
      aria-label={label}
      className={cx(styles.icon, size === "large" && styles.large, tone === "secondary" && styles.toneSecondary, className)}
      {...(tooltip ? tooltipProps(typeof tooltip === "string" ? tooltip : label, shortcut, tooltipPlacement) : {})}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

export interface ToggleIconButtonProps extends IconButtonProps {
  pressed: Mixed<boolean>;
  onPressedChange: (next: boolean) => void;
}

/** An icon button that stays on (contract §4.3): selected blue while on, a paler fill while mixed; mixed → on. */
export function ToggleIconButton({ pressed, onPressedChange, onClick, ...rest }: ToggleIconButtonProps) {
  return (
    <IconButton
      {...rest}
      data-ds="ToggleIconButton"
      aria-pressed={isMixed(pressed) ? "mixed" : pressed}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onPressedChange(pressed !== true);
      }}
    />
  );
}
