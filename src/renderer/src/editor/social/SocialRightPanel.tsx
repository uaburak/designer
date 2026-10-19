/**
 * Social's right panel (docs/social.md §6.3; the layout is the proposed answer to §12.1, pending the owner's
 * confirmation — SOCIAL_RIGHT_PANEL is the one place to change it): the header (account, Present, Share), an
 * Agent | Properties switch, then — Agent, the default — the Agents panel full height (moved here from the left panel's
 * Agents tab: one instance mounts at a time) with the Post and Design sections collapsed under its composer;
 * Properties gives the whole panel to Post and Design, the chat hidden, a badge on "Agent" counting the tasks running.
 * Its width is its own (`ui.socialRightWidth`), Design mode's untouched.
 */
import { useCallback, useState, useSyncExternalStore } from "react";
import { Badge, PanelSection, ResizeHandle, SegmentedControl } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { agentsOf } from "../agents/service";
import { AgentsPanel } from "../panels/agents/AgentsPanel";
import { RightHeader } from "../panels/RightPanel";
import { DesignPanel } from "../panels/design/DesignPanel";
import { designPanelTab } from "../panels/design/tabOrder";
import { PostSection } from "./PostSection";
import panelStyles from "../panels/Panels.module.css";
import styles from "./SocialRightPanel.module.css";

/**
 * The right panel's defaults in Social (docs/social.md §12.1, proposed — owner to confirm): the Agent tab first, Post
 * and Design collapsed under the chat, 320 wide (240–560).
 */
export const SOCIAL_RIGHT_PANEL = {
  tab: "agent" as "agent" | "properties",
  postOpen: false,
  designOpen: false,
  width: 320,
  minWidth: 240,
  maxWidth: 560,
};

export function SocialRightPanel() {
  useT();
  const ed = useEditor();
  const width = useUI((s) => s.socialRightWidth ?? SOCIAL_RIGHT_PANEL.width);
  const tab = useUI((s) => s.socialRightTab ?? SOCIAL_RIGHT_PANEL.tab);
  const draft = useUI((s) => s.socialDraft ?? null);
  const taken = useCallback(() => ed.ui.set({ socialDraft: null }), [ed]);
  const service = agentsOf(ed);
  const running = useSyncExternalStore(service.subscribe, () => Object.keys(service.get().running).length);
  const [postOpen, setPostOpen] = useState(SOCIAL_RIGHT_PANEL.postOpen);
  const [designOpen, setDesignOpen] = useState(SOCIAL_RIGHT_PANEL.designOpen);
  return (
    <aside className={panelStyles.right} style={{ width }} aria-label={t("Social panel")} data-panel="right" data-social-right={tab}>
      <RightHeader />
      <div className={styles.switch}>
        <SegmentedControl
          label={t("Social panel")}
          fullWidth
          value={tab}
          options={[
            { value: "agent", label: t("Agent") },
            { value: "properties", label: t("Properties") },
          ]}
          onChange={(v) => ed.ui.set({ socialRightTab: v as "agent" | "properties" })}
        />
        {tab === "properties" && running > 0 && (
          <Badge tone="brand" count className={styles.badge} aria-label={t("Agent tasks running")}>
            {running}
          </Badge>
        )}
      </div>
      {tab === "agent" ? (
        <>
          <div className={styles.agent}>
            <AgentsPanel placement="right" draft={draft} onDraftTaken={taken} />
          </div>
          <div className={styles.under} onKeyDownCapture={designPanelTab}>
            <PanelSection title={t("Post")} collapsible open={postOpen} onOpenChange={setPostOpen} pad="none" data-social-section="post">
              <PostSection />
            </PanelSection>
            <PanelSection title={t("Design")} collapsible open={designOpen} onOpenChange={setDesignOpen} pad="none" data-social-section="design">
              <DesignPanel />
            </PanelSection>
          </div>
        </>
      ) : (
        <div className={panelStyles.rightBody} onKeyDownCapture={designPanelTab} data-social-properties="">
          <PanelSection title={t("Post")} pad="none" data-social-section="post">
            <PostSection />
          </PanelSection>
          <DesignPanel />
        </div>
      )}
      <ResizeHandle side="left" value={width} min={SOCIAL_RIGHT_PANEL.minWidth} max={SOCIAL_RIGHT_PANEL.maxWidth} defaultValue={SOCIAL_RIGHT_PANEL.width} onChange={(px) => ed.ui.set({ socialRightWidth: px })} />
    </aside>
  );
}
