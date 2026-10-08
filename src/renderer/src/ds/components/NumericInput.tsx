import { capture, release } from "../util/pointer";
import { useEffect, useRef, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cx } from "../util/cx";
import { commitTyped, formatNumber } from "../util/evaluate";
import { scrubRate, scrubValue, stepValue, SCRUB_THRESHOLD } from "../util/scrub";
import { exitKey, selectAllOnClick } from "../util/selectAll";
import { useReturnFocus } from "../util/returnFocus";
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
  /**
   * "Mixed+100" typed while the value is Mixed (help: "will apply to all selected layers"): the editor applies `each`
   * (already clamped and rounded) to every layer's own value
   */
  onExpression?: (each: (x: number) => number, info: ChangeInfo) => void;
  /** Words the field takes besides numbers (a gap's "Auto", a line height's "Auto"): typed in any case */
  keywords?: readonly string[];
  onKeyword?: (word: string) => void;
  /** Sees what was typed first; true when it took it (padding's CSS shorthand "8 16") */
  onText?: (raw: string) => boolean;
  min?: number;
  max?: number;
  step?: number;
  bigStep?: number;
  /** Decimals shown and kept (default 2) */
  precision?: number;
  /** Hugs the number ("100%", "0°") */
  unit?: string;
  /** Scrub by dragging the prefix, or the field with ⌥ held (default true) */
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
  /**
   * Shown instead of the number while the field isn't focused (a gap's "Auto"); focusing it shows the number, and
   * typing one commits as usual
   */
  valueLabel?: string;
  /** Shown after the number, right-aligned, while not focused (W / H: "Hug", "Fill") */
  modeLabel?: string;
}

/**
 * Figma's numeric field (contract §4.5; help.figma.com 360039956914): a number or arithmetic (+ − × ÷ ^ and
 * parentheses; "Mixed+100" on a Mixed field applies to each layer), a typed unit ignored, clamped and rounded.
 * Enter commits and gives focus back (to the canvas: `ReturnFocusProvider`); Tab or leaving commits; Esc puts the
 * typed text back and keeps the field focused with its text selected, a second Esc leaves like Enter
 * (live/behaviour/fields.md). ↑ ↓ step (⇧ big step). Dragging the prefix — or the field while ⌥ is held — scrubs: 1 unit a
 * px (⇧ ×10), faster toward the top of the screen and slower toward the bottom (2x, 1x, 1/2, 1/4): `final:
 * false` each frame, one `final: true` on release, Esc cancels; a press without movement focuses the field.
 */
export function NumericInput({ label, prefix, value, onChange, onCancel, onClear, onStep, onExpression, keywords, onKeyword, onText, min = -1e6, max = 1e6, step = 1, bigStep = 10, precision = 2, unit, scrub = true, placeholder, suffix, disabled, variant = "filled", onExit, onFocusChange, bare, valueLabel, modeLabel, className, ...rest }: NumericInputProps) {
  const mixed = isMixed(value);
  const current = mixed ? null : value;
  const base = current ?? 0;
  const [draft, setDraft] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [altHover, setAltHover] = useState(false);
  const [speed, setSpeed] = useState(1);
  const typing = useRef(false);
  const exitBy = useRef<ExitReason>("blur");
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number; start: number; last: number; moved: boolean; rate: number; id: number; el: HTMLElement } | null>(null);
  const [focused, setFocused] = useState(false);
  const returnFocus = useReturnFocus();
  // Figma writes the unit in the field's text ("100%", "0°"); a bare field (the colour row's opacity) puts it after the number.
  const unitInside = !!unit && !bare;
  const shown = valueLabel !== undefined && !focused && !scrubbing ? valueLabel : mixed ? STRINGS.mixed : current === null ? "" : formatNumber(current, precision) + (unitInside ? unit : "");
  const unitAfter = !!unit && !unitInside;
  const text = draft ?? shown;

  const finish = (raw?: string) => {
    if (!typing.current) return;
    typing.current = false;
    setDraft(null);
    if (raw === undefined) return;
    const word = keywords?.find((k) => k.toLowerCase() === raw.trim().toLowerCase());
    if (!word && onText?.(raw)) return;
    if (word) {
      onKeyword?.(word);
      return;
    }
    const r = commitTyped(raw, current, { min, max, precision, unit });
    if (r === "clear") onClear?.();
    else if (typeof r === "number") onChange(r, { final: true, source: "type" });
    else if (r) onExpression?.(r.each, { final: true, source: "type" });
  };

  const startScrub = (e: ReactPointerEvent<HTMLElement>) => {
    capture(e.currentTarget, e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: base, last: base, moved: false, rate: 1, id: e.pointerId, el: e.currentTarget };
  };
  const moveScrub = (e: ReactPointerEvent<HTMLElement>) => {
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
    const rate = scrubRate(e.clientY - d.y);
    if (rate !== d.rate) {
      // A speed change keeps the value reached and goes on from there at the new rate.
      d.rate = rate;
      d.start = d.last;
      d.x = e.clientX;
      setSpeed(rate);
      document.documentElement.setAttribute("data-scrub-speed", String(rate));
    }
    const next = scrubValue(d.start, e.clientX - d.x, { step, bigStep, shift: e.shiftKey, min, max, precision, rate });
    if (next !== d.last) {
      d.last = next;
      onChange(next, { final: false, source: "scrub" });
    }
  };
  const endScrub = (cancel: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.documentElement.removeAttribute("data-cursor");
    document.documentElement.removeAttribute("data-scrub-speed");
    release(d.el, d.id);
    setScrubbing(false);
    setSpeed(1);
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

  const canScrub = scrub && !disabled && !mixed;
  // ⌥ over the field: the scrub cursor, and a drag on the number scrubs instead of selecting text.
  useEffect(() => {
    if (!canScrub || focused) return;
    const root = input.current?.parentElement;
    if (!root) return;
    let over = false;
    const sync = (alt: boolean) => setAltHover(over && alt);
    const enter = (e: PointerEvent) => ((over = true), sync(e.altKey));
    const leave = () => ((over = false), sync(false));
    const keys = (e: KeyboardEvent) => sync(e.altKey);
    root.addEventListener("pointerenter", enter);
    root.addEventListener("pointerleave", leave);
    window.addEventListener("keydown", keys);
    window.addEventListener("keyup", keys);
    return () => {
      root.removeEventListener("pointerenter", enter);
      root.removeEventListener("pointerleave", leave);
      window.removeEventListener("keydown", keys);
      window.removeEventListener("keyup", keys);
    };
  }, [canScrub, focused]);

  return (
    <div
      data-ds="NumericInput"
      data-disabled={disabled || undefined}
      data-scrubbing={scrubbing || undefined}
      data-alt-scrub={(altHover && canScrub) || undefined}
      data-mixed={(mixed && draft === null) || undefined}
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
            startScrub(e);
          }}
          onPointerMove={moveScrub}
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
        placeholder={placeholder}
        spellCheck={false}
        // With a unit the number hugs it: as wide as its digits (plus its start padding — the box is border-box).
        style={modeLabel ? { width: `calc(${Math.max(1, (text || placeholder || "").length) + 0.2}ch + ${prefix === undefined ? 8 : 0}px)` } : undefined}
        onPointerDown={(e) => {
          if (canScrub && e.altKey && e.button === 0 && document.activeElement !== e.currentTarget) {
            e.preventDefault();
            startScrub(e);
            return;
          }
          selectAllOnClick.onPointerDown(e);
        }}
        onPointerMove={moveScrub}
        onPointerUp={() => endScrub(false)}
        onPointerCancel={() => endScrub(true)}
        onMouseUp={selectAllOnClick.onMouseUp}
        onChange={(e) => {
          typing.current = true;
          setDraft(e.target.value);
        }}
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
          const el = e.currentTarget;
          requestAnimationFrame(() => {
            if (document.activeElement === el) el.select();
          });
          onFocusChange?.(true);
        }}
        onBlur={(e) => {
          setFocused(false);
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
          if (r === "escape" && typing.current) {
            // First Esc: the typed text goes, the field keeps focus with the value selected.
            e.preventDefault();
            typing.current = false;
            setDraft(null);
            const el = e.currentTarget;
            requestAnimationFrame(() => {
              if (document.activeElement === el) el.select();
            });
            return;
          }
          exitBy.current = r;
          if (r === "enter" || r === "escape") {
            // Enter commits (on blur); a second Esc leaves as it is. Either way the keys go back to the canvas.
            e.preventDefault();
            e.currentTarget.blur();
            returnFocus?.();
          }
        }}
        className={cx(styles.input, styles.tabular, modeLabel && styles.hug, unitAfter && styles.opacityInput, prefix === undefined && styles.padStart, mixed && draft === null && styles.mixedText)}
      />
      {unitAfter && (
        <>
          {text !== "" && !(mixed && draft === null) && <span className={styles.unit}>{unit}</span>}
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
      {modeLabel && (
        <span
          className={styles.modeLabel}
          onPointerDown={(e) => {
            e.preventDefault();
            input.current?.focus();
            input.current?.select();
          }}
        >
          {modeLabel}
        </span>
      )}
      {suffix !== undefined && <span className={styles.suffix}>{suffix}</span>}
      {scrubbing && speed !== 1 && (
        <span className={styles.scrubSpeed} role="status" data-scrub-speed={speed}>
          {speed === 2 ? "2x" : speed === 0.5 ? "1/2" : "1/4"}
        </span>
      )}
    </div>
  );
}
