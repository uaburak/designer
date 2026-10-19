/**
 * The diamonds of the fields in Motion mode (docs/motion.md §6.5, §6.13): Transform's Position / Scale / Rotation, W / H,
 * Opacity, Corner radius, Stroke weight, a solid paint's colour — each joined with its diamond as the control's last
 * cell, Figma's way: outlined without a track, on the selected blue with one (or with auto-keyframe on), filled at a
 * keyframe on the playhead; a click adds the keyframe there or removes it.
 *
 * DesignPanel puts `MotionFieldStates` around its sections in Motion mode: one `motionFieldStates` read for the
 * selection, re-read when the document, the selection, Motion or the playhead changed, shared by every diamond. Out of
 * Motion mode there is no provider and a `MotionField` is its field alone.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fieldKey, type DiamondState, type FieldStates, type KeyframeField, type KeyframePropertyFieldName } from "@shared/motion/types";
import { useEditor, type EditorController } from "../../controller";
import { useTopics, useUI } from "../../hooks";
import type { PanelNode } from "../../panels/design/shared";
import { MOTION_UI_DEFAULT } from "../../uiStore";
import { motionRead } from "../motionState";
import { KeyframeDiamond } from "./KeyframeDiamond";
import styles from "./MotionPanels.module.css";

interface MotionStates {
  refs: string[];
  states: FieldStates;
  timeUs: number;
  /** Auto-keyframe on: every diamond reads as keyed-to-be (Figma tints them all) */
  auto: boolean;
}

const MotionStatesContext = createContext<MotionStates | null>(null);

/** The selection's diamonds: `motionFieldStates` at the playhead, re-read on every change that can move them. */
export function useMotionFieldStates(nodes: readonly PanelNode[]): MotionStates {
  const ed = useEditor();
  const refs = useMemo(() => nodes.map((n) => String(n.guid)), [nodes]);
  const timeUs = useUI((s) => (s.motion ?? MOTION_UI_DEFAULT).timeUs);
  const auto = useUI((s) => !!(s.motion ?? MOTION_UI_DEFAULT).autoKeyframe);
  const version = useTopics(ed.store, ["selection", "structure", "undo"]);
  const [motionVersion, setMotionVersion] = useState(0);
  useEffect(() => ed.engine.on("MOTION_CHANGED", () => setMotionVersion((v) => v + 1)), [ed]);
  const states = useMemo<FieldStates>(() => {
    void version;
    void motionVersion;
    void timeUs;
    return motionRead(() => ed.engine.motionFieldStates(refs), {});
  }, [ed, refs, version, motionVersion, timeUs]);
  return useMemo(() => ({ refs, states, timeUs, auto }), [refs, states, timeUs, auto]);
}

export function MotionFieldStates({ nodes, children }: { nodes: readonly PanelNode[]; children: ReactNode }) {
  return <MotionStatesContext.Provider value={useMotionFieldStates(nodes)}>{children}</MotionStatesContext.Provider>;
}

/** The provider's states (inside DesignPanel in Motion mode), else null. */
export const useMotionStates = () => useContext(MotionStatesContext);

/** The selection's diamond for a field: a keyframe when every node has one at the playhead, a track when any has one. */
export function combinedState(states: FieldStates, refs: readonly string[], key: string): { state: DiamondState; keyframes: string[] } {
  const per = refs.map((r) => states[r]?.[key] ?? { state: "none" as DiamondState });
  const keyframes = per.flatMap((s) => (s.keyframe ? [s.keyframe] : []));
  if (per.length && per.every((s) => s.state === "keyframe")) return { state: "keyframe", keyframes };
  if (per.some((s) => s.state !== "none")) return { state: "track", keyframes };
  return { state: "none", keyframes };
}

/** The diamond's click: the keyframes at the playhead go (MOTION_DELETE_KEYFRAMES), else one is added there for each node. */
export function toggleKeyframe(ed: EditorController, refs: readonly string[], field: KeyframeField, state: DiamondState, keyframes: readonly string[], timeUs: number) {
  try {
    if (state === "keyframe") ed.engine.runMotionCommand("MOTION_DELETE_KEYFRAMES", { ids: [...keyframes] });
    else ed.engine.runMotionCommand("MOTION_ADD_KEYFRAME", { nodes: [...refs], field, timeUs });
  } catch {
    // The engine's Motion commands not built in this wasm.
  }
}

/**
 * A Design field joined with its diamond (Motion mode only; Figma's rule, docs/research/figma/live/2026-10-18/
 * motion.txt: "every animatable field is a joined control whose LAST cell holds the keyframe diamond"). `field` is the
 * track the diamond adds — a property, or a paint's / effect's indexed field; `axis`, when the layer has its own track
 * for one axis (Position X or Y alone, exclusive with the XY track), is the one it shows. Several fields sharing one
 * diamond (Position X / Y, Scale X / Y) go in one MotionField as its children.
 */
export function MotionField({ field, axis, disabled, className, children }: { field: KeyframePropertyFieldName | KeyframeField; axis?: KeyframePropertyFieldName; disabled?: boolean; className?: string; children: ReactNode }) {
  const ed = useEditor();
  const ctx = useMotionStates();
  if (!ctx) return <>{children}</>;
  const asField = (f: KeyframePropertyFieldName | KeyframeField): KeyframeField => (typeof f === "string" ? { type: "PROPERTY", name: f } : f);
  const own = axis ? combinedState(ctx.states, ctx.refs, fieldKey({ type: "PROPERTY", name: axis })) : null;
  const target = own && own.state !== "none" ? asField(axis!) : asField(field);
  const { state, keyframes } = own && own.state !== "none" ? own : combinedState(ctx.states, ctx.refs, fieldKey(target));
  return (
    <div className={className ? `${styles.field} ${className}` : styles.field} data-motion-field={target.type === "PROPERTY" ? target.name : fieldKey(target)} data-state={state}>
      {children}
      <KeyframeDiamond state={state} auto={ctx.auto} disabled={disabled} onClick={() => toggleKeyframe(ed, ctx.refs, target, state, keyframes, ctx.timeUs)} />
    </div>
  );
}
