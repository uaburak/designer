/**
 * The page's brand over its board on the canvas (docs/social.md §34, the owner's ask 2026-11-03): Instagram's web
 * profile header — the profile picture, the handle with New post / New story, the counts, the name and the description
 * (the story rings are the Prototype tab's) — over the board, as wide as the grids in the feed grid's row (only the
 * feed's when it is alone: the owner, 2026-11-03), sized from the feed grid's width and scaled with the camera as the
 * board is. A page without a brand shows the placeholder; a double-click on the name or the
 * description writes it, a click on the picture picks one — the brand is made in the library (Brands) when there is
 * none (BrandProfile). Canvas chrome: never a layer of the document; gone in the asset view. The wheel over it pans and
 * zooms the canvas, as over the board.
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import { cx } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "../controller";
import { layoutOf } from "./arrange";
import { BOARD } from "./board";
import { canWritePosts } from "./actions";
import { AvatarPicture, EditableField, pickBrandAvatar, saveBrandProfile, useBrandProfile } from "./BrandProfile";
import { useFocusedPost } from "./focus";
import { isStory, profileOf, startPost } from "./SocialPreview";
import { useSocialBoard } from "./socialState";
import styles from "./CanvasProfile.module.css";

/** Instagram's web profile column, CSS px: the header is laid out at this width, then scaled to its grid's */
export const PROFILE_WIDTH = 935;
/** Screen px between the header and its grid's name band (BoardLabels' 32 px band, then a gap) */
const OVER_GRID = 48;
/** A page with no posts: the header over where its first grid goes (three 1080 px columns at the board's gap) */
const FIRST_GRID = { x: 0, y: 0, width: 3 * 1080 + 2 * BOARD.gap, span: 3 * 1080 + 2 * BOARD.gap };

export function CanvasProfile() {
  useT();
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const focus = useFocusedPost(ed);
  const profile = useBrandProfile();
  const parts = useMemo(() => profileOf(board), [board]);
  const box = useRef<HTMLDivElement>(null);
  // Over the feed's grid: the first one that isn't stories, else the first
  const grid = useMemo(() => {
    if (!board.page) return null;
    if (!board.posts.length) return FIRST_GRID;
    const story = new Map(board.posts.map((p) => [p.id, isStory(p)]));
    const grids = layoutOf(ed, board.page).sections.flatMap((s) => s.grids);
    const g = grids.find((x) => !story.get(x.ids[0] ?? "")) ?? grids[0];
    if (!g) return FIRST_GRID;
    // Across every grid in its row (a story grid beside it, …)
    const row = grids.filter((x) => Math.abs(x.frame.y - g.frame.y) < 1);
    const left = Math.min(...row.map((x) => x.frame.x));
    const right = Math.max(...row.map((x) => x.frame.x + x.frame.width));
    return { x: left, y: g.frame.y, width: g.frame.width, span: right - left };
  }, [ed, board]);
  useLayoutEffect(() => {
    const run = () => {
      const el = box.current;
      if (!el || !grid) return;
      const cam = ed.store.camera;
      const scale = (cam.zoom * grid.width) / PROFILE_WIDTH;
      el.style.width = `${(PROFILE_WIDTH * grid.span) / grid.width}px`;
      el.style.transform = `translate(${grid.x * cam.zoom + cam.x}px, ${grid.y * cam.zoom + cam.y - OVER_GRID}px) scale(${scale}) translateY(-100%)`;
    };
    run();
    return ed.store.subscribe("camera", run);
  }, [ed, grid, focus]);
  if (!grid || focus) return null;
  const write = canWritePosts(ed);
  const placeholder = !profile.brand;
  return (
    <div className={styles.layer}>
      <div
        ref={box}
        className={styles.profile}
        // The wheel pans and zooms the canvas, as over the board (the canvas reads it off its own element)
        onWheel={(e) => ed.canvas?.dispatchEvent(new WheelEvent("wheel", e.nativeEvent))}
        data-canvas-profile={placeholder ? "placeholder" : (profile.brand?.id ?? "")}
      >
        <div className={styles.head}>
          <button type="button" className={styles.avatarButton} disabled={!write} onClick={() => pickBrandAvatar(ed, profile)} title={write ? t("Change profile picture") : undefined} aria-label={t("Change profile picture")} data-canvas-profile-avatar="">
            <AvatarPicture profile={profile} className={cx(styles.avatar, placeholder && styles.placeholderAvatar)} />
          </button>
          <div className={styles.info}>
            <div className={styles.row}>
              <span className={cx(styles.handle, placeholder && styles.placeholder)}>{profile.handle}</span>
              <button type="button" className={styles.button} disabled={!write} onClick={() => startPost(ed, "instagram.post", board.brandId ?? profile.brand?.id ?? null)} data-canvas-profile-new="post">
                {t("New post")}
              </button>
              <button type="button" className={styles.button} disabled={!write} onClick={() => startPost(ed, "instagram.story", board.brandId ?? profile.brand?.id ?? null)} data-canvas-profile-new="story">
                {t("New story")}
              </button>
            </div>
            <div className={styles.stats}>
              <span>
                <strong>{parts.feed.length}</strong> {t("posts")}
              </span>
              <span>
                <strong>{board.campaigns.length}</strong> {t("campaigns")}
              </span>
              <span>
                <strong>{parts.approved}</strong> {t("approved")}
              </span>
            </div>
            <EditableField
              value={profile.brand?.name ?? ""}
              placeholder={profile.pageName || t("Your brand")}
              label={t("Brand name")}
              className={styles.name}
              editingClassName={styles.editing}
              placeholderClassName={styles.placeholder}
              onCommit={(name) => name && void saveBrandProfile(ed, profile, { name })}
              data-canvas-profile-title=""
            />
            <EditableField
              value={profile.description}
              placeholder={t("Double-click to write a description")}
              multiline
              maxLength={150}
              label={t("Description")}
              className={styles.bio}
              editingClassName={styles.editing}
              placeholderClassName={styles.placeholder}
              onCommit={(description) => void saveBrandProfile(ed, profile, { description })}
              data-canvas-profile-bio=""
            />
          </div>
        </div>
      </div>
    </div>
  );
}
