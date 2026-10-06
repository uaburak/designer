/**
 * What a press on the canvas picks, read from what it drew: the path of
 * layers under the pointer (a text only on its glyphs, nothing locked), and
 * the one Figma would pick of them.
 */

import { getNode, type FigmaDocument, type SceneNode } from "./model";

/** A text layer's lines — where its glyphs are, one box per line (an empty text: its whole box). */
export function glyphLines(el: HTMLElement): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  range.detach();
  return rects.length ? rects : [el.getBoundingClientRect()];
}

let metricsCtx: CanvasRenderingContext2D | null = null;
/** How far a text's baseline sits above its line boxes' bottom (the font's descent), in the text's own (unzoomed) px. */
export function descentOf(el: HTMLElement): number {
  metricsCtx ??= document.createElement("canvas").getContext("2d");
  if (!metricsCtx) return 0;
  const cs = getComputedStyle(el);
  metricsCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return metricsCtx.measureText("x").fontBoundingBoxDescent || 0;
}

/** Whether a point is over a text layer's glyphs (its lines' boxes), not the empty rest of its box. An empty text counts whole. */
function overGlyphs(el: HTMLElement, x: number, y: number): boolean {
  return glyphLines(el).some((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1);
}

/** The ids from the top-level node down to the innermost element under `target` (locked ones and what is under them left out); `at` given: a text is only hit on its glyphs (its empty box hits what is under it). */
export function pathAt(target: Element, root: Element, doc: FigmaDocument, at?: { x: number; y: number }): { id: string; el: HTMLElement }[] {
  const path: { id: string; el: HTMLElement }[] = [];
  let el = target.closest<HTMLElement>("[data-node-id]");
  while (el && root.contains(el)) {
    path.unshift({ id: el.dataset.nodeId!, el });
    el = el.parentElement?.closest<HTMLElement>("[data-node-id]") ?? null;
  }
  const last = path[path.length - 1];
  if (at && last && last.el.dataset.nodeType === "text" && !overGlyphs(last.el, at.x, at.y)) path.pop();
  // A locked node can't be picked, nor what is inside it.
  const locked = path.findIndex((p) => !p.id.includes("/") && getNode(doc.nodes, p.id)?.locked);
  return locked >= 0 ? path.slice(0, locked) : path;
}

/**
 * What a press picks, as Figma's: the innermost layer along the path whose parent is "open" — a top-level frame,
 * a selected layer or one of its ancestors. So nothing selected: a top-level frame's direct child; inside a selected
 * layer: the next level down (never two); beside it: its siblings, its parent's siblings… at their own level.
 * `deep` (⌘): the innermost.
 */
export function pickFrom(path: { id: string; el: HTMLElement }[], selection: readonly string[], deep: boolean, root: Element | null): { id: string; el: HTMLElement } | null {
  if (!path.length) return null;
  if (deep) return path[path.length - 1];
  const open = new Set<string>();
  for (const id of selection) {
    let el: HTMLElement | null | undefined = root?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
    if (!el) { open.add(id); continue; }
    while (el && root?.contains(el)) {
      open.add(el.dataset.nodeId!);
      el = el.parentElement?.closest<HTMLElement>("[data-node-id]");
    }
  }
  for (let i = path.length - 1; i >= 2; i--) if (open.has(path[i - 1].id)) return path[i];
  return path[Math.min(1, path.length - 1)];
}

/** A component, a set, an instance or a layer inside one (a composite id): outlined in Figma's purple, not blue. */
export function isComponentish(id: string, nodes: SceneNode[]): boolean {
  if (id.includes("/")) return true;
  const n = getNode(nodes, id);
  return !!n && (n.type === "component" || n.type === "componentSet" || n.type === "instance");
}
