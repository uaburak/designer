/**
 * Find and replace (Figma's: help "Find and replace in Figma"), as plain data: which layers match a query — their
 * name, and a text layer's characters —, the layer-type filters, the settings (Match case, Whole words, Other) and
 * the text a Replace leaves. The engine reads and the panel are editor/find.ts and panels/Find.tsx.
 */

/** A layer as Find reads it. */
export interface FindNode {
  id: string;
  page: string;
  type: string;
  name: string;
  /** A text layer's characters */
  text?: string;
  /** FRAME + resizeToFit, or GROUP */
  group?: boolean;
  /** A component set */
  stateGroup?: boolean;
  /** A visible image or video fill */
  media?: boolean;
  /** The top-level layer it sits in (its name: the result's context) */
  top?: string;
}

/** The layer-type filters (Figma's "search filters for layer type"), in the menu's order. */
export const FIND_FILTERS = [
  { id: "text", label: "Text" },
  { id: "frame", label: "Frame" },
  { id: "component", label: "Component" },
  { id: "instance", label: "Instance" },
  { id: "group", label: "Group" },
  { id: "section", label: "Section" },
  { id: "image", label: "Image" },
  { id: "shape", label: "Shape" },
  { id: "vector", label: "Vector" },
] as const;

export type FindFilter = (typeof FIND_FILTERS)[number]["id"];

const SHAPES = new Set(["RECTANGLE", "ROUNDED_RECTANGLE", "ELLIPSE", "REGULAR_POLYGON", "STAR", "LINE"]);

/** The filter a layer falls under; null: "Other" (slices, widgets, stickies…), found only with Settings › Other. */
export function filterOf(n: Pick<FindNode, "type" | "group" | "stateGroup" | "media">): FindFilter | null {
  switch (n.type) {
    case "TEXT":
      return "text";
    case "FRAME":
      return n.stateGroup ? "component" : n.group ? "group" : "frame";
    case "GROUP":
      return "group";
    case "SYMBOL":
      return "component";
    case "INSTANCE":
      return "instance";
    case "SECTION":
      return "section";
    case "VECTOR":
    case "BOOLEAN_OPERATION":
      return "vector";
    default:
      if (SHAPES.has(n.type)) return n.media ? "image" : "shape";
      return null;
  }
}

export interface FindOptions {
  matchCase?: boolean;
  wholeWords?: boolean;
  /** Settings › Other */
  other?: boolean;
  /** Only these types (empty: all) */
  types?: readonly string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The query as a global regex (Match case, Whole words); null for an empty query. */
export function findPattern(query: string, o: FindOptions = {}): RegExp | null {
  if (!query) return null;
  const body = escape(query);
  return new RegExp(o.wholeWords ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body, o.matchCase ? "gu" : "giu");
}

/** Where the query is in `s` ([start, end) pairs, UTF-16). */
export function matchRanges(s: string, pattern: RegExp | null): [number, number][] {
  if (!pattern || !s) return [];
  const out: [number, number][] = [];
  pattern.lastIndex = 0;
  for (let m = pattern.exec(s); m; m = pattern.exec(s)) {
    if (m[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

export interface FindResult {
  id: string;
  page: string;
  type: string;
  filter: FindFilter | null;
  name: string;
  /** What the row shows: the text that matched (a text layer's characters) or the name */
  label: string;
  /** Where the query is in `label` */
  ranges: [number, number][];
  /** The match is in a text layer's characters (Replace can change it) */
  inText: boolean;
  top?: string;
}

/** The layers matching `query`, in the order given (pages, then the panel's order): text in characters first, else the name. */
export function findLayers(nodes: readonly FindNode[], query: string, o: FindOptions = {}): FindResult[] {
  const pattern = findPattern(query, o);
  if (!pattern) return [];
  const types = o.types?.length ? new Set(o.types) : null;
  const out: FindResult[] = [];
  for (const n of nodes) {
    const filter = filterOf(n);
    if (filter === null && !o.other) continue;
    if (types && (filter === null || !types.has(filter))) continue;
    const inText = n.type === "TEXT" && n.text !== undefined ? matchRanges(n.text, pattern) : [];
    if (inText.length) {
      out.push({ id: n.id, page: n.page, type: n.type, filter, name: n.name, label: n.text!, ranges: inText, inText: true, top: n.top });
      continue;
    }
    const inName = matchRanges(n.name, pattern);
    if (inName.length) out.push({ id: n.id, page: n.page, type: n.type, filter, name: n.name, label: n.name, ranges: inName, inText: false, top: n.top });
  }
  return out;
}

/** A text's characters after replacing every match with `replacement`, and where each replaced run was ([from, to) old, its new length). */
export function replaceText(s: string, query: string, replacement: string, o: FindOptions = {}): { text: string; edits: { from: number; to: number; length: number }[] } {
  const ranges = matchRanges(s, findPattern(query, o));
  if (!ranges.length) return { text: s, edits: [] };
  let text = "";
  let at = 0;
  for (const [from, to] of ranges) {
    text += s.slice(at, from) + replacement;
    at = to;
  }
  text += s.slice(at);
  return { text, edits: ranges.map(([from, to]) => ({ from, to, length: replacement.length })) };
}

/**
 * A text's per-character style ids after the replace edits (`characterStyleIDs`): a replaced run takes the style of
 * its first character, the rest shift with the text. A shorter array (the tail in style 0) stays as short as it can.
 */
export function remapStyleIds(ids: readonly number[] | undefined, edits: readonly { from: number; to: number; length: number }[]): number[] | undefined {
  if (!ids || !ids.length) return ids ? [] : undefined;
  const out: number[] = [];
  let at = 0;
  const id = (i: number) => ids[i] ?? 0;
  for (const e of edits) {
    for (let i = at; i < e.from; i++) out.push(id(i));
    for (let i = 0; i < e.length; i++) out.push(id(e.from));
    at = e.to;
  }
  const total = Math.max(ids.length, at);
  for (let i = at; i < total; i++) out.push(id(i));
  while (out.length && out[out.length - 1] === 0) out.pop();
  return out;
}

/** The next result index for ↑ / ↓ (wrapping), from `at` (−1: none yet). */
export function stepIndex(at: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (at < 0) return dir > 0 ? 0 : count - 1;
  return (at + dir + count) % count;
}
