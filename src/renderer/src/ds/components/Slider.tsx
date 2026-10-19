import { useRef, type HTMLAttributes, type KeyboardEvent, type PointerEvent } from "react";
import { cx } from "../util/cx";
import { MIXED, type ChangeInfo, type Mixed } from "../types";
import { STRINGS } from "../strings";
import { t, useT } from "@/i18n";
import styles from "./Slider.module.css";

export interface SliderProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  /** The accessible name (the number field beside it shows the same value) */
  label: string;
  /** MIXED: no thumb, read out "Mixed"; null: empty */
  value: Mixed<number> | null;
  min: number;
  max: number;
  /** The value snaps to it (default 1); ← → step by it, ⇧ by ten of it */
  step?: number;
  /** Per frame while dragged (`final: false`), once with `final: true` on release; keys and clicks are final */
  onChange: (v: number, info: ChangeInfo) => void;
  /** Esc while dragging (the value goes back) */
  onCancel?: () => void;
  disabled?: boolean;
}

/** `v` clamped to [min, max] and snapped to `step` from `min` (the step's own decimals, no float dust). */
export function sliderValue(v: number, min: number, max: number, step = 1): number {
  const clamped = Math.min(max, Math.max(min, v));
  if (!(step > 0)) return clamped;
  const decimals = Math.min(6, (String(step).split(".")[1] ?? "").length);
  const snapped = min + Math.round((clamped - min) / step) * step;
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals));
}

/** Where `v` sits on the track, 0–1. */
export const sliderFraction = (v: number, min: number, max: number): number => (max > min ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0);

/**
 * A horizontal slider (docs/design-system.md §4.38; Draw's sidebar, docs/draw.md §5.3; live 2026-10-18 slider.txt): a
 * 24 high hit area holding Figma's 6 px pill track — the part up to the value in the brand blue — and a 12 px white
 * round thumb with its shadow. A press anywhere on it jumps the
 * thumb there and drags: one gesture, `final: false` per move and `final: true` on release (one undo step); Esc while
 * dragging cancels. ← ↓ / → ↑ step, ⇧ ten steps, Home / End the ends. `role="slider"`; disabled at 40 %.
 */
export function Slider({ label, value, min, max, step = 1, onChange, onCancel, disabled, className, style, ...rest }: SliderProps) {
  useT();
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ last: number; id: number } | null>(null);
  const mixed = value === MIXED;
  const v = mixed || value === null ? null : value;
  const at = (clientX: number) => {
    const r = root.current!.getBoundingClientRect();
    const f = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return sliderValue(min + f * (max - min), min, max, step);
  };
  const end = (e: PointerEvent<HTMLDivElement>, cancel: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    root.current?.releasePointerCapture?.(d.id);
    if (cancel) onCancel?.();
    else onChange(d.last, { final: true, source: "drag" });
    e.preventDefault();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === "Escape" && drag.current) {
      drag.current = null;
      onCancel?.();
    } else {
      const base = v ?? min;
      const by = step * (e.shiftKey ? 10 : 1);
      const next = e.key === "ArrowRight" || e.key === "ArrowUp" ? base + by : e.key === "ArrowLeft" || e.key === "ArrowDown" ? base - by : e.key === "Home" ? min : e.key === "End" ? max : null;
      if (next === null) return;
      const snapped = sliderValue(next, min, max, step);
      if (snapped !== v) onChange(snapped, { final: true, source: "step" });
    }
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div
      ref={root}
      role="slider"
      data-ds="Slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={v ?? undefined}
      aria-valuetext={mixed ? t(STRINGS.mixed) : undefined}
      aria-disabled={disabled || undefined}
      data-mixed={mixed || undefined}
      tabIndex={disabled ? -1 : 0}
      className={cx(styles.slider, className)}
      style={{ ...style, ["--slider-fraction" as string]: v === null ? 0 : sliderFraction(v, min, max) }}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        root.current?.setPointerCapture?.(e.pointerId);
        root.current?.focus();
        const next = at(e.clientX);
        drag.current = { last: next, id: e.pointerId };
        onChange(next, { final: false, source: "drag" });
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const next = at(e.clientX);
        if (next === d.last) return;
        d.last = next;
        onChange(next, { final: false, source: "drag" });
      }}
      onPointerUp={(e) => end(e, false)}
      onPointerCancel={(e) => end(e, true)}
      onKeyDown={onKeyDown}
      {...rest}
    >
      <span className={styles.track}>
        <span className={styles.fill} />
      </span>
      {v !== null && <span className={styles.thumb} />}
    </div>
  );
}
