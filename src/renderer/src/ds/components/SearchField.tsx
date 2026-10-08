import { useRef, type HTMLAttributes } from "react";
import { cx } from "../util/cx";
import { Icon } from "../icons/Icon";
import type { ControlSize, ExitReason } from "../types";
import { STRINGS } from "../strings";
import styles from "./Field.module.css";

export interface SearchFieldProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "onSubmit"> {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** default 24 (panels), large 32 (Home) */
  size?: ControlSize;
  autoFocus?: boolean;
  onSubmit?: () => void;
  onExit?: (r: ExitReason) => void;
  label?: string;
  /** Focus selects the text (live: the font picker opens on the family's name, selected) */
  selectOnFocus?: boolean;
}

/** A search box (contract §4.28): the magnifier, the query, × while there is text. Esc clears, a second Esc leaves; ↓ hands focus to the list. */
export function SearchField({ value, onChange, placeholder = STRINGS.search, size = "default", autoFocus, onSubmit, onExit, label = STRINGS.search, selectOnFocus, className, ...rest }: SearchFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div data-ds="SearchField" role="search" className={cx(styles.field, size === "large" && styles.large, className)} {...rest}>
      <span className={styles.prefix} style={{ color: "var(--figma-color-icon-secondary)" }}>
        <Icon name="24.search.small" />
      </span>
      <input
        ref={input}
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        onFocus={selectOnFocus ? (e) => e.currentTarget.select() : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            if (value) onChange("");
            else {
              e.currentTarget.blur();
              onExit?.("escape");
            }
          } else if (e.key === "Enter") onSubmit?.();
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            onExit?.("tab");
          }
        }}
        className={cx(styles.input, !value && styles.padEnd)}
      />
      {value && (
        <button type="button" aria-label={STRINGS.clear} className={styles.clear} onClick={() => { onChange(""); input.current?.focus(); }}>
          <Icon name="24.close.small" />
        </button>
      )}
    </div>
  );
}
