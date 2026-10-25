/**
 * New post (docs/social.md §6.6) and the toolbar's Social slot [ours]: New post's menu — platform › format, each with
 * its size, then the board's brand's own sizes — Safe areas (a toggle; its right-click sets their opacity and colour,
 * §30) and Table (round 18b's posts table, a toggle). The same menu opens from the Posts list's "+" and from the command `social.new-post` (⌘K). A pick makes a
 * post of that format on the board (actions.ts `newPost`, one undo step), with the board's brand, then selects it and
 * zooms to it.
 */
import { useEffect, useRef, useState } from "react";
import { ContextMenu, Icon, MenuButton, ToolButton, showToast, type MenuEntry } from "@/ds";
import { t, useT } from "@/i18n";
import { PLATFORMS, PLATFORM_NAMES, brandFormatId, formatsFor, parseBrandFormatId } from "@shared/social/formats";
import type { Brand } from "@shared/studio/types";
import { useEditor, type EditorController } from "../controller";
import { useUI } from "../hooks";
import { applySelection } from "../agents/mcpTools";
import { useBrands } from "../studio/forms";
import { canWritePosts, editorWriter, newPost } from "./actions";
import { SAFE_AREA_OPACITIES, safeAreaLook, setSafeAreaLook, toggleSafeAreas, type SafeAreaColor } from "./SocialMode";
import styles from "./NewPostMenu.module.css";

const FORMAT = "format:";

/** The menu's rows: each platform's formats in a submenu, then the brand's own sizes (when it has any). */
export function newPostEntries(brand: Brand | null): MenuEntry[] {
  const size = (f: { width: number; height: number }) => `${f.width} × ${f.height}`;
  const out: MenuEntry[] = PLATFORMS.map((p) => ({
    id: `platform:${p}`,
    label: PLATFORM_NAMES[p],
    items: formatsFor(p).map((f) => ({ id: `${FORMAT}${f.id}`, label: t(f.name), hint: size(f) })),
  }));
  if (brand?.formats.length) {
    out.push("-", { header: brand.name });
    for (const f of brand.formats) out.push({ id: `${FORMAT}${brandFormatId(brand.id, f.id)}`, label: f.name, hint: size(f) });
  }
  return out;
}

/** The board's brand (ui.socialBrandId) among the library's brands. */
export function boardBrand(ed: EditorController, brands: readonly Brand[] | null): Brand | null {
  const id = ed.ui.get().socialBrandId;
  return (id && brands?.find((b) => b.id === id)) || null;
}

/** A menu pick: a post of that format with the board's brand, selected and zoomed to. */
export function pickNewPost(ed: EditorController, id: string, brands: readonly Brand[] | null, campaignId: string | null = null): void {
  if (!id.startsWith(FORMAT) || !canWritePosts(ed)) return;
  const formatId = id.slice(FORMAT.length);
  const own = parseBrandFormatId(formatId);
  const format = own ? brands?.find((b) => b.id === own.brandId)?.formats.find((f) => f.id === own.formatId) : undefined;
  try {
    const post = newPost(ed, editorWriter(ed), { formatId, format, brandId: boardBrand(ed, brands)?.id ?? null, campaignId });
    applySelection(ed, [post], true);
    ed.focusCanvas();
  } catch (e) {
    showToast({ message: e instanceof Error ? e.message : String(e), kind: "error" });
  }
}

const SAFE_COLORS: readonly { id: Exclude<SafeAreaColor, "auto">; label: string; token: string }[] = [
  { id: "red", label: "Red", token: "--figma-color-bg-danger" },
  { id: "blue", label: "Blue", token: "--figma-color-bg-brand" },
  { id: "purple", label: "Purple", token: "--figma-color-bg-component" },
  { id: "yellow", label: "Yellow", token: "--figma-color-bg-warning" },
  { id: "green", label: "Green", token: "--figma-color-bg-success" },
];

/** The Safe areas button's right-click: their opacity, then their colour (Auto: red, else a colour the design isn't) */
function safeAreaEntries(ed: EditorController): MenuEntry[] {
  const look = safeAreaLook(ed.ui.get());
  return [
    { header: t("Opacity") },
    ...SAFE_AREA_OPACITIES.map((o) => ({ id: `opacity:${o}`, label: `${Math.round(o * 100)}%`, checked: Math.abs(look.opacity - o) < 1e-3 })),
    "-",
    { header: t("Color") },
    { id: "color:auto", label: t("Auto"), checked: look.color === "auto" },
    ...SAFE_COLORS.map((c) => ({ id: `color:${c.id}`, label: t(c.label), swatch: `var(${c.token})`, checked: look.color === c.id })),
  ];
}

function pickSafeAreaLook(ed: EditorController, id: string): void {
  if (id.startsWith("opacity:")) setSafeAreaLook(ed, { opacity: Number(id.slice(8)) });
  else if (id.startsWith("color:")) setSafeAreaLook(ed, { color: id.slice(6) as SafeAreaColor });
}

/** The toolbar's Social slot: New post ▾, Safe areas, Table. */
export function SocialToolbarSlot() {
  useT();
  const ed = useEditor();
  const { brands } = useBrands();
  const safeAreas = useUI((s) => s.socialSafeAreas !== false);
  const table = useUI((s) => !!s.socialTable);
  const asked = useUI((s) => s.socialNewPostMenu ?? 0);
  const wrap = useRef<HTMLSpanElement>(null);
  const first = useRef(asked);
  const [lookAt, setLookAt] = useState<{ x: number; y: number } | null>(null);
  // `social.new-post` (⌘K): the menu opens as if its button were clicked.
  useEffect(() => {
    if (asked === first.current) return;
    wrap.current?.querySelector("button")?.click();
  }, [asked]);
  return (
    <>
      <span ref={wrap} className={styles.slot} data-social-new-post="">
        <MenuButton label={t("New post")} tooltip placement="top" className={styles.button} disabled={!canWritePosts(ed)} entries={() => newPostEntries(boardBrand(ed, brands))} onSelect={(id) => pickNewPost(ed, id, brands)}>
          <Icon name="24.plus" />
        </MenuButton>
      </span>
      <span
        className={styles.slot}
        data-social-safe-areas=""
        onContextMenu={(e) => {
          e.preventDefault();
          setLookAt({ x: e.clientX, y: e.clientY });
        }}
      >
        <ToolButton icon="24.safe-area" label={t("Safe areas")} active={safeAreas} onSelect={() => toggleSafeAreas(ed)} />
      </span>
      {lookAt ? <ContextMenu at={lookAt} above context label={t("Safe areas")} entries={safeAreaEntries(ed)} onSelect={(id) => pickSafeAreaLook(ed, id)} onClose={() => setLookAt(null)} /> : null}
      {/* The posts table (docs/social.md §4.5, templates/PostsTable.tsx) */}
      <ToolButton icon="24.table" label={t("Table")} active={table} onSelect={() => ed.ui.set((s) => ({ socialTable: !s.socialTable }))} />
    </>
  );
}
