/**
 * An in-memory `BranchesRepository` for the branching UI's tests (round 2b builds before round 2a's store): records
 * kept in a map, previews handed in by the test (chunks, conflicts), every call logged. Behaviour follows docs/data.md
 * §15.5: no branches of branches, merged branches never restored, unresolved conflicts refuse apply / merge.
 */
import type { BranchEvent, BranchRecord, BranchReview, BranchesRepository, MergePreview } from "../../../../../shared/merge/branches";
import type { Conflict, DiffChunk, Resolutions } from "../../../../../shared/merge/types";
import type { OpenedFile } from "../../../../../shared/store/repositories";
import type { FileKey } from "../../../../../shared/store/types";
import type { BranchingBackend, Reviewer } from "../access";

export interface FakeOptions {
  /** The local user's id (null: signed out) */
  me?: { id: string | null; name: string | null };
  files?: Record<FileKey, string>;
  reviewers?: Reviewer[];
  canEditMain?: boolean;
  /** What preview() returns per direction (chunks and conflicts); unresolved is worked out from the resolutions */
  preview?: Partial<Record<"merge" | "update", { chunks: DiffChunk[]; conflicts: Conflict[] }>>;
}

/** A chunk for tests: a frame on Page 1 changed on the branch. */
export function fakeChunk(index: number, over: Partial<DiffChunk> = {}): DiffChunk {
  return {
    index,
    displayNode: `1:${index + 10}`,
    displayName: `Frame ${index}`,
    displayType: "FRAME",
    phase: null,
    canvasId: "0:1",
    canvasName: "Page 1",
    canvasIsInternal: false,
    nodeChanges: [],
    chunksAffectingThisChunk: [],
    parentHierarchyGuids: [],
    changedOn: ["branch"],
    conflicts: [],
    ...over,
  };
}

/** A field conflict on a chunk's display node. */
export function fakeConflict(chunk: number, field = "fillPaints"): Conflict {
  return { id: `1:${chunk + 10}|${field}`, kind: "field", guid: `1:${chunk + 10}`, field, itemKey: null, base: null, main: null, branch: null, removedOn: null, chunk };
}

export class MemoryBranches implements BranchesRepository {
  readonly records = new Map<FileKey, BranchRecord>();
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly opened: FileKey[] = [];
  mainHeadSeq = 1;
  private readonly listeners = new Set<(e: BranchEvent) => void>();
  private nextId = 1;

  constructor(readonly opts: FakeOptions = {}) {}

  private log(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }
  private emit(e: BranchEvent) {
    this.listeners.forEach((l) => l(e));
  }
  private must(key: FileKey): BranchRecord {
    const r = this.records.get(key);
    if (!r) throw new Error("not-found");
    return r;
  }
  private put(r: BranchRecord): BranchRecord {
    this.records.set(r.branchFileKey, r);
    this.emit({ type: "branch.updated", branch: r });
    return r;
  }

  /** A branch as round 2a would have made it (for tests opening a branch directly). */
  seed(partial: Partial<BranchRecord> & { branchFileKey: FileKey; mainFileKey: FileKey; name: string }): BranchRecord {
    const r: BranchRecord = {
      mainKey: null,
      branchKey: null,
      createdBy: { id: null, name: null },
      createdAt: 0,
      status: "active",
      base: { mainSeq: 1, mainVersionId: null, at: 0 },
      mainSeenSeq: 1,
      archivedAt: null,
      mergedAt: null,
      mergedBy: null,
      mergeVersionId: null,
      review: null,
      ...partial,
    };
    this.records.set(r.branchFileKey, r);
    return r;
  }

  /** Main moved on: the notice's event. */
  touchMain(branchFileKey: FileKey) {
    this.mainHeadSeq += 1;
    this.emit({ type: "branch.main-changed", branchFileKey, mainHeadSeq: this.mainHeadSeq });
  }

  async create(mainFileKey: FileKey, name: string) {
    this.log("create", mainFileKey, name);
    if ([...this.records.values()].some((r) => r.branchFileKey === mainFileKey)) throw new Error("invalid");
    const key = `branch-${this.nextId++}`;
    return this.put(this.seed({ branchFileKey: key, mainFileKey, name, createdAt: Date.now(), base: { mainSeq: this.mainHeadSeq, mainVersionId: null, at: Date.now() }, mainSeenSeq: this.mainHeadSeq }));
  }
  async list(mainFileKey: FileKey, tab: "active" | "archived" | "yours") {
    this.log("list", mainFileKey, tab);
    const all = [...this.records.values()].filter((r) => r.mainFileKey === mainFileKey);
    if (tab === "active") return all.filter((r) => r.status === "active");
    if (tab === "archived") return all.filter((r) => r.status !== "active");
    return all.filter((r) => r.createdBy.id === null || r.createdBy.id === this.opts.me?.id);
  }
  async get(branchFileKey: FileKey) {
    return this.records.get(branchFileKey) ?? null;
  }
  async rename(branchFileKey: FileKey, name: string) {
    this.log("rename", branchFileKey, name);
    return this.put({ ...this.must(branchFileKey), name });
  }
  async archive(branchFileKey: FileKey) {
    this.log("archive", branchFileKey);
    return this.put({ ...this.must(branchFileKey), status: "archived", archivedAt: Date.now() });
  }
  async restore(branchFileKey: FileKey) {
    this.log("restore", branchFileKey);
    const r = this.must(branchFileKey);
    if (r.status === "merged") throw new Error("invalid");
    return this.put({ ...r, status: "active", archivedAt: null });
  }
  async mainStatus(branchFileKey: FileKey) {
    const r = this.must(branchFileKey);
    return { changed: this.mainHeadSeq > r.base.mainSeq, mainHeadSeq: this.mainHeadSeq, baseSeq: r.base.mainSeq };
  }
  async preview(branchFileKey: FileKey, direction: "merge" | "update", resolutions: Resolutions = {}): Promise<MergePreview> {
    this.log("preview", branchFileKey, direction, resolutions);
    const p = this.opts.preview?.[direction] ?? { chunks: [], conflicts: [] };
    const unresolved = p.conflicts.filter((c) => !resolutions[c.id] && !resolutions[`chunk:${c.chunk}`] && !resolutions["*"]).map((c) => c.id);
    return { previewId: `preview-${this.nextId++}`, direction, mainHeadSeq: this.mainHeadSeq, branchHeadSeq: 1, chunks: p.chunks, conflicts: p.conflicts, unresolved, stats: { created: 0, removed: 0, updated: p.chunks.length, reKeyed: 0 } };
  }
  async openSide(previewId: string, side: "base" | "main" | "branch" | "merged"): Promise<OpenedFile> {
    this.log("openSide", previewId, side);
    throw new Error("no document in the fake");
  }
  private check(branchFileKey: FileKey, direction: "merge" | "update", resolutions: Resolutions) {
    const p = this.opts.preview?.[direction] ?? { chunks: [], conflicts: [] };
    if (p.conflicts.some((c) => !resolutions[c.id] && !resolutions[`chunk:${c.chunk}`] && !resolutions["*"])) throw new Error("invalid");
    return this.must(branchFileKey);
  }
  async applyUpdate(branchFileKey: FileKey, input: { previewId: string; resolutions: Resolutions }) {
    this.log("applyUpdate", branchFileKey, input);
    const r = this.check(branchFileKey, "update", input.resolutions);
    return this.put({ ...r, base: { mainSeq: this.mainHeadSeq, mainVersionId: null, at: Date.now() }, mainSeenSeq: this.mainHeadSeq });
  }
  async merge(branchFileKey: FileKey, input: { previewId: string; resolutions: Resolutions; title?: string; description?: string }) {
    this.log("merge", branchFileKey, input);
    const r = this.check(branchFileKey, "merge", input.resolutions);
    const branch = { ...r, status: "merged" as const, mergedAt: Date.now(), mergedBy: this.opts.me?.id ?? null, mergeVersionId: "v-merge", preMergeVersionId: "v-before-merge" };
    this.records.set(branchFileKey, branch);
    this.emit({ type: "branch.merged", branch });
    return { branch, version: { id: "v-merge", fileKey: r.mainFileKey, kind: "merge", title: input.title ?? r.name, description: input.description ?? null, createdAt: Date.now() } as never };
  }
  async requestReview(branchFileKey: FileKey, input: { reviewerIds: string[]; description: string }) {
    this.log("requestReview", branchFileKey, input);
    const r = this.must(branchFileKey);
    const names = new Map((this.opts.reviewers ?? []).map((p) => [p.userId, p.name]));
    const review: BranchReview = {
      id: `review-${this.nextId++}`,
      state: "in-review",
      requestedBy: this.opts.me?.id ?? null,
      description: input.description,
      createdAt: Date.now(),
      reviewers: input.reviewerIds.map((userId) => ({ userId, name: names.get(userId) ?? null, verdict: "pending", comment: "", at: null })),
    };
    this.put({ ...r, review });
    return review;
  }
  async answerReview(branchFileKey: FileKey, input: { verdict: "approved" | "changes-suggested"; comment?: string }) {
    this.log("answerReview", branchFileKey, input);
    const r = this.must(branchFileKey);
    if (!r.review) throw new Error("invalid");
    const me = this.opts.me?.id ?? null;
    const review: BranchReview = {
      ...r.review,
      state: input.verdict,
      reviewers: r.review.reviewers.map((x) => (x.userId === me ? { ...x, verdict: input.verdict, comment: input.comment ?? "", at: Date.now() } : x)),
    };
    this.put({ ...r, review });
    return review;
  }
  async withdrawReview(branchFileKey: FileKey) {
    this.log("withdrawReview", branchFileKey);
    const r = this.must(branchFileKey);
    if (!r.review) throw new Error("invalid");
    const me = this.opts.me?.id ?? null;
    const reviewers = r.review.reviewers.map((x) => (x.userId === me ? { ...x, verdict: "pending" as const, comment: "", at: null } : x));
    const last = reviewers.filter((x) => x.verdict !== "pending").sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
    const review: BranchReview = { ...r.review, state: last ? (last.verdict as "approved" | "changes-suggested") : "in-review", reviewers };
    this.put({ ...r, review });
    return review;
  }
  async closeReview(branchFileKey: FileKey) {
    this.log("closeReview", branchFileKey);
    const r = this.must(branchFileKey);
    if (!r.review) throw new Error("invalid");
    const review: BranchReview = { ...r.review, state: "closed" };
    this.put({ ...r, review });
    return review;
  }
  async undoMerge(branchFileKey: FileKey) {
    this.log("undoMerge", branchFileKey);
    const r = this.must(branchFileKey);
    if (r.status !== "merged") throw new Error("invalid");
    return this.put({ ...r, status: "active", mergedAt: null, mergedBy: null, mergeVersionId: null, preMergeVersionId: null, archivedAt: null });
  }
  watch(listener: (e: BranchEvent) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** The UI's backend over this repository. */
  backend(): BranchingBackend {
    return {
      branches: this,
      fileName: async (k) => this.opts.files?.[k] ?? null,
      reviewers: async () => this.opts.reviewers ?? [],
      me: async () => this.opts.me ?? { id: null, name: null },
      canEditMain: async () => this.opts.canEditMain ?? true,
      openFile: async (k) => void this.opened.push(k),
      link: async (b) => (b.branchKey ? `https://example.test/file/${b.mainKey}/branch/${b.branchKey}` : null),
    };
  }
}
