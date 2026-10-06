/**
 * Figma's "Selection colors" (help.figma.com "View and adjust colors in a mixed
 * selection"): the distinct solid colours and gradients of the fills and
 * strokes in the selection and every layer inside it, each listed once (a
 * gradient as one row, not its stops — Figma's forum asks for stops as a
 * feature); editing one recolours every paint that uses it. Image fills,
 * hidden paints and masks are left out.
 * Plain data — the panel reads the subtree, this groups and rewrites it.
 *
 * Shown when the selection's paints don't fit the Fill / Stroke sections: a
 * layer with children that hold colours (frames, groups), or several layers
 * whose colours differ.
 */
import type { Color, Guid, NodeChange, Paint } from "@/engine/codec";
import { colorToHex } from "./color";
import { gradientKey, isGradientType, type FullPaint } from "./paints";

export type PaintField = "fillPaints" | "strokePaints";

export interface PaintUse {
  guid: Guid;
  field: PaintField;
  index: number;
}

export interface SelectionColor {
  /** "#rrggbb" + opacity (a gradient: its type, stops and opacity): the identity in the list */
  key: string;
  /** A gradient row: the first paint using it (its type and stops); absent for a solid colour */
  gradient?: FullPaint;
  color: Color;
  /** The paint's opacity (0..1) */
  opacity: number;
  uses: PaintUse[];
}

/** How many rows show before "See all N colors". */
export const SELECTION_COLORS_SHOWN = 3;

/** Past this many layers the subtree isn't read (Figma also stops listing colours on huge selections). */
export const SELECTION_COLORS_MAX_NODES = 5000;

export const colorKey = (color: Pick<Color, "r" | "g" | "b">, opacity: number) => `${colorToHex(color)}/${Math.round(opacity * 100)}`;

/** The distinct colours of `nodes` (in the order given: the selection, then each layer's subtree top first). */
export function collectColors(nodes: readonly NodeChange[]): SelectionColor[] {
  const out = new Map<string, SelectionColor>();
  for (const n of nodes) {
    for (const field of ["fillPaints", "strokePaints"] as const) {
      if ((n as { mask?: boolean }).mask) continue;
      (n[field] ?? []).forEach((p: Paint, index) => {
        if (p.visible === false) return;
        if (isGradientType(p.type)) {
          const g = p as FullPaint;
          if (!g.stops?.length) return;
          const key = gradientKey(g);
          let entry = out.get(key);
          if (!entry) out.set(key, (entry = { key, color: { ...g.stops[0].color, a: 1 }, opacity: g.opacity ?? 1, gradient: g, uses: [] }));
          entry.uses.push({ guid: n.guid, field, index });
          return;
        }
        if (p.type !== "SOLID" || !p.color) return;
        const opacity = p.opacity ?? 1;
        const key = colorKey(p.color, opacity);
        let entry = out.get(key);
        if (!entry) out.set(key, (entry = { key, color: { ...p.color, a: 1 }, opacity, uses: [] }));
        entry.uses.push({ guid: n.guid, field, index });
      });
    }
  }
  return [...out.values()];
}

/**
 * Does the section show? `selected` are the selected layers, `inside` every
 * visible layer below them. Children with colours always bring it; otherwise
 * only several selected layers whose colours differ do.
 */
export function showSelectionColors(selected: readonly NodeChange[], inside: readonly NodeChange[]): boolean {
  if (collectColors(inside).length > 0) return true;
  if (selected.length < 2) return false;
  const own = selected.map((n) => collectColors([n]).map((c) => c.key).join(","));
  return collectColors(selected).length > 0 && own.some((k) => k !== own[0]);
}

/** Each node's paint lists with every use of a colour replaced (one write per node). */
export function recolor(nodes: ReadonlyMap<Guid, NodeChange>, uses: readonly PaintUse[], next: { color?: Color; opacity?: number }): Map<Guid, Partial<Record<PaintField, Paint[]>>> {
  const out = new Map<Guid, Partial<Record<PaintField, Paint[]>>>();
  for (const u of uses) {
    const node = nodes.get(u.guid);
    if (!node) continue;
    let fields = out.get(u.guid);
    if (!fields) out.set(u.guid, (fields = {}));
    const list = (fields[u.field] ??= [...(node[u.field] ?? [])]);
    const p = list[u.index];
    if (!p) continue;
    list[u.index] = { ...p, ...(next.color ? { color: { ...next.color, a: 1 } } : {}), ...(next.opacity !== undefined ? { opacity: next.opacity } : {}) };
  }
  return out;
}

/**
 * A gradient row's edit: every use takes the new type, stops, opacity and blend mode, keeping its own transform
 * (where its handles are) — one write per node.
 */
export function regradient(nodes: ReadonlyMap<Guid, NodeChange>, uses: readonly PaintUse[], next: Pick<FullPaint, "type" | "stops" | "opacity" | "blendMode">): Map<Guid, Partial<Record<PaintField, Paint[]>>> {
  const out = new Map<Guid, Partial<Record<PaintField, Paint[]>>>();
  for (const u of uses) {
    const node = nodes.get(u.guid);
    if (!node) continue;
    let fields = out.get(u.guid);
    if (!fields) out.set(u.guid, (fields = {}));
    const list = (fields[u.field] ??= [...(node[u.field] ?? [])]);
    const p = list[u.index] as FullPaint | undefined;
    if (!p) continue;
    const merged: FullPaint = { ...p, type: next.type, ...(next.stops ? { stops: next.stops } : {}), ...(next.opacity !== undefined ? { opacity: next.opacity } : {}), ...(next.blendMode ? { blendMode: next.blendMode } : {}) };
    if (next.type === "SOLID") delete merged.stops;
    list[u.index] = merged;
  }
  return out;
}
