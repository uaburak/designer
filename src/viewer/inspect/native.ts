/**
 * Dev Mode's iOS (SwiftUI) and Android (Jetpack Compose) snippets for one layer, in the shape Figma prints them
 * (docs/research/figma/R9-dev-mode.md: a container stub with "// Child views…", then modifiers; Figma's own output is
 * the reference, its exact modifier order unverified). Units are Figma's px as points / dp, text sizes as sp.
 */
import type { Color } from "@/engine/codec";
import { cornersOf, isAutoLayout, num, paddingOf, sizingOf, typographyOf, visiblePaints, type BoundName, type InspectInput } from "./model";

const swiftColor = (c: Color, opacity = 1) => {
  const a = (c.a ?? 1) * opacity;
  return `Color(red: ${num(c.r)}, green: ${num(c.g)}, blue: ${num(c.b)}${a < 1 ? `, opacity: ${num(a)}` : ""})`;
};

const hexArgb = (c: Color, opacity = 1) =>
  [(c.a ?? 1) * opacity, c.r, c.g, c.b]
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, "0")
        .toUpperCase(),
    )
    .join("");

const composeColor = (c: Color, opacity = 1) => `Color(0x${hexArgb(c, opacity)})`;

/** A variable's name in a platform's code syntax, else Figma's camel-cased name ("Color/Primary" → colorPrimary). */
function platformName(bound: BoundName | undefined, platform: "iOS" | "ANDROID"): string | null {
  if (!bound) return null;
  const syntax = bound.codeSyntax?.[platform]?.trim();
  if (syntax) return syntax;
  const words = bound.name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1))).join("") || null;
}

const swiftString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

export function swiftUI(input: InspectInput): string {
  const n = input.node;
  const size = n.size ?? { x: 0, y: 0 };
  const sizing = sizingOf(input);
  const fill = visiblePaints(n.fillPaints)[0];
  const fillIndex = fill ? (n.fillPaints ?? []).indexOf(fill) : -1;
  const fillVar = fill ? platformName(input.variables?.[`fillPaints[${fillIndex}].color`], "iOS") : null;
  const fillColor = fill?.type === "SOLID" && fill.color ? (fillVar ? `Color(${swiftString(fillVar)})` : swiftColor(fill.color, fill.opacity ?? 1)) : null;
  const mods: string[] = [];
  let head: string;
  if (n.type === "TEXT") {
    const t = typographyOf(n);
    head = `Text(${swiftString(n.textData?.characters ?? "")})`;
    mods.push(`.font(Font.custom(${swiftString(`${t.family}-${t.style.replace(/\s+/g, "")}`)}, size: ${num(t.size)}))`);
    if (t.letterSpacingPx) mods.push(`.kerning(${num(t.letterSpacingPx)})`);
    if (t.align !== "LEFT") mods.push(`.multilineTextAlignment(.${t.align === "CENTER" ? "center" : t.align === "RIGHT" ? "trailing" : "leading"})`);
    if (fillColor) mods.push(`.foregroundColor(${fillColor})`);
    if (sizing.width === "Fixed") mods.push(`.frame(width: ${num(size.x)}${sizing.height === "Fixed" ? `, height: ${num(size.y)}` : ""}, alignment: .topLeading)`);
  } else if (isAutoLayout(n)) {
    const horizontal = n.stackMode === "HORIZONTAL";
    const counter = n.stackCounterAlignItems ?? "MIN";
    const align = horizontal ? (counter === "CENTER" ? "center" : counter === "MAX" ? "bottom" : "top") : counter === "CENTER" ? "center" : counter === "MAX" ? "trailing" : "leading";
    head = `${horizontal ? "HStack" : "VStack"}(alignment: .${align}, spacing: ${num(n.stackSpacing ?? 0)}) { // Child views... }`;
    const p = paddingOf(n);
    if (p.top === p.bottom && p.left === p.right && p.top === p.left) {
      if (p.top) mods.push(`.padding(${num(p.top)})`);
    } else {
      if (p.left === p.right && p.left) mods.push(`.padding(.horizontal, ${num(p.left)})`);
      if (p.top === p.bottom && p.top) mods.push(`.padding(.vertical, ${num(p.top)})`);
      if (p.left !== p.right) {
        if (p.left) mods.push(`.padding(.leading, ${num(p.left)})`);
        if (p.right) mods.push(`.padding(.trailing, ${num(p.right)})`);
      }
      if (p.top !== p.bottom) {
        if (p.top) mods.push(`.padding(.top, ${num(p.top)})`);
        if (p.bottom) mods.push(`.padding(.bottom, ${num(p.bottom)})`);
      }
    }
    const dims = [sizing.width === "Fixed" ? `width: ${num(size.x)}` : sizing.width === "Fill" ? "maxWidth: .infinity" : null, sizing.height === "Fixed" ? `height: ${num(size.y)}` : sizing.height === "Fill" ? "maxHeight: .infinity" : null].filter(Boolean);
    if (dims.length) mods.push(`.frame(${dims.join(", ")}, alignment: .topLeading)`);
    if (fillColor) mods.push(`.background(${fillColor})`);
  } else {
    head = n.type === "ELLIPSE" ? "Ellipse()" : "Rectangle()";
    mods.push(".foregroundColor(.clear)");
    mods.push(`.frame(width: ${num(size.x)}, height: ${num(size.y)})`);
    if (fillColor) mods.push(`.background(${fillColor})`);
  }
  const corners = cornersOf(n);
  if (corners && n.type !== "TEXT" && n.type !== "ELLIPSE") mods.push(`.cornerRadius(${num(corners.tl)})`);
  const stroke = visiblePaints(n.strokePaints)[0];
  if (stroke?.type === "SOLID" && stroke.color && n.type !== "TEXT")
    mods.push(`.overlay(\n  RoundedRectangle(cornerRadius: ${num(corners?.tl ?? 0)})\n    .inset(by: ${num((n.strokeWeight ?? 1) / 2)})\n    .stroke(${swiftColor(stroke.color, stroke.opacity ?? 1)}, lineWidth: ${num(n.strokeWeight ?? 1)})\n)`);
  if (n.opacity !== undefined && n.opacity < 1) mods.push(`.opacity(${num(n.opacity)})`);
  const shadow = (n.effects ?? []).find((e) => e.visible !== false && e.type === "DROP_SHADOW");
  if (shadow) mods.push(`.shadow(color: ${swiftColor(shadow.color ?? { r: 0, g: 0, b: 0, a: 0.25 })}, radius: ${num((shadow.radius ?? 0) / 2)}, x: ${num(shadow.offset?.x ?? 0)}, y: ${num(shadow.offset?.y ?? 0)})`);
  return [head, ...mods].join("\n");
}

const kotlinString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/\n/g, "\\n")}"`;

export function compose(input: InspectInput): string {
  const n = input.node;
  const size = n.size ?? { x: 0, y: 0 };
  const sizing = sizingOf(input);
  const corners = cornersOf(n);
  const shape = n.type === "ELLIPSE" ? "CircleShape" : corners ? `RoundedCornerShape(size = ${num(corners.tl)}.dp)` : null;
  const fill = visiblePaints(n.fillPaints)[0];
  const fillIndex = fill ? (n.fillPaints ?? []).indexOf(fill) : -1;
  const fillVar = fill ? platformName(input.variables?.[`fillPaints[${fillIndex}].color`], "ANDROID") : null;
  const fillColor = fill?.type === "SOLID" && fill.color ? (fillVar ?? composeColor(fill.color, fill.opacity ?? 1)) : null;
  const mod: string[] = [];
  const stroke = visiblePaints(n.strokePaints)[0];
  if (n.type !== "TEXT" && stroke?.type === "SOLID" && stroke.color) mod.push(`.border(width = ${num(n.strokeWeight ?? 1)}.dp, color = ${composeColor(stroke.color, stroke.opacity ?? 1)}${shape ? `, shape = ${shape}` : ""})`);
  if (sizing.width === "Fixed") mod.push(`.width(${num(size.x)}.dp)`);
  else if (sizing.width === "Fill") mod.push(".fillMaxWidth()");
  if (sizing.height === "Fixed") mod.push(`.height(${num(size.y)}.dp)`);
  else if (sizing.height === "Fill") mod.push(".fillMaxHeight()");
  if (n.type !== "TEXT" && fillColor) mod.push(`.background(color = ${fillColor}${shape ? `, shape = ${shape}` : ""})`);
  if (isAutoLayout(n)) {
    const p = paddingOf(n);
    if (p.top || p.right || p.bottom || p.left) mod.push(`.padding(start = ${num(p.left)}.dp, top = ${num(p.top)}.dp, end = ${num(p.right)}.dp, bottom = ${num(p.bottom)}.dp)`);
  }
  if (n.opacity !== undefined && n.opacity < 1) mod.push(`.alpha(${num(n.opacity)}f)`);
  const modifier = mod.length ? `modifier = Modifier\n    ${mod.join("\n    ")}` : null;
  if (n.type === "TEXT") {
    const t = typographyOf(n);
    const style = [
      `fontSize = ${num(t.size)}.sp`,
      t.lineHeightPx !== null ? `lineHeight = ${num(t.lineHeightPx)}.sp` : null,
      `fontFamily = FontFamily(Font(R.font.${t.family.toLowerCase().replace(/[^a-z0-9]+/g, "_")}))`,
      `fontWeight = FontWeight(${t.weight})`,
      fillColor ? `color = ${fillColor}` : null,
      t.align !== "LEFT" ? `textAlign = TextAlign.${t.align === "CENTER" ? "Center" : t.align === "RIGHT" ? "Right" : "Justify"}` : null,
      t.letterSpacingPx ? `letterSpacing = ${num(t.letterSpacingPx)}.sp` : null,
    ].filter(Boolean);
    return `Text(\n  text = ${kotlinString(n.textData?.characters ?? "")},\n  style = TextStyle(\n    ${style.join(",\n    ")},\n  )${modifier ? `,\n  ${modifier}` : ""}\n)`;
  }
  if (isAutoLayout(n)) {
    const horizontal = n.stackMode === "HORIZONTAL";
    const gap = num(n.stackSpacing ?? 0);
    const counter = n.stackCounterAlignItems ?? "MIN";
    const arrangement = horizontal
      ? `horizontalArrangement = Arrangement.spacedBy(${gap}.dp, Alignment.Start)`
      : `verticalArrangement = Arrangement.spacedBy(${gap}.dp, Alignment.Top)`;
    const alignment = horizontal
      ? `verticalAlignment = Alignment.${counter === "CENTER" ? "CenterVertically" : counter === "MAX" ? "Bottom" : "Top"}`
      : `horizontalAlignment = Alignment.${counter === "CENTER" ? "CenterHorizontally" : counter === "MAX" ? "End" : "Start"}`;
    return `${horizontal ? "Row" : "Column"}(\n  ${arrangement},\n  ${alignment}${modifier ? `,\n  ${modifier}` : ""}\n) {\n  // Child views.\n}`;
  }
  return `Box(${modifier ? `\n  ${modifier}\n` : ""})`;
}
