/**
 * Branch merging (docs/data.md §15.3–§15.6): the diff of two node tables, the three-way merge with its conflicts and
 * Figma's DiffChunk grouping. Pure: the store runs it (src/store/branches), never a view.
 */
export * from "./types";
export { diff, fieldEqual, keyedFields, type KeyedField } from "./diff";
export { merge3, mergeTables, batchOf, MergedTable, MergeInvalidError, type MergeOptions, type MergeOutput } from "./merge3";
export { displayNodeOf } from "./chunks";
