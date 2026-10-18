/**
 * The preview's document as the viewer's panels read it, through the engine (read-only, so every read is cached for
 * the session): the layer tree of a page, a layer's parent and its box on the page, and the inspect input (the node
 * with the names of its variables, their collection and mode, and its styles).
 */
import type { Engine } from "@/engine/Engine";
import type { AssetId, Guid, NodeChange } from "@/engine/codec";
import type { BoundName, InspectInput } from "./inspect/model";
import { boundsOf, IDENTITY, multiply, type Affine, type Box } from "./inspect/measure";
import { annotationsOf, statusOf, type AnnotationView, type AssetNode, type DevStatus, type StatusNode } from "./inspect/devMode";
import { statusIn, type FrameStatus, type PluginDataEntry } from "@/editor/workflowStatus";

/** A design with a status: the owner's (`workflow`) and Figma's own, if any (`status`, "CHANGED" when edited since). */
export interface DesignStatus {
  id: Guid;
  name: string;
  status: DevStatus | null;
  workflow: FrameStatus;
}

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

/** A style reference's GUID ("s:l"; the engine's reads may write it as an object or as the string). */
const assetGuid = (a: AssetId | undefined): Guid | null => {
  const g = a?.guid as AssetId["guid"] | string | undefined;
  if (!g) return null;
  return typeof g === "string" ? g : `${g.sessionID}:${g.localID}`;
};

export class ViewerDoc {
  private readonly trees = new Map<Guid, PageTree>();
  private readonly parents = new Map<Guid, Guid | null>();
  private readonly geometry = new Map<Guid, { transform: Affine; size: { x: number; y: number }; parent: Guid | null; type: string } | null>();
  private styleNames: Map<Guid, string> | null = null;
  private collections: Map<Guid, { name: string; modes: Map<Guid, string> }> | null = null;
  private readonly statusCache = new Map<Guid, DesignStatus[]>();
  private readonly annotationCache = new Map<Guid, { id: Guid; notes: AnnotationView[] }[]>();

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

  /**
   * The page's designs with a status — the owner's (docs/editor.md "Frame status (ours)": `designer.workflow` in
   * pluginData, else the one Figma's "Ready for dev" / "Completed" stands for), with Figma's own beside it (`status`, for
   * "Changed"): its top-level frames, sections, components and instances and those inside sections, in the Layers
   * panel's order.
   */
  statuses(page: Guid): DesignStatus[] {
    const cached = this.statusCache.get(page);
    if (cached) return cached;
    const tree = this.tree(page);
    const ids: Guid[] = [];
    const walk = (list: readonly Guid[]) => {
      for (const id of list) {
        const n = tree.nodes.get(id);
        if (!n || (n.type !== "FRAME" && n.type !== "SECTION" && n.type !== "SYMBOL" && n.type !== "INSTANCE")) continue;
        ids.push(id);
        if (n.type === "SECTION") walk(n.children);
      }
    };
    walk(tree.roots);
    const out: DesignStatus[] = [];
    if (ids.length) {
      const rows = this.engine.readNodes(ids, { fields: ["sectionStatusInfo", "editInfo", "pluginData"] }) as (NodeChange & StatusNode & { pluginData?: PluginDataEntry[] })[];
      rows.forEach((r, i) => {
        const s = r?.sectionStatusInfo?.status;
        const workflow = statusIn(r?.pluginData, s === 1 ? "BUILD" : s === 2 ? "COMPLETED" : typeof s === "string" ? s : null);
        if (workflow) out.push({ id: ids[i], name: tree.nodes.get(ids[i])?.name ?? "", status: statusOf(r), workflow });
      });
    }
    this.statusCache.set(page, out);
    return out;
  }

  /** The layers of a page that carry annotations, with them. */
  annotations(page: Guid): { id: Guid; notes: AnnotationView[] }[] {
    const cached = this.annotationCache.get(page);
    if (cached) return cached;
    const ids = [...this.tree(page).nodes.keys()];
    const out: { id: Guid; notes: AnnotationView[] }[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const rows = this.engine.readNodes(batch, { fields: ["annotations"] }) as (NodeChange & { annotations?: unknown[] })[];
      rows.forEach((r, k) => {
        if (!r?.annotations?.length) return;
        const full = this.engine.readNode(batch[k]);
        if (full) out.push({ id: batch[k], notes: annotationsOf({ ...full, annotations: r.annotations } as never) });
      });
    }
    this.annotationCache.set(page, out);
    return out;
  }

  /** What the asset finder reads of a layer (inspect/devMode.ts detectAssets). */
  assetNode(id: Guid): AssetNode | null {
    const n = this.engine.readNode(id, { fields: ["name", "type", "visible", "size", "fillPaints", "resizeToFit"], childIds: true }) as (NodeChange & { childIds?: Guid[] }) | null;
    if (!n) return null;
    const type = n.type === "FRAME" && (n as { resizeToFit?: boolean }).resizeToFit ? "GROUP" : (n.type ?? "FRAME");
    return { id, name: n.name ?? "", type, visible: n.visible !== false, size: n.size ?? { x: 0, y: 0 }, fillPaints: n.fillPaints, children: n.childIds ?? [] };
  }

  /** Everything the snippets need for one layer. */
  inspect(id: Guid): (InspectInput & { node: NodeChange; variables: Record<string, VariableUse> }) | null {
    const node = this.engine.readNode(id);
    if (!node) return null;
    const parent = this.parentOf(id);
    const parentNode = parent ? this.engine.readNode(parent, { fields: ["type", "name", "size", "stackMode", "stackPrimarySizing", "gridRows", "gridColumns", "gridReflowEnabled"] }) : null;
    const parentStackMode = parentNode?.stackMode ?? null;
    // A wrapping auto layout writes `align-content` unless every child fills its counter axis (atlas 14 §5.4).
    const kids = node.stackWrap === "WRAP" ? ((this.engine.readNode(id, { fields: ["type"], childIds: true }) as { childIds?: Guid[] } | null)?.childIds ?? []) : [];
    const childrenFill = kids.length > 0 && kids.every((k) => this.engine.readNode(k, { fields: ["stackChildAlignSelf"] })?.stackChildAlignSelf === "STRETCH");
    const styles = this.styles();
    const name = (a: AssetId | undefined) => {
      const g = assetGuid(a);
      return g ? styles.get(g) : undefined;
    };
    return {
      node,
      parentStackMode,
      parent: parentNode,
      childrenFill,
      variables: this.variablesOf(id),
      styles: { fill: name(node.styleIdForFill), stroke: name(node.styleIdForStrokeFill), text: name(node.styleIdForText), effect: name(node.styleIdForEffect) },
    };
  }
}
