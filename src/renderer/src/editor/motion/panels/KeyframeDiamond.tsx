/**
 * The right panel's diamond before a keyframable field (docs/motion.md §6.5): empty when the field has no track, an
 * outline when it has one, filled when a keyframe sits at the playhead. Clicking it adds a keyframe at the playhead
 * ("Add keyframe", Figma's wording) or removes the one there.
 */
import type { DiamondState } from "@shared/motion/types";
import { t } from "@/i18n";
import styles from "./MotionPanels.module.css";

export function KeyframeDiamond({ state, onClick, disabled }: { state: DiamondState; onClick(): void; disabled?: boolean }) {
  const label = state === "keyframe" ? t("Remove keyframe") : t("Add keyframe");
  return (
    <button type="button" className={styles.diamond} data-state={state} aria-label={label} title={label} aria-pressed={state === "keyframe"} disabled={disabled} onClick={onClick}>
      <svg viewBox="0 0 16 16" aria-hidden>
        <path d="M8 3 13 8 8 13 3 8Z" />
      </svg>
    </button>
  );
}
