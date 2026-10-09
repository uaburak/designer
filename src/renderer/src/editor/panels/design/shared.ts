/** What the Design panel's sections share: the selection's nodes, field support, kinds. */
import type { BlendMode, Color, Effect, Guid, NodeChange, NodeFields } from "@/engine/codec";
import { useEffect, useState } from "react";
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
  // Text round: fields the engine keeps as data and applies (per run where Figma allows; null removes)
  hangingList?: boolean;
  listSpacing?: number;
  textWrapStyle?: "AUTO" | "BALANCE" | "PRETTY";
  textDecorationStyle?: "SOLID" | "DOTTED" | "WAVY";
  textDecorationSkipInk?: boolean;
  textDecorationThickness?: NumberValue | null;
  textUnderlineOffset?: NumberValue | null;
  hyperlink?: { url?: string; guid?: { sessionID: number; localID: number }; openInNewTab?: boolean } | null;
  fontVariations?: { axisTag: number; axisName?: string; value: number }[] | null;
  toggledOnOTFeatures?: string[] | null;
  toggledOffOTFeatures?: string[] | null;
  fontVariantCommonLigatures?: boolean | null;
  fontVariantContextualLigatures?: boolean | null;
  fontVariantDiscretionaryLigatures?: boolean | null;
  fontVariantHistoricalLigatures?: boolean | null;
  fontVariantOrdinal?: boolean | null;
  fontVariantSlashedZero?: boolean | null;
  fontVariantNumericFigure?: "NORMAL" | "LINING" | "OLDSTYLE";
  fontVariantNumericSpacing?: "NORMAL" | "PROPORTIONAL" | "TABULAR";
  fontVariantNumericFraction?: "NORMAL" | "DIAGONAL" | "STACKED";
  fontVariantPosition?: "NORMAL" | "SUB" | "SUPER";
  fontVariantCaps?: "NORMAL" | "SMALL" | "ALL_SMALL" | "PETITE" | "ALL_PETITE" | "UNICASE" | "TITLING";
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

/**
 * The Design panel's menus open 12 under their trigger (live boolean-operations-menu, instance-more-actions-menu,
 * component-create-property-menu: 129 / 161 for buttons ending at 117 / 149), or 12 above it when they don't fit
 * (stroke-individual-strokes-menu).
 */
export const PANEL_MENU_GAP = 12;

/** The node's type as a string (its real one: the facade's NodeType lists only what the engine draws). */
export const typeOf = (n: { type?: string }): string => n.type ?? "NONE";
export const isGroupNode = (n: PanelNode) => typeOf(n) === "GROUP" || (typeOf(n) === "FRAME" && n.resizeToFit === true);
export const isFrameNode = (n: PanelNode) => (typeOf(n) === "FRAME" && n.resizeToFit !== true) || ["SECTION", "SYMBOL", "INSTANCE"].includes(typeOf(n));
export const isTextNode = (n: PanelNode) => typeOf(n) === "TEXT";
export const hasCorners = (n: PanelNode) => typeOf(n) === "RECTANGLE" || typeOf(n) === "ROUNDED_RECTANGLE" || isFrameNode(n);
/**
 * A layer inside an instance (its guid is an instance path, "I8:62;8:51"): live Figma (design/nested-instance.txt)
 * keeps its place, turn, flow and proportions — X / Y, Rotation, Rotate 90˚ / Flip, Align, Ignore auto layout, Flow,
 * Wrap and Lock aspect ratio are disabled, its W / H a read-only sizing list.
 */
export const isInstanceSublayer = (n: { guid?: unknown }) => String(n.guid ?? "").startsWith("I");

/** The text layer being edited on the canvas (null when none), re-read on every TEXT_EDIT event. */
export function useTextEditRef(): Guid | null {
  const ed = useEditor();
  const [ref, setRef] = useState<Guid | null>(() => ed.engine.textEdit?.ref ?? null);
  useEffect(() => ed.engine.on("TEXT_EDIT", (e) => setRef(e.active ? e.ref : null)), [ed]);
  return ref;
}

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

/**
 * What Fill and Stroke edit (Figma's live panel: a group shows its layers' fills — "Click + to replace mixed content"
 * when they differ — and a change goes to each of them): the selection with every group replaced by its layers,
 * nested groups too; the selection itself when there's no group in it.
 */
export function usePaintTargets(nodes: readonly PanelNode[]): PanelNode[] {
  const ed = useEditor();
  const ids: Guid[] | null = nodes.some(isGroupNode) ? [] : null;
  if (ids) {
    const expand = (n: NodeChange) => {
      if (!isGroupNode(n as PanelNode)) {
        ids.push(n.guid);
        return;
      }
      const children = (ed.engine.readNodes([n.guid], { childIds: true })[0]?.childIds ?? []) as Guid[];
      for (const c of ed.engine.readNodes(children)) expand(ed.withRealType(c));
    };
    for (const n of nodes) expand(n as NodeChange);
  }
  const read = useNodes(ids ?? []);
  if (!ids) return nodes as PanelNode[];
  return read.filter((n): n is NodeChange => n !== null).map(ed.withRealType) as PanelNode[];
}
