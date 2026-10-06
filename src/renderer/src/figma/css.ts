import type { CSSProperties } from "react";
import type { DesignVariable, InteractionAnimation, VariableValue } from "@/types/design";
import { cssValue } from "@/components/project/designVariables";
import { durationOf, easingCss, type Timing } from "@/components/project/interactions";
import { isFrameLike, type FrameNode, type LayoutMode, type Paint, type SceneNode, type ShapeNode, type StrokeStyle, type TextNode } from "./model";

/**
 * A node as CSS — the same on the editor's canvas and on the site: a frame
 * with auto layout is a flex box, one without places its children by their
 * x, y; fills, strokes (as box shadows, so they never change the size, as in
 * Figma), corners, effects; a text's typography. Colours bound to variables
 * become `var(--…)`, so the site's themes apply (see DesignSystemStyle).
 */

const px = (value: VariableValue | undefined, byId: Map<string, DesignVariable>) => (value ? cssValue(value, "number", byId) ?? "0px" : "0px");

/** A colour at an opacity: a variable's through color-mix, so its theme value still applies. */
export function colorCss(color: VariableValue, opacity: number | undefined, byId: Map<string, DesignVariable>): string | null {
  const base = cssValue(color, "color", byId);
  if (!base) return null;
  const alpha = opacity === undefined ? 100 : Math.max(0, Math.min(100, opacity));
  if (alpha >= 100) return base;
  return `color-mix(in srgb, ${base} ${alpha}%, transparent)`;
}

const shownPaints = (paints: readonly Paint[] | undefined) => (paints ?? []).filter((p) => p.visible !== false);

/** One fill as a background layer: a solid colour, a linear gradient, or an image. */
function paintLayer(p: Paint, byId: Map<string, DesignVariable>): { image: string; size?: string; repeat?: string; solid?: string } | null {
  if (p.type === "gradient" && p.gradient) {
    const alpha = p.opacity === undefined ? 100 : p.opacity;
    const stops = [...p.gradient.stops].sort((a, b) => a.position - b.position).map((s) => `${alpha >= 100 ? s.color : colorWithAlpha(s.color, alpha)} ${s.position}%`);
    return { image: `linear-gradient(${p.gradient.angle}deg, ${stops.join(", ")})` };
  }
  if (p.type === "image" && p.image?.url) {
    const fit = p.image.fit;
    return { image: `url("${p.image.url}")`, size: fit === "fit" ? "contain" : fit === "tile" ? "auto" : "cover", repeat: fit === "tile" ? "repeat" : "no-repeat" };
  }
  const c = colorCss(p.color, p.opacity, byId);
  return c ? { image: `linear-gradient(${c}, ${c})`, solid: c } : null;
}

/** Fills as a background: one colour, or several layered (the first on top, as Figma lists them). */
export function fillsCss(fills: readonly Paint[] | undefined, byId: Map<string, DesignVariable>): CSSProperties {
  const layers = shownPaints(fills).map((p) => paintLayer(p, byId)).filter((l): l is NonNullable<typeof l> => Boolean(l));
  if (layers.length === 0) return {};
  if (layers.length === 1 && layers[0].solid) return { backgroundColor: layers[0].solid };
  return {
    backgroundImage: layers.map((l) => l.image).join(", "),
    backgroundSize: layers.map((l) => l.size ?? "auto").join(", "),
    backgroundRepeat: layers.map((l) => l.repeat ?? "no-repeat").join(", "),
    backgroundPosition: "center",
  };
}

function strokeShadows(strokes: readonly StrokeStyle[] | undefined, byId: Map<string, DesignVariable>): string[] {
  return (strokes ?? [])
    .filter((s) => s.visible !== false)
    .flatMap((s) => {
      const color = colorCss(s.color, s.opacity, byId);
      const weight = px(s.weight, byId);
      if (!color) return [];
      if (s.align === "outside") return [`0 0 0 ${weight} ${color}`];
      if (s.align === "center") return [`inset 0 0 0 calc(${weight} / 2) ${color}`, `0 0 0 calc(${weight} / 2) ${color}`];
      return [`inset 0 0 0 ${weight} ${color}`];
    });
}

function effectShadows(node: FrameNode | ShapeNode): string[] {
  return (node.effects ?? [])
    .filter((e) => e.visible !== false)
    .flatMap((e) => (e.type === "dropShadow" || e.type === "innerShadow" ? [`${e.type === "innerShadow" ? "inset " : ""}${e.x}px ${e.y}px ${e.blur}px ${e.spread}px ${colorWithAlpha(e.color, e.opacity)}`] : []));
}

/** The blurs: a layer blur on the node itself, a background blur behind it. */
function effectBlurs(node: FrameNode | ShapeNode): CSSProperties {
  const style: CSSProperties = {};
  for (const e of (node.effects ?? []).filter((x) => x.visible !== false)) {
    if (e.type === "layerBlur") style.filter = `blur(${e.radius}px)`;
    if (e.type === "backgroundBlur") style.backdropFilter = `blur(${e.radius}px)`;
  }
  return style;
}

/** #rrggbb at an opacity (0–100) as rgba. */
export function colorWithAlpha(hex: string, opacity: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(100, opacity)) / 100})`;
}

function radiusCss(node: FrameNode | ShapeNode, byId: Map<string, DesignVariable>): string | undefined {
  if (node.type === "ellipse") return "50%";
  if (node.corners) return node.corners.map((c) => px(c, byId)).join(" ");
  return node.cornerRadius ? px(node.cornerRadius, byId) : undefined;
}

/** How a child sizes and sits in its parent — its own place when the parent has no auto layout, its flex sizing otherwise. */
function placement(node: SceneNode, parentLayout: LayoutMode, byId: Map<string, DesignVariable>, textAuto?: TextNode["textAutoResize"]): CSSProperties {
  const style: CSSProperties = {};
  const hugW = node.sizingH === "hug" || (node.type === "text" && textAuto === "widthHeight");
  const hugH = node.sizingV === "hug" || (node.type === "text" && textAuto !== "none");
  const limits = (st: CSSProperties) => {
    // Constrained proportions on a layer as wide as its frame lets it (Fill): its height follows its width.
    if (node.lockAspect && node.sizingH === "fill" && !hugH && node.sizingV !== "fill" && node.width > 0 && node.height > 0 && parentLayout !== "none" && !node.absolute) {
      st.height = "auto";
      st.aspectRatio = `${node.width} / ${node.height}`;
    }
    if (node.minWidth !== undefined) st.minWidth = node.minWidth;
    if (node.maxWidth !== undefined) st.maxWidth = node.maxWidth;
    if (node.minHeight !== undefined) st.minHeight = node.minHeight;
    if (node.maxHeight !== undefined) st.maxHeight = node.maxHeight;
    if (node.widthVar && !hugW) st.width = px(node.widthVar, byId);
    if (node.heightVar && !hugH) st.height = px(node.heightVar, byId);
    return st;
  };
  if (parentLayout === "none" || node.absolute) {
    style.position = "absolute";
    style.left = node.x;
    style.top = node.y;
    style.width = hugW ? "max-content" : node.width;
    style.height = hugH ? "auto" : node.height;
    return limits(style);
  }
  style.position = "relative";
  style.flexShrink = 0;
  if (parentLayout === "grid") {
    // Its cell, when it was put in one; the columns it covers.
    const span = Math.max(1, Math.round(node.gridSpan ?? 1));
    if (node.gridCol) style.gridColumn = `${Math.round(node.gridCol)} / span ${span}`;
    else if (span > 1) style.gridColumn = `span ${span}`;
    if (node.gridRow) style.gridRow = String(Math.round(node.gridRow));
    style.width = hugW ? "max-content" : node.sizingH === "fill" ? undefined : node.width;
    style.height = hugH ? "auto" : node.sizingV === "fill" ? undefined : node.height;
    if (node.sizingH === "fill") style.justifySelf = "stretch";
    if (node.sizingV === "fill") style.alignSelf = "stretch";
    return limits(style);
  }
  const along = parentLayout === "horizontal" ? "H" : "V";
  const fillW = node.sizingH === "fill";
  const fillH = node.sizingV === "fill";
  style.width = hugW ? "max-content" : fillW ? undefined : node.width;
  style.height = hugH ? "auto" : fillH ? undefined : node.height;
  // Across the flow, Fill stretches — unless a max size caps it: a stretched item stays at the start
  // once capped, so a capped one takes the whole width instead and sits where the parent aligns it.
  if (fillW) {
    if (along === "H") {
      style.flexGrow = node.grow ?? 1;
      style.flexBasis = 0;
      style.minWidth = 0;
    } else if (node.maxWidth !== undefined) style.width = "100%";
    else style.alignSelf = "stretch";
  }
  if (fillH) {
    if (along === "V") {
      style.flexGrow = node.grow ?? 1;
      style.flexBasis = 0;
      style.minHeight = 0;
    } else if (node.maxHeight !== undefined) style.height = "100%";
    else style.alignSelf = "stretch";
  }
  if (hugW && node.type !== "text") style.width = "max-content";
  return limits(style);
}

const JUSTIFY: Record<FrameNode["primaryAlign"], CSSProperties["justifyContent"]> = { min: "flex-start", center: "center", max: "flex-end", spaceBetween: "space-between" };
const ALIGN: Record<FrameNode["counterAlign"], CSSProperties["alignItems"]> = { min: "flex-start", center: "center", max: "flex-end" };

/** A frame's own layout: its auto layout as flex, or the box its children are placed in. */
export function frameLayoutCss(frame: FrameNode, byId: Map<string, DesignVariable>): CSSProperties {
  const style: CSSProperties = {
    boxSizing: "border-box",
    paddingTop: px(frame.paddingTop, byId),
    paddingRight: px(frame.paddingRight, byId),
    paddingBottom: px(frame.paddingBottom, byId),
    paddingLeft: px(frame.paddingLeft, byId),
  };
  if (frame.layoutMode === "none") return style;
  if (frame.layoutMode === "grid") {
    style.display = "grid";
    // Equal columns sharing the width (as the site's grids of cards) unless sized one by one: Fill children stretch into them.
    const cols = Math.max(1, frame.gridColumns ?? 2);
    style.gridTemplateColumns = frame.gridTracks?.length === cols ? frame.gridTracks.join(" ") : `repeat(${cols}, minmax(0, 1fr))`;
    if (frame.gridRows) style.gridTemplateRows = frame.gridRowTracks?.length === frame.gridRows ? frame.gridRowTracks.join(" ") : `repeat(${frame.gridRows}, auto)`;
    style.columnGap = px(frame.itemSpacing, byId);
    style.rowGap = px(frame.counterSpacing ?? frame.itemSpacing, byId);
    style.justifyContent = JUSTIFY[frame.primaryAlign];
    style.alignItems = ALIGN[frame.counterAlign];
    style.justifyItems = ALIGN[frame.counterAlign] === "flex-start" ? "start" : ALIGN[frame.counterAlign] === "flex-end" ? "end" : "center";
    return style;
  }
  style.display = "flex";
  style.flexDirection = frame.layoutMode === "horizontal" ? "row" : "column";
  style.gap = px(frame.itemSpacing, byId);
  style.justifyContent = JUSTIFY[frame.primaryAlign];
  style.alignItems = frame.baselineAlign && frame.layoutMode === "horizontal" ? "baseline" : ALIGN[frame.counterAlign];
  if (frame.layoutWrap && frame.layoutMode === "horizontal") {
    style.flexWrap = "wrap";
    style.alignContent = ALIGN[frame.counterAlign];
    if (frame.counterSpacing) style.rowGap = px(frame.counterSpacing, byId);
  }
  return style;
}

/** Everything a node draws with, at its place in `parentLayout`. */
export function nodeCss(node: SceneNode, parentLayout: LayoutMode, byId: Map<string, DesignVariable>): CSSProperties {
  const style: CSSProperties = { ...placement(node, parentLayout, byId, node.type === "text" ? node.textAutoResize : undefined) };
  if (node.visible === false) style.display = "none";
  if (node.opacity !== undefined && node.opacity < 100) style.opacity = Math.max(0, node.opacity) / 100;
  if (node.blendMode && node.blendMode !== "pass-through" && node.blendMode !== "normal") style.mixBlendMode = node.blendMode;
  else if (node.blendMode === "normal") style.isolation = "isolate";
  const transforms = [node.rotation ? `rotate(${node.rotation}deg)` : "", node.flipH ? "scaleX(-1)" : "", node.flipV ? "scaleY(-1)" : ""].filter(Boolean);
  if (transforms.length) {
    style.transform = transforms.join(" ");
    style.transformOrigin = "center";
  }
  if (node.type === "text") {
    Object.assign(style, textCss(node, byId));
    return style;
  }
  const bordered = (node.strokes ?? []).filter((s) => s.visible !== false && (s.sides || s.dashed));
  const shadows = [...strokeShadows((node.strokes ?? []).filter((s) => !(s.sides || s.dashed)), byId), ...effectShadows(node)];
  if (shadows.length) style.boxShadow = shadows.join(", ");
  // A stroke on some sides only, or dashed: drawn as borders (inside the box).
  for (const s of bordered) {
    const color = colorCss(s.color, s.opacity, byId) ?? "#000";
    const line = `${px(s.weight, byId)} ${s.dashed ? "dashed" : "solid"} ${color}`;
    const sides = s.sides ?? { top: true, right: true, bottom: true, left: true };
    if (sides.top) style.borderTop = line;
    if (sides.right) style.borderRight = line;
    if (sides.bottom) style.borderBottom = line;
    if (sides.left) style.borderLeft = line;
    style.boxSizing = "border-box";
  }
  Object.assign(style, effectBlurs(node));
  const radius = radiusCss(node, byId);
  if (radius) style.borderRadius = radius;
  if (node.type === "line") {
    // A line: its stroke drawn as its own height.
    const stroke = (node.strokes ?? []).find((s) => s.visible !== false);
    style.height = 0;
    style.boxShadow = undefined;
    style.borderTop = stroke ? `${px(stroke.weight, byId)} solid ${colorCss(stroke.color, stroke.opacity, byId) ?? "#000"}` : undefined;
    return style;
  }
  Object.assign(style, fillsCss(node.fills, byId));
  if (isFrameLike(node)) {
    Object.assign(style, frameLayoutCss(node, byId));
    // A hidden frame stays hidden (its auto layout's display: flex must not show it).
    if (node.visible === false) style.display = "none";
    if (node.clipsContent) style.overflow = "hidden";
  }
  return style;
}

const WEIGHT_NAMES: Record<number, string> = { 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold" };
export const weightLabel = (w: number) => WEIGHT_NAMES[w] ?? String(w);

/** A text's typography and its colour (its first fill). */
export function textCss(node: TextNode, byId: Map<string, DesignVariable>): CSSProperties {
  // In a text style, its typography comes from the style's CSS rule (see textStylesCss).
  const styled = Boolean(node.textStyle);
  const style: CSSProperties = {
    fontSize: styled ? undefined : px(node.fontSize, byId),
    fontWeight: styled || !node.fontWeight ? undefined : cssValue(node.fontWeight, "weight", byId) ?? undefined,
    lineHeight: styled ? undefined : node.lineHeight ? px(node.lineHeight, byId) : "normal",
    letterSpacing: styled ? undefined : node.letterSpacing ? px(node.letterSpacing, byId) : undefined,
    textAlign: node.textAlign,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    margin: 0,
  };
  const color = shownPaints(node.fills)[0];
  if (color) style.color = colorCss(color.color, color.opacity, byId) ?? undefined;
  if (node.textAutoResize === "none") style.overflow = "hidden";
  if (node.textCase) style.textTransform = node.textCase === "upper" ? "uppercase" : node.textCase === "lower" ? "lowercase" : "capitalize";
  if (node.textDecoration) style.textDecoration = node.textDecoration === "underline" ? "underline" : "line-through";
  if (node.verticalAlign && node.verticalAlign !== "top" && node.textAutoResize === "none") {
    style.display = "flex";
    style.flexDirection = "column";
    style.justifyContent = node.verticalAlign === "middle" ? "center" : "flex-end";
  }
  return style;
}

/** A prototype animation's CSS on an instance's frame (see MOTION_CSS in interactions.ts). */
export function motionCss(reaction: Timing & { animation: InteractionAnimation }): CSSProperties {
  if (reaction.animation === "instant") return {};
  return { "--motion-duration": `${durationOf(reaction)}ms`, "--motion-easing": easingCss(reaction) } as CSSProperties;
}
