/**
 * Dev Mode's frame stepper above the toolbar (the owner's capture docs/research/figma/live/owner-2026-10-18/
 * figma-devmode-inspect: "‹ 1 / 1 ›"; Figma's `dev-handoff-focus-next` / `-previous`, atlas 14 §2): the selection's
 * design among the page's top-level frames, and the previous / next one — selected and zoomed to.
 */
import { useMemo } from "react";
import { IconButton, Toolbar } from "@/ds";
import { useSelection } from "@/engine/hooks";
import type { Guid } from "@/engine/codec";
import { t, useT } from "@/i18n";
import { useEditor } from "../controller";
import { topLevelOf } from "../actions";
import styles from "./DevMode.module.css";

const DESIGN_TYPES = new Set(["FRAME", "SYMBOL", "INSTANCE", "SECTION"]);

export function FrameStepper() {
  useT();
  const ed = useEditor();
  const selection = useSelection(ed.store);
  const page = ed.store.page;
  // The page's designs, top first in the canvas's reading order (Layers' order: last child first).
  const frames = useMemo(() => {
    const ids = (ed.engine.readNode(page, { childIds: true }) as { childIds?: Guid[] } | null)?.childIds ?? [];
    return ids.filter((id) => DESIGN_TYPES.has(ed.engine.readNode(id, { fields: ["type"] })?.type ?? "")).reverse();
    // The selection changes with every page and structure change that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed, page, selection.refs]);
  if (!frames.length) return null;
  const top = selection.refs.length ? topLevelOf(ed, selection.refs[0])?.guid : undefined;
  const at = top ? frames.indexOf(top) : -1;
  const go = (step: number) => {
    const next = frames[at < 0 ? (step > 0 ? 0 : frames.length - 1) : (at + step + frames.length) % frames.length];
    ed.engine.setSelection([next]);
    ed.engine.command("ZOOM_TO_SELECTION");
    ed.focusCanvas();
  };
  return (
    <Toolbar floating secondary label={t("Frames")} className={styles.stepper} data-frame-stepper="">
      <IconButton icon="24.chevron.right" label={t("Previous frame")} className={styles.stepBack} disabled={frames.length < 2 && at >= 0} onClick={() => go(-1)} />
      <span className={styles.stepCount}>{at < 0 ? `– / ${frames.length}` : `${at + 1} / ${frames.length}`}</span>
      <IconButton icon="24.chevron.right" label={t("Next frame")} disabled={frames.length < 2 && at >= 0} onClick={() => go(1)} />
    </Toolbar>
  );
}
