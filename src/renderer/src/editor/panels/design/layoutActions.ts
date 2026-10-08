/**
 * Layout section actions that change several layers at once (Figma's live panel):
 * - "Resize to fit" (⌥⇧⌘R): a frame (or section) shrinks or grows to its children's bounds, the children staying
 *   where they are on the page;
 * - a group's W / H: what is in it scales (as the resize handles do: aligned layers grow along their axes, turned
 *   ones follow with their centre), anchored at the group's top left;
 * - "Spacing": the gap between several layers (or a group's children) along the axis they line up on.
 */
import type { ChangeInfo } from "@/ds";
import type { Guid, Matrix, NodeChange as EngineNode } from "@/engine/codec";

/** A node as the panel reads it (its real type as a string). */
type NodeChange = Omit<EngineNode, "type"> & { type?: string };
import type { EditorController } from "../../controller";
import { worldTransform } from "../../actions";
import { boundsOf, IDENTITY, invert, multiply, unionBoxes } from "../../model/geometry";
import { respace, type SpacingAxis, type SpacingItem } from "../../model/spacing";

const isGroup = (n: NodeChange | null | undefined) => !!n && (n.type === "GROUP" || (n.type === "FRAME" && n.resizeToFit === true));

function childrenOf(ed: EditorController, id: Guid): NodeChange[] {
  const ids = (ed.engine.readNodes([id], { childIds: true })[0]?.childIds ?? []) as Guid[];
  return ids.length ? ed.engine.readNodes(ids) : [];
}

/** Can "Resize to fit" change these (frames or sections with children, not auto layout, not groups)? */
export function canResizeToFit(nodes: readonly NodeChange[]): boolean {
  return nodes.some((n) => (n.type === "FRAME" || n.type === "SECTION" || n.type === "SYMBOL") && !isGroup(n) && (n.stackMode ?? "NONE") === "NONE");
}

/** "Resize to fit": each frame takes its children's bounds; the children don't move on the page. One undo step. */
export function resizeToFit(ed: EditorController, refs: readonly Guid[]): void {
  ed.batch("Resize to fit", () => {
    for (const f of ed.engine.readNodes(refs)) {
      if (!(f.type === "FRAME" || f.type === "SECTION" || f.type === "SYMBOL") || isGroup(f) || (f.stackMode && f.stackMode !== "NONE")) continue;
      const kids = childrenOf(ed, f.guid).filter((c) => c.visible !== false);
      const box = unionBoxes(kids.map((c) => boundsOf(c.transform ?? IDENTITY, c.size ?? { x: 0, y: 0 })));
      if (!box || box.w <= 0 || box.h <= 0) continue;
      const shift: Matrix = { m00: 1, m01: 0, m02: box.x, m10: 0, m11: 1, m12: box.y };
      ed.engine.setProps([f.guid], { transform: multiply(f.transform ?? IDENTITY, shift), size: { x: box.w, y: box.h } });
      for (const c of childrenOf(ed, f.guid)) {
        const t = c.transform ?? IDENTITY;
        ed.engine.setProps([c.guid], { transform: { ...t, m02: t.m02 - box.x, m12: t.m12 - box.y } });
      }
    }
  });
}

/** The layers a group's resize changes: its descendants that aren't groups themselves. */
function leaves(ed: EditorController, id: Guid, depth = 0): NodeChange[] {
  const out: NodeChange[] = [];
  for (const c of childrenOf(ed, id)) {
    if (isGroup(c) && depth < 64) out.push(...leaves(ed, c.guid, depth + 1));
    else out.push(c);
  }
  return out;
}

/**
 * A group resized to `size` (one axis or both): its contents scale about its top left, as the handles scale them
 * (Editor::dragResize). Written inside the caller's edit (a scrub frame or a typed value).
 */
export function scaleGroupTo(ed: EditorController, group: NodeChange, size: { x: number; y: number }): void {
  const now = group.size ?? { x: 0, y: 0 };
  if (!(now.x > 0) || !(now.y > 0)) return;
  const sx = size.x / now.x;
  const sy = size.y / now.y;
  const g = worldTransform(ed, group as EngineNode);
  // S = G · diag(sx, sy) · G⁻¹: the scale in the group's own axes, in page space.
  const S = multiply(multiply(g, { m00: sx, m01: 0, m02: 0, m10: 0, m11: sy, m12: 0 }), invert(g));
  for (const t of leaves(ed, group.guid)) {
    const world = worldTransform(ed, t as EngineNode);
    const parent = t.parentIndex?.guid ? ed.engine.readNode(t.parentIndex.guid) : null;
    const parentWorld = parent && parent.type !== "CANVAS" ? worldTransform(ed, parent as EngineNode) : IDENTITY;
    const next = multiply(S, world);
    const local = multiply(invert(world), next);
    const s = t.size ?? { x: 0, y: 0 };
    const eps = 1e-6;
    if (Math.abs(local.m01) < eps && Math.abs(local.m10) < eps) {
      const ax = Math.abs(local.m00);
      const ay = Math.abs(local.m11);
      const unscale: Matrix = { m00: ax > 0 ? 1 / ax : 1, m01: 0, m02: 0, m10: 0, m11: ay > 0 ? 1 / ay : 1, m12: 0 };
      ed.engine.setProps([t.guid], { size: { x: s.x * ax, y: s.y * ay }, transform: multiply(multiply(invert(parentWorld), next), unscale) });
    } else {
      // Turned against the group: it keeps its size and follows with its centre.
      const c = { x: world.m00 * (s.x / 2) + world.m01 * (s.y / 2) + world.m02, y: world.m10 * (s.x / 2) + world.m11 * (s.y / 2) + world.m12 };
      const nc = { x: S.m00 * c.x + S.m01 * c.y + S.m02, y: S.m10 * c.x + S.m11 * c.y + S.m12 };
      const moved: Matrix = { ...world, m02: world.m02 + nc.x - c.x, m12: world.m12 + nc.y - c.y };
      ed.engine.setProps([t.guid], { transform: multiply(invert(parentWorld), moved) });
    }
  }
}

/** The items "Spacing" reads: the layers (several selected) or a group's children, with their page bounds. */
export function spacingItems(ed: EditorController, nodes: readonly NodeChange[]): SpacingItem[] {
  const list = nodes.length === 1 && isGroup(nodes[0]) ? childrenOf(ed, nodes[0].guid) : nodes.length > 1 ? [...nodes] : [];
  return list.filter((n) => n.visible !== false).map((n) => ({ id: n.guid, box: boundsOf(worldTransform(ed, n as EngineNode), n.size ?? { x: 0, y: 0 }) }));
}

/** Writes a new gap between the items along `axis` (the first one stays). */
export function writeSpacing(ed: EditorController, nodes: readonly NodeChange[], axis: SpacingAxis, gap: number, info: ChangeInfo): void {
  ed.edit(axis === "x" ? "Horizontal spacing" : "Vertical spacing", info, () => {
    const fresh = ed.engine.readNodes(nodes.map((n) => n.guid));
    const items = spacingItems(ed, fresh);
    for (const [id, d] of respace(items, axis, gap)) {
      const n = ed.engine.readNode(id);
      if (!n) continue;
      const parent = n.parentIndex?.guid ? ed.engine.readNode(n.parentIndex.guid) : null;
      const pw = parent && parent.type !== "CANVAS" ? worldTransform(ed, parent as EngineNode) : IDENTITY;
      // A page-space move, in the parent's space.
      const inv = invert(pw);
      const dx = axis === "x" ? d : 0;
      const dy = axis === "y" ? d : 0;
      const t = n.transform ?? IDENTITY;
      ed.engine.setProps([id], { transform: { ...t, m02: t.m02 + inv.m00 * dx + inv.m01 * dy, m12: t.m12 + inv.m10 * dx + inv.m11 * dy } });
    }
  });
}
