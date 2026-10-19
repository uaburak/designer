/**
 * The Audio section in Motion mode (docs/motion.md §6.5, §6.6; round 8e): for the audio clip selected on the timeline,
 * its Volume (a slider and a field, 0–100 %, one "Edit audio" step per drag) and Mute. Help: "volume slider in the
 * Audio section". Its layout [unverified].
 *
 * 2026-10-19 (Figma's capture, owner-2026-10-19/figma-motion-easing-panel.webp): with no clip selected the section is
 * its "Audio" title and **+** — audio files chosen there land on the timeline's root at the playhead, as a drop does.
 */
import { useEffect, useRef, useState } from "react";
import { Checkbox, IconButton, NumericInput, PanelSection, PropertyGrid, PropertyRow, Slider, showToast } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "../../controller";
import { useTopics, useUI } from "../../hooks";
import { AUDIO_ACCEPT, importAudioFiles } from "../audio/audio";
import { selectedAudio, timelineModel, toggleAudioMute } from "../audio/audioEdits";
import { motionRead, motionUi, setMotionUi } from "../motionState";

export function AudioSection() {
  useT();
  const ed = useEditor();
  const id = useUI((s) => s.motion?.selectedAudio ?? null);
  const version = useTopics(ed.store, ["undo", "selection"]);
  const [motionVersion, setMotionVersion] = useState(0);
  useEffect(() => ed.engine.on("MOTION_CHANGED", () => setMotionVersion((v) => v + 1)), [ed]);
  void version;
  void motionVersion;
  const model = timelineModel(ed);
  const clip = id ? selectedAudio(ed, model) : null;
  const dragging = useRef(false);
  const file = useRef<HTMLInputElement>(null);
  if (!model) return null;
  if (!clip) {
    const add = (files: File[]) => {
      if (!files.length) return;
      void importAudioFiles(ed, files, model.root, motionUi(ed).timeUs).then((r) => {
        if (r.error) showToast({ message: r.error, kind: "error" });
        if (r.added.length) setMotionUi(ed, { selectedAudio: r.added[r.added.length - 1] });
      });
    };
    return (
      <PanelSection title={t("Audio")} data-audio-section="" actions={<IconButton icon="24.plus.small" label={t("Add audio")} data-add-audio onClick={() => file.current?.click()} />}>
        <input
          ref={file}
          type="file"
          accept={AUDIO_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            add([...(e.currentTarget.files ?? [])]);
            e.currentTarget.value = "";
          }}
        />
      </PanelSection>
    );
  }
  const setVolume = (percent: number, final: boolean) => {
    const volume = Math.min(100, Math.max(0, percent)) / 100;
    // A drag is one undo step: the edits inside one transaction, committed on release.
    if (!final && !dragging.current) {
      ed.engine.txnBegin("Edit audio");
      dragging.current = true;
    }
    motionRead(() => ed.engine.runMotionCommand("MOTION_SET_AUDIO", { root: model.root, edits: [{ id: clip.id, volume }] }), 0);
    if (final && dragging.current) {
      ed.engine.txnCommit();
      dragging.current = false;
    }
  };
  const percent = Math.round(clip.volume * 100);
  return (
    <PanelSection title={t("Audio")} data-audio-section>
      <PropertyGrid labels>
        <PropertyRow labels={[t("Volume")]}>
          <Slider label={t("Volume")} value={percent} min={0} max={100} step={1} disabled={clip.mute} onChange={(v, info) => setVolume(v, info.final)} />
          <NumericInput label={t("Volume")} unit="%" precision={0} min={0} max={100} value={percent} disabled={clip.mute} onChange={(v, info) => setVolume(v, info.final)} />
        </PropertyRow>
        <PropertyRow>
          <Checkbox label={t("Mute audio")} checked={clip.mute} onChange={() => toggleAudioMute(ed, clip)} />
        </PropertyRow>
      </PropertyGrid>
    </PanelSection>
  );
}
