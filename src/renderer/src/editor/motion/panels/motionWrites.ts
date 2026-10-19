/**
 * Design's Position X / Y and Rotation while Motion is on (docs/motion.md §4.9, §6.5). The fields show the layer at the
 * playhead (the motion layer's preview writes are in the live nodes), but a transaction reads and writes base values,
 * and the engine routes no transform write (motionRouteWrite takes opacity, the corners, stroke weight, the size, gaps
 * and paddings). So a value typed, stepped or scrubbed here is a change from the value shown: a layer with a Position
 * (Rotation) track — or, with auto-keyframe on, any layer under the root — gets the keyframe at the playhead moved by
 * it (MOTION_ADD_KEYFRAME, then MOTION_SET_KEYFRAMES, in the edit's one undo step); any other layer's base moves by it.
 */
import { scrubFrom, type ChangeInfo, type NumericInputProps } from "@/ds";
import type { Guid } from "@/engine/codec";
import { fieldKey, type FieldStates, type GuidString, type KeyframeField, type KeyframePropertyFieldName, type KeyframeValue, type Micros } from "@shared/motion/types";
import type { EditorController } from "../../controller";
import { groupChain } from "../../actions";
import { IDENTITY, invert, multiply } from "../../model/geometry";
import type { PanelNode } from "../../panels/design/shared";
import { motionRead, motionUi } from "../motionState";

type Fields = Parameters<EditorController["engine"]["setProps"]>[1];

/** The Design fields routed here: the panel's X, Y and Rotation. */
export type MotionAxis = "x" | "y" | "rotation";

/** The track a Design field keys: X / Y → Position (the layer's own X / Y track when it has one), Rotation. */
export function motionFieldOf(axis: MotionAxis, states: FieldStates[string] | undefined): KeyframePropertyFieldName {
  if (axis === "rotation") return "ROTATION";
  const own = axis === "x" ? "TRANSLATION_X" : "TRANSLATION_Y";
  return states?.[own] && states[own].state !== "none" ? own : "TRANSLATION_XY";
}

/** A keyframe value moved by a change in the layer's own axes (`d`: x / y for Position, x alone for one axis or Rotation). */
export function movedValue(value: KeyframeValue, d: { x: number; y: number }): KeyframeValue {
  if (value.type === "VECTOR") return { type: "VECTOR", value: { x: value.value.x + d.x, y: value.value.y + d.y } };
  if (value.type === "FLOAT") return { type: "FLOAT", value: value.value + d.x };
  return value;
}

/** The keyframe of `field` at `timeUs` on the layer's track (the timeline model's), or null. */
function keyframeAt(ed: EditorController, node: GuidString, field: KeyframeField, timeUs: Micros): { id: GuidString; value: KeyframeValue } | null {
  const model = motionRead(() => ed.engine.motionTimeline(node), null);
  const key = fieldKey(field);
  const track = model?.layers.find((l) => l.node === node)?.tracks.find((tr) => fieldKey(tr.field) === key);
  const k = track?.keyframes.find((kf) => kf.timeUs === timeUs);
  return k ? { id: k.id, value: k.value } : null;
}

/** Under a timeline root and not the root itself: auto-keyframe takes the layer's edits. */
function underRoot(ed: EditorController, node: GuidString): boolean {
  const model = motionRead(() => ed.engine.motionTimeline(node), null);
  return !!model && model.root !== node;
}

/**
 * One edit (a typed value, a step, or a scrub's frames until its last): the values shown when it began (the live
 * nodes, read before its transaction), and per layer the base value or the keyframe it moves, so every frame writes
 * start + change (the open transaction already holds the last frame's).
 */
interface Session {
  live: Map<Guid, PanelNode>;
  base: Map<Guid, number>;
  keys: Map<Guid, { id: GuidString; value: KeyframeValue } | null>;
}
let session: Session | null = null;

function edit(ed: EditorController, label: string, info: ChangeInfo, refs: readonly Guid[], axis: MotionAxis, get: (n: PanelNode) => number, set: (n: PanelNode, v: number) => Fields | null, next: (shown: number) => number) {
  if (!session) session = { live: new Map((ed.engine.readNodes(refs) as PanelNode[]).map((n) => [n.guid, ed.withRealType(n as never) as PanelNode])), base: new Map(), keys: new Map() };
  const s = session;
  if (info.final) session = null;
  const { timeUs, autoKeyframe } = motionUi(ed);
  const states = motionRead<FieldStates>(() => ed.engine.motionFieldStates(refs.map(String)), {});
  ed.edit(label, info, () => {
    for (const raw of ed.engine.readNodes(refs) as PanelNode[]) {
      const b = ed.withRealType(raw as never) as PanelNode;
      const shown = s.live.get(b.guid) ?? b;
      // The panel's rotation is (−180, 180]: 170 typed over −180 shown is a turn of −10, not 350.
      const by = next(get(shown)) - get(shown);
      const change = axis === "rotation" && Math.abs(by) > 180 ? by - 360 * Math.round(by / 360) : by;
      const name = motionFieldOf(axis, states[b.guid]);
      const tracked = (states[b.guid]?.[name]?.state ?? "none") !== "none";
      if (tracked || (autoKeyframe && underRoot(ed, b.guid))) {
        moveKeyframe(ed, s, b, axis, { type: "PROPERTY", name }, tracked, timeUs, change);
        continue;
      }
      if (!s.base.has(b.guid)) s.base.set(b.guid, get(b));
      const f = set(b, s.base.get(b.guid)! + change);
      if (f) ed.engine.setProps([b.guid], f);
    }
  });
}

function moveKeyframe(ed: EditorController, s: Session, b: PanelNode, axis: MotionAxis, field: KeyframeField, tracked: boolean, timeUs: Micros, change: number) {
  if (!s.keys.has(b.guid)) {
    // The keyframe at the playhead with the value there (made when missing); auto-keyframe's first keyframe of a
    // field keeps the value as it was at 0 (docs/motion.md §4.9, as motionRouteWrite does).
    if (!tracked && timeUs > 0) ed.engine.runMotionCommand("MOTION_ADD_KEYFRAME", { nodes: [b.guid], field, timeUs: 0 });
    ed.engine.runMotionCommand("MOTION_ADD_KEYFRAME", { nodes: [b.guid], field, timeUs });
    s.keys.set(b.guid, keyframeAt(ed, b.guid, field, timeUs));
  }
  const k = s.keys.get(b.guid);
  if (!k) return;
  let d = { x: change, y: 0 };
  if (axis !== "rotation") {
    // A panel move in the parent's axes is a translation in the layer's (the motion transform sits under its layout
    // transform, docs/motion.md §4.5); one axis's own track takes its own component.
    const lin = invert({ ...multiply(groupChain(ed, b), b.transform ?? IDENTITY), m02: 0, m12: 0 });
    const panel = axis === "x" ? { x: change, y: 0 } : { x: 0, y: change };
    const local = { x: lin.m00 * panel.x + lin.m01 * panel.y, y: lin.m10 * panel.x + lin.m11 * panel.y };
    d = field.type === "PROPERTY" && field.name === "TRANSLATION_Y" ? { x: local.y, y: 0 } : local;
  }
  ed.engine.runMotionCommand("MOTION_SET_KEYFRAMES", { edits: [{ id: k.id, value: movedValue(k.value, d) }] });
}

/**
 * perLayer's handlers for X, Y or Rotation in Motion mode: each change is taken from the value shown (the live node)
 * and lands on the keyframe at the playhead or on the base, as the file comment says.
 */
export function motionPerLayer(
  ed: EditorController,
  label: string,
  refs: readonly Guid[],
  get: (n: PanelNode) => number,
  set: (n: PanelNode, v: number) => Fields | null,
  axis: MotionAxis,
  exit: NonNullable<NumericInputProps["onExit"]>
): Pick<NumericInputProps, "onChange" | "onStep" | "onExpression" | "onScrubBy" | "onCancel" | "onExit"> {
  return {
    onChange: (v, info) => edit(ed, label, info, refs, axis, get, set, () => v),
    onStep: (d) => edit(ed, label, { final: true, source: "step" }, refs, axis, get, set, (v) => v + d),
    onExpression: (each, info) => edit(ed, label, info, refs, axis, get, set, each),
    onScrubBy: (d, info) => edit(ed, label, info, refs, axis, get, set, (v) => scrubFrom(v, d)),
    onCancel: () => {
      session = null;
      ed.cancelEdit();
    },
    onExit: exit,
  };
}
