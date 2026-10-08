/**
 * Export settings as Figma's UI shows and makes them (help.figma.com
 * 13402894554519 "Export formats and settings", 360040028114 "Export from
 * Figma Design"): the scale field ("1x", "0.5x", "512w", "512h" — a factor,
 * a width or a height), the formats (PNG, JPG, SVG, PDF; SVG and PDF only at
 * 1x), the "+" defaults (1x, then 2x "@2x", then 3x "@3x"), file names
 * (layer name + suffix + extension), and the pure helpers the export path
 * uses: PNG DPI (72 × scale, Figma's pHYs), a stored ZIP for a browser
 * download of several files, Copy as code's CSS, and Export frames to PDF's
 * page order (rows top to bottom, left to right).
 */
import type { ExportSettings } from "../../../../shared/schema/document.generated";

export type { ExportSettings };
export type ExportFormat = "PNG" | "JPEG" | "SVG" | "PDF";

/** The format menu (live popovers/export-format-menu.txt: PNG, JPEG, SVG, PDF). */
export const EXPORT_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: "PNG", label: "PNG" },
  { value: "JPEG", label: "JPEG" },
  { value: "SVG", label: "SVG" },
  { value: "PDF", label: "PDF" },
];

/** The scale field's menu. */
export const SCALE_PRESETS = ["0.5x", "0.75x", "1x", "1.5x", "2x", "3x", "4x", "512w", "512h"] as const;

/** Image quality (JPG, PDF): Figma's defaults are High for JPG and Medium for PDF. */
export const QUALITY_LEVELS: { value: string; label: string; quality: number }[] = [
  { value: "low", label: "Low", quality: 0.6 },
  { value: "medium", label: "Medium", quality: 0.8 },
  { value: "high", label: "High", quality: 0.92 },
];

export const formatOf = (s: ExportSettings): ExportFormat => (s.imageType === "JPEG" || s.imageType === "SVG" || s.imageType === "PDF" ? s.imageType : "PNG");
export const isVectorFormat = (f: ExportFormat) => f === "SVG" || f === "PDF";
export const extensionOf = (f: ExportFormat) => (f === "JPEG" ? "jpg" : f.toLowerCase());
export const formatLabel = (f: ExportFormat) => EXPORT_FORMATS.find((x) => x.value === f)?.label ?? f;

function trimNumber(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/** "2x", "0.5x", "512w", "512h" (SVG and PDF: always 1x). */
export function scaleLabel(s: ExportSettings): string {
  if (isVectorFormat(formatOf(s))) return "1x";
  const c = s.constraint ?? { type: "CONTENT_SCALE", value: 1 };
  if (c.type === "CONTENT_WIDTH") return `${trimNumber(c.value)}w`;
  if (c.type === "CONTENT_HEIGHT") return `${trimNumber(c.value)}h`;
  return `${trimNumber(c.value)}x`;
}

/** What the scale field accepts: a number with "x" (or none), "w" or "h" — null when it isn't one. */
export function parseScale(text: string): ExportSettings["constraint"] | null {
  const m = /^\s*(\d*\.?\d+)\s*([xwh]?)\s*$/i.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = (m[2] || "x").toLowerCase();
  if (!(value > 0) || !Number.isFinite(value)) return null;
  if (unit === "x") return { type: "CONTENT_SCALE", value: Math.min(value, 100) };
  const px = Math.max(1, Math.min(16384, Math.round(value)));
  return { type: unit === "w" ? "CONTENT_WIDTH" : "CONTENT_HEIGHT", value: px };
}

/** The "+" button's next setting: 1x, then 2x "@2x", 3x "@3x", 4x "@4x" (as Figma adds them), PNG. */
export function nextExportSetting(existing: readonly ExportSettings[]): ExportSettings {
  const order = [1, 2, 3, 4];
  const used = new Set(existing.filter((s) => (s.constraint?.type ?? "CONTENT_SCALE") === "CONTENT_SCALE").map((s) => s.constraint?.value ?? 1));
  const scale = order.find((v) => !used.has(v)) ?? 1;
  return {
    suffix: scale === 1 ? "" : `@${scale}x`,
    imageType: "PNG",
    constraint: { type: "CONTENT_SCALE", value: scale },
    contentsOnly: true,
    svgOutlineText: true,
    svgIDMode: "IF_NEEDED",
    svgForceStrokeMasks: false,
    useAbsoluteBounds: false,
    colorProfile: "DOCUMENT",
  };
}

/** The setting with another format (the scale is 1x for SVG and PDF; the suffix stays, as in Figma). */
export function withFormat(s: ExportSettings, format: ExportFormat): ExportSettings {
  const next: ExportSettings = { ...s, imageType: format };
  if (isVectorFormat(format)) next.constraint = { type: "CONTENT_SCALE", value: 1 };
  return next;
}

/** The file an export makes: the layer's name, the suffix, the extension ("Frame 1@2x.png"; "/" makes folders). */
export function exportFileName(layerName: string, s: ExportSettings): string {
  const name = layerName.trim() || "Untitled";
  return `${name}${s.suffix ?? ""}.${extensionOf(formatOf(s))}`;
}

/** "2x PNG", "512w JPG", "SVG" — a setting in a list. */
export function describeSetting(s: ExportSettings): string {
  const f = formatOf(s);
  return isVectorFormat(f) ? formatLabel(f) : `${scaleLabel(s)} ${formatLabel(f)}`;
}

/** The settings of a node as the panel reads them (absent: none). */
export function exportSettingsOf(node: { exportSettings?: unknown } | null | undefined): ExportSettings[] {
  const v = node?.exportSettings;
  return Array.isArray(v) ? (v as ExportSettings[]) : [];
}

/** The JPEG / PDF image quality of a setting (0..1). */
export function qualityOf(s: ExportSettings): number {
  if (typeof s.quality === "number" && s.quality > 0 && s.quality <= 1) return s.quality;
  return formatOf(s) === "PDF" ? 0.8 : 0.92;
}

// ---- Files ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A PNG with its pixel density: a pHYs chunk after IHDR (Figma: "assets exported as images have a DPI of 72";
 * 2x = 144 DPI, so a 2x export placed back in Figma shows at half its pixels). Anything else comes back as it was.
 */
export function pngWithDpi(png: Uint8Array, dpi: number): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 33 || sig.some((b, i) => png[i] !== b)) return png;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const ihdrEnd = 8 + 8 + view.getUint32(8) + 4;
  // Already has one: leave it.
  for (let at = ihdrEnd; at + 8 <= png.length; ) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7]);
    if (type === "pHYs") return png;
    if (type === "IDAT" || type === "IEND") break;
    at += 12 + len;
  }
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4);  // "pHYs"
  cv.setUint32(8, ppm);
  cv.setUint32(12, ppm);
  chunk[16] = 1;  // the unit: metres
  cv.setUint32(17, crc32(chunk, 4, 17));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}

/** A ZIP of `files` (stored, no compression: the images are compressed already), for a browser's single download. */
export function zipStored(files: readonly { name: string; bytes: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);  // UTF-8 names
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.bytes.length, true);
    lv.setUint32(22, f.bytes.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.bytes.length, true);
    cv.setUint32(24, f.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, f.bytes);
    centrals.push(central);
    offset += local.length + f.bytes.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---- Export frames to PDF ----

/** Frames in reading order — rows top to bottom (frames whose vertical extents overlap share a row), left to right. */
export function readingOrder<T extends { x: number; y: number; w: number; h: number }>(frames: readonly T[]): T[] {
  const byTop = [...frames].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: { bottom: number; top: number; items: T[] }[] = [];
  for (const f of byTop) {
    const row = rows.find((r) => f.y < r.bottom && f.y + f.h > r.top);
    if (row) {
      row.items.push(f);
      row.bottom = Math.max(row.bottom, f.y + f.h);
    } else {
      rows.push({ top: f.y, bottom: f.y + f.h, items: [f] });
    }
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
}

// ---- Copy as code (CSS) ----

interface CssColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}
interface CssPaint {
  type?: string;
  color?: CssColor;
  opacity?: number;
  visible?: boolean;
  stops?: { color: CssColor; position: number }[];
  transform?: { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
}
export interface CssNode {
  name?: string;
  type?: string;
  size?: { x: number; y: number };
  transform?: { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
  opacity?: number;
  fillPaints?: CssPaint[];
  strokePaints?: CssPaint[];
  strokeWeight?: number;
  strokeAlign?: string;
  cornerRadius?: number;
  rectangleTopLeftCornerRadius?: number;
  rectangleTopRightCornerRadius?: number;
  rectangleBottomRightCornerRadius?: number;
  rectangleBottomLeftCornerRadius?: number;
  effects?: { type?: string; visible?: boolean; color?: CssColor; offset?: { x: number; y: number }; radius?: number; spread?: number }[];
  stackMode?: string;
  stackSpacing?: number;
  stackPaddingLeft?: number;
  stackPaddingTop?: number;
  stackPaddingRight?: number;
  stackPaddingBottom?: number;
  stackHorizontalPadding?: number;
  stackVerticalPadding?: number;
  stackPrimaryAlignItems?: string;
  stackCounterAlignItems?: string;
  fontName?: { family: string; style: string };
  fontSize?: number;
  lineHeight?: { value: number; units: string };
  letterSpacing?: { value: number; units: string };
  textAlignHorizontal?: string;
  textData?: { characters?: string };
}

const px = (v: number) => `${Math.round(v * 100) / 100}px`;
const hex2 = (v: number) =>
  Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
function cssColor(c: CssColor, opacity = 1): string {
  const a = (c.a ?? 1) * opacity;
  if (a >= 1) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${Math.round(a * 100) / 100})`;
}
function cssPaint(p: CssPaint, size: { x: number; y: number }): string | null {
  if (p.visible === false) return null;
  const op = p.opacity ?? 1;
  if (p.type === "SOLID" || !p.type) return p.color ? cssColor(p.color, op) : null;
  const stops = (p.stops ?? []).map((s) => `${cssColor(s.color, op)} ${Math.round(s.position * 10000) / 100}%`).join(", ");
  if (p.type === "GRADIENT_LINEAR") {
    // The gradient's direction in the layer (its unit square → paint space, inverted), as a CSS angle.
    const m = p.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
    const det = m.m00 * m.m11 - m.m01 * m.m10 || 1;
    const dx = (m.m11 / det) * size.x, dy = (-m.m10 / det) * size.y;
    const deg = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360);
    return `linear-gradient(${deg}deg, ${stops})`;
  }
  if (p.type === "GRADIENT_RADIAL") return `radial-gradient(50% 50% at 50% 50%, ${stops})`;
  if (p.type === "GRADIENT_ANGULAR") return `conic-gradient(from 90deg at 50% 50%, ${stops})`;
  if (p.type === "IMAGE") return "url(image.png)";
  return null;
}

const FONT_WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];
const weightOf = (style: string) => FONT_WEIGHTS.find(([re]) => re.test(style))?.[1] ?? 400;

const JUSTIFY: Record<string, string> = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between" };
const ALIGN: Record<string, string> = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", BASELINE: "baseline" };

/** Figma's "Copy as code" CSS of one layer: a comment with its name, its box, then its look. */
export function cssOf(node: CssNode): string {
  const size = node.size ?? { x: 0, y: 0 };
  const t = node.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const box: string[] = ["position: absolute;", `width: ${px(size.x)};`, `height: ${px(size.y)};`, `left: ${px(t.m02)};`, `top: ${px(t.m12)};`];
  const look: string[] = [];
  const angle = Math.round((Math.atan2(t.m10, t.m00) * 180) / Math.PI * 100) / 100;
  if (angle) box.push(`transform: rotate(${-angle}deg);`);
  if (node.stackMode === "HORIZONTAL" || node.stackMode === "VERTICAL") {
    const l = node.stackPaddingLeft ?? node.stackHorizontalPadding ?? 0;
    const r = node.stackPaddingRight ?? node.stackHorizontalPadding ?? 0;
    const tp = node.stackPaddingTop ?? node.stackVerticalPadding ?? 0;
    const b = node.stackPaddingBottom ?? node.stackVerticalPadding ?? 0;
    look.push(
      "/* Auto layout */",
      "display: flex;",
      `flex-direction: ${node.stackMode === "HORIZONTAL" ? "row" : "column"};`,
      `justify-content: ${JUSTIFY[node.stackPrimaryAlignItems ?? "MIN"] ?? "flex-start"};`,
      `align-items: ${ALIGN[node.stackCounterAlignItems ?? "MIN"] ?? "flex-start"};`,
      `padding: ${[tp, r, b, l].map(px).join(" ")};`,
      `gap: ${px(node.stackSpacing ?? 0)};`,
      ""
    );
  }
  const isText = node.type === "TEXT";
  if (isText) {
    const font = node.fontName ?? { family: "Inter", style: "Regular" };
    const size_ = node.fontSize ?? 12;
    look.push(`font-family: '${font.family}';`, `font-style: ${/italic/i.test(font.style) ? "italic" : "normal"};`, `font-weight: ${weightOf(font.style)};`, `font-size: ${px(size_)};`);
    const lh = node.lineHeight;
    if (lh && lh.units === "PIXELS") look.push(`line-height: ${px(lh.value)};`);
    else if (lh && lh.units === "PERCENT" && lh.value !== 100) look.push(`line-height: ${Math.round(lh.value)}%;`);
    else look.push("line-height: normal;");
    const ls = node.letterSpacing;
    if (ls && ls.value) look.push(`letter-spacing: ${ls.units === "PIXELS" ? px(ls.value) : `${Math.round(ls.value * 100) / 10000}em`};`);
    if (node.textAlignHorizontal && node.textAlignHorizontal !== "LEFT") look.push(`text-align: ${node.textAlignHorizontal === "JUSTIFIED" ? "justify" : node.textAlignHorizontal.toLowerCase()};`);
    const fill = (node.fillPaints ?? []).map((p) => cssPaint(p, size)).filter(Boolean)[0];
    if (fill) look.push("", `color: ${fill};`);
  } else {
    const fills = (node.fillPaints ?? []).map((p) => cssPaint(p, size)).filter((x): x is string => !!x).reverse();
    if (fills.length) look.push(`background: ${fills.join(", ")};`);
  }
  const strokes = (node.strokePaints ?? []).filter((p) => p.visible !== false);
  if (strokes.length && (node.strokeWeight ?? 0) > 0 && !isText) {
    const c = cssPaint(strokes[0], size) ?? "#000000";
    look.push(`border: ${px(node.strokeWeight ?? 1)} solid ${c};`);
    if ((node.strokeAlign ?? "INSIDE") === "INSIDE") look.push("box-sizing: border-box;");
  }
  const radii = [node.rectangleTopLeftCornerRadius, node.rectangleTopRightCornerRadius, node.rectangleBottomRightCornerRadius, node.rectangleBottomLeftCornerRadius];
  if (node.type === "ELLIPSE") look.push("border-radius: 50%;");
  else if (radii.some((r) => r !== undefined && r !== radii[0])) look.push(`border-radius: ${radii.map((r) => px(r ?? 0)).join(" ")};`);
  else if ((radii[0] ?? node.cornerRadius ?? 0) > 0) look.push(`border-radius: ${px(radii[0] ?? node.cornerRadius ?? 0)};`);
  const shadows: string[] = [];
  for (const e of node.effects ?? []) {
    if (e.visible === false) continue;
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW")
      shadows.push(`${e.type === "INNER_SHADOW" ? "inset " : ""}${px(e.offset?.x ?? 0)} ${px(e.offset?.y ?? 0)} ${px(e.radius ?? 0)}${e.spread ? ` ${px(e.spread)}` : ""} ${cssColor(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 })}`);
    else if (e.type === "FOREGROUND_BLUR") look.push(`filter: blur(${px((e.radius ?? 0) / 2)});`);
    else if (e.type === "BACKGROUND_BLUR") look.push(`backdrop-filter: blur(${px((e.radius ?? 0) / 2)});`);
  }
  if (shadows.length) look.push(`box-shadow: ${shadows.join(", ")};`);
  if (node.opacity !== undefined && node.opacity < 1) look.push(`opacity: ${Math.round(node.opacity * 100) / 100};`);
  const lines = [`/* ${node.name ?? "Layer"} */`, "", ...box];
  if (look.length) lines.push("", ...look);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
