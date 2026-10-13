// A few builders for the documents the site's live canvases open: NODE_CHANGES messages in the engine's own shape
// (docs/schema.md; the same fields as src/renderer/src/editor/fixtures.ts), so what the visitor edits is a real file.
import type { Color, Matrix, Message, NodeChange, Paint } from "@/engine/codec";

export const hex = (rgb: number, a = 1): Color => ({ r: ((rgb >> 16) & 255) / 255, g: ((rgb >> 8) & 255) / 255, b: (rgb & 255) / 255, a });
export const solid = (rgb: number, opacity = 1): Paint[] => [{ type: "SOLID", color: hex(rgb), opacity, visible: true }];
export const at = (x: number, y: number): Matrix => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
/** Fractional positions, ascending (docs/schema.md §3.5). */
export const position = (i: number) => String.fromCharCode(33 + i);

type Fields = Partial<NodeChange> & Record<string, unknown>;

export class DocBuilder {
  private readonly nodes: NodeChange[] = [];
  private readonly counts = new Map<string, number>();
  private next = 1;

  constructor(pageName: string, background = 0xf5f5f5) {
    this.nodes.push(
      { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
      { guid: "0:1", phase: "CREATED", type: "CANVAS", name: pageName, parentIndex: { guid: "0:0", position: "!" }, backgroundColor: hex(background), backgroundEnabled: true },
      { guid: "0:2", phase: "CREATED", type: "CANVAS", name: "Internal Only Canvas", parentIndex: { guid: "0:0", position: "~" }, internalOnly: true, visible: false },
    );
  }

  /** Adds a node under `parent` (the page: "0:1"), after its earlier children; returns its guid. */
  add(parent: string, type: string, name: string, x: number, y: number, w: number, h: number, fields: Fields = {}): string {
    const guid = `1:${this.next++}`;
    const index = this.counts.get(parent) ?? 0;
    this.counts.set(parent, index + 1);
    this.nodes.push({
      guid,
      phase: "CREATED",
      type: type as NodeChange["type"],
      name,
      parentIndex: { guid: parent, position: position(index) },
      size: { x: w, y: h },
      transform: at(x, y),
      strokeWeight: 1,
      strokeAlign: "INSIDE",
      fillPaints: [],
      ...fields,
    } as NodeChange);
    return guid;
  }

  message(): Message {
    return { type: "NODE_CHANGES", sessionID: 0, nodeChanges: this.nodes };
  }
}

export const radius = (r: number): Fields => ({
  cornerRadius: r,
  rectangleTopLeftCornerRadius: r,
  rectangleTopRightCornerRadius: r,
  rectangleBottomRightCornerRadius: r,
  rectangleBottomLeftCornerRadius: r,
});

/** Auto layout on a frame: direction, gap, padding [vertical, horizontal] or [top, right, bottom, left]. */
export function autoLayout(
  mode: "HORIZONTAL" | "VERTICAL",
  gap: number,
  padding: [number, number] | [number, number, number, number] = [0, 0],
  more: Fields = {},
): Fields {
  const [t, r, b, l] = padding.length === 2 ? [padding[0], padding[1], padding[0], padding[1]] : padding;
  return {
    stackMode: mode,
    stackSpacing: gap,
    stackVerticalPadding: t,
    stackPaddingRight: r,
    stackPaddingBottom: b,
    stackHorizontalPadding: l,
    stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE",
    stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE",
    ...more,
  };
}

export type FontStyle = "Regular" | "Medium" | "Semi Bold" | "Bold";

/** A text layer in Figma's Inter (the engine's bundled face). */
export function textFields(characters: string, size: number, style: FontStyle, color: number, more: Fields = {}): Fields {
  return {
    textData: { characters },
    fontName: { family: "Inter", style, postscript: "" },
    fontSize: size,
    lineHeight: { value: Math.round(size * (size >= 32 ? 1.08 : 1.45)), units: "PIXELS" },
    letterSpacing: { value: size >= 32 ? -3 : size >= 20 ? -1.5 : 0, units: "PERCENT" },
    textAutoResize: "WIDTH_AND_HEIGHT",
    fillPaints: solid(color),
    ...more,
  };
}
