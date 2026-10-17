/**
 * The right panel in Motion mode (docs/motion.md §6.5): a "Motion" section listing the selection's keyframable fields
 * with their diamonds (none / a track / a keyframe at the playhead, from `motionFieldStates`) and the field's value at
 * the playhead. Clicking a diamond adds a keyframe at the playhead (MOTION_ADD_KEYFRAME, the engine reads the value) or
 * removes the one there (MOTION_DELETE_KEYFRAMES).
 *
 * The values are the live nodes' (the store reads them again whenever the playhead moves, motionState.pushMotion), so
 * Opacity, Corner radius, Stroke weight, Width and Height are the motion layer's; Position, Rotation and Scale are
 * motion-only fields without a node prop to read (blank until the engine gives their evaluated values). Increment 2
 * puts the same diamonds beside Design's own fields (MotionField.tsx); later increments add the Transform section
 * (position from the anchor, Edit anchor point), Path trim, Animations and Audio.
 */
import { PanelSection } from "@/ds";
import { t, useT } from "@/i18n";
import { KEYFRAME_FIELDS, fieldKey, type KeyframePropertyFieldName } from "@shared/motion/types";
import { useEditor } from "../../controller";
import type { PanelNode } from "../../panels/design/shared";
import { KeyframeDiamond } from "./KeyframeDiamond";
import { MotionFieldStates, combinedState, toggleKeyframe, useMotionStates } from "./MotionField";
import styles from "./MotionPanels.module.css";

export { combinedState };

/** The rows of increment 1, in the panel's order (names from KEYFRAME_FIELDS). */
export const MOTION_SECTION_FIELDS: readonly KeyframePropertyFieldName[] = ["OPACITY", "CORNER_RADIUS", "STROKE_WEIGHT", "WIDTH", "HEIGHT", "TRANSLATION_XY", "ROTATION", "SCALE_XY"];

const round = (v: number) => Math.round(v * 100) / 100;

/** The field's value as the live node carries it (the motion layer's at the playhead): blank for fields the panel node doesn't hold. */
function valueText(field: KeyframePropertyFieldName, nodes: readonly PanelNode[]): string {
  const vals = nodes.map((n) => {
    switch (field) {
      case "OPACITY": return n.opacity === undefined ? undefined : `${Math.round((n.opacity ?? 1) * 100)}%`;
      case "CORNER_RADIUS": return n.cornerRadius === undefined ? undefined : String(round(n.cornerRadius));
      case "STROKE_WEIGHT": return n.strokeWeight === undefined ? undefined : String(round(n.strokeWeight));
      case "WIDTH": return n.size ? String(round(n.size.x)) : undefined;
      case "HEIGHT": return n.size ? String(round(n.size.y)) : undefined;
      default: return undefined;
    }
  });
  if (vals.some((v) => v === undefined)) return "";
  return new Set(vals).size === 1 ? vals[0]! : t("Mixed");
}

export function MotionSection({ nodes }: { nodes: PanelNode[] }) {
  // DesignPanel's shared read in Motion mode; mounted on its own, the section makes its own.
  const shared = useMotionStates();
  if (!shared)
    return (
      <MotionFieldStates nodes={nodes}>
        <MotionSection nodes={nodes} />
      </MotionFieldStates>
    );
  return <MotionRows nodes={nodes} />;
}

function MotionRows({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  const { refs, states, timeUs } = useMotionStates()!;
  return (
    <PanelSection title={t("Motion")} data-motion-section>
      {MOTION_SECTION_FIELDS.map((name) => {
        const key = fieldKey({ type: "PROPERTY", name });
        const { state, keyframes } = combinedState(states, refs, key);
        return (
          <div key={name} className={styles.row} data-state={state} data-motion-field={name}>
            <KeyframeDiamond state={state} onClick={() => toggleKeyframe(ed, refs, { type: "PROPERTY", name }, state, keyframes, timeUs)} />
            <span className={styles.label}>{t(KEYFRAME_FIELDS[name].label)}</span>
            <span className={styles.value}>{valueText(name, nodes)}</span>
          </div>
        );
      })}
    </PanelSection>
  );
}
