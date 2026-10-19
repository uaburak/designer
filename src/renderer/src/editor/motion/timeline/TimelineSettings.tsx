/**
 * The timeline settings popover (docs/motion.md §6.2; round 8i), from Figma's timeline settings module
 * (docs/research/rea/motion.md §2.16): **Units** ms or frames; the **snapping grid** as a frame rate — in ms the grid's
 * step (100, 50, 10 ms) or Off, in frames 60 (the default), 30, 29.97, 24, 23.976, 12 — or a typed one (a step in ms
 * becomes 1000 / ms fps, 1–1000; a frame rate is rounded, 1–120); **Loop** Once / Loop / Ping pong, Ping pong disabled
 * while the timeline has audio. Labels and layout [unverified] until the signed-in capture (§12).
 */
import { Popover, SegmentedControl, Select, TextInput } from "@/ds";
import { t, useT } from "@/i18n";
import { PLAYBACK_LABELS, SNAPPING_GRIDS, type PlaybackName, type TimelineUnit } from "@shared/motion/types";
import { GRID_OFF_FPS, gridFromFps, gridFromMs, gridLabel } from "./maths";
import styles from "./TimelineSettings.module.css";

export interface TimelineSettingsProps {
  anchor: HTMLElement;
  unit: TimelineUnit;
  /** The snapping grid (frames per second) */
  fps: number;
  playback: PlaybackName;
  hasAudio: boolean;
  onUnit(unit: TimelineUnit): void;
  onFps(fps: number): void;
  onPlayback(mode: PlaybackName): void;
  onClose(): void;
}

/** Figma's order in the settings (the Playback button cycles Loop → Once → Ping-pong). */
const LOOP_ORDER: readonly PlaybackName[] = ["ONCE", "LOOP", "PING_PONG"];

/** A grid's frame rate as the Select's value (to the thousandth: 29.97 and 23.976 stay apart). */
const key = (fps: number) => String(Math.round(fps * 1000) / 1000);

/** The grids offered in a unit: Figma's presets (ms: Off last), the current one first when it is none of them. */
export function gridOptions(unit: TimelineUnit, fps: number): { value: string; label: string }[] {
  const presets = SNAPPING_GRIDS[unit].map(([n, d]) => n / d);
  if (unit === "ms") presets.push(GRID_OFF_FPS);
  const all = presets.some((p) => key(p) === key(fps)) ? presets : [fps, ...presets];
  return all.map((p) => ({ value: key(p), label: gridLabel(p, unit) === "Off" ? t("Off") : gridLabel(p, unit) }));
}

export function TimelineSettings({ anchor, unit, fps, playback, hasAudio, onUnit, onFps, onPlayback, onClose }: TimelineSettingsProps) {
  useT();
  return (
    <Popover anchor={anchor} placement="top" title={t("Timeline settings")} onClose={onClose} width={240}>
      <div className={styles.body} data-timeline-settings-popover>
        <div className={styles.field}>
          <span className={styles.label}>{t("Units")}</span>
          <SegmentedControl label={t("Units")} value={unit} fullWidth options={[{ value: "ms", label: t("Milliseconds") }, { value: "frames", label: t("Frames") }]} onChange={(v) => onUnit(v as TimelineUnit)} />
        </div>
        <div className={styles.field}>
          <span className={styles.label}>{t("Snapping")}</span>
          <div className={styles.pair}>
            <Select label={t("Snapping")} value={key(fps)} options={gridOptions(unit, fps)} onChange={(v) => onFps(Number(v))} />
            <TextInput
              label={unit === "ms" ? t("Grid (ms)") : t("Frame rate")}
              value={unit === "ms" ? (fps >= GRID_OFF_FPS ? "" : String(Math.round((1000 / fps) * 100) / 100)) : String(Math.round(fps * 1000) / 1000)}
              placeholder={unit === "ms" ? t("Off") : "60"}
              onCommit={(text) => {
                const n = Number(text);
                const next = unit === "ms" ? gridFromMs(n) : gridFromFps(n);
                if (next !== null) onFps(next);
              }}
            />
          </div>
        </div>
        <div className={styles.field}>
          <span className={styles.label}>{t("Loop")}</span>
          <SegmentedControl
            label={t("Loop")}
            value={playback}
            fullWidth
            options={LOOP_ORDER.map((m) => ({ value: m, label: t(PLAYBACK_LABELS[m]), disabled: m === "PING_PONG" && hasAudio }))}
            onChange={(v) => onPlayback(v as PlaybackName)}
          />
        </div>
      </div>
    </Popover>
  );
}
