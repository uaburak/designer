/**
 * The opened file → what the engine loads (docs/data-impl.md "Opening a file"): the snapshot with its journal
 * applied, converted straight from the node table into the engine's wire form (one conversion, not kiwi → Message →
 * engine), plus what the editor wants to know before the engine has the document — the fonts it uses (requested
 * ahead of `engine_load`, so they arrive during it instead of causing a relayout after the first paint) and the
 * node types the engine may read as NONE. Pure: runs the same in the load worker and inline.
 */
import type { Message as EngineMessage, NodeChange as EngineNodeChange } from "@/engine/codec";
import { decodeMessage } from "../../../shared/schema/codec";
import type { Message, NodeChange } from "../../../shared/schema/codec";
import { NodeTable } from "../../../shared/schema/patch";
import { bytesToBase64, nodeToEngine } from "./engineMessage";

/** A FontName the document uses (family + style, as the engine asks for it). */
export interface FontRef {
  family: string;
  style: string;
}

/** A node whose type the engine may not know (EditorController.noteSourceTypes), in the engine's shape. */
export type SourceType = Pick<EngineNodeChange, "guid" | "type"> & { booleanOperation?: string };

export interface PreparedDocument {
  /** The engine's wire bytes (`engine_load` takes them as they are) */
  bytes: Uint8Array;
  nodeCount: number;
  /** For `noteSourceTypes` (nodes with a type outside the engine's first set, or a boolean operation) */
  types: SourceType[];
  fonts: FontRef[];
  /**
   * Some text holds characters Latin fonts rarely cover (CJK, Arabic, Hebrew, Thai, Devanagari, emoji): the engine
   * will ask for its first fallback family after the load; asking for it before saves a relayout.
   */
  needsFallbackFont: boolean;
  /** Milliseconds spent: kiwi decode + table, the engine form, its bytes */
  timing: { table: number; convert: number; encode: number };
}

export interface OpenedDocument {
  snapshot: Uint8Array;
  journal: readonly { message: Uint8Array }[];
  sessionID: number;
}

/** Node types the engine read as themselves from E0 on (controller.ts ENGINE_TYPES); the rest are noted from the source. */
const ENGINE_TYPES = new Set(["DOCUMENT", "CANVAS", "GROUP", "FRAME", "ELLIPSE", "RECTANGLE", "ROUNDED_RECTANGLE", "SYMBOL", "INSTANCE", "SECTION"]);

/** The snapshot and its journal as one node table. */
export function tableOf(opened: OpenedDocument): NodeTable {
  const table = NodeTable.fromMessage(decodeMessage(opened.snapshot));
  for (const frame of opened.journal) table.apply(decodeMessage(frame.message));
  return table;
}

/** The table as the engine's snapshot Message: DOCUMENT first, parents before children, every node CREATED. */
export function engineDocumentFromTable(table: NodeTable, sessionID = 0): EngineMessage {
  const dense = table.denseBlobs();
  const nodeChanges: EngineNodeChange[] = [];
  for (const n of table.snapshotNodes({}, dense)) {
    const converted = nodeToEngine(n);
    converted.phase = "CREATED";
    nodeChanges.push(converted);
  }
  const out: EngineMessage = { type: "NODE_CHANGES", sessionID, nodeChanges };
  if (dense.blobs.length) out.blobs = dense.blobs.map((b) => bytesToBase64(b.bytes ?? new Uint8Array(0)));
  return out;
}

/** Scripts a Latin text font rarely covers: the engine then asks for a fallback family (fonts.ts FALLBACK_FAMILIES). */
// (Code-point ranges, not characters: the lint's "combined character" check reads the escapes as one.)
// eslint-disable-next-line no-misleading-character-class
const FALLBACK_SCRIPTS = /[\u0590-\u06ff\u0900-\u097f\u0e00-\u0e7f\u2600-\u27bf\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]|\p{Extended_Pictographic}/u;

/** Does any text of the table hold characters that will need a fallback font? */
export function needsFallbackFont(table: NodeTable): boolean {
  for (const n of table.nodes.values()) {
    const text = (n as { textData?: { characters?: unknown } }).textData?.characters;
    if (typeof text === "string" && FALLBACK_SCRIPTS.test(text)) return true;
  }
  return false;
}

/** The distinct fonts the document's text uses (text nodes, their style runs, text styles), in first-seen order. */
export function fontsOf(table: NodeTable): FontRef[] {
  const seen = new Map<string, FontRef>();
  const add = (f: unknown) => {
    const font = f as { family?: unknown; style?: unknown } | undefined;
    if (!font || typeof font.family !== "string" || !font.family) return;
    const style = typeof font.style === "string" && font.style ? font.style : "Regular";
    const key = `${font.family}\n${style}`;
    if (!seen.has(key)) seen.set(key, { family: font.family, style });
  };
  for (const n of table.nodes.values()) {
    const node = n as NodeChange & { fontName?: unknown; textData?: { styleOverrideTable?: { fontName?: unknown }[] } };
    if (node.fontName) add(node.fontName);
    const runs = node.textData?.styleOverrideTable; // mixed text: one entry per styled run (TextData.styleOverrideTable)
    if (Array.isArray(runs)) for (const run of runs) if (run?.fontName) add(run.fontName);
  }
  return [...seen.values()];
}

/** The nodes `noteSourceTypes` records: a type outside the engine's first set, or a boolean operation. */
export function sourceTypesOf(message: EngineMessage): SourceType[] {
  const out: SourceType[] = [];
  for (const c of message.nodeChanges) {
    const op = (c as { booleanOperation?: string }).booleanOperation;
    if ((c.type && !ENGINE_TYPES.has(c.type)) || op !== undefined) out.push({ guid: c.guid, type: c.type, ...(op !== undefined ? { booleanOperation: op } : {}) });
  }
  return out;
}

const encoder = new TextEncoder();

/**
 * Everything the editor loads from an opened file. `onTable` hears the table as soon as it is built (before the
 * conversion), so a caller can start on the fonts while the engine form is produced.
 */
export function prepareEngineDocument(opened: OpenedDocument, onTable?: (fonts: FontRef[], needsFallbackFont: boolean) => void): PreparedDocument {
  const t0 = performance.now();
  const table = tableOf(opened);
  const fonts = fontsOf(table);
  const fallback = needsFallbackFont(table);
  const t1 = performance.now();
  onTable?.(fonts, fallback);
  const message = engineDocumentFromTable(table, 0);
  const t2 = performance.now();
  const bytes = encoder.encode(JSON.stringify(message));
  const t3 = performance.now();
  return { bytes, nodeCount: message.nodeChanges.length, types: sourceTypesOf(message), fonts, needsFallbackFont: fallback, timing: { table: t1 - t0, convert: t2 - t1, encode: t3 - t2 } };
}

/** A kiwi Message (a version, a restore diff) → the engine's form, through the table (one conversion). */
export function engineDocumentOf(message: Message, sessionID = 0): EngineMessage {
  return engineDocumentFromTable(NodeTable.fromMessage(message), sessionID);
}
