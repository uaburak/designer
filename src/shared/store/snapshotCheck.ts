/**
 * The store's check on a snapshot the engine wrote (docs/data.md §5.5 "Snapshots from the engine"): it may replace
 * the file's snapshot + journal only if it holds every node the head holds and every reference and content field
 * (`REFERENCE_FIELDS`: what a node is, what it points at, what it says and paints) with a value. Other values may
 * change, to their default too — in kiwi an absent field *is* its default (docs/schema.md §3.4), and the engine
 * legitimately rewrites geometry and bound values (stale stored geometry corrected in memory, values a variable
 * resolves) — so they are not losses. Shared by the local store and the browser's dev store.
 */
import { guidKey, type GUID } from "../schema/guid";
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

/**
 * An empty value of any shape: an empty array, bytes or string, or a message whose every value is empty ({entries: []},
 * a TextData `{characters: ""}`). The engine holds such a message as its default — no message — and writes it as
 * absent (docs/schema.md §3.4): a detached frame's `textData {characters: ""}` (written by Detach instance before
 * 2026-10-19) had every snapshot of the owner's file refused.
 */
function emptyish(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v) || v instanceof Uint8Array) return v.length === 0;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).every(emptyish);
  return false;
}

const absent = (name: string, v: unknown) => emptyish(v) || isAbsentValue(name, v);

/** A deleted main the engine lets go at load (docs/schema.md §5.7): soft-deleted, a component or set, never published. */
function purgeableMain(n: Record<string, unknown> | undefined): boolean {
  if (!n || n.isSoftDeleted !== true) return false;
  if (n.type !== "SYMBOL" && !(n.type === "FRAME" && n.isStateGroup === true)) return false;
  const published = n.publishedVersion;
  return published === undefined || published === null || published === "";
}

/** The node or one of its ancestors (in `head`) is a deleted main the engine lets go when nothing uses it. */
function underPurgeableMain(head: NodeTable, key: string): boolean {
  let n = head.nodes.get(key) as Record<string, unknown> | undefined;
  for (let depth = 0; n && depth < 256; depth++) {
    if (purgeableMain(n)) return true;
    const parent = (n.parentIndex as { guid?: GUID } | undefined)?.guid;
    if (!parent) return false;
    n = head.nodes.get(guidKey(parent)) as Record<string, unknown> | undefined;
  }
  return false;
}

/** What the snapshot `snap` loses against the head `head` (both tables of the same file). */
export function snapshotLosses(head: NodeTable, snap: NodeTable): SnapshotLosses {
  const out: SnapshotLosses = { missingNodes: 0, droppedFields: {}, total: 0, examples: [] };
  for (const [key, n] of head.nodes) {
    const s = snap.nodes.get(key) as Record<string, unknown> | undefined;
    // A deleted main nothing uses (and what is inside it) goes at the engine's load — Figma's rule, not a loss (the
    // owner's Wecra UI had every snapshot refused for 1969 such nodes, so its journal only grew).
    if (!s && underPurgeableMain(head, key)) continue;
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
