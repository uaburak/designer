/**
 * The keyframe diamond (docs/motion.md §6.5), Figma's (docs/research/figma/live/2026-10-18/motion.txt): a 24 × 24
 * button holding Figma's rounded 8 px diamond. In the right panel it is the last cell of a field's joined control (the
 * field's grey, its right corners rounded): outlined in the icon colour when the field has no track; on the selected
 * blue with a light-blue outline when it has one (or auto-keyframe is on); filled light blue at a keyframe on the
 * playhead. Clicking it adds a keyframe at the playhead ("Add keyframe", Figma's wording) or removes the one there.
 * `bare`: the timeline's own (no cell).
 */
import type { DiamondState } from "@shared/motion/types";
import { t } from "@/i18n";
import styles from "./MotionPanels.module.css";

/** Figma's diamond path (24 box). */
export const DIAMOND_PATH =
  "M11.6465 8.06055C11.8417 7.8654 12.1583 7.86537 12.3535 8.06055L15.9395 11.6465C16.1346 11.8417 16.1346 12.1583 15.9395 12.3535L12.3535 15.9395C12.1583 16.1346 11.8417 16.1346 11.6465 15.9395L8.06055 12.3535C7.86538 12.1583 7.86538 11.8417 8.06055 11.6465L11.6465 8.06055Z";

export function DiamondGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden>
      <path d={DIAMOND_PATH} />
    </svg>
  );
}

export function KeyframeDiamond({ state, onClick, disabled, auto, bare }: { state: DiamondState; onClick(): void; disabled?: boolean; auto?: boolean; bare?: boolean }) {
  const label = state === "keyframe" ? t("Remove keyframe") : t("Add keyframe");
  return (
    <button type="button" className={bare ? styles.diamondBare : styles.diamond} data-state={state} data-auto={auto || undefined} aria-label={label} title={label} aria-pressed={state === "keyframe"} disabled={disabled} onClick={onClick}>
      <DiamondGlyph />
    </button>
  );
}
