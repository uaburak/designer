/**
 * Compare changes (help.figma.com 15023193382935): a design in a saved version against now — its layers tagged
 * "Edited", "Added" or "Deleted", each edited layer's properties with their previous and current values. Pure: the
 * modal reads both sides' subtrees (the version loaded into an engine of its own, the editor's engine for now).
 */
import type { Guid, NodeChange } from "@/engine/codec";
import { hexOf, num } from "../../../../viewer/inspect/model";

export type ChangeKind = "Edited" | "Added" | "Deleted";

export interface PropertyChange {
  field: string;
  label: string;
  before: string;
  after: string;
}

export interface LayerChange {
  id: Guid;
  name: string;
  type: string;
  kind: ChangeKind;
  depth: number;
  changes: PropertyChange[];
}

/** Bookkeeping, derived data and Dev Mode's own fields: never a design change. */
const IGNORED = new Set([
  "guid", "phase", "childIds", "editInfo", "derivedSymbolData", "derivedSymbolDataLayoutVersion", "derivedTextData", "annotations",
  "measurements", "sectionStatusInfo", "annotationCategories", "thumbnailInfo", "versionHash", "publishedVersion", "key",
]);

const LABEL: Record<string, string> = {
  name: "Name",
  visible: "Visibility",
  locked: "Lock",
  opacity: "Opacity",
  size: "Size",
  transform: "Position",
  parentIndex: "Parent",
  fillPaints: "Fill",
  strokePaints: "Stroke",
  strokeWeight: "Stroke weight",
  strokeAlign: "Stroke position",
  cornerRadius: "Corner radius",
  rectangleTopLeftCornerRadius: "Top left radius",
  rectangleTopRightCornerRadius: "Top right radius",
  rectangleBottomLeftCornerRadius: "Bottom left radius",
  rectangleBottomRightCornerRadius: "Bottom right radius",
  effects: "Effects",
  blendMode: "Blend mode",
  textData: "Text",
  fontName: "Font",
  fontSize: "Font size",
  lineHeight: "Line height",
  letterSpacing: "Letter spacing",
  textAlignHorizontal: "Text align",
  textAlignVertical: "Vertical align",
  textAutoResize: "Resizing",
  stackMode: "Auto layout",
  stackSpacing: "Gap",
  stackHorizontalPadding: "Left padding",
  stackVerticalPadding: "Top padding",
  stackPaddingRight: "Right padding",
  stackPaddingBottom: "Bottom padding",
  stackPrimaryAlignItems: "Alignment",
  stackCounterAlignItems: "Counter alignment",
  stackPrimarySizing: "Primary sizing",
  stackCounterSizing: "Counter sizing",
  frameMaskDisabled: "Clip content",
  symbolData: "Overrides",
  componentPropAssignments: "Properties",
  styleIdForFill: "Fill style",
  styleIdForText: "Text style",
  styleIdForEffect: "Effect style",
  styleIdForStrokeFill: "Stroke style",
  parameterConsumptionMap: "Variables",
  exportSettings: "Export",
  prototypeInteractions: "Interactions",
};

/** "stackPaddingRight" → "Stack padding right". */
export function fieldLabel(field: string): string {
  if (LABEL[field]) return LABEL[field];
  const words = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type Json = unknown;

function paints(v: Json): string {
  if (!Array.isArray(v) || !v.length) return "None";
  return v
    .map((p: { type?: string; color?: { r: number; g: number; b: number; a: number }; opacity?: number; visible?: boolean }) => {
      const hidden = p.visible === false ? " (hidden)" : "";
      if (p.type === "SOLID" && p.color) {
        const a = (p.opacity ?? 1) * (p.color.a ?? 1);
        return `${hexOf(p.color)}${a < 0.999 ? ` ${num(a * 100)}%` : ""}${hidden}`;
      }
      return `${(p.type ?? "Paint").replace(/_/g, " ").toLowerCase()}${hidden}`;
    })
    .join(", ");
}

/** A field's value as the properties list shows it. */
export function valueText(field: string, v: Json): string {
  if (v === undefined || v === null) return "—";
  if (field === "fillPaints" || field === "strokePaints") return paints(v);
  if (field === "size" && typeof v === "object") {
    const s = v as { x: number; y: number };
    return `${num(s.x)} × ${num(s.y)}`;
  }
  if (field === "transform" && typeof v === "object") {
    const m = v as { m00: number; m01: number; m02: number; m10: number; m12: number };
    const angle = Math.round((Math.atan2(-m.m10, m.m00) * 180) / Math.PI);
    return `X ${num(m.m02)}, Y ${num(m.m12)}${angle ? `, ${angle}°` : ""}`;
  }
  if (field === "textData" && typeof v === "object") return JSON.stringify((v as { characters?: string }).characters ?? "");
  if (field === "fontName" && typeof v === "object") {
    const f = v as { family?: string; style?: string };
    return `${f.family ?? ""} ${f.style ?? ""}`.trim();
  }
  if ((field === "lineHeight" || field === "letterSpacing") && typeof v === "object") {
    const n = v as { value: number; units: string };
    return n.units === "PIXELS" ? num(n.value) : n.units === "PERCENT" ? `${num(n.value)}%` : `${num(n.value * 100)}%`;
  }
  if (field === "opacity" && typeof v === "number") return `${num(v * 100)}%`;
  if (field === "parentIndex" && typeof v === "object") return String((v as { guid?: string }).guid ?? "");
  if (field === "effects" && Array.isArray(v)) return v.map((e: { type?: string }) => (e.type ?? "").replace(/_/g, " ").toLowerCase()).join(", ") || "None";
  if (typeof v === "number") return num(v);
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (typeof v === "string") return v;
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

const same = (a: Json, b: Json): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields of a layer that differ between the two sides (`parentIndex`: only a new parent counts, not the order). */
export function propertyChanges(before: NodeChange, after: NodeChange): PropertyChange[] {
  const out: PropertyChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const field of keys) {
    if (IGNORED.has(field)) continue;
    const a = (before as unknown as Record<string, Json>)[field];
    const b = (after as unknown as Record<string, Json>)[field];
    if (field === "parentIndex") {
      if ((a as { guid?: string } | undefined)?.guid !== (b as { guid?: string } | undefined)?.guid)
        out.push({ field, label: "Parent", before: valueText(field, a), after: valueText(field, b) });
      continue;
    }
    if (same(a, b)) continue;
    const before_ = valueText(field, a);
    const after_ = valueText(field, b);
    // Positions that round to the same numbers (layout's float noise) aren't changes.
    if (before_ === after_ && (field === "transform" || field === "size")) continue;
    out.push({ field, label: fieldLabel(field), before: before_, after: after_ });
  }
  return out.sort((x, y) => x.label.localeCompare(y.label));
}

/**
 * The design's layers that changed, in the current version's layer order (top first, as the Layers list shows them),
 * the deleted ones under their old parent. `before` / `after`: each side's subtree of `root`, parents before children
 * (instance sublayers left out: an instance's changes are its own fields).
 */
export function diffDesign(root: Guid, before: readonly NodeChange[], after: readonly NodeChange[]): LayerChange[] {
  const real = (n: NodeChange) => !n.guid.startsWith("I");
  const was = new Map(before.filter(real).map((n) => [n.guid, n]));
  const now = new Map(after.filter(real).map((n) => [n.guid, n]));
  const out: LayerChange[] = [];
  const kids = (map: Map<Guid, NodeChange>) => {
    const k = new Map<Guid, NodeChange[]>();
    for (const n of map.values()) {
      const p = n.parentIndex?.guid;
      if (!p || n.guid === root) continue;
      if (!k.has(p)) k.set(p, []);
      k.get(p)!.push(n);
    }
    // Layers order: the topmost (the last in paint order: the greatest position) first.
    for (const list of k.values()) list.sort((x, y) => ((y.parentIndex?.position ?? "") < (x.parentIndex?.position ?? "") ? -1 : 1));
    return k;
  };
  const nowKids = kids(now);
  const wasKids = kids(was);
  const visit = (id: Guid, depth: number) => {
    const a = was.get(id);
    const b = now.get(id);
    if (b) {
      const type = b.type ?? "FRAME";
      if (!a) out.push({ id, name: b.name ?? "", type, kind: "Added", depth, changes: [] });
      else {
        const changes = propertyChanges(a, b);
        if (changes.length) out.push({ id, name: b.name ?? "", type, kind: "Edited", depth, changes });
      }
      for (const c of nowKids.get(id) ?? []) visit(c.guid, depth + 1);
    }
    // Layers that were here and aren't anywhere now.
    for (const c of wasKids.get(id) ?? []) if (!now.has(c.guid)) deleted(c.guid, depth + 1);
  };
  const deleted = (id: Guid, depth: number) => {
    const a = was.get(id)!;
    out.push({ id, name: a.name ?? "", type: a.type ?? "FRAME", kind: "Deleted", depth, changes: [] });
    for (const c of wasKids.get(id) ?? []) deleted(c.guid, depth + 1);
  };
  if (now.has(root) || was.has(root)) visit(root, 0);
  return out;
}

/** The latest version saved at or before `at` (ms), else the oldest — what a design marked ready is compared with. */
export function versionAtOrBefore<V extends { createdAt: number }>(versions: readonly V[], at: number | null): V | null {
  if (!versions.length) return null;
  const sorted = [...versions].sort((a, b) => b.createdAt - a.createdAt);
  if (at === null) return sorted[0];
  return sorted.find((v) => v.createdAt <= at) ?? sorted[sorted.length - 1];
}

/** CSS lines of two snippets: each line marked when the other side lacks it ("Compare code"). */
export function codeDiff(before: string, after: string): { before: { text: string; changed: boolean }[]; after: { text: string; changed: boolean }[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  const inA = new Set(a);
  const inB = new Set(b);
  return { before: a.map((text) => ({ text, changed: !inB.has(text) })), after: b.map((text) => ({ text, changed: !inA.has(text) })) };
}
