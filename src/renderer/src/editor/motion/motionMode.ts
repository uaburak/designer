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

/** The engine's view state from the UI's (on only in Motion mode). */
export function pushMotion(ed: EditorController): boolean {
  if (ed.engine.destroyed) return false;
  const m = motionUi(ed);
  try {
    ed.engine.setMotion({ on: modeOf(ed) === "motion", root: null, timeUs: m.timeUs, autoKeyframe: m.autoKeyframe });
    return true;
  } catch {
    return false;
  }
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
