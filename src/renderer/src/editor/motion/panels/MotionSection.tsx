/**
 * The right panel in Motion mode (docs/motion.md §6.5), increment 1: a "Motion" section listing the selection's
 * keyframable fields with their diamonds (none / a track / a keyframe at the playhead, from `motionFieldStates`) and
 * the field's current value. Clicking a diamond adds a keyframe at the playhead (MOTION_ADD_KEYFRAME, the engine
 * reads the value) or removes the one there (MOTION_DELETE_KEYFRAMES).
 *
 * Later increments put the diamonds beside Design's own fields (Transform, Appearance, Fill, Stroke, Effects), add the
 * Transform section (position from the anchor, Edit anchor point), Path trim, Animations and Audio.
 */
import { useEffect, useMemo, useState } from "react";
import { PanelSection } from "@/ds";
import { t, useT } from "@/i18n";
import { KEYFRAME_FIELDS, fieldKey, type DiamondState, type FieldStates, type KeyframeField, type KeyframePropertyFieldName } from "@shared/motion/types";
import { useEditor } from "../../controller";
import { useTopics, useUI } from "../../hooks";
import type { PanelNode } from "../../panels/design/shared";
import { MOTION_UI_DEFAULT } from "../../uiStore";
import { motionRead } from "../motionState";
import { KeyframeDiamond } from "./KeyframeDiamond";
import styles from "./MotionPanels.module.css";

/** The rows of increment 1, in the panel's order (names from KEYFRAME_FIELDS). */
export const MOTION_SECTION_FIELDS: readonly KeyframePropertyFieldName[] = ["OPACITY", "CORNER_RADIUS", "STROKE_WEIGHT", "WIDTH", "HEIGHT", "TRANSLATION_XY", "ROTATION", "SCALE_XY"];

const round = (v: number) => Math.round(v * 100) / 100;

/** The field's value as the node carries it now (the motion layer's, in Motion mode): blank for fields the panel node doesn't hold. */
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

/** The selection's diamond for a field: a keyframe when every node has one at the playhead, a track when any has one. */
export function combinedState(states: FieldStates, refs: readonly string[], key: string): { state: DiamondState; keyframes: string[] } {
  const per = refs.map((r) => states[r]?.[key] ?? { state: "none" as DiamondState });
  const keyframes = per.flatMap((s) => (s.keyframe ? [s.keyframe] : []));
  if (per.length && per.every((s) => s.state === "keyframe")) return { state: "keyframe", keyframes };
  if (per.some((s) => s.state !== "none")) return { state: "track", keyframes };
  return { state: "none", keyframes };
}

export function MotionSection({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  const refs = useMemo(() => nodes.map((n) => String(n.guid)), [nodes]);
  const timeUs = useUI((s) => (s.motion ?? MOTION_UI_DEFAULT).timeUs);
  const version = useTopics(ed.store, ["selection", "structure", "undo"]);
  const [motionVersion, setMotionVersion] = useState(0);
  useEffect(() => ed.engine.on("MOTION_CHANGED", () => setMotionVersion((v) => v + 1)), [ed]);
  const states = useMemo<FieldStates>(() => {
    void version;
    void motionVersion;
    void timeUs;
    return motionRead(() => ed.engine.motionFieldStates(refs), {});
  }, [ed, refs, version, motionVersion, timeUs]);

  const toggle = (name: KeyframePropertyFieldName, state: DiamondState, keyframes: string[]) => {
    const field: KeyframeField = { type: "PROPERTY", name };
    try {
      if (state === "keyframe") ed.engine.runMotionCommand("MOTION_DELETE_KEYFRAMES", { ids: keyframes });
      else ed.engine.runMotionCommand("MOTION_ADD_KEYFRAME", { nodes: refs, field, timeUs });
    } catch {
      // The engine's Motion commands not built in this wasm.
    }
  };

  return (
    <PanelSection title={t("Motion")} data-motion-section>
      {MOTION_SECTION_FIELDS.map((name) => {
        const key = fieldKey({ type: "PROPERTY", name });
        const { state, keyframes } = combinedState(states, refs, key);
        return (
          <div key={name} className={styles.row} data-state={state} data-motion-field={name}>
            <KeyframeDiamond state={state} onClick={() => toggle(name, state, keyframes)} />
            <span className={styles.label}>{t(KEYFRAME_FIELDS[name].label)}</span>
            <span className={styles.value}>{valueText(name, nodes)}</span>
          </div>
        );
      })}
    </PanelSection>
  );
}
