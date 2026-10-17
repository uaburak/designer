/**
 * Motion mode's shell (docs/motion.md §6.1, §6.2): while `ui.mode` is "motion", the timeline docked along the
 * editor's bottom (EditorApp.module.css lifts the panels and the toolbar over it by its `data-motion-timeline` state),
 * fed by the engine's `motionTimeline()` and re-read on MOTION_CHANGED, document changes and selection changes; the
 * playback clock (clock.ts) drives the playhead, which `setPlayhead` pushes to the engine every frame. Increment 2: ⌘C /
 * ⌘V of keyframes (keyframeClipboard.ts) and the height dragged by the top edge (`ui.motion.height`, put on the editor
 * as --ds-size-motion-timeline so the panels and the toolbar lift with it). Round 8a increment 2: an animated
 * instance's bar dragged (MOTION_SET_INSTANCE_OFFSET, one undo step). Round 8h: a preset's clip selected (the
 * Animations section opens its settings), dragged or stretched (MOTION_SET_ANIMATION, one undo step) and deleted.
 *
 * Every engine call is guarded: the loaded wasm may predate round 8 (built on another machine), in which case the
 * timeline shows its empty state and the chrome's own state still works.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Guid } from "@/engine/codec";
import type { EasingRef, GuidString, Micros, PlaybackName, TimelineClip, TimelineModel, TimelineTrack } from "@shared/motion/types";
import { useEditor } from "../controller";
import { useTopics, useUI } from "../hooks";
import { MOTION_UI_DEFAULT } from "../uiStore";
import { Clock } from "./clock";
import { copySelectedKeyframes, pasteKeyframes } from "./keyframeClipboard";
import { motionRead, motionUi, setMotionUi, setPlayhead, toggleAutoKeyframe, toggleMotionPlaying } from "./motionState";
import { editPreset, removePresets } from "./presets";
import { Timeline } from "./timeline/Timeline";

export function MotionMode() {
  const on = useUI((s) => s.mode === "motion");
  return on ? <MotionShell /> : null;
}

function MotionShell() {
  const ed = useEditor();
  const ui = useUI((s) => s.motion ?? MOTION_UI_DEFAULT);
  // The model: the selection's root (the engine picks it), re-read when the document, the selection or Motion changed.
  const version = useTopics(ed.store, ["selection", "structure", "undo"]);
  const [motionVersion, setMotionVersion] = useState(0);
  useEffect(() => ed.engine.on("MOTION_CHANGED", () => setMotionVersion((v) => v + 1)), [ed]);
  // The height dragged by the top edge: on the editor (EditorApp.module.css reads it for the lift), gone with the mode.
  useLayoutEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-editor]");
    if (!root || ui.height === undefined) return;
    root.style.setProperty("--ds-size-motion-timeline", `${ui.height}px`);
    return () => void root.style.removeProperty("--ds-size-motion-timeline");
  }, [ui.height]);
  const model = useMemo<TimelineModel | null>(() => {
    void version;
    void motionVersion;
    return motionRead(() => ed.engine.motionTimeline(), null);
  }, [ed, version, motionVersion]);
  const selectedNodes = useMemo(() => {
    void version;
    return new Set<GuidString>(ed.store.selection.refs);
  }, [ed, version]);

  // The clock: playing starts it from the playhead, pausing keeps the playhead; ONCE's end pauses the UI too.
  const [clock] = useState(
    () =>
      new Clock({
        durationUs: 2_000_000,
        playback: "LOOP",
        onTime: (t) => setPlayhead(ed, t),
        onEnd: () => setMotionUi(ed, { playing: false }),
      })
  );
  useEffect(() => {
    clock.configure(model?.durationUs ?? 2_000_000, model?.playback ?? "LOOP");
  }, [clock, model?.durationUs, model?.playback]);
  useEffect(() => {
    if (ui.playing) {
      if (!clock.playing) clock.play(ui.timeUs);
    } else clock.pause();
  }, [clock, ui.playing, ui.timeUs]);
  useEffect(() => () => clock.pause(), [clock]);

  // A keyframe drag is one undo step: txnBegin on its first move, the edits inside it, txnCommit on release.
  const dragging = useRef(false);
  const run = useCallback(
    (fn: () => void) => {
      try {
        fn();
      } catch {
        // The engine's Motion commands not built in this wasm.
      }
    },
    []
  );
  const onMoveKeyframes = useCallback(
    (edits: { id: GuidString; timeUs: Micros }[], final: boolean) =>
      run(() => {
        if (!dragging.current) {
          ed.engine.txnBegin("Move keyframes");
          dragging.current = true;
        }
        ed.engine.runMotionCommand("MOTION_SET_KEYFRAMES", { edits });
        if (final) {
          ed.engine.txnCommit();
          dragging.current = false;
        }
      }),
    [ed, run]
  );
  const durationDrag = useRef(false);
  const onSetTimeline = useCallback(
    (patch: { durationUs?: Micros; playback?: PlaybackName }, final: boolean) =>
      run(() => {
        if (!model) return;
        if (!final && !durationDrag.current) {
          ed.engine.txnBegin("Change duration");
          durationDrag.current = true;
        }
        ed.engine.runMotionCommand("MOTION_SET_TIMELINE", { root: model.root, ...patch });
        if (final && durationDrag.current) {
          ed.engine.txnCommit();
          durationDrag.current = false;
        }
      }),
    [ed, model, run]
  );
  // An animated instance's bar dragged in time: one "Move animation" step, as a keyframe drag.
  const instanceDrag = useRef(false);
  const onMoveInstance = useCallback(
    (instance: GuidString, offsetUs: Micros, final: boolean) =>
      run(() => {
        if (!instanceDrag.current) {
          ed.engine.txnBegin("Move animation");
          instanceDrag.current = true;
        }
        ed.engine.runMotionCommand("MOTION_SET_INSTANCE_OFFSET", { instance, offsetUs });
        if (final) {
          ed.engine.txnCommit();
          instanceDrag.current = false;
        }
      }),
    [ed, run]
  );
  const onDeleteTrack = useCallback((node: GuidString, track: TimelineTrack) => run(() => void ed.engine.runMotionCommand("MOTION_DELETE_TRACKS", { node, fields: [track.field] })), [ed, run]);
  const onSetEasing = useCallback((ids: GuidString[], easing: EasingRef) => run(() => void ed.engine.runMotionCommand("MOTION_SET_EASING", { ids, easing })), [ed, run]);
  const onDeleteKeyframes = useCallback(
    (ids: GuidString[]) => {
      run(() => void ed.engine.runMotionCommand("MOTION_DELETE_KEYFRAMES", { ids }));
      setMotionUi(ed, { selectedKeyframes: [] });
    },
    [ed, run]
  );
  // A clip dragged or stretched: one step ("Move animation" / "Change animation duration"), its tracks stretched with it.
  const clipDrag = useRef(false);
  const onEditClip = useCallback(
    (clip: TimelineClip, patch: { startUs?: Micros; durationUs?: Micros }, final: boolean) =>
      run(() => {
        if (!clipDrag.current) {
          ed.engine.txnBegin(patch.durationUs !== undefined ? "Change animation duration" : "Move animation");
          clipDrag.current = true;
        }
        // Absolute start and length: the engine stretches the tracks from the clip's length as it is now.
        editPreset(ed, clip, patch);
        if (final) {
          ed.engine.txnCommit();
          clipDrag.current = false;
        }
      }),
    [ed, run]
  );
  const onDeleteClip = useCallback(
    (id: GuidString) => {
      removePresets(ed, [id]);
      setMotionUi(ed, { selectedClip: null });
    },
    [ed]
  );
  const selectedKeyframes = useMemo(() => new Set(ui.selectedKeyframes), [ui.selectedKeyframes]);

  return (
    <Timeline
      model={model}
      timeUs={ui.timeUs}
      playing={ui.playing}
      autoKeyframe={ui.autoKeyframe}
      collapsed={ui.collapsed}
      unit={ui.unit}
      selectedKeyframes={selectedKeyframes}
      selectedNodes={selectedNodes}
      onSeek={(t) => {
        clock.seek(t);
        setPlayhead(ed, t);
      }}
      onTogglePlay={() => toggleMotionPlaying(ed)}
      onToggleAutoKeyframe={() => toggleAutoKeyframe(ed)}
      onToggleCollapse={() => setMotionUi(ed, { collapsed: !motionUi(ed).collapsed })}
      onSetTimeline={onSetTimeline}
      onSelectKeyframes={(ids) => setMotionUi(ed, { selectedKeyframes: ids })}
      onMoveKeyframes={onMoveKeyframes}
      onDeleteKeyframes={onDeleteKeyframes}
      onDeleteTrack={onDeleteTrack}
      onSetEasing={onSetEasing}
      onSelectLayer={(node, additive) => {
        const refs: Guid[] = additive ? [...new Set([...ed.store.selection.refs, node])] : [node];
        ed.engine.setSelection(refs);
      }}
      onCopyKeyframes={(ids) => void copySelectedKeyframes(model, ids)}
      onPasteKeyframes={() => pasteKeyframes(ed, model)}
      onResize={(height) => setMotionUi(ed, { height })}
      onMoveInstance={onMoveInstance}
      selectedClip={ui.selectedClip ?? null}
      onSelectClip={(id) => setMotionUi(ed, { selectedClip: id })}
      onEditClip={onEditClip}
      onDeleteClip={onDeleteClip}
    />
  );
}
