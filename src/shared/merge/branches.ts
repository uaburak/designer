/**
 * Branches' records and repository (docs/data.md §15.2 / §15.6), committed before Phase 7 round 2: 2a adds
 * `branches: BranchesRepository` and the "branches" topic to StoreApi (re-exporting these), FileMeta.branch,
 * the version / batch kinds; 2b builds the editor's UI against this interface.
 */
import type { FileKey, VersionId, VersionRecord } from "../store/types";
import type { OpenedFile } from "../store/repositories";
import type { Unsubscribe } from "../store/emitter";
import type { Conflict, DiffChunk, MergeResult, Resolutions } from "./types";

export type BranchStatus = "active" | "archived" | "merged";
export interface BranchRecord {
  /** The branch's own file (a local file, or a room for a shared main) */
  branchFileKey: FileKey;
  mainFileKey: FileKey;
  /** Room keys when main is shared (the branch is then shared too); null for local files */
  mainKey: string | null;
  branchKey: string | null;
  name: string;
  createdBy: { id: string | null; name: string | null };   // null id: the local user
  createdAt: number;
  status: BranchStatus;
  /** The merge base: main as it was at "Create branch" or the last "Update from main" */
  base: { mainSeq: number; mainVersionId: VersionId | null; at: number };
  /** main's head seq when the branch last looked (the "main has changed" notice compares it) */
  mainSeenSeq: number;
  archivedAt: number | null;
  mergedAt: number | null;
  mergedBy: string | null;
  /** The main's version "Branch merged" made by the merge */
  mergeVersionId: VersionId | null;
  /** Main's savepoint just before the merge (atlas 16 §3.2): Undo merge restores it. Absent on older records and on
   *  shared merges (the server's) */
  preMergeVersionId?: VersionId | null;
  review: BranchReview | null;
}
export interface BranchReview {
  id: string;
  state: "in-review" | "approved" | "changes-suggested" | "closed";
  requestedBy: string | null;
  description: string;
  createdAt: number;
  reviewers: { userId: string; name: string | null; verdict: "pending" | "approved" | "changes-suggested"; comment: string; at: number | null }[];
}


export type BranchEvent =
  | { type: "branch.updated"; branch: BranchRecord }
  | { type: "branch.main-changed"; branchFileKey: FileKey; mainHeadSeq: number }
  | { type: "branch.merged"; branch: BranchRecord };

export interface MergePreview {
  previewId: string;                 // valid ~10 minutes, one per branch and direction
  direction: "merge" | "update";
  mainHeadSeq: number;
  branchHeadSeq: number;
  chunks: DiffChunk[];
  conflicts: Conflict[];
  unresolved: string[];
  stats: MergeResult["stats"];
}

export interface BranchesRepository {
  create(mainFileKey: FileKey, name: string): Promise<BranchRecord>;
  /** "Active" | "Archived" (archived + merged) | "Yours" (created by the user, any status) */
  list(mainFileKey: FileKey, tab: "active" | "archived" | "yours"): Promise<BranchRecord[]>;
  get(branchFileKey: FileKey): Promise<BranchRecord | null>;
  rename(branchFileKey: FileKey, name: string): Promise<BranchRecord>;
  archive(branchFileKey: FileKey): Promise<BranchRecord>;
  restore(branchFileKey: FileKey): Promise<BranchRecord>;
  /** Main's head vs the base: whether to show the notice */
  mainStatus(branchFileKey: FileKey): Promise<{ changed: boolean; mainHeadSeq: number; baseSeq: number }>;
  preview(branchFileKey: FileKey, direction: "merge" | "update", resolutions?: Resolutions): Promise<MergePreview>;
  /** A side of a preview opened read-only for Compare changes' views (side by side / overlay): base, main, branch or
   *  the merged result */
  openSide(previewId: string, side: "base" | "main" | "branch" | "merged"): Promise<OpenedFile>;
  applyUpdate(branchFileKey: FileKey, input: { previewId: string; resolutions: Resolutions }): Promise<BranchRecord>;
  merge(branchFileKey: FileKey, input: { previewId: string; resolutions: Resolutions; title?: string; description?: string }): Promise<{ branch: BranchRecord; version: VersionRecord }>;
  requestReview(branchFileKey: FileKey, input: { reviewerIds: string[]; description: string }): Promise<BranchReview>;
  answerReview(branchFileKey: FileKey, input: { verdict: "approved" | "changes-suggested"; comment?: string }): Promise<BranchReview>;
  /**
   * Undo merge (main's "Branch merged" version, atlas 16 §4.8): the merged branch active again, as before the merge.
   * Main itself goes back by restoring `preMergeVersionId` (the editor's restore: one undoable step and a restore
   * version). A local merge only.
   */
  undoMerge(branchFileKey: FileKey): Promise<BranchRecord>;
  watch(listener: (e: BranchEvent) => void): Unsubscribe;
}
