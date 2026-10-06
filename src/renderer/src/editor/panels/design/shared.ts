/** What the Design panel's sections share: the selection's nodes, field support, kinds. */
import type { BlendMode, Color, Effect, Guid, NodeChange, NodeFields } from "@/engine/codec";
import { useSelection } from "@/engine/hooks";
import { useEditor } from "../../controller";
import { keepsField, supportsField } from "../../engineCompat";
import { useNodes } from "../../hooks";

export type BlendModeName = BlendMode;
export type { Effect };

/** schema/document.kiwi `LayoutGrid` ("Layout guide"). */
export interface LayoutGrid {
  type?: "MIN" | "CENTER" | "STRETCH" | "MAX";
  axis?: "X" | "Y";
  visible?: boolean;
  numSections?: number;
  offset?: number;
  sectionSize?: number;
  gutterSize?: number;
  color?: Color;
  pattern?: "STRIPES" | "GRID";
  [other: string]: unknown;
}

/** Text (schema/document.kiwi's names): Number = { value, units }. */
export interface NumberValue {
  value: number;
  units: "RAW" | "PIXELS" | "PERCENT";
}
export interface FontName {
  family: string;
  style: string;
  postscript?: string;
}

/** The NodeChange fields the editor reads or writes that the TS facade doesn't type yet (effects, text…). */
export type ExtraFields = {
  // Kept by the engine as it came (not typed by the facade yet)
  layoutGrids?: LayoutGrid[];
  // Text (E3)
  fontName?: FontName;
  fontSize?: number;
  lineHeight?: NumberValue;
  letterSpacing?: NumberValue;
  paragraphSpacing?: number;
  paragraphIndent?: number;
  textAlignHorizontal?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  textAlignVertical?: "TOP" | "CENTER" | "BOTTOM";
  textAutoResize?: "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT";
  textTruncation?: "DISABLED" | "ENDING";
  maxLines?: number;
  textCase?: "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED";
  textDecoration?: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
  leadingTrim?: "NONE" | "CAP_HEIGHT";
  hangingPunctuation?: boolean;
};

/** A selected node as the panel reads it: its real type (controller.withRealType) and every field. */
export type PanelNode = Omit<NodeChange, "type"> & ExtraFields & { type?: string };

/** Fields for setProps, including ones the facade's type doesn't list yet. */
export const fields = (f: Omit<NodeFields, "type"> & ExtraFields): NodeFields => f as NodeFields;

/** The selected nodes (re-read when a change touches one), without the missing ones, with their real types. */
export function useSelectedNodes(): { refs: Guid[]; nodes: PanelNode[] } {
  const ed = useEditor();
  const refs = useSelection(ed.store).refs;
  const nodes = useNodes(refs)
    .filter((n): n is NodeChange => n !== null)
    .map(ed.withRealType) as PanelNode[];
  return { refs, nodes };
}

/** Each node's parent (null on the page or when missing), re-read when a change touches one. */
export function useParents(nodes: readonly PanelNode[]): (PanelNode | null)[] {
  const ed = useEditor();
  const ids = nodes.map((n) => n.parentIndex?.guid ?? "");
  const read = useNodes(ids.filter(Boolean));
  const byId = new Map(read.filter((n): n is NodeChange => n !== null).map((n) => [n.guid, ed.withRealType(n) as PanelNode]));
  return ids.map((id) => {
    const p = byId.get(id);
    return p && p.type !== "CANVAS" && p.type !== "DOCUMENT" ? p : null;
  });
}

/** Does the engine keep this field (else the control shows disabled)? */
export function useSupports(field: string): boolean {
  return supportsField(useEditor().engine, field);
}

/** Does the engine keep this field (typed, or round-tripped since E3)? Controls for E4/E5 fields gate on it. */
export function useKeeps(field: string): boolean {
  return keepsField(useEditor().engine, field);
}

/** The node's type as a string (its real one: the facade's NodeType lists only what the engine draws). */
export const typeOf = (n: { type?: string }): string => n.type ?? "NONE";
export const isGroupNode = (n: PanelNode) => typeOf(n) === "GROUP" || (typeOf(n) === "FRAME" && n.resizeToFit === true);
export const isFrameNode = (n: PanelNode) => (typeOf(n) === "FRAME" && n.resizeToFit !== true) || ["SECTION", "SYMBOL", "INSTANCE"].includes(typeOf(n));
export const isTextNode = (n: PanelNode) => typeOf(n) === "TEXT";
export const hasCorners = (n: PanelNode) => typeOf(n) === "RECTANGLE" || typeOf(n) === "ROUNDED_RECTANGLE" || isFrameNode(n);

const BOOLEAN_LABEL: Record<string, string> = { UNION: "Union", SUBTRACT: "Subtract", INTERSECT: "Intersect", XOR: "Exclude" };

/** One layer's type as Figma's Design panel header names it. */
export function nodeTypeLabel(n: PanelNode): string {
  if (isGroupNode(n)) return "Group";
  switch (typeOf(n)) {
    case "FRAME":
      return "Frame";
    case "SECTION":
      return "Section";
    case "SYMBOL":
      return "Component";
    case "INSTANCE":
      return "Instance";
    case "ELLIPSE":
      return "Ellipse";
    case "RECTANGLE":
    case "ROUNDED_RECTANGLE":
      return "Rectangle";
    case "TEXT":
      return "Text";
    case "LINE":
      return "Line";
    case "VECTOR":
      return "Vector path";
    case "STAR":
      return "Star";
    case "REGULAR_POLYGON":
      return "Polygon";
    case "BOOLEAN_OPERATION":
      return BOOLEAN_LABEL[n.booleanOperation ?? "UNION"] ?? "Boolean";
    case "SLICE":
      return "Slice";
    default:
      return "Layer";
  }
}

/** The selection's type as Figma's header names it ("Mixed" for several kinds). */
export function typeLabel(nodes: readonly PanelNode[]): string {
  const names = new Set(nodes.map(nodeTypeLabel));
  return names.size === 1 ? [...names][0] : "Mixed";
}
