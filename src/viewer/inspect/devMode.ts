/**
 * Dev Mode's other read-outs (docs/research/figma/R9-dev-mode.md), pure and tested:
 * - statuses (help.figma.com 26781702258583): a section's or frame's `sectionStatusInfo` — "Ready for dev" (BUILD) or
 *   "Completed";
 * - annotations (20774752502935): a layer's notes (rich text kept as HTML in the file) and the properties they pin
 *   ("+ Property": Width, Fill, Font size…), with their values read off the layer;
 * - assets (15023124644247: "Dev Mode can automatically detect icons and present them as downloadable assets", and
 *   images: "Source image file" / "Layer export"): the icons and images inside a layer;
 * - the List view (the Code / List toggle): a snippet's declarations as property rows.
 */
import type { NodeChange, Paint } from "@/engine/codec";
import type { CssDecl } from "./css";
import { cssColor, hexOf, num, typographyOf } from "./model";
import { markdownPlain } from "@/editor/devmode/annotations";

// ---- Statuses ----------------------------------------------------------------------------------------------------

export type DevStatus = "READY_FOR_DEV" | "COMPLETED" | "CHANGED";
export const STATUS_LABEL: Record<DevStatus, string> = { READY_FOR_DEV: "Ready for dev", COMPLETED: "Completed", CHANGED: "Changed" };

export interface StatusNode {
  sectionStatusInfo?: { status?: string | number; lastUpdateUnixTimestamp?: number };
  editInfo?: { lastEditedAt?: number; createdAt?: number };
}

/**
 * The status a node carries (schema `SectionStatusInfo.status`: BUILD = "Ready for dev", COMPLETED), or null; "Changed"
 * (help.figma.com 26781702258583: set automatically when a Ready or Completed design is modified) when the design was
 * edited after its status was set — `editInfo.lastEditedAt` later than `sectionStatusInfo.lastUpdateUnixTimestamp`, as
 * Figma's files record it (R9 "Round 6").
 */
export function statusOf(node: StatusNode | null | undefined): DevStatus | null {
  const s = node?.sectionStatusInfo?.status;
  const set = s === "BUILD" || s === 1 ? "READY_FOR_DEV" : s === "COMPLETED" || s === 2 ? "COMPLETED" : null;
  if (!set) return null;
  const edited = node?.editInfo?.lastEditedAt ?? 0;
  const since = node?.sectionStatusInfo?.lastUpdateUnixTimestamp ?? 0;
  return edited > since ? "CHANGED" : set;
}

/** "Edited 5 minutes ago" from a unix-seconds timestamp (Inspect's header; the left panel's designs). */
export function editedAgo(unixSeconds: number | undefined | null, now = Date.now()): string | null {
  if (!unixSeconds) return null;
  const s = Math.max(0, Math.round(now / 1000 - unixSeconds));
  if (s < 60) return "Edited just now";
  const units: [number, string][] = [[60, "minute"], [3600, "hour"], [86400, "day"], [604800, "week"], [2629800, "month"], [31557600, "year"]];
  let pick = units[0];
  for (const u of units) if (s >= u[0]) pick = u;
  const n = Math.floor(s / pick[0]);
  return `Edited ${n} ${pick[1]}${n === 1 ? "" : "s"} ago`;
}

// ---- Annotations ---------------------------------------------------------------------------------------------------

export interface AnnotationView {
  /** The note as plain text (its HTML's text, paragraphs on their own lines) */
  text: string;
  /** The pinned properties with the layer's values */
  properties: { label: string; value: string }[];
}

/** Rich text (Figma keeps an annotation's label as HTML) as plain text. */
export function htmlText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h\d)\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const firstSolid = (paints: readonly Paint[] | undefined): string | null => {
  const p = (paints ?? []).find((x) => x.visible !== false && x.type === "SOLID" && x.color);
  return p?.color ? hexOf(p.color) : null;
};

/** An annotation property's label and the layer's value for it (Figma's names; "—" when the layer has none). */
export function annotationProperty(type: string, n: NodeChange): { label: string; value: string } {
  const size = n.size ?? { x: 0, y: 0 };
  const t = n.type === "TEXT" ? typographyOf(n) : null;
  const px = (v: number | undefined | null) => (v === undefined || v === null ? "—" : `${num(v)}px`);
  const e = n as NodeChange & Record<string, unknown>;
  switch (type) {
    case "WIDTH": return { label: "Width", value: px(size.x) };
    case "HEIGHT": return { label: "Height", value: px(size.y) };
    case "MIN_WIDTH": return { label: "Min width", value: px(e.minWidth as number | undefined) };
    case "MIN_HEIGHT": return { label: "Min height", value: px(e.minHeight as number | undefined) };
    case "MAX_WIDTH": return { label: "Max width", value: px(e.maxWidth as number | undefined) };
    case "MAX_HEIGHT": return { label: "Max height", value: px(e.maxHeight as number | undefined) };
    case "FILL": return { label: "Fill", value: firstSolid(n.fillPaints) ?? "—" };
    case "STROKE": return { label: "Stroke", value: firstSolid(n.strokePaints) ?? "—" };
    case "STROKE_WIDTH": return { label: "Stroke weight", value: px(n.strokeWeight) };
    case "CORNER_RADIUS": return { label: "Corner radius", value: px(n.cornerRadius) };
    case "OPACITY": return { label: "Opacity", value: `${num((n.opacity ?? 1) * 100)}%` };
    case "EFFECT": return { label: "Effects", value: (n.effects ?? []).filter((x) => x.visible !== false).map((x) => x.type.toLowerCase().replace(/_/g, " ")).join(", ") || "—" };
    case "TEXT_STYLE": return { label: "Text style", value: t ? `${t.family} ${t.style} ${num(t.size)}` : "—" };
    case "TEXT_ALIGN_HORIZONTAL": return { label: "Text align", value: t ? t.align.toLowerCase() : "—" };
    case "FONT_FAMILY": return { label: "Font family", value: t?.family ?? "—" };
    case "FONT_STYLE": return { label: "Font style", value: t?.style ?? "—" };
    case "FONT_SIZE": return { label: "Font size", value: t ? px(t.size) : "—" };
    case "FONT_WEIGHT": return { label: "Font weight", value: t ? String(t.weight) : "—" };
    case "LINE_HEIGHT": return { label: "Line height", value: t ? (t.lineHeightPx === null ? "Auto" : px(t.lineHeightPx)) : "—" };
    case "LETTER_SPACING": return { label: "Letter spacing", value: t ? px(t.letterSpacingPx) : "—" };
    case "STACK_SPACING": return { label: "Gap", value: px(n.stackSpacing) };
    case "STACK_PADDING": return { label: "Padding", value: n.stackMode && n.stackMode !== "NONE" ? `${num(n.stackVerticalPadding ?? 0)} ${num(n.stackPaddingRight ?? n.stackHorizontalPadding ?? 0)} ${num(n.stackPaddingBottom ?? n.stackVerticalPadding ?? 0)} ${num(n.stackHorizontalPadding ?? 0)}` : "—" };
    case "STACK_MODE": return { label: "Layout", value: n.stackMode === "HORIZONTAL" ? "Horizontal" : n.stackMode === "VERTICAL" ? "Vertical" : n.stackMode === "GRID" ? "Grid" : "—" };
    case "STACK_ALIGNMENT": return { label: "Alignment", value: [n.stackPrimaryAlignItems, n.stackCounterAlignItems].filter(Boolean).join(" / ").toLowerCase() || "—" };
    case "COMPONENT": return { label: "Main component", value: n.name ?? "—" };
    default: return { label: type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, " "), value: "—" };
  }
}

/** A layer's annotations, ready to show. */
export function annotationsOf(n: NodeChange & { annotations?: { label?: string; labelV2?: string; properties?: { type?: string | number }[] }[] }): AnnotationView[] {
  return (n.annotations ?? []).map((a) => ({
    // The markdown (labelV2, round 6) as text, else the label (older files: HTML).
    text: a.labelV2 ? markdownPlain(a.labelV2) : htmlText(a.label ?? ""),
    properties: (a.properties ?? []).filter((p) => typeof p.type === "string").map((p) => annotationProperty(p.type as string, n)),
  }));
}

// ---- Assets --------------------------------------------------------------------------------------------------------

/** What the asset finder reads of a layer. */
export interface AssetNode {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  size: { x: number; y: number };
  fillPaints?: readonly Paint[];
  children: readonly string[];
}

export interface Asset {
  id: string;
  name: string;
  kind: "icon" | "image";
  /** Images: the first image fill's hash (its source file) */
  imageHash?: string;
}

const VECTORS = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "REGULAR_POLYGON", "LINE", "ELLIPSE", "ROUNDED_RECTANGLE", "RECTANGLE"]);
const CONTAINERS = new Set(["FRAME", "GROUP", "INSTANCE", "SYMBOL", "BOOLEAN_OPERATION"]);
/** The largest icon (each side), in px. Figma's own threshold isn't published (unverified). */
export const ICON_MAX = 128;

/** The image fill of a layer (visible), or null. */
export function imageFillOf(n: Pick<AssetNode, "fillPaints">): string | null {
  const p = (n.fillPaints ?? []).find((x) => x.visible !== false && x.type === "IMAGE" && x.image?.hash);
  const h = p?.image?.hash as unknown;
  if (!h) return null;
  if (typeof h === "string") return h;
  if (h instanceof Uint8Array || Array.isArray(h)) return Array.from(h as ArrayLike<number>).map((b) => b.toString(16).padStart(2, "0")).join("");
  return null;
}

/**
 * The icons and images inside `root` (itself included), outermost first: an icon is a small layer made only of
 * vector shapes (a vector, or a frame / group / instance holding only them, with at least one real vector — a lone
 * rectangle is no icon), with no image in it; an image is a layer with an image fill.
 */
export function detectAssets(root: string, get: (id: string) => AssetNode | null, limit = 60): Asset[] {
  const out: Asset[] = [];
  const iconMemo = new Map<string, boolean>();
  const onlyVectors = (id: string): { ok: boolean; real: boolean } => {
    const n = get(id);
    if (!n || !n.visible) return { ok: true, real: false };
    if (imageFillOf(n)) return { ok: false, real: false };
    if (n.type === "TEXT") return { ok: false, real: false };
    if (VECTORS.has(n.type) && !n.children.length) return { ok: true, real: n.type !== "RECTANGLE" && n.type !== "ROUNDED_RECTANGLE" };
    if (!CONTAINERS.has(n.type)) return { ok: false, real: false };
    let real = n.type === "BOOLEAN_OPERATION";
    for (const c of n.children) {
      const r = onlyVectors(c);
      if (!r.ok) return { ok: false, real: false };
      real ||= r.real;
    }
    return { ok: true, real };
  };
  const isIcon = (n: AssetNode) => {
    if (iconMemo.has(n.id)) return iconMemo.get(n.id)!;
    const small = n.size.x > 0 && n.size.y > 0 && n.size.x <= ICON_MAX && n.size.y <= ICON_MAX;
    const r = small ? onlyVectors(n.id) : { ok: false, real: false };
    const yes = r.ok && r.real;
    iconMemo.set(n.id, yes);
    return yes;
  };
  const walk = (id: string) => {
    if (out.length >= limit) return;
    const n = get(id);
    if (!n || !n.visible) return;
    if (isIcon(n)) {
      out.push({ id, name: n.name, kind: "icon" });
      return;
    }
    const hash = imageFillOf(n);
    if (hash) out.push({ id, name: n.name, kind: "image", imageHash: hash });
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

// ---- List view -----------------------------------------------------------------------------------------------------

/** A snippet's declarations as the List view's rows: "Width" → "375px", a colour's swatch value kept. */
export function listRows(decls: readonly CssDecl[]): { label: string; value: string }[] {
  return decls.map((d) => ({
    label: d.property.replace(/^-+/, "").replace(/-([a-z])/g, (_, c: string) => ` ${c}`).replace(/^./, (c) => c.toUpperCase()),
    value: d.value,
  }));
}

/** A colour as Dev Mode copies it (used by annotation values). */
export const colorText = (c: { r: number; g: number; b: number; a?: number }) => cssColor({ r: c.r, g: c.g, b: c.b, a: c.a ?? 1 });
