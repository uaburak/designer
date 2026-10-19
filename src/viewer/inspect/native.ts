/**
 * Dev Mode's iOS (SwiftUI) and Android (Jetpack Compose) code for one layer, as Figma's first-party generators write
 * it (docs/research/atlas/14-dev-mode.md §6, §8).
 *
 * SwiftUI: one section named after its view (HStack, VStack, ZStack, Rectangle, Text, Image) — the view line, then
 * its modifiers in Figma's order (font, kerning, underline, strikethrough, multilineTextAlignment, foregroundColor,
 * padding, frame, position, background, cornerRadius, shadow, overlay border, blur, rotation, opacity last), at column
 * 0 after a stack's `{ ... }` and one level in under a shape, text or image; colours are `.black` / `.white` or
 * `Color(red:green:blue:)` with `.opacity()`; bound variables are `Constants.<name>` and listed in a "Variables" section.
 *
 * Compose: a "Modifier" section (`Modifier`, then alpha, offset, shadow, blur, border, width and height, rotation,
 * backgrounds, padding last), a "Layout" stub for auto layout (Row / Column with their arrangement and alignment),
 * "Text" (a `Text(` with its `TextStyle`), "Image" for vectors and image fills, and "Variables" (`object Variables`).
 *
 * Numbers have 5 decimals and are written in px; units.ts divides them for pt / dp. What Figma can't express in a
 * language carries a hint (§4.1).
 */
import type { Color, Effect, NodeChange, Paint } from "@/engine/codec";
import { COLLAPSE_AFTER, sectionsText, type CodeLine, type CodeSection, type Hint } from "./code";
import { camelName, cornersOf, gradientHandles, gradientAngle, isAutoLayout, isTextLike, isTransformGroup, paddingOf, rotationOf, round, sizingOf, typographyOf, visibleEffects, visiblePaints, type BoundName, type InspectInput } from "./model";

/** Figma's `hX`: 5 decimals, no unit. */
const n5 = (v: number) => round(v, 5);
/** `+v.toFixed(2)`: at most 2 decimals, trailing zeros dropped. */
const n2 = (v: number) => String(+v.toFixed(2));

const isVectorClass = (n: NodeChange) => n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION" || n.type === "STAR" || n.type === "REGULAR_POLYGON";
const isShape = (n: NodeChange) => n.type === "RECTANGLE" || n.type === "ROUNDED_RECTANGLE" || n.type === "ELLIPSE" || n.type === "LINE";
const isFrameLike = (n: NodeChange) => n.type === "FRAME" || n.type === "GROUP" || n.type === "SYMBOL" || n.type === "INSTANCE" || n.type === "SECTION" || isTransformGroup(n);

/** An absolute child of an auto layout: SwiftUI's `.position`, Compose's `.offset`. */
const isAbsolute = (input: InspectInput) => {
  const mode = input.parentStackMode ?? input.parent?.stackMode;
  return (mode === "HORIZONTAL" || mode === "VERTICAL") && input.node.stackPositioning === "ABSOLUTE";
};

/** A variable bound to a value, by its platform name; collected for the "Variables" section. */
interface Constant {
  name: string;
  type: string | null;
  value: string;
}

class Bindings {
  readonly constants: Constant[] = [];
  constructor(
    private readonly input: InspectInput,
    private readonly platform: "iOS" | "ANDROID",
  ) {}

  /** The variable's code syntax, else `Constants.<name>` / `Variables.<name>` (and a constant to list). */
  use(target: string, type: string | null, value: string): string {
    const bound: BoundName | undefined = this.input.variables?.[target];
    if (!bound) return value;
    const syntax = bound.codeSyntax?.[this.platform]?.trim();
    if (syntax) return syntax;
    const name = camelName(bound.name);
    if (!this.constants.some((c) => c.name === name)) this.constants.push({ name, type, value });
    return `${this.platform === "iOS" ? "Constants" : "Variables"}.${name}`;
  }
}

const section = (name: string, language: CodeSection["language"], lines: CodeLine[]): CodeSection => ({ name, language, lines, collapseAfterIndex: COLLAPSE_AFTER });
const L = (code: string, indent = 0, hint?: Hint): CodeLine => ({ code, indent, ...(hint ? { hint } : {}) });

// ---- SwiftUI ----------------------------------------------------------------------------------------------------------

/** SwiftUI's colour (`t1`): `.black` / `.white`, else its components to 2 decimals; alpha × opacity as `.opacity()`. */
export function swiftColor(c: Color, opacity = 1): string {
  const near = (v: number, to: number) => Math.abs(v - to) < 1e-5;
  const base = near(c.r, 0) && near(c.g, 0) && near(c.b, 0) ? ".black" : near(c.r, 1) && near(c.g, 1) && near(c.b, 1) ? ".white" : `Color(red: ${n2(c.r)}, green: ${n2(c.g)}, blue: ${n2(c.b)})`;
  const a = (c.a ?? 1) * opacity;
  return a !== 1 ? `${base}.opacity(${n2(a)})` : base;
}

const SWIFT_WEIGHT: Record<number, string> = { 100: "thin", 200: "ultraLight", 300: "light", 400: "regular", 500: "medium", 600: "semibold", 700: "bold", 800: "heavy", 900: "black" };
const swiftString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

/** A paint as a SwiftUI view or colour, its lines one level in from `indent` (`t3`, `t4`, `t6`, `t7`). */
function swiftPaint(p: Paint, i: number, size: { x: number; y: number }, vars: Bindings, indent: number): CodeLine[] | null {
  const opacity = p.opacity ?? 1;
  if (p.type === "SOLID" && p.color) return [L(vars.use(`fillPaints[${i}].color`, "Color", swiftColor(p.color, opacity)), indent)];
  if (p.type?.startsWith("GRADIENT_")) {
    const h = gradientHandles(p, { x: 1, y: 1 });
    const point = (q: { x: number; y: number }) => `UnitPoint(x: ${n2(q.x)}, y: ${n2(q.y)})`;
    const stops = [L("stops: [", indent + 1), ...(p.stops ?? []).map((s) => L(`Gradient.Stop(color: ${swiftColor(s.color, opacity)}, location: ${s.position.toFixed(2)}),`, indent + 2)), L("],", indent + 1)];
    if (p.type === "GRADIENT_LINEAR")
      return [L("LinearGradient(", indent), ...stops, L(`startPoint: ${point(h?.start ?? { x: 0, y: 0.5 })},`, indent + 1), L(`endPoint: ${point(h?.end ?? { x: 1, y: 0.5 })}`, indent + 1), L(")", indent)];
    if (p.type === "GRADIENT_ANGULAR")
      return [L("AngularGradient(", indent), ...stops, L(`center: ${point(h?.center ?? { x: 0.5, y: 0.5 })},`, indent + 1), L(`angle: Angle(degrees: ${n2(gradientAngle(p, size) - 90)})`, indent + 1), L(")", indent)];
    return [L("EllipticalGradient(", indent), ...stops, L(`center: ${point(h?.center ?? { x: 0.5, y: 0.5 })}`, indent + 1), L(")", indent)];
  }
  if (p.type === "IMAGE") {
    const mode = p.imageScaleMode ?? "FILL";
    const out = [L('Image("PATH_TO_IMAGE")', indent)];
    if (mode === "FIT") out.push(L(".resizable()", indent + 1), L(".aspectRatio(contentMode: .fit)", indent + 1));
    else if (mode === "TILE") out.push(L(".resizable(resizingMode: .tile)", indent + 1));
    else out.push(L(".resizable()", indent + 1), L(".aspectRatio(contentMode: .fill)", indent + 1), L(`.frame(width: ${n5(size.x)}, height: ${n5(size.y)})`, indent + 1), L(".clipped()", indent + 1));
    if (opacity !== 1) out.push(L(`.opacity(${round(opacity, 4)})`, indent + 1));
    return out;
  }
  return null;
}

/** A stack's `.frame` alignment from its primary × counter alignment; a text's from its horizontal × vertical one. */
function swiftAlignment(h: "leading" | "center" | "trailing", v: "top" | "center" | "bottom"): string {
  if (v === "center") return h === "center" ? ".center" : `.${h}`;
  return h === "center" ? `.${v}` : `.${v}${h[0].toUpperCase()}${h.slice(1)}`;
}
const H_OF: Record<string, "leading" | "center" | "trailing"> = { MIN: "leading", CENTER: "center", MAX: "trailing", LEFT: "leading", RIGHT: "trailing", JUSTIFIED: "leading" };
const V_OF: Record<string, "top" | "center" | "bottom"> = { MIN: "top", CENTER: "center", MAX: "bottom", TOP: "top", BOTTOM: "bottom" };

/** SwiftUI's code: the view's section, then "Variables" when constants were used. */
export function swiftUISections(input: InspectInput): CodeSection[] {
  const n = input.node;
  const vars = new Bindings(input, "iOS");
  const size = n.size ?? { x: 0, y: 0 };
  const sizing = sizingOf(input);
  const text = isTextLike(n);
  const auto = isAutoLayout(n);
  const fills = visiblePaints(n.fillPaints);
  const effects = visibleEffects(n.effects);
  const head: CodeLine[] = [];
  let name: string;
  let indent: number;
  if (text) {
    name = "Text";
    indent = 1;
    if (input.styles?.text) head.push(L(`// ${input.styles.text}`));
    head.push(L(`Text(${swiftString(n.textData?.characters ?? "")})`));
  } else if (auto) {
    const horizontal = n.stackMode === "HORIZONTAL";
    const counter = n.stackCounterAlignItems ?? "MIN";
    const align = horizontal ? ({ MIN: "top", CENTER: "center", MAX: "bottom", BASELINE: "firstTextBaseline" } as Record<string, string>)[counter] : ({ MIN: "leading", CENTER: "center", MAX: "trailing" } as Record<string, string>)[counter];
    name = horizontal ? "HStack" : "VStack";
    indent = 0;
    const primary = n.stackPrimaryAlignItems ?? "MIN";
    const spread = primary === "SPACE_EVENLY" || primary === "SPACE_BETWEEN" ? "Space Between" : primary === "SPACE_AROUND" ? "Space Around" : primary === "SPACE_EVENLY_CSS" ? "Space Evenly" : null;
    if (spread) {
      // Space between / around / evenly: views and spacers (the exact lines are ours; atlas 14 §6 names only the comments).
      const hint: Hint = { id: "swift_ui_spacers_for_space_between" };
      head.push(L(`${name}(alignment: .${align ?? "center"}) {`, 0, hint), L(`// ${spread}`, 1));
      if (spread !== "Space Between") head.push(L("Spacer()", 1));
      head.push(L("// Alternating Views and Spacers", 1), L("View()", 1), L("Spacer()", 1), L("View()", 1));
      if (spread !== "Space Between") head.push(L("Spacer()", 1));
      head.push(L("}"));
    } else head.push(L(`${name}(alignment: .${align ?? "center"}, spacing: ${vars.use("STACK_SPACING", "CGFloat", n5(n.stackSpacing ?? 0))}) { ... }`));
  } else if (isVectorClass(n)) {
    name = "Image";
    indent = 1;
    head.push(L(`Image(${swiftString(n.name ?? "")})`));
  } else if (isShape(n) || !isFrameLike(n)) {
    name = "Rectangle";
    indent = 1;
    // A shape with effects whose colour is hidden is a plain View [atlas 14 §6]; ours always draws Rectangle.
    head.push(L("Rectangle()"));
  } else {
    name = "ZStack";
    indent = 0;
    head.push(L("ZStack { ... }"));
  }
  const mods: CodeLine[] = [];
  const m = (code: string, hint?: Hint, extra = 0) => mods.push(L(code, indent + extra, hint));

  if (text) {
    const t = typographyOf(n);
    const font = `Font.custom(${vars.use("FONT_FAMILY", "String", swiftString(t.family))}, size: ${vars.use("FONT_SIZE", "CGFloat", n5(t.size))})`;
    const parts = [...(t.weight !== 400 ? [`.weight(.${SWIFT_WEIGHT[Math.round(t.weight / 100) * 100] ?? "regular"})`] : []), ...(t.italic ? [".italic()"] : [])];
    if (!parts.length) m(`.font(${font})`);
    else {
      m(".font(");
      m(font, undefined, 1);
      for (const p of parts) m(p, undefined, 2);
      m(")");
    }
    if (t.letterSpacingPx > 0) m(`.kerning(${vars.use("LETTER_SPACING", "CGFloat", n5(t.letterSpacingPx))})`);
    if (t.decoration === "UNDERLINE") {
      const style = (n as NodeChange & { textDecorationStyle?: string }).textDecorationStyle;
      m(style && style !== "SOLID" ? `.underline(true, pattern: .${style === "DOTTED" ? "dot" : "solid"})` : ".underline()");
    } else if (t.decoration === "STRIKETHROUGH") m(".strikethrough()");
    if (t.align === "CENTER" || t.align === "RIGHT") m(`.multilineTextAlignment(.${t.align === "CENTER" ? "center" : "trailing"})`);
    const fill = fills[0];
    if (fill?.type === "SOLID" && fill.color) m(`.foregroundColor(${vars.use(`fillPaints[${(n.fillPaints ?? []).indexOf(fill)}].color`, "Color", swiftColor(fill.color, fill.opacity ?? 1))})`);
  } else if (name === "Rectangle") m(".foregroundColor(.clear)");

  if (auto) {
    const p = paddingOf(n);
    const pv = (target: string, v: number) => vars.use(target, "CGFloat", n5(v));
    if (p.top === p.bottom && p.left === p.right && p.top === p.left) {
      if (p.top) m(`.padding(${pv("STACK_PADDING_TOP", p.top)})`);
    } else {
      if (p.left === p.right) {
        if (p.left) m(`.padding(.horizontal, ${pv("STACK_PADDING_LEFT", p.left)})`);
      } else {
        if (p.left) m(`.padding(.leading, ${pv("STACK_PADDING_LEFT", p.left)})`);
        if (p.right) m(`.padding(.trailing, ${pv("STACK_PADDING_RIGHT", p.right)})`);
      }
      if (p.top === p.bottom) {
        if (p.top) m(`.padding(.vertical, ${pv("STACK_PADDING_TOP", p.top)})`);
      } else {
        if (p.top) m(`.padding(.top, ${pv("STACK_PADDING_TOP", p.top)})`);
        if (p.bottom) m(`.padding(.bottom, ${pv("STACK_PADDING_BOTTOM", p.bottom)})`);
      }
    }
  }

  // .frame: fixed axes as width / height, or as min = max beside a filling axis (maxWidth: .infinity).
  const fillsAxis = sizing.width === "Fill" || sizing.height === "Fill";
  const w = vars.use("WIDTH", "CGFloat", n5(size.x));
  const h = vars.use("HEIGHT", "CGFloat", n5(size.y));
  const dims = fillsAxis
    ? [sizing.width === "Fixed" ? `minWidth: ${w}, maxWidth: ${w}` : sizing.width === "Fill" ? "maxWidth: .infinity" : null, sizing.height === "Fixed" ? `minHeight: ${h}, maxHeight: ${h}` : sizing.height === "Fill" ? "maxHeight: .infinity" : null]
    : [sizing.width === "Fixed" ? `width: ${w}` : null, sizing.height === "Fixed" ? `height: ${h}` : null];
  const present = dims.filter(Boolean);
  if (present.length) {
    let alignment = "";
    if (auto) {
      const horizontal = n.stackMode === "HORIZONTAL";
      const primary = n.stackPrimaryAlignItems ?? "MIN";
      const counter = n.stackCounterAlignItems ?? "MIN";
      alignment = horizontal ? swiftAlignment(H_OF[primary] ?? "leading", V_OF[counter] ?? "top") : swiftAlignment(H_OF[counter] ?? "leading", V_OF[primary] ?? "top");
    } else if (text) alignment = swiftAlignment(H_OF[n.textAlignHorizontal ?? "LEFT"] ?? "leading", V_OF[n.textAlignVertical ?? "TOP"] ?? "top");
    m(`.frame(${present.join(", ")}${alignment ? `, alignment: ${alignment}` : ""})`);
  }

  if (isAbsolute(input)) m(`.position(x:${n5((n.transform?.m02 ?? 0) + size.x / 2)}, y:${n5((n.transform?.m12 ?? 0) + size.y / 2)})`);

  if (!text && !isVectorClass(n)) {
    const backgrounds = name === "Rectangle" && fills.length > 1 ? fills.slice(0, 1) : fills;
    const single: Hint | undefined = name === "Rectangle" && fills.length > 1 ? { id: "swift_ui_only_single_fill_for_shapes" } : undefined;
    for (const p of backgrounds) {
      const lines = swiftPaint(p, (n.fillPaints ?? []).indexOf(p), size, vars, indent + 1);
      if (!lines) continue;
      if (lines.length === 1) m(`.background(${lines[0].code})`, single);
      else {
        m(".background(", single);
        mods.push(...lines);
        m(")");
      }
    }
  }

  const corners = cornersOf(n);
  const radius = corners ? Math.max(corners.tl, corners.tr, corners.br, corners.bl) : 0;
  if (corners && !text && n.type !== "ELLIPSE") {
    const uneven = corners.tl !== corners.tr || corners.tr !== corners.br || corners.br !== corners.bl;
    m(`.cornerRadius(${vars.use("CORNER_RADIUS", "CGFloat", n5(radius))})`, uneven ? { id: "swift_ui_separate_corner_radius" } : undefined);
  }

  for (const e of effects.filter((x) => x.type === "DROP_SHADOW"))
    m(`.shadow(color: ${swiftColor(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 })}, radius: ${n5((e.radius ?? 0) / 2)}, x: ${n5(e.offset?.x ?? 0)}, y: ${n5(e.offset?.y ?? 0)})`, e.spread ? { id: "swift_ui_blur_no_spread" } : undefined);

  const stroke = visiblePaints(n.strokePaints)[0];
  if (stroke?.type === "SOLID" && stroke.color && !text) {
    const sides = n.borderStrokeWeightsIndependent ? [n.borderTopWeight ?? 0, n.borderRightWeight ?? 0, n.borderBottomWeight ?? 0, n.borderLeftWeight ?? 0] : [n.strokeWeight ?? 1];
    const weight = Math.max(...sides);
    const uneven = sides.some((s) => s !== weight);
    const color = vars.use(`strokePaints[${(n.strokePaints ?? []).indexOf(stroke)}].color`, "Color", swiftColor(stroke.color, stroke.opacity ?? 1));
    const lw = vars.use("STROKE_WEIGHT", "CGFloat", n5(weight));
    m(".overlay(", uneven ? { id: "swift_ui_separate_border_width" } : undefined);
    m(radius ? `RoundedRectangle(cornerRadius: ${n5(radius)})` : "Rectangle()", undefined, 1);
    const align = n.strokeAlign ?? "INSIDE";
    if (align === "INSIDE") m(`.inset(by: ${n5(weight / 2)})`, undefined, 2);
    else if (align === "OUTSIDE") m(`.inset(by: ${n5(-weight / 2)})`, undefined, 2);
    m(n.dashPattern?.length ? `.stroke(${color}, style: StrokeStyle(lineWidth: ${lw}, dash: [${n.dashPattern.map(n5).join(", ")}]))` : `.stroke(${color}, lineWidth: ${lw})`, undefined, 2);
    m(")");
  }

  for (const e of effects) {
    if (e.type === "FOREGROUND_BLUR") m(`.blur(radius: ${n5((e.radius ?? 0) / 2)})`);
    else if (e.type === "BACKGROUND_BLUR") m(`.blur(radius: ${n5((e.radius ?? 0) / 2)})`, { id: "swift_ui_background_blur" });
  }

  const rot = rotationOf(n);
  if (rot) m(`.rotationEffect(Angle(degrees: ${n2(-rot)}))`);
  if (n.opacity !== undefined && n.opacity !== 1) m(`.opacity(${vars.use("OPACITY", null, round(n.opacity, 4))})`);

  const sections = [section(name, "swift", [...head, ...mods])];
  if (vars.constants.length) sections.push(section("Variables", "swift", [L("struct Constants {"), ...vars.constants.map((c) => L(`static let ${c.name}${c.type ? `: ${c.type}` : ""} = ${c.value}`, 1)), L("}")]));
  return sections;
}

export const swiftUI = (input: InspectInput): string => sectionsText(swiftUISections(input));

// ---- Compose ----------------------------------------------------------------------------------------------------------

/** Compose's colour (`M2`): `Color(0xAARRGGBB)`, alpha = the colour's alpha × the paint's opacity. */
export function composeColor(c: Color, opacity = 1): string {
  const byte = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `Color(0x${byte((c.a ?? 1) * opacity)}${byte(c.r)}${byte(c.g)}${byte(c.b)})`;
}

const kotlinString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/\n/g, "\\n")}"`;
const snake = (s: string) => camelName(s).replace(/([A-Z])/g, "_$1").replace(/(\d+)/g, "_$1").toLowerCase().replace(/^_/, "");

/** Compose's code: Modifier, the Layout stub, Text, Image, Variables. */
export function composeSections(input: InspectInput): CodeSection[] {
  const n = input.node;
  const vars = new Bindings(input, "ANDROID");
  const size = n.size ?? { x: 0, y: 0 };
  const text = isTextLike(n);
  const dp = (target: string, v: number) => (input.variables?.[target] ? vars.use(target, "Dp", `${n5(v)}.dp`) : `${n5(v)}.dp`);
  const corners = cornersOf(n);
  const shape = !corners
    ? null
    : corners.tl === corners.tr && corners.tr === corners.br && corners.br === corners.bl
      ? `RoundedCornerShape(size = ${dp("CORNER_RADIUS", corners.tl)})`
      : `RoundedCornerShape(topStart = ${n5(corners.tl)}.dp, topEnd = ${n5(corners.tr)}.dp, bottomStart = ${n5(corners.bl)}.dp, bottomEnd = ${n5(corners.br)}.dp)`;
  const mod: CodeLine[] = [];
  const m = (code: string, hint?: Hint) => mod.push(L(code, 1, hint));

  if (n.opacity !== undefined && n.opacity !== 1) m(`.alpha(${input.variables?.OPACITY ? vars.use("OPACITY", null, `${round(n.opacity, 4)}f`) : `${round(n.opacity, 4)}f`})`);
  if (isAbsolute(input)) m(`.offset(x = ${n5(n.transform?.m02 ?? 0)}.dp, y = ${n5(n.transform?.m12 ?? 0)}.dp)`);
  const effects = visibleEffects(n.effects);
  for (const e of effects.filter((x) => x.type === "DROP_SHADOW")) {
    const c = composeColor(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 });
    m(`.shadow(elevation = ${n5(e.radius ?? 0)}.dp, spotColor = ${c}, ambientColor = ${c})`, { id: "compose_shadow_incompatibility" });
  }
  for (const e of effects.filter((x: Effect) => x.type === "FOREGROUND_BLUR")) m(`.blur(radius = ${n5(e.radius ?? 0)}.dp)`, { id: "compose_blur_tip" });
  const stroke = visiblePaints(n.strokePaints)[0];
  if (!text && stroke?.type === "SOLID" && stroke.color) {
    const sides = n.borderStrokeWeightsIndependent ? [n.borderTopWeight ?? 0, n.borderRightWeight ?? 0, n.borderBottomWeight ?? 0, n.borderLeftWeight ?? 0] : [n.strokeWeight ?? 1];
    const weight = Math.max(...sides);
    const color = vars.use(`strokePaints[${(n.strokePaints ?? []).indexOf(stroke)}].color`, "Color", composeColor(stroke.color, stroke.opacity ?? 1));
    m(`.border(width = ${dp("STROKE_WEIGHT", weight)}, color = ${color}${shape ? `, shape = ${shape}` : ""})`, sides.some((s) => s !== weight) ? { id: "compose_separate_border_width" } : undefined);
    const align = n.strokeAlign ?? "INSIDE";
    if (align === "CENTER") m(`.padding(${n5(weight / 2)}.dp)`);
    else if (align === "OUTSIDE") m(`.padding(${n5(weight)}.dp)`);
  }
  m(`.width(${dp("WIDTH", size.x)})`);
  m(`.height(${dp("HEIGHT", size.y)})`);
  const rot = rotationOf(n);
  if (rot) m(`.rotate(degrees = ${n2(-rot)}f)`);
  if (!text && !isVectorClass(n))
    for (const p of visiblePaints(n.fillPaints)) {
      if (p.type !== "SOLID" || !p.color) continue;
      const color = vars.use(`fillPaints[${(n.fillPaints ?? []).indexOf(p)}].color`, "Color", composeColor(p.color, p.opacity ?? 1));
      m(`.background(color = ${color}${shape ? `, shape = ${shape}` : ""})`);
    }
  if (isAutoLayout(n)) {
    const p = paddingOf(n);
    const parts = [
      p.left ? `start = ${dp("STACK_PADDING_LEFT", p.left)}` : null,
      p.top ? `top = ${dp("STACK_PADDING_TOP", p.top)}` : null,
      p.right ? `end = ${dp("STACK_PADDING_RIGHT", p.right)}` : null,
      p.bottom ? `bottom = ${dp("STACK_PADDING_BOTTOM", p.bottom)}` : null,
    ].filter(Boolean);
    if (parts.length) m(`.padding(${parts.join(", ")})`);
  }
  const sections = [section("Modifier", "kotlin", [L("Modifier"), ...mod])];

  if (isAutoLayout(n)) {
    const horizontal = n.stackMode === "HORIZONTAL";
    const primary = n.stackPrimaryAlignItems ?? "MIN";
    const counter = n.stackCounterAlignItems ?? "MIN";
    const along = horizontal ? ({ MIN: "Start", CENTER: "CenterHorizontally", MAX: "End" } as Record<string, string>) : ({ MIN: "Top", CENTER: "CenterVertically", MAX: "Bottom" } as Record<string, string>);
    const arrangement =
      primary === "SPACE_BETWEEN" || primary === "SPACE_EVENLY"
        ? "Arrangement.SpaceBetween"
        : primary === "SPACE_AROUND"
          ? "Arrangement.SpaceAround"
          : primary === "SPACE_EVENLY_CSS"
            ? "Arrangement.SpaceEvenly"
            : `Arrangement.spacedBy(${dp("STACK_SPACING", n.stackSpacing ?? 0)}, Alignment.${along[primary] ?? along.MIN})`;
    const alignment = horizontal
      ? `verticalAlignment = Alignment.${counter === "CENTER" ? "CenterVertically" : counter === "MAX" ? "Bottom" : "Top"},`
      : `horizontalAlignment = Alignment.${counter === "CENTER" ? "CenterHorizontally" : counter === "MAX" ? "End" : "Start"},`;
    sections.push(section("Layout", "kotlin", [L(`${horizontal ? "Row" : "Column"}(`), L(`${horizontal ? "horizontalArrangement" : "verticalArrangement"} = ${arrangement},`, 1), L(alignment, 1), L(") {"), L("// Child views.", 1), L("}")]));
  }

  if (text) {
    const t = typographyOf(n);
    const fill = visiblePaints(n.fillPaints)[0];
    const sp = (target: string, v: number) => (input.variables?.[target] ? vars.use(target, "Sp", `${n2(v)}.sp`) : `${n2(v)}.sp`);
    const style = [
      `fontSize = ${sp("FONT_SIZE", t.size)},`,
      t.lineHeightPx !== null ? `lineHeight = ${sp("LINE_HEIGHT", t.lineHeightPx)},` : null,
      `fontFamily = FontFamily(Font(R.font.${snake(t.family)})),`,
      `fontWeight = FontWeight(${Math.round(t.weight / 100) * 100}),`,
      t.italic ? "fontStyle = FontStyle.Italic," : null,
      fill?.type === "SOLID" && fill.color ? `color = ${vars.use(`fillPaints[${(n.fillPaints ?? []).indexOf(fill)}].color`, "Color", composeColor(fill.color, fill.opacity ?? 1))},` : null,
      t.align === "RIGHT" || t.align === "CENTER" || t.align === "JUSTIFIED" ? `textAlign = TextAlign.${t.align === "CENTER" ? "Center" : t.align === "RIGHT" ? "Right" : "Justify"},` : null,
      t.letterSpacingPx > 0 ? `letterSpacing = ${sp("LETTER_SPACING", t.letterSpacingPx)},` : null,
      t.decoration === "UNDERLINE" ? "textDecoration = TextDecoration.Underline," : t.decoration === "STRIKETHROUGH" ? "textDecoration = TextDecoration.LineThrough," : null,
    ].filter((x): x is string => !!x);
    sections.push(
      section("Text", "kotlin", [
        L("Text("),
        L(`text = ${kotlinString(n.textData?.characters ?? "")},`, 1),
        ...(input.styles?.text ? [L("", 1), L(`// ${input.styles.text}`, 1)] : []),
        L("style = TextStyle(", 1),
        ...style.map((s) => L(s, 2)),
        L(")", 1),
        L(")"),
      ]),
    );
  }

  const image = visiblePaints(n.fillPaints).find((p) => p.type === "IMAGE");
  if (isVectorClass(n) || image) {
    const scale = !image ? "None" : ({ FIT: "Fit", FILL: "Crop", STRETCH: "FillBounds", TILE: "None" } as Record<string, string>)[image.imageScaleMode ?? "FILL"];
    sections.push(section("Image", "kotlin", [L("Image("), L(`painter = painterResource(id = R.drawable.${camelName(n.name ?? "image")}),`, 1), L('contentDescription = "image description",', 1), L(`contentScale = ContentScale.${scale}`, 1), L(")")]));
  }

  if (vars.constants.length) sections.push(section("Variables", "kotlin", [L("object Variables {"), ...vars.constants.map((c) => L(`val ${c.name}${c.type ? `: ${c.type}` : ""} = ${c.value}`, 1)), L("}")]));
  return sections;
}

export const compose = (input: InspectInput): string => sectionsText(composeSections(input));
