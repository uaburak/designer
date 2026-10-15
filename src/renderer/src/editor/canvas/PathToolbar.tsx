/**
 * Simplify vector and Offset path as Figma's tools (docs/research/rea/vector.md §8, §10; Figma's SIMPLIFY_VECTOR and
 * OFFSET_PATH with their secondary toolbar), replacing round 10's popover. The engine keeps the tool (editor/
 * PathTools.cpp, `Engine.pathTool`): every change previews live on the canvas, ✓ (or Enter) applies it as one undo step,
 * Cancel (or Esc, or ⌘Z) puts the layer back. The toolbar sits where vector edit's does, 8 over the bottom toolbar,
 * and follows the engine's PATH_TOOL events (Enter / Esc on the canvas close it there).
 * - Simplify: "simpler" icon, a slider −2…3 (step 0.01, ⇧ 0.1, starting at 3 — no change), "more detailed" icon.
 * - Offset: a slider over the engine's range (step 1, starting at 0) and its value, Join Miter ("Square") / Round.
 */
import { t, useT } from "@/i18n";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Button, Icon, IconButton, NumericInput, SegmentedControl, Slider, Toolbar, ToolbarDivider } from "@/ds";
import type { PathToolState } from "@/engine/codec";
import { useEditor, type EditorController } from "../controller";
import styles from "./PathToolbar.module.css";

/** Opens the tool on the selection (Vector › Simplify vector / Offset vector); false when the engine refused it. */
export function openPathTool(ed: EditorController, kind: "SIMPLIFY" | "OFFSET"): boolean {
  if (ed.engine.destroyed) return false;
  return !!ed.engine.pathTool({ op: "begin", kind })?.active;
}

/** The open tool, as the engine's PATH_TOOL events report it (null: none). */
export function usePathTool(ed: EditorController): PathToolState | null {
  const [state, setState] = useState<PathToolState | null>(() => {
    const s = ed.engine.destroyed ? null : ed.engine.pathTool({ op: "state" });
    return s?.active ? s : null;
  });
  useEffect(() => ed.engine.on("PATH_TOOL", (e) => setState(e.active ? { ...e } : null)), [ed]);
  return state;
}

export function PathToolbar({ state }: { state: PathToolState }) {
  useT();
  const ed = useEditor();
  const simplify = state.kind === "SIMPLIFY";
  const set = (patch: { threshold: number } | { offset?: number; join?: "MITER" | "ROUND" }) => void ed.engine.pathTool({ op: "set", ...patch });
  const apply = () => {
    ed.engine.pathTool({ op: "apply" });
    ed.focusCanvas();
  };
  const cancel = () => {
    ed.engine.pathTool({ op: "cancel" });
    ed.focusCanvas();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The toolbar's own keys: Enter applies, Esc cancels (the slider's arrows step it); nothing reaches the canvas.
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
    e.stopPropagation();
  };
  return (
    <Toolbar floating secondary label={simplify ? t("Simplify vector") : t("Offset vector")} data-path-toolbar={simplify ? "simplify" : "offset"} onKeyDown={onKeyDown}>
      {simplify ? (
        <div className={styles.group}>
          <span className={styles.icon} title={t("Simpler")}>
            <Icon name="24.simplify.less" />
          </span>
          <Slider className={styles.slider} label={t("Simplify")} value={state.threshold} min={-2} max={3} step={0.01} onChange={(v) => set({ threshold: v })} data-path-slider="" />
          <span className={styles.icon} title={t("More detailed")}>
            <Icon name="24.simplify.more" />
          </span>
        </div>
      ) : (
        <>
          <div className={styles.group}>
            <Slider className={styles.slider} label={t("Offset")} value={state.offset} min={state.minOffset} max={state.maxOffset} step={1} onChange={(v) => set({ offset: v })} data-path-slider="" />
            <NumericInput className={styles.value} label={t("Offset")} value={state.offset} min={state.minOffset} max={state.maxOffset} step={1} bigStep={5} precision={0} onChange={(v) => set({ offset: v })} />
          </div>
          <ToolbarDivider />
          <SegmentedControl
            label={t("Join")}
            value={state.join}
            options={[
              { value: "MITER", icon: "24.join.miter", tooltip: t("Square") },
              { value: "ROUND", icon: "24.join.round", tooltip: t("Round") },
            ]}
            onChange={(v) => set({ join: v as "MITER" | "ROUND" })}
          />
        </>
      )}
      <ToolbarDivider />
      <Button variant="secondary" onClick={cancel} data-path-cancel="">
        {t("Cancel")}
      </Button>
      <IconButton icon="24.check" label={t("Apply")} onClick={apply} data-path-apply="" />
    </Toolbar>
  );
}
