/**
 * The preview's document as the viewer's panels read it, through the engine (read-only, so every read is cached for
 * the session): the layer tree of a page, a layer's parent and its box on the page, and the inspect input (the node
 * with the names of its variables, their collection and mode, and its styles).
 */
import type { Engine } from "@/engine/Engine";
import type { AssetId, Guid, NodeChange } from "@/engine/codec";
import type { BoundName, InspectInput } from "./inspect/model";
import { boundsOf, IDENTITY, multiply, type Affine, type Box } from "./inspect/measure";

export interface LayerNode {
  id: Guid;
  name: string;
  type: string;
  parent: Guid | null;
  /** Top layer first (the Layers panel's order) */
  children: Guid[];
  visible: boolean;
  stackMode?: string;
  stackWrap?: string;
  group: boolean;
  stateGroup: boolean;
  booleanOperation?: string;
}

export interface PageTree {
  page: Guid;
  nodes: Map<Guid, LayerNode>;
  /** The page's top layers, top first */
  roots: Guid[];
}

/** A variable as the Inspect panel shows it: its name, collection and the mode it resolves in here. */
export interface VariableUse extends BoundName {
  collection: string | null;
  mode: string | null;
}

const assetGuid = (a: AssetId | undefined): Guid | null => (a?.guid ? `${a.guid.sessionID}:${a.guid.localID}` : null);

export class ViewerDoc {
  private readonly trees = new Map<Guid, PageTree>();
  private readonly parents = new Map<Guid, Guid | null>();
  private readonly geometry = new Map<Guid, { transform: Affine; size: { x: number; y: number }; parent: Guid | null; type: string } | null>();
  private styleNames: Map<Guid, string> | null = null;
  private collections: Map<Guid, { name: string; modes: Map<Guid, string> }> | null = null;

  constructor(readonly engine: Engine) {}

  tree(page: Guid): PageTree {
    let t = this.trees.get(page);
    if (t) return t;
    const rows = this.engine.layerTree(page);
    const nodes = new Map<Guid, LayerNode>();
    for (const r of rows) {
      if (r.guid === page) continue;
      const extra = r as NodeChange & { isStateGroup?: boolean };
      nodes.set(r.guid, {
        id: r.guid,
        name: r.name ?? "",
        type: r.type ?? "FRAME",
        parent: r.parentIndex?.guid && r.parentIndex.guid !== page ? r.parentIndex.guid : null,
        children: [...(r.childIds ?? [])].reverse(),
        visible: r.visible !== false,
        stackMode: r.stackMode,
        stackWrap: r.stackWrap,
        group: r.type === "FRAME" && r.resizeToFit === true,
        stateGroup: extra.isStateGroup === true,
        booleanOperation: r.booleanOperation,
      });
    }
    const pageRow = rows.find((r) => r.guid === page);
    const roots = pageRow?.childIds ? [...pageRow.childIds].reverse() : [...nodes.values()].filter((n) => n.parent === null).map((n) => n.id);
    for (const n of nodes.values()) this.parents.set(n.id, n.parent);
    t = { page, nodes, roots };
    this.trees.set(page, t);
    return t;
  }

  /** The layer's parent (null: a top layer of its page). */
  parentOf(id: Guid): Guid | null {
    if (this.parents.has(id)) return this.parents.get(id)!;
    const g = this.node(id);
    return g?.parent ?? null;
  }

  private node(id: Guid) {
    if (this.geometry.has(id)) return this.geometry.get(id)!;
    const n = this.engine.readNode(id, { fields: ["transform", "size", "parentIndex"] });
    const parent = n?.parentIndex?.guid ?? null;
    const parentType = parent ? this.engine.readNode(parent, { fields: ["type"] })?.type : undefined;
    const g = n ? { transform: (n.transform as Affine | undefined) ?? IDENTITY, size: n.size ?? { x: 0, y: 0 }, parent: parentType === "CANVAS" || parentType === "DOCUMENT" ? null : parent, type: n.type ?? "" } : null;
    this.geometry.set(id, g);
    if (g && !this.parents.has(id)) this.parents.set(id, g.parent);
    return g;
  }

  /** The layer's bounding box on its page. */
  pageBox(id: Guid): Box | null {
    const g = this.node(id);
    if (!g) return null;
    let m = g.transform;
    let parent = g.parent;
    for (let guard = 0; parent && guard < 256; guard++) {
      const p = this.node(parent);
      if (!p) break;
      m = multiply(p.transform, m);
      parent = p.parent;
    }
    return boundsOf(m, g.size);
  }

  /** The union of the layers' boxes. */
  unionBox(ids: readonly Guid[]): Box | null {
    let out: Box | null = null;
    for (const id of ids) {
      const b = this.pageBox(id);
      if (!b) continue;
      if (!out) out = b;
      else {
        const x = Math.min(out.x, b.x);
        const y = Math.min(out.y, b.y);
        out = { x, y, width: Math.max(out.x + out.width, b.x + b.width) - x, height: Math.max(out.y + out.height, b.y + b.height) - y };
      }
    }
    return out;
  }

  private styles(): Map<Guid, string> {
    if (!this.styleNames) {
      this.styleNames = new Map();
      try {
        for (const s of this.engine.styles(undefined, { includeRemote: true })) this.styleNames.set(s.id, s.name);
      } catch {
        // no styles API: names stay unknown
      }
    }
    return this.styleNames;
  }

  private collectionInfo(): Map<Guid, { name: string; modes: Map<Guid, string> }> {
    if (!this.collections) {
      this.collections = new Map();
      try {
        for (const c of this.engine.variableCollections({ includeRemote: true })) this.collections.set(c.id, { name: c.name, modes: new Map(c.modes.map((m) => [m.modeId, m.name])) });
      } catch {
        // no variables API
      }
    }
    return this.collections;
  }

  /** The variables bound to a layer's properties, by binding target. */
  variablesOf(id: Guid): Record<string, VariableUse> {
    const out: Record<string, VariableUse> = {};
    let bound;
    try {
      bound = this.engine.boundVariables(id);
    } catch {
      return out;
    }
    if (!bound.length) return out;
    const modes = new Map<Guid, Guid | null>();
    try {
      for (const m of this.engine.variableModes(id)) modes.set(m.collectionId, m.resolvedModeId);
    } catch {
      // modes unknown
    }
    const collections = this.collectionInfo();
    for (const b of bound) {
      if (!b.variable) continue;
      const v = this.engine.variable(b.variable);
      if (!v) continue;
      const c = v.collectionId ? collections.get(v.collectionId) : undefined;
      const modeId = v.collectionId ? modes.get(v.collectionId) : null;
      out[b.target] = { name: v.name, codeSyntax: v.codeSyntax, collection: c?.name ?? null, mode: modeId ? (c?.modes.get(modeId) ?? null) : null };
    }
    return out;
  }

  /** Everything the snippets need for one layer. */
  inspect(id: Guid): (InspectInput & { node: NodeChange; variables: Record<string, VariableUse> }) | null {
    const node = this.engine.readNode(id);
    if (!node) return null;
    const parent = this.parentOf(id);
    const parentStackMode = parent ? (this.engine.readNode(parent, { fields: ["stackMode"] })?.stackMode ?? null) : null;
    const styles = this.styles();
    const name = (a: AssetId | undefined) => {
      const g = assetGuid(a);
      return g ? styles.get(g) : undefined;
    };
    return {
      node,
      parentStackMode,
      variables: this.variablesOf(id),
      styles: { fill: name(node.styleIdForFill), stroke: name(node.styleIdForStrokeFill), text: name(node.styleIdForText), effect: name(node.styleIdForEffect) },
    };
  }
}
