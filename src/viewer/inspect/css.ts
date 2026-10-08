/**
 * Dev Mode's CSS snippet for one layer (help.figma.com "Use code snippets in Dev Mode"; docs/research/figma/dev-mode.md):
 * properties in Figma's order — the flex container (display, size, padding, direction, alignment, gap), the flex item
 * (flex, align-self, flex-shrink), corners, border, opacity, background, shadows and blurs — then the typography of a
 * text (color, font-family, font-size, font-style, font-weight, line-height with its percentage as a comment,
 * letter-spacing), the text style's name as a comment above it. Variables are `var(--Name, fallback)`; colours are
 * uppercase hex, shortened when they can be, `rgba()` with alpha.
 */
import type { Effect, Paint } from "@/engine/codec";
import {
  cornersOf,
  cssColor,
  cssVar,
  gradientAngle,
  isAutoLayout,
  num,
  paddingOf,
  px,
  rotationOf,
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
}

/** Dev Mode's groups of a snippet: how the layer is laid out, how it looks, its text. */
export interface CssSnippet {
  layout: CssDecl[];
  style: CssDecl[];
  typography: CssDecl[];
  /** The text style's name, written as a comment above the typography */
  textStyle?: string;
}

const JUSTIFY: Record<string, string> = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between", SPACE_EVENLY: "space-evenly", SPACE_AROUND: "space-around" };
const ALIGN: Record<string, string> = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", BASELINE: "baseline" };

function paintCss(p: Paint, input: InspectInput, list: "fillPaints" | "strokePaints", i: number): string | null {
  const opacity = p.opacity ?? 1;
  switch (p.type) {
    case "SOLID":
      return p.color ? cssVar(input.variables?.[`${list}[${i}].color`], cssColor(p.color, opacity)) : null;
    case "GRADIENT_LINEAR":
    case "GRADIENT_RADIAL":
    case "GRADIENT_ANGULAR":
    case "GRADIENT_DIAMOND": {
      const stops = (p.stops ?? []).map((s, j) => `${cssVar(input.variables?.[`${list}[${i}].stops[${j}].color`], cssColor(s.color, opacity))} ${num(s.position * 100)}%`).join(", ");
      if (p.type === "GRADIENT_LINEAR") return `linear-gradient(${gradientAngle(p)}deg, ${stops})`;
      if (p.type === "GRADIENT_ANGULAR") return `conic-gradient(from ${gradientAngle(p)}deg at 50% 50%, ${stops})`;
      return `radial-gradient(50% 50% at 50% 50%, ${stops})`;
    }
    case "IMAGE": {
      const fit = p.imageScaleMode === "FIT" ? "contain" : p.imageScaleMode === "TILE" ? "auto" : "cover";
      return `url(<path-to-image>) lightgray 50% / ${fit} ${p.imageScaleMode === "TILE" ? "repeat" : "no-repeat"}`;
    }
    default:
      return null;
  }
}

function shadowCss(e: Effect, input: InspectInput, i: number): string {
  const v = (field: string, value: string) => cssVar(input.variables?.[`effects[${i}].${field}`], value);
  const parts = [v("x", px(e.offset?.x ?? 0)), v("y", px(e.offset?.y ?? 0)), v("radius", px(e.radius ?? 0)), v("spread", px(e.spread ?? 0)), v("color", cssColor(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 }))];
  return `${e.type === "INNER_SHADOW" ? "inset " : ""}${parts.join(" ")}`;
}

/** The snippet's declarations, grouped. */
export function cssSnippet(input: InspectInput): CssSnippet {
  const n = input.node;
  const vars = input.variables ?? {};
  const v = (target: string, value: string) => cssVar(vars[target], value);
  const layout: CssDecl[] = [];
  const style: CssDecl[] = [];
  const typography: CssDecl[] = [];
  const size = n.size ?? { x: 0, y: 0 };
  const sizing = sizingOf(input);
  const auto = isAutoLayout(n);

  if (auto) layout.push({ property: "display", value: "flex" });
  if (sizing.width === "Fixed") layout.push({ property: "width", value: v("WIDTH", px(size.x)) });
  if (sizing.height === "Fixed") layout.push({ property: "height", value: v("HEIGHT", px(size.y)) });
  if (n.minSize?.value?.x) layout.push({ property: "min-width", value: v("MIN_WIDTH", px(n.minSize.value.x)) });
  if (n.maxSize?.value?.x) layout.push({ property: "max-width", value: v("MAX_WIDTH", px(n.maxSize.value.x)) });
  if (n.minSize?.value?.y) layout.push({ property: "min-height", value: v("MIN_HEIGHT", px(n.minSize.value.y)) });
  if (n.maxSize?.value?.y) layout.push({ property: "max-height", value: v("MAX_HEIGHT", px(n.maxSize.value.y)) });
  if (auto) {
    const p = paddingOf(n);
    const t = v("STACK_PADDING_TOP", px(p.top));
    const r = v("STACK_PADDING_RIGHT", px(p.right));
    const b = v("STACK_PADDING_BOTTOM", px(p.bottom));
    const l = v("STACK_PADDING_LEFT", px(p.left));
    if (p.top || p.right || p.bottom || p.left) {
      if (t === b && r === l) layout.push({ property: "padding", value: t === r ? t : `${t} ${r}` });
      else layout.push({ property: "padding", value: `${t} ${r} ${b} ${l}` });
    }
    layout.push({ property: "flex-direction", value: n.stackMode === "HORIZONTAL" ? "row" : "column" });
    const justify = JUSTIFY[n.stackPrimaryAlignItems ?? "MIN"] ?? "flex-start";
    if (justify !== "flex-start") layout.push({ property: "justify-content", value: justify });
    layout.push({ property: "align-items", value: ALIGN[n.stackCounterAlignItems ?? "MIN"] ?? "flex-start" });
    if (n.stackPrimaryAlignItems !== "SPACE_BETWEEN") layout.push({ property: "gap", value: v("STACK_SPACING", px(n.stackSpacing ?? 0)) });
    if (n.stackWrap === "WRAP") {
      layout.push({ property: "flex-wrap", value: "wrap" });
      if (n.stackCounterSpacing !== undefined) layout.push({ property: "row-gap", value: v("STACK_COUNTER_SPACING", px(n.stackCounterSpacing)) });
    }
  }
  const parent = input.parentStackMode;
  if ((parent === "HORIZONTAL" || parent === "VERTICAL") && n.stackPositioning !== "ABSOLUTE") {
    const primaryFill = parent === "HORIZONTAL" ? sizing.width === "Fill" : sizing.height === "Fill";
    const counterFill = parent === "HORIZONTAL" ? sizing.height === "Fill" : sizing.width === "Fill";
    if (primaryFill) layout.push({ property: "flex", value: "1 0 0" });
    if (counterFill) layout.push({ property: "align-self", value: "stretch" });
    if (!primaryFill) layout.push({ property: "flex-shrink", value: "0" });
  } else if (parent === "HORIZONTAL" || parent === "VERTICAL") {
    layout.push({ property: "position", value: "absolute" });
  }
  const rot = rotationOf(n);
  if (rot) layout.push({ property: "transform", value: `rotate(${num(-rot)}deg)` });

  const corners = cornersOf(n);
  if (corners && n.type !== "ELLIPSE" && n.type !== "TEXT") {
    const c = (target: string, value: number) => v(target, px(value));
    const tl = n.rectangleCornerRadiiIndependent ? c("RECTANGLE_TOP_LEFT_CORNER_RADIUS", corners.tl) : c("CORNER_RADIUS", corners.tl);
    if (!n.rectangleCornerRadiiIndependent) style.push({ property: "border-radius", value: tl });
    else
      style.push({
        property: "border-radius",
        value: `${tl} ${c("RECTANGLE_TOP_RIGHT_CORNER_RADIUS", corners.tr)} ${c("RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS", corners.br)} ${c("RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", corners.bl)}`,
      });
  } else if (n.type === "ELLIPSE") style.push({ property: "border-radius", value: `${px(Math.max(size.x, size.y))}` });

  const strokes = visiblePaints(n.strokePaints);
  const isText = n.type === "TEXT";
  if (strokes.length && (n.strokeWeight ?? 1) > 0) {
    const color = paintCss(strokes[0], input, "strokePaints", (n.strokePaints ?? []).indexOf(strokes[0])) ?? "currentColor";
    const kind = n.dashPattern?.length ? "dashed" : "solid";
    if (n.borderStrokeWeightsIndependent) {
      for (const [side, field, target] of [["top", n.borderTopWeight, "BORDER_TOP_WEIGHT"], ["right", n.borderRightWeight, "BORDER_RIGHT_WEIGHT"], ["bottom", n.borderBottomWeight, "BORDER_BOTTOM_WEIGHT"], ["left", n.borderLeftWeight, "BORDER_LEFT_WEIGHT"]] as const)
        if (field) style.push({ property: `border-${side}`, value: `${v(target, px(field))} ${kind} ${color}` });
    } else if (!isText) {
      style.push({ property: "border", value: `${v("STROKE_WEIGHT", px(n.strokeWeight ?? 1))} ${kind} ${color}` });
    }
  }
  if (n.opacity !== undefined && n.opacity < 1) style.push({ property: "opacity", value: v("OPACITY", num(n.opacity)) });
  const fills = visiblePaints(n.fillPaints);
  if (!isText && fills.length) {
    // CSS paints the first background on top: Figma's list is bottom first.
    const values = fills.map((p) => paintCss(p, input, "fillPaints", (n.fillPaints ?? []).indexOf(p))).filter((x): x is string => !!x);
    if (values.length) style.push({ property: "background", value: values.reverse().join(", ") });
  }
  const effects = visibleEffects(n.effects);
  const shadows = effects.filter((e) => e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW");
  if (shadows.length) style.push({ property: isText ? "text-shadow" : "box-shadow", value: shadows.map((e) => shadowCss(e, input, (n.effects ?? []).indexOf(e))).join(", ") });
  for (const e of effects) {
    // CSS's blur radius is half of Figma's.
    if (e.type === "FOREGROUND_BLUR") style.push({ property: "filter", value: `blur(${px((e.radius ?? 0) / 2)})` });
    if (e.type === "BACKGROUND_BLUR") style.push({ property: "backdrop-filter", value: `blur(${px((e.radius ?? 0) / 2)})` });
  }

  if (isText) {
    const t = typographyOf(n);
    const textFill = fills[0];
    if (textFill) {
      const color = paintCss(textFill, input, "fillPaints", (n.fillPaints ?? []).indexOf(textFill));
      if (color) typography.push({ property: "color", value: color });
    }
    if (t.align !== "LEFT") typography.push({ property: "text-align", value: t.align === "JUSTIFIED" ? "justify" : t.align.toLowerCase() });
    typography.push({ property: "font-family", value: v("FONT_FAMILY", /^[A-Za-z-]+$/.test(t.family) ? t.family : `"${t.family}"`) });
    typography.push({ property: "font-size", value: v("FONT_SIZE", px(t.size)) });
    typography.push({ property: "font-style", value: t.italic ? "italic" : "normal" });
    typography.push({ property: "font-weight", value: v("FONT_STYLE", String(t.weight)) });
    if (t.lineHeightPx === null) typography.push({ property: "line-height", value: "normal" });
    else typography.push({ property: "line-height", value: v("LINE_HEIGHT", px(t.lineHeightPx)), comment: `${num(t.lineHeightPercent!)}%` });
    if (t.letterSpacingPx) typography.push({ property: "letter-spacing", value: v("LETTER_SPACING", px(t.letterSpacingPx)) });
    if (t.textCase === "UPPER") typography.push({ property: "text-transform", value: "uppercase" });
    else if (t.textCase === "LOWER") typography.push({ property: "text-transform", value: "lowercase" });
    else if (t.textCase === "TITLE") typography.push({ property: "text-transform", value: "capitalize" });
    else if (t.textCase === "SMALL_CAPS" || t.textCase === "SMALL_CAPS_FORCED") typography.push({ property: "font-variant", value: "small-caps" });
    if (t.decoration === "UNDERLINE") typography.push({ property: "text-decoration-line", value: "underline" });
    else if (t.decoration === "STRIKETHROUGH") typography.push({ property: "text-decoration-line", value: "line-through" });
  }
  return { layout, style, typography, textStyle: isText ? input.styles?.text : undefined };
}

const line = (d: CssDecl) => `${d.property}: ${d.value};${d.comment ? ` /* ${d.comment} */` : ""}`;

/** One group as Dev Mode prints it. */
export function cssLines(decls: readonly CssDecl[], comment?: string): string {
  return [...(comment ? [`/* ${comment} */`] : []), ...decls.map(line)].join("\n");
}

/** The whole snippet as one text (what "Copy" puts on the clipboard with ⇧). */
export function cssText(input: InspectInput): string {
  const s = cssSnippet(input);
  return [cssLines(s.layout), cssLines(s.style), s.typography.length ? cssLines(s.typography, s.textStyle) : ""].filter(Boolean).join("\n\n");
}
