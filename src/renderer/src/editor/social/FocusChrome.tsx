/**
 * A Social file's views over the visible canvas (docs/social.md §19, §20, §23 — Figma Buzz's): `SocialFocus` drives the
 * asset view's camera (focus.ts) and draws its column of posts at the canvas's left — New post on top, then every post
 * in the board's order, the one shown marked (a click shows another); `PostToolbar` floats over the one selected post in
 * either view, as Buzz's inline toolbar (help.figma.com "Edit assets in Figma Buzz": Size, the background's Fill —
 * colour, gradient, image & video —, Border solid or dashed; docs/social.md §28): its format (a click resizes it to
 * another of its platform's), its fill, its border, Clip content, and Edit (the agent, the post as context). Each
 * write is one undo step.
 */
import { useLayoutEffect, useRef, useSyncExternalStore, type ChangeEvent } from "react";
import type { Paint } from "@/engine/codec";
import { Icon, MenuButton, type MenuEntry } from "@/ds";
import { formatById, formatsFor } from "@shared/social/formats";
import { t, useT } from "@/i18n";
import { useEditor, type EditorController } from "../controller";
import { useTopics, useUI } from "../hooks";
import { hexToColor, solidPaint } from "../model/color";
import { mediaPaint } from "../model/paints";
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
    // Gone while the post (or anything) is dragged on the canvas: it would trail behind (docs/social.md §25).
    const canvas = ed.canvas;
    const down = () => bar.current?.toggleAttribute("data-dragging", true);
    const up = () => bar.current?.toggleAttribute("data-dragging", false);
    canvas?.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up, true);
    const off = ed.store.subscribe("camera", place);
    return () => {
      off();
      canvas?.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up, true);
    };
  }, [ed, row]);
  const { brands } = useBrands();
  const file = useRef<HTMLInputElement>(null);
  // Its fill, border and clip read again after every change of the document
  useTopics(ed.store, ["undo", "structure"]);
  if (!row) return null;
  const f = formatById(row.data.formatId);
  const formats: MenuEntry[] = f ? formatsFor(f.platform).map((x) => ({ id: x.id, label: t(x.name), shortcut: `${x.width} × ${x.height}`, checked: x.id === f.id })) : [];
  const write = canWritePosts(ed);
  const node = ed.engine.readNode(row.id, { fields: ["fillPaints", "strokePaints", "dashPattern", "frameMaskDisabled"] });
  const fill = (node?.fillPaints ?? []).find((p) => p.visible !== false);
  const stroked = (node?.strokePaints ?? []).some((p) => p.visible !== false);
  const dashed = stroked && (node?.dashPattern?.length ?? 0) > 0;
  const clipped = node?.frameMaskDisabled !== true;
  // The post's brand's colours (else the board's), then white and black
  const brand = brands?.find((b) => b.id === row.data.brandId) ?? boardBrand(ed, brands);
  const colors = [...new Set([...(brand?.colors ?? []).map((c) => c.hex.toUpperCase()), "#FFFFFF", "#000000"])];
  const fills: MenuEntry[] = [
    { header: t("Color") },
    ...colors.map((hex) => {
      const name = brand?.colors.find((c) => c.hex.toUpperCase() === hex)?.name;
      return { id: `color:${hex}`, label: name || hex, ...(name ? { hint: hex } : {}), swatch: hex };
    }),
    "-",
    { id: "gradient", label: t("Gradient"), icon: "24.fill.solid.small" },
    { id: "image", label: t("Image or video…"), icon: "24.image" },
    { id: "none", label: t("No fill") },
  ];
  const setFill = (id: string) => {
    if (id === "image") return file.current?.click();
    let paints: Paint[] = [];
    if (id.startsWith("color:")) paints = [solidPaint(id.slice(6))];
    else if (id === "gradient") {
      const [a, b] = [colors[0] ?? "#FFFFFF", colors[1] ?? "#000000"];
      paints = [{ type: "GRADIENT_LINEAR", visible: true, opacity: 1, blendMode: "NORMAL", transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 }, stops: [{ color: hexToColor(a), position: 0 }, { color: hexToColor(b), position: 1 }] } as Paint];
    }
    ed.setProps([row.id], { fillPaints: paints }, "Fill");
  };
  const picked = async (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!chosen) return;
    const [img] = await ed.images.import([chosen]);
    if (img) ed.setProps([row.id], { fillPaints: [mediaPaint(img) as Paint] }, "Fill");
  };
  const borders: MenuEntry[] = [
    { id: "none", label: t("No border"), checked: !stroked },
    { id: "solid", label: t("Solid"), icon: "24.stroke-weight", checked: stroked && !dashed },
    { id: "dashed", label: t("Dashed"), icon: "24.stroke.dashed", checked: dashed },
  ];
  const setBorder = (id: string) => {
    if (id === "none") return void ed.setProps([row.id], { strokePaints: [] }, "Border");
    const ink = brand?.colors[0]?.hex ?? "#000000";
    // A post's border: 1 % of its short side, inside it (Buzz's) [ours: the weight]
    const weight = Math.max(4, Math.round(Math.min(row.width, row.height) / 100));
    ed.setProps([row.id], { strokePaints: [solidPaint(ink)], strokeWeight: weight, strokeAlign: "INSIDE", dashPattern: id === "dashed" ? [weight * 3, weight * 2] : [] }, "Border");
  };
  const swatch = fill?.type === "SOLID" && fill.color ? `rgb(${Math.round(fill.color.r * 255)} ${Math.round(fill.color.g * 255)} ${Math.round(fill.color.b * 255)})` : undefined;
  return (
    <div ref={bar} className={styles.toolbar} role="toolbar" aria-label={t("Post")} data-post-toolbar="">
      <MenuButton label={t("Format")} placement="bottom" className={styles.format} disabled={!write || !formats.length} entries={formats} onSelect={(formatId) => formatId !== row.data.formatId && resizePost(ed, editorWriter(ed), [row.id], formatId, { duplicate: false })}>
        <span className={styles.formatName}>{f ? t(f.name) : t("Other size")}</span>
        <Icon name="24.chevron.down" />
      </MenuButton>
      <MenuButton label={t("Fill")} tooltip placement="bottom" className={styles.tool} disabled={!write} entries={fills} onSelect={setFill} data-post-fill="">
        <span className={styles.swatch} data-kind={fill ? (fill.type === "SOLID" ? "solid" : fill.type === "IMAGE" || fill.type === "VIDEO" ? "image" : "gradient") : "none"} style={swatch ? { background: swatch } : undefined} />
        <Icon name="24.chevron.down" />
      </MenuButton>
      <MenuButton label={t("Border")} tooltip placement="bottom" className={styles.tool} disabled={!write} entries={borders} onSelect={setBorder} data-post-border="">
        <Icon name={dashed ? "24.stroke.dashed" : "24.stroke-weight"} />
        <Icon name="24.chevron.down" />
      </MenuButton>
      <button type="button" className={styles.tool} aria-pressed={clipped} disabled={!write} title={t("Clip content")} aria-label={t("Clip content")} onClick={() => ed.setProps([row.id], { frameMaskDisabled: clipped }, "Clip content")} data-post-clip="">
        <Icon name="24.pathfinder.crop.small" />
      </button>
      <span className={styles.sep} />
      <button type="button" className={styles.edit} onClick={() => askAgent(ed, [row.id])} data-post-edit="">
        <Icon name="24.ai.edit-image" />
        <span>{t("Edit")}</span>
      </button>
      <input ref={file} type="file" accept="image/*,video/*" hidden onChange={(e) => void picked(e)} data-post-fill-file="" />
    </div>
  );
}
