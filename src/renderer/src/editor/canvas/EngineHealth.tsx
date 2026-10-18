/**
 * What the editor shows about the engine's health (docs/research/atlas/20-rendering.md §3.6, §3.7, §9.4): View ›
 * Memory usage as Figma's card — the file's memory as a percentage of its heap limit, red with Figma's warning at
 * 90 % (the card opens by itself then, and in recovery mode), "Exit recovery mode" under 45 %; the out-of-memory
 * dialog, which can't be closed (reload in recovery mode, or reload when already there or the engine is gone); the
 * GPU error when the canvas's WebGL context won't come back; the hardware-acceleration bell, once on this machine.
 * Figma's English texts for these aren't in its build (only their keys): the wording here follows the keys' names;
 * the card sits at the canvas's bottom left, not in the Pages panel.
 */
import { t, useT } from "@/i18n";
import { useEffect, useState } from "react";
import { Button, Dialog, IconButton, showToast } from "@/ds";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { hardwareAcceleration, probeWebGL2 } from "../../engine/gfx";
import { onEngineAbort } from "../../engine/loadEngine";
import {
  EXIT_RECOVERY_PERCENT,
  HeapMemoryMode,
  heapModeOf,
  isOutOfMemory,
  MemoryMonitor,
  MemoryWarningLevel,
  recoveryUrl,
  type MemoryState,
} from "../../engine/memory";
import styles from "./CommandOverlays.module.css";

/** Figma's key: the hardware-acceleration bell was shown on this machine. */
const ACCELERATION_SHOWN_KEY = "hardware_acceleration_disabled_warning_shown";
/** Figma shows the bell for 10 s. */
const ACCELERATION_BELL_MS = 10_000;

export function EngineHealth() {
  useT();
  const ed = useEditor();
  const [memory, setMemory] = useState<MemoryState | null>(null);
  const [gfxError, setGfxError] = useState<string | null>(ed.engine.gfxError);
  const [closed, setClosed] = useState(false);
  const shown = useUI((s) => !!s.memoryUsage);

  useEffect(() => {
    const monitor = new MemoryMonitor(
      { used: () => (ed.engine.destroyed ? null : ed.engine.heapUsed()), purge: () => ed.engine.purgeMemory() },
      heapModeOf(location.search)
    );
    const off = [
      monitor.subscribe(setMemory),
      monitor.start(),
      onEngineAbort((what, bytes) => {
        if (isOutOfMemory(what, bytes)) monitor.outOfMemory();
      }),
      ed.engine.onGfxError(setGfxError),
    ];
    return () => off.forEach((f) => f());
  }, [ed]);

  useEffect(() => warnSoftwareRendering(), []);

  if (!memory) return null;
  const recovery = memory.mode === HeapMemoryMode.RECOVERY;
  const error = memory.level === MemoryWarningLevel.ERROR;
  const reload = (inRecovery: boolean) => location.assign(recoveryUrl(location.href, inRecovery));
  const card = (shown && !closed) || error || recovery;
  return (
    <>
      {card && memory.level !== MemoryWarningLevel.OOM && (
        <MemoryCard
          state={memory}
          onClose={() => (shown ? ed.ui.set({ memoryUsage: false }) : setClosed(true))}
          onExitRecovery={() => reload(false)}
        />
      )}
      {memory.level === MemoryWarningLevel.OOM && <OutOfMemoryDialog recovery={recovery || ed.engine.destroyed} onReload={() => reload(!recovery)} />}
      {gfxError && <GfxErrorDialog onClose={() => setGfxError(null)} />}
    </>
  );
}

/** Figma's memory card: the percentage of the heap limit, a bar, the warning and recovery messages. */
function MemoryCard({ state, onClose, onExitRecovery }: { state: MemoryState; onClose: () => void; onExitRecovery: () => void }) {
  const ed = useEditor();
  const recovery = state.mode === HeapMemoryMode.RECOVERY;
  const error = state.level === MemoryWarningLevel.ERROR;
  const r = ed.canvas?.getBoundingClientRect();
  let header: string | null = null;
  let body: string | null = null;
  if (error) {
    header = recovery ? t("Memory usage is high") : t("Almost out of memory");
    body = recovery ? t("This file is still over its memory limit. Reduce its memory usage to leave recovery mode.") : t("To avoid losing access to this file, reduce its memory usage.");
  } else if (recovery && state.percent < EXIT_RECOVERY_PERCENT) {
    header = t("Memory usage is low");
    body = t("This file uses less memory now. You can leave recovery mode.");
  } else if (state.recovered) {
    header = t("You're good to go");
    body = t("This file has enough memory now.");
  }
  return (
    <div
      className={styles.memoryCard}
      data-level={error ? "error" : "safe"}
      style={r ? { left: r.left + 12, top: r.bottom - 12, transform: "translateY(-100%)" } : undefined}
      role="status"
      data-memory-usage=""
    >
      <div className={styles.memoryRow}>
        <span className={styles.memoryTitle}>{t("Memory usage")}</span>
        <span className={styles.memoryPercent}>{Math.trunc(state.percent)}%</span>
        {!error && <IconButton icon="16.close" label={t("Close")} tooltip={false} onClick={onClose} />}
      </div>
      <div className={styles.memoryBar} role="progressbar" aria-label={t("Memory usage")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.trunc(state.percent)}>
        <div className={styles.memoryFill} style={{ width: `${state.percent}%` }} />
      </div>
      {header && <div className={styles.memoryHeader}>{header}</div>}
      {body && <div className={styles.memoryBody}>{body}</div>}
      {recovery && !error && state.percent < EXIT_RECOVERY_PERCENT && (
        <Button variant="secondary" onClick={onExitRecovery}>
          {t("Exit recovery mode")}
        </Button>
      )}
    </div>
  );
}

/** Figma's out-of-memory dialog: no closing it — reload in recovery mode, or reload (already there, or the engine is gone). */
function OutOfMemoryDialog({ recovery, onReload }: { recovery: boolean; onReload: () => void }) {
  return (
    <Dialog
      open
      title={recovery ? t("Reload the file") : t("Out of memory")}
      onClose={() => {}}
      closeOnScrim={false}
      footer={
        <Button variant="primary" data-autofocus="" onClick={onReload}>
          {recovery ? t("Reload") : t("Open in recovery mode")}
        </Button>
      }
    >
      {recovery
        ? t("This file ran out of memory. Reload it to keep working; changes not saved yet may be lost.")
        : t("This file ran out of memory. Open it in recovery mode, with more memory, to reduce its memory usage.")}
    </Dialog>
  );
}

/** Figma's WebGL error: the canvas's context was lost and couldn't be brought back. */
function GfxErrorDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      title={t("We can't open that file")}
      onClose={onClose}
      footer={
        <Button variant="primary" data-autofocus="" onClick={onClose}>
          {t("Got it")}
        </Button>
      }
    >
      {t("We're having trouble with WebGL on this device. If this problem persists, restart the app.")}
    </Dialog>
  );
}

/** Figma's hardware-acceleration bell: the browser draws in software (SwiftShader); shown once on this machine. */
function warnSoftwareRendering(): void {
  try {
    if (hardwareAcceleration(navigator.userAgent, probeWebGL2()) !== "DISABLED") {
      localStorage.removeItem(ACCELERATION_SHOWN_KEY);
      return;
    }
    if (localStorage.getItem(ACCELERATION_SHOWN_KEY)) return;
    localStorage.setItem(ACCELERATION_SHOWN_KEY, "1");
  } catch {
    return; // storage blocked: no bell rather than one every time
  }
  showToast({ message: t("Hardware acceleration is turned off. Turn it on in your browser's settings for the best performance."), duration: ACCELERATION_BELL_MS });
}
