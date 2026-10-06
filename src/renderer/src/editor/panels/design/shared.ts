/** What the Design panel's sections share: the selection's nodes, field support, kinds. */
import type { Guid, NodeChange, NodeFields } from "@/engine/codec";
import { useSelection } from "@/engine/hooks";
import { useEditor } from "../../controller";
import { supportsField } from "../../engineCompat";
import { useNodes } from "../../hooks";

/** The NodeChange fields the editor writes that the TS facade doesn't type yet (auto layout, effects…). */
export type ExtraFields = {
  stackMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  stackWrap?: "NO_WRAP" | "WRAP";
  stackSpacing?: number;
  stackHorizontalPadding?: number;
  stackVerticalPadding?: number;
  stackPaddingRight?: number;
  stackPaddingBottom?: number;
  stackPrimaryAlignItems?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" | "SPACE_EVENLY" | "SPACE_AROUND";
  stackCounterAlignItems?: "MIN" | "CENTER" | "MAX" | "BASELINE";
  proportionsConstrained?: boolean;
  blendMode?: string;
};

export type PanelNode = NodeChange & ExtraFields;

/** Fields for setProps, including ones the facade's type doesn't list yet. */
export const fields = (f: NodeFields & ExtraFields): NodeFields => f as NodeFields;

/** The selected nodes (re-read when a change touches one), without the missing ones. */
export function useSelectedNodes(): { refs: Guid[]; nodes: PanelNode[] } {
  const ed = useEditor();
  const refs = useSelection(ed.store).refs;
  const nodes = useNodes(refs).filter((n): n is NodeChange => n !== null) as PanelNode[];
  return { refs, nodes };
}

/** Does the engine keep this field (else the control shows disabled)? */
export function useSupports(field: string): boolean {
  return supportsField(useEditor().engine, field);
}

/** The node's type as a string (the facade's NodeType lists only what E1 draws). */
export const typeOf = (n: NodeChange): string => n.type ?? "NONE";
export const isGroupNode = (n: NodeChange) => typeOf(n) === "GROUP" || (typeOf(n) === "FRAME" && n.resizeToFit === true);
export const isFrameNode = (n: NodeChange) => (typeOf(n) === "FRAME" && n.resizeToFit !== true) || ["SECTION", "SYMBOL", "INSTANCE"].includes(typeOf(n));
export const hasCorners = (n: NodeChange) => typeOf(n) === "RECTANGLE" || typeOf(n) === "ROUNDED_RECTANGLE" || isFrameNode(n);

/** The selection's type as Figma's header names it. */
export function typeLabel(nodes: readonly NodeChange[]): string {
  const names = new Set(
    nodes.map((n) => {
      if (isGroupNode(n)) return "Group";
      switch (typeOf(n)) {
        case "FRAME":
          return "Frame";
        case "SECTION":
          return "Section";
        case "ELLIPSE":
          return "Ellipse";
        case "RECTANGLE":
        case "ROUNDED_RECTANGLE":
          return "Rectangle";
        case "TEXT":
          return "Text";
        case "LINE":
          return "Line";
        default:
          return "Layer";
      }
    })
  );
  return names.size === 1 ? [...names][0] : "Mixed";
}
