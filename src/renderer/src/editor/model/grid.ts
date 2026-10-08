/**
 * Figma's grid auto layout (docs/research/figma/R9-grid-auto-layout.md) as plain data on the schema's fields — no
 * engine, no React. The engine keeps a grid's fields as they come (schema/document.kiwi, layout/GridLayout.cpp):
 *
 * - the frame: `gridColumns` / `gridRows` (tracks: a GUID and a fractional position each), `gridColumnsSizing` /
 *   `gridRowsSizing` (per track GUID: FIXED px, FLEX fr, HUG), `gridColumnGap` / `gridRowGap`, `gridReflowEnabled`
 *   (automatic positioning);
 * - an item: `gridColumnAnchor` / `gridRowAnchor` (track GUIDs), `gridColumnSpan` / `gridRowSpan`,
 *   `gridChildHorizontalAlign` / `gridChildVerticalAlign`.
 *
 * Edits return whole field values (setProps replaces a field), so a track list is always written with its sizing.
 */
import { compareKeys, keyAfter } from "@shared/schema/fractionalIndex";
import { evaluate } from "@/ds/util/evaluate";

export type GridAxis = "columns" | "rows";
export type TrackType = "FIXED" | "FLEX" | "HUG";

export interface GuidValue {
  sessionID: number;
  localID: number;
}
export interface TrackSizing {
  type: TrackType;
  value: number;
}
export interface Track {
  id: GuidValue;
  position: string;
  sizing: TrackSizing;
}

export interface GridNode {
  stackMode?: string;
  gridColumns?: { entries?: { id?: GuidValue; position?: string }[] };
  gridRows?: { entries?: { id?: GuidValue; position?: string }[] };
  gridColumnsSizing?: { entries?: { id?: GuidValue; trackSize?: { minSizing?: Partial<TrackSizing>; maxSizing?: Partial<TrackSizing> } }[] };
  gridRowsSizing?: { entries?: { id?: GuidValue; trackSize?: { minSizing?: Partial<TrackSizing>; maxSizing?: Partial<TrackSizing> } }[] };
  gridColumnGap?: number;
  gridRowGap?: number;
  gridReflowEnabled?: boolean;
  /** "ROWS": Number of rows is Auto — rows come and go with the items (Figma's default for a new grid) */
  gridAutoTracks?: "NONE" | "ROWS";
  [other: string]: unknown;
}

export interface GridItemNode {
  gridColumnAnchor?: GuidValue;
  gridRowAnchor?: GuidValue;
  gridColumnSpan?: number;
  gridRowSpan?: number;
  stackPositioning?: string;
  visible?: boolean;
  [other: string]: unknown;
}

export const isGrid = (n: { stackMode?: string } | null | undefined): boolean => n?.stackMode === "GRID";

const sameGuid = (a: GuidValue | undefined, b: GuidValue | undefined) => !!a && !!b && a.sessionID === b.sessionID && a.localID === b.localID;
const listKey = (axis: GridAxis) => (axis === "columns" ? "gridColumns" : "gridRows");
const sizingKey = (axis: GridAxis) => (axis === "columns" ? "gridColumnsSizing" : "gridRowsSizing");

/** A grid's tracks along `axis`, in order, each with its sizing (Figma writes the same function as min and max). */
export function tracksOf(n: GridNode, axis: GridAxis): Track[] {
  const list = (n[listKey(axis)] as GridNode["gridColumns"])?.entries ?? [];
  const sizing = (n[sizingKey(axis)] as GridNode["gridColumnsSizing"])?.entries ?? [];
  const out: Track[] = [];
  for (const e of list) {
    if (!e.id) continue;
    const s = sizing.find((x) => sameGuid(x.id, e.id))?.trackSize;
    const f = s?.maxSizing ?? s?.minSizing;
    out.push({ id: e.id, position: e.position ?? "", sizing: { type: (f?.type as TrackType) ?? "HUG", value: typeof f?.value === "number" ? f.value : 1 } });
  }
  return out.sort((a, b) => compareKeys(a.position, b.position));
}

/** The fields that write `tracks` along `axis` (the list and its sizing together). */
export function trackFields(axis: GridAxis, tracks: readonly Track[]): Record<string, unknown> {
  return {
    [listKey(axis)]: { entries: tracks.map((t) => ({ id: t.id, position: t.position })) },
    [sizingKey(axis)]: { entries: tracks.map((t) => ({ id: t.id, trackSize: { minSizing: { ...t.sizing }, maxSizing: { ...t.sizing } } })) },
  };
}

/** Figma's label for a track's size: "1fr", "120", "Hug". */
export function trackLabel(s: TrackSizing): string {
  if (s.type === "FLEX") return `${formatNumber(s.value)}fr`;
  if (s.type === "HUG") return "Hug";
  return formatNumber(s.value);
}

/** Parses what is typed into a track's field: "2fr", "120", "Hug" / "H", "Auto" / "A" (Fill 1fr, Figma). */
export function parseTrackInput(text: string): TrackSizing | null {
  const t = text.trim().toLowerCase();
  if (t === "a" || t === "auto") return { type: "FLEX", value: 1 };
  if (t === "h" || t === "hug") return { type: "HUG", value: 1 };
  const fr = /^(\d*\.?\d+)\s*fr$/.exec(t);
  if (fr) return { type: "FLEX", value: Math.max(0, Number(fr[1])) };
  const px = /^(\d*\.?\d+)(px)?$/.exec(t);
  if (px) return { type: "FIXED", value: Math.max(0, Number(px[1])) };
  return null;
}

const formatNumber = (v: number) => String(Math.round(v * 100) / 100);

/** A GUID for a new track, unique among the grid's tracks (Figma's are per grid: a session and a counter). */
export function newTrackId(n: GridNode, sessionID: number, taken: GuidValue[] = []): GuidValue {
  let max = -1;
  for (const t of [...tracksOf(n, "columns"), ...tracksOf(n, "rows"), ...taken.map((id) => ({ id }))]) if (t.id.sessionID === sessionID) max = Math.max(max, t.id.localID);
  return { sessionID, localID: max + 1 };
}

/**
 * The fields that make a grid have `count` tracks along `axis`: new ones (Figma: Hug in Figma Design, as the tracks a
 * new grid gets) added after the last; tracks taken away from the end. Items anchored past the new end move to the
 * last track (Figma keeps objects, moving them to the nearest cells).
 */
export function setTrackCount(n: GridNode, axis: GridAxis, count: number, sessionID: number, items: readonly { guid: string; node: GridItemNode }[] = []): { frame: Record<string, unknown>; items: { guid: string; fields: Record<string, unknown> }[] } {
  const want = Math.max(1, Math.min(1000, Math.round(count)));
  const tracks = tracksOf(n, axis);
  const out = tracks.slice(0, want);
  const added: GuidValue[] = [];
  while (out.length < want) {
    const id = newTrackId(n, sessionID, added);
    added.push(id);
    out.push({ id, position: keyAfter(out.length ? out[out.length - 1].position : ""), sizing: { type: "HUG", value: 1 } });
  }
  const removed = tracks.slice(want);
  const anchorKey = axis === "columns" ? "gridColumnAnchor" : "gridRowAnchor";
  const last = out[out.length - 1].id;
  const moved = items.filter((it) => removed.some((t) => sameGuid(t.id, it.node[anchorKey] as GuidValue | undefined))).map((it) => ({ guid: it.guid, fields: { [anchorKey]: last } }));
  return { frame: trackFields(axis, out), items: moved };
}

/** A track's new sizing (FLEX on an axis whose frame hugs is Figma's "invalid": the caller turns the frame Fixed). */
export function setTrackSizing(n: GridNode, axis: GridAxis, index: number | readonly number[], sizing: TrackSizing): Record<string, unknown> {
  const indices = typeof index === "number" ? [index] : index;
  const tracks = tracksOf(n, axis).map((t, i) => (indices.includes(i) ? { ...t, sizing: { ...sizing } } : t));
  return trackFields(axis, tracks);
}

/** Number of rows is Auto (`gridAutoTracks: ROWS`): rows come and go with the items. */
export const isAutoRows = (n: GridNode): boolean => n.gridAutoTracks === "ROWS";

/** What the Number of rows field shows: "Auto", else the count. */
export const rowCountLabel = (n: GridNode): string => (isAutoRows(n) ? "Auto" : String(tracksOf(n, "rows").length));

/**
 * What typing into Number of rows means: "Auto" / "A" → Auto rows; a number (math allowed: + - * /) → that many
 * rows, Auto off. Null: not understood.
 */
export function parseRowCount(text: string): { auto: true } | { auto: false; count: number } | null {
  const t = text.trim().toLowerCase();
  if (t === "a" || t === "auto") return { auto: true };
  const v = evaluate(t);
  if (!Number.isFinite(v)) return null;
  return { auto: false, count: Math.max(1, Math.min(1000, Math.round(v))) };
}

/** Labels of the tracks along `axis` as the canvas pills show them, joined when several differ ("Mixed"). */
export function tracksLabel(n: GridNode, axis: GridAxis, indices: readonly number[]): string {
  const tracks = tracksOf(n, axis);
  const labels = [...new Set(indices.filter((i) => i >= 0 && i < tracks.length).map((i) => trackLabel(tracks[i].sizing)))];
  return labels.length === 1 ? labels[0] : labels.length ? "Mixed" : "";
}

/** Moves the tracks at `from` (indices) to before index `to` (Figma's reorderColumns / reorderRows). */
export function reorderTracks(n: GridNode, axis: GridAxis, from: readonly number[], to: number): Record<string, unknown> {
  const tracks = tracksOf(n, axis);
  const moving = from.filter((i) => i >= 0 && i < tracks.length).sort((a, b) => a - b);
  const rest = tracks.filter((_, i) => !moving.includes(i));
  const at = Math.max(0, Math.min(rest.length, to - moving.filter((i) => i < to).length));
  const order = [...rest.slice(0, at), ...moving.map((i) => tracks[i]), ...rest.slice(at)];
  // Positions follow the new order (rebalanced: the list is written whole).
  let key = "";
  const positioned = order.map((t) => ((key = keyAfter(key)), { ...t, position: key }));
  return trackFields(axis, positioned);
}

/** The defaults a frame gets when its flow becomes Grid: 2 × 2 Hug tracks (Figma Design), automatic positioning. */
export function gridDefaults(n: GridNode, sessionID: number, columns = 2, rows = 2): Record<string, unknown> {
  // A frame that was a grid before keeps its tracks.
  const cols = tracksOf(n, "columns").length ? {} : setTrackCount(n, "columns", columns, sessionID).frame;
  const rowsFields = tracksOf(n, "rows").length ? {} : setTrackCount({ ...n, ...cols } as GridNode, "rows", rows, sessionID).frame;
  // Number of rows starts as Auto (help: "By default, Number of rows is set to auto").
  return { stackMode: "GRID", gridReflowEnabled: true, gridAutoTracks: n.gridAutoTracks ?? "ROWS", gridColumnGap: n.gridColumnGap ?? 10, gridRowGap: n.gridRowGap ?? 10, ...cols, ...rowsFields };
}

/** An item's span along `axis` (≥ 1). */
export const spanOf = (n: GridItemNode, axis: GridAxis): number => Math.max(1, Math.round((axis === "columns" ? n.gridColumnSpan : n.gridRowSpan) ?? 1));
