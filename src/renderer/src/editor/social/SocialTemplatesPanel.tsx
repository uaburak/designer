/**
 * A Social file's Templates (docs/social.md §20; round 18b's gallery, templates/TemplatesGallery.tsx): the rail's own
 * tab after Posts, as Figma Buzz keeps templates in its left panel — this file's templates and the enabled libraries',
 * filtered by platform, format and kind; a click puts one on the board for the board's brand (it opens in focus), a
 * drag drops it; none yet: Make starter templates…. Same width and resize handle as Design's left panel.
 */
import { ResizeHandle } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { TabHeader } from "../panels/TabHeader";
import { NavStrip } from "../panels/Rail";
import { BrandPicker } from "./BrandPicker";
import { TemplatesGallery } from "./templates/TemplatesGallery";
import panelStyles from "../panels/Panels.module.css";
import styles from "./SocialLeftPanel.module.css";

export function SocialTemplatesPanel() {
  useT();
  const ed = useEditor();
  const width = useUI((s) => s.leftWidth);
  const navMinimized = useUI((s) => !!s.navMinimized);
  return (
    <aside className={panelStyles.left} style={{ width: width + 1 }} aria-label={t("Templates")} data-panel="left" data-tab="templates">
      {navMinimized && <NavStrip />}
      <TabHeader title={t("Templates")} />
      <div className={styles.brand}>
        <BrandPicker />
      </div>
      <div className={styles.scroll}>
        <TemplatesGallery />
      </div>
      <ResizeHandle side="right" value={width} onChange={(px) => ed.ui.set({ leftWidth: px })} />
    </aside>
  );
}
