/**
 * Branch merging's value types (docs/data.md §15.6), committed before Phase 7 round 2 so the merge core (2a), the
 * editor's branching UI (2b) and the server (2c) share them. `diff` / `merge3` / `displayNodeOf` come with 2a.
 */
import type { GUID, Message } from "../schema/document.generated";
import type { NodeTable } from "../schema/patch";

export const ABSENT: unique symbol = Symbol("absent");
export type Value = unknown | typeof ABSENT;

export interface FieldChange { field: string; before: Value; after: Value }
export interface ItemChange { field: string; itemKey: string; before: Value; after: Value } // keyed fields (§15.3)
export interface NodeDelta {
  key: string;                       // "s:l"
  guid: GUID;
  phase: "created" | "removed" | "updated";
  fields: FieldChange[];             // updated: changed whole fields; created: every field
  items: ItemChange[];               // updated: changed items of keyed fields
}
export interface TableDiff { deltas: Map<string, NodeDelta> }

export type Side = "main" | "branch";
export type ConflictKind = "field" | "keyed" | "delete-edit" | "move" | "cycle";
export interface Conflict {
  id: string;                        // "<guid>|<field>[|<itemKey>]" — stable across previews
  kind: ConflictKind;
  guid: string;
  field: string | null;
  itemKey: string | null;
  base: Value; main: Value; branch: Value;
  /** For delete-edit: which side removed it */
  removedOn: Side | null;
  chunk: number;
}
/** Figma's DiffChunk (figma-schema-106.kiwi), with GUIDs as "s:l" strings and our conflicts */
export interface DiffChunk {
  index: number;
  displayNode: string;
  displayName: string;
  displayType: string;               // NodeType name
  phase: "CREATED" | "REMOVED" | null;
  canvasId: string;
  canvasName: string;
  canvasIsInternal: boolean;
  /** Indices into MergeResult.batch.nodeChanges */
  nodeChanges: number[];
  chunksAffectingThisChunk: number[];
  parentHierarchyGuids: string[];
  /** Which sides changed something in it */
  changedOn: Side[];
  conflicts: string[];
  /** The display node is a library copy the incoming side updated (Figma's UPDATED_LIBRARY phase) */
  libraryUpdate?: boolean;
  /** Figma's change details: what the incoming side changed, per node (its first CHUNK_DETAILS_MAX nodes) */
  details?: ChunkDetail[];
}
/** One node's changes in a chunk: each field added, changed or removed (keyed fields' items count as the field changed) */
export interface ChunkDetail {
  guid: string;
  name: string;
  type: string;
  phase: "created" | "removed" | "updated";
  fields: { field: string; change: "added" | "changed" | "removed" }[];
}
export const CHUNK_DETAILS_MAX = 50;
export type Resolutions = Record<string /* Conflict.id, or "chunk:<index>", or "*" */, Side>;
export interface MergeInput {
  base: NodeTable;
  main: NodeTable;
  branch: NodeTable;
  direction: "merge" | "update";
  resolutions?: Resolutions;
}
export interface MergeResult {
  direction: "merge" | "update";
  /** NODE_CHANGES to apply to the target head (main on merge, the branch on update); empty when nothing changes */
  batch: Message;
  chunks: DiffChunk[];
  conflicts: Conflict[];
  /** Conflict ids still without a side; non-empty → the batch must not be written */
  unresolved: string[];
  stats: { created: number; removed: number; updated: number; reKeyed: number };
}

