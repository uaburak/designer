/**
 * Canvas buttons (ours, not Figma's): a frame on the canvas that works as a button while you design — right-click ›
 * Buttons ▸ adds one; a click on it follows its link, or opens a menu of its links when it has several (each named by
 * where it goes: the outermost frame its layer is on, "/home"). ⌘-click selects it; then the Design panel styles it as
 * any frame (fill, radius, padding, its text) and its Button section edits the links.
 *
 * Stored on the frame as plugin data (`pluginID` "wecra", key "canvasButton", JSON `{ links: [{ link, place? }] }`):
 * it travels with the layer through copy, paste, duplicate, files and multiplayer like any field.
 */
import type { Guid, NodeChange } from "@/engine/codec";
import { createNodes } from "../agents/mcpTools";
import type { EditorController } from "../controller";
import { fileKeyOf, parseLinkTarget, placeName, urlLabel, type LinkTarget } from "./canvasLinks";

export const BUTTON_PLUGIN = "wecra";
export const BUTTON_KEY = "canvasButton";

export interface ButtonLink {
  /** The link as entered: a website, or a layer's link (⌘L "Copy link") */
  link: string;
  /** Where it goes, as it was named when it was added (another file's layer can't be read from here) */
  place?: string;
}

export interface CanvasButton {
  links: ButtonLink[];
}

type PluginEntry = NonNullable<NodeChange["pluginData"]>[number];

/** The button stored on a node, or null when it isn't one. */
export function buttonOf(node: Pick<NodeChange, "pluginData"> | null | undefined): CanvasButton | null {
  const entry = node?.pluginData?.find((e) => e.pluginID === BUTTON_PLUGIN && e.key === BUTTON_KEY);
  if (!entry?.value) return null;
  try {
    const v = JSON.parse(entry.value) as Partial<CanvasButton>;
    const links = Array.isArray(v.links) ? v.links.filter((l): l is ButtonLink => !!l && typeof l.link === "string") : [];
    return { links };
  } catch {
    return { links: [] };
  }
}

export const readButton = (ed: EditorController, id: Guid): CanvasButton | null => (ed.engine.destroyed ? null : buttonOf(ed.engine.readNode(id, { fields: ["pluginData"] })));

/** The innermost button among layers under the pointer (`hits`, innermost first). */
export function buttonAmong(ed: EditorController, hits: readonly Guid[]): Guid | null {
  for (const id of hits) if (readButton(ed, id)) return id;
  return null;
}

/** Writes the button's links (one undo step, `label`; null: inside a write already open), keeping every other plugin's data on the layer. */
export function writeButton(ed: EditorController, id: Guid, button: CanvasButton, label: string | null): void {
  const node = ed.engine.readNode(id, { fields: ["pluginData"] });
  const others = (node?.pluginData ?? []).filter((e) => !(e.pluginID === BUTTON_PLUGIN && e.key === BUTTON_KEY));
  const entry: PluginEntry = { pluginID: BUTTON_PLUGIN, key: BUTTON_KEY, value: JSON.stringify(button) };
  const fields = { pluginData: [...others, entry] } as never;
  if (label === null) ed.engine.setProps([id], fields);
  else ed.setProps([id], fields, label);
}

/** A link's target and its name in the menu: a layer of this file by where it is now, else as it was added. */
export function buttonEntry(ed: EditorController, l: ButtonLink): { target: LinkTarget | null; label: string } {
  const here = fileKeyOf(ed);
  const target = parseLinkTarget(l.link, here);
  if (!target) return { target: null, label: l.link };
  if (target.kind === "url") return { target, label: urlLabel(target.url) };
  const local = !target.fileKey ? placeName(ed, target.nodeId) : null;
  return { target, label: local ?? l.place ?? target.nodeId };
}

/** A link entered in the Button section: kept with its place's name (`place=` in a copied link, or read here). */
export function newButtonLink(ed: EditorController, text: string): ButtonLink | null {
  const here = fileKeyOf(ed);
  const target = parseLinkTarget(text, here);
  if (!target) return null;
  const link = text.trim();
  if (target.kind === "url") return { link: target.url };
  const fromLink = /[?&]place=([^&#]*)/.exec(link);
  const place = (fromLink ? decodeURIComponent(fromLink[1]) : null) || (!target.fileKey ? placeName(ed, target.nodeId) : null);
  return place ? { link, place } : { link };
}

// ---- Adding one: right-click › Buttons ▸ ----------------------------------------------------------------------------

export type ButtonStyle = "primary" | "secondary";

const LINK_ICON = (c: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.6 9.4a2.9 2.9 0 0 0 4.1 0l2.1-2.1a2.9 2.9 0 0 0-4.1-4.1l-.7.7" stroke="${c}" stroke-width="1.4" stroke-linecap="round"/><path d="M9.4 6.6a2.9 2.9 0 0 0-4.1 0L3.2 8.7a2.9 2.9 0 0 0 4.1 4.1l.7-.7" stroke="${c}" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const CHEVRON = (c: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3.5 10.5 8 6 12.5" stroke="${c}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const STYLES: Record<ButtonStyle, { fill: string; text: string }> = {
  primary: { fill: "#1E7CF2", text: "#FFFFFF" },
  secondary: { fill: "#F0F0F0", text: "#1E1E1E" },
};

/**
 * A new button at page point `at` (its top-left), on the page or in the frame under it: "Go to the Used Variant",
 * a link icon, a chevron; auto layout, a pill. Selected; one undo step. Null when the engine refused it.
 */
export function addButton(ed: EditorController, at: { x: number; y: number }, style: ButtonStyle = "primary", parent?: Guid): Guid | null {
  const s = STYLES[style];
  const env = { ed, write: <T,>(_label: string, fn: () => T): T => fn() };
  if (ed.engine.txnBegin("Add button") !== 0) return null;
  let id: Guid | null = null;
  try {
    const r = createNodes(env, {
      ...(parent ? { parentId: parent } : {}),
      nodes: [
        {
          type: "FRAME",
          name: "Go to the Used Variant",
          x: Math.round(at.x),
          y: Math.round(at.y),
          width: 278,
          fills: [s.fill],
          cornerRadius: 999,
          layoutMode: "HORIZONTAL",
          counterAxisAlignItems: "CENTER",
          itemSpacing: 8,
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 14,
          paddingBottom: 14,
          layoutSizingHorizontal: "FIXED",
          layoutSizingVertical: "HUG",
          children: [
            { svg: LINK_ICON(s.text), name: "Link icon" },
            { type: "TEXT", name: "Label", characters: "Go to the Used Variant", fontFamily: "Inter", fontStyle: "Semi Bold", fontSize: 14, fills: [s.text], layoutGrow: 1, textAutoResize: "HEIGHT" },
            { svg: CHEVRON(s.text), name: "Chevron" },
          ],
        },
      ],
    });
    id = r.touched?.[0] ?? null;
    if (id) {
      // Its height hugs the label once the label has its width: laid out again now (made, the label was measured at
      // its first width, a letter wide, and the pill came out that tall).
      ed.engine.setProps([id], { stackCounterSizing: "FIXED" } as never);
      ed.engine.setProps([id], { stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" } as never);
      writeButton(ed, id, { links: [] }, null);
    }
    ed.engine.txnCommit();
  } catch (e) {
    ed.engine.txnCancel();
    throw e;
  }
  if (id) ed.engine.setSelection([id]);
  return id;
}
