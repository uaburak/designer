/**
 * The store's check on a snapshot the engine wrote (docs/data.md §5.5 "Snapshots from the engine"): it may replace
 * the file's snapshot + journal only if it holds every node the head holds and every reference and content field
 * (`REFERENCE_FIELDS`: what a node is, what it points at, what it says and paints) with a value. Other values may
 * change, to their default too — in kiwi an absent field *is* its default (docs/schema.md §3.4), and the engine
 * legitimately rewrites geometry and bound values (stale stored geometry corrected in memory, values a variable
 * resolves) — so they are not losses. Shared by the local store and the browser's dev store.
 */
import { DERIVED_FIELDS, type NodeTable } from "../schema/patch";
import { isAbsentValue } from "./assetIdentity";

export interface SnapshotLosses {
  /** Nodes of the head the snapshot lacks */
  missingNodes: number;
  /** Reference and content fields of the head (with a value that isn't absence) the snapshot lacks or empties, by name */
  droppedFields: Record<string, number>;
  /** missingNodes + every dropped field */
  total: number;
  /** A few examples ("guid field"), for the log */
  examples: string[];
}

/**
 * Fields whose loss would be data loss whatever the engine re-derives: identity, references (mains, styles,
 * variables, libraries, bindings), content (text, vectors, paints, effects), and the asset bookkeeping.
 */
export const REFERENCE_FIELDS: ReadonlySet<string> = new Set([
  "type", "name", "parentIndex",
  "symbolData", "overriddenSymbolID", "detachedSymbolId", "componentPropAssignments", "componentPropDefs", "componentPropRefs", "isStateGroup",
  "parameterConsumptionMap", "variableModeBySetMap", "variableSetID", "variableSetModes", "variableResolvedType", "variableDataValues",
  "styleIdForFill", "styleIdForStrokeFill", "styleIdForText", "styleIdForEffect", "styleIdForGrid", "styleType",
  "key", "sourceLibraryKey", "publishID", "version", "publishedVersion", "libraryMoveInfo", "librarySubscriptions",
  "textData", "vectorData", "fillPaints", "strokePaints", "effects", "internalOnly", "isSoftDeleted",
]);

const SKIP = new Set(["guid", "phase", "clearedFields"]);

/** An empty value of any shape: an empty array or bytes, or a message whose every value is empty ({entries: []}). */
function emptyish(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v) || v instanceof Uint8Array) return v.length === 0;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).every(emptyish);
  return false;
}

const absent = (name: string, v: unknown) => emptyish(v) || isAbsentValue(name, v);

/** What the snapshot `snap` loses against the head `head` (both tables of the same file). */
export function snapshotLosses(head: NodeTable, snap: NodeTable): SnapshotLosses {
  const out: SnapshotLosses = { missingNodes: 0, droppedFields: {}, total: 0, examples: [] };
  for (const [key, n] of head.nodes) {
    const s = snap.nodes.get(key) as Record<string, unknown> | undefined;
    if (!s) {
      out.missingNodes++;
      out.total++;
      if (out.examples.length < 8) out.examples.push(`${key} (${n.type ?? "?"}) missing`);
      continue;
    }
    for (const [f, v] of Object.entries(n)) {
      if (SKIP.has(f) || DERIVED_FIELDS.has(f) || !REFERENCE_FIELDS.has(f) || absent(f, v)) continue;
      if (s[f] !== undefined && !absent(f, s[f])) continue;
      out.droppedFields[f] = (out.droppedFields[f] ?? 0) + 1;
      out.total++;
      if (out.examples.length < 8) out.examples.push(`${key} (${n.type ?? "?"}) ${f}`);
    }
  }
  return out;
}
