/**
 * Figma's DiffChunk grouping (docs/data.md §15.4 "Grouping"): every changed node belongs to one chunk, keyed by its
 * display node — the layer Review and Resolve conflicts list.
 *
 *   on a page                       → its top-level layer (the ancestor whose parent is a CANVAS)
 *   a page (name, order, background) → the page
 *   a variable / mode / override    → its collection (VARIABLE_SET)
 *   a style                         → the style
 *   a component or variant (0:2)    → the component or its set
 *   a library copy                  → the copy's root
 *   DOCUMENT                        → the document
 */
import type { NodeChange } from "../schema/document.generated";
import { guidKey } from "../schema/guid";
import type { NodeTable } from "../schema/patch";
import type { DiffChunk, Side } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- generic field access on decoded kiwi objects */

const parentKey = (n: NodeChange | undefined): string | null => (n?.parentIndex?.guid ? guidKey(n.parentIndex.guid) : null);

/** The display node ("s:l") a node of `table` belongs to (itself when the table doesn't hold it). */
export function displayNodeOf(table: NodeTable, guidKeyOf: string): string {
  const n: any = table.nodes.get(guidKeyOf);
  if (!n) return guidKeyOf;
  if (n.type === "DOCUMENT" || n.type === "CANVAS") return guidKeyOf;
  if (n.type === "VARIABLE" && n.variableSetID?.guid) {
    const c = guidKey(n.variableSetID.guid);
    if (table.nodes.has(c)) return c;
  }
  let cur = guidKeyOf;
  let copyRoot: string | null = null;
  for (let guard = 0; guard < 10_000; guard++) {
    const node: any = table.nodes.get(cur);
    if (node?.sourceLibraryKey) copyRoot = cur;
    const p = parentKey(node);
    const parent: any = p !== null ? table.nodes.get(p) : undefined;
    if (!parent || parent.type === "CANVAS" || parent.type === "DOCUMENT" || p === guidKeyOf) return copyRoot ?? cur;
    cur = p!;
  }
  return copyRoot ?? cur;
}

/** Ancestors of a node from the root down (the node itself excluded). */
export function ancestorsOf(table: NodeTable, key: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([key]);
  let p = parentKey(table.nodes.get(key));
  while (p !== null && !seen.has(p) && table.nodes.has(p)) {
    out.push(p);
    seen.add(p);
    p = parentKey(table.nodes.get(p));
  }
  return out.reverse();
}

/** The page (CANVAS) a node is on, or null (the document). */
export function canvasOf(table: NodeTable, key: string): string | null {
  const n: any = table.nodes.get(key);
  if (!n) return null;
  if (n.type === "CANVAS") return key;
  for (const a of ancestorsOf(table, key).reverse()) if (table.nodes.get(a)?.type === "CANVAS") return a;
  return null;
}

/**
 * Collects chunks by display node. Chunk indices are given in `finish` order — the document first, then pages in
 * page order, then display nodes by position and GUID — so the same inputs always number them the same.
 */
export class ChunkSet {
  private readonly byDisplay = new Map<string, DiffChunk>();
  private readonly late: DiffChunk[] = [];
  private frozen = false;
  readonly list: DiffChunk[] = [];

  /** `tables`: where to read a display node's name, type and page, in order of preference */
  constructor(
    private readonly tables: NodeTable[],
    /** Is the display node present before (base) and after (the incoming side)? */
    private readonly phaseOf: (display: string) => DiffChunk["phase"],
  ) {}

  private tableFor(key: string): NodeTable | null {
    for (const t of this.tables) if (t.nodes.has(key)) return t;
    return null;
  }

  /** The chunk of a display node (made on first use; after `finish`, appended at the end). */
  chunk(display: string): DiffChunk {
    let c = this.byDisplay.get(display);
    if (c) return c;
    const t = this.tableFor(display);
    const n: any = t?.nodes.get(display);
    const canvas = t ? canvasOf(t, display) : null;
    const cn: any = canvas && t ? t.nodes.get(canvas) : null;
    c = {
      index: -1,
      displayNode: display,
      displayName: typeof n?.name === "string" ? n.name : "",
      displayType: typeof n?.type === "string" ? n.type : "",
      phase: this.phaseOf(display),
      canvasId: canvas ?? "",
      canvasName: typeof cn?.name === "string" ? cn.name : "",
      canvasIsInternal: !!cn?.internalOnly,
      nodeChanges: [],
      chunksAffectingThisChunk: [],
      parentHierarchyGuids: t ? ancestorsOf(t, display) : [],
      changedOn: [],
      conflicts: [],
    };
    this.byDisplay.set(display, c);
    if (this.frozen) {
      c.index = this.list.length;
      this.list.push(c);
      this.late.push(c);
    }
    return c;
  }

  has(display: string): boolean {
    return this.byDisplay.has(display);
  }

  get(display: string): DiffChunk | undefined {
    return this.byDisplay.get(display);
  }

  markChanged(display: string, side: Side): void {
    const c = this.chunk(display);
    if (!c.changedOn.includes(side)) c.changedOn.push(side);
  }

  /** Numbers the chunks made so far (stable order); chunks made afterwards are appended. */
  finish(): DiffChunk[] {
    if (this.frozen) return this.list;
    const sortKey = (c: DiffChunk): [number, string, string, string] => {
      if (c.displayType === "DOCUMENT") return [0, "", "", c.displayNode];
      const t = this.tableFor(c.displayNode);
      const canvasPos = c.canvasId && t ? (t.nodes.get(c.canvasId)?.parentIndex?.position ?? "") : "";
      const ownPos = c.displayNode === c.canvasId ? "" : (t?.nodes.get(c.displayNode)?.parentIndex?.position ?? "");
      return [1, canvasPos, ownPos, c.displayNode];
    };
    const keyed = [...this.byDisplay.values()].map((c) => ({ c, k: sortKey(c) }));
    keyed.sort((x, y) => {
      for (let i = 0; i < 4; i++) {
        const a = x.k[i];
        const b = y.k[i];
        if (a < b) return -1;
        if (a > b) return 1;
      }
      return 0;
    });
    keyed.forEach(({ c }, i) => {
      c.index = i;
      this.list.push(c);
    });
    this.frozen = true;
    return this.list;
  }
}
