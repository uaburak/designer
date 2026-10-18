/**
 * The Export section's Animated tab (docs/motion.md §7.1): for top-level frames with a timeline — Format (MP4, WebM,
 * GIF, SVG, Lottie, dotLottie), Size (0.5x … 4x or a custom W × H), Frame rate, Quality (MP4 / WebM), Loop (GIF),
 * then Export with a progress row and Cancel. Round 8e: the settings are stored on the layer (an `exportSettings`
 * entry with Figma's Motion fields, motion/export/animatedSettings.ts; the first frame's shown, a change written to
 * every selected frame, one undo step), and Export waits while another animated export of the file runs. Other
 * selections show "Select a top-level frame to export animations".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Select, TextInput } from "@/ds";
import { t, tp, useT } from "@/i18n";
import { ANIMATED_FORMATS, ANIMATED_FORMAT_LABELS, DEFAULT_ANIMATED_EXPORT, FRAME_RATES, type AnimatedExportSettings, type AnimatedFormat } from "@shared/motion/types";
import { useEditor } from "../../controller";
import { canExport } from "../../exporting";
import { useDocumentVersion } from "../../hooks";
import { animatedSettingOf, writeAnimatedSetting } from "../../motion/export/animatedSettings";
import { ANIMATED_FORMATS_BUILT, animatedExportRunning, exportAnimated, onAnimatedExportLock, timelineOf, type AnimatedExportJob, type AnimatedProgress } from "../../motion/export/exportAnimated";
import type { ExportTarget } from "./Export";
import styles from "./Design.module.css";
import own from "./Export.module.css";

const SIZE_PRESETS = [0.5, 1, 2, 3, 4] as const;
const QUALITIES: AnimatedExportSettings["quality"][] = ["LOW", "MEDIUM", "HIGH"];
const QUALITY_LABEL: Record<AnimatedExportSettings["quality"], string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };

const sizeValue = (s: AnimatedExportSettings["size"]): string => ("scale" in s ? `${s.scale}x` : "custom");

export function ExportAnimatedTab({ targets, page }: { targets: ExportTarget[]; page: boolean }) {
  useT();
  const ed = useEditor();
  const version = useDocumentVersion();
  const [progress, setProgress] = useState<AnimatedProgress | null>(null);
  // Another animated export of this file running (one at a time, §7.7).
  const [locked, setLocked] = useState(() => animatedExportRunning(ed));
  useEffect(() => onAnimatedExportLock(() => setLocked(animatedExportRunning(ed))), [ed]);
  const [errors, setErrors] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null);
  // The roots among the targets: top-level frames with a timeline (the engine says); the settings stored on the first.
  const roots = useMemo(() => {
    void version;
    if (page) return [];
    return targets.flatMap((tg) => {
      const tl = timelineOf(ed, tg.guid);
      return tl ? [{ root: tg.guid, name: tl.name || tg.name || "" }] : [];
    });
  }, [ed, targets, page, version]);
  const settings = useMemo<AnimatedExportSettings>(() => {
    void version;
    return (roots.length ? animatedSettingOf(ed, roots[0].root) : null) ?? DEFAULT_ANIMATED_EXPORT;
  }, [ed, roots, version]);
  const jobs = useMemo<AnimatedExportJob[]>(() => roots.map((r) => ({ ...r, settings })), [roots, settings]);
  const video = settings.format === "MP4" || settings.format === "WEBM";
  const busy = progress !== null && progress.phase !== "done";
  const set = (patch: Partial<AnimatedExportSettings>) => writeAnimatedSetting(ed, roots.map((r) => r.root), { ...settings, ...patch });

  const run = async () => {
    const ctl = new AbortController();
    controller.current = ctl;
    setErrors([]);
    setProgress({ job: 0, jobs: jobs.length, frame: 0, frames: 0, phase: "render" });
    try {
      const r = await exportAnimated(ed, jobs, setProgress, ctl.signal);
      setErrors(r.errors);
    } finally {
      setProgress(null);
      controller.current = null;
    }
  };

  if (!jobs.length)
    return (
      <div className={styles.note} data-animated-hint>
        {t("Select a top-level frame to export animations")}
      </div>
    );
  return (
    <div className={own.animated} data-animated-export>
      <div className={own.animatedRow}>
        <Select
          label={t("Format")}
          value={settings.format}
          options={ANIMATED_FORMATS.map((f) => ({ value: f, label: ANIMATED_FORMAT_LABELS[f], disabled: !ANIMATED_FORMATS_BUILT.includes(f) }))}
          onChange={(v) => set({ format: v as AnimatedFormat })}
          disabled={busy}
        />
        <Select
          label={t("Size")}
          value={sizeValue(settings.size)}
          options={[...SIZE_PRESETS.map((s) => ({ value: `${s}x`, label: `${s}x` })), { value: "custom", label: t("Custom") }]}
          onChange={(v) => set({ size: v === "custom" ? { width: 1080, height: 1080 } : { scale: Number.parseFloat(v) } })}
          disabled={busy}
        />
      </div>
      {!("scale" in settings.size) && (
        <div className={own.animatedRow}>
          <TextInput label={t("Width")} prefix="W" value={String(settings.size.width)} disabled={busy} onCommit={(v) => set({ size: { width: Math.max(0, Math.round(Number(v) || 0)), height: ("scale" in settings.size ? 0 : settings.size.height) } })} />
          <TextInput label={t("Height")} prefix="H" value={String(settings.size.height)} disabled={busy} onCommit={(v) => set({ size: { width: "scale" in settings.size ? 0 : settings.size.width, height: Math.max(0, Math.round(Number(v) || 0)) } })} />
        </div>
      )}
      <div className={own.animatedRow}>
        <Select label={t("Frame rate")} value={String(settings.fps)} options={FRAME_RATES.map((f) => ({ value: String(f), label: `${f} fps` }))} onChange={(v) => set({ fps: Number(v) as AnimatedExportSettings["fps"] })} disabled={busy} />
        {video ? (
          <Select label={t("Quality")} value={settings.quality} options={QUALITIES.map((q) => ({ value: q, label: t(QUALITY_LABEL[q]) }))} onChange={(v) => set({ quality: v as AnimatedExportSettings["quality"] })} disabled={busy} />
        ) : settings.format === "GIF" ? (
          <Checkbox label={t("Loop")} checked={settings.loop} onChange={(c) => set({ loop: c })} disabled={busy} />
        ) : (
          <span />
        )}
      </div>
      <div className={own.actions}>
        {busy ? (
          <div className={own.progress} role="status">
            <span>{progress.phase === "encode" && progress.frames ? t("Exporting frame {frame} of {frames}…", { frame: String(progress.frame), frames: String(progress.frames) }) : t("Exporting…")}</span>
            <Button variant="secondary" onClick={() => controller.current?.abort()}>
              {t("Cancel")}
            </Button>
          </div>
        ) : (
          <Button variant="secondary" fullWidth disabled={!canExport(ed) || locked} onClick={() => void run()} data-export-animated-button="">
            {jobs.length === 1 ? t("Export animation") : tp(jobs.length, "Export {n} animation", "Export {n} animations")}
          </Button>
        )}
      </div>
      {errors.map((e) => (
        <div key={e} className={styles.note} data-animated-error>
          {e}
        </div>
      ))}
    </div>
  );
}
