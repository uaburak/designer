/**
 * The Layers panel's tree, as plain data (no engine, no React), in two passes
 * as Figma's Layers panel computes it (docs/research: "Improving performance
 * in the layers panel"): PASS 1, the outline — every row's place and kind (its
 * parent, its children in paint order, its type and the flags that decide
 * what may be dropped where and which glyph family it gets); PASS 2, the
 * details a row shows (name, visibility, lock, auto layout, boolean
 * operation), computed only for the rows the panel is about to draw, from the
 * row the outline read brought or from one engine read per window of rows.
 * Also the rows the panel shows (top layer first, children of expanded layers
 * indented) and the panel's selection and drag-and-drop rules — Figma's
 * (docs/research/figma/R7-editor.md).
 */
import type { Guid, NodeChange } from "@/engine/codec";

/** PASS 1 — a row's place and kind: what the hierarchy, the selection rules and drops need. */
export interface OutlineNode {
  id: Guid;
  parent: Guid | null;
  type: string;
  /** Children back to front (paint order, index 0 = bottom), as the engine lists them */
  children: Guid[];
  /** FRAME + resizeToFit (DesignerV2's groups) or an imported GROUP */
  group: boolean;
  /** A component set (FRAME + isStateGroup) */
  stateGroup?: boolean;
  /** An instance's sublayer (ids `I<instance>;<key>…`): it keeps the main's place, no drops, no lock */
  derived?: boolean;
}

/** PASS 2 — what a row shows; read for the rows in view. */
export interface RowDetails {
  name: string;
  visible: boolean;
  locked: boolean;
  /** Auto layout direction, when the engine keeps it */
  stackMode?: string;
  stackWrap?: string;
  /** BOOLEAN_OPERATION's operation (UNION, INTERSECT, SUBTRACT, XOR) */
  booleanOperation?: string;
  /** "Use as mask" */
  mask?: boolean;
  /** A component's slot (FRAME isSlot) */
  slot?: boolean;
  /** A visible image or video fill: the Image / Video glyph (Figma's) for a rectangle */
  media?: "IMAGE" | "VIDEO";
}

/** A row: its outline, and its details filled on first use (`LayerTree.details`). */
export interface TreeNode extends OutlineNode, RowDetails {}

/** What a details read asks the engine for (schema keys of `engine_read_nodes` `fields`). */
export const DETAIL_FIELDS: readonly string[] = ["name", "visible", "locked", "resizeToFit", "stackMode", "stackWrap", "booleanOperation", "isStateGroup", "mask", "isSlot", "fillPaints"];

/** The glyph a fill list gives a row: its top visible image or video fill. */
function mediaOf(fills: unknown): RowDetails["media"] {
  if (!Array.isArray(fills)) return undefined;
  for (let i = fills.length - 1; i >= 0; i--) {
    const p = fills[i] as { type?: string; visible?: boolean };
    if (p?.visible === false) continue;
    if (p?.type === "IMAGE" || p?.type === "VIDEO") return p.type;
  }
  return undefined;
}

/** Reads the layer-tree rows of `ids` (guid, type, name, visible, locked, the optional flags) in one engine call. */
export type RowReader = (ids: readonly Guid[]) => readonly NodeChange[];

const UNKNOWN: RowDetails = { name: "", visible: true, locked: false };

/** A row's details from its engine row. */
export function detailsOf(row: NodeChange | undefined): RowDetails {
  if (!row) return UNKNOWN;
  const extra = row as NodeChange & { stackMode?: string; stackWrap?: string; booleanOperation?: string; mask?: boolean; isSlot?: boolean; fillPaints?: unknown };
  const out: RowDetails = { name: row.name ?? "", visible: row.visible !== false, locked: row.locked === true };
  if (extra.stackMode !== undefined) out.stackMode = extra.stackMode;
  if (extra.stackWrap !== undefined) out.stackWrap = extra.stackWrap;
  if (extra.booleanOperation !== undefined) out.booleanOperation = extra.booleanOperation;
  if (extra.mask === true) out.mask = true;
  if (extra.isSlot === true) out.slot = true;
  const media = mediaOf(extra.fillPaints);
  if (media) out.media = media;
  return out;
}

/**
 * PASS 2's store, one per page: the details of the rows shown so far, computed on first use from the row pass 1
 * brought (a layer-tree row carries them) or read from the engine — `prefetch` reads a window of rows in one call,
 * so a scroll costs one read per window, never a read per row. Shared by every tree of the same page (a patched
 * tree keeps the details of the rows the delta didn't touch); invalidated per row, never whole.
 */
export class RowDetailsStore {
  /** Rows pass 1 or a delta brought, not yet turned into details (freed as they are) */
  private readonly rows = new Map<Guid, NodeChange>();
  /** The details computed so far (the rows shown) */
  private readonly known = new Map<Guid, RowDetails>();
  private readonly read: RowReader | null;
  /** Engine reads made, and the rows they asked for (tests, the perf bench) */
  reads = 0;
  rowsRead = 0;

  constructor(read: RowReader | null = null) {
    this.read = read;
  }

  /** A row pass 1 or a delta brought: its details come from it when first asked (what it had before is dropped). */
  keep(row: NodeChange): void {
    this.rows.set(row.guid, row);
    this.known.delete(row.guid);
  }

  /** Are the row's details in hand (computed, or its row kept) — no engine read needed? */
  has(id: Guid): boolean {
    return this.known.has(id) || this.rows.has(id);
  }

  /** Is the row's details object built (tests: details are computed for the rows shown, not the whole page)? */
  computed(id: Guid): boolean {
    return this.known.has(id);
  }

  /** How many rows have their details built */
  get size(): number {
    return this.known.size;
  }

  /** The row's details: from the row kept, else one engine read of that row (the panel prefetches its window first). */
  of(id: Guid): RowDetails {
    const d = this.known.get(id);
    if (d) return d;
    let row = this.rows.get(id);
    if (!row && this.read) {
      this.reads++;
      this.rowsRead++;
      row = this.read([id])[0];
    }
    const details = detailsOf(row);
    this.known.set(id, details);
    this.rows.delete(id);
    return details;
  }

  /** Reads the rows of `ids` not yet in hand in one engine call (a window of the panel); how many it asked for. */
  prefetch(ids: readonly Guid[]): number {
    if (!this.read) return 0;
    const missing: Guid[] = [];
    for (const id of ids) if (!this.has(id)) missing.push(id);
    if (!missing.length) return 0;
    this.reads++;
    this.rowsRead += missing.length;
    for (const row of this.read(missing)) this.rows.set(row.guid, row);
    return missing.length;
  }

  /** The row changed (NODES_CHANGED, a committed change): its details are read again when next shown. */
  invalidate(id: Guid): void {
    this.rows.delete(id);
    this.known.delete(id);
  }

  /** The row left the document. */
  delete(id: Guid): void {
    this.invalidate(id);
  }
}

/** A row: the outline as own fields, the details through the page's store (built when first asked). */
class Row implements TreeNode {
  readonly id: Guid;
  readonly parent: Guid | null;
  readonly type: string;
  readonly children: Guid[];
  readonly group: boolean;
  readonly stateGroup?: true;
  readonly derived?: true;
  private readonly store: RowDetailsStore;

  constructor(id: Guid, parent: Guid | null, type: string, children: Guid[], group: boolean, stateGroup: boolean, derived: boolean, store: RowDetailsStore) {
    this.id = id;
    this.parent = parent;
    this.type = type;
    this.children = children;
    this.group = group;
    if (stateGroup) this.stateGroup = true;
    if (derived) this.derived = true;
    this.store = store;
  }

  static fromOutline(o: OutlineNode, store: RowDetailsStore): Row {
    return new Row(o.id, o.parent, o.type, o.children, o.group, o.stateGroup === true, o.derived === true, store);
  }

  /** From an engine row (a layer-tree row, or a read with `childIds`) — one allocation per row in pass 1. */
  static fromNode(n: NodeChange, store: RowDetailsStore): Row {
    const extra = n as NodeChange & { isStateGroup?: boolean; derived?: boolean };
    const type = n.type ?? "NONE";
    const group = type === "GROUP" || (type === "FRAME" && n.resizeToFit === true);
    return new Row(n.guid, n.parentIndex?.guid || null, type, n.childIds ?? [], group, extra.isStateGroup === true && type === "FRAME", extra.derived === true || n.guid.startsWith("I"), store);
  }

  get name(): string {
    return this.store.of(this.id).name;
  }
  get visible(): boolean {
    return this.store.of(this.id).visible;
  }
  get locked(): boolean {
    return this.store.of(this.id).locked;
  }
  get stackMode(): string | undefined {
    return this.store.of(this.id).stackMode;
  }
  get stackWrap(): string | undefined {
    return this.store.of(this.id).stackWrap;
  }
  get booleanOperation(): string | undefined {
    return this.store.of(this.id).booleanOperation;
  }
  get mask(): boolean | undefined {
    return this.store.of(this.id).mask;
  }
  get slot(): boolean | undefined {
    return this.store.of(this.id).slot;
  }
  get media(): RowDetails["media"] {
    return this.store.of(this.id).media;
  }
}

export interface LayerTree {
  page: Guid;
  nodes: ReadonlyMap<Guid, TreeNode>;
  /** The page has instances (their derived rows follow their mains) */
  hasInstances?: boolean;
  /** Holds sublayer rows the editor derived from mains (an engine without materialized sublayers): they follow the mains' changes */
  derivedSublayers?: boolean;
  /** PASS 2: the rows' details, built for the rows shown (`RowDetailsStore.prefetch` a window before drawing it) */
  details: RowDetailsStore;
}

export const EMPTY_TREE: LayerTree = { page: "", nodes: new Map(), details: new RowDetailsStore() };

/**
 * The tree from engine rows (each read with `childIds`): pass 1 takes every row's place and kind. `keepRows`
 * (the default: tests, a delta's rows) keeps the rows in `details`, so pass 2 has them without a read; the
 * controller's page read passes false — the rows are let go and pass 2 reads the engine per window (rows the
 * engine can't read, the sublayers derived here for an older engine, are kept whatever `keepRows`). `details`
 * given: the page's store (a patch), else a new one.
 */
export function treeFromNodes(page: Guid, nodes: readonly NodeChange[], details = new RowDetailsStore(), keepRows = true): LayerTree {
  const map = new Map<Guid, TreeNode>();
  let hasInstances = false;
  for (const n of nodes) {
    if (n.type === "INSTANCE") hasInstances = true;
    if (keepRows || (n as { derived?: boolean }).derived === true) details.keep(n);
    map.set(n.guid, Row.fromNode(n, details));
  }
  return { page, nodes: map, hasInstances, details };
}

/**
 * The tree from an outline alone (an engine read of places and kinds, no names): pass 2 reads every row's details
 * from `details`' reader as the panel shows it.
 */
export function treeFromOutline(page: Guid, rows: readonly OutlineNode[], details: RowDetailsStore): LayerTree {
  const map = new Map<Guid, TreeNode>();
  let hasInstances = false;
  for (const o of rows) {
    if (o.type === "INSTANCE") hasInstances = true;
    map.set(o.id, Row.fromOutline(o, details));
  }
  return { page, nodes: map, hasInstances, details };
}

/** Can layers be dropped inside it? */
export function isContainer(node: OutlineNode | undefined): boolean {
  return !!node && !node.derived && (node.type === "FRAME" || node.type === "GROUP" || node.type === "SECTION" || node.type === "SYMBOL" || node.type === "CANVAS");
}

export interface RowData {
  id: Guid;
  depth: number;
  /** Has children (shows the chevron) */
  expandable: boolean;
  expanded: boolean;
}

/**
 * Does the panel list this layer's children in flow order (the first child at the top)? A horizontal or vertical
 * auto layout (wrapping or not) does — Figma's panel follows the flow there (live capture: AL_horizontal, AL_wrap);
 * everything else (the page, frames, groups, a grid) lists the top layer first.
 */
export function flowOrdered(tree: LayerTree, id: Guid): boolean {
  if (id === tree.page) return false;
  const node = tree.nodes.get(id);
  if (!node || (node.type !== "FRAME" && node.type !== "SYMBOL" && node.type !== "INSTANCE")) return false;
  const mode = node.stackMode;
  return mode === "HORIZONTAL" || mode === "VERTICAL";
}

/** The rows the panel shows: top layer first (flow order in an auto layout); an expanded layer's children follow it, one level deeper. */
export function visibleRows(tree: LayerTree, expanded: ReadonlySet<Guid>): RowData[] {
  const rows: RowData[] = [];
  const walk = (id: Guid, depth: number) => {
    const node = tree.nodes.get(id);
    if (!node) return;
    const n = node.children.length;
    const flow = n > 1 && flowOrdered(tree, id);
    for (let k = 0; k < n; k++) {
      const i = flow ? k : n - 1 - k;
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

/** `ids` in the order the panel lists them with everything open (top first; unknown ids last, as given). */
export function inPanelOrder(tree: LayerTree, ids: readonly Guid[]): Guid[] {
  const all = visibleRows(tree, { has: () => true } as unknown as ReadonlySet<Guid>);
  const order = new Map(all.map((r, i) => [r.id, i]));
  return [...ids].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
}

/** How far around a row the panel reads details: the rows above and below it that one window read covers. */
export const DETAILS_WINDOW = { above: 24, below: 48 } as const;

/**
 * The ids whose details one read should bring when `rows[index]` is drawn without them: the window around it, so a
 * scroll costs one read per ~50 rows and the rows about to come into view are already in hand.
 */
export function detailsWindow(rows: readonly RowData[], index: number): Guid[] {
  const from = Math.max(0, index - DETAILS_WINDOW.above);
  const to = Math.min(rows.length, index + DETAILS_WINDOW.below);
  const out: Guid[] = [];
  for (let i = from; i < to; i++) out.push(rows[i].id);
  return out;
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

/**
 * "Collapse layers" (⌥L): the expanded set with this page's layers closed but the selection's ancestors (Figma:
 * "all expanded layers collapse except for your selection"); other pages' entries are kept.
 */
export function collapsedLayers(tree: LayerTree, selection: readonly Guid[], expanded: ReadonlySet<Guid>): ReadonlySet<Guid> {
  const kept = new Set<Guid>();
  for (const id of expanded) if (!tree.nodes.has(id)) kept.add(id);
  return revealed(tree, selection, kept);
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
  if (!node || node.derived) return null;
  if (moving.has(row.id) || ancestorsOf(tree, row.id).some((a) => moving.has(a))) return null;
  const position = dropZone(fraction, isContainer(node));
  // The top of a layer's children as listed: the top of the paint order, or the flow's start in an auto layout.
  const top = (id: Guid, kids: readonly Guid[]) => (flowOrdered(tree, id) ? 0 : without(kids, moving).length);
  if (position === "inside") return { row: row.id, position, parent: row.id, index: top(row.id, node.children) };
  if (position === "after" && row.expanded) return { row: row.id, position, parent: row.id, index: top(row.id, node.children) };
  const parentId = node.parent ?? tree.page;
  const parent = tree.nodes.get(parentId);
  if (!parent) return null;
  const siblings = without(parent.children, moving);
  const at = siblings.indexOf(row.id);
  if (at < 0) return null;
  const above = position === "before";
  if (flowOrdered(tree, parentId)) return { row: row.id, position, parent: parentId, index: above ? at : at + 1 };
  return { row: row.id, position, parent: parentId, index: above ? at + 1 : at };
}

/** The layers a drag moves: the selection when the pressed row is in it (outermost only, in panel order), else that row. */
export function draggedLayers(tree: LayerTree, rows: readonly RowData[], selection: readonly Guid[], pressed: Guid): Guid[] {
  if (!selection.includes(pressed)) return [pressed];
  const order = new Map(rows.map((r, i) => [r.id, i]));
  return normalizeSelection(tree, selection).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}
