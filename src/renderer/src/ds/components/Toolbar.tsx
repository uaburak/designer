import { useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../util/cx";
import { Icon, type IconName } from "../icons/Icon";
import { tooltipProps } from "../overlay/TooltipManager";
import { ContextMenu, type MenuEntry } from "./Menu";
import styles from "./Toolbar.module.css";

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Absolutely placed: centred, 12px over the bottom of its (relative) container */
  floating?: boolean;
  /** Centre on the window, not the canvas: the px to shift by */
  offset?: number;
  label?: string;
}

/** The bottom toolbar (contract §4.24): 48px, radius 13, elevation 100, 8 padding, 8 between groups. */
export function Toolbar({ children, floating, offset = 0, label = "Tools", className, style, ...rest }: ToolbarProps) {
  return (
    <div role="toolbar" aria-label={label} data-ds="Toolbar" className={cx(styles.toolbar, floating && styles.floating, className)} style={{ ...style, ["--ds-toolbar-offset" as string]: `${offset}px` }} {...rest}>
      {children}
    </div>
  );
}

/** Tools side by side, no gap. */
export function ToolbarGroup({ children }: { children: ReactNode }) {
  return <div className={styles.group}>{children}</div>;
}

export function ToolbarDivider() {
  return <span role="separator" aria-orientation="vertical" className={styles.divider} />;
}

export interface ToolButtonProps {
  icon: IconName;
  label: string;
  shortcut?: string;
  active: boolean;
  onSelect: () => void;
  /** A 16×32 chevron after the tool opens these above it */
  menu?: MenuEntry[];
  onMenuSelect?: (id: string) => void;
  /** The chevron's name (Figma: "Move tools", "Shape tools"…); default "<label> options" */
  menuLabel?: string;
  disabled?: boolean;
  /** The chevron's own disabled state; default `disabled` (a slot whose shown tool is off can still offer the others) */
  menuDisabled?: boolean;
  /** Gallery: forced states */
  forceHover?: boolean;
  forceOpen?: boolean;
}

/** A 32px tool; active, the brand fill with the white glyph; tooltip above with its key. */
export function ToolButton({ icon, label, shortcut, active, onSelect, menu, onMenuSelect, menuLabel, disabled, menuDisabled = disabled, forceHover, forceOpen }: ToolButtonProps) {
  const chevron = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  // Live (toolbar/*-tools-menu.txt): the menu's left edge at the chevron's, its bottom 12 over the tool's top (4 over
  // the toolbar).
  const toggle = () => {
    const el = chevron.current;
    if (at || !el) return setAt(null);
    const r = el.getBoundingClientRect();
    setAt({ x: r.left, y: r.top - 12 });
  };
  return (
    <div data-ds="ToolButton" className={styles.tool} data-active={active || undefined}>
      {/* Disabled stays hoverable (aria-disabled, not the attribute) so its tooltip still says what it is */}
      <button type="button" aria-label={label} aria-pressed={active} aria-keyshortcuts={shortcut} aria-disabled={disabled || undefined} data-hover={forceHover || undefined} className={styles.button} onClick={disabled ? undefined : onSelect} {...tooltipProps(label, shortcut, "top")}>
        <Icon name={icon} />
      </button>
      {menu && (
        <>
          <button
            ref={chevron}
            type="button"
            aria-label={menuLabel ?? `${label} options`}
            aria-haspopup="menu"
            aria-expanded={Boolean(at) || Boolean(forceOpen)}
            data-open={at || forceOpen ? "" : undefined}
            disabled={menuDisabled}
            className={styles.chevron}
            onClick={toggle}
          >
            <Icon name="16.chevron.down" />
          </button>
          {at && (
            <ContextMenu
              at={at}
              above
              dropdown
              label={menuLabel ?? `${label} options`}
              entries={menu}
              ignore={chevron}
              onSelect={(id) => onMenuSelect?.(id)}
              onClose={() => {
                setAt(null);
                chevron.current?.focus({ preventScroll: true });
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

/** The 32px "?" circle at the canvas's bottom right (contract §4.24). */
export function HelpButton({ onClick, inline, label = "Help and resources" }: { onClick?: () => void; inline?: boolean; label?: string }) {
  return (
    <button type="button" data-ds="HelpButton" aria-label={label} className={cx(styles.help, inline && styles.inline)} onClick={onClick} {...tooltipProps(label, undefined, "top", "end")}>
      <Icon name="24.help" />
    </button>
  );
}
