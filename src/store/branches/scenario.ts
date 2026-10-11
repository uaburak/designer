/**
 * The branches scenario both stores run (docs/data.md §15.5, §15.8 cases 19, 25–27): create / list / Update from main /
 * Merge / archive / restore / reviews through `StoreApi` alone — src/store/branches/branches.test.ts (the desktop
 * store) and src/renderer/src/store/memory/branches.test.ts (the browser's dev store). Pure: no Node or DOM.
 */
import { expect } from "vitest";
import { decodeMessage, encodeMessage, type NodeChange } from "../../shared/schema/codec";
import { splitSessionId } from "../../shared/schema/guid";
import { NodeTable } from "../../shared/schema/patch";
import type { BranchEvent } from "../../shared/merge/branches";
import type { FileChange, OpenedFile, StoreApi } from "../../shared/store/repositories";
import type { ChangeBatch } from "../../shared/store/types";
import { SESSION_BLOCK } from "./service";

const PAGE = { sessionID: 0, localID: 1 };

export function rect(sessionID: number, localID: number, position: string): NodeChange {
  return { guid: { sessionID, localID }, phase: "CREATED", type: "ROUNDED_RECTANGLE", name: `Rectangle ${localID}`, parentIndex: { guid: PAGE, position }, size: { x: 100, y: 100 } };
}

export function batch(sessionID: number, batchSeq: number, nodeChanges: NodeChange[]): ChangeBatch {
  return { sessionID, batchSeq, kind: "edit", label: "Edit", message: encodeMessage({ type: "NODE_CHANGES", sessionID, ackID: 0, nodeChanges, blobs: [] }), wallClock: Date.UTC(2026, 9, 6) };
}

export function tableOf(o: OpenedFile): NodeTable {
  const table = NodeTable.fromMessage(decodeMessage(o.snapshot));
  for (const f of o.journal) table.apply(decodeMessage(f.message));
  return table;
}

/** Opens for editing, appends `changes(sessionID)` as one batch, closes. */
export async function editFile(api: StoreApi, fileKey: string, changes: (s: number) => NodeChange[]): Promise<number> {
  const o = await api.files.open(fileKey, { mode: "edit" });
  await api.files.append(fileKey, batch(o.sessionID, 1, changes(o.sessionID)));
  await api.files.close(fileKey, o.sessionID);
  return o.sessionID;
}

async function head(api: StoreApi, fileKey: string): Promise<NodeTable> {
  return tableOf(await api.files.open(fileKey, { mode: "view" }));
}

const g = (sessionID: number, localID: number) => `${sessionID}:${localID}`;

export async function scenario(api: StoreApi, idle: () => Promise<void>): Promise<void> {
  const { workspace, files, branches } = api;
  const events: BranchEvent[] = [];
  branches.watch((e) => events.push(e));
  const main = await workspace.createFile({ name: "Design", folderId: null });
  const s0 = await editFile(api, main.fileKey, (s) => [rect(s, 1, "!")]);

  // Create branch.
  const b = await branches.create(main.fileKey, "Feature");
  expect(b).toMatchObject({ mainFileKey: main.fileKey, name: "Feature", status: "active", mainKey: null, branchKey: null, review: null });
  expect(b.base.mainSeq).toBe(1);
  const bm = await workspace.getFile(b.branchFileKey);
  expect(bm.name).toBe("Feature");
  expect(bm.branch).toEqual({ mainFileKey: main.fileKey, name: "Feature", status: "active" });
  expect((await workspace.listFiles({ in: "drafts" })).map((f) => f.fileKey)).toEqual([main.fileKey]);
  expect((await files.listVersions(main.fileKey)).map((v) => [v.kind, v.title])).toEqual([["branch", "Feature"]]);
  expect((await files.listVersions(b.branchFileKey)).map((v) => v.kind)).toEqual(["branch"]);
  // The copy keeps identity: the same GUIDs.
  expect((await head(api, b.branchFileKey)).get(g(s0, 1))?.name).toBe("Rectangle 1");
  expect(await branches.list(main.fileKey, "active")).toEqual([b]);
  expect(await branches.list(main.fileKey, "yours")).toEqual([b]);
  expect(await branches.list(main.fileKey, "archived")).toEqual([]);
  expect(await branches.get(b.branchFileKey)).toEqual(b);

  // Case 27: GUID blocks — main's next session is past the branch's block.
  const sb = await editFile(api, b.branchFileKey, (s) => [{ guid: { sessionID: s0, localID: 1 }, name: "Branch's" }, rect(s, 1, '"')]);
  const sm = await editFile(api, main.fileKey, (s) => [{ guid: { sessionID: s0, localID: 1 }, name: "Main's" }, rect(s, 1, "#")]);
  expect(sb).not.toBe(sm);
  expect(splitSessionId(sm).n - splitSessionId(sb).n).toBe(SESSION_BLOCK);
  await idle();
  expect(events.some((e) => e.type === "branch.main-changed" && e.branchFileKey === b.branchFileKey)).toBe(true);
  expect(await branches.mainStatus(b.branchFileKey)).toEqual({ changed: true, mainHeadSeq: 2, baseSeq: 1 });

  // Update from main: one conflict (the rectangle's name), all picked before Apply.
  const up = await branches.preview(b.branchFileKey, "update");
  expect(up.conflicts.map((c) => [c.kind, c.field, c.main, c.branch])).toEqual([["field", "name", "Main's", "Branch's"]]);
  expect(up.unresolved).toHaveLength(1);
  await expect(branches.applyUpdate(b.branchFileKey, { previewId: up.previewId, resolutions: {} })).rejects.toMatchObject({ code: "invalid" });
  const side = await branches.openSide(up.previewId, "main");
  expect(side.mode).toBe("view");
  expect(tableOf(side).get(g(sm, 1))).toBeDefined();
  const merged = await branches.openSide(up.previewId, "merged");
  expect(tableOf(merged).get(g(sm, 1))).toBeDefined();
  const updated = await branches.applyUpdate(b.branchFileKey, { previewId: up.previewId, resolutions: { "*": "branch" } });
  expect(updated.base.mainSeq).toBe(2);
  expect(updated.mainSeenSeq).toBe(2);
  const afterUpdate = await head(api, b.branchFileKey);
  expect(afterUpdate.get(g(sm, 1))).toBeDefined();
  expect(afterUpdate.get(g(s0, 1))?.name).toBe("Branch's");
  expect((await files.listVersions(b.branchFileKey)).map((v) => v.kind)).toEqual(["update", "branch"]);
  expect(await branches.mainStatus(b.branchFileKey)).toEqual({ changed: false, mainHeadSeq: 2, baseSeq: 2 });
  // The preview is spent.
  await expect(branches.applyUpdate(b.branchFileKey, { previewId: up.previewId, resolutions: {} })).rejects.toMatchObject({ code: "stale" });

  // Case 25: the conflict resolved during the update doesn't come back at the merge.
  const pm = await branches.preview(b.branchFileKey, "merge");
  expect(pm.conflicts).toEqual([]);
  expect(pm.stats.created).toBe(1);
  // Open editors get the merge as remote changes.
  const seen: FileChange[] = [];
  const off = files.subscribe(main.fileKey, 2, (c) => seen.push(c));
  const { branch: done, version } = await branches.merge(b.branchFileKey, { previewId: pm.previewId, resolutions: {}, description: "Ready" });
  await idle();
  off();
  expect(seen.map((c) => [c.kind, c.sessionID])).toEqual([["merge", 0]]);
  expect(version).toMatchObject({ kind: "merge", title: "Feature", description: "Ready" });
  expect(done).toMatchObject({ status: "merged", mergeVersionId: version.id });
  expect(done.mergedAt).not.toBeNull();
  expect((await files.listVersions(main.fileKey)).map((v) => v.kind)).toEqual(["merge", "autosave", "branch"]);
  expect((await files.listVersions(b.branchFileKey)).map((v) => v.kind)).toEqual(["merge", "update", "branch"]);
  const afterMerge = await head(api, main.fileKey);
  expect(afterMerge.get(g(s0, 1))?.name).toBe("Branch's");
  expect(afterMerge.get(g(sb, 1))).toBeDefined();
  expect(afterMerge.get(g(sm, 1))).toBeDefined();
  expect(events.some((e) => e.type === "branch.merged")).toBe(true);
  expect((await workspace.getFile(b.branchFileKey)).branch?.status).toBe("merged");
  // A merged branch opens read-only, can't be restored, can't be merged again.
  expect((await files.open(b.branchFileKey, { mode: "edit" })).mode).toBe("view");
  await expect(branches.restore(b.branchFileKey)).rejects.toMatchObject({ code: "invalid" });
  await expect(branches.preview(b.branchFileKey, "merge")).rejects.toMatchObject({ code: "invalid" });
  expect((await branches.list(main.fileKey, "archived")).map((r) => r.branchFileKey)).toEqual([b.branchFileKey]);

  // Case 26: a head moved since the preview → stale.
  const b2 = await branches.create(main.fileKey, "Second");
  await editFile(api, b2.branchFileKey, (s) => [rect(s, 1, "$")]);
  const p2 = await branches.preview(b2.branchFileKey, "merge");
  await editFile(api, main.fileKey, (s) => [rect(s, 1, "%")]);
  await expect(branches.merge(b2.branchFileKey, { previewId: p2.previewId, resolutions: {} })).rejects.toMatchObject({ code: "stale" });

  // Archive / restore / rename.
  const archived = await branches.archive(b2.branchFileKey);
  expect(archived.status).toBe("archived");
  expect((await files.open(b2.branchFileKey, { mode: "edit" })).mode).toBe("view");
  expect((await branches.restore(b2.branchFileKey)).status).toBe("active");
  const renamed = await branches.rename(b2.branchFileKey, "Second take");
  expect(renamed.name).toBe("Second take");
  expect((await workspace.getFile(b2.branchFileKey)).name).toBe("Second take");

  // Refusals: a branch of a branch; publishing from a branch (case 19).
  await expect(branches.create(b2.branchFileKey, "Nested")).rejects.toMatchObject({ code: "invalid" });
  await expect(branches.create(main.fileKey, "  ")).rejects.toMatchObject({ code: "invalid" });
  await expect(api.libraries.publish({ libraryFileKey: b2.branchFileKey, description: "", assets: [], moves: [] })).rejects.toMatchObject({ code: "branch-cannot-publish" });

  // Reviews: request, answer, request another.
  const review = await branches.requestReview(b2.branchFileKey, { reviewerIds: ["u1"], description: "Please look" });
  expect(review).toMatchObject({ state: "in-review", description: "Please look", reviewers: [{ userId: "u1", verdict: "pending" }] });
  const answered = await branches.answerReview(b2.branchFileKey, { verdict: "changes-suggested", comment: "Spacing" });
  expect(answered.state).toBe("changes-suggested");
  const again = await branches.requestReview(b2.branchFileKey, { reviewerIds: [], description: "" });
  expect(again.id).toBe(review.id);
  expect(again.state).toBe("in-review");
  expect(again.reviewers.every((r) => r.verdict === "pending")).toBe(true);
  expect((await branches.get(b2.branchFileKey))?.review?.state).toBe("in-review");
}
