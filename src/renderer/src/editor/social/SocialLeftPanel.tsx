/**
 * Social's left panel (docs/social.md §6.2), the navigation bar's Posts tab: the board's brand, the page's posts by
 * campaign with "+" (New post's menu); the templates are their own tab since §20 (SocialTemplatesPanel). Same width
 * and resize handle as Design's left panel.
 */
import { Icon, MenuButton, ResizeHandle } from "@/ds";
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
import panelStyles from "../panels/Panels.module.css";
import styles from "./SocialLeftPanel.module.css";

export function SocialLeftPanel() {
  useT();
  const ed = useEditor();
  const width = useUI((s) => s.leftWidth);
  const { brands } = useBrands();
  const navMinimized = useUI((s) => !!s.navMinimized);
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
      <ResizeHandle side="right" value={width} onChange={(px) => ed.ui.set({ leftWidth: px })} />
    </aside>
  );
}
