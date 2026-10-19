/**
 * A page's saved measurements in the Plugin API (PageNode.getMeasurements / getMeasurementsForNode / addMeasurement /
 * editMeasurement / deleteMeasurement; docs/research/atlas/17-plugins.md §9.2), over Dev Mode's own commands
 * (MEASUREMENT_ADD / _UPDATE / _DELETE, docs/research/atlas/14-dev-mode.md) — each one undo step of the run, allowed
 * in Dev Mode as the Measure tool is. Figma's shape: `{id, start: {node, side}, end: {node, side}, offset, freeText}`,
 * the offset `{type: "INNER", relative}` or `{type: "OUTER", fixed}`.
 */
import type { DevInfo, Guid } from "@/engine/codec";
import { Status } from "@/engine/abi";
import { ApiError } from "./codec";
import { mustNode, refOf, type ApiContext } from "./context";

type Obj = Record<string, unknown>;
type Side = "TOP" | "BOTTOM" | "LEFT" | "RIGHT";
type Saved = DevInfo["measurements"][number];

const SIDES: readonly Side[] = ["TOP", "BOTTOM", "LEFT", "RIGHT"];
const OPPOSITE: Record<Side, Side> = { TOP: "BOTTOM", BOTTOM: "TOP", LEFT: "RIGHT", RIGHT: "LEFT" };

function page(ctx: ApiContext, id: Guid): Guid {
  const n = mustNode(ctx, id);
  if (n.type !== "CANVAS") throw new ApiError("Measurements are on pages");
  return n.guid;
}

/** The saved one as Figma's Measurement: an end on the same side, or the side across. */
function toApi(ctx: ApiContext, m: Saved): Obj {
  const offset = m.outer ? { type: "OUTER", fixed: m.outer } : { type: "INNER", relative: m.inner };
  return { id: m.id, start: { node: refOf(ctx, m.from), side: m.side }, end: { node: refOf(ctx, m.to), side: m.toSameSide ? m.side : OPPOSITE[m.side] }, offset, freeText: m.freeText };
}

function saved(ctx: ApiContext, pageId: Guid): Saved[] {
  return ctx.ed.engine.devInfo(pageId).measurements;
}

function end(v: unknown, what: string): { node: Guid; side: Side } {
  const o = (v ?? {}) as { node?: unknown; side?: unknown };
  const node = typeof o.node === "string" ? o.node : (o.node as { id?: string } | undefined)?.id;
  if (typeof node !== "string" || !node) throw new ApiError(`in addMeasurement: Expected ${what}.node to be a node`);
  if (!SIDES.includes(o.side as Side)) throw new ApiError(`in addMeasurement: Expected ${what}.side to be "TOP", "BOTTOM", "LEFT" or "RIGHT"`);
  return { node, side: o.side as Side };
}

/** `{offset, freeText}` → the command's `inner` / `outer` / `freeText`. */
function options(v: Obj, what: string): Obj {
  const out: Obj = {};
  const offset = v.offset as { type?: string; relative?: unknown; fixed?: unknown } | undefined;
  if (offset !== undefined) {
    if (offset?.type === "INNER" && typeof offset.relative === "number") Object.assign(out, { inner: offset.relative, outer: 0 });
    else if (offset?.type === "OUTER" && typeof offset.fixed === "number") Object.assign(out, { outer: offset.fixed, inner: 0 });
    else throw new ApiError(`in ${what}: Expected offset to be {type: "INNER", relative} or {type: "OUTER", fixed}`);
  }
  if (v.freeText !== undefined) out.freeText = String(v.freeText);
  return out;
}

export function list(ctx: ApiContext, pageId: Guid, node: Guid | null): Obj[] {
  const all = saved(ctx, page(ctx, pageId));
  return (node ? all.filter((m) => m.from === node || m.to === node) : all).map((m) => toApi(ctx, m));
}

export function add(ctx: ApiContext, pageId: Guid, start: unknown, finish: unknown, opts: Obj): Obj {
  const p = page(ctx, pageId);
  const a = end(start, "start");
  const b = end(finish, "end");
  if (a.node === b.node && a.side === b.side) throw new ApiError("in addMeasurement: Measurement can't point to itself");
  if (b.side !== a.side && b.side !== OPPOSITE[a.side]) throw new ApiError(`in addMeasurement: Measurement start side ${a.side} and end side ${b.side} must be on the same axis`);
  mustNode(ctx, a.node);
  mustNode(ctx, b.node);
  ctx.write();
  const r = ctx.ed.engine.runCommand("MEASUREMENT_ADD", { from: a.node, to: b.node, side: a.side, toSameSide: a.side === b.side, page: p, ...options(opts, "addMeasurement") } as never);
  const id = r.created[0];
  const made = id ? saved(ctx, p).find((m) => m.id === id) : undefined;
  if (r.status !== Status.OK || !made) throw new ApiError(`in addMeasurement: the measurement was refused (status ${r.status})`);
  return toApi(ctx, made);
}

export function edit(ctx: ApiContext, pageId: Guid, id: string, value: Obj): Obj {
  const p = page(ctx, pageId);
  if (!saved(ctx, p).some((m) => m.id === id)) throw new ApiError(`in editMeasurement: No measurement with id ${id}`);
  ctx.write();
  const status = ctx.ed.engine.command("MEASUREMENT_UPDATE", { id, page: p, ...options(value, "editMeasurement") } as never);
  if (status !== Status.OK) throw new ApiError(`in editMeasurement: the change was refused (status ${status})`);
  return toApi(ctx, saved(ctx, p).find((m) => m.id === id)!);
}

export function remove(ctx: ApiContext, pageId: Guid, id: string): void {
  const p = page(ctx, pageId);
  if (!saved(ctx, p).some((m) => m.id === id)) throw new ApiError(`in deleteMeasurement: No measurement with id ${id}`);
  ctx.write();
  ctx.ed.engine.command("MEASUREMENT_DELETE", { id, page: p });
}
