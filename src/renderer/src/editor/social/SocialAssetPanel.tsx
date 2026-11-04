/**
 * A Social file's left panel in the asset view (docs/social.md §36, the owner's ask 2026-11-04): a post opened on its own
 * canvas is designed like a Figma frame, so the panel is the agent above (70% of its height) and that post's layers below —
 * only the post and what is in it, no Pages. Back in the grid view the tabs are as before (SocialAgentPanel,
 * SocialTemplatesPanel, Design's LeftPanel). Same width and resize handle as Design's left panel.
 */
import { useCallback } from "react";
import { ResizeHandle } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { AgentsPanel } from "../panels/agents/AgentsPanel";
import { Layers } from "../panels/Layers";
import { NavStrip } from "../panels/Rail";
import { useFocusedPost } from "./focus";
import panelStyles from "../panels/Panels.module.css";
import styles from "./SocialAssetPanel.module.css";

export function SocialAssetPanel() {
  useT();
  const ed = useEditor();
  const width = useUI((s) => s.leftWidth);
  const navMinimized = useUI((s) => !!s.navMinimized);
  const draft = useUI((s) => s.socialDraft ?? null);
  const taken = useCallback(() => ed.ui.set({ socialDraft: null }), [ed]);
  const post = useFocusedPost(ed);
  return (
    <aside className={panelStyles.left} style={{ width: width + 1, ["--left-panel-width" as string]: `${width}px` }} aria-label={t("Layers panel")} data-panel="left" data-tab="asset">
      {navMinimized && <NavStrip />}
      <div className={styles.half} data-social-asset-agent="">
        <AgentsPanel placement="left" draft={draft} onDraftTaken={taken} />
      </div>
      <div className={styles.half} data-social-asset-layers={post ?? ""}>
        <Layers root={post} />
      </div>
      <ResizeHandle side="right" value={width} onChange={(px) => ed.ui.set({ leftWidth: px })} />
    </aside>
  );
}
