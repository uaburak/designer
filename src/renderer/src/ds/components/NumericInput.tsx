import { capture, release } from "../util/pointer";
import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../util/cx";
import { commitTyped, formatNumber } from "../util/evaluate";
import { scrubValue, stepValue, SCRUB_THRESHOLD } from "../util/scrub";
import { exitKey, selectAllOnClick } from "../util/selectAll";
import { isMixed, type ChangeInfo, type ExitReason, type Mixed } from "../types";
import type { IconName } from "../icons/Icon";
import { STRINGS } from "../strings";
import { FieldPrefix } from "./TextInput";
import styles from "./Field.module.css";

export interface NumericInputProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "prefix"> {
  label: string;
  /** A letter (W, H, X, Y) or a glyph; dragging it scrubs */
  prefix?: IconName | string;
  /** null = empty */
  value: Mixed<number> | null;
  onChange: (v: number, info: ChangeInfo) => void;
  /** Esc during a scrub: put the value back */
  onCancel?: () => void;
  /** Emptied and committed */
  onClear?: () => void;
  /** ↑ ↓ while the value is Mixed: the editor adds the delta to each layer */
  onStep?: (delta: number) => void;
  min?: number;
  max?: number;
  step?: number;
  bigStep?: number;
  /** Decimals shown and kept (default 2) */
  precision?: number;
  /** Hugs the number ("100%", "0°") */
  unit?: string;
  /** Scrub by dragging the prefix (default true) */
  scrub?: boolean;
  placeholder?: string;
  suffix?: ReactNode;
  disabled?: boolean;
  variant?: "filled" | "ghost";
  onExit?: (r: ExitReason) => void;
  /** The canvas highlights what a padding / gap field edits */
  onFocusChange?: (focused: boolean) => void;
  /** Drawn inside another field (the colour row's opacity) */
  bare?: boolean;
}

/**
 * Figma's numeric field (contract §4.5; behaviour ported from figma/ui.tsx):
 * a number or arithmetic, a typed unit ignored, clamped and rounded; Enter,
 * Tab or leaving commits, Esc reverts; ↑ ↓ step (⇧ big step) with the text
 * selected after; dragging the prefix scrubs 1 unit a px (⇧ ×10, ⌥ ×0.1)
 * — `final: false` each frame, one `final: true` on release, Esc cancels;
 * a press without movement focuses the field.
 */
export function NumericInput({ label, prefix, value, onChange, onCancel, onClear, onStep, min = -1e6, max = 1e6, step = 1, bigStep = 10, precision = 2, unit, scrub = true, placeholder, suffix, disabled, variant = "filled", onExit, onFocusChange, bare, className, ...rest }: NumericInputProps) {
  const mixed = isMixed(value);
  const current = mixed ? null : value;
  const base = current ?? 0;
  const [draft, setDraft] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const typing = useRef(false);
  const exitBy = useRef<ExitReason>("blur");
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; start: number; last: number; moved: boolean; id: number; el: HTMLElement } | null>(null);
  const text = draft ?? (current === null ? "" : formatNumber(current, precision));
  const shownPlaceholder = mixed ? STRINGS.mixed : placeholder;

  const finish = (raw?: string) => {
    if (!typing.current) return;
    typing.current = false;
    setDraft(null);
    if (raw === undefined) return;
    const r = commitTyped(raw, current, { min, max, precision, unit });
    if (r === "clear") onClear?.();
    else if (r !== null) onChange(r, { final: true, source: "type" });
  };

  const endScrub = (cancel: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.documentElement.removeAttribute("data-cursor");
    release(d.el, d.id);
    setScrubbing(false);
    onFocusChange?.(false);
    if (!d.moved) {
      input.current?.focus();
      return;
    }
    if (cancel) onCancel?.();
    else onChange(d.last, { final: true, source: "scrub" });
  };

  // Esc during a scrub cancels it.
  useEffect(() => {
    if (!scrubbing) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      endScrub(true);
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  });

  const canScrub = scrub && !disabled && !mixed && prefix !== undefined;
  return (
    <div
      data-ds="NumericInput"
      data-disabled={disabled || undefined}
      data-scrubbing={scrubbing || undefined}
      className={cx(styles.field, variant === "ghost" && styles.ghost, bare && styles.bare, className)}
      {...rest}
    >
      {prefix !== undefined && (
        <FieldPrefix
          prefix={prefix}
          className={cx(canScrub && styles.scrub)}
          onPointerDown={(e) => {
            if (!canScrub || e.button !== 0) return;
            e.preventDefault();
            capture(e.currentTarget, e.pointerId);
            drag.current = { x: e.clientX, start: base, last: base, moved: false, id: e.pointerId, el: e.currentTarget };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.x;
            if (!d.moved) {
              if (Math.abs(dx) < SCRUB_THRESHOLD) return;
              d.moved = true;
              setScrubbing(true);
              document.documentElement.setAttribute("data-cursor", "ew-resize");
              onFocusChange?.(true);
            }
            const next = scrubValue(d.start, dx, { step, shift: e.shiftKey, alt: e.altKey, min, max, precision });
            if (next !== d.last) {
              d.last = next;
              onChange(next, { final: false, source: "scrub" });
            }
          }}
          onPointerUp={() => endScrub(false)}
          onPointerCancel={() => endScrub(true)}
        />
      )}
      <input
        ref={input}
        aria-label={label}
        inputMode="decimal"
        disabled={disabled}
        value={text}
        placeholder={shownPlaceholder}
        spellCheck={false}
        // With a unit the number hugs it: as wide as its digits (plus its start padding — the box is border-box).
        style={unit ? { width: `calc(${Math.max(1, (text || shownPlaceholder || "").length) + 0.2}ch + ${prefix === undefined ? 8 : 0}px)` } : undefined}
        {...selectAllOnClick}
        onChange={(e) => {
          typing.current = true;
          setDraft(e.target.value);
        }}
        onFocus={(e) => {
          e.currentTarget.select();
          onFocusChange?.(true);
        }}
        onBlur={(e) => {
          finish(e.currentTarget.value);
          onFocusChange?.(false);
          const reason = exitBy.current;
          exitBy.current = "blur";
          onExit?.(reason);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const dir = e.key === "ArrowUp" ? 1 : -1;
            typing.current = false;
            setDraft(null);
            if (mixed) onStep?.(dir * (e.shiftKey ? bigStep : step));
            else {
              const next = stepValue(base, dir, { step, bigStep, shift: e.shiftKey, min, max, precision });
              if (next !== current) onChange(next, { final: true, source: "step" });
            }
            const el = e.currentTarget;
            requestAnimationFrame(() => el.select());
            return;
          }
          const r = exitKey(e);
          if (!r) return;
          exitBy.current = r;
          if (r === "escape") {
            typing.current = false;
            setDraft(null);
          }
          if (r === "enter" || r === "escape") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className={cx(styles.input, styles.tabular, unit && styles.hug, prefix === undefined && styles.padStart, mixed && draft === null && styles.mixed)}
      />
      {unit && (
        <>
          {(text !== "" || !shownPlaceholder) && <span className={styles.unit}>{unit}</span>}
          <span
            className={styles.filler}
            onPointerDown={(e) => {
              e.preventDefault();
              input.current?.focus();
              input.current?.select();
            }}
          />
        </>
      )}
      {suffix !== undefined && <span className={styles.suffix}>{suffix}</span>}
    </div>
  );
}
