/**
 * Local styles as plain data (docs/schema.md §6.5, R3-38…42): style nodes
 * under the internal canvas (`styleType` FILL / TEXT / EFFECT / GRID, a
 * slash name = folders, `sortPosition`), how a layer references one
 * (`styleIdForFill`, `styleIdForStrokeFill`, `styleIdForText`,
 * `styleIdForEffect`, `styleIdForGrid`) and which of its fields the style
 * supplies (the resolved copy that stays when the style is detached).
 */
import type { Effect, Guid, NodeChange, Paint } from "@/engine/codec";
import { guidStr, guidVal, type GuidValue } from "./components";

export type StyleKind = "TEXT" | "FILL" | "EFFECT" | "GRID";
/** The Styles list's order (UI3): Text, Color, Effect, Layout guide. */
export const STYLE_KINDS: readonly StyleKind[] = ["TEXT", "FILL", "EFFECT", "GRID"];
export const STYLE_KIND_LABEL: Record<StyleKind, string> = { TEXT: "Text styles", FILL: "Color styles", EFFECT: "Effect styles", GRID: "Layout guide styles" };
export const STYLE_KIND_SINGULAR: Record<StyleKind, string> = { TEXT: "Text style", FILL: "Color style", EFFECT: "Effect style", GRID: "Layout guide style" };
/** The node type a style of each kind is stored as (Figma's). */
export const STYLE_NODE_TYPE: Record<StyleKind, string> = { TEXT: "TEXT", FILL: "ROUNDED_RECTANGLE", EFFECT: "ROUNDED_RECTANGLE", GRID: "ROUNDED_RECTANGLE" };

/** The text-style fields (docs/schema.md §6.5: never fills, alignment, resizing or truncation). */
export const TEXT_STYLE_FIELDS = [
  "fontName",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "paragraphSpacing",
  "paragraphIndent",
  "listSpacing",
  "textCase",
  "textDecoration",
  "textDecorationStyle",
  "leadingTrim",
  "hangingPunctuation",
  "hangingList",
  "fontVariations",
  "toggledOnOTFeatures",
  "toggledOffOTFeatures",
  "semanticWeight",
  "semanticItalic",
] as const;

/** Where a layer uses a style: the reference field, the style's kind, and the fields it supplies. */
export type StyleSlot = "fill" | "stroke" | "text" | "effect" | "grid";
export const STYLE_SLOT: Record<StyleSlot, { kind: StyleKind; ref: string; fields: readonly string[] }> = {
  fill: { kind: "FILL", ref: "styleIdForFill", fields: ["fillPaints"] },
  stroke: { kind: "FILL", ref: "styleIdForStrokeFill", fields: ["strokePaints"] },
  text: { kind: "TEXT", ref: "styleIdForText", fields: TEXT_STYLE_FIELDS },
  effect: { kind: "EFFECT", ref: "styleIdForEffect", fields: ["effects"] },
  grid: { kind: "GRID", ref: "styleIdForGrid", fields: ["layoutGrids"] },
};

export interface StyleNode {
  guid: Guid;
  type?: string;
  name?: string;
  styleType?: string;
  description?: string;
  sortPosition?: string;
  isPublishable?: boolean;
  fillPaints?: Paint[];
  effects?: Effect[];
  layoutGrids?: unknown[];
  fontName?: { family: string; style: string; postscript?: string };
  fontSize?: number;
  lineHeight?: { value: number; units: "RAW" | "PIXELS" | "PERCENT" };
  letterSpacing?: { value: number; units: "RAW" | "PIXELS" | "PERCENT" };
  [other: string]: unknown;
}

export interface Style {
  id: Guid;
  kind: StyleKind;
  name: string;
  description: string;
  sortPosition: string;
  hidden: boolean;
  node: StyleNode;
}

export const isStyleNode = (n: { styleType?: unknown } | null | undefined): boolean => typeof n?.styleType === "string" && n.styleType !== "NONE" && (STYLE_KINDS as readonly string[]).includes(n.styleType);

export function readStyle(n: StyleNode): Style {
  const name = n.name ?? "";
  return {
    id: n.guid,
    kind: n.styleType as StyleKind,
    name,
    description: n.description ?? "",
    sortPosition: n.sortPosition ?? "",
    hidden: n.isPublishable === false || name.startsWith("_") || name.startsWith("."),
    node: n,
  };
}

type RefNode = Partial<NodeChange> & Record<string, unknown>;

/** The style a layer uses in `slot` (null: none). */
export function styleIdOf(n: RefNode | null | undefined, slot: StyleSlot): Guid | null {
  const ref = n?.[STYLE_SLOT[slot].ref] as { guid?: GuidValue } | undefined;
  return ref?.guid ? guidStr(ref.guid) : null;
}

/** The style's fields as `slot` takes them (a color style's paints go to `strokePaints` for a stroke). */
export function styleContent(style: Pick<Style, "node" | "kind">, slot: StyleSlot): Record<string, unknown> {
  const n = style.node;
  switch (slot) {
    case "fill":
      return { fillPaints: n.fillPaints ?? [] };
    case "stroke":
      return { strokePaints: n.fillPaints ?? [] };
    case "effect":
      return { effects: n.effects ?? [] };
    case "grid":
      return { layoutGrids: n.layoutGrids ?? [] };
    case "text": {
      const out: Record<string, unknown> = {};
      for (const f of TEXT_STYLE_FIELDS) if (n[f] !== undefined) out[f] = n[f];
      return out;
    }
  }
}

/** Applying a style: the reference and the style's fields (one write). */
export function applyStyleFields(style: Pick<Style, "id" | "node" | "kind">, slot: StyleSlot): Record<string, unknown> {
  return { [STYLE_SLOT[slot].ref]: { guid: guidVal(style.id) }, ...styleContent(style, slot) };
}

/** Kiwi field ids of the reference fields (`clearedFields` resets them to absent). */
export const STYLE_REF_FIELD_ID: Record<StyleSlot, number> = { fill: 332, stroke: 333, text: 334, effect: 335, grid: 336 };

/** The fields a new style of `kind` takes from a layer (its current look), else Figma's defaults. */
export function styleFieldsFrom(kind: StyleKind, n: RefNode | null): Record<string, unknown> {
  switch (kind) {
    case "FILL":
      return { fillPaints: (n?.fillPaints as Paint[] | undefined)?.length ? n!.fillPaints : [{ type: "SOLID", color: { r: 217 / 255, g: 217 / 255, b: 217 / 255, a: 1 }, opacity: 1, visible: true }] };
    case "EFFECT":
      return { effects: (n?.effects as Effect[] | undefined)?.length ? n!.effects : [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 4, spread: 0, visible: true, blendMode: "NORMAL", showShadowBehindNode: false }] };
    case "GRID":
      return { layoutGrids: (n?.layoutGrids as unknown[] | undefined)?.length ? n!.layoutGrids : [{ pattern: "GRID", sectionSize: 10, visible: true, color: { r: 1, g: 0, b: 0, a: 0.1 } }] };
    case "TEXT": {
      const out: Record<string, unknown> = { fontName: { family: "Inter", style: "Regular", postscript: "" }, fontSize: 12, lineHeight: { value: 100, units: "PERCENT" }, letterSpacing: { value: 0, units: "PERCENT" } };
      if (n) for (const f of TEXT_STYLE_FIELDS) if (n[f] !== undefined) out[f] = n[f];
      return { ...out, textData: { characters: "Ag" } };
    }
  }
}

/** "Heading · 24/Auto" — a text style's size / line height as the list shows them. */
export function textStyleSummary(n: StyleNode): string {
  const size = n.fontSize ?? 12;
  const lh = n.lineHeight;
  const line = !lh || (lh.units === "PERCENT" && lh.value === 100) ? "Auto" : lh.units === "PIXELS" ? String(Math.round(lh.value * 100) / 100) : `${Math.round(lh.value * (lh.units === "RAW" ? 100 : 1))}%`;
  return `${Math.round(size * 100) / 100}/${line}`;
}

/** A style's name without its folders ("Brand/Primary" → "Primary"). */
export const styleLeaf = (name: string) => name.slice(name.lastIndexOf("/") + 1);
