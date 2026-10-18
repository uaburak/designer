/**
 * Draw's sliders (docs/draw.md §5.3: "a streamlined set of illustration-related properties with slider controls"): a
 * DS Slider under each number field it belongs to — the field and the slider show the same value and write through
 * the same handlers, so a drag is one undo step as a scrub is. Only in Draw mode.
 */
import {  useT, t } from "@/i18n";
import { MIXED, PropertyRow, Slider, type ChangeInfo, type Mixed } from "@/ds";
import { useUI } from "../../hooks";

/** Draw is the editor's mode (the panels' reduced sections, sliders, larger previews, 48 px Layers rows). */
export const useDrawMode = (): boolean => useUI((s) => s.mode === "draw");

export interface SliderSpec {
  label: string;
  value: Mixed<number> | null | undefined;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number, info: ChangeInfo) => void;
  onCancel?: () => void;
  disabled?: boolean;
  /** The track's scale: even (default), or Figma's EXPONENTIAL (noise and texture sizes, the texture radius) */
  scale?: "linear" | "exponential";
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Figma's EXPONENTIAL slider (atlas 08 §6.3–6.4; its slider transform `Bk`): the track's position p over [min, max]
 * gives min + (max − min) · 10^(3 (f − 1)), f = (p − min) / (max − min) — a thousandth of the range at the left end,
 * a tenth at 2/3, all of it at the right — rounded to 2 decimals (`toValue`); `fromValue` puts a value back on the track.
 */
export function exponentialSlider(min: number, max: number): { toValue: (p: number) => number; fromValue: (v: number) => number } {
  const span = max - min;
  return {
    toValue: (p) => (p < min ? min : p > max ? max : round2(min + span * 10 ** (3 * ((p - min) / span - 1)))),
    fromValue: (v) => (v <= min ? min : v > max ? max : Math.max(min, round2(min + span * (Math.log10((v - min) / span) / 3 + 1)))),
  };
}

/** A slider bound to a number field's value (undefined = the field's absence value: shown as `min`). */
export function DrawSlider({ spec }: { spec: SliderSpec }) {
  useT();
  const value = spec.value === undefined ? spec.min : spec.value;
  const exp = spec.scale === "exponential" ? exponentialSlider(spec.min, spec.max) : null;
  const shown = value === MIXED ? MIXED : value === null || !exp ? value : exp.fromValue(value);
  const onChange = exp ? (p: number, info: ChangeInfo) => spec.onChange(exp.toValue(p), info) : spec.onChange;
  return <Slider label={t("{name} slider", { name: t(spec.label) })} value={shown} min={spec.min} max={spec.max} step={exp ? 0.01 : spec.step} disabled={spec.disabled} onChange={onChange} onCancel={spec.onCancel} data-draw-slider={spec.label} />;
}

/** A row of sliders, one per field column of the row above (null: an empty column). */
export function SliderRow({ sliders }: { sliders: (SliderSpec | null)[] }) {
  return (
    <PropertyRow data-draw-sliders="">
      {sliders.map((s, i) => (s ? <DrawSlider key={s.label} spec={s} /> : <span key={i} />))}
    </PropertyRow>
  );
}

/** Draw's slider ranges where a field has no bounds of its own [ours]. */
export const SLIDER_RANGE = {
  opacity: [0, 100],
  cornerRadius: [0, 100],
  strokeWeight: [0, 100],
  blur: [0, 100],
  spread: [-100, 100],
  percent: [0, 100],
  /** Figma's: noise / texture sizes and the texture's radius, 0.01–100 on an exponential track (atlas 08 §6.3–6.4) */
  noiseSize: [0.01, 100],
} as const;
