/**
 * Figma's resizing (W / H menus: Fixed, Hug contents, Fill container), min / max
 * and "Ignore auto layout", as plain data on the schema's fields — no engine, no
 * React (docs/research/figma/R7-editor.md; help.figma.com "Guide to auto layout").
 *
 * - Hug on an auto-layout frame: its own `stackPrimarySizing` (the axis of its
 *   flow) or `stackCounterSizing` ≠ FIXED; absent primary sizing = Hug
 *   (docs/schema.md §3.4). On text, `textAutoResize` (WIDTH_AND_HEIGHT = both,
 *   HEIGHT = height only).
 * - Fill in an auto-layout parent: along the parent's flow
 *   `stackChildPrimaryGrow` = 1, across it `stackChildAlignSelf` = STRETCH.
 *   Fill on an axis the parent hugs turns the parent's axis Fixed (Figma).
 * - min / max: `minSize` / `maxSize` `{ value }`, 0 = no limit on that axis.
 */
import type { NodeFields, OptionalVector, StackSize } from "@/engine/codec";

export type Axis = "x" | "y";
export type Sizing = "FIXED" | "HUG" | "FILL";
export type Limit = "min" | "max";

/** The fields sizing reads (a NodeChange, plus text's `textAutoResize` the facade doesn't type yet). */
export interface SizingNode {
  type?: string;
  resizeToFit?: boolean;
  stackMode?: string;
  stackWrap?: string;
  stackPrimarySizing?: StackSize;
  stackCounterSizing?: StackSize;
  stackChildPrimaryGrow?: number;
  stackChildAlignSelf?: string;
  stackPositioning?: string;
  minSize?: OptionalVector;
  maxSize?: OptionalVector;
  size?: { x: number; y: number };
  textAutoResize?: string;
}

export type SizingFields = NodeFields & { textAutoResize?: "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" };

const HUG: StackSize = "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE";

export const isAutoLayout = (n: SizingNode | null | undefined): boolean =>
  !!n && (n.stackMode === "HORIZONTAL" || n.stackMode === "VERTICAL" || n.stackMode === "GRID") && n.resizeToFit !== true;

/** The axis an auto-layout frame lays its children along (a grid: x). */
export const flowAxis = (n: SizingNode): Axis => (n.stackMode === "VERTICAL" ? "y" : "x");

/** Is the layer placed by its auto-layout parent (not "Ignore auto layout")? */
export const inFlow = (n: SizingNode, parent: SizingNode | null | undefined): boolean => isAutoLayout(parent) && n.stackPositioning !== "ABSOLUTE";

export const canHug = (n: SizingNode): boolean => isAutoLayout(n) || n.type === "TEXT";
export const canFill = (n: SizingNode, parent: SizingNode | null | undefined): boolean => inFlow(n, parent);
/** min / max apply to auto-layout frames and to layers in an auto-layout flow. */
export const canLimit = (n: SizingNode, parent: SizingNode | null | undefined): boolean => isAutoLayout(n) || inFlow(n, parent);

/** The node's own hug on `axis` (auto layout or text). */
function hugs(n: SizingNode, axis: Axis): boolean {
  if (isAutoLayout(n)) {
    const own = flowAxis(n) === axis ? (n.stackPrimarySizing ?? HUG) : (n.stackCounterSizing ?? "FIXED");
    return own !== "FIXED";
  }
  if (n.type === "TEXT") return n.textAutoResize === "WIDTH_AND_HEIGHT" || (axis === "y" && n.textAutoResize === "HEIGHT");
  return false;
}

function fills(n: SizingNode, parent: SizingNode | null | undefined, axis: Axis): boolean {
  if (!parent || !inFlow(n, parent)) return false;
  return flowAxis(parent) === axis ? (n.stackChildPrimaryGrow ?? 0) > 0 : n.stackChildAlignSelf === "STRETCH";
}

/** What the W (x) or H (y) field shows: Fill wins over Hug (Figma). */
export function sizingOf(n: SizingNode, parent: SizingNode | null | undefined, axis: Axis): Sizing {
  if (fills(n, parent, axis)) return "FILL";
  return hugs(n, axis) ? "HUG" : "FIXED";
}

/** The writes for choosing `mode` on `axis`: the node's, and its parent's when that changes too. */
export function sizingChanges(n: SizingNode, parent: SizingNode | null | undefined, axis: Axis, mode: Sizing): { node: SizingFields; parent: SizingFields | null } {
  const node: SizingFields = {};
  let parentFields: SizingFields | null = null;
  if (isAutoLayout(n)) node[flowAxis(n) === axis ? "stackPrimarySizing" : "stackCounterSizing"] = mode === "HUG" ? HUG : "FIXED";
  if (n.type === "TEXT") {
    const now = (n.textAutoResize ?? "NONE") as NonNullable<SizingFields["textAutoResize"]>;
    if (mode === "HUG") node.textAutoResize = axis === "x" ? "WIDTH_AND_HEIGHT" : now === "WIDTH_AND_HEIGHT" ? now : "HEIGHT";
    else node.textAutoResize = axis === "x" ? (now === "WIDTH_AND_HEIGHT" ? "HEIGHT" : now) : "NONE";
    if (node.textAutoResize === now) delete node.textAutoResize;
  }
  if (parent && inFlow(n, parent)) {
    const along = flowAxis(parent) === axis;
    if (along) node.stackChildPrimaryGrow = mode === "FILL" ? 1 : 0;
    else node.stackChildAlignSelf = mode === "FILL" ? "STRETCH" : "AUTO";
    if (mode === "FILL" && hugs(parent, axis)) parentFields = { [flowAxis(parent) === axis ? "stackPrimarySizing" : "stackCounterSizing"]: "FIXED" };
  }
  return { node, parent: parentFields };
}

/** The limit on `axis`, or null when there is none (0 = none). */
export function limitOf(n: SizingNode, which: Limit, axis: Axis): number | null {
  const v = (which === "min" ? n.minSize : n.maxSize)?.value?.[axis] ?? 0;
  return v > 0 ? v : null;
}

export const hasLimits = (n: SizingNode, axis: Axis): boolean => limitOf(n, "min", axis) !== null || limitOf(n, "max", axis) !== null;

/**
 * The write setting (or, with null, removing) one limit; the other axis is kept. When the layer's size breaks
 * the new limit, the clamped size goes with it (the engine's layout doesn't run for a limit alone yet).
 */
export function withLimit(n: SizingNode, which: Limit, axis: Axis, value: number | null): NodeFields {
  const field = which === "min" ? "minSize" : "maxSize";
  const now = (which === "min" ? n.minSize : n.maxSize)?.value ?? { x: 0, y: 0 };
  const v = value === null ? 0 : Math.max(0, value);
  const out: NodeFields = { [field]: { value: { x: axis === "x" ? v : now.x ?? 0, y: axis === "y" ? v : now.y ?? 0 } } };
  const size = n.size?.[axis];
  if (size !== undefined && v > 0 && (which === "max" ? size > v : size < v)) out.size = { ...n.size!, [axis]: v };
  return out;
}

/** "Remove min and max" on one axis. */
export const withoutLimits = (n: SizingNode, axis: Axis): NodeFields => ({ ...withLimit(n, "min", axis, null), ...withLimit(n, "max", axis, null) });

/** The value a new limit starts at (Figma: the current size). */
export const newLimit = (n: SizingNode, axis: Axis): number => Math.max(1, Math.round(n.size?.[axis] ?? 1));
