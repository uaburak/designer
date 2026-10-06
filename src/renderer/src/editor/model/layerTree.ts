/**
 * The Layers panel's tree, as plain data (no engine, no React): the page's
 * nodes with their children in paint order, the rows the panel shows (top
 * layer first, children of expanded layers indented), and the panel's
 * selection and drag-and-drop rules — Figma's (docs/research/figma/R7-editor.md).
 */
import type { Guid, NodeChange } from "@/engine/codec";

export interface TreeNode {
  id: Guid;
  parent: Guid | null;
  type: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** FRAME + resizeToFit (DesignerV2's groups) or an imported GROUP */
  group: boolean;
  /** Auto layout direction, when the engine keeps it */
  stackMode?: string;
  stackWrap?: string;
  /** BOOLEAN_OPERATION's operation (UNION, INTERSECT, SUBTRACT, XOR) */
  booleanOperation?: string;
  /** Children back to front (paint order, index 0 = bottom), as the engine lists them */
  children: Guid[];
}

export interface LayerTree {
  page: Guid;
  nodes: ReadonlyMap<Guid, TreeNode>;
}

export const EMPTY_TREE: LayerTree = { page: "", nodes: new Map() };

/** The tree from engine reads (each node read with `childIds`). */
export function treeFromNodes(page: Guid, nodes: readonly NodeChange[]): LayerTree {
  const map = new Map<Guid, TreeNode>();
  for (const n of nodes) {
    const extra = n as NodeChange & { stackMode?: string; stackWrap?: string; booleanOperation?: string };
    map.set(n.guid, {
      id: n.guid,
      parent: n.parentIndex?.guid || null,
      type: n.type ?? "NONE",
      name: n.name ?? "",
      visible: n.visible !== false,
      locked: n.locked === true,
      group: n.type === "GROUP" || (n.type === "FRAME" && n.resizeToFit === true),
      stackMode: extra.stackMode,
      stackWrap: extra.stackWrap,
      booleanOperation: extra.booleanOperation,
      children: n.childIds ?? [],
    });
  }
  return { page, nodes: map };
}

/** Can layers be dropped inside it? */
export function isContainer(node: TreeNode | undefined): boolean {
  return !!node && (node.type === "FRAME" || node.type === "GROUP" || node.type === "SECTION" || node.type === "SYMBOL" || node.type === "CANVAS");
}

export interface RowData {
  id: Guid;
  depth: number;
  /** Has children (shows the chevron) */
  expandable: boolean;
  expanded: boolean;
}

/** The rows the panel shows: top layer first; an expanded layer's children follow it, one level deeper. */
export function visibleRows(tree: LayerTree, expanded: ReadonlySet<Guid>): RowData[] {
  const rows: RowData[] = [];
  const walk = (id: Guid, depth: number) => {
    const node = tree.nodes.get(id);
    if (!node) return;
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = tree.nodes.get(node.children[i]);
      if (!child) continue;
      const expandable = child.children.length > 0;
      const open = expandable && expanded.has(child.id);
      rows.push({ id: child.id, depth, expandable, expanded: open });
      if (open) walk(child.id, depth + 1);
    }
  };
  walk(tree.page, 0);
  return rows;
}

/** The layer's ancestors below the page, nearest first. */
export function ancestorsOf(tree: LayerTree, id: Guid): Guid[] {
  const out: Guid[] = [];
  const seen = new Set<Guid>([id]);
  let at = tree.nodes.get(id)?.parent ?? null;
  while (at && at !== tree.page && !seen.has(at) && tree.nodes.has(at)) {
    out.push(at);
    seen.add(at);
    at = tree.nodes.get(at)?.parent ?? null;
  }
  return out;
}

export function isAncestor(tree: LayerTree, ancestor: Guid, of: Guid): boolean {
  return ancestorsOf(tree, of).includes(ancestor);
}

/** A selection never holds a layer together with one of its ancestors: the ancestor wins; order kept, duplicates dropped. */
export function normalizeSelection(tree: LayerTree, ids: readonly Guid[]): Guid[] {
  const set = new Set(ids);
  const out: Guid[] = [];
  for (const id of ids) {
    if (out.includes(id)) continue;
    if (ancestorsOf(tree, id).some((a) => set.has(a))) continue;
    out.push(id);
  }
  return out;
}

/** ⇧-click: every row from the anchor to the clicked one (as shown), ancestors winning over their children. */
export function rangeSelection(tree: LayerTree, rows: readonly RowData[], anchor: Guid | null, target: Guid): Guid[] {
  const to = rows.findIndex((r) => r.id === target);
  const from = anchor ? rows.findIndex((r) => r.id === anchor) : -1;
  if (to < 0) return [];
  if (from < 0) return [target];
  const [a, b] = from <= to ? [from, to] : [to, from];
  return normalizeSelection(tree, rows.slice(a, b + 1).map((r) => r.id));
}

/** ⌘-click: the layer leaves the selection, or joins it (its ancestors and descendants leave). */
export function toggleSelection(tree: LayerTree, selection: readonly Guid[], id: Guid): Guid[] {
  if (selection.includes(id)) return selection.filter((s) => s !== id);
  const kept = selection.filter((s) => !isAncestor(tree, s, id) && !isAncestor(tree, id, s));
  return [...kept, id];
}

/** The expanded set with every ancestor of `ids` opened (Figma reveals a canvas selection); the same set when nothing opens. */
export function revealed(tree: LayerTree, ids: readonly Guid[], expanded: ReadonlySet<Guid>): ReadonlySet<Guid> {
  let next: Set<Guid> | null = null;
  for (const id of ids)
    for (const a of ancestorsOf(tree, id))
      if (!expanded.has(a) && !next?.has(a)) {
        next ??= new Set(expanded);
        next.add(a);
      }
  return next ?? expanded;
}

/** ⌥-click on a chevron: the layer and every descendant open (or all closed). */
export function withSubtree(tree: LayerTree, id: Guid, expanded: ReadonlySet<Guid>, open: boolean): Set<Guid> {
  const next = new Set(expanded);
  const walk = (at: Guid) => {
    const node = tree.nodes.get(at);
    if (!node || !node.children.length) return;
    if (open) next.add(at);
    else next.delete(at);
    node.children.forEach(walk);
  };
  walk(id);
  return next;
}

export type RunPart = "start" | "middle" | "end" | "single";

/**
 * Contiguous highlighted rows (selected, or inside a selected layer) draw as
 * one block: corners only at its ends (LayerRow `run`).
 */
export function selectionRuns(rows: readonly RowData[], highlighted: (id: Guid) => boolean): Map<Guid, RunPart> {
  const out = new Map<Guid, RunPart>();
  let i = 0;
  while (i < rows.length) {
    if (!highlighted(rows[i].id)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < rows.length && highlighted(rows[j + 1].id)) j++;
    if (i === j) out.set(rows[i].id, "single");
    else for (let k = i; k <= j; k++) out.set(rows[k].id, k === i ? "start" : k === j ? "end" : "middle");
    i = j + 1;
  }
  return out;
}

// ---- Drag and drop ------------------------------------------------------------------------

export type DropPosition = "before" | "after" | "inside";

export interface DropTarget {
  /** The row showing the indicator, and where on it */
  row: Guid;
  position: DropPosition;
  /** Where the dragged layers go: `index` in the parent's paint order (0 = bottom), counted without them (Engine.moveNodes) */
  parent: Guid;
  index: number;
}

/** Where on a row the pointer is: a container's middle half drops inside it; elsewhere above or below. */
export function dropZone(fraction: number, container: boolean): DropPosition {
  if (!container) return fraction < 0.5 ? "before" : "after";
  return fraction < 0.25 ? "before" : fraction > 0.75 ? "after" : "inside";
}

const without = (ids: readonly Guid[], moving: ReadonlySet<Guid>) => ids.filter((id) => !moving.has(id));

/**
 * The drop for a pointer over `rows[rowIndex]` at `fraction` (0 top … 1
 * bottom) of its height, dragging `moving`; null where nothing may go (on or
 * into a dragged layer). Above a row = just above it in paint order; below a
 * row = just below it, or — for an expanded layer, whose children follow —
 * the top of its children; inside = the top of its children.
 */
export function dropTarget(tree: LayerTree, rows: readonly RowData[], rowIndex: number, fraction: number, moving: ReadonlySet<Guid>): DropTarget | null {
  if (!rows.length) return null;
  if (rowIndex >= rows.length) {
    // Under every row: the bottom of the page.
    const last = rows[rows.length - 1];
    return { row: last.id, position: "after", parent: tree.page, index: 0 };
  }
  const row = rows[Math.max(0, rowIndex)];
  const node = tree.nodes.get(row.id);
  if (!node) return null;
  if (moving.has(row.id) || ancestorsOf(tree, row.id).some((a) => moving.has(a))) return null;
  const position = dropZone(fraction, isContainer(node));
  if (position === "inside") return { row: row.id, position, parent: row.id, index: without(node.children, moving).length };
  if (position === "after" && row.expanded) return { row: row.id, position, parent: row.id, index: without(node.children, moving).length };
  const parentId = node.parent ?? tree.page;
  const parent = tree.nodes.get(parentId);
  if (!parent) return null;
  const siblings = without(parent.children, moving);
  const at = siblings.indexOf(row.id);
  if (at < 0) return null;
  return { row: row.id, position, parent: parentId, index: position === "before" ? at + 1 : at };
}

/** The layers a drag moves: the selection when the pressed row is in it (outermost only, in panel order), else that row. */
export function draggedLayers(tree: LayerTree, rows: readonly RowData[], selection: readonly Guid[], pressed: Guid): Guid[] {
  if (!selection.includes(pressed)) return [pressed];
  const order = new Map(rows.map((r, i) => [r.id, i]));
  return normalizeSelection(tree, selection).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}
