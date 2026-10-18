/**
 * Social's left panel (docs/social.md §6.2), the navigation bar's Posts tab: the board's brand, the page's posts by
 * campaign with "+" (New post's menu), and the Templates gallery's place — round 18b's (collapsed by default when the
 * page has posts). Same width and resize handle as Design's left panel.
 */
import { EmptyState, Icon, MenuButton, PanelSection, ResizeHandle } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { TabHeader } from "../panels/TabHeader";
import { NavStrip } from "../panels/Rail";
import { useBrands } from "../studio/forms";
import { canWritePosts } from "./actions";
import { BrandPicker } from "./BrandPicker";
import { boardBrand, newPostEntries, pickNewPost } from "./NewPostMenu";
import { PostsList } from "./PostsList";
import { useSocialBoard } from "./socialState";
import panelStyles from "../panels/Panels.module.css";
import styles from "./SocialLeftPanel.module.css";

export function SocialLeftPanel() {
  useT();
  const ed = useEditor();
  const width = useUI((s) => s.leftWidth);
  const { brands } = useBrands();
  const board = useSocialBoard(ed);
  const templatesOpen = useUI((s) => s.socialTemplatesOpen);
  const navMinimized = useUI((s) => !!s.navMinimized);
  // Closed by default once the page has posts; the owner's own toggle wins.
  const templates = templatesOpen ?? board.posts.length === 0;
  return (
    <aside className={panelStyles.left} style={{ width: width + 1 }} aria-label={t("Posts panel")} data-panel="left" data-tab="posts">
      {navMinimized && <NavStrip />}
      <TabHeader
        title={t("Posts")}
        actions={
          <MenuButton label={t("New post")} tooltip align="end" className={styles.add} disabled={!canWritePosts(ed)} entries={() => newPostEntries(boardBrand(ed, brands))} onSelect={(id) => pickNewPost(ed, id, brands)}>
            <Icon name="24.plus.small" />
          </MenuButton>
        }
      />
      <div className={styles.brand}>
        <BrandPicker />
      </div>
      <div className={styles.scroll}>
        <PostsList />
      </div>
      <PanelSection title={t("Templates")} collapsible open={templates} onOpenChange={(open) => ed.ui.set({ socialTemplatesOpen: open })} className={styles.templates} data-social-templates="">
        <EmptyState icon="24.component" title={t("No templates yet")} body={t("Templates saved from posts, and the agent's starter templates, show here.")} />
      </PanelSection>
      <ResizeHandle side="right" value={width} onChange={(px) => ed.ui.set({ leftWidth: px })} />
    </aside>
  );
}
