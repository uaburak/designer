/**
 * Edits the engine has no command for yet, written as setProps on the
 * selection (one undo step each), and geometry reads the panels and rulers
 * share. When the engine grows a command (FLIP_*, engine_set_geometry…),
 * these defer to it.
 */
import type { Guid, Matrix, NodeChange, Vector } from "@/engine/codec";
import type { EditorController } from "./controller";
import { boundsOf, IDENTITY, multiply, rotateAbout, unionBoxes, type Box } from "./model/geometry";

const isGroup = (n: NodeChange | null) => !!n && (n.type === "GROUP" || (n.type === "FRAME" && n.resizeToFit === true));

/** The product of the group ancestors' transforms up to the nearest non-group ancestor (X/Y are measured from there). */
export function groupChain(ed: EditorController, node: Pick<NodeChange, "parentIndex">): Matrix {
  let chain = IDENTITY;
  let parent = node.parentIndex?.guid ? ed.store.readNode(node.parentIndex.guid) : null;
  for (let depth = 0; parent && isGroup(parent) && depth < 64; depth++) {
    chain = multiply(parent.transform ?? IDENTITY, chain);
    parent = parent.parentIndex?.guid ? ed.store.readNode(parent.parentIndex.guid) : null;
  }
  return chain;
}

/** The node's transform in page space. */
export function worldTransform(ed: EditorController, node: NodeChange): Matrix {
  let m = node.transform ?? IDENTITY;
  let parent = node.parentIndex?.guid ? ed.store.readNode(node.parentIndex.guid) : null;
  for (let depth = 0; parent && parent.type !== "CANVAS" && parent.type !== "DOCUMENT" && depth < 256; depth++) {
    m = multiply(parent.transform ?? IDENTITY, m);
    parent = parent.parentIndex?.guid ? ed.store.readNode(parent.parentIndex.guid) : null;
  }
  return m;
}

/** The page-space bounds of nodes (groups by their children, as the engine draws them). */
export function pageBounds(ed: EditorController, ids: readonly Guid[]): Box | null {
  const boxes: Box[] = [];
  const visit = (id: Guid, depth: number) => {
    const n = ed.store.readNode(id);
    if (!n || depth > 64) return;
    if (isGroup(n)) {
      const kids = ed.engine.readNode(id, { childIds: true })?.childIds ?? [];
      kids.forEach((k) => visit(k, depth + 1));
      return;
    }
    boxes.push(boundsOf(worldTransform(ed, n), n.size ?? { x: 0, y: 0 }));
  };
  ids.forEach((id) => visit(id, 0));
  return unionBoxes(boxes);
}

/** The top-level node (a child of the page) holding `id`, or null. */
export function topLevelOf(ed: EditorController, id: Guid): NodeChange | null {
  let n = ed.store.readNode(id);
  for (let depth = 0; n && depth < 256; depth++) {
    const parent = n.parentIndex?.guid ? ed.store.readNode(n.parentIndex.guid) : null;
    if (!parent || parent.type === "CANVAS") return n;
    n = parent;
  }
  return null;
}

/**
 * Rewrites the transforms of the selection, grouped by parent: `fn` gets
 * each node's transform and the centre of its siblings' union box (parent
 * space) — Figma turns and flips a multi-selection as a whole.
 */
function transformSelection(ed: EditorController, label: string, fn: (m: Matrix, center: Vector) => Matrix): void {
  const nodes = ed.selectedNodes().filter((n) => n.transform && n.size);
  if (!nodes.length) return;
  const byParent = new Map<string, NodeChange[]>();
  for (const n of nodes) {
    const p = n.parentIndex?.guid ?? "";
    byParent.set(p, [...(byParent.get(p) ?? []), n]);
  }
  ed.batch(label, () => {
    for (const siblings of byParent.values()) {
      const box = unionBoxes(siblings.map((n) => boundsOf(n.transform!, n.size!)))!;
      const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      for (const n of siblings) ed.engine.setProps([n.guid], { transform: fn(n.transform!, center) });
    }
  });
}

/** Turns the selection by `degrees` (Figma's sense: positive = counter-clockwise, "Rotate 90° left"). */
export function rotateSelection(ed: EditorController, degrees: number): void {
  transformSelection(ed, "Rotate", (m, c) => rotateAbout(m, c, degrees));
}

/** Zooms to `zoom` about the viewport's centre. */
export function zoomTo(ed: EditorController, zoom: number): void {
  const canvas = ed.canvas;
  if (!canvas) return;
  const cam = ed.engine.getCamera();
  const cx = canvas.clientWidth / 2;
  const cy = canvas.clientHeight / 2;
  const wx = (cx - cam.x) / cam.zoom;
  const wy = (cy - cam.y) / cam.zoom;
  ed.engine.setCamera({ x: Math.round(cx - wx * zoom), y: Math.round(cy - wy * zoom), zoom });
}
