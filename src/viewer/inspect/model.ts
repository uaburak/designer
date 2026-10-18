/**
 * Dev Mode's Inspect, as plain data (no engine, no React): what a layer's properties are in the words and units
 * the Inspect panel and its code snippets use (help.figma.com "Guide to inspecting", "Use code snippets in Dev Mode";
 * docs/research/figma/R9-dev-mode.md). The viewer reads the node from the engine and hands it here with the names of the
 * variables and styles it uses.
 */
import type { Color, Effect, NodeChange, Paint } from "@/engine/codec";

/** A variable bound to a property, as Dev Mode names it. */
export interface BoundName {
  /** The variable's name ("Color/Primary") */
  name: string;
  /** Its code syntax per platform, when set */
  codeSyntax?: Partial<Record<"WEB" | "ANDROID" | "iOS", string>>;
}

/** Everything a snippet needs besides the node itself. */
export interface InspectInput {
  node: NodeChange;
  /** The parent lays it out (auto layout): Hug / Fill / Fixed are written as flex items */
  parentStackMode?: string | null;
  /** The parent as the snippets read it: its type and name (absolute children), size (right / bottom), primary sizing */
  parent?: Pick<NodeChange, "type" | "name" | "size" | "stackMode" | "stackPrimarySizing"> | null;
  /** A wrapping auto layout whose children all fill its counter axis (no `align-content` then) */
  childrenFill?: boolean;
  /** Binding target ("fillPaints[0].color", "STACK_SPACING", "WIDTH"…) → its variable */
  variables?: Readonly<Record<string, BoundName>>;
  /** Style names by kind */
  styles?: { fill?: string; stroke?: string; text?: string; effect?: string };
  /** A vector's SVG markup for CSS's SVG section (atlas 14 §5.3), and whether it or a parent is rotated or mirrored */
  svg?: { markup: string; transformed: boolean } | null;
}

// ---- Numbers and colours -------------------------------------------------------------------------------------

/** Dev Mode's numbers: at most two decimals, no trailing zeros ("12", "12.5", "0.33"). */
export function num(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

/** A number rounded to `digits` decimals, no trailing zeros (lodash `round`, as Figma's code generators use it). */
export function round(v: number, digits: number): string {
  const k = 10 ** digits;
  const r = Math.round(v * k) / k;
  return String(Object.is(r, -0) ? 0 : r);
}

/** CSS's length (atlas 14 §5.1): 3 decimals with `px`, and 0 written `0` with no unit ("12.346px", "0"). */
export const px = (v: number) => {
  const r = round(v, 3);
  return r === "0" ? "0" : `${r}px`;
};

/** A CSS percentage: 3 decimals, then `%` ("125%"). */
export const percent = (v: number) => `${round(v, 3)}%`;

const hex2 = (c: number) =>
  Math.round(Math.max(0, Math.min(1, c)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

/** "#0D99FF" (alpha left out). */
export function hexOf(c: Color): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

/**
 * CSS's colour (atlas 14 §5.1): "#FFF" when it shortens, "#0D99FF"; with a colour alpha or a paint opacity other
 * than 1, `rgba(R, G, B, A)` with A = alpha × opacity always to two digits ("rgba(255, 255, 255, 0.50)").
 */
export function cssColor(c: Color, opacity = 1): string {
  const alpha = c.a ?? 1;
  if (alpha !== 1 || opacity !== 1) return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${(alpha * opacity).toFixed(2)})`;
  const h = hexOf(c);
  return h[1] === h[2] && h[3] === h[4] && h[5] === h[6] ? `#${h[1]}${h[3]}${h[5]}` : h;
}

/** A name cleaned as Figma's converters start (atlas 14 §4.2): nothing above U+007E, no quotes, line breaks as spaces. */
const cleanName = (name: string) =>
  name
    .replace(/[^\t\n\r -~]/g, "")
    .replace(/['"]/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();

/** lodash `words` for ASCII: camel humps, upper-case runs, lower-case runs and digit runs. */
export function words(s: string): string[] {
  return s.match(/[A-Z]{2,}(?=[A-Z][a-z]|[^A-Za-z]|$)|[A-Z]?[a-z]+|[A-Z]+|\d+/g) ?? [];
}

/**
 * A variable's or style's CSS name (atlas 14 §4.2 `OX`): runs of whitespace or `/` become one `-`; a name that is then
 * only `[-A-Za-z0-9_]` keeps its case ("Colors/Primary 500" → "--Colors-Primary-500"), any other is camel-cased and
 * written as kebab-case ("Brand (new)" → "--brand-new"); an empty name is "unnamed".
 */
export function cssVariableName(name: string): string {
  const dashed = cleanName(name).replace(/[\s/]+/g, "-");
  if (/^[-A-Za-z0-9_]+$/.test(dashed)) return `--${dashed}`;
  const camel = words(dashed)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
  const kebab = camel
    .replace(/([A-Z])/g, "-$1")
    .replace(/(\d+)/g, "-$1")
    .toLowerCase()
    .replace(/^[^A-Za-z0-9-]+/, "");
  return `--${kebab || "unnamed"}`;
}

/** A variable's Swift / Kotlin name (atlas 14 §4.2 `O$`): "brand/primary 500" → brandPrimary500. */
export function camelName(name: string): string {
  const joined = words(cleanName(name))
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join("")
    .replace(/^[^A-Za-z]+/, "");
  return joined || "unnamed";
}

/** `var(--Name, fallback)`, or the variable's Web code syntax written as it is (atlas 14 §4.2). */
export function cssVar(bound: BoundName | undefined, fallback: string): string {
  if (!bound) return fallback;
  const syntax = bound.codeSyntax?.WEB?.trim();
  if (syntax) return syntax;
  return `var(${cssVariableName(bound.name)}, ${fallback})`;
}

// ---- Reading the node --------------------------------------------------------------------------------------------

export const visiblePaints = (paints: readonly Paint[] | undefined): Paint[] => (paints ?? []).filter((p) => p.visible !== false);
export const visibleEffects = (effects: readonly Effect[] | undefined): Effect[] => (effects ?? []).filter((e) => e.visible !== false);

/** Rotation in degrees as Figma shows it (counter-clockwise positive). */
/** Mirrored: the transform flips the layer (its determinant is negative). */
export const isMirrored = (node: NodeChange): boolean => {
  const t = node.transform;
  return !!t && t.m00 * t.m11 - t.m01 * t.m10 < 0;
};

/**
 * CSS's 2D transform (atlas 14 §5.1, Figma's `rotationAndMirror`): the rotation, and for a mirrored layer the flip
 * that leaves the smaller story — `scaleY(-1)` when the layer flipped on its own Y needs no rotation, else the rotation
 * without the X flip and `scaleX(-1)`. Degrees as CSS's `rotate()` takes them (3 decimals).
 */
export function rotationAndMirror(node: NodeChange): { rotate: number; mirror?: "X" | "Y" } {
  const t = node.transform;
  if (!t) return { rotate: 0 };
  const deg = (y: number, x: number) => Number(round((Math.atan2(y, x) * 180) / Math.PI, 3)) || 0;
  if (!isMirrored(node)) return { rotate: deg(t.m10, t.m00) };
  const withoutY = deg(t.m10, t.m00);
  return withoutY === 0 ? { rotate: 0, mirror: "Y" } : { rotate: deg(-t.m10, -t.m00), mirror: "X" };
}

export function rotationOf(node: NodeChange): number {
  const t = node.transform;
  if (!t) return 0;
  const deg = (-Math.atan2(t.m10, t.m00) * 180) / Math.PI;
  return Math.abs(deg) < 0.005 ? 0 : deg;
}

export interface Corners {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

export function cornersOf(node: NodeChange): Corners | null {
  if (node.rectangleCornerRadiiIndependent) {
    const c = {
      tl: node.rectangleTopLeftCornerRadius ?? 0,
      tr: node.rectangleTopRightCornerRadius ?? 0,
      br: node.rectangleBottomRightCornerRadius ?? 0,
      bl: node.rectangleBottomLeftCornerRadius ?? 0,
    };
    return c.tl || c.tr || c.br || c.bl ? c : null;
  }
  const r = node.cornerRadius ?? 0;
  return r > 0 ? { tl: r, tr: r, br: r, bl: r } : null;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function paddingOf(node: NodeChange): Padding {
  const left = node.stackHorizontalPadding ?? 0;
  const top = node.stackVerticalPadding ?? 0;
  return { top, right: node.stackPaddingRight ?? left, bottom: node.stackPaddingBottom ?? top, left };
}

/** A text or a text on a path (Draw's TEXT_PATH inspects as text: Typography, text colour; docs/draw.md §7). */
export const isTextLike = (node: Pick<NodeChange, "type">): boolean => node.type === "TEXT" || (node.type as string) === "TEXT_PATH";

/** Draw's transform group (TRANSFORM): inspected as a group (docs/draw.md §7). */
export const isTransformGroup = (node: Pick<NodeChange, "type">): boolean => (node.type as string) === "TRANSFORM";

export const isAutoLayout = (node: NodeChange) => node.stackMode === "HORIZONTAL" || node.stackMode === "VERTICAL";

/** How the layer sizes on each axis, in Figma's words. */
export function sizingOf(input: InspectInput): { width: "Fixed" | "Hug" | "Fill"; height: "Fixed" | "Hug" | "Fill" } {
  const n = input.node;
  let width: "Fixed" | "Hug" | "Fill" = "Fixed";
  let height: "Fixed" | "Hug" | "Fill" = "Fixed";
  if (n.type === "TEXT") {
    if (n.textAutoResize === "WIDTH_AND_HEIGHT") width = height = "Hug";
    else if (n.textAutoResize === "HEIGHT") height = "Hug";
  }
  if (isAutoLayout(n)) {
    const primaryHug = n.stackPrimarySizing !== "FIXED";
    const counterHug = n.stackCounterSizing === "RESIZE_TO_FIT" || n.stackCounterSizing === "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE";
    if (n.stackMode === "HORIZONTAL") {
      width = primaryHug ? "Hug" : "Fixed";
      height = counterHug ? "Hug" : "Fixed";
    } else {
      height = primaryHug ? "Hug" : "Fixed";
      width = counterHug ? "Hug" : "Fixed";
    }
  }
  const parent = input.parentStackMode ?? input.parent?.stackMode;
  if ((parent === "HORIZONTAL" || parent === "VERTICAL") && n.stackPositioning !== "ABSOLUTE") {
    const grow = (n.stackChildPrimaryGrow ?? 0) > 0;
    const stretch = n.stackChildAlignSelf === "STRETCH";
    if (parent === "HORIZONTAL") {
      if (grow) width = "Fill";
      if (stretch) height = "Fill";
    } else {
      if (grow) height = "Fill";
      if (stretch) width = "Fill";
    }
  }
  return { width, height };
}

/** Figma's weight names → CSS numbers ("Semi Bold" → 600). */
export function fontWeightOf(style: string): number {
  const s = style.replace(/[\s_-]/g, "").toLowerCase();
  const table: [string, number][] = [
    ["extralight", 200], ["ultralight", 200], ["semibold", 600], ["demibold", 600], ["extrabold", 800], ["ultrabold", 800],
    ["hairline", 100], ["thin", 100], ["light", 300], ["medium", 500], ["bold", 700], ["heavy", 900], ["black", 900],
  ];
  for (const [name, w] of table) if (s.includes(name)) return w;
  return 400;
}

export const isItalic = (style: string) => /italic|oblique/i.test(style);

export interface Typography {
  family: string;
  style: string;
  weight: number;
  italic: boolean;
  size: number;
  /** null = Auto */
  lineHeightPx: number | null;
  /** line height as a percentage of the size (Auto: null) */
  lineHeightPercent: number | null;
  /** How the line height was set: in pixels or as a percentage (Auto: null) */
  lineHeightUnit: "PIXELS" | "PERCENT" | null;
  letterSpacingPx: number;
  letterSpacingPercent: number | null;
  align: string;
  textCase: string;
  decoration: string;
}

export function typographyOf(node: NodeChange): Typography {
  const family = node.fontName?.family ?? "Inter";
  const style = node.fontName?.style ?? "Regular";
  const size = node.fontSize ?? 12;
  const lh = node.lineHeight;
  let lineHeightPx: number | null = null;
  if (lh && !(lh.units === "PERCENT" && lh.value === 100)) lineHeightPx = lh.units === "PIXELS" ? lh.value : lh.units === "PERCENT" ? (lh.value / 100) * size : lh.value * size;
  const ls = node.letterSpacing;
  const letterSpacingPx = !ls ? 0 : ls.units === "PIXELS" ? ls.value : (ls.value / 100) * size;
  return {
    family,
    style,
    weight: fontWeightOf(style),
    italic: isItalic(style),
    size,
    lineHeightPx,
    lineHeightPercent: lineHeightPx === null ? null : (lineHeightPx / size) * 100,
    lineHeightUnit: lineHeightPx === null ? null : lh?.units === "PIXELS" ? "PIXELS" : "PERCENT",
    letterSpacingPx,
    letterSpacingPercent: ls && ls.units === "PERCENT" ? ls.value : null,
    align: node.textAlignHorizontal ?? "LEFT",
    textCase: node.textCase ?? "ORIGINAL",
    decoration: node.textDecoration ?? "NONE",
  };
}

/** The type Dev Mode's header names ("Frame", "Text", "Instance"…). */
export function typeLabel(node: NodeChange): string {
  if (node.type === "FRAME" && node.resizeToFit) return "Group";
  if (node.type === "FRAME" && node.isStateGroup) return "Component set";
  const names: Record<string, string> = {
    FRAME: "Frame", GROUP: "Group", SECTION: "Section", TEXT: "Text", RECTANGLE: "Rectangle", ROUNDED_RECTANGLE: "Rectangle",
    ELLIPSE: "Ellipse", LINE: "Line", VECTOR: "Vector", STAR: "Star", REGULAR_POLYGON: "Polygon", BOOLEAN_OPERATION: "Boolean",
    SYMBOL: "Component", INSTANCE: "Instance", CANVAS: "Page", SLICE: "Slice",
    // Draw (the Layers names of docs/draw.md §5.9's As built [unverified])
    TEXT_PATH: "Text on path", TRANSFORM: "Transform group",
  };
  return names[node.type ?? ""] ?? "Layer";
}

/**
 * A gradient's handles in the layer's pixels: Figma's paint transform maps the node's unit square to gradient space
 * (t along x, the centre at (0.5, 0.5)), so its inverse places the start (0, 0.5), the end (1, 0.5) and the second
 * handle (0.5, 1); null when the matrix can't be inverted.
 */
export function gradientHandles(p: Paint, size: { x: number; y: number } = { x: 1, y: 1 }): { start: Point; end: Point; center: Point; width: Point } | null {
  const t = p.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const det = t.m00 * t.m11 - t.m01 * t.m10;
  if (!det) return null;
  const at = (gx: number, gy: number): Point => {
    const x = gx - t.m02;
    const y = gy - t.m12;
    return { x: ((t.m11 * x - t.m01 * y) / det) * size.x, y: ((-t.m10 * x + t.m00 * y) / det) * size.y };
  };
  return { start: at(0, 0.5), end: at(1, 0.5), center: at(0.5, 0.5), width: at(0.5, 1) };
}

interface Point {
  x: number;
  y: number;
}

/**
 * A linear gradient's CSS angle (atlas 14 §5.1): the direction from its start handle to its end handle against the
 * box, CSS's 0deg pointing up and 90deg right, rounded; 360 is written 0.
 */
export function gradientAngle(p: Paint, size: { x: number; y: number } = { x: 1, y: 1 }): number {
  const h = gradientHandles(p, size);
  if (!h) return 180;
  const deg = Math.round((Math.atan2(h.end.x - h.start.x, -(h.end.y - h.start.y)) * 180) / Math.PI);
  return ((deg % 360) + 360) % 360;
}
