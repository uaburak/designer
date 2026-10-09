/**
 * Round 10 — the Figma menu's commands that are the editor's own (docs/editor.md "Round 10 — Menus, commands, left side
 * and toolbar"; live menus/main-edit.txt, main-view.txt, main-object.txt, main-file.txt, context-*.txt): Copy /
 * Paste properties (⌥⌘C / ⌥⌘V), Hide other layers, Set as thumbnail / Restore default thumbnail, Find previous / next
 * frame (Home / End), More layout options ▸, and the File menu's Duplicate, Save local copy…, Move to project… where
 * the document source can do them. What live does beyond its menus' labels is from
 * help.figma.com or, where noted, unverified.
 */
import { showToast } from "@/ds";
import type { Guid, NodeChange } from "@/engine/codec";
import type { EditorController } from "./controller";
import { fields } from "./panels/design/shared";
import { gridDefaults, type GridNode } from "./model/grid";

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
  "layoutGrids",
  "exportSettings",
] as const;
const TEXT_PROPERTIES = ["fontName", "fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent", "textAlignHorizontal", "textAlignVertical", "textCase", "textDecoration"] as const;

type Copied = { fields: Record<string, unknown>; text: Record<string, unknown> | null };
const copied = new WeakMap<EditorController, Copied>();

export function canCopyProperties(ed: EditorController): boolean {
  return ed.selection.length === 1;
}

export function copyProperties(ed: EditorController): void {
  const [ref] = ed.selection;
  if (!ref || ed.selection.length !== 1) return;
  const n = ed.engine.readNode(ref, { fields: [...SHAPE_PROPERTIES, ...TEXT_PROPERTIES, "type"] }) as (NodeChange & Record<string, unknown>) | null;
  if (!n) return;
  const pick = (keys: readonly string[]) => Object.fromEntries(keys.filter((k) => n[k] !== undefined).map((k) => [k, n[k]]));
  copied.set(ed, { fields: pick(SHAPE_PROPERTIES), text: n.type === "TEXT" ? pick(TEXT_PROPERTIES) : null });
  showToast({ message: "Properties copied" });
}

export function canPasteProperties(ed: EditorController): boolean {
  return copied.has(ed) && ed.selection.length > 0;
}

/** ⌥⌘V: the copied look onto every selected layer (a text's type settings onto texts only); one undo step. */
export function pasteProperties(ed: EditorController): void {
  const c = copied.get(ed);
  if (!c || !ed.selection.length) return;
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
  showToast({ message: ref ? "Thumbnail set" : "Default thumbnail restored" });
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
  ed.engine.setCamera({ x: canvas.width / 2 - cx * cam.zoom, y: canvas.height / 2 - cy * cam.zoom, zoom: cam.zoom });
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

// ---- File: Duplicate, Save local copy…, Move to project…, Create branch… ---------------------------------------------

/** The document source's file operations (the store's: docs/data.md §5), when the file lives in the workspace. */
export interface FileOps {
  fileKey: string;
  duplicate(): Promise<{ fileKey: string; name: string }>;
  folders(): Promise<{ id: string | null; name: string }[]>;
  moveTo(folderId: string | null): Promise<void>;
  /** File › Create branch…: a copy named after the branch ("<file> / <branch>") */
  branch(name: string): Promise<{ fileKey: string; name: string }>;
}

export function fileOps(ed: EditorController): FileOps | null {
  const ops = (ed.source as { fileOps?: FileOps }).fileOps;
  return ops ?? null;
}

type DesktopBridge = { designer?: { nav?: { openFile?: (fileKey: string) => Promise<unknown> }; files?: { saveLocalCopy?: (fileKey: string) => Promise<{ path: string } | { cancelled: true }> } } };
const desktop = () => (window as unknown as DesktopBridge).designer;

/** File › Duplicate: a copy in Drafts, opened in a new tab (live Figma). */
export async function duplicateFile(ed: EditorController): Promise<void> {
  const ops = fileOps(ed);
  if (!ops) return;
  await ed.source.flush();
  const copy = await ops.duplicate();
  const open = desktop()?.nav?.openFile;
  if (open) await open(copy.fileKey);
  else showToast({ message: `Duplicated as “${copy.name}”` });
}

/** File › Create branch…: the branch's copy, opened in a new tab (the desktop app; else a toast says where it is). */
export async function createBranch(ed: EditorController, name: string): Promise<void> {
  const ops = fileOps(ed);
  if (!ops || !name.trim()) return;
  await ed.source.flush();
  const copy = await ops.branch(name.trim());
  const open = desktop()?.nav?.openFile;
  if (open) await open(copy.fileKey);
  else showToast({ message: `Created branch “${copy.name}”` });
}

export function canSaveLocalCopy(ed: EditorController): boolean {
  return !!fileOps(ed) && !!desktop()?.files?.saveLocalCopy;
}

/** File › Save local copy…: the file as a .fig, where the Save dialog says (the desktop app's `files.saveLocalCopy`). */
export async function saveLocalCopy(ed: EditorController): Promise<void> {
  const ops = fileOps(ed);
  const save = desktop()?.files?.saveLocalCopy;
  if (!ops || !save) return;
  await ed.source.flush();
  const r = await save(ops.fileKey);
  if ("path" in r) showToast({ message: "Saved a local copy" });
}
