/**
 * Convert to Social file (docs/social.md §18.1, the owner's wireframe H) in the editor: what a Design file's pages
 * hold, read from the engine for the pure rules (shared/social/convert.ts); the conversion applied as one undo step
 * "Convert to Social file"; and the two ways it runs —
 * - **Copy as a new Social file** (the default): the file flushed, duplicated by the store as a Social file (node GUIDs
 *   kept), the conversion handed to the copy in its FileUiState (`socialConvert`) and the copy opened; the Social
 *   editor applies it once when it opens (`applyPendingConversion`) and clears it. Nothing is written to the original.
 * - **Convert this file**: a version saved first, the conversion applied here, then the file's kind set to "buzz"
 *   (`workspace.setEditorType`) and the editor switched to Social. The file keeps its key, versions and comments; its
 *   other pages stay.
 */
import { t, tp } from "@/i18n";
import { showToast } from "@/ds";
import { isWebApp } from "@/app/webApp";
import type { Guid, Message, NodeChange } from "@/engine/codec";
import { conversionPlan, findConvertible, readConversion, type ConvertFound, type ConvertInput, type ConvertNode, type ConvertTopNode, type RowChoice, type SocialConversion } from "@shared/social/convert";
import type { EditorController } from "../../controller";
import { isSocialFile, setMode } from "../../devmode/devMode";
import { fileOps, thumbnailNode } from "../../objectCommands";
import { canWritePosts, editorWriter, type Writer } from "../actions";
import { postRecord, readPost, writePost } from "../posts";
import { boardEndAt } from "../board";

export const CONVERT_LABEL = "Convert to Social file";

/** File › Convert to Social file… is there: a Design file this person can edit, with the store's file operations. */
export function canConvertToSocial(ed: EditorController): boolean {
  return !isSocialFile(ed) && canWritePosts(ed) && !!fileOps(ed)?.duplicateAs;
}

/** "Convert this file" is offered: the file's kind is this computer's to change and versions can be saved. */
export function canConvertInPlace(ed: EditorController): boolean {
  const ops = fileOps(ed);
  return !!ops?.setEditorType && !!ops.canChangeKind?.() && typeof ed.source.saveVersion === "function";
}

/** File › Convert to Social file…: the dialog. */
export function openConvertDialog(ed: EditorController): void {
  if (canConvertToSocial(ed)) ed.ui.set({ socialConvertDialog: true, uiHidden: false });
}

type Row = NodeChange & { childIds?: Guid[] };

const box = (ed: EditorController, n: Row): ConvertNode => ({
  id: n.guid,
  name: n.name ?? "",
  type: ed.withRealType(n).type ?? "",
  x: n.transform?.m02 ?? 0,
  y: n.transform?.m12 ?? 0,
  width: n.size?.x ?? 0,
  height: n.size?.y ?? 0,
});

/** The page holding the file's thumbnail frame (DOCUMENT.thumbnailInfo), or null. */
export function thumbnailPage(ed: EditorController): Guid | null {
  let id = thumbnailNode(ed);
  for (let depth = 0; id && depth < 64; depth++) {
    const n = ed.engine.readNode(id, { fields: ["type", "parentIndex"] });
    if (!n) return null;
    if (n.type === "CANVAS") return id;
    id = n.parentIndex?.guid ?? null;
  }
  return null;
}

/** The pages' top-level layers (a frame's or section's children with it), as the rules read them. */
export function readConvertInput(ed: EditorController, brands: ConvertInput["brands"] = []): ConvertInput {
  const fields = ["name", "type", "size", "transform"];
  const pages = ed.store.pages.map((p) => {
    const kids = (ed.engine.readNode(p.guid, { childIds: true })?.childIds ?? []) as Guid[];
    const tops = kids.length ? (ed.engine.readNodes(kids, { fields, childIds: true }) as Row[]) : [];
    const nodes: ConvertTopNode[] = tops.map((n) => {
      const top: ConvertTopNode = box(ed, n);
      if ((top.type === "FRAME" || top.type === "SECTION") && n.childIds?.length) top.children = (ed.engine.readNodes(n.childIds, { fields }) as Row[]).map((c) => box(ed, c));
      return top;
    });
    return { id: p.guid, name: p.name, nodes };
  });
  return { pages, thumbnailPageId: thumbnailPage(ed), brands };
}

/** What this file holds that can become posts. */
export const findInEditor = (ed: EditorController, brands: ConvertInput["brands"] = []): ConvertFound => findConvertible(readConvertInput(ed, brands));

/**
 * Applies a conversion as one write (`w`; the chrome's: one undo step "Convert to Social file"): each container's
 * children moved to the page where the container is, in reading order (the first on top in Layers) and where they
 * are on the page, the empty container removed; each post's record written (a draft of its format with the page's
 * brand, no campaign — a frame already a post keeps its record); then the pages a copy drops removed. Layers no longer
 * there are passed over (applying it twice changes nothing). Returns how many posts the pages hold from it.
 */
export function applyConversion(ed: EditorController, w: Writer, plan: SocialConversion): number {
  return w(CONVERT_LABEL, () => {
    let posts = 0;
    for (const page of plan.pages) {
      if (ed.engine.readNode(page.pageId, { fields: ["type"] })?.type !== "CANVAS") continue;
      for (const u of page.unwrap) {
        const node = ed.engine.readNode(u.id, { childIds: true, fields: ["parentIndex"] }) as Row | null;
        if (!node) continue;
        const parent = node.parentIndex?.guid ?? page.pageId;
        const siblings = (ed.engine.readNode(parent, { childIds: true })?.childIds ?? []) as Guid[];
        // Just above the container; each next one under the last (Layers lists them top-down in reading order).
        const at = siblings.indexOf(u.id) + 1;
        const kids = (node.childIds ?? []) as Guid[];
        const order = [...u.children.filter((id) => kids.includes(id)), ...kids.filter((id) => !u.children.includes(id))];
        for (const id of order) ed.engine.moveNodes([id], parent, at);
        if (!ed.engine.readNode(u.id, { childIds: true })?.childIds?.length) {
          const message: Message = { type: "NODE_CHANGES", sessionID: ed.source.sessionID ?? 1, nodeChanges: [{ guid: u.id, phase: "REMOVED" } as NodeChange] };
          ed.engine.applyChanges(message, "user");
        }
      }
      let at = 0;
      for (const p of page.posts) {
        const n = ed.engine.readNode(p.id, { fields: ["parentIndex", "transform"] });
        if (!n || n.parentIndex?.guid !== page.pageId) continue;
        if (!readPost(ed, p.id)) writePost(ed, p.id, postRecord(p.formatId, { brandId: page.brandId }));
        // In the plan's order past the board's end (docs/social.md §19): the board's arrange then keeps a container's
        // designs together, in its reading order, rather than reading two containers side by side as one grid.
        if (n.transform && isSocialFile(ed)) {
          const end = boardEndAt(at++);
          ed.engine.setProps([p.id], { transform: { ...n.transform, m02: end.x, m12: end.y } });
        }
        posts++;
      }
    }
    const removing = new Set(plan.removePages);
    const kept = ed.store.pages.filter((p) => !removing.has(p.guid));
    if (removing.size && kept.length) {
      const first = plan.pages.find((p) => kept.some((k) => k.guid === p.pageId))?.pageId ?? kept[0].guid;
      if (removing.has(ed.store.page)) ed.engine.setCurrentPage(first);
      for (const id of removing) if (ed.store.pages.length > 1) ed.engine.command("DELETE_PAGE", { page: id });
    }
    return posts;
  });
}

const applied = new WeakSet<EditorController>();

/**
 * A Social copy's conversion, applied once as it opens (one undo step), then cleared from its UI state; the first
 * converted page shown, zoomed to fit. Returns the posts made (0: none waiting).
 */
export function applyPendingConversion(ed: EditorController): number {
  const plan = readConversion(ed.source.uiState?.socialConvert);
  if (!plan || applied.has(ed) || !isSocialFile(ed) || !canWritePosts(ed)) return 0;
  applied.add(ed);
  ed.source.setUiState?.({ socialConvert: null });
  const made = applyConversion(ed, editorWriter(ed), plan);
  const first = plan.pages.find((p) => ed.store.pages.some((x) => x.guid === p.pageId))?.pageId;
  if (first && ed.store.page !== first) ed.engine.setCurrentPage(first);
  ed.engine.command("ZOOM_TO_FIT");
  if (made) showToast({ message: tp(made, "Converted 1 design to a post", "Converted {n} designs to posts") });
  return made;
}

/** Home's Convert to Social file…: the Design file opened with the dialog shown (once). */
export function openPendingDialog(ed: EditorController): void {
  if (!ed.source.uiState?.socialConvertOpen) return;
  ed.source.setUiState?.({ socialConvertOpen: false });
  openConvertDialog(ed);
}

type Nav = { designer?: { nav?: { openFile?: (fileKey: string) => Promise<unknown> } } };

/**
 * Runs the dialog's Convert. "copy": a new Social file holding the converted pages, opened in a tab (the original
 * untouched); "convert": this file, after a version is saved. Resolves with the Social file's key.
 */
export async function convertToSocialFile(ed: EditorController, found: ConvertFound, choices: Readonly<Record<string, RowChoice>>, mode: "copy" | "convert"): Promise<string | null> {
  const ops = fileOps(ed);
  if (!ops?.duplicateAs || !canConvertToSocial(ed)) return null;
  if (mode === "convert") {
    if (!canConvertInPlace(ed)) return null;
    const plan = conversionPlan(found, choices);
    if (!plan.pages.length) return null;
    await ed.source.saveVersion!({ title: t("Before converting to Social file") });
    applyConversion(ed, editorWriter(ed), plan);
    await ops.setEditorType!("buzz");
    setMode(ed, "social");
    return ops.fileKey;
  }
  const plan = conversionPlan(found, choices, { allPages: ed.store.pages.map((p) => p.guid) });
  if (!plan.pages.length) return null;
  await ed.source.flush();
  const copy = await ops.duplicateAs({ editorType: "buzz", name: ed.ui.get().fileName || ed.source.fileName });
  await ops.setUiStateOf?.(copy.fileKey, { socialConvert: plan, currentPageId: plan.pages[0].pageId });
  const open = (window as unknown as Nav).designer?.nav?.openFile;
  if (open) await open(copy.fileKey);
  // The web app: the copy in a new browser tab, as File › Duplicate opens one
  else if (isWebApp()) window.open(`${location.pathname}?editor&file=${encodeURIComponent(copy.fileKey)}`, "_blank", "noopener");
  else showToast({ message: t("Made the Social file “{name}”", { name: copy.name }) });
  return copy.fileKey;
}
