/**
 * Text styles as the Typography section and the Text menu read them (docs/engine-build.md "Text round"): the
 * engine's range summary per text (the edited selection, else the whole text), merged over the selected layers;
 * fields whose runs or layers differ are "Mixed". Plus Figma's weight steps for ⌘B / ⌘I, OpenType tags as the
 * schema names them, and variable axis values as fontVariations.
 */
import type { Guid } from "@/engine/codec";
import type { TextRangeStyle } from "@/engine/codec";

export interface TextSummary {
  /** The value shared by every run and layer (the first one's where they differ). */
  values: Record<string, unknown>;
  /** Fields whose values differ. */
  mixed: ReadonlySet<string>;
}

interface RangeReader {
  textRangeStyle?: (ref: Guid) => TextRangeStyle | null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Merges each text's range summary: a field differing between them, or mixed in one, is mixed. */
export function mergeRangeStyles(styles: readonly TextRangeStyle[]): TextSummary {
  const values: Record<string, unknown> = {};
  const mixed = new Set<string>();
  styles.forEach((s, i) => {
    for (const k of s.mixed) mixed.add(k);
    for (const [k, v] of Object.entries(s.values)) {
      if (i === 0) values[k] = v;
      else if (!same(values[k], v)) mixed.add(k);
    }
  });
  return { values, mixed };
}

/** The selected texts' summary (null when the engine can't read ranges, or nothing is a text). */
export function textSummary(engine: RangeReader, refs: readonly Guid[]): TextSummary | null {
  if (typeof engine.textRangeStyle !== "function") return null;
  const styles = refs.map((r) => engine.textRangeStyle!(r)).filter((s): s is TextRangeStyle => !!s);
  return styles.length ? mergeRangeStyles(styles) : null;
}

/** Figma's weight names (100–900), as a style is named for them. */
export const WEIGHTS: readonly [number, string][] = [
  [100, "Thin"],
  [200, "Extra Light"],
  [300, "Light"],
  [400, "Regular"],
  [500, "Medium"],
  [600, "Semi Bold"],
  [700, "Bold"],
  [800, "Extra Bold"],
  [900, "Black"],
];

/** The weight and italic a style name implies ("Semi Bold Italic" → 600, true). */
export function styleWeight(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase().replace(/[\s_-]/g, "");
  const italic = s.includes("italic") || s.includes("oblique");
  const table: [string, number][] = [
    ["extralight", 200], ["ultralight", 200], ["semibold", 600], ["demibold", 600], ["extrabold", 800], ["ultrabold", 800],
    ["hairline", 100], ["thin", 100], ["light", 300], ["medium", 500], ["bold", 700], ["heavy", 900], ["black", 900],
  ];
  for (const [name, w] of table) if (s.includes(name)) return { weight: w, italic };
  return { weight: 400, italic };
}

/** A style name for a weight and slant, from the family's own styles when one matches (Inter's naming otherwise). */
export function styleFor(weight: number, italic: boolean, available: readonly string[] = []): string {
  const match = available.find((st) => {
    const w = styleWeight(st);
    return w.weight === weight && w.italic === italic;
  });
  if (match) return match;
  const name = WEIGHTS.find(([w]) => w === weight)?.[1] ?? "Regular";
  if (!italic) return name;
  return name === "Regular" ? "Italic" : `${name} Italic`;
}

/** ⌘B: Bold, or back to Regular from Semi Bold and heavier (the engine's own rule while editing). */
export function toggledBold(style: string, available?: readonly string[]): string {
  const { weight, italic } = styleWeight(style);
  return styleFor(weight >= 600 ? 400 : 700, italic, available);
}

/** ⌘I: the same weight, the other slant. */
export function toggledItalic(style: string, available?: readonly string[]): string {
  const { weight, italic } = styleWeight(style);
  return styleFor(weight, !italic, available);
}

/** An OpenType tag ("ss01") as the schema's OpenTypeFeature name ("SS01"). */
export const featureName = (tag: string): string => tag.toUpperCase();

/** A 4-letter axis tag as fontVariations' big-endian uint32 ("wght" → 2003265652). */
export function axisTagNumber(tag: string): number {
  let n = 0;
  for (let i = 0; i < 4; i++) n = n * 256 + (tag.charCodeAt(i) & 0xff);
  return n >>> 0;
}

/** fontVariations with one axis set (the others kept). */
export function withAxis(
  variations: readonly { axisTag: number; axisName?: string; value: number }[] | null | undefined,
  tag: string,
  name: string,
  value: number
): { axisTag: number; axisName: string; value: number }[] {
  const t = axisTagNumber(tag);
  const out = (variations ?? []).filter((v) => v.axisTag !== t).map((v) => ({ axisTag: v.axisTag, axisName: v.axisName ?? "", value: v.value }));
  out.push({ axisTag: t, axisName: name, value });
  return out;
}

/** Figma's names for the standard axes; others show the font's own name. */
export const AXIS_LABELS: Record<string, string> = { wght: "Weight", wdth: "Width", opsz: "Optical size", slnt: "Slant", ital: "Italic" };

/** Whether a URL is one a link can open (Figma: http(s) and Figma links; no mailto:). */
export function normalizeLink(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/^mailto:/i.test(t)) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(t)) return `https://${t}`;
  return null;
}
