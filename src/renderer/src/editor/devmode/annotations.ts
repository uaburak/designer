/**
 * Dev Mode's annotations as the document keeps them (docs/research/figma/R9-dev-mode.md "Round 6"; schema
 * `Annotation {label, properties, labelV2, categoryId}` on a layer, `AnnotationCategories {version, items}` on the
 * DOCUMENT): pure reads and writes for the editor's note editor and categories dialog, and the markdown the engine draws
 * (its twin is engine/src/editor/Annotations.cpp `markdownLines`).
 */
import type { Guid } from "@/engine/codec";

/** Figma's AnnotationPropertyType, in the schema's order. */
export const PROPERTY_TYPES = [
  "FILL", "STROKE", "WIDTH", "HEIGHT", "MIN_WIDTH", "MIN_HEIGHT", "MAX_WIDTH", "MAX_HEIGHT", "STROKE_WIDTH", "CORNER_RADIUS", "EFFECT",
  "TEXT_STYLE", "TEXT_ALIGN_HORIZONTAL", "FONT_FAMILY", "FONT_SIZE", "FONT_WEIGHT", "LINE_HEIGHT", "LETTER_SPACING", "STACK_SPACING",
  "STACK_PADDING", "STACK_MODE", "STACK_ALIGNMENT", "OPACITY", "COMPONENT", "FONT_STYLE", "GRID_ROW_GAP", "GRID_COLUMN_GAP",
  "GRID_ROW_COUNT", "GRID_COLUMN_COUNT", "GRID_ROW_ANCHOR_INDEX", "GRID_COLUMN_ANCHOR_INDEX", "GRID_ROW_SPAN", "GRID_COLUMN_SPAN",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/** A pinned property's name in the "+ Property" menu and on the label (the engine's propertyLabel says the same). */
export const PROPERTY_LABEL: Record<PropertyType, string> = {
  FILL: "Fill",
  STROKE: "Stroke",
  WIDTH: "Width",
  HEIGHT: "Height",
  MIN_WIDTH: "Min width",
  MIN_HEIGHT: "Min height",
  MAX_WIDTH: "Max width",
  MAX_HEIGHT: "Max height",
  STROKE_WIDTH: "Stroke weight",
  CORNER_RADIUS: "Corner radius",
  EFFECT: "Effects",
  TEXT_STYLE: "Text style",
  TEXT_ALIGN_HORIZONTAL: "Text align",
  FONT_FAMILY: "Font family",
  FONT_SIZE: "Font size",
  FONT_WEIGHT: "Font weight",
  LINE_HEIGHT: "Line height",
  LETTER_SPACING: "Letter spacing",
  STACK_SPACING: "Gap",
  STACK_PADDING: "Padding",
  STACK_MODE: "Layout",
  STACK_ALIGNMENT: "Alignment",
  OPACITY: "Opacity",
  COMPONENT: "Main component",
  FONT_STYLE: "Font style",
  GRID_ROW_GAP: "Row gap",
  GRID_COLUMN_GAP: "Column gap",
  GRID_ROW_COUNT: "Rows",
  GRID_COLUMN_COUNT: "Columns",
  GRID_ROW_ANCHOR_INDEX: "Row",
  GRID_COLUMN_ANCHOR_INDEX: "Column",
  GRID_ROW_SPAN: "Row span",
  GRID_COLUMN_SPAN: "Column span",
};

/** What "+ Property" needs to know about the layer. */
export interface PropertyTarget {
  type?: string;
  stackMode?: string;
  /** The parent's auto layout (a grid item gets its cell fields) */
  parentStackMode?: string | null;
  resizeToFit?: boolean;
}

/**
 * The properties "+ Property" offers for a layer (which ones Figma offers per layer type is unverified: R9 "Round 6").
 * Groups: size, then what the layer type has — typography for text, auto layout for auto-layout frames, the grid's own
 * fields and a grid item's cell, the main component of an instance — then paints, effects and opacity.
 */
export function propertiesFor(t: PropertyTarget): PropertyType[] {
  const out: PropertyType[] = ["WIDTH", "HEIGHT"];
  const frameLike = t.type === "FRAME" || t.type === "SYMBOL" || t.type === "INSTANCE";
  const auto = frameLike && !!t.stackMode && t.stackMode !== "NONE";
  if (auto || (t.parentStackMode && t.parentStackMode !== "NONE")) out.push("MIN_WIDTH", "MAX_WIDTH", "MIN_HEIGHT", "MAX_HEIGHT");
  if (t.type === "TEXT") out.push("TEXT_STYLE", "FONT_FAMILY", "FONT_STYLE", "FONT_SIZE", "FONT_WEIGHT", "LINE_HEIGHT", "LETTER_SPACING", "TEXT_ALIGN_HORIZONTAL");
  if (auto && t.stackMode !== "GRID") out.push("STACK_MODE", "STACK_SPACING", "STACK_PADDING", "STACK_ALIGNMENT");
  if (auto && t.stackMode === "GRID") out.push("STACK_MODE", "STACK_PADDING", "GRID_ROW_COUNT", "GRID_COLUMN_COUNT", "GRID_ROW_GAP", "GRID_COLUMN_GAP");
  if (t.parentStackMode === "GRID") out.push("GRID_ROW_ANCHOR_INDEX", "GRID_COLUMN_ANCHOR_INDEX", "GRID_ROW_SPAN", "GRID_COLUMN_SPAN");
  if (t.type === "INSTANCE") out.push("COMPONENT");
  out.push("FILL", "STROKE", "STROKE_WIDTH");
  if (t.type !== "TEXT" && t.type !== "LINE" && !t.resizeToFit) out.push("CORNER_RADIUS");
  out.push("EFFECT", "OPACITY");
  return out;
}

// ---- Notes ----------------------------------------------------------------------------------------------------------

type GuidJson = { sessionID: number; localID: number };

/** An annotation as the engine's JSON reads give it (`annotations` of a node). */
export interface AnnotationData {
  label?: string;
  labelV2?: string;
  properties?: { type?: string | number }[];
  categoryId?: GuidJson | Guid | null;
}

export interface Note {
  /** The note's text as markdown */
  markdown: string;
  properties: PropertyType[];
  categoryId: Guid | null;
}

export const guidOf = (g: GuidJson | Guid | null | undefined): Guid | null =>
  !g ? null : typeof g === "string" ? g : `${g.sessionID}:${g.localID}`;
export const guidJson = (g: Guid): GuidJson => {
  const [s, l] = g.split(":").map(Number);
  return { sessionID: s >>> 0, localID: l >>> 0 };
};

/** HTML (older files keep notes as rich text HTML) reduced to markdown-free text. */
export function htmlToText(html: string): string {
  if (!html.includes("<")) return html;
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/\s*(p|div|li|h\d)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function notesOf(node: { annotations?: AnnotationData[] | null } | null | undefined): Note[] {
  return (node?.annotations ?? []).map((a) => ({
    markdown: a.labelV2 || htmlToText(a.label ?? ""),
    properties: (a.properties ?? []).map((p) => p.type).filter((t): t is PropertyType => typeof t === "string" && (PROPERTY_TYPES as readonly string[]).includes(t)),
    categoryId: guidOf(a.categoryId ?? null),
  }));
}

/** The `annotations` field for a layer's notes (null: none, the field removed): markdown in labelV2, plain text in label. */
export function encodeNotes(notes: readonly Note[]): AnnotationData[] | null {
  const kept = notes.filter((n) => n.markdown.trim() || n.properties.length);
  if (!kept.length) return null;
  return kept.map((n) => ({
    label: markdownPlain(n.markdown),
    labelV2: n.markdown,
    properties: n.properties.map((type) => ({ type })),
    ...(n.categoryId ? { categoryId: guidJson(n.categoryId) } : {}),
  }));
}

// ---- Markdown (the plugin API's labelMarkdown: paragraphs, - / * / 1. lists, ## headings, **bold**, _italic_, ~~, links, code) ----

export interface Line {
  text: string;
  heading: boolean;
  bullet: boolean;
  number: number;
}

function inlinePlain(s: string): string {
  return s
    .replace(/\\(.)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2");
}

/** Markdown as the canvas shows it: one line per paragraph, list item or heading; inline markers removed. */
export function markdownLines(markdown: string): Line[] {
  const out: Line[] = [];
  let code = false;
  for (const raw of markdown.split("\n")) {
    const t = raw.trim();
    if (t.startsWith("```")) {
      code = !code;
      continue;
    }
    if (!t) continue;
    if (code) out.push({ text: t, heading: false, bullet: false, number: 0 });
    else if (t.startsWith("#")) out.push({ text: inlinePlain(t.replace(/^#+/, "").trim()), heading: true, bullet: false, number: 0 });
    else if (/^[-*+] /.test(t)) out.push({ text: inlinePlain(t.slice(2).trim()), heading: false, bullet: true, number: 0 });
    else {
      const m = /^(\d+)[.)] (.*)$/.exec(t);
      if (m) out.push({ text: inlinePlain(m[2].trim()), heading: false, bullet: false, number: Number(m[1]) });
      else out.push({ text: inlinePlain(t), heading: false, bullet: false, number: 0 });
    }
  }
  return out;
}

/** The note as plain text (bullets as •, numbers kept). */
export function markdownPlain(markdown: string): string {
  return markdownLines(markdown)
    .map((l) => (l.bullet ? `• ${l.text}` : l.number ? `${l.number}. ${l.text}` : l.text))
    .join("\n");
}

// ---- Categories ---------------------------------------------------------------------------------------------------

/** AnnotationCategoryColor, as the category editor lists them (the API's names). */
export const CATEGORY_COLORS = ["YELLOW", "ORANGE", "RED", "PINK", "VIOLET", "BLUE", "TEAL", "GREEN"] as const;
export type CategoryColor = (typeof CATEGORY_COLORS)[number];
export const CATEGORY_COLOR_LABEL: Record<CategoryColor, string> = {
  YELLOW: "Yellow",
  ORANGE: "Orange",
  RED: "Red",
  PINK: "Pink",
  VIOLET: "Violet",
  BLUE: "Blue",
  TEAL: "Teal",
  GREEN: "Green",
};
/** The canvas's colours for them (engine/src/editor/Annotations.cpp categoryColor; unverified hexes). */
export const CATEGORY_HEX: Record<CategoryColor, string> = {
  YELLOW: "#FFC21A",
  ORANGE: "#FF8C1A",
  RED: "#F24822",
  PINK: "#FF24BD",
  VIOLET: "#9747FF",
  BLUE: "#0D99FF",
  TEAL: "#00B5A3",
  GREEN: "#14AE5C",
};
export type Preset = "DEVELOPMENT" | "INTERACTION" | "ACCESSIBILITY" | "CONTENT" | "BEHAVIOR";
export const PRESET_LABEL: Record<Preset, string> = {
  DEVELOPMENT: "Development",
  INTERACTION: "Interaction",
  ACCESSIBILITY: "Accessibility",
  CONTENT: "Content",
  BEHAVIOR: "Behavior",
};
/** A preset's colour (Figma's files store presets without one; unverified). */
export const PRESET_COLOR: Record<Preset, CategoryColor> = {
  DEVELOPMENT: "BLUE",
  INTERACTION: "VIOLET",
  ACCESSIBILITY: "GREEN",
  CONTENT: "ORANGE",
  BEHAVIOR: "TEAL",
};
/** The order Figma's files list the presets in (FILE: the owner's file, R9). */
export const DEFAULT_PRESETS: Preset[] = ["DEVELOPMENT", "INTERACTION", "ACCESSIBILITY", "CONTENT"];

export interface Category {
  /** null: one of Figma's presets not yet written to the file */
  id: Guid | null;
  preset: Preset | null;
  label: string;
  color: CategoryColor;
  /** A preset whose label or colour was edited keeps its preset and gets `custom` */
  custom: boolean;
}

interface CategoryJson {
  id?: GuidJson | Guid;
  preset?: string;
  custom?: { color?: string; label?: string };
}

export interface CategoriesJson {
  version?: number;
  items?: CategoryJson[];
}

const isPreset = (p: unknown): p is Preset => typeof p === "string" && p in PRESET_LABEL;
const isColor = (c: unknown): c is CategoryColor => typeof c === "string" && (CATEGORY_COLORS as readonly string[]).includes(c);

/** The file's categories (the DOCUMENT's annotationCategories), else Figma's four presets (ids null until written). */
export function categoriesOf(json: CategoriesJson | null | undefined): Category[] {
  if (!json?.items) return DEFAULT_PRESETS.map((p) => ({ id: null, preset: p, label: PRESET_LABEL[p], color: PRESET_COLOR[p], custom: false }));
  return json.items.map((it) => {
    const preset = isPreset(it.preset) ? it.preset : null;
    const label = it.custom?.label || (preset ? PRESET_LABEL[preset] : "Untitled");
    const color = isColor(it.custom?.color) ? it.custom!.color : preset ? PRESET_COLOR[preset] : "GREEN";
    return { id: guidOf(it.id ?? null), preset, label, color, custom: !!it.custom };
  });
}

/** The field to write: every category with an id (`newId` gives the missing ones theirs). */
export function encodeCategories(list: readonly Category[], newId: () => Guid): { list: Category[]; json: CategoriesJson } {
  const withIds = list.map((c) => (c.id ? c : { ...c, id: newId() }));
  return {
    list: withIds,
    json: {
      version: 3,
      items: withIds.map((c) => {
        const presetUnchanged = c.preset && !c.custom && c.label === PRESET_LABEL[c.preset] && c.color === PRESET_COLOR[c.preset];
        return {
          id: guidJson(c.id!),
          preset: c.preset ?? "NONE",
          ...(presetUnchanged ? {} : { custom: { color: c.color, label: c.label } }),
        };
      }),
    },
  };
}
