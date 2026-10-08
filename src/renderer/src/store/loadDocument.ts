/**
 * The opened file → what the engine loads (docs/data-impl.md "Opening a file"), and what the editor wants to know
 * before the engine has the document: the fonts it uses — the shown page's first (requested ahead of `engine_load`,
 * so they arrive during it instead of causing a relayout after the first paint), the rest later —, the node types the
 * engine may read as NONE, and whether the snapshot carries the engine's derived data.
 *
 * Two wire forms (docs/engine-build.md "Figma parity round 3"): an engine that reads kiwi takes the store's own
 * snapshot bytes as they are, followed by the journal's frames (`applyChanges(frame, "load")`, docs/desktop.md §3.1)
 * — no conversion at all; with a long journal the frames are folded into the snapshot here first (the kiwi codec, a
 * table, derived fields kept). An engine without kiwi gets the table converted straight into its JSON form, as
 * before. Pure: runs the same in the load worker and inline.
 */
import type { Message as EngineMessage, NodeChange as EngineNodeChange } from "@/engine/codec";
import { decodeMessage, encodeMessage } from "../../../shared/schema/codec";
import type { Message, NodeChange } from "../../../shared/schema/codec";
import { guidKey } from "../../../shared/schema/guid";
import { NodeTable } from "../../../shared/schema/patch";
import { bytesToBase64, nodeToEngine } from "./engineMessage";

/** A FontName the document uses (family + style, as the engine asks for it). */
export interface FontRef {
  family: string;
  style: string;
}

/** A node whose type the engine may not know (EditorController.noteSourceTypes), in the engine's shape. */
export type SourceType = Pick<EngineNodeChange, "guid" | "type"> & { booleanOperation?: string };

/** The engine's wire form: its interim JSON (docs/engine-build.md "The wire encoding"), or the schema's kiwi. */
export type EngineWireFormat = "json" | "kiwi";

/**
 * A journal longer than this is folded into the snapshot before the load instead of replayed frame by frame
 * (`applyChanges(…, "load")` runs the engine's stages once per frame; the store compacts far before this on close).
 */
export const MAX_REPLAY_FRAMES = 1024;
export const MAX_REPLAY_BYTES = 8 * 1024 * 1024;

/** What is known of the file as soon as it is decoded (before any conversion). */
export interface DocumentFacts {
  nodeCount: number;
  /** For `noteSourceTypes` (nodes with a type outside the engine's first set, or a boolean operation) */
  types: SourceType[];
  /** Every font the document uses, the first page's first (in first-seen order within a page) */
  fonts: FontRef[];
  /** The fonts by page (page GUID "s:l" → fonts), so the shown page's can be requested first */
  fontsByPage: Record<string, FontRef[]>;
  /**
   * Some text holds characters Latin fonts rarely cover (CJK, Arabic, Hebrew, Thai, Devanagari, emoji): the engine
   * will ask for its first fallback family after the load; asking for it before saves a relayout.
   */
  needsFallbackFont: boolean;
  /** `Message.derivedDataVersion` of the snapshot (0: it carries no derived data) */
  derivedDataVersion: number;
}

export interface PreparedDocument extends DocumentFacts {
  /**
   * The bytes `engine_load` takes, in `format`; null with `format: "kiwi"` when the snapshot and its frames go to the
   * engine as they are (the journal was short enough to replay).
   */
  bytes: Uint8Array | null;
  format: EngineWireFormat;
  /** Milliseconds spent: kiwi decode + table, the engine form, its bytes */
  timing: { table: number; convert: number; encode: number };
}

export interface OpenedDocument {
  snapshot: Uint8Array;
  journal: readonly { message: Uint8Array }[];
  sessionID: number;
  /** `Message.derivedDataVersion` of the snapshot as the store recorded it (0 / absent: none or unknown) */
  derivedDataVersion?: number;
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
const FALLBACK_SCRIPTS = /[֐-ۿऀ-ॿ฀-๿☀-➿⺀-鿿가-힯豈-﫿＀-￯]|\p{Extended_Pictographic}/u;

/** Does any text of the table hold characters that will need a fallback font? */
export function needsFallbackFont(table: NodeTable): boolean {
  for (const n of table.nodes.values()) {
    const text = (n as { textData?: { characters?: unknown } }).textData?.characters;
    if (typeof text === "string" && FALLBACK_SCRIPTS.test(text)) return true;
  }
  return false;
}

type FontsSeen = Map<string, FontRef>;

function addFont(seen: FontsSeen, f: unknown): void {
  const font = f as { family?: unknown; style?: unknown } | undefined;
  if (!font || typeof font.family !== "string" || !font.family) return;
  const style = typeof font.style === "string" && font.style ? font.style : "Regular";
  const key = `${font.family}\n${style}`;
  if (!seen.has(key)) seen.set(key, { family: font.family, style });
}

type FontBearing = NodeChange & { fontName?: unknown; textData?: { styleOverrideTable?: { fontName?: unknown }[] }; symbolData?: { symbolID?: unknown; symbolOverrides?: FontBearing[] } };

/** The fonts a node names itself: its `fontName`, its text's style runs, and — on an instance — its overrides' (overridden text keeps its own font). */
function addFonts(seen: FontsSeen, n: NodeChange): void {
  const node = n as FontBearing;
  if (node.fontName) addFont(seen, node.fontName);
  const runs = node.textData?.styleOverrideTable; // mixed text: one entry per styled run (TextData.styleOverrideTable)
  if (Array.isArray(runs)) for (const run of runs) if (run?.fontName) addFont(seen, run.fontName);
  const overrides = node.symbolData?.symbolOverrides;
  if (Array.isArray(overrides)) for (const o of overrides) if (o && typeof o === "object") addFonts(seen, o as NodeChange);
}

/** The distinct fonts the document's text uses (text nodes, their style runs, instance overrides), in first-seen order. */
export function fontsOf(table: NodeTable): FontRef[] {
  const seen: FontsSeen = new Map();
  for (const n of table.nodes.values()) addFonts(seen, n);
  return [...seen.values()];
}

/**
 * The fonts by page (page GUID → fonts, pages in document order, the internal canvas's under its own GUID): the
 * editor requests the shown page's before the load and the others later (Figma fetches fonts as pages are shown).
 * A page's fonts include its read dependencies' (Figma's dynamic page loading: "the components of the page's
 * instances"): the fonts under the mains its instances reference, nested instances followed, so the shown page's
 * instance sublayers shape with their fonts in hand too.
 */
export function fontsByPageOf(table: NodeTable): Record<string, FontRef[]> {
  const pageOf = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  for (const [key, n] of table.nodes) {
    const p = n.parentIndex?.guid ? guidKey(n.parentIndex.guid) : null;
    if (p && p !== key) {
      let list = children.get(p);
      if (!list) children.set(p, (list = []));
      list.push(key);
    }
  }
  const resolve = (key: string): string | null => {
    const known = pageOf.get(key);
    if (known !== undefined) return known;
    pageOf.set(key, null); // a cycle guard
    const n = table.nodes.get(key);
    let page: string | null = null;
    if (n) {
      if (n.type === "CANVAS") page = key;
      else if (n.parentIndex?.guid) {
        const pk = guidKey(n.parentIndex.guid);
        page = pk === key ? null : resolve(pk);
      }
    }
    pageOf.set(key, page);
    return page;
  };
  // The fonts under a main (its subtree, nested instances' mains followed), memoized per main.
  const mainFonts = new Map<string, FontRef[]>();
  const visiting = new Set<string>();
  const fontsUnder = (root: string): FontRef[] => {
    const known = mainFonts.get(root);
    if (known) return known;
    if (visiting.has(root)) return [];
    visiting.add(root);
    const seen: FontsSeen = new Map();
    const stack = [root];
    while (stack.length) {
      const key = stack.pop()!;
      const n = table.nodes.get(key);
      if (!n) continue;
      addFonts(seen, n);
      const main = mainOf(n);
      if (main && main !== root) for (const f of fontsUnder(main)) seen.set(`${f.family}\n${f.style}`, f);
      const kids = children.get(key);
      if (kids) for (const k of kids) stack.push(k);
    }
    visiting.delete(root);
    const out = [...seen.values()];
    mainFonts.set(root, out);
    return out;
  };
  const mainOf = (n: NodeChange): string | null => {
    if (n.type !== "INSTANCE") return null;
    const id = (n as FontBearing).symbolData?.symbolID as { sessionID: number; localID: number } | undefined;
    if (!id || typeof id.sessionID !== "number") return null;
    const key = guidKey(id);
    return table.nodes.has(key) ? key : null;
  };
  const byPage = new Map<string, FontsSeen>();
  for (const [key, n] of table.nodes) {
    const node = n as FontBearing;
    const main = mainOf(n);
    if (!node.fontName && !node.textData && !main && !node.symbolData?.symbolOverrides) continue;
    const page = resolve(key);
    if (!page) continue;
    let seen = byPage.get(page);
    if (!seen) byPage.set(page, (seen = new Map()));
    addFonts(seen, n);
    if (main) for (const f of fontsUnder(main)) seen.set(`${f.family}\n${f.style}`, f);
  }
  const out: Record<string, FontRef[]> = {};
  for (const [page, seen] of byPage) if (seen.size) out[page] = [...seen.values()];
  return out;
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

/** The same from the table (no engine form needed). */
export function sourceTypesOfTable(table: NodeTable): SourceType[] {
  const out: SourceType[] = [];
  for (const [key, n] of table.nodes) {
    const op = (n as { booleanOperation?: string }).booleanOperation;
    if ((n.type && !ENGINE_TYPES.has(n.type)) || op !== undefined) out.push({ guid: key, type: n.type as EngineNodeChange["type"], ...(op !== undefined ? { booleanOperation: op } : {}) });
  }
  return out;
}

/** Everything known from the decoded document. */
export function documentFacts(table: NodeTable): DocumentFacts {
  const fontsByPage = fontsByPageOf(table);
  return { nodeCount: table.size, types: sourceTypesOfTable(table), fonts: fontsOf(table), fontsByPage, needsFallbackFont: needsFallbackFont(table), derivedDataVersion: table.derivedDataVersion };
}

/** Can the snapshot and its frames go to a kiwi-reading engine as they are (the journal short enough to replay)? */
export function canReplayJournal(journal: readonly { message: Uint8Array }[]): boolean {
  if (journal.length > MAX_REPLAY_FRAMES) return false;
  let bytes = 0;
  for (const f of journal) bytes += f.message.length;
  return bytes <= MAX_REPLAY_BYTES;
}

const encoder = new TextEncoder();

/**
 * Everything the editor loads from an opened file. `onTable` hears what is known as soon as the table is built
 * (before any conversion), so a caller can start on the fonts while the engine form is produced. With `format:
 * "kiwi"` and a short journal there is nothing to convert: `bytes` is null and the caller hands the store's snapshot
 * and frames to the engine as they are.
 */
export function prepareEngineDocument(opened: OpenedDocument, onTable?: (facts: DocumentFacts) => void, format: EngineWireFormat = "json"): PreparedDocument {
  const t0 = performance.now();
  const table = tableOf(opened);
  const facts = documentFacts(table);
  const t1 = performance.now();
  onTable?.(facts);
  if (format === "kiwi") {
    if (canReplayJournal(opened.journal)) return { ...facts, bytes: null, format, timing: { table: t1 - t0, convert: 0, encode: 0 } };
    // A long journal: folded into one kiwi snapshot, the derived fields of untouched nodes kept.
    const bytes = encodeMessage(table.toMessage({ keepDerived: true }));
    const t2 = performance.now();
    return { ...facts, bytes, format, timing: { table: t1 - t0, convert: 0, encode: t2 - t1 } };
  }
  const message = engineDocumentFromTable(table, 0);
  const t2 = performance.now();
  const bytes = encoder.encode(JSON.stringify(message));
  const t3 = performance.now();
  return { ...facts, bytes, format, timing: { table: t1 - t0, convert: t2 - t1, encode: t3 - t2 } };
}

/** A kiwi Message (a version, a restore diff) → the engine's form, through the table (one conversion). */
export function engineDocumentOf(message: Message, sessionID = 0): EngineMessage {
  return engineDocumentFromTable(NodeTable.fromMessage(message), sessionID);
}
