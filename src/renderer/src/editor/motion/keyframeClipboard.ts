/**
 * ⌘C / ⌘V of keyframes in the timeline (docs/motion.md §6.2; ours, Figma's isn't documented). The copy is the
 * editor's, not the system clipboard: per layer, per track, the values and easings at their distance from the earliest
 * keyframe copied (timeline/maths.ts `copyKeyframes`). A paste puts them at the playhead with the engine's
 * MOTION_PASTE_KEYFRAMES (round 8i), one undo step: onto the selected layers when the copy came from one layer, else
 * back onto the layers it came from (a command per layer inside the step).
 */
import type { GuidString, TimelineModel } from "@shared/motion/types";
import type { EditorController } from "../controller";
import { motionUi } from "./motionState";
import { copyKeyframes, type KeyframeCopy } from "./timeline/maths";

let copied: KeyframeCopy[] | null = null;

/** Keeps the selected keyframes of `model` (nothing selected: the copy stays as it was). */
export function copySelectedKeyframes(model: TimelineModel | null, ids: readonly GuidString[]): boolean {
  const copy = model ? copyKeyframes(model.layers, new Set(ids)) : [];
  if (!copy.length) return false;
  copied = copy;
  return true;
}

/** The copy at the playhead; false when nothing was copied (the document's paste goes on). */
export function pasteKeyframes(ed: EditorController, model: TimelineModel | null): boolean {
  if (!copied?.length || !model) return false;
  const selection = ed.store.selection.refs.filter((r) => r !== model.root);
  const targets = copied.length === 1 && selection.length ? [{ nodes: selection, tracks: copied[0].tracks }] : copied.map((c) => ({ nodes: [c.node], tracks: c.tracks }));
  const atUs = motionUi(ed).timeUs;
  ed.engine.txnBegin("Paste keyframes");
  try {
    for (const { nodes, tracks } of targets) ed.engine.runMotionCommand("MOTION_PASTE_KEYFRAMES", { nodes, atUs, clipboard: { tracks } });
  } catch {
    // The engine's Motion commands not built in this wasm.
  } finally {
    ed.engine.txnCommit();
  }
  return true;
}

/** Tests: forget the copy. */
export function clearKeyframeCopy(): void {
  copied = null;
}
