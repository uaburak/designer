// The Layers list of a page, as the app's panel orders it (editor/model/layerTree.ts): top layer first, an auto
// layout's children in their flow order; a frame open when the visitor opened it or something inside is selected.
import type { IconName } from "@/ds/icons/Icon";
import type { NodeChange } from "@/engine/codec";

export interface LayerRowModel {
  id: string;
  depth: number;
  name: string;
  icon: IconName;
  iconLabel: string;
  /** undefined: no children */
  expanded?: boolean;
  visible: boolean;
  locked: boolean;
  strong: boolean;
  selected: boolean;
  selectedAncestor: boolean;
  run?: "start" | "middle" | "end" | "single";
}

type Node = Pick<NodeChange, "guid" | "type" | "name" | "visible" | "locked" | "childIds" | "stackMode" | "resizeToFit" | "parentIndex">;

export function layerIcon(n: Node): [IconName, string] {
  switch (n.type) {
    case "FRAME":
      if (n.resizeToFit) return ["16.group", "Group"];
      if (n.stackMode === "HORIZONTAL") return ["16.autolayout.horizontal", "Auto layout"];
      if (n.stackMode === "VERTICAL") return ["16.autolayout.vertical", "Auto layout"];
      return ["16.frame", "Frame"];
    case "TEXT":
      return ["16.text", "Text"];
    case "ELLIPSE":
      return ["16.ellipse", "Ellipse"];
    case "LINE":
      return ["16.line", "Line"];
    case "STAR":
      return ["16.star", "Star"];
    case "REGULAR_POLYGON":
      return ["16.polygon", "Polygon"];
    case "VECTOR":
    case "BOOLEAN_OPERATION":
      return ["16.vector", "Vector"];
    case "SECTION":
      return ["16.section", "Section"];
    case "SYMBOL":
      return ["16.component", "Component"];
    case "INSTANCE":
      return ["16.instance", "Instance"];
    default:
      return ["16.rectangle", "Rectangle"];
  }
}

/** A NODE_CHANGES message's nodes with their children listed (back to front), for the list before the engine runs. */
export function withChildIds(nodes: readonly NodeChange[]): NodeChange[] {
  const kids = new Map<string, { guid: string; position: string }[]>();
  for (const n of nodes) {
    const p = n.parentIndex;
    if (!p) continue;
    const list = kids.get(p.guid) ?? [];
    list.push({ guid: n.guid, position: p.position });
    kids.set(p.guid, list);
  }
  return nodes.map((n) => ({ ...n, childIds: (kids.get(n.guid) ?? []).sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0)).map((k) => k.guid) }));
}

export function layerRows(nodes: readonly Node[], page: string, expanded: ReadonlySet<string>, selection: ReadonlySet<string>): LayerRowModel[] {
  const byId = new Map(nodes.map((n) => [n.guid, n]));
  const rows: LayerRowModel[] = [];
  const parentOf = new Map<string, string>();
  for (const n of nodes) for (const c of n.childIds ?? []) parentOf.set(c, n.guid);
  const insideSelection = (id: string) => {
    for (let p = parentOf.get(id); p && p !== page; p = parentOf.get(p)) if (selection.has(p)) return true;
    return false;
  };
  const containsSelection = (id: string) => {
    for (const s of selection) for (let p = parentOf.get(s); p; p = parentOf.get(p)) if (p === id) return true;
    return false;
  };
  const walk = (id: string, depth: number) => {
    const n = byId.get(id);
    if (!n) return;
    const kids = n.childIds ?? [];
    const open = kids.length ? expanded.has(id) || containsSelection(id) : undefined;
    const [icon, iconLabel] = layerIcon(n);
    rows.push({
      id,
      depth,
      name: n.name ?? "",
      icon,
      iconLabel,
      expanded: open,
      visible: n.visible !== false,
      locked: !!n.locked,
      strong: depth === 0 && n.type === "FRAME" && !n.resizeToFit,
      selected: selection.has(id),
      selectedAncestor: insideSelection(id),
    });
    if (open) for (const c of order(n, kids)) walk(c, depth + 1);
  };
  const root = byId.get(page);
  for (const c of order(root, root?.childIds ?? [])) walk(c, 0);
  // Contiguous selected rows draw as one block
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].selected) continue;
    const prev = rows[i - 1]?.selected;
    const next = rows[i + 1]?.selected;
    rows[i].run = prev && next ? "middle" : prev ? "end" : next ? "start" : "single";
  }
  return rows;
}

/** Top first; an auto layout lists its children in flow order. */
const order = (parent: Node | undefined, kids: readonly string[]) => (parent?.stackMode === "HORIZONTAL" || parent?.stackMode === "VERTICAL" ? [...kids] : [...kids].reverse());
