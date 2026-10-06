/**
 * Documents the `?editor` route opens without a store: `&doc=reference` is a
 * file matching the owner's reference screenshots of Figma (docs/editor.md,
 * docs/research/visual-diff.md); `&doc=empty` a new file's three nodes.
 */
import type { Color, Message, NodeChange } from "@/engine/codec";

const hex = (rgb: number, a = 1): Color => ({ r: ((rgb >> 16) & 255) / 255, g: ((rgb >> 8) & 255) / 255, b: (rgb & 255) / 255, a });

/** Fractional positions, ascending (docs/schema.md §3.5: base-95 strings). */
const position = (i: number) => String.fromCharCode(33 + i);

function page(guid: string, name: string, i: number, background = 0xf5f5f5): NodeChange {
  return { guid, phase: "CREATED", type: "CANVAS", name, parentIndex: { guid: "0:0", position: position(i) }, backgroundColor: hex(background), backgroundEnabled: true };
}

const internalCanvas = (): NodeChange => ({ guid: "0:2", phase: "CREATED", type: "CANVAS", name: "Internal Only Canvas", parentIndex: { guid: "0:0", position: "~" }, internalOnly: true, visible: false });

/** A new design file: the document, "Page 1", the internal canvas. */
export const EMPTY_DOCUMENT: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [{ guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" }, page("0:1", "Page 1", 0), internalCanvas()],
};

/** The pages of the owner's file "burakkoc" (screenshot 1). */
export const REFERENCE_PAGES = ["Page 10", "New Page", "burakkoc.net ( new )", "OXTV", "Page 7", "theStudio", "CV", "Logolar"];

/** File "burakkoc" in Drafts: eight pages, the first one #232323 with "Frame 1" (437 × 305 at −34, 3, white). */
export const REFERENCE_DOCUMENT: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [
    { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
    ...REFERENCE_PAGES.map((name, i) => page(i === 0 ? "0:1" : `0:${i + 2}`, name, i, i === 0 ? 0x232323 : 0xf5f5f5)),
    internalCanvas(),
    {
      guid: "1:1",
      phase: "CREATED",
      type: "FRAME",
      name: "Frame 1",
      parentIndex: { guid: "0:1", position: "!" },
      size: { x: 437, y: 305 },
      transform: { m00: 1, m01: 0, m02: -34, m10: 0, m11: 1, m12: 3 },
      fillPaints: [{ type: "SOLID", color: hex(0xffffff), opacity: 1, visible: true }],
      strokeWeight: 1,
      strokeAlign: "INSIDE",
    },
  ],
};
