/**
 * Documents the `?editor` route opens without a store: `&doc=reference` is a
 * file matching the owner's reference screenshots of Figma (docs/editor.md,
 * docs/research/visual-diff.md); `&doc=empty` a new file's three nodes;
 * `&doc=types` the Design panel's Phase 2 cases.
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

const solidFill = (rgb: number) => [{ type: "SOLID" as const, color: hex(rgb), opacity: 1, visible: true }];
const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });

/**
 * `&doc=types`: one of each kind the Design panel handles in Phase 2 — an auto-layout frame (Hug, a Fill child,
 * an "Ignore auto layout" child), a plain frame with a pinned child (Constraints), and layers the engine doesn't
 * draw yet but the panels name by type: a vector, a boolean group and a text layer.
 */
export const TYPES_DOCUMENT: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [
    { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
    page("0:1", "Page 1", 0, 0x1e1e1e),
    internalCanvas(),
    { guid: "1:1", phase: "CREATED", type: "FRAME", name: "Auto layout", parentIndex: { guid: "0:1", position: "!" }, size: { x: 320, y: 120 }, transform: at(0, 0), fillPaints: solidFill(0xffffff), stackMode: "HORIZONTAL", stackSpacing: 12, stackHorizontalPadding: 16, stackVerticalPadding: 16, stackPaddingRight: 16, stackPaddingBottom: 16, stackPrimarySizing: "FIXED", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" },
    { guid: "1:2", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Fixed", parentIndex: { guid: "1:1", position: "!" }, size: { x: 64, y: 64 }, transform: at(16, 16), fillPaints: solidFill(0x0d99ff) },
    { guid: "1:3", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Fill", parentIndex: { guid: "1:1", position: '"' }, size: { x: 100, y: 64 }, transform: at(92, 16), fillPaints: solidFill(0x14ae5c), stackChildPrimaryGrow: 1 },
    { guid: "1:4", phase: "CREATED", type: "ELLIPSE", name: "Absolute", parentIndex: { guid: "1:1", position: "#" }, size: { x: 24, y: 24 }, transform: at(284, 8), fillPaints: solidFill(0xf24822), stackPositioning: "ABSOLUTE", horizontalConstraint: "MAX" },
    { guid: "1:10", phase: "CREATED", type: "FRAME", name: "Constraints", parentIndex: { guid: "0:1", position: '"' }, size: { x: 240, y: 160 }, transform: at(380, 0), fillPaints: solidFill(0xffffff) },
    { guid: "1:11", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Pinned", parentIndex: { guid: "1:10", position: "!" }, size: { x: 80, y: 40 }, transform: at(144, 104), fillPaints: solidFill(0xffc700), horizontalConstraint: "STRETCH", verticalConstraint: "MAX" },
    { guid: "1:12", phase: "CREATED", type: "ELLIPSE", name: "Dot", parentIndex: { guid: "1:10", position: '"' }, size: { x: 32, y: 32 }, transform: at(16, 16), fillPaints: solidFill(0x9747ff), horizontalConstraint: "CENTER", verticalConstraint: "SCALE" },
    { guid: "1:20", phase: "CREATED", type: "VECTOR" as never, name: "Vector", parentIndex: { guid: "0:1", position: "#" }, size: { x: 80, y: 60 }, transform: at(0, 200), fillPaints: solidFill(0xd9d9d9) },
    { guid: "1:21", phase: "CREATED", type: "BOOLEAN_OPERATION" as never, booleanOperation: "SUBTRACT", name: "Subtract", parentIndex: { guid: "0:1", position: "$" }, size: { x: 80, y: 80 }, transform: at(120, 200), fillPaints: solidFill(0xd9d9d9) } as NodeChange,
    { guid: "1:22", phase: "CREATED", type: "TEXT" as never, name: "Heading", parentIndex: { guid: "0:1", position: "%" }, size: { x: 120, y: 24 }, transform: at(240, 200), fillPaints: solidFill(0x000000), fontSize: 20, textAutoResize: "WIDTH_AND_HEIGHT" } as NodeChange,
  ],
};
