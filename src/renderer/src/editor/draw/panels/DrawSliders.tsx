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
}

/** A slider bound to a number field's value (undefined = the field's absence value: shown as `min`). */
export function DrawSlider({ spec }: { spec: SliderSpec }) {
  useT();
  const value = spec.value === undefined ? spec.min : spec.value;
  return <Slider label={t("{name} slider", { name: t(spec.label) })} value={value === MIXED ? MIXED : value} min={spec.min} max={spec.max} step={spec.step} disabled={spec.disabled} onChange={spec.onChange} onCancel={spec.onCancel} data-draw-slider={spec.label} />;
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
  noiseSize: [0, 10],
} as const;
