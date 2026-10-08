/**
 * Dev Mode's Inspect, as plain data (no engine, no React): what a layer's properties are in the words and units
 * the Inspect panel and its code snippets use (help.figma.com "Guide to inspecting", "Use code snippets in Dev Mode";
 * docs/research/figma/R8-dev-mode.md). The viewer reads the node from the engine and hands it here with the names of the
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
  /** Binding target ("fillPaints[0].color", "STACK_SPACING", "WIDTH"…) → its variable */
  variables?: Readonly<Record<string, BoundName>>;
  /** Style names by kind */
  styles?: { fill?: string; stroke?: string; text?: string; effect?: string };
}

// ---- Numbers and colours -------------------------------------------------------------------------------------

/** Dev Mode's numbers: at most two decimals, no trailing zeros ("12", "12.5", "0.33"). */
export function num(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

export const px = (v: number) => `${num(v)}px`;

const hex2 = (c: number) =>
  Math.round(Math.max(0, Math.min(1, c)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

/** "#0D99FF" (alpha left out). */
export function hexOf(c: Color): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

/** CSS's colour: "#FFF" when it shortens, "#0D99FF", or "rgba(0, 0, 0, 0.25)" with alpha. */
export function cssColor(c: Color, opacity = 1): string {
  const a = Math.round((c.a ?? 1) * opacity * 100) / 100;
  if (a < 1) return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${num(a)})`;
  const h = hexOf(c);
  return h[1] === h[2] && h[3] === h[4] && h[5] === h[6] ? `#${h[1]}${h[3]}${h[5]}` : h;
}

/** A variable's CSS name: Figma's "Color/Primary 500" → "--Color-Primary-500". */
export function cssVariableName(name: string): string {
  return `--${name
    .trim()
    .replace(/[\s/]+/g, "-")
    .replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** `var(--Name, fallback)`, or the variable's Web code syntax when it has one. */
export function cssVar(bound: BoundName | undefined, fallback: string): string {
  if (!bound) return fallback;
  const syntax = bound.codeSyntax?.WEB?.trim();
  if (syntax) return syntax.startsWith("--") ? `var(${syntax}, ${fallback})` : syntax;
  return `var(${cssVariableName(bound.name)}, ${fallback})`;
}

// ---- Reading the node --------------------------------------------------------------------------------------------

export const visiblePaints = (paints: readonly Paint[] | undefined): Paint[] => (paints ?? []).filter((p) => p.visible !== false);
export const visibleEffects = (effects: readonly Effect[] | undefined): Effect[] => (effects ?? []).filter((e) => e.visible !== false);

/** Rotation in degrees as Figma shows it (counter-clockwise positive). */
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
  const parent = input.parentStackMode;
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
  };
  return names[node.type ?? ""] ?? "Layer";
}

/**
 * A gradient's CSS angle from its paint transform: Figma's matrix maps the node's unit square to gradient space, t
 * along x, so t grows fastest along (m00, m01); CSS's 0deg points up, 90deg right.
 */
export function gradientAngle(p: Paint): number {
  const t = p.transform;
  if (!t || (t.m00 === 0 && t.m01 === 0)) return 180;
  const deg = (Math.atan2(t.m00, -t.m01) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360);
}
