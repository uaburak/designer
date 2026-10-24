/**
 * The navigation bar's Brands tab (docs/studio.md §3.2): the Brands view edge to edge over the panels and the canvas,
 * the navigation bar left visible (as the Variables view). Another tab, Esc on the list or Close ends it. Its agent
 * buttons go to Social's agent (the right panel): Design posts there with the brand on the board, Ask agent with the
 * text in its composer; Read labels uses the editor's text model (library_read_labels).
 */
import { useEffect, useMemo, useRef } from "react";
import { t, useT } from "@/i18n";
import { useEditor, type EditorController } from "../../controller";
import { useUI } from "../../hooks";
import { modeOf, setMode } from "../../devmode/devMode";
import { draftForAgent } from "../../social/SocialMode";
import { runLibraryTool } from "../libraryTools";
import { BrandsView } from "./BrandsView";
import { designRequest } from "./model";
import type { BrandsActions } from "./parts";
import styles from "./BrandsWindow.module.css";

/** Social, its board on `brandId` when given; the Brands tab gives way to Posts. */
function toSocial(ed: EditorController, brandId?: string) {
  if (modeOf(ed) !== "social") {
    setMode(ed, "social");
    ed.setTool("MOVE");
  } else ed.ui.set({ railTab: "posts" });
  if (brandId) ed.ui.set({ socialBrandId: brandId });
}

export function editorBrandsActions(ed: EditorController): BrandsActions {
  return {
    askAgent(text) {
      toSocial(ed);
      draftForAgent(ed, text);
    },
    designPosts(brand, products) {
      toSocial(ed, brand.id);
      draftForAgent(ed, designRequest(brand, products));
    },
    async readLabels(brandId, productId) {
      const r = await runLibraryTool(ed, "library_read_labels", { brandId, productId });
      if (!r.isError) return null;
      return r.content[0]?.type === "text" ? r.content[0].text : t("The label couldn't be read");
    },
  };
}

export function BrandsWindow() {
  useT();
  const ed = useEditor();
  const open = useUI((s) => s.railTab === "brands" && !s.variablesOpen && s.mode !== "dev" && !s.uiHidden);
  const navMinimized = useUI((s) => !!s.navMinimized);
  const actions = useMemo(() => editorBrandsActions(ed), [ed]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) root.current?.focus({ preventScroll: true });
  }, [open]);
  if (!open) return null;
  const close = () => {
    ed.ui.set({ railTab: modeOf(ed) === "social" ? "posts" : "file" });
    ed.focusCanvas();
  };
  return (
    // A dialog to the editor's shortcuts (keyboard.ts inOverlay): keys typed here never reach the canvas
    <div ref={root} className={styles.window} role="dialog" aria-label={t("Brands")} tabIndex={-1} data-brands-window="" data-nav-minimized={navMinimized || undefined}>
      <BrandsView actions={actions} onClose={close} />
    </div>
  );
}
