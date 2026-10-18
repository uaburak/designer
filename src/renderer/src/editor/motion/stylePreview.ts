/**
 * The canvas preview of an animation style (docs/motion.md §6.5: the Animations menu's "hover previews on the canvas",
 * verified for Text enter / exit; round 8j): while a style's row is lit, the style goes on the selected layers in an
 * open transaction and plays once from the playhead — the engine evaluating each frame, the playhead itself untouched
 * — then holds its last frame. Another row starts that one's; the menu closing, or a row picked, cancels the
 * transaction, so neither the document nor the undo history ever sees the preview. Nothing previews while the
 * timeline plays.
 */
import { Status } from "@/engine/abi";
import type { GuidString, Micros } from "@shared/motion/types";
import type { EditorController } from "../controller";
import { motionLayerOn, motionUi, pushMotion } from "./motionState";
import { applyStyle, styleSpanUs, type PresetTarget } from "./presets";

interface Preview {
  raf: number;
  startUs: Micros;
  spanUs: Micros;
}

const previews = new WeakMap<EditorController, Preview>();

/** Whether a style's preview is on (its transaction open). */
export const previewing = (ed: EditorController): boolean => previews.has(ed);

/** The preview gone: its transaction cancelled, the canvas back at the playhead. */
export function stopStylePreview(ed: EditorController): void {
  const p = previews.get(ed);
  if (!p) return;
  previews.delete(ed);
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(p.raf);
  if (ed.engine.destroyed) return;
  ed.engine.txnCancel();
  pushMotion(ed);
}

/** The preview's frame `atUs` from its start (the clock's, and the tests'). */
export function showStylePreviewAt(ed: EditorController, atUs: Micros): void {
  const p = previews.get(ed);
  if (!p || ed.engine.destroyed) return;
  try {
    ed.engine.setMotion({ on: motionLayerOn(ed), root: null, timeUs: p.startUs + Math.min(p.spanUs, Math.max(0, atUs)), autoKeyframe: false, inTransaction: true });
  } catch {
    // The loaded wasm has no Motion.
  }
}

/** `styleKey`'s preview on `nodes` (null: none — the one shown stops). False when it can't play. */
export function previewStyle(ed: EditorController, styleKey: string | null, nodes: readonly GuidString[], target?: PresetTarget): boolean {
  stopStylePreview(ed);
  if (!styleKey || !nodes.length || ed.engine.destroyed || motionUi(ed).playing) return false;
  if (ed.engine.txnBegin("Preview animation style") !== Status.OK) return false;
  const startUs = motionUi(ed).timeUs;
  if (!applyStyle(ed, styleKey, [...nodes], target, startUs)) {
    ed.engine.txnCancel();
    return false;
  }
  const p: Preview = { raf: 0, startUs, spanUs: styleSpanUs(ed, styleKey) };
  previews.set(ed, p);
  showStylePreviewAt(ed, 0);
  if (typeof requestAnimationFrame !== "function") return true;
  const t0 = performance.now();
  const frame = (now: number) => {
    if (previews.get(ed) !== p) return;
    const at = (now - t0) * 1000;
    showStylePreviewAt(ed, at);
    if (at < p.spanUs) p.raf = requestAnimationFrame(frame);
  };
  p.raf = requestAnimationFrame(frame);
  return true;
}
