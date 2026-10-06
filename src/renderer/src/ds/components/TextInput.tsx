import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../util/cx";
import { exitKey, selectAllOnClick } from "../util/selectAll";
import { Icon, ICON_NAMES, type IconName } from "../icons/Icon";
import { isMixed, type ControlSize, type ExitReason, type Mixed } from "../types";
import { STRINGS } from "../strings";
import styles from "./Field.module.css";

/** A field prefix: a kit glyph by name, or one or two letters (W, H, X…). */
export function FieldPrefix({ prefix, className, ...rest }: { prefix: IconName | string; className?: string } & HTMLAttributes<HTMLSpanElement>) {
  const isIcon = (ICON_NAMES as string[]).includes(prefix);
  return (
    <span className={cx(styles.prefix, className)} {...rest}>
      {isIcon ? <Icon name={prefix as IconName} /> : prefix}
    </span>
  );
}

export interface TextInputProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "prefix"> {
  /** aria-label */
  label: string;
  value: Mixed<string>;
  /** Draft mode: Enter, Tab or leaving keeps what was typed (when it changed); Esc puts it back */
  onCommit?: (v: string) => void;
  /** Live mode: every keystroke */
  onChange?: (v: string) => void;
  placeholder?: string;
  prefix?: IconName | string;
  suffix?: ReactNode;
  variant?: "filled" | "outlined" | "ghost";
  size?: ControlSize;
  autoFocus?: boolean;
  /** default true */
  selectAllOnFocus?: boolean;
  maxLength?: number;
  disabled?: boolean;
  invalid?: boolean;
  onExit?: (r: ExitReason) => void;
}

/** Figma's one-line field (contract §4.4). */
export function TextInput({ label, value, onCommit, onChange, placeholder, prefix, suffix, variant = "filled", size = "default", autoFocus, selectAllOnFocus = true, maxLength, disabled, invalid, onExit, className, ...rest }: TextInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const exitBy = useRef<ExitReason>("blur");
  const input = useRef<HTMLInputElement>(null);
  const mixed = isMixed(value);
  // Focused on mount without scrolling the page (an inline rename must not jump its panel).
  useEffect(() => {
    if (!autoFocus) return;
    input.current?.focus({ preventScroll: true });
    if (selectAllOnFocus) input.current?.select();
  }, [autoFocus, selectAllOnFocus]);
  const shown = draft ?? (mixed ? "" : value);
  return (
    <div
      data-ds="TextInput"
      data-disabled={disabled || undefined}
      aria-invalid={invalid || undefined}
      className={cx(styles.field, variant === "outlined" && styles.outlined, variant === "ghost" && styles.ghost, size === "large" && styles.large, className)}
      {...rest}
    >
      {prefix !== undefined && <FieldPrefix prefix={prefix} />}
      <input
        ref={input}
        aria-label={label}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        maxLength={maxLength}
        value={shown}
        placeholder={mixed ? STRINGS.mixed : placeholder}
        spellCheck={false}
        {...(selectAllOnFocus ? selectAllOnClick : {})}
        onFocus={(e) => selectAllOnFocus && e.currentTarget.select()}
        onChange={(e) => (onCommit ? setDraft(e.target.value) : onChange?.(e.target.value))}
        onBlur={(e) => {
          const typed = e.currentTarget.value;
          const keep = onCommit && draft !== null && !cancelled.current && (mixed || typed !== value);
          cancelled.current = false;
          setDraft(null);
          if (keep) onCommit(typed);
          const reason = exitBy.current;
          exitBy.current = "blur";
          onExit?.(reason);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          const r = exitKey(e);
          if (!r) return;
          exitBy.current = r;
          if (r === "escape") {
            cancelled.current = true;
            setDraft(null);
          }
          if (r === "enter" || r === "escape") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className={cx(styles.input, prefix === undefined && styles.padStart, suffix === undefined && styles.padEnd, mixed && draft === null && styles.mixed)}
      />
      {suffix !== undefined && <span className={styles.suffix}>{suffix}</span>}
    </div>
  );
}

export interface TextAreaProps extends Omit<HTMLAttributes<HTMLTextAreaElement>, "onChange"> {
  label: string;
  value: string;
  onCommit?: (v: string) => void;
  onChange?: (v: string) => void;
  placeholder?: string;
  minRows?: number;
  maxRows?: number;
  disabled?: boolean;
  onExit?: (r: ExitReason) => void;
}

/** A multi-line field: the same box, 3 to 8 rows; Enter is a newline, ⌘Enter commits, Esc reverts. */
export function TextArea({ label, value, onCommit, onChange, placeholder, minRows = 3, maxRows = 8, disabled, onExit, className, ...rest }: TextAreaProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const lines = (draft ?? value).split("\n").length;
  const rows = Math.max(minRows, Math.min(maxRows, lines));
  return (
    <textarea
      data-ds="TextArea"
      aria-label={label}
      disabled={disabled}
      rows={rows}
      value={draft ?? value}
      placeholder={placeholder}
      spellCheck={false}
      className={cx(styles.textarea, className)}
      style={{ height: rows * 16 + 10 }}
      onChange={(e) => (onCommit ? setDraft(e.target.value) : onChange?.(e.target.value))}
      onBlur={(e) => {
        const typed = e.currentTarget.value;
        const keep = onCommit && draft !== null && !cancelled.current && typed !== value;
        cancelled.current = false;
        setDraft(null);
        if (keep) onCommit(typed);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.currentTarget.blur();
          onExit?.("enter");
        }
        if (e.key === "Escape") {
          cancelled.current = true;
          setDraft(null);
          e.currentTarget.blur();
          onExit?.("escape");
        }
      }}
      {...rest}
    />
  );
}
