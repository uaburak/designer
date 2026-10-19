/**
 * Round 19b [ours]: Pathfinder › Pathfinder options… — Illustrator's Pathfinder Options dialog as a window like
 * Preferences › Nudge amount… (draggable, not modal, opened at the window's middle a third of the way down): Precision
 * (px; Illustrator's 0.028), Remove redundant points, Divide and Outline will remove unpainted artwork. Each change is
 * kept at once (per machine, pathfinder.ts); Defaults puts Illustrator's back; Esc or × close it.
 */
import { useMemo } from "react";
import { Button, Checkbox, FloatingPanel, NumericInput, size } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { clampPrecision, DEFAULT_PATHFINDER, loadPathfinderOptions, PATHFINDER_PRECISION, setPathfinderOptions } from "../pathfinder";
import styles from "./PathfinderOptions.module.css";

export function PathfinderOptionsDialog() {
  const open = useUI((s) => !!s.pathfinderDialog);
  return open ? <PathfinderOptionsWindow /> : null;
}

function PathfinderOptionsWindow() {
  useT();
  const ed = useEditor();
  const current = useUI((s) => s.pathfinder) ?? loadPathfinderOptions();
  const at = useMemo(() => new DOMRect(window.innerWidth / 2 - size.popover / 2, window.innerHeight / 3, 0, 0), []);
  const close = () => {
    ed.ui.set({ pathfinderDialog: false });
    ed.focusCanvas();
  };
  return (
    <FloatingPanel title={t("Pathfinder options")} anchor={at} placement="bottom-start" gap={0} width={size.popover} onClose={close}>
      <div className={styles.form} data-pathfinder-options="">
        <div className={styles.row}>
          <span className={styles.label}>{t("Precision")}</span>
          <NumericInput
            data-pathfinder-precision=""
            label={t("Precision")}
            value={current.precision}
            min={PATHFINDER_PRECISION.min}
            max={PATHFINDER_PRECISION.max}
            precision={3}
            step={0.01}
            bigStep={0.1}
            unit="px"
            scrub={false}
            onChange={(v) =>
              setPathfinderOptions(ed, {
                ...current,
                precision: clampPrecision(v),
              })
            }
            onExit={(r) => r === "enter" && close()}
          />
        </div>
        <Checkbox label={t("Remove redundant points")} checked={current.removeRedundantPoints} onChange={(c) => setPathfinderOptions(ed, { ...current, removeRedundantPoints: c })} />
        <Checkbox label={t("Divide and Outline will remove unpainted artwork")} checked={current.removeUnpainted} onChange={(c) => setPathfinderOptions(ed, { ...current, removeUnpainted: c })} />
        <div className={styles.footer}>
          <Button variant="secondary" onClick={() => setPathfinderOptions(ed, DEFAULT_PATHFINDER)}>
            {t("Defaults")}
          </Button>
        </div>
      </div>
    </FloatingPanel>
  );
}
