/**
 * Fill / Stroke / Effect rows selected in the Design panel and copied or pasted as Figma does (live 2026-10-19,
 * docs/research/figma/live/2026-10-18/property-rows-copy.txt), as pure functions:
 *
 * - The selection: rows of ONE section, by their item's index in the layer's list (0 is the bottom paint, the panel's
 *   last row) and the anchor ⇧-click ranges from, by its place in the panel (display index), which carries over to
 *   another section as Figma's does.
 * - ⌘C writes Figma's clipboard Message: NODE_CHANGES with `pasteAssetType` STYLE_PROPERTIES_FILL / _STROKE / _EFFECT
 *   (Message field 41), `clipboardSelectionRegions` naming the source layers, and one temporary 100 × 100
 *   ROUNDED_RECTANGLE carrying only the copied items (`fillPaints`, `strokePaints` or `effects`, in the source's
 *   order) on page 0:1, beside the hidden Internal Only Canvas — so a copy here pastes in Figma and Figma's here.
 * - ⌘V adds the items on top of the list, or directly above the selected row of that section.
 */
import type { Effect, Guid, NodeChange, Paint } from "@/engine/codec";
import type { Message as KiwiMessage, PasteAssetType } from "../../../../shared/schema/codec";
import { DOCUMENT_GUID, FIRST_PAGE_GUID, guidKey, INTERNAL_CANVAS_GUID, parseGuid } from "../../../../shared/schema/guid";
import { nodeToEngine, nodeToKiwi } from "../../store/engineMessage";
import { IDENTITY } from "./geometry";
import { sameData } from "./mixed";

export type RowSection = "fill" | "stroke" | "effect";
export type RowField = "fillPaints" | "strokePaints" | "effects";
export type RowItem = Paint | Effect;

/** The rows selected in the Design panel (UI state, `ui.propertyRows`). */
export interface PropertyRows {
  section: RowSection;
  /** The selected items' indices in the layers' list (0: the bottom one), ascending */
  rows: number[];
  /** ⇧-click's anchor: its row's place in the panel, top first */
  anchor: number;
}

export const ROW_FIELD: Record<RowSection, RowField> = { fill: "fillPaints", stroke: "strokePaints", effect: "effects" };
export const ASSET_TYPE: Record<RowSection, PasteAssetType> = { fill: "STYLE_PROPERTIES_FILL", stroke: "STYLE_PROPERTIES_STROKE", effect: "STYLE_PROPERTIES_EFFECT" };
const SECTION_OF: Partial<Record<PasteAssetType, RowSection>> = { STYLE_PROPERTIES_FILL: "fill", STYLE_PROPERTIES_STROKE: "stroke", STYLE_PROPERTIES_EFFECT: "effect" };

/**
 * A click on a row's empty part (`display`: its place in the panel, `count`: the section's rows): the row alone, or
 * with ⇧ the range from the anchor — whose place carries over from another section (live: a fill row selected, ⇧ on
 * an effect row selected Effects 0 … that row).
 */
export function clickRow(current: PropertyRows | null | undefined, section: RowSection, display: number, count: number, shift: boolean): PropertyRows {
  const item = (d: number) => count - 1 - d;
  if (!shift || !current) return { section, rows: [item(display)], anchor: display };
  const anchor = Math.min(Math.max(current.anchor, 0), count - 1);
  const [from, to] = anchor < display ? [anchor, display] : [display, anchor];
  const rows: number[] = [];
  for (let d = from; d <= to; d++) rows.push(item(d));
  return { section, rows: rows.sort((a, b) => a - b), anchor: current.anchor };
}

/** The list without the selected items (Delete / Backspace on rows). */
export function withoutRows<T>(list: readonly T[], rows: readonly number[]): T[] {
  const gone = new Set(rows);
  return list.filter((_, i) => !gone.has(i));
}

/**
 * The list with `items` added (in their order) on top — or, with `above`, directly above that item — and the indices
 * the added items take.
 */
export function insertRows<T>(list: readonly T[], items: readonly T[], above?: number): { list: T[]; rows: number[] } {
  const at = above === undefined ? list.length : Math.min(Math.max(above + 1, 0), list.length);
  return { list: [...list.slice(0, at), ...items, ...list.slice(at)], rows: items.map((_, i) => at + i) };
}

/** Whether the layers' lists are all equal (the panel shows them; else it reads Mixed and nothing is pasted). */
export function sameLists(lists: readonly (readonly unknown[])[]): boolean {
  return lists.every((l) => sameData(l, lists[0]));
}

/** The temporary rectangle's GUID in a rows clipboard (Figma's is a fresh one; any GUID off the reserved 0:0–0:4). */
const TEMPORARY_GUID = { sessionID: 1, localID: 1 };

/**
 * ⌘C on rows: Figma's clipboard Message (kiwi form). `items` in the source's order; `layers`: the selected layers
 * (`clipboardSelectionRegions`), `page` their page.
 */
export function rowsMessage(section: RowSection, items: readonly RowItem[], o: { layers: readonly Guid[]; page: Guid | null; fileKey?: string | null; pasteID?: number }): KiwiMessage {
  const field = ROW_FIELD[section];
  const rectangle = nodeToKiwi({
    guid: guidKey(TEMPORARY_GUID),
    phase: "CREATED",
    parentIndex: { guid: guidKey(FIRST_PAGE_GUID), position: "!" },
    type: "ROUNDED_RECTANGLE",
    name: "Rectangle",
    visible: true,
    opacity: 1,
    size: { x: 100, y: 100 },
    transform: IDENTITY,
    strokeJoin: "BEVEL",
    [field]: items,
  } as unknown as NodeChange);
  return {
    type: "NODE_CHANGES",
    sessionID: 0,
    pasteID: o.pasteID ?? Math.floor(Math.random() * 0x7fffffff),
    ...(o.fileKey ? { pasteFileKey: o.fileKey } : {}),
    ...(o.page ? { pastePageId: parseGuid(o.page) } : {}),
    isCut: false,
    pasteEditorType: "DESIGN",
    clipboardSelectionRegions: o.page ? [{ parent: parseGuid(o.page), nodes: o.layers.map(parseGuid), focusType: "NONE" }] : [],
    pasteAssetType: ASSET_TYPE[section],
    nodeChanges: [
      { guid: DOCUMENT_GUID, phase: "CREATED", type: "DOCUMENT", name: "Document", visible: true, opacity: 1, transform: IDENTITY },
      { guid: FIRST_PAGE_GUID, phase: "CREATED", parentIndex: { guid: DOCUMENT_GUID, position: "!" }, type: "CANVAS", name: "Page 1", visible: true, opacity: 1, transform: IDENTITY },
      rectangle,
      { guid: INTERNAL_CANVAS_GUID, phase: "CREATED", parentIndex: { guid: DOCUMENT_GUID, position: "\"" }, type: "CANVAS", name: "Internal Only Canvas", visible: false, opacity: 1, transform: IDENTITY, internalOnly: true },
    ],
  };
}

/**
 * A clipboard Message's copied rows: its section (by `pasteAssetType`) and the items its one non-page layer carries
 * (the engine's form); null for any other Message — layers, Copy properties, variables.
 */
export function rowsOfMessage(message: KiwiMessage): { section: RowSection; items: RowItem[] } | null {
  const section = message.pasteAssetType ? SECTION_OF[message.pasteAssetType] : undefined;
  if (!section) return null;
  const holder = (message.nodeChanges ?? []).find((n) => n.type !== "DOCUMENT" && n.type !== "CANVAS" && n.phase !== "REMOVED");
  if (!holder) return { section, items: [] };
  const node = nodeToEngine(holder) as unknown as Record<string, unknown>;
  return { section, items: ((node[ROW_FIELD[section]] as RowItem[] | undefined) ?? []).map((x) => ({ ...x })) };
}

/** Whether a clipboard Message (kiwi form) is copied rows — ⌘V adds them to the selection's list instead of pasting layers. */
export const isRowsMessage = (message: KiwiMessage): boolean => !!message.pasteAssetType && !!SECTION_OF[message.pasteAssetType];
