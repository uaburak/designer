/**
 * Round 10 — the Figma menu's commands that are the editor's own (docs/editor.md "Round 10 — Menus, commands, left side
 * and toolbar"; live menus/main-edit.txt, main-view.txt, main-object.txt, main-file.txt, context-*.txt): Copy /
 * Paste properties (⌥⌘C / ⌥⌘V), Hide other layers, Set as thumbnail / Restore default thumbnail, Find previous / next
 * frame (Home / End), More layout options ▸, and the File menu's Duplicate, Save local copy…, Move to folder… where
 * the document source can do them. What live does beyond its menus' labels is from
 * help.figma.com or, where noted, unverified.
 */
import { t } from "@/i18n";
import { dismissToast, showToast } from "@/ds";
import { isWebApp } from "@/app/webApp";
import type { Guid, NodeChange } from "@/engine/codec";
import type { EditorController } from "./controller";
import type { EditorUiState } from "./documentSource";
import { exportAllowed } from "./exporting";
import { readPropertiesClipboard, writePropertiesClipboard } from "./clipboardIO";
import { fields } from "./panels/design/shared";
import { gridDefaults, type GridNode } from "./model/grid";
import { viewCentre } from "./canvas/viewInsets";
import { saveStatusOf } from "./saveStatus";

/** A GUID's session (a derived one's: its instance's). */
const sessionOf = (guid: string) => Number(String(guid).replace(/^I/, "").split(":")[0]) || 1;

// ---- Copy / Paste properties -----------------------------------------------------------------------------------------

/** What Copy properties takes (help.figma.com "Copy and paste properties": fills, strokes, effects, layout grids, text and export settings, opacity, blend mode, corner radius). */
const SHAPE_PROPERTIES = [
  "opacity",
  "blendMode",
  "fillPaints",
  "strokePaints",
  "strokeWeight",
  "strokeAlign",
  "strokeCap",
  "strokeJoin",
  "miterLimit",
  "dashPattern",
  "borderTopWeight",
  "borderRightWeight",
  "borderBottomWeight",
  "borderLeftWeight",
  "borderStrokeWeightsIndependent",
  "effects",
  "cornerRadius",
  "rectangleCornerRadiiIndependent",
  "rectangleTopLeftCornerRadius",
  "rectangleTopRightCornerRadius",
  "rectangleBottomRightCornerRadius",
  "rectangleBottomLeftCornerRadius",
  "cornerSmoothing",
  "invertedCornerMask",
  "layoutGrids",
  "exportSettings",
] as const;
const TEXT_PROPERTIES = ["fontName", "fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent", "textAlignHorizontal", "textAlignVertical", "textCase", "textDecoration"] as const;

type Copied = { fields: Record<string, unknown>; text: Record<string, unknown> | null };
/** The last copy, for when the system clipboard can't be read (a browser without the permission). */
const copied = new WeakMap<EditorController, Copied>();

const pickFrom = (n: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => n[k] !== undefined).map((k) => [k, n[k]]));

export function canCopyProperties(ed: EditorController): boolean {
  return ed.selection.length === 1;
}

/** ⌥⌘C: the layer's look onto the system clipboard (Figma's STYLE Message, clipboardIO.ts), so it pastes in any file. */
export function copyProperties(ed: EditorController): void {
  const [ref] = ed.selection;
  if (!ref || ed.selection.length !== 1) return;
  const n = ed.engine.readNode(ref, { fields: [...SHAPE_PROPERTIES, ...TEXT_PROPERTIES, "type"] }) as (NodeChange & Record<string, unknown>) | null;
  if (!n) return;
  const c: Copied = { fields: pickFrom(n, SHAPE_PROPERTIES), text: n.type === "TEXT" ? pickFrom(n, TEXT_PROPERTIES) : null };
  copied.set(ed, c);
  void writePropertiesClipboard(ed, { type: n.type, ...c.fields, ...c.text } as unknown as NodeChange);
  showToast({ message: t("Properties copied") });
}

/** Paste properties needs a selection; what the clipboard holds is only known once it is read. */
export function canPasteProperties(ed: EditorController): boolean {
  return ed.selection.length > 0;
}

/**
 * ⌥⌘V: the copied look onto every selected layer (a text's type settings onto texts only); one undo step. From the
 * system clipboard (copied here or in another file); this window's last copy when the clipboard can't be read.
 */
export async function pasteProperties(ed: EditorController): Promise<void> {
  if (!ed.selection.length) return;
  const read = await readPropertiesClipboard();
  const c: Copied | undefined =
    read === undefined
      ? copied.get(ed)
      : read
        ? { fields: pickFrom(read.node as unknown as Record<string, unknown>, SHAPE_PROPERTIES), text: read.node.type === "TEXT" ? pickFrom(read.node as unknown as Record<string, unknown>, TEXT_PROPERTIES) : null }
        : undefined;
  if (!c || !ed.selection.length || ed.engine.destroyed) return;
  const nodes = ed.selectedNodes();
  ed.batch("Paste properties", () => {
    for (const n of nodes) {
      const patch = { ...c.fields, ...(n.type === "TEXT" && c.text ? c.text : {}) };
      ed.engine.setProps([n.guid], fields(patch as never));
    }
  });
}

// ---- Hide other layers ------------------------------------------------------------------------------------------------

/** The page's top-level layers that hold none of the selection (what Hide other layers hides; unverified beyond the label). */
export function otherLayers(ed: EditorController): Guid[] {
  const page = ed.store.page;
  if (!page || !ed.selection.length) return [];
  const kids = (ed.engine.readNode(page, { childIds: true }) as { childIds?: Guid[] } | null)?.childIds ?? [];
  const keep = new Set<Guid>();
  for (const id of ed.selection) {
    let cur: Guid | undefined = id;
    let top: Guid | undefined = id;
    while (cur && cur !== page) {
      top = cur;
      cur = (ed.engine.readNode(cur, { fields: ["parentIndex"] }) as { parentIndex?: { guid: Guid } } | null)?.parentIndex?.guid;
    }
    if (top) keep.add(top);
  }
  return kids.filter((k) => !keep.has(k) && (ed.engine.readNode(k, { fields: ["visible"] }) as { visible?: boolean } | null)?.visible !== false);
}

export function hideOtherLayers(ed: EditorController): void {
  const others = otherLayers(ed);
  if (others.length) ed.setProps(others, { visible: false }, "Hide other layers");
}

// ---- The file's thumbnail ---------------------------------------------------------------------------------------------

/** The layer set as the file's thumbnail (the document's thumbnailInfo), or null. */
export function thumbnailNode(ed: EditorController): Guid | null {
  const info = (ed.engine.readNode("0:0", { fields: ["thumbnailInfo"] }) as { thumbnailInfo?: { nodeID?: { sessionID: number; localID: number } | string } } | null)?.thumbnailInfo;
  const id = info?.nodeID;
  if (!id) return null;
  const guid = typeof id === "string" ? id : `${id.sessionID}:${id.localID}`;
  return ed.engine.readNode(guid, { fields: ["type"] }) ? guid : null;
}

/** Set as thumbnail: one top-level frame or main component that isn't the thumbnail already (live context-frame / context-component). */
export function canSetThumbnail(ed: EditorController): boolean {
  if (ed.selection.length !== 1) return false;
  const n = ed.engine.readNode(ed.selection[0], { fields: ["type", "parentIndex", "resizeToFit"] }) as { type?: string; parentIndex?: { guid: Guid }; resizeToFit?: boolean } | null;
  return !!n && (n.type === "FRAME" || n.type === "SYMBOL") && !n.resizeToFit && n.parentIndex?.guid === ed.store.page && thumbnailNode(ed) !== ed.selection[0];
}

export function setThumbnail(ed: EditorController, ref: Guid | null): void {
  ed.setProps(["0:0"], { thumbnailInfo: ref ? { nodeID: ref, thumbnailVersion: "" } : null } as never, ref ? "Set as thumbnail" : "Restore default thumbnail");
  showToast({ message: ref ? t("Thumbnail set") : t("Default thumbnail restored") });
}

// ---- Find previous / next frame ---------------------------------------------------------------------------------------

/** The page's top-level frames, in Layers order from the top (sections, frames, components; not groups). */
export function pageFrames(ed: EditorController): Guid[] {
  const page = ed.store.page;
  if (!page) return [];
  const kids = (ed.engine.readNode(page, { childIds: true }) as { childIds?: Guid[] } | null)?.childIds ?? [];
  return kids
    .filter((k) => {
      const n = ed.engine.readNode(k, { fields: ["type", "resizeToFit", "visible"] }) as { type?: string; resizeToFit?: boolean; visible?: boolean } | null;
      return !!n && n.visible !== false && ["FRAME", "SYMBOL", "INSTANCE", "SECTION"].includes(String(n.type)) && !n.resizeToFit;
    })
    .reverse();
}

/**
 * Home / End (live View menu "Find previous frame" / "Find next frame"): the previous / next top-level frame selected and
 * brought to the middle of the view at the same zoom (Zoom to … frame, N / ⇧N, fits it instead; unverified beyond that).
 */
export function findFrame(ed: EditorController, step: 1 | -1): void {
  const frames = pageFrames(ed);
  if (!frames.length) return;
  const page = ed.store.page;
  let top: Guid | undefined = ed.selection[0];
  while (top) {
    const parent: Guid | undefined = (ed.engine.readNode(top, { fields: ["parentIndex"] }) as { parentIndex?: { guid: Guid } } | null)?.parentIndex?.guid;
    if (!parent || parent === page) break;
    top = parent;
  }
  const at = top ? frames.indexOf(top) : -1;
  const next = frames[at < 0 ? (step > 0 ? 0 : frames.length - 1) : (at + step + frames.length) % frames.length];
  const n = ed.engine.readNode(next, { fields: ["transform", "size"] }) as { transform?: { m02: number; m12: number }; size?: { x: number; y: number } } | null;
  ed.engine.setSelection([next]);
  const canvas = ed.canvas?.getBoundingClientRect();
  if (!n?.transform || !n.size || !canvas) return;
  const cam = ed.engine.getCamera();
  const cx = n.transform.m02 + n.size.x / 2;
  const cy = n.transform.m12 + n.size.y / 2;
  const mid = viewCentre(ed.canvas);
  ed.engine.setCamera({ x: mid.x - cx * cam.zoom, y: mid.y - cy * cam.zoom, zoom: cam.zoom });
}

// ---- More layout options ▸ ----------------------------------------------------------------------------------------------

export type LayoutFlow = "HORIZONTAL" | "VERTICAL" | "GRID";

/**
 * More layout options ▸ (live context-frame / context-multi list it; its items aren't captured — unverified): auto layout
 * of a chosen flow, added to a frame or around the selection.
 */
export function addLayout(ed: EditorController, flow: LayoutFlow): void {
  if (!ed.selection.length) return;
  ed.batch(flow === "GRID" ? "Add grid layout" : "Add auto layout", () => {
    const n = ed.selectedNodes();
    const already = n.length === 1 && (n[0] as { stackMode?: string }).stackMode && (n[0] as { stackMode?: string }).stackMode !== "NONE";
    if (!already) ed.engine.command("ADD_AUTO_LAYOUT");
    const frames = ed.selectedNodes();
    for (const f of frames) {
      if (flow === "GRID") ed.engine.setProps([f.guid], fields({ ...(gridDefaults(f as unknown as GridNode, sessionOf(f.guid)) as object), stackWrap: "NO_WRAP" } as never));
      else ed.engine.setProps([f.guid], fields({ stackMode: flow, ...(flow === "VERTICAL" ? { stackWrap: "NO_WRAP" } : {}) }));
    }
  });
}

// ---- File: Duplicate, Save local copy…, Move to folder…, Create branch… ---------------------------------------------

/** The document source's file operations (the store's: docs/data.md §5), when the file lives in the workspace. */
export interface FileOps {
  fileKey: string;
  duplicate(): Promise<{ fileKey: string; name: string }>;
  folders(): Promise<{ id: string | null; name: string }[]>;
  moveTo(folderId: string | null): Promise<void>;
  /** File › Create branch…: a copy named after the branch ("<file> / <branch>") */
  branch(name: string): Promise<{ fileKey: string; name: string }>;
  /** Convert to Social file (social/convert, docs/social.md §18.1): a copy of another kind, named `name`. Optional. */
  duplicateAs?(input: { editorType: "design" | "buzz"; name: string }): Promise<{ fileKey: string; name: string }>;
  /** Convert this file: the file's kind changed (only where `canChangeKind`). Optional. */
  setEditorType?(editorType: "design" | "buzz"): Promise<void>;
  /** False for a file whose kind isn't this computer's to change (an org file: its server's). Optional: absent, it can't. */
  canChangeKind?(): boolean;
  /** Writes another file's UI state (the conversion a Social copy applies when it opens). Optional. */
  setUiStateOf?(fileKey: string, patch: Partial<EditorUiState>): Promise<void>;
}

export function fileOps(ed: EditorController): FileOps | null {
  const ops = (ed.source as { fileOps?: FileOps }).fileOps;
  return ops ?? null;
}

type DesktopBridge = { designer?: { nav?: { openFile?: (fileKey: string) => Promise<unknown> }; files?: { saveLocalCopy?: (fileKey: string, opts?: { partial?: boolean }) => Promise<{ path: string } | { cancelled: true }> } } };
const desktop = () => (window as unknown as DesktopBridge).designer;

/** File › Duplicate is there for a viewer only when the file lets viewers copy and export (docs/governance.md §2.7). */
export function canDuplicateFile(ed: EditorController): boolean {
  return !!fileOps(ed) && exportAllowed(ed);
}

/** File › Duplicate: a copy in Drafts, opened in a new tab (live Figma). */
export async function duplicateFile(ed: EditorController): Promise<void> {
  const ops = fileOps(ed);
  if (!ops || !exportAllowed(ed)) return;
  await ed.source.flush();
  const copy = await ops.duplicate();
  const open = desktop()?.nav?.openFile;
  if (open) await open(copy.fileKey);
  // The web app: the copy in a new browser tab, as Figma's web app opens it
  else if (isWebApp()) window.open(`${location.pathname}?editor&file=${encodeURIComponent(copy.fileKey)}`, "_blank", "noopener");
  else showToast({ message: t("Duplicated as “{name}”", { name: copy.name }) });
}

/** File › Create branch…: the branch's copy, opened in a new tab (the desktop app; else a toast says where it is). */
export async function createBranch(ed: EditorController, name: string): Promise<void> {
  const ops = fileOps(ed);
  if (!ops || !name.trim()) return;
  await ed.source.flush();
  const copy = await ops.branch(name.trim());
  const open = desktop()?.nav?.openFile;
  if (open) await open(copy.fileKey);
  else showToast({ message: t("Created branch “{name}”", { name: copy.name }) });
}

export function canSaveLocalCopy(ed: EditorController): boolean {
  return !!fileOps(ed) && (!!desktop()?.files?.saveLocalCopy || isWebApp()) && exportAllowed(ed);
}

/**
 * File › Save local copy…: the file as a .fig, where the Save dialog says (the desktop app's `files.saveLocalCopy`).
 * A shared file whose images are still coming down waits for them (Figma's flow, atlas 22 §4): "Downloading images…"
 * with Cancel, and — at once when offline, else after 20 s — "Save without images", which saves a partial file.
 */
export async function saveLocalCopy(ed: EditorController): Promise<void> {
  const ops = fileOps(ed);
  const save = desktop()?.files?.saveLocalCopy;
  if (!ops || !exportAllowed(ed)) return;
  // The web app: the .fig goes to the browser's downloads (docs/cloud.md §7)
  if (!save) {
    if (!isWebApp()) return;
    await ed.source.flush();
    await (await import("@/store")).downloadFig(ops.fileKey);
    return;
  }
  await ed.source.flush();
  const images = await waitForImages(ed, ops.fileKey);
  if (images === "cancel") return;
  const r = await save(ops.fileKey, images === "partial" ? { partial: true } : {});
  if ("path" in r) showToast({ message: t("Saved a local copy") });
}

/** Figma's wait before a partial file is offered (`save_as_actions.save_without_images`) */
export const SAVE_PARTIAL_AFTER_MS = 20_000;
const IMAGES_POLL_MS = 1000;

/** Until the file's images are all here: "ready", the user's "Save without images" ("partial"), or "cancel". */
async function waitForImages(ed: EditorController, fileKey: string): Promise<"ready" | "partial" | "cancel"> {
  const files = (await import("@/store")).getStoreClient().files;
  const missing = () => files.missingImages(fileKey).catch(() => 0);
  if (!(await missing())) return "ready";
  const offline = !saveStatusOf(ed).state.online;
  return new Promise((resolve) => {
    let toast = 0;
    let done = false;
    const finish = (r: "ready" | "partial" | "cancel") => {
      if (done) return;
      done = true;
      window.clearInterval(poll);
      window.clearTimeout(offer);
      dismissToast(toast);
      resolve(r);
    };
    const show = (partial: boolean) => {
      if (toast) dismissToast(toast);
      toast = showToast({
        message: offline ? t("Can't download images while offline") : t("Downloading images…"),
        duration: Infinity,
        action: partial ? { label: t("Save without images"), onAction: () => finish("partial") } : { label: t("Cancel"), onAction: () => finish("cancel") },
        onDismiss: () => finish("cancel"),
      });
    };
    show(offline);
    const offer = window.setTimeout(() => show(true), offline ? 0 : SAVE_PARTIAL_AFTER_MS);
    const poll = window.setInterval(() => void missing().then((n) => n === 0 && finish("ready")), IMAGES_POLL_MS);
  });
}
