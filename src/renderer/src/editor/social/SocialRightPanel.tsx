/**
 * A Social file's right panel (docs/social.md §19, the owner's ask 2026-10-24): what it shows follows what the user
 * looks at —
 * - nothing selected (a click on the board's blank): the **Board** — the board's brand, the posts by status, the grids
 *   (a click glides to one), what the review found, Export approved…;
 * - two posts or more: the **bulk** panel — the Post section's shared fields (Mixed where they differ) and the actions
 *   for them all (Ask agent…, Export…, Delete);
 * - one post, or layers inside one (the focus view, focus.ts): Figma's **Design** panel, with the post's own **Post**
 *   section a tab beside it.
 * The agent is the left panel's (SocialAgentPanel). Its width is its own (`ui.socialRightWidth`), Design mode's
 * untouched; the content changes in place, the width stays (the canvas doesn't jump).
 */
import { useMemo, useSyncExternalStore } from "react";
import { Button, PanelSection, ResizeHandle, SegmentedControl } from "@/ds";
import { PLATFORM_NAMES, formatById } from "@shared/social/formats";
import { POST_STATUSES, type Platform, type PostStatus } from "@shared/social/types";
import { t, tp, useT } from "@/i18n";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { applySelection } from "../agents/mcpTools";
import { RightHeader } from "../panels/RightPanel";
import { DesignPanel } from "../panels/design/DesignPanel";
import { designPanelTab } from "../panels/design/tabOrder";
import { runEditorCommand } from "../commands";
import { canExport } from "../exporting";
import { layoutOf } from "./arrange";
import { BrandPicker } from "./BrandPicker";
import { glide, useFocusedPost } from "./focus";
import { PostSection } from "./PostSection";
import { askAgent, exportPostsDialog } from "./SocialMode";
import { socialOf, useSocialBoard } from "./socialState";
import panelStyles from "../panels/Panels.module.css";
import styles from "./SocialRightPanel.module.css";

/** The right panel's size in a Social file [ours]: 320 wide (240–560). */
export const SOCIAL_RIGHT_PANEL = { width: 320, minWidth: 240, maxWidth: 560 };

const STATUS_LABEL: Record<PostStatus, string> = { draft: "Draft", reviewed: "Reviewed", approved: "Approved", exported: "Exported" };

/** The selected posts (the selection's top-level frames that are posts). */
function useSelectedPostCount(): number {
  const ed = useEditor();
  return useSyncExternalStore(
    (on) => {
      const a = ed.store.subscribe("selection", on);
      const b = socialOf(ed).subscribe(on);
      return () => {
        a();
        b();
      };
    },
    () => {
      const posts = new Set(socialOf(ed).get().posts.map((p) => p.id));
      return ed.store.selection.refs.filter((id) => posts.has(id)).length;
    },
  );
}

export function SocialRightPanel() {
  useT();
  const ed = useEditor();
  const width = useUI((s) => s.socialRightWidth ?? SOCIAL_RIGHT_PANEL.width);
  const focus = useFocusedPost(ed);
  const posts = useSelectedPostCount();
  const anything = useSyncExternalStore((on) => ed.store.subscribe("selection", on), () => ed.store.selection.refs.length > 0);
  const view = focus ? "design" : posts > 1 ? "bulk" : anything ? "design" : "board";
  return (
    <aside className={panelStyles.right} style={{ width }} aria-label={t("Social panel")} data-panel="right" data-social-right={view}>
      <RightHeader />
      {view === "board" ? <BoardPanel /> : view === "bulk" ? <BulkPanel count={posts} /> : <PostDesign post={!!focus} />}
      <ResizeHandle side="left" value={width} min={SOCIAL_RIGHT_PANEL.minWidth} max={SOCIAL_RIGHT_PANEL.maxWidth} defaultValue={SOCIAL_RIGHT_PANEL.width} onChange={(px) => ed.ui.set({ socialRightWidth: px })} />
    </aside>
  );
}

/** One post (or a layer in it): the Design panel, the post's Post section a tab beside it. */
function PostDesign({ post }: { post: boolean }) {
  const ed = useEditor();
  const tab = useUI((s) => s.socialPanelTab ?? "design");
  if (!post)
    return (
      <div className={panelStyles.rightBody} onKeyDownCapture={designPanelTab}>
        <DesignPanel />
      </div>
    );
  return (
    <>
      <div className={styles.switch}>
        <SegmentedControl
          label={t("Social panel")}
          fullWidth
          value={tab}
          options={[
            { value: "design", label: t("Design") },
            { value: "post", label: t("Post") },
          ]}
          onChange={(v) => ed.ui.set({ socialPanelTab: v as "design" | "post" })}
        />
      </div>
      <div className={panelStyles.rightBody} onKeyDownCapture={designPanelTab} data-social-properties="">
        {tab === "post" ? <PostSection /> : <DesignPanel />}
      </div>
    </>
  );
}

/** Two posts or more: their shared fields and the actions for them all. */
function BulkPanel({ count }: { count: number }) {
  const ed = useEditor();
  const ids = () => {
    const posts = new Set(socialOf(ed).get().posts.map((p) => p.id));
    return ed.store.selection.refs.filter((id) => posts.has(id));
  };
  return (
    <div className={panelStyles.rightBody} data-social-bulk="">
      <div className={styles.bulkHead}>
        <span className={styles.bulkTitle}>{tp(count, "{n} post selected", "{n} posts selected")}</span>
      </div>
      <PostSection />
      <PanelSection title={t("For all of them")}>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={() => askAgent(ed, ids())}>
            {t("Ask agent…")}
          </Button>
          <Button variant="secondary" disabled={!canExport(ed)} onClick={() => exportPostsDialog(ed, ids())}>
            {t("Export…")}
          </Button>
          <Button variant="secondary" onClick={() => runEditorCommand(ed, "edit.delete")}>
            {t("Delete")}
          </Button>
        </div>
      </PanelSection>
    </div>
  );
}

/** Nothing selected: the board's brand, statuses, grids, problems and export. */
function BoardPanel() {
  useT();
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const layout = useMemo(() => (board.posts.length ? layoutOf(ed, board.page) : null), [ed, board]);
  const total = board.posts.length;
  const byStatus = (s: PostStatus) => board.posts.filter((p) => p.data.status === s).length;
  const problems = board.posts.filter((p) => p.data.problems.length > 0);
  const approved = board.posts.filter((p) => p.data.status === "approved").map((p) => p.id);
  return (
    <div className={panelStyles.rightBody} data-social-board="">
      <PanelSection title={t("Brand")}>
        <BrandPicker />
      </PanelSection>
      <PanelSection title={t("Status")} actions={<span className={styles.muted}>{tp(total, "{n} design", "{n} designs")}</span>}>
        {total ? (
          <div className={styles.bars}>
            {POST_STATUSES.map((s) => {
              const n = byStatus(s);
              return (
                <div key={s} className={styles.bar} data-status={s}>
                  <span className={styles.barLabel}>{t(STATUS_LABEL[s])}</span>
                  <span className={styles.muted}>{n}</span>
                  <span className={styles.track}>
                    <span className={styles.fill} style={{ width: `${(n / total) * 100}%` }} />
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className={styles.muted}>{t("No designs yet.")}</p>
        )}
      </PanelSection>
      {layout && (
        <PanelSection title={t("Grids")}>
          <div className={styles.grids}>
            {layout.sections.flatMap((s) =>
              s.grids.map((g) => {
                const f = formatById(g.formatId);
                const name = `${s.platform in PLATFORM_NAMES ? PLATFORM_NAMES[s.platform as Platform] : t("Other sizes")} · ${f ? t(f.name) : t("Other size")}`;
                return (
                  <button
                    key={g.formatId}
                    type="button"
                    className={styles.gridRow}
                    onClick={() => {
                      const view = document.querySelector<HTMLElement>("[data-canvas-view]")?.getBoundingClientRect();
                      const zoom = Math.min(((view?.width ?? 1000) - 120) / g.width, ((view?.height ?? 800) - 160) / Math.max(1, g.height), 1);
                      glide(ed, { x: g.x + g.width / 2, y: g.y + g.height / 2, zoom });
                    }}
                    data-grid-row={g.formatId}
                  >
                    <span className={styles.gridName}>{name}</span>
                    <span className={styles.muted}>{g.ids.length}</span>
                  </button>
                );
              }),
            )}
          </div>
        </PanelSection>
      )}
      {problems.length > 0 && (
        <PanelSection title={t("Problems")}>
          <p className={styles.muted}>{tp(problems.length, "{n} design has problems the review found.", "{n} designs have problems the review found.")}</p>
          <Button variant="secondary" onClick={() => applySelection(ed, problems.map((p) => p.id), true)}>
            {t("Select them")}
          </Button>
        </PanelSection>
      )}
      <PanelSection title={t("Export")}>
        <p className={styles.muted}>{approved.length ? tp(approved.length, "{n} approved design, with the platforms' presets.", "{n} approved designs, with the platforms' presets.") : t("Approve designs in their Post tab to export them together.")}</p>
        <Button variant="secondary" disabled={!approved.length || !canExport(ed)} onClick={() => exportPostsDialog(ed, approved)}>
          {t("Export approved…")}
        </Button>
      </PanelSection>
    </div>
  );
}
