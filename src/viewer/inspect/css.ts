/**
 * Dev Mode's CSS for one layer, as Figma's first-party generator writes it (docs/research/atlas/14-dev-mode.md §5):
 * the declarations are collected in a map, the ones equal to their default dropped (§5.3), the rest sorted by
 * Figma's one fixed list and split into sections — Layout, Position, Other, Typography (text only), Style — then one
 * section per styled text run. Lengths have 3 decimals and 0 is `0`; colours are uppercase hex, shortened when they
 * can be, or `rgba()` with a two-digit alpha; variables are `var(--name, fallback)` or their Web code syntax; the
 * paints are listed top first (every solid but the bottom one as a two-stop gradient) and the effects in reverse.
 * A line Figma explains carries a hint (§4.1). Grids are `display: grid` with their tracks (a flexible track as Figma's
 * `minmax(0,<n>fr)`), a grid's items placed by `grid-row` / `grid-column`; a vector gets an SVG section, its markup a
 * tag a line. Not written yet: 3D transforms and Display P3 colours.
 */
import { tracksOf, type GridNode, type Track } from "@/editor/model/grid";
import type { Color, Effect, NodeChange, Paint } from "@/engine/codec";
import { COLLAPSE_AFTER, sectionsText, type CodeSection, type Hint } from "./code";
import {
  cornersOf,
  cssColor,
  cssVar,
  gradientAngle,
  gradientHandles,
  isAutoLayout,
  isTextLike,
  isTransformGroup,
  num,
  paddingOf,
  percent,
  px,
  rotationAndMirror,
  rotationOf,
  round,
  sizingOf,
  typographyOf,
  visibleEffects,
  visiblePaints,
  type InspectInput,
} from "./model";

export interface CssDecl {
  property: string;
  value: string;
  comment?: string;
  hint?: Hint;
  /** Printed after the first ones, behind a blank line and the style's name when there is one: the text's font
   * (its text style), a text's shadows or a layer's effects (its effect style) */
  part?: "font" | "shadow" | "effect";
}

/** The sections' declarations (List shows them; Code prints them with cssSections). */
export interface CssSnippet {
  layout: CssDecl[];
  position: CssDecl[];
  other: CssDecl[];
  typography: CssDecl[];
  style: CssDecl[];
  /** The text style's name, a comment above the font */
  textStyle?: string;
  /** The effect style's name, a comment above the shadows and blurs */
  effectStyle?: string;
  /** A text's runs styled apart from it: the first characters, then their typography */
  runs: { name: string; decls: CssDecl[] }[];
}

// ---- Figma's tables (atlas 14 §5.3) ---------------------------------------------------------------------------------

/** A declaration equal to its default is dropped (`eL`). */
const DEFAULTS: Record<string, string> = {
  width: "auto", height: "auto", "min-width": "auto", "min-height": "auto", "max-width": "auto", "max-height": "auto",
  position: "static", "flex-grow": "0", "flex-shrink": "1", "flex-basis": "auto", "box-sizing": "border-box",
  "align-self": "center", "aspect-ratio": "auto", padding: "0", "flex-direction": "row", "justify-content": "flex-start",
  "align-items": "stretch", "align-content": "stretch", gap: "0", "row-gap": "0", "column-gap": "0", left: "auto",
  right: "auto", top: "auto", bottom: "auto", "word-break": "normal", "pointer-events": "auto", inset: "auto",
  "border-radius": "0", "margin-bottom": "0", "text-indent": "0", "font-size": "0", "letter-spacing": "0",
  "text-transform": "none", "text-align": "left", "text-overflow": "clip", "white-space": "normal", "font-variant": "normal",
  "text-decoration-line": "none", "background-blend-mode": "normal", overflow: "visible", opacity: "1", flex: "0 1 auto",
  "flex-wrap": "nowrap", "mix-blend-mode": "normal", "transform-style": "flat", "backface-visibility": "visible",
};

/** The one sort order (`ej`); a property not in it sorts first, in the order it was set. */
const ORDER = [
  "box-sizing", "display", "position", "left", "right", "top", "bottom", "inset", "width", "height", "min-width", "max-width",
  "min-height", "max-height", "overflow", "perspective", "transform", "transform-origin", "transform-style",
  "backface-visibility", "-webkit-box-orient", "-webkit-line-clamp", "padding", "padding-top", "padding-bottom",
  "padding-left", "padding-right", "border-radius", "margin-bottom", "border", "border-top", "border-right",
  "border-bottom", "border-left", "border-width", "border-color", "border-style", "box-shadow", "opacity", "background",
  "background-clip", "-webkit-background-clip", "-webkit-text-fill-color", "background-blend-mode", "mix-blend-mode",
  "flex-direction", "justify-content", "align-items", "align-content", "gap", "row-gap", "column-gap", "flex", "flex-grow",
  "flex-shrink", "flex-basis", "align-self", "flex-wrap", "aspect-ratio", "color", "font-family", "font-size", "font-style",
  "font-weight", "line-height", "font-variant", "letter-spacing", "text-align", "text-decoration", "text-decoration-line",
  "text-decoration-style", "text-decoration-skip-ink", "text-decoration-color", "text-decoration-thickness",
  "text-underline-offset", "text-underline-position", "text-indent", "text-transform", "text-wrap-style", "text-shadow",
  "word-break", "leading-trim", "text-edge", "font-kerning", "font-variant-numeric", "font-feature-settings",
  "text-overflow", "white-space", "filter", "backdrop-filter", "pointer-events", "content", "grid-template-rows",
  "grid-template-columns", "grid-row", "grid-column", "grid-auto-flow", "justify-self",
];
const RANK = new Map(ORDER.map((p, i) => [p, i]));
const rank = (p: string) => RANK.get(p) ?? -1;

/** The sections (`tR`). */
const LAYOUT = new Set([
  "width", "height", "min-width", "max-width", "min-height", "max-height", "flex-grow", "flex-shrink", "align-self", "flex",
  "flex-wrap", "display", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left", "flex-direction",
  "justify-content", "align-items", "align-content", "gap", "transform", "transform-origin", "transform-style", "perspective",
  "backface-visibility", "row-gap", "column-gap", "-webkit-line-clamp", "-webkit-box-orient", "aspect-ratio",
  "grid-template-rows", "grid-template-columns", "grid-row", "grid-column", "grid-auto-flow", "justify-self",
]);
const POSITION = new Set(["left", "right", "top", "bottom"]);
const TYPOGRAPHY = new Set([
  "color", "text-align", "text-wrap-style", "leading-trim", "text-edge", "font-kerning", "font-variant-numeric",
  "font-feature-settings", "text-overflow", "white-space", "overflow",
]);
const FONT = new Set([
  "font-family", "font-size", "font-weight", "font-style", "font-variant", "text-decoration", "text-decoration-line",
  "text-decoration-style", "text-decoration-skip-ink", "text-decoration-color", "text-decoration-thickness",
  "text-underline-offset", "text-underline-position", "letter-spacing", "text-transform", "line-height",
  "-webkit-text-stroke-width", "-webkit-text-stroke-color",
]);
const STYLE = new Set([
  "background", "background-blend-mode", "opacity", "mix-blend-mode", "background-clip", "-webkit-background-clip",
  "-webkit-text-fill-color", "border", "border-top", "border-right", "border-bottom", "border-left", "border-width",
  "border-color", "border-style", "border-radius", "stroke", "stroke-width", "fill",
]);
const EFFECTS = new Set(["box-shadow", "filter", "backdrop-filter"]);

// Kiwi's alignments: SPACE_EVENLY is Figma's "Space between" (older files: SPACE_BETWEEN), SPACE_EVENLY_CSS is CSS's.
const JUSTIFY: Record<string, string> = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between", SPACE_EVENLY: "space-between", SPACE_AROUND: "space-around", SPACE_EVENLY_CSS: "space-evenly", BASELINE: "baseline" };
const ALIGN: Record<string, string> = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", BASELINE: "baseline" };

/** A layer blend's CSS name; LINEAR_BURN / LINEAR_DODGE are the plus-darker / plus-lighter Safari draws. */
const BLEND: Record<string, string> = {
  NORMAL: "normal", DARKEN: "darken", MULTIPLY: "multiply", LINEAR_BURN: "plus-darker", COLOR_BURN: "color-burn",
  LIGHTEN: "lighten", SCREEN: "screen", LINEAR_DODGE: "plus-lighter", COLOR_DODGE: "color-dodge", OVERLAY: "overlay",
  SOFT_LIGHT: "soft-light", HARD_LIGHT: "hard-light", DIFFERENCE: "difference", EXCLUSION: "exclusion", HUE: "hue",
  SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity",
};

/** OpenType features CSS names in `font-variant-numeric`; KERN is `font-kerning`; the rest `font-feature-settings`. */
const NUMERIC: Record<string, string> = { LNUM: "lining-nums", ONUM: "oldstyle-nums", TNUM: "tabular-nums", PNUM: "proportional-nums", FRAC: "diagonal-fractions", ORDN: "ordinal", ZERO: "slashed-zero" };

/** A vector, boolean or star / polygon: its paints are `fill` and `stroke` (atlas 14 §4 "vector class"). */
export const isVectorClass = (n: NodeChange) => n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION" || n.type === "STAR" || n.type === "REGULAR_POLYGON";
const isGroup = (n: NodeChange) => n.type === "GROUP" || (n.type === "FRAME" && !!n.resizeToFit) || isTransformGroup(n);

/** Fields the snippets read that the TypeScript codec doesn't type yet (schema/document.kiwi names; the engine sends them). */
type CssNode = NodeChange & {
  textWrapStyle?: string;
  leadingTrim?: string;
  toggledOnOTFeatures?: string[];
  toggledOffOTFeatures?: string[];
  fontVariantNumericFigure?: string;
  fontVariantNumericSpacing?: string;
  fontVariantNumericFraction?: string;
  fontVariantOrdinal?: boolean;
  fontVariantSlashedZero?: boolean;
  textDecorationStyle?: string;
  textDecorationSkipInk?: boolean;
  textDecorationFillPaints?: Paint[];
  textDecorationThickness?: { value: number; units: string };
  textUnderlineOffset?: { value: number; units: string };
  targetAspectRatio?: { value?: { x: number; y: number } };
};

// ---- Values -----------------------------------------------------------------------------------------------------------

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };

/** A paint where CSS takes one colour (borders, text, shadows): a gradient gives its first stop, an image black. */
function colorOf(p: Paint, input: InspectInput, list: "fillPaints" | "strokePaints", i: number): { value: string; hint?: Hint } {
  const opacity = p.opacity ?? 1;
  if (p.type === "SOLID" && p.color) return { value: cssVar(input.variables?.[`${list}[${i}].color`], cssColor(p.color, opacity)) };
  if (p.type?.startsWith("GRADIENT_") && p.stops?.length) return { value: cssColor(p.stops[0].color, opacity), hint: { id: "unsupported_gradient_paint" } };
  return { value: cssColor(BLACK), hint: { id: "unsupported_paint" } };
}

function stopsCss(p: Paint, input: InspectInput, list: "fillPaints" | "strokePaints", i: number): string {
  const opacity = p.opacity ?? 1;
  return (p.stops ?? []).map((s, j) => `${cssVar(input.variables?.[`${list}[${i}].stops[${j}].color`], cssColor(s.color, opacity))} ${num(s.position * 100)}%`).join(", ");
}

/** One background layer (atlas 14 §5.1); `top`: a solid above the bottom paint is a two-stop gradient of itself. */
function backgroundCss(p: Paint, input: InspectInput, i: number, size: { x: number; y: number }, top: boolean): string | null {
  switch (p.type) {
    case "SOLID": {
      if (!p.color) return null;
      const c = cssVar(input.variables?.[`fillPaints[${i}].color`], cssColor(p.color, p.opacity ?? 1));
      return top ? `linear-gradient(0deg, ${c} 0%, ${c} 100%)` : c;
    }
    case "GRADIENT_LINEAR":
      return `linear-gradient(${gradientAngle(p, size)}deg, ${stopsCss(p, input, "fillPaints", i)})`;
    case "GRADIENT_RADIAL":
    case "GRADIENT_DIAMOND": {
      const h = gradientHandles(p, size);
      if (!h || !size.x || !size.y) return `radial-gradient(50% 50% at 50% 50%, ${stopsCss(p, input, "fillPaints", i)})`;
      const w = (Math.hypot(h.end.x - h.center.x, h.end.y - h.center.y) / size.x) * 100;
      const ht = (Math.hypot(h.width.x - h.center.x, h.width.y - h.center.y) / size.y) * 100;
      return `radial-gradient(${num(w)}% ${num(ht)}% at ${num((h.center.x / size.x) * 100)}% ${num((h.center.y / size.y) * 100)}%, ${stopsCss(p, input, "fillPaints", i)})`;
    }
    case "GRADIENT_ANGULAR": {
      // Figma's angular formatter (module 1740) is unread (atlas 14 §18 question 5): a conic gradient around the centre [ours].
      const h = gradientHandles(p, size);
      const at = h && size.x && size.y ? `${num((h.center.x / size.x) * 100)}% ${num((h.center.y / size.y) * 100)}%` : "50% 50%";
      return `conic-gradient(from ${gradientAngle(p, size)}deg at ${at}, ${stopsCss(p, input, "fillPaints", i)})`;
    }
    case "IMAGE": {
      const mode = p.imageScaleMode ?? "FILL";
      if (mode === "FIT") return "url(<path-to-image>) lightgray 50% / contain no-repeat";
      if (mode === "TILE") {
        const s = round(100 * (p.scale ?? 1), 3);
        return `url(<path-to-image>) lightgray 0% 0% / ${s}px ${s}px repeat`;
      }
      if (mode === "STRETCH" && p.transform && p.transform.m00 && p.transform.m11) {
        // Crop: the size from the image transform's scale; its position in px is our reading of it (atlas 14 §18).
        const t = p.transform;
        return `url(<path-to-image>) lightgray ${px((-t.m02 / t.m00) * size.x)} ${px((-t.m12 / t.m11) * size.y)} / ${num(100 / t.m00)}% ${num(100 / t.m11)}% no-repeat`;
      }
      return "url(<path-to-image>) lightgray 50% / cover no-repeat";
    }
    default:
      // Video and pattern fills are skipped.
      return null;
  }
}

/** Figma's 1 / 2 / 4-value shorthand (`eS`): top right bottom left. */
function shorthand(t: string, r: string, b: string, l: string): string {
  if (t === b && r === l) return t === r ? t : `${t} ${r}`;
  return `${t} ${r} ${b} ${l}`;
}

/** `aspect-ratio`: a continued-fraction a/b (denominator ≤ max(50, height), within 1e-4), else the two sizes. */
export function aspectRatio(w: number, h: number): string {
  const target = w / h;
  const limit = Math.max(50, h);
  let [p0, q0, p1, q1] = [0, 1, 1, 0];
  let x = target;
  for (let k = 0; k < 64; k++) {
    const a = Math.floor(x);
    const [p2, q2] = [a * p1 + p0, a * q1 + q0];
    if (q2 > limit) break;
    [p0, q0, p1, q1] = [p1, q1, p2, q2];
    if (Math.abs(p1 / q1 - target) < 1e-4) return `${p1}/${q1}`;
    if (x === a) break;
    x = 1 / (x - a);
  }
  return `${w.toFixed(2)}/${h.toFixed(2)}`;
}

/**
 * A grid's tracks as `grid-template-rows` / `-columns`: a flexible track `minmax(0,<n>fr)` (Figma's format strings,
 * `%d` or `%.2f` fr), every track 1fr `repeat(<count>,minmax(0,1fr))`; a fixed track in px and a hugging one `auto`
 * (ours: Figma's strings for these two aren't in its build's text).
 */
export function gridTemplate(tracks: readonly Track[]): string {
  if (!tracks.length) return "none";
  const flex1 = (t: Track) => t.sizing.type === "FLEX" && t.sizing.value === 1;
  if (tracks.length > 1 && tracks.every(flex1)) return `repeat(${tracks.length},minmax(0,1fr))`;
  return tracks
    .map((t) => {
      const v = t.sizing.value;
      if (t.sizing.type === "FLEX") return `minmax(0,${Number.isInteger(v) ? v : v.toFixed(2)}fr)`;
      if (t.sizing.type === "FIXED") return px(v);
      return "auto";
    })
    .join(" ");
}

/** A text's line height (`ty`): px with its percentage as a comment, a percentage with its px, or `normal`. */
function lineHeight(n: NodeChange, v: (target: string, value: string) => string): Pick<CssDecl, "value" | "comment"> {
  const t = typographyOf(n);
  if (t.lineHeightPx === null) return { value: "normal" };
  if (t.lineHeightUnit === "PIXELS") return { value: v("LINE_HEIGHT", px(t.lineHeightPx)), comment: percent(t.lineHeightPercent!) };
  return { value: v("LINE_HEIGHT", percent(t.lineHeightPercent!)), comment: px(t.lineHeightPx) };
}

/** A decoration's thickness or offset: px or % with the other unit as a comment, or `auto`. */
function decorationLength(value: { value: number; units: string } | undefined, size: number): Pick<CssDecl, "value" | "comment"> {
  if (!value || value.units === "RAW" || value.units === "AUTO") return { value: "auto" };
  if (value.units === "PERCENT") return { value: percent(value.value), comment: px((value.value / 100) * size) };
  return { value: px(value.value), comment: size ? percent((value.value / size) * 100) : undefined };
}

// ---- The declarations -----------------------------------------------------------------------------------------------

type Decls = Map<string, CssDecl>;

/** A text's typography (`ty`, `tA`): colour, alignment, OpenType, then its font, decoration and case. */
function typography(n: CssNode, input: InspectInput, set: (d: CssDecl) => void, v: (target: string, value: string) => string): void {
  const t = typographyOf(n);
  const fills = visiblePaints(n.fillPaints);
  const fill = fills[0];
  if (fill) {
    const i = (n.fillPaints ?? []).indexOf(fill);
    const single = fills.length > 1 ? { hint: { id: "single_paint" } as Hint } : {};
    if (fill.type === "SOLID") set({ property: "color", ...colorOf(fill, input, "fillPaints", i), ...single });
    else {
      const bg = backgroundCss(fill, input, i, n.size ?? { x: 0, y: 0 }, false);
      if (bg) {
        set({ property: "background", value: bg, ...single });
        set({ property: "background-clip", value: "text" });
        set({ property: "-webkit-background-clip", value: "text" });
        set({ property: "-webkit-text-fill-color", value: "transparent" });
      }
    }
  }
  if (t.align !== "LEFT") set({ property: "text-align", value: t.align === "JUSTIFIED" ? "justify" : t.align.toLowerCase() });
  if (n.textWrapStyle === "BALANCE" || n.textWrapStyle === "PRETTY") set({ property: "text-wrap-style", value: n.textWrapStyle.toLowerCase() });
  if (n.leadingTrim === "CAP_HEIGHT") {
    set({ property: "leading-trim", value: "both", hint: { id: "leading_trim" } });
    set({ property: "text-edge", value: "cap", hint: { id: "leading_trim" } });
  }
  const numeric: string[] = [];
  const settings: string[] = [];
  const feature = (f: string, on: boolean) => {
    if (f === "KERN") set({ property: "font-kerning", value: on ? "normal" : "none" });
    else if (NUMERIC[f]) {
      if (on && !numeric.includes(NUMERIC[f])) numeric.push(NUMERIC[f]);
    } else settings.push(`'${f.toLowerCase()}' ${on ? "on" : "off"}`);
  };
  for (const f of n.toggledOnOTFeatures ?? []) feature(f, true);
  for (const f of n.toggledOffOTFeatures ?? []) feature(f, false);
  if (n.fontVariantNumericFigure === "LINING") feature("LNUM", true);
  if (n.fontVariantNumericFigure === "OLDSTYLE") feature("ONUM", true);
  if (n.fontVariantNumericSpacing === "TABULAR") feature("TNUM", true);
  if (n.fontVariantNumericSpacing === "PROPORTIONAL") feature("PNUM", true);
  if (n.fontVariantNumericFraction === "DIAGONAL") feature("FRAC", true);
  if (n.fontVariantOrdinal) feature("ORDN", true);
  if (n.fontVariantSlashedZero) feature("ZERO", true);
  if (numeric.length) set({ property: "font-variant-numeric", value: numeric.join(" ") });
  if (settings.length) set({ property: "font-feature-settings", value: settings.join(", ") });

  set({ property: "font-family", value: v("FONT_FAMILY", t.family.includes(" ") ? `"${t.family}"` : t.family), part: "font" });
  set({ property: "font-size", value: v("FONT_SIZE", px(t.size)), part: "font" });
  set({ property: "font-style", value: t.italic ? "italic" : "normal", part: "font" });
  set({ property: "font-weight", value: v("FONT_STYLE", String(t.weight)), part: "font" });
  set({ property: "line-height", ...lineHeight(n, v), part: "font" });
  if (t.textCase === "SMALL_CAPS") set({ property: "font-variant", value: "small-caps", part: "font" });
  else if (t.textCase === "SMALL_CAPS_FORCED") set({ property: "font-variant", value: "all-small-caps", part: "font" });
  set({ property: "letter-spacing", value: v("LETTER_SPACING", px(t.letterSpacingPx)), part: "font" });
  if (t.decoration === "UNDERLINE") {
    set({ property: "text-decoration-line", value: "underline", part: "font" });
    set({ property: "text-decoration-style", value: (n.textDecorationStyle ?? "SOLID").toLowerCase(), part: "font" });
    set({ property: "text-decoration-skip-ink", value: n.textDecorationSkipInk === false ? "none" : "auto", part: "font" });
    const color = visiblePaints(n.textDecorationFillPaints).find((p) => p.type === "SOLID" && p.color);
    if (color?.color) set({ property: "text-decoration-color", value: cssColor(color.color, color.opacity ?? 1), part: "font" });
    set({ property: "text-decoration-thickness", ...decorationLength(n.textDecorationThickness, t.size), part: "font" });
    set({ property: "text-underline-offset", ...decorationLength(n.textUnderlineOffset, t.size), part: "font" });
    set({ property: "text-underline-position", value: "from-font", part: "font" });
  } else if (t.decoration === "STRIKETHROUGH") set({ property: "text-decoration-line", value: "line-through", part: "font" });
  if (t.textCase === "UPPER") set({ property: "text-transform", value: "uppercase", part: "font" });
  else if (t.textCase === "LOWER") set({ property: "text-transform", value: "lowercase", part: "font" });
  else if (t.textCase === "TITLE") set({ property: "text-transform", value: "capitalize", part: "font" });
}

function collect(input: InspectInput): Decls {
  const n = input.node as CssNode;
  const vars = input.variables ?? {};
  const v = (target: string, value: string) => cssVar(vars[target], value);
  const out: Decls = new Map();
  const set = (d: CssDecl) => void out.set(d.property, d);
  const size = n.size ?? { x: 0, y: 0 };
  const sizing = sizingOf(input);
  const auto = isAutoLayout(n);
  const text = isTextLike(n);
  const vector = isVectorClass(n);
  const parentMode = input.parentStackMode ?? input.parent?.stackMode ?? null;
  const parentAuto = parentMode === "HORIZONTAL" || parentMode === "VERTICAL";
  const parentGrid = parentMode === "GRID";
  const absolute = (parentAuto || parentGrid) && n.stackPositioning === "ABSOLUTE";
  const rot = rotationOf(n);
  const grid = n.stackMode === "GRID";
  // A container's padding (`ta`): 1 / 2 / 4 values, or the one side that has any alone.
  const padding = () => {
    const p = paddingOf(n);
    const sides = [
      ["top", p.top, v("STACK_PADDING_TOP", px(p.top))],
      ["right", p.right, v("STACK_PADDING_RIGHT", px(p.right))],
      ["bottom", p.bottom, v("STACK_PADDING_BOTTOM", px(p.bottom))],
      ["left", p.left, v("STACK_PADDING_LEFT", px(p.left))],
    ] as const;
    const some = sides.filter(([, value]) => value !== 0);
    if (some.length === 1) set({ property: `padding-${some[0][0]}`, value: some[0][2] });
    else set({ property: "padding", value: shorthand(sides[0][2], sides[1][2], sides[2][2], sides[3][2]) });
  };

  set({ property: "box-sizing", value: "border-box" });

  // Position: an absolute child of an auto layout, offset from the sides its constraints pin.
  if (absolute) {
    const hint: Hint = { id: "absolute_position", params: { name: input.parent?.name ?? "" } };
    const x = n.transform?.m02 ?? 0;
    const y = n.transform?.m12 ?? 0;
    const parentSize = input.parent?.size;
    set({ property: "position", value: "absolute" });
    const h = n.horizontalConstraint ?? "MIN";
    const vc = n.verticalConstraint ?? "MIN";
    if (h === "MIN" && x !== 0) set({ property: "left", value: px(x), hint });
    if (h === "MAX" && parentSize) set({ property: "right", value: px(parentSize.x - x - size.x), hint });
    if (vc === "MIN" && y !== 0) set({ property: "top", value: px(y), hint });
    if (vc === "MAX" && parentSize) set({ property: "bottom", value: px(parentSize.y - y - size.y), hint });
  }

  // Size (`e4.addSize`): only a fixed axis; an auto-width text only when rotated.
  if (sizing.width === "Fixed" || (text && n.textAutoResize === "WIDTH_AND_HEIGHT" && rot)) set({ property: "width", value: v("WIDTH", px(size.x)) });
  if (sizing.height === "Fixed") set({ property: "height", value: v("HEIGHT", px(size.y)) });
  if (n.minSize?.value?.x) set({ property: "min-width", value: v("MIN_WIDTH", px(n.minSize.value.x)) });
  if (n.maxSize?.value?.x) set({ property: "max-width", value: v("MAX_WIDTH", px(n.maxSize.value.x)) });
  if (n.minSize?.value?.y) set({ property: "min-height", value: v("MIN_HEIGHT", px(n.minSize.value.y)) });
  if (n.maxSize?.value?.y) set({ property: "max-height", value: v("MAX_HEIGHT", px(n.maxSize.value.y)) });
  if (n.targetAspectRatio?.value && size.y) set({ property: "aspect-ratio", value: aspectRatio(size.x, size.y) });

  // A flex item: Fill on the primary axis grows, on the counter axis stretches; a fixed child of a fixed parent keeps its size.
  if (parentAuto && !absolute) {
    const horizontal = parentMode === "HORIZONTAL";
    const primary = horizontal ? sizing.width : sizing.height;
    const counter = horizontal ? sizing.height : sizing.width;
    if (primary === "Fill") set({ property: "flex", value: "1 0 0" });
    else if (primary === "Fixed" && input.parent?.stackPrimarySizing === "FIXED") set({ property: "flex-shrink", value: "0" });
    if (counter === "Fill") set({ property: "align-self", value: "stretch" });
  }

  // The flex container.
  if (auto) {
    const horizontal = n.stackMode === "HORIZONTAL";
    set({ property: "display", value: !parentAuto && sizing.width === "Hug" ? "inline-flex" : "flex" });
    padding();
    set({ property: "flex-direction", value: horizontal ? "row" : "column" });
    const justify = JUSTIFY[n.stackPrimaryAlignItems ?? "MIN"] ?? "flex-start";
    set({ property: "justify-content", value: justify });
    set({ property: "align-items", value: ALIGN[n.stackCounterAlignItems ?? "MIN"] ?? "flex-start" });
    const wrap = n.stackWrap === "WRAP";
    if (wrap) set({ property: "flex-wrap", value: "wrap" });
    const alignContent = n.stackCounterAlignContent === "SPACE_BETWEEN" ? "space-between" : wrap && !input.childrenFill ? (ALIGN[n.stackCounterAlignItems ?? "MIN"] ?? "flex-start") : "stretch";
    set({ property: "align-content", value: alignContent });
    const item = v("STACK_SPACING", px(n.stackSpacing ?? 0));
    const counter = v("STACK_COUNTER_SPACING", px(n.stackCounterSpacing ?? 0));
    if (justify.startsWith("space-")) {
      if (wrap && alignContent !== "space-between") set({ property: horizontal ? "row-gap" : "column-gap", value: counter });
    } else if (!wrap || item === counter) set({ property: "gap", value: item });
    else if (alignContent === "space-between") set({ property: horizontal ? "column-gap" : "row-gap", value: item });
    else set({ property: "gap", value: horizontal ? `${counter} ${item}` : `${item} ${counter}` });
  }

  // A grid (`isGrid`): its tracks, gaps, automatic flow, then its padding.
  if (grid) {
    const g = n as unknown as GridNode;
    const hugs = n.stackPrimarySizing !== "FIXED" || n.stackCounterSizing === "RESIZE_TO_FIT" || n.stackCounterSizing === "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE";
    set({ property: "display", value: hugs ? "inline-grid" : "grid" });
    set({ property: "grid-template-rows", value: gridTemplate(tracksOf(g, "rows")) });
    set({ property: "grid-template-columns", value: gridTemplate(tracksOf(g, "columns")) });
    set({ property: "row-gap", value: v("GRID_ROW_GAP", px(g.gridRowGap ?? 0)) });
    set({ property: "column-gap", value: v("GRID_COLUMN_GAP", px(g.gridColumnGap ?? 0)) });
    if (g.gridReflowEnabled) set({ property: "grid-auto-flow", value: "row" });
    padding();
  }

  // An item of a grid: its rows and columns — spans alone when the grid places its items — and its own alignment.
  if (parentGrid && !absolute && input.parent) {
    const parent = input.parent as unknown as GridNode;
    const item = n as unknown as { gridRowAnchor?: Track["id"]; gridColumnAnchor?: Track["id"]; gridRowSpan?: number; gridColumnSpan?: number; gridChildHorizontalAlign?: string; gridChildVerticalAlign?: string };
    const rowSpan = item.gridRowSpan || 1;
    const columnSpan = item.gridColumnSpan || 1;
    if (parent.gridReflowEnabled) {
      set({ property: "grid-row", value: `span ${rowSpan}` });
      set({ property: "grid-column", value: `span ${columnSpan}` });
    } else {
      const index = (axis: "rows" | "columns", id?: Track["id"]) => Math.max(0, tracksOf(parent, axis).findIndex((t) => !!id && t.id.sessionID === id.sessionID && t.id.localID === id.localID));
      set({ property: "grid-row", value: `${index("rows", item.gridRowAnchor) + 1} / span ${rowSpan}` });
      set({ property: "grid-column", value: `${index("columns", item.gridColumnAnchor) + 1} / span ${columnSpan}` });
    }
    const SELF: Record<string, string> = { AUTO: "auto", MIN: "start", MAX: "end", CENTER: "center" };
    // Only a layer that doesn't fill (`layoutGrow` 0) aligns itself.
    if (!n.stackChildPrimaryGrow && item.gridChildHorizontalAlign && item.gridChildHorizontalAlign !== "AUTO") set({ property: "justify-self", value: SELF[item.gridChildHorizontalAlign] ?? "auto" });
    if (n.stackChildAlignSelf !== "STRETCH" && item.gridChildVerticalAlign && item.gridChildVerticalAlign !== "AUTO") set({ property: "align-self", value: SELF[item.gridChildVerticalAlign] ?? "auto" });
  }

  // Rotation, then the flip of a mirrored layer (`scaleX(-1)` / `scaleY(-1)`).
  const turn = rotationAndMirror(n);
  const transforms = [...(turn.rotate ? [`rotate(${turn.rotate}deg)`] : []), ...(turn.mirror ? [`scale${turn.mirror}(-1)`] : [])];
  if (transforms.length) set({ property: "transform", value: transforms.join(" ") });

  // A text's vertical alignment in a box taller than it, and its truncation.
  if (text) {
    const va = n.textAlignVertical ?? "TOP";
    if (va !== "TOP" && sizing.height !== "Hug") {
      set({ property: "display", value: "flex" });
      set({ property: "flex-direction", value: "column" });
      set({ property: "justify-content", value: va === "CENTER" ? "center" : "flex-end" });
    }
    if (n.textTruncation === "ENDING") {
      if ((n.maxLines ?? 0) > 0) {
        set({ property: "display", value: "-webkit-box" });
        set({ property: "-webkit-box-orient", value: "vertical" });
        set({ property: "-webkit-line-clamp", value: String(n.maxLines) });
        set({ property: "overflow", value: "hidden" });
        set({ property: "text-overflow", value: "ellipsis" });
      } else {
        set({ property: "overflow", value: "hidden" });
        set({ property: "text-overflow", value: "ellipsis" });
        set({ property: "white-space", value: "nowrap" });
      }
    }
  }

  // Corners: 1 / 2 / 4 values, each bindable.
  const corners = cornersOf(n);
  if (corners && n.type !== "ELLIPSE" && !text && !vector) {
    if (!n.rectangleCornerRadiiIndependent) set({ property: "border-radius", value: v("CORNER_RADIUS", px(corners.tl)) });
    else {
      const c = (target: string, value: number) => v(target, px(value));
      const tl = c("RECTANGLE_TOP_LEFT_CORNER_RADIUS", corners.tl);
      const tr = c("RECTANGLE_TOP_RIGHT_CORNER_RADIUS", corners.tr);
      const br = c("RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS", corners.br);
      const bl = c("RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", corners.bl);
      set({ property: "border-radius", value: tl === tr && tr === br && br === bl ? tl : tl === br && tr === bl ? `${tl} ${tr}` : `${tl} ${tr} ${br} ${bl}` });
    }
  } else if (n.type === "ELLIPSE") set({ property: "border-radius", value: px(Math.max(size.x, size.y)) });

  // Strokes: one paint (`e7`); stroke alignment is ignored in CSS.
  const strokes = visiblePaints(n.strokePaints);
  const weight = n.strokeWeight ?? 1;
  if (strokes.length) {
    const i = (n.strokePaints ?? []).indexOf(strokes[0]);
    const color = colorOf(strokes[0], input, "strokePaints", i);
    const hint: Hint | undefined = strokes.length > 1 ? { id: "single_paint" } : auto && !n.bordersTakeSpace ? { id: "borders_dont_take_up_space" } : color.hint;
    const kind = n.dashPattern?.length ? "dashed" : "solid";
    if (text) {
      const solid = strokes.find((p) => p.type === "SOLID" && p.color);
      set({ property: "-webkit-text-stroke-width", value: `${round(weight, 2)}px`, part: "font" });
      set({ property: "-webkit-text-stroke-color", value: solid?.color ? cssColor(solid.color, solid.opacity ?? 1) : cssColor(BLACK), ...(solid ? {} : { hint: { id: "unsupported_paint" } as Hint }), part: "font" });
    } else if (vector) {
      if (weight > 0 || vars.STROKE_WEIGHT) set({ property: "stroke-width", value: v("STROKE_WEIGHT", px(weight)) });
      set({ property: "stroke", value: color.value, ...(hint ? { hint } : {}) });
    } else if (n.borderStrokeWeightsIndependent) {
      for (const [side, field, target] of [["top", n.borderTopWeight, "BORDER_TOP_WEIGHT"], ["right", n.borderRightWeight, "BORDER_RIGHT_WEIGHT"], ["bottom", n.borderBottomWeight, "BORDER_BOTTOM_WEIGHT"], ["left", n.borderLeftWeight, "BORDER_LEFT_WEIGHT"]] as const)
        if ((field ?? 0) > 0 || vars[target]) set({ property: `border-${side}`, value: `${v(target, px(field ?? 0))} ${kind} ${color.value}`, ...(hint ? { hint } : {}) });
    } else if (weight > 0 || vars.STROKE_WEIGHT) {
      set({ property: "border", value: `${v("STROKE_WEIGHT", px(weight))} ${kind} ${color.value}`, ...(hint ? { hint } : {}) });
    }
  }

  if (n.opacity !== undefined || vars.OPACITY) set({ property: "opacity", value: v("OPACITY", round(n.opacity ?? 1, 4)) });

  const blend = n.blendMode && n.blendMode !== "PASS_THROUGH" ? BLEND[n.blendMode] : undefined;
  if (blend) set({ property: "mix-blend-mode", value: blend, ...(n.blendMode === "LINEAR_BURN" ? { hint: { id: "plus_darker" } as Hint } : {}) });

  // Fills: a text's colour, a vector's fill, else the backgrounds top first.
  const fills = visiblePaints(n.fillPaints);
  if (text) typography(n, input, set, v);
  else if (vector && fills.length) {
    const fill = colorOf(fills[0], input, "fillPaints", (n.fillPaints ?? []).indexOf(fills[0]));
    set({ property: "fill", value: fill.value, ...(fills.length > 1 ? { hint: { id: "single_paint" } as Hint } : fill.hint ? { hint: fill.hint } : {}) });
  } else if (fills.length) {
    const layers = fills
      .map((p, k) => ({ p, css: backgroundCss(p, input, (n.fillPaints ?? []).indexOf(p), size, k > 0) }))
      .filter((l): l is { p: Paint; css: string } => !!l.css)
      .reverse();
    if (layers.length) {
      set({ property: "background", value: layers.map((l) => l.css).join(", ") });
      const blends = layers.map((l) => BLEND[l.p.blendMode ?? "NORMAL"] ?? "normal");
      if (blends.some((b) => b !== "normal")) {
        const plus = blends.find((b) => b.startsWith("plus-"));
        set({ property: "background-blend-mode", value: blends.join(", "), ...(plus ? { hint: { id: "background_blend_mode_plus_lighter_darker", params: { value: plus } } as Hint } : {}) });
      }
    }
  }

  // Effects, in reverse order (each one is prepended); noise, texture, glass and shaders are skipped.
  const effects = visibleEffects(n.effects);
  const shadows: string[] = [];
  const textShadows: string[] = [];
  const filters: string[] = [];
  const backdrop: string[] = [];
  const blur = (e: Effect, i: number) => (vars[`effects[${i}].radius`] ? `blur(calc(${cssVar(vars[`effects[${i}].radius`], px(e.radius ?? 0))} / 2))` : `blur(${(e.radius ?? 0) / 2}px)`);
  effects.forEach((e) => {
    const i = (n.effects ?? []).indexOf(e);
    const ev = (field: string, value: string) => cssVar(vars[`effects[${i}].${field}`], value);
    const x = ev("x", px(e.offset?.x ?? 0));
    const y = ev("y", px(e.offset?.y ?? 0));
    const r = ev("radius", px(e.radius ?? 0));
    const c = ev("color", cssColor(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 }));
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      if (text) {
        // An inner shadow on text has no CSS (Figma logs a warning).
        if (e.type === "DROP_SHADOW") textShadows.unshift(`${x} ${y} ${r} ${c}`);
      } else if (e.type === "DROP_SHADOW" && (vector || isGroup(n))) filters.unshift(`drop-shadow(${x} ${y} ${r} ${c})`);
      else shadows.unshift(`${x} ${y} ${r} ${ev("spread", px(e.spread ?? 0))} ${c}${e.type === "INNER_SHADOW" ? " inset" : ""}`);
    } else if (e.type === "FOREGROUND_BLUR") filters.unshift(blur(e, i));
    else if (e.type === "BACKGROUND_BLUR") backdrop.unshift(blur(e, i));
  });
  // A vector's effects are in its SVG too (hint 19).
  const inSvg = vector ? { hint: { id: "effects_in_svg" } as Hint } : {};
  if (textShadows.length) set({ property: "text-shadow", value: textShadows.join(", "), part: "shadow" });
  if (shadows.length) set({ property: "box-shadow", value: shadows.join(", "), part: "effect", ...inSvg });
  if (filters.length) set({ property: "filter", value: filters.join(" "), part: "effect", ...inSvg });
  if (backdrop.length) set({ property: "backdrop-filter", value: backdrop.join(" "), part: "effect" });
  return out;
}

/**
 * The SVG section (atlas 14 §5.3): a vector's markup a tag a line, indented by its nesting — a closing tag one level
 * out, an opening one that doesn't close itself one level in after it — hint 20 on the first line when the layer or a
 * parent is rotated or mirrored. Not for a file that blocks exports (the caller leaves `svg` out).
 */
export function svgSection(markup: string, transformed: boolean): CodeSection {
  let depth = 0;
  const lines = markup
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((code, i) => {
      const hint: Hint | undefined = i === 0 && transformed ? { id: "transform_included_in_svg" } : undefined;
      if (code.startsWith("</")) depth = Math.max(0, depth - 1);
      const line = { code, indent: depth, ...(hint ? { hint } : {}) };
      if (code.startsWith("<") && !code.startsWith("</") && !code.endsWith("/>") && !/<\/[^>]+>$/.test(code)) depth++;
      return line;
    });
  return { name: "SVG", language: "html", lines, collapseAfterIndex: COLLAPSE_AFTER };
}

/** A text's runs styled apart from it (§5.3 "6+"): named by their first 10 characters; blank runs and repeats skipped. */
function runsOf(input: InspectInput): CssSnippet["runs"] {
  const n = input.node;
  const data = n.textData;
  if (!isTextLike(n) || !data?.characterStyleIDs?.length || !data.styleOverrideTable?.length) return [];
  const chars = data.characters ?? "";
  const ids = data.characterStyleIDs;
  const seen = new Set<number>();
  const runs: CssSnippet["runs"] = [];
  for (let start = 0; start < ids.length; ) {
    const id = ids[start];
    let end = start;
    while (end < ids.length && ids[end] === id) end++;
    const run = chars.slice(start, end);
    const override = data.styleOverrideTable.find((o) => o.styleID === id);
    if (id && override && run.trim() && !seen.has(id)) {
      seen.add(id);
      const merged = { ...n, ...override, guid: n.guid, type: n.type } as NodeChange;
      const decls = new Map<string, CssDecl>();
      typography(merged, { ...input, node: merged, variables: {} }, (d) => void decls.set(d.property, d), (_, value) => value);
      const base = new Map<string, CssDecl>();
      typography(n, { ...input, variables: {} }, (d) => void base.set(d.property, d), (_, value) => value);
      const differs = [...decls.values()].some((d) => base.get(d.property)?.value !== d.value) || [...base.keys()].some((k) => !decls.has(k));
      if (differs) runs.push({ name: run.length > 10 ? `${run.slice(0, 10)}...` : run, decls: sortDecls([...decls.values()]).map((d) => ({ ...d, part: undefined })) });
    }
    start = end;
  }
  return runs;
}

const sortDecls = (decls: CssDecl[]) => decls.filter((d) => DEFAULTS[d.property] !== d.value).sort((a, b) => rank(a.property) - rank(b.property));

/** The snippet's declarations, defaults dropped, sorted and split into Figma's sections. */
export function cssSnippet(input: InspectInput): CssSnippet {
  const text = isTextLike(input.node);
  const s: CssSnippet = { layout: [], position: [], other: [], typography: [], style: [], runs: runsOf(input) };
  const typographyParts: Record<"first" | "shadow" | "font", CssDecl[]> = { first: [], shadow: [], font: [] };
  const styleParts: Record<"look" | "effect", CssDecl[]> = { look: [], effect: [] };
  for (const d of sortDecls([...collect(input).values()])) {
    const p = d.property;
    if (LAYOUT.has(p)) s.layout.push(d);
    else if (POSITION.has(p)) s.position.push(d);
    else if (p === "position") {
      // `position: relative` (a parent of absolute children) is dropped here.
      if (d.value === "absolute") s.position.push(d);
    } else if (TYPOGRAPHY.has(p) || FONT.has(p) || p === "text-shadow") {
      // The typography of anything but a text is dropped — a clipping frame's `overflow: hidden` too.
      if (text) typographyParts[p === "text-shadow" ? "shadow" : FONT.has(p) ? "font" : "first"].push(d);
    } else if (STYLE.has(p)) styleParts.look.push(d);
    else if (EFFECTS.has(p)) styleParts.effect.push(d);
    else s.other.push(d);
  }
  s.position.sort((a, b) => rank(a.property) - rank(b.property));
  s.typography = [...typographyParts.first, ...typographyParts.shadow, ...typographyParts.font];
  s.style = [...styleParts.look, ...styleParts.effect];
  s.textStyle = text ? input.styles?.text : undefined;
  s.effectStyle = input.styles?.effect;
  return s;
}

const line = (d: CssDecl) => `${d.property}: ${d.value};${d.comment ? ` /* ${d.comment} */` : ""}`;

/** A group's lines: a blank line and the style's name before the font (text style) and the effects (effect style). */
function groupLines(decls: readonly CssDecl[], styles: { font?: string; effect?: string }): CodeSection["lines"] {
  const out: CodeSection["lines"] = [];
  let part: CssDecl["part"];
  for (const d of decls) {
    if (d.part && d.part !== part) {
      const name = d.part === "font" ? styles.font : styles.effect;
      // The shadows and the effects share the effect style's comment.
      if (name && !(d.part === "effect" && part === "shadow")) out.push(...(out.length ? [{ code: "", indent: 0 }] : []), { code: `/* ${name} */`, indent: 0 });
    }
    part = d.part;
    out.push({ code: line(d), indent: 0, ...(d.hint ? { hint: d.hint } : {}) });
  }
  return out;
}

/** Figma's sections in order: Layout, Position, Other, Typography, Style, then the text runs; empty ones left out. */
export function cssSections(input: InspectInput): CodeSection[] {
  const s = cssSnippet(input);
  const styles = { font: s.textStyle, effect: s.effectStyle };
  const sections: CodeSection[] = [
    { name: "Layout", language: "css", lines: groupLines(s.layout, styles) },
    { name: "Position", language: "css", lines: groupLines(s.position, styles) },
    { name: "Other", language: "css", lines: groupLines(s.other, styles) },
    { name: "Typography", language: "css", lines: groupLines(s.typography, styles) },
    { name: "Style", language: "css", lines: groupLines(s.style, styles) },
    ...s.runs.map((r) => ({ name: r.name, language: "css" as const, lines: groupLines(r.decls, styles) })),
  ];
  const out: CodeSection[] = sections.filter((x) => x.lines.length).map((x) => ({ ...x, collapseAfterIndex: COLLAPSE_AFTER }));
  if (input.svg?.markup && isVectorClass(input.node)) out.push(svgSection(input.svg.markup, input.svg.transformed));
  return out;
}

/** One group as Dev Mode prints it. */
export function cssLines(decls: readonly CssDecl[], comment?: string): string {
  return [...(comment ? [`/* ${comment} */`] : []), ...decls.map(line)].join("\n");
}

/** The whole snippet as one text (what "Copy" puts on the clipboard with ⇧). */
export function cssText(input: InspectInput): string {
  return sectionsText(cssSections(input));
}
