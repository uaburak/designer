/**
 * A Social file's views over the visible canvas (docs/social.md §19, §20, §23 — Figma Buzz's): `SocialFocus` drives the
 * asset view's camera (focus.ts) and draws its column of posts at the canvas's left — New post on top, then every post
 * in the board's order, the one shown marked (a click shows another); `PostToolbar` floats over the one selected post in
 * either view — its format (a click resizes it to another of its platform's) and Edit (the agent, the post as context).
 * Nothing here writes the document but those two actions.
 */
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Icon, MenuButton, type MenuEntry } from "@/ds";
import { formatById, formatsFor } from "@shared/social/formats";
import { t, useT } from "@/i18n";
import { useEditor, type EditorController } from "../controller";
import { useUI } from "../hooks";
import { applySelection } from "../agents/mcpTools";
import { useBrands } from "../studio/forms";
import { canWritePosts, editorWriter, resizePost } from "./actions";
import { postsInOrder, useFocusCamera, useFocusedPost } from "./focus";
import { boardBrand, newPostEntries, pickNewPost } from "./NewPostMenu";
import { PostThumb } from "./PostsList";
import { askAgent } from "./SocialMode";
import { socialOf, useSocialBoard } from "./socialState";
import styles from "./FocusChrome.module.css";

/** The asset view's camera, and its column of posts while it shows one. */
export function SocialFocus() {
  useT();
  const ed = useEditor();
  const focus = useFocusedPost(ed);
  useFocusCamera(ed, focus);
  const board = useSocialBoard(ed);
  const { brands } = useBrands();
  const asset = useUI((s) => s.socialView === "asset");
  if (!asset) return null;
  const ids = postsInOrder(ed);
  return (
    <>
      <nav className={styles.column} aria-label={t("Posts")} data-asset-column="">
        <MenuButton label={t("New post")} tooltip placement="bottom" className={styles.add} disabled={!canWritePosts(ed)} entries={() => newPostEntries(boardBrand(ed, brands))} onSelect={(id) => pickNewPost(ed, id, brands)}>
          <Icon name="24.plus" />
        </MenuButton>
        <div className={styles.list} role="listbox" aria-label={t("Posts")}>
          {ids.map((id) => {
            const p = board.posts.find((x) => x.id === id);
            return p ? (
              <button key={id} type="button" role="option" aria-selected={id === focus} aria-label={p.name} title={p.name} className={styles.cell} onClick={() => applySelection(ed, [id], false)} data-asset-cell={id}>
                <PostThumb row={p} />
              </button>
            ) : null;
          })}
        </div>
      </nav>
    </>
  );
}

/** The one post selected (the post itself, not a layer in it), re-rendering when the selection changes. */
function useSelectedPost(ed: EditorController): string | null {
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
      const sel = ed.store.selection.refs;
      return sel.length === 1 && socialOf(ed).post(sel[0]) ? sel[0] : null;
    },
  );
}

/** Screen px between the toolbar's bottom and the post's top: over its card's 32 px band, 12 px clear (Buzz's) */
const TOOLBAR_GAP = 44;

/** Over the selected post: its format and Edit (Buzz's inline toolbar); with the canvas's layers (canvas px). */
export function PostToolbar() {
  const ed = useEditor();
  const id = useSelectedPost(ed);
  const board = useSocialBoard(ed);
  const bar = useRef<HTMLDivElement>(null);
  const row = id ? board.posts.find((p) => p.id === id) : undefined;
  useLayoutEffect(() => {
    if (!row) return;
    const place = () => {
      const el = bar.current;
      if (!el) return;
      const cam = ed.store.camera;
      const x = (row.x + row.width / 2) * cam.zoom + cam.x;
      const y = row.y * cam.zoom + cam.y - TOOLBAR_GAP;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    };
    place();
    return ed.store.subscribe("camera", place);
  }, [ed, row]);
  if (!row) return null;
  const f = formatById(row.data.formatId);
  const formats: MenuEntry[] = f ? formatsFor(f.platform).map((x) => ({ id: x.id, label: t(x.name), shortcut: `${x.width} × ${x.height}`, checked: x.id === f.id })) : [];
  return (
    <div ref={bar} className={styles.toolbar} role="toolbar" aria-label={t("Post")} data-post-toolbar="">
      <MenuButton label={t("Format")} placement="bottom" className={styles.format} disabled={!canWritePosts(ed) || !formats.length} entries={formats} onSelect={(formatId) => formatId !== row.data.formatId && resizePost(ed, editorWriter(ed), [row.id], formatId, { duplicate: false })}>
        <span className={styles.formatName}>{f ? t(f.name) : t("Other size")}</span>
        <Icon name="24.chevron.down" />
      </MenuButton>
      <span className={styles.sep} />
      <button type="button" className={styles.edit} onClick={() => askAgent(ed, [row.id])} data-post-edit="">
        <Icon name="24.ai.edit-image" />
        <span>{t("Edit")}</span>
      </button>
    </div>
  );
}
