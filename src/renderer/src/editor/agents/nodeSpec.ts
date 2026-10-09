/**
 * The agents' layer vocabulary (src/shared/agents/tools.ts: the Plugin API's names — layoutMode, itemSpacing,
 * layoutSizingHorizontal, characters, fontSize …) translated to and from the document's fields (schema/document.kiwi
 * names: stackMode, stackSpacing, stackChildPrimaryGrow, textData …). Pure functions: tested without the engine.
 */
import type { Color, Effect, Matrix, NodeChange, NodeFields, NodeType, Paint } from "@/engine/codec";

export type Spec = Record<string, unknown>;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** "123-456" (a link's node-id) → "123:456"; anything else as it is. */
export const normId = (id: unknown): string => {
  const s = typeof id === "string" ? id.trim() : "";
  return /^\d+-\d+$/.test(s) ? s.replace("-", ":") : s;
};

// ---- Colours and paints ---------------------------------------------------------------------------------------------

export function parseColor(v: unknown): Color | null {
  if (typeof v !== "string") return null;
  let h = v.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3,4}$/i.test(h)) h = [...h].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) {
    const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v.trim());
    if (!m) return null;
    return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: m[4] === undefined ? 1 : +m[4] };
  }
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

export function colorHex(c: Color | undefined, opacity = 1): string {
  if (!c) return "#000000";
  const b = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
  const a = (c.a ?? 1) * opacity;
  return `#${b(c.r)}${b(c.g)}${b(c.b)}${a < 0.999 ? b(a) : ""}`.toUpperCase();
}

export const solid = (c: Color): Paint => ({ type: "SOLID", color: { ...c, a: 1 }, opacity: c.a ?? 1, visible: true, blendMode: "NORMAL" });

/** An image hash as hex (the engine gives 20 numbers or a hex string). */
export function imageHash(p: Paint): string | null {
  const h = p.image?.hash;
  if (typeof h === "string") return h.toLowerCase();
  if (Array.isArray(h)) return h.map((x) => (x & 255).toString(16).padStart(2, "0")).join("");
  return null;
}

/** "#hex" | [paint spec] → paints; null when it can't be read. */
export function parsePaints(v: unknown): Paint[] | null {
  if (v === null || (Array.isArray(v) && v.length === 0)) return [];
  if (typeof v === "string") {
    const c = parseColor(v);
    return c ? [solid(c)] : null;
  }
  if (!Array.isArray(v)) return null;
  const out: Paint[] = [];
  for (const p of v as Spec[]) {
    if (typeof p === "string") {
      const c = parseColor(p);
      if (c) out.push(solid(c));
      continue;
    }
    if (!p || typeof p !== "object") continue;
    const type = str(p.type)?.toUpperCase() ?? (p.imageRef || p.imageHash ? "IMAGE" : "SOLID");
    if (type === "SOLID") {
      const c = parseColor(p.color);
      if (!c) continue;
      out.push({ ...solid(c), opacity: (num(p.opacity) ?? 1) * (c.a ?? 1), visible: p.visible !== false });
    } else if (type === "IMAGE") {
      const hash = str(p.imageRef) ?? str(p.imageHash);
      if (!hash || !/^[0-9a-f]{40}$/i.test(hash)) continue;
      const mode = str(p.scaleMode)?.toUpperCase();
      out.push({ type: "IMAGE", image: { hash: hash.toLowerCase() }, imageScaleMode: (mode === "FIT" || mode === "CROP" || mode === "TILE" ? (mode === "CROP" ? "STRETCH" : mode) : "FILL") as Paint["imageScaleMode"], opacity: num(p.opacity) ?? 1, visible: true, blendMode: "NORMAL" });
    } else if (type.startsWith("GRADIENT_") && Array.isArray(p.stops)) {
      const stops = (p.stops as Spec[]).map((s) => ({ color: parseColor(s.color) ?? { r: 0, g: 0, b: 0, a: 1 }, position: num(s.position) ?? 0 }));
      out.push({ type, stops, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, opacity: num(p.opacity) ?? 1, visible: true, blendMode: "NORMAL" });
    }
  }
  return out;
}

/** Paints as the agent reads them. */
export function describePaints(paints: readonly Paint[] | undefined): unknown[] | undefined {
  if (!paints?.length) return undefined;
  return paints.map((p) => {
    const hidden = p.visible === false ? { visible: false } : {};
    if (p.type === "SOLID") return { type: "SOLID", color: colorHex(p.color, p.opacity ?? 1), ...hidden, ...(p.colorVar ? { boundVariable: true } : {}) };
    if (p.type === "IMAGE") return { type: "IMAGE", imageRef: imageHash(p), scaleMode: p.imageScaleMode ?? "FILL", ...(p.originalImageWidth ? { imageSize: { width: p.originalImageWidth, height: p.originalImageHeight } } : {}), ...hidden };
    if (String(p.type).startsWith("GRADIENT")) return { type: p.type, stops: (p.stops ?? []).map((s) => ({ color: colorHex(s.color), position: +s.position.toFixed(3) })), ...hidden };
    return { type: p.type, ...hidden };
  });
}

function parseEffects(v: unknown): Effect[] | null {
  if (!Array.isArray(v)) return null;
  return (v as Spec[]).flatMap((e): Effect[] => {
    const type = str(e?.type)?.toUpperCase();
    if (type === "DROP_SHADOW" || type === "INNER_SHADOW") {
      const o = (e.offset ?? {}) as Spec;
      return [{ type, color: parseColor(e.color) ?? { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: num(o.x) ?? 0, y: num(o.y) ?? 4 }, radius: num(e.radius) ?? 4, spread: num(e.spread) ?? 0, visible: e.visible !== false, blendMode: "NORMAL" }];
    }
    if (type === "LAYER_BLUR" || type === "FOREGROUND_BLUR" || type === "BACKGROUND_BLUR") return [{ type: type === "BACKGROUND_BLUR" ? "BACKGROUND_BLUR" : "FOREGROUND_BLUR", radius: num(e.radius) ?? 4, visible: e.visible !== false }];
    return [];
  });
}

// ---- Geometry -------------------------------------------------------------------------------------------------------

export const IDENTITY: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

export const rotationOf = (t: Matrix | undefined) => (t ? Math.round(((Math.atan2(t.m10, t.m00) * 180) / Math.PI) * 100) / 100 : 0);

export function matrixAt(x: number, y: number, degrees: number): Matrix {
  const r = (degrees * Math.PI) / 180;
  const c = Math.round(Math.cos(r) * 1e9) / 1e9;
  const s = Math.round(Math.sin(r) * 1e9) / 1e9;
  return { m00: c, m01: -s, m02: x, m10: s, m11: c, m12: y };
}

// ---- Auto layout ----------------------------------------------------------------------------------------------------

const HUG = "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE";
export const isHug = (v: unknown) => v === undefined || v === "RESIZE_TO_FIT" || v === HUG;

export type Axis = "H" | "V";
export type Sizing = "FIXED" | "HUG" | "FILL";

/** A layer's sizing on an axis, as the Plugin API's layoutSizingHorizontal / Vertical reads it. */
export function sizingOf(n: NodeChange, parent: NodeChange | null, axis: Axis): Sizing {
  const pMode = parent?.stackMode && parent.stackMode !== "NONE" && parent.stackMode !== "GRID" ? parent.stackMode : null;
  if (pMode && n.stackPositioning !== "ABSOLUTE") {
    const primary = (pMode === "HORIZONTAL") === (axis === "H");
    if (primary ? (n.stackChildPrimaryGrow ?? 0) > 0 : n.stackChildAlignSelf === "STRETCH") return "FILL";
  }
  const own = n.stackMode && n.stackMode !== "NONE" ? n.stackMode : null;
  if (own) {
    const primary = (own === "HORIZONTAL") === (axis === "H");
    return isHug(primary ? n.stackPrimarySizing : n.stackCounterSizing) ? "HUG" : "FIXED";
  }
  if (n.type === "TEXT") {
    const r = n.textAutoResize ?? "NONE";
    if (r === "WIDTH_AND_HEIGHT") return "HUG";
    if (r === "HEIGHT" && axis === "V") return "HUG";
  }
  return "FIXED";
}

/** Fields that make a layer FIXED / HUG / FILL on an axis (its own type and auto layout, and its parent's). */
export function sizingFields(n: NodeChange, parent: NodeChange | null, axis: Axis, sizing: Sizing): NodeFields {
  const out: NodeFields = {};
  const pMode = parent?.stackMode && parent.stackMode !== "NONE" && parent.stackMode !== "GRID" ? parent.stackMode : null;
  const ownMode = (n.stackMode && n.stackMode !== "NONE" ? n.stackMode : null) as "HORIZONTAL" | "VERTICAL" | null;
  if (pMode) {
    const primary = (pMode === "HORIZONTAL") === (axis === "H");
    if (primary) out.stackChildPrimaryGrow = sizing === "FILL" ? 1 : 0;
    else out.stackChildAlignSelf = sizing === "FILL" ? "STRETCH" : "AUTO";
  }
  if (ownMode) {
    const primary = (ownMode === "HORIZONTAL") === (axis === "H");
    const key = primary ? "stackPrimarySizing" : "stackCounterSizing";
    out[key] = sizing === "HUG" ? HUG : "FIXED";
  }
  if (n.type === "TEXT") {
    const r = (n.textAutoResize ?? "NONE") as string;
    if (axis === "H") out.textAutoResize = sizing === "HUG" ? "WIDTH_AND_HEIGHT" : r === "WIDTH_AND_HEIGHT" ? "HEIGHT" : (r as NodeFields["textAutoResize"]);
    else out.textAutoResize = sizing === "HUG" ? (r === "WIDTH_AND_HEIGHT" ? "WIDTH_AND_HEIGHT" : "HEIGHT") : r === "NONE" ? "NONE" : r === "WIDTH_AND_HEIGHT" ? "WIDTH_AND_HEIGHT" : "NONE";
  }
  return out;
}

const PRIMARY_ALIGN = new Set(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]);
const COUNTER_ALIGN = new Set(["MIN", "CENTER", "MAX", "BASELINE"]);

/** The auto layout container fields of a spec (layoutMode, itemSpacing, padding …). */
export function autoLayoutFields(spec: Spec, current: NodeChange | null): NodeFields {
  const out: NodeFields = {};
  const mode = str(spec.layoutMode)?.toUpperCase();
  if (mode === "HORIZONTAL" || mode === "VERTICAL" || mode === "NONE") out.stackMode = mode;
  const effective = out.stackMode ?? current?.stackMode ?? "NONE";
  if (num(spec.itemSpacing) !== undefined) out.stackSpacing = num(spec.itemSpacing);
  const pad = spec.padding;
  if (typeof pad === "number" || Array.isArray(pad)) {
    const [t, r, b, l] = typeof pad === "number" ? [pad, pad, pad, pad] : (pad as number[]).length === 2 ? [pad[0], pad[1], pad[0], pad[1]] : (pad as number[]);
    Object.assign(out, { stackVerticalPadding: +t || 0, stackPaddingRight: +r || 0, stackPaddingBottom: +b || 0, stackHorizontalPadding: +l || 0 });
  }
  for (const [k, f] of [["paddingTop", "stackVerticalPadding"], ["paddingRight", "stackPaddingRight"], ["paddingBottom", "stackPaddingBottom"], ["paddingLeft", "stackHorizontalPadding"]] as const) if (num(spec[k]) !== undefined) out[f] = num(spec[k]);
  const pa = str(spec.primaryAxisAlignItems)?.toUpperCase();
  if (pa && PRIMARY_ALIGN.has(pa)) out.stackPrimaryAlignItems = pa as NodeFields["stackPrimaryAlignItems"];
  const ca = str(spec.counterAxisAlignItems)?.toUpperCase();
  if (ca && COUNTER_ALIGN.has(ca)) out.stackCounterAlignItems = ca as NodeFields["stackCounterAlignItems"];
  const wrap = str(spec.layoutWrap)?.toUpperCase();
  if (wrap === "WRAP" || wrap === "NO_WRAP") out.stackWrap = wrap;
  if (num(spec.counterAxisSpacing) !== undefined) out.stackCounterSpacing = num(spec.counterAxisSpacing);
  const ps = str(spec.primaryAxisSizingMode)?.toUpperCase();
  if (ps === "AUTO" || ps === "FIXED") out.stackPrimarySizing = ps === "AUTO" ? HUG : "FIXED";
  const cs = str(spec.counterAxisSizingMode)?.toUpperCase();
  if (cs === "AUTO" || cs === "FIXED") out.stackCounterSizing = cs === "AUTO" ? HUG : "FIXED";
  // A frame turned into auto layout without sizing modes: hug the layout direction, keep the other (Figma's ⇧A on a frame keeps its size; an agent's new stack wants to hug).
  if (out.stackMode && out.stackMode !== "NONE" && (!current?.stackMode || current.stackMode === "NONE")) {
    out.stackPrimarySizing ??= current ? "FIXED" : HUG;
    out.stackCounterSizing ??= "FIXED";
  }
  if (effective === "NONE") delete out.stackWrap;
  return out;
}

// ---- Text -----------------------------------------------------------------------------------------------------------

function parseLineHeight(v: unknown): NodeFields["lineHeight"] | undefined {
  if (typeof v === "number") return { value: v, units: "PIXELS" };
  if (typeof v !== "string") return undefined;
  if (/^auto$/i.test(v.trim())) return { value: 100, units: "PERCENT" };
  const m = /^([\d.]+)\s*%$/.exec(v.trim());
  if (m) return { value: +m[1] / 100, units: "RAW" };
  const px = /^([\d.]+)\s*(px)?$/.exec(v.trim());
  return px ? { value: +px[1], units: "PIXELS" } : undefined;
}

function parseLetterSpacing(v: unknown): NodeFields["letterSpacing"] | undefined {
  if (typeof v === "number") return { value: v, units: "PIXELS" };
  if (typeof v !== "string") return undefined;
  const m = /^(-?[\d.]+)\s*(%|px)?$/.exec(v.trim());
  return m ? { value: +m[1], units: m[2] === "%" ? "PERCENT" : "PIXELS" } : undefined;
}

export function describeLineHeight(v: NodeChange["lineHeight"]): string | number {
  if (!v || (v.units === "PERCENT" && v.value === 100)) return "auto";
  if (v.units === "RAW") return `${Math.round(v.value * 1000) / 10}%`;
  if (v.units === "PERCENT") return `${v.value}%`;
  return v.value;
}

// ---- Specs → fields -------------------------------------------------------------------------------------------------

const TYPES: Record<string, NodeType> = { FRAME: "FRAME", RECTANGLE: "ROUNDED_RECTANGLE", ROUNDED_RECTANGLE: "ROUNDED_RECTANGLE", ELLIPSE: "ELLIPSE", TEXT: "TEXT", LINE: "LINE", GROUP: "GROUP" };
export const nodeTypeOf = (v: unknown): NodeType | null => TYPES[String(v ?? "").toUpperCase()] ?? null;

/** Defaults of a new layer (Figma's: a white frame that clips, #D9D9D9 shapes, black Inter text). */
export function defaults(type: NodeType): NodeFields {
  switch (type) {
    case "FRAME":
      return { fillPaints: [solid({ r: 1, g: 1, b: 1, a: 1 })], frameMaskDisabled: false, size: { x: 100, y: 100 } };
    case "TEXT":
      return { fillPaints: [solid({ r: 0, g: 0, b: 0, a: 1 })], fontName: { family: "Inter", style: "Regular", postscript: "" }, fontSize: 16, textAutoResize: "WIDTH_AND_HEIGHT", size: { x: 100, y: 20 }, autoRename: true };
    case "LINE":
      return { strokePaints: [solid({ r: 0, g: 0, b: 0, a: 1 })], strokeWeight: 1, size: { x: 100, y: 0 } };
    case "GROUP":
      return { size: { x: 100, y: 100 } };
    default:
      return { fillPaints: [solid({ r: 0xd9 / 255, g: 0xd9 / 255, b: 0xd9 / 255, a: 1 })], size: { x: 100, y: 100 } };
  }
}

/**
 * A spec's fields on `node` (its current fields; for a new layer, its defaults and type) under `parent`. Errors are
 * collected, not thrown: a bad colour is skipped and named.
 */
export function fieldsOf(spec: Spec, node: NodeChange, parent: NodeChange | null, errors: string[] = []): NodeFields {
  const out: NodeFields = {};
  if (str(spec.name) !== undefined) out.name = str(spec.name);
  if (typeof spec.visible === "boolean") out.visible = spec.visible;
  if (num(spec.opacity) !== undefined) out.opacity = Math.max(0, Math.min(1, num(spec.opacity)!));
  const size = { x: node.size?.x ?? 0, y: node.size?.y ?? 0 };
  if (num(spec.width) !== undefined) size.x = Math.max(node.type === "LINE" ? 0 : 0.01, num(spec.width)!);
  if (num(spec.height) !== undefined) size.y = Math.max(0, num(spec.height)!);
  if (num(spec.width) !== undefined || num(spec.height) !== undefined) out.size = size;
  const t = node.transform ?? IDENTITY;
  const x = num(spec.x) ?? t.m02;
  const y = num(spec.y) ?? t.m12;
  const rot = num(spec.rotation) ?? rotationOf(t);
  if (num(spec.x) !== undefined || num(spec.y) !== undefined || num(spec.rotation) !== undefined) out.transform = matrixAt(x, y, -rot);
  for (const [key, field] of [["fills", "fillPaints"], ["strokes", "strokePaints"]] as const) {
    if (spec[key] === undefined) continue;
    const p = parsePaints(spec[key]);
    if (p) out[field] = p;
    else errors.push(`${key}: not a colour or a paint list`);
  }
  if (num(spec.strokeWeight) !== undefined) out.strokeWeight = num(spec.strokeWeight);
  const cr = spec.cornerRadius;
  if (typeof cr === "number" || (Array.isArray(cr) && cr.length === 4)) {
    const [tl, tr, br, bl] = typeof cr === "number" ? [cr, cr, cr, cr] : (cr as number[]).map((v) => +v || 0);
    Object.assign(out, { cornerRadius: tl, rectangleCornerRadiiIndependent: !(tl === tr && tr === br && br === bl), rectangleTopLeftCornerRadius: tl, rectangleTopRightCornerRadius: tr, rectangleBottomRightCornerRadius: br, rectangleBottomLeftCornerRadius: bl });
  }
  if (typeof spec.clipsContent === "boolean") out.frameMaskDisabled = !spec.clipsContent;
  if (spec.effects !== undefined) {
    const e = parseEffects(spec.effects);
    if (e) out.effects = e;
  }
  // Text.
  if (node.type === "TEXT") {
    if (typeof spec.characters === "string") out.textData = { characters: spec.characters };
    if (str(spec.fontFamily) || str(spec.fontStyle)) out.fontName = { family: str(spec.fontFamily) ?? node.fontName?.family ?? "Inter", style: str(spec.fontStyle) ?? node.fontName?.style ?? "Regular", postscript: "" };
    if (num(spec.fontSize) !== undefined) out.fontSize = Math.max(1, num(spec.fontSize)!);
    const lh = parseLineHeight(spec.lineHeight);
    if (lh) out.lineHeight = lh;
    const ls = parseLetterSpacing(spec.letterSpacing);
    if (ls) out.letterSpacing = ls;
    const ta = str(spec.textAlignHorizontal)?.toUpperCase();
    if (ta === "LEFT" || ta === "CENTER" || ta === "RIGHT" || ta === "JUSTIFIED") out.textAlignHorizontal = ta;
    const ar = str(spec.textAutoResize)?.toUpperCase();
    if (ar === "NONE" || ar === "WIDTH_AND_HEIGHT" || ar === "HEIGHT") out.textAutoResize = ar;
    // A width given to an auto-width text makes it wrap there (Figma).
    else if (num(spec.width) !== undefined && (node.textAutoResize ?? "NONE") === "WIDTH_AND_HEIGHT") out.textAutoResize = "HEIGHT";
  }
  // Auto layout, as a container (frames).
  if (node.type === "FRAME" || node.type === "SYMBOL" || node.type === "INSTANCE") Object.assign(out, autoLayoutFields(spec, node));
  // As a child, and its sizing.
  const pos = str(spec.layoutPositioning)?.toUpperCase();
  if (pos === "AUTO" || pos === "ABSOLUTE") out.stackPositioning = pos;
  const after = { ...node, ...out } as NodeChange;
  for (const [key, axis] of [["layoutSizingHorizontal", "H"], ["layoutSizingVertical", "V"]] as const) {
    const s = str(spec[key])?.toUpperCase();
    if (s !== "FIXED" && s !== "HUG" && s !== "FILL") continue;
    if (s === "FILL" && !(parent?.stackMode && parent.stackMode !== "NONE")) {
      errors.push(`${key}: FILL needs an auto layout parent`);
      continue;
    }
    if (s === "HUG" && !(after.stackMode && after.stackMode !== "NONE") && after.type !== "TEXT") {
      errors.push(`${key}: HUG needs an auto layout frame or a text`);
      continue;
    }
    Object.assign(out, sizingFields({ ...after, ...out } as NodeChange, parent, axis, s));
  }
  const minW = num(spec.minWidth);
  const maxW = num(spec.maxWidth);
  if (minW !== undefined) out.minSize = { value: { x: minW, y: node.minSize?.value.y ?? 0 } };
  if (maxW !== undefined) out.maxSize = { value: { x: maxW, y: node.maxSize?.value.y ?? 0 } };
  return out;
}

// ---- Fields → what the agent reads ----------------------------------------------------------------------------------

const round = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 100) / 100);

/** The type as the Plugin API names it. */
export const typeName = (t: string | undefined) => (t === "ROUNDED_RECTANGLE" ? "RECTANGLE" : t === "SYMBOL" ? "COMPONENT" : t === "CANVAS" ? "PAGE" : (t ?? "NONE"));

/** One layer's design, in the tools' vocabulary (get_design_context). */
export function describeNode(n: NodeChange, parent: NodeChange | null): Record<string, unknown> {
  const t = n.transform ?? IDENTITY;
  const out: Record<string, unknown> = { id: n.guid, name: n.name, type: typeName(n.type) };
  if (n.type !== "CANVAS") Object.assign(out, { x: round(t.m02), y: round(t.m12), width: round(n.size?.x), height: round(n.size?.y) });
  const rot = rotationOf(t);
  if (rot) out.rotation = -rot;
  if (n.visible === false) out.visible = false;
  if (n.opacity !== undefined && n.opacity < 1) out.opacity = round(n.opacity);
  const fills = describePaints(n.fillPaints);
  if (fills) out.fills = fills;
  const strokes = describePaints(n.strokePaints);
  if (strokes) Object.assign(out, { strokes, strokeWeight: n.strokeWeight ?? 1, strokeAlign: n.strokeAlign ?? "INSIDE" });
  if (n.rectangleCornerRadiiIndependent) out.cornerRadius = [n.rectangleTopLeftCornerRadius ?? 0, n.rectangleTopRightCornerRadius ?? 0, n.rectangleBottomRightCornerRadius ?? 0, n.rectangleBottomLeftCornerRadius ?? 0];
  else if (n.cornerRadius) out.cornerRadius = n.cornerRadius;
  if (n.effects?.length) out.effects = n.effects.filter((e) => e.visible !== false).map((e) => ({ type: e.type === "FOREGROUND_BLUR" ? "LAYER_BLUR" : e.type, ...(e.color ? { color: colorHex(e.color) } : {}), ...(e.offset ? { offset: e.offset } : {}), radius: e.radius, ...(e.spread ? { spread: e.spread } : {}) }));
  if ((n.type === "FRAME" || n.type === "SYMBOL" || n.type === "INSTANCE") && n.frameMaskDisabled !== true) out.clipsContent = true;
  if (n.stackMode && n.stackMode !== "NONE") {
    out.layoutMode = n.stackMode;
    out.itemSpacing = n.stackSpacing ?? 0;
    const pad = [n.stackVerticalPadding ?? 0, n.stackPaddingRight ?? n.stackHorizontalPadding ?? 0, n.stackPaddingBottom ?? n.stackVerticalPadding ?? 0, n.stackHorizontalPadding ?? 0];
    if (pad.some(Boolean)) out.padding = pad;
    if (n.stackPrimaryAlignItems && n.stackPrimaryAlignItems !== "MIN") out.primaryAxisAlignItems = n.stackPrimaryAlignItems;
    if (n.stackCounterAlignItems && n.stackCounterAlignItems !== "MIN") out.counterAxisAlignItems = n.stackCounterAlignItems;
    if (n.stackWrap === "WRAP") Object.assign(out, { layoutWrap: "WRAP", counterAxisSpacing: n.stackCounterSpacing ?? n.stackSpacing ?? 0 });
  }
  const inLayout = !!parent?.stackMode && parent.stackMode !== "NONE";
  if (inLayout || (n.stackMode && n.stackMode !== "NONE") || n.type === "TEXT") {
    out.layoutSizingHorizontal = sizingOf(n, parent, "H");
    out.layoutSizingVertical = sizingOf(n, parent, "V");
  }
  if (inLayout && n.stackPositioning === "ABSOLUTE") out.layoutPositioning = "ABSOLUTE";
  if (n.minSize?.value.x) out.minWidth = n.minSize.value.x;
  if (n.maxSize?.value.x) out.maxWidth = n.maxSize.value.x;
  if (n.type === "TEXT") {
    out.characters = n.textData?.characters ?? "";
    Object.assign(out, { fontFamily: n.fontName?.family ?? "Inter", fontStyle: n.fontName?.style ?? "Regular", fontSize: n.fontSize ?? 12, lineHeight: describeLineHeight(n.lineHeight), textAutoResize: n.textAutoResize ?? "NONE" });
    if (n.letterSpacing?.value) out.letterSpacing = n.letterSpacing.units === "PERCENT" ? `${n.letterSpacing.value}%` : n.letterSpacing.value;
    if (n.textAlignHorizontal && n.textAlignHorizontal !== "LEFT") out.textAlignHorizontal = n.textAlignHorizontal;
    if (n.textData?.styleOverrideTable?.length) out.mixedStyles = true;
  }
  if (n.horizontalConstraint && !inLayout && n.horizontalConstraint !== "MIN") out.constraintHorizontal = n.horizontalConstraint;
  return out;
}
