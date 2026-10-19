/**
 * The Audio section in Motion mode (docs/motion.md §6.5, §6.6; round 8e): for the audio clip selected on the timeline,
 * its Volume (a slider and a field, 0–100 %, one "Edit audio" step per drag) and Mute. Help: "volume slider in the
 * Audio section". Shown only while a clip is selected; its layout [unverified].
 */
import { useEffect, useRef, useState } from "react";
import { Checkbox, NumericInput, PanelSection, PropertyGrid, PropertyRow, Slider } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "../../controller";
import { useTopics, useUI } from "../../hooks";
import { selectedAudio, timelineModel, toggleAudioMute } from "../audio/audioEdits";
import { motionRead } from "../motionState";

export function AudioSection() {
  useT();
  const ed = useEditor();
  const id = useUI((s) => s.motion?.selectedAudio ?? null);
  const version = useTopics(ed.store, ["undo", "selection"]);
  const [motionVersion, setMotionVersion] = useState(0);
  useEffect(() => ed.engine.on("MOTION_CHANGED", () => setMotionVersion((v) => v + 1)), [ed]);
  void version;
  void motionVersion;
  const model = id ? timelineModel(ed) : null;
  const clip = id ? selectedAudio(ed, model) : null;
  const dragging = useRef(false);
  if (!model || !clip) return null;
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
