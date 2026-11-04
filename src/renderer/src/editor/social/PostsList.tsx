/**
 * A post's parts the chrome shares (docs/social.md §6.2; the Posts tab that listed them went, §37): its format's label,
 * its picture (PostThumb: the asset view's strip, the posts table, the export dialog), and its menu — resize, duplicate
 * for another format, move to a campaign, ask the agent, save as a template, export, delete — whose Resize to /
 * Duplicate for / Save as template… / Export… rows the canvas's menu on a post frame shows (`postCanvasRows`).
 */
import { useEffect, useRef } from "react";
import { showToast, type MenuEntry } from "@/ds";
import { t } from "@/i18n";
import type { Guid } from "@/engine/codec";
import { PLATFORMS, PLATFORM_NAMES, formatById, formatsFor, parseBrandFormatId } from "@shared/social/formats";
import type { SocialCampaign } from "@shared/social/types";
import { useEditor, type EditorController } from "../controller";
import { applySelection } from "../agents/mcpTools";
import { canWritePosts, editorWriter, newCampaign, resizePost, setCampaign, setPost, withinWrite } from "./actions";
import { askAgent, exportPostsDialog } from "./SocialMode";
import { canExport } from "../exporting";
import { boardBrandId, type PostRow } from "./socialState";
import styles from "./SocialLeftPanel.module.css";

/** A post's format name and platform (a brand's own size: its id's format, no platform). */
export function formatLabel(row: PostRow): { name: string; platform: string | null } {
  const f = formatById(row.data.formatId);
  if (f) return { name: t(f.name), platform: f.platform };
  const own = parseBrandFormatId(row.data.formatId);
  return { name: own ? `${Math.round(row.width)} × ${Math.round(row.height)}` : row.data.formatId, platform: null };
}

/** The post's picture, 24 px (rendered at 2× by the engine), drawn again when the board changes. */
export function PostThumb({ row }: { row: PostRow }) {
  const ed = useEditor();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const c = canvas.current;
      const ctx = c?.getContext("2d");
      if (!c || !ctx || ed.engine.destroyed) return;
      try {
        const px = ed.engine.renderNodeThumbnailPixels({ node: row.id, maxSize: 48 });
        if (!px) return;
        c.width = px.width;
        c.height = px.height;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
      } catch {
        // No thumbnail from this engine: the square stays empty.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [ed, row]);
  return <canvas ref={canvas} className={styles.thumb} aria-hidden />;
}

const RESIZE = "resize:";
const DUPLICATE = "duplicate:";
const MOVE = "move:";
const NEW_CAMPAIGN = "move-new";

/** Platform › format submenus for "Resize to" / "Duplicate for". */
function formatItems(prefix: string): MenuEntry[] {
  return PLATFORMS.map((p) => ({ id: `${prefix}platform:${p}`, label: PLATFORM_NAMES[p], items: formatsFor(p).map((f) => ({ id: `${prefix}${f.id}`, label: t(f.name), hint: `${f.width} × ${f.height}` })) }));
}

export function postMenu(ed: EditorController, ids: readonly Guid[], campaigns: readonly SocialCampaign[]): MenuEntry[] {
  const write = canWritePosts(ed);
  return [
    { id: "resize", label: t("Resize to"), disabled: !write, items: formatItems(RESIZE) },
    { id: "duplicate", label: t("Duplicate for"), disabled: !write, items: formatItems(DUPLICATE) },
    {
      id: "move",
      label: t("Move to campaign"),
      disabled: !write,
      items: [...campaigns.map((c) => ({ id: `${MOVE}${c.id}`, label: c.name || t("Untitled campaign") })), { id: `${MOVE}`, label: t("No campaign") }, "-", { id: NEW_CAMPAIGN, label: t("New campaign") }],
    },
    "-",
    { id: "ask", label: t("Ask agent…") },
    { id: "template", label: t("Save as template…"), disabled: !write || ids.length !== 1 },
    { id: "export", label: t("Export…"), disabled: !ids.length || !canExport(ed) },
    "-",
    { id: "delete", label: t("Delete"), disabled: !write || !ids.length },
  ];
}

/** The canvas menu's post rows' ids: the post menu's under this prefix (menus.ts runs them on the selected posts). */
export const POST_ROW = "post:";
const CANVAS_ROWS = new Set(["resize", "duplicate", "template", "export"]);

const prefixed = (entries: readonly MenuEntry[]): MenuEntry[] => entries.map((e) => (e === "-" || !("id" in e) ? e : { ...e, id: `${POST_ROW}${e.id}`, ...(e.items ? { items: prefixed(e.items) } : {}) }));

/** The canvas's menu over post frames (docs/social.md §6.6): Resize to ›, Duplicate for ›, Save as template…, Export…. */
export function postCanvasRows(ed: EditorController, ids: readonly Guid[]): MenuEntry[] {
  return prefixed(postMenu(ed, ids, []).filter((e) => e !== "-" && "id" in e && CANVAS_ROWS.has(e.id)));
}

/** Runs a post menu's pick; a new campaign's id when one was made (its name is edited next). */
export function runPostMenu(ed: EditorController, id: string, ids: readonly Guid[], page: Guid): string | null {
  const w = editorWriter(ed);
  try {
    if (id.startsWith(RESIZE)) resizePost(ed, w, ids, id.slice(RESIZE.length), { duplicate: false });
    else if (id.startsWith(DUPLICATE)) {
      const copies = resizePost(ed, w, ids, id.slice(DUPLICATE.length), { duplicate: true });
      if (copies.length) applySelection(ed, copies, true);
    } else if (id === NEW_CAMPAIGN) {
      const campaign = newCampaign(t("New campaign"), boardBrandId(ed));
      w("Move to campaign", () => {
        setCampaign(ed, withinWrite, page, campaign);
        setPost(ed, withinWrite, ids, { campaignId: campaign.id });
      });
      return campaign.id;
    } else if (id.startsWith(MOVE)) setPost(ed, w, ids, { campaignId: id.slice(MOVE.length) || null });
    else if (id === "ask") askAgent(ed, ids);
    else if (id === "template") ed.ui.set({ socialSaveTemplate: ids[0] ?? null });
    else if (id === "export") exportPostsDialog(ed, ids);
    else if (id === "delete") {
      ed.engine.setSelection([...ids]);
      ed.engine.command("DELETE");
    }
  } catch (e) {
    showToast({ message: e instanceof Error ? e.message : String(e), kind: "error" });
  }
  return null;
}
