/**
 * The audio edits the chrome makes (docs/motion.md §6.6, §6.9; round 8e) over the engine's commands: Split audio at
 * playhead (⌥K), Mute audio (the canvas menu and a clip's menu), Delete, the Audio section's volume. They act on the
 * selected audio clip, else on every clip of the timeline's root (Mute) or every clip under the playhead (Split).
 */
import type { GuidString, TimelineAudioClip, TimelineModel } from "@shared/motion/types";
import type { EditorController } from "../../controller";
import { motionRead, motionUi, setMotionUi } from "../motionState";

/** The timeline's model (the selection's root), null without one or without Motion in this wasm. */
export const timelineModel = (ed: EditorController): TimelineModel | null => motionRead(() => ed.engine.motionTimeline(), null);

/** The selected audio clip, if it is still on the timeline. */
export function selectedAudio(ed: EditorController, model: TimelineModel | null = timelineModel(ed)): TimelineAudioClip | null {
  const id = motionUi(ed).selectedAudio;
  return (id && model?.audio.find((c) => c.id === id)) || null;
}

/** What Mute audio acts on: the selected clip, else every clip of the root. */
const muteTargets = (ed: EditorController, model: TimelineModel): TimelineAudioClip[] => {
  const one = selectedAudio(ed, model);
  return one ? [one] : model.audio;
};

/** Whether the root has audio Mute audio can act on (the canvas menu shows it then). */
export const hasAudio = (ed: EditorController): boolean => !!timelineModel(ed)?.audio.length;

/** Mute audio's check: every clip it acts on is muted. */
export function audioMuted(ed: EditorController): boolean {
  const model = timelineModel(ed);
  const clips = model ? muteTargets(ed, model) : [];
  return clips.length > 0 && clips.every((c) => c.mute);
}

/** Mute audio / Unmute audio: one "Edit audio" step. */
export function toggleAudioMute(ed: EditorController, clip?: TimelineAudioClip): void {
  const model = timelineModel(ed);
  if (!model) return;
  const clips = clip ? [clip] : muteTargets(ed, model);
  if (!clips.length) return;
  const mute = !clips.every((c) => c.mute);
  motionRead(() => ed.engine.runMotionCommand("MOTION_SET_AUDIO", { root: model.root, edits: clips.map((c) => ({ id: c.id, mute })) }), 0);
}

/** The clips Split audio at playhead cuts: the selected one when the playhead is inside it, else every one it's inside. */
export function splitTargets(ed: EditorController, model: TimelineModel | null = timelineModel(ed)): TimelineAudioClip[] {
  if (!model) return [];
  const t = motionUi(ed).timeUs;
  const inside = (c: TimelineAudioClip) => t > c.offsetUs && t < c.offsetUs + c.durationUs;
  const one = selectedAudio(ed, model);
  if (one) return inside(one) ? [one] : [];
  return model.audio.filter(inside);
}

/** ⌥K: one "Split audio" step; the new right-hand region selected (help: "then move or Delete a region"). */
export function splitAudioAtPlayhead(ed: EditorController, clip?: TimelineAudioClip): void {
  const model = timelineModel(ed);
  const clips = clip ? [clip] : splitTargets(ed, model);
  if (!model || !clips.length) return;
  const atUs = motionUi(ed).timeUs;
  let last: GuidString | null = null;
  const run = () => {
    for (const c of clips) {
      const r = motionRead(() => ed.engine.runMotionCommandCreating("MOTION_SPLIT_AUDIO", { root: model.root, id: c.id, atUs }), null);
      if (r?.created.length) last = r.created[0];
    }
  };
  if (clips.length > 1) {
    ed.engine.txnBegin("Split audio");
    try {
      run();
    } finally {
      ed.engine.txnCommit();
    }
  } else run();
  if (last) setMotionUi(ed, { selectedAudio: last });
}

/** Delete on audio clips: one "Delete audio" step. */
export function removeAudio(ed: EditorController, ids: GuidString[]): void {
  const model = timelineModel(ed);
  if (!model || !ids.length) return;
  motionRead(() => ed.engine.runMotionCommand("MOTION_REMOVE_AUDIO", { root: model.root, ids }), 0);
  if (ids.includes(motionUi(ed).selectedAudio ?? "")) setMotionUi(ed, { selectedAudio: null });
}
