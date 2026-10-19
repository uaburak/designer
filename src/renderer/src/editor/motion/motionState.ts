/**
 * Motion mode's state and the engine's view of it (docs/motion.md §4.9, §6.1): the playhead, playing, Toggle
 * auto-keyframe, the collapsed timeline live in `ui.motion` (uiStore); every change of the playhead or of auto-keyframe
 * is pushed to the engine with `setMotion`, which applies the evaluated values as preview writes (its motion layer).
 *
 * The engine's Motion side may be missing from the loaded wasm (built on another machine): every call is wrapped and
 * read as "nothing yet", so the chrome keeps working on its own state.
 */
import type { EditorController } from "../controller";
import { modeOf } from "../devmode/devMode";
import { MOTION_UI_DEFAULT, type MotionUIState } from "../uiStore";

export const motionUi = (ed: EditorController): MotionUIState => ed.ui.get().motion ?? MOTION_UI_DEFAULT;

export function setMotionUi(ed: EditorController, patch: Partial<MotionUIState>): void {
  ed.ui.set({ motion: { ...motionUi(ed), ...patch } });
}

/** The engine's motion layer is on in Motion mode, and in Social while the selected post's timeline shows (docs/social.md §6.1). */
export const motionLayerOn = (ed: EditorController): boolean => modeOf(ed) === "motion" || (modeOf(ed) === "social" && !!ed.ui.get().socialTimeline);

/**
 * The engine's view state from the UI's (on in Motion mode, and under Social's timeline: motionLayerOn). The motion layer's preview writes send no node event,
 * so the store is told to read the nodes again: the panels show the values at the playhead (docs/motion.md §6.5).
 */
export function pushMotion(ed: EditorController): boolean {
  if (ed.engine.destroyed) return false;
  const m = motionUi(ed);
  try {
    ed.engine.setMotion({ on: motionLayerOn(ed), root: null, timeUs: m.timeUs, autoKeyframe: m.autoKeyframe });
  } catch {
    return false;
  }
  ed.store.refreshNodes();
  return true;
}

const watching = new WeakMap<EditorController, () => void>();

/**
 * While Motion is on, the store reads the nodes again after every commit and every change of root: a commit applies
 * the motion layer again (a keyframe moved changes the value at the playhead of a layer the change doesn't name) and
 * a new root applies it to other layers, and neither tells the store. devMode's syncEngine turns it on and off.
 */
export function watchMotionLayer(ed: EditorController, on: boolean): void {
  if (!on) {
    watching.get(ed)?.();
    watching.delete(ed);
    return;
  }
  if (watching.has(ed)) return;
  const offs = [ed.engine.on("DOCUMENT_CHANGED", () => ed.store.refreshNodes()), ed.engine.on("MOTION_CHANGED", () => ed.store.refreshNodes())];
  watching.set(ed, () => offs.forEach((off) => off()));
}

/** The playhead (µs, ≥ 0): the engine evaluates there at once. */
export function setPlayhead(ed: EditorController, timeUs: number): void {
  const t = Math.max(0, Math.round(timeUs));
  if (motionUi(ed).timeUs === t) return;
  setMotionUi(ed, { timeUs: t });
  pushMotion(ed);
}

export function toggleMotionPlaying(ed: EditorController): void {
  setMotionUi(ed, { playing: !motionUi(ed).playing });
}

export function toggleAutoKeyframe(ed: EditorController): void {
  setMotionUi(ed, { autoKeyframe: !motionUi(ed).autoKeyframe });
  pushMotion(ed);
}

/** A Motion engine read that may not be built into the loaded wasm: its value, or `fallback`. */
export function motionRead<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
