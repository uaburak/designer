/**
 * The focus view's chrome (docs/social.md §19): over the canvas, the post in focus left bright and the rest of the
 * board dimmed (`Spotlight`); over the visible canvas, the path bar on top — "← Board", the platform › format, the
 * post's name, its place in its grid with ‹ › — and the strip of its grid's posts at the bottom (a click focuses one,
 * gliding across). `SocialFocus` drives the camera (focus.ts). Nothing here writes the document.
 */
import { useLayoutEffect, useRef } from "react";
import { Button, IconButton } from "@/ds";
import { formatById, PLATFORM_NAMES } from "@shared/social/formats";
import { t, useT } from "@/i18n";
import { useEditor } from "../controller";
import { applySelection } from "../agents/mcpTools";
import { layoutOf } from "./arrange";
import { useFocusCamera, useFocusedPost } from "./focus";
import { PostThumb } from "./PostsList";
import { useSocialBoard } from "./socialState";
import styles from "./FocusChrome.module.css";

/** The post in focus bright, the board around it dimmed (on the canvas, placed from the camera). */
export function Spotlight() {
  const ed = useEditor();
  const focus = useFocusedPost(ed);
  const board = useSocialBoard(ed);
  const row = focus ? board.posts.find((p) => p.id === focus) : null;
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!row) return;
    const place = () => {
      const c = ed.store.camera;
      const s = el.current?.style;
      if (!s) return;
      s.transform = `translate(${row.x * c.zoom + c.x}px, ${row.y * c.zoom + c.y}px)`;
      s.width = `${row.width * c.zoom}px`;
      s.height = `${row.height * c.zoom}px`;
    };
    place();
    return ed.store.subscribe("camera", place);
  }, [ed, row]);
  if (!row) return null;
  return (
    <div className={styles.dim} aria-hidden data-spotlight="">
      <div ref={el} className={styles.hole} />
    </div>
  );
}

/** The camera of the focus view, and its bars over the visible canvas while a post is in focus. */
export function SocialFocus() {
  useT();
  const ed = useEditor();
  const focus = useFocusedPost(ed);
  useFocusCamera(ed, focus);
  const board = useSocialBoard(ed);
  if (!focus) return null;
  const row = board.posts.find((p) => p.id === focus);
  if (!row) return null;
  const grid = layoutOf(ed, board.page).sections.flatMap((s) => s.grids).find((g) => g.ids.includes(focus));
  const ids = grid?.ids ?? [focus];
  const at = ids.indexOf(focus);
  const f = formatById(row.data.formatId);
  const go = (id: string | undefined) => id && applySelection(ed, [id], false);
  return (
    <>
      <div className={styles.bar} role="toolbar" aria-label={t("Post in focus")} data-focus-bar="">
        <Button variant="secondary" icon="24.arrow.left" onClick={() => ed.engine.setSelection([])} data-focus-back="">
          {t("Board")}
        </Button>
        <span className={styles.path}>{f ? `${PLATFORM_NAMES[f.platform]} › ${t(f.name)}` : t("Other size")}</span>
        <span className={styles.name}>{row.name}</span>
        <span className={styles.spacer} />
        <IconButton icon="24.chevron.left" label={t("Previous post")} disabled={at <= 0} onClick={() => go(ids[at - 1])} />
        <span className={styles.place}>{t("{n} of {total}", { n: String(at + 1), total: String(ids.length) })}</span>
        <IconButton icon="24.chevron.right" label={t("Next post")} disabled={at >= ids.length - 1} onClick={() => go(ids[at + 1])} />
      </div>
      {ids.length > 1 && (
        <div className={styles.strip} role="listbox" aria-label={t("Posts in this grid")} data-focus-strip="">
          {ids.map((id) => {
            const p = board.posts.find((x) => x.id === id);
            return p ? (
              <button key={id} type="button" role="option" aria-selected={id === focus} aria-label={p.name} className={styles.cell} onClick={() => go(id)}>
                <PostThumb row={p} />
              </button>
            ) : null;
          })}
        </div>
      )}
    </>
  );
}
