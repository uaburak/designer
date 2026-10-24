/**
 * A Social file's agent (docs/social.md §19, the owner's ask 2026-10-24): the left panel's first tab — the Agents panel
 * full height on the left, the right panel being Social's own. What the chrome drafts for the agent (Ask agent…, a
 * post's Fix, the board's suggestions) lands in its composer (`ui.socialDraft`). Same width and resize handle as
 * Design's left panel.
 */
import { useCallback } from "react";
import { ResizeHandle } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { AgentsPanel } from "../panels/agents/AgentsPanel";
import { NavStrip } from "../panels/Rail";
import panelStyles from "../panels/Panels.module.css";

export function SocialAgentPanel() {
  useT();
  const ed = useEditor();
  const width = useUI((s) => s.leftWidth);
  const navMinimized = useUI((s) => !!s.navMinimized);
  const draft = useUI((s) => s.socialDraft ?? null);
  const taken = useCallback(() => ed.ui.set({ socialDraft: null }), [ed]);
  return (
    <aside className={panelStyles.left} style={{ width: width + 1 }} aria-label={t("Agent")} data-panel="left" data-tab="agents">
      {navMinimized && <NavStrip />}
      <AgentsPanel placement="left" draft={draft} onDraftTaken={taken} />
      <ResizeHandle side="right" value={width} onChange={(px) => ed.ui.set({ leftWidth: px })} />
    </aside>
  );
}
