// Branching's pure parts (branching/model.ts): grouping by page then top-level layer, change tags, a pick per chunk
// and Resolve all as Resolutions, review badges and roles, links.
import { describe, expect, it } from "vitest";
import { fakeChunk as chunk } from "../fake/memoryBranches";
import { allPicked, branchBadge, branchLink, changeTag, detailLines, groupChunks, pickAll, pickOf, propertyName, reviewRole, sendLabel, withPick } from "../model";

describe("branching model", () => {
  it("groups chunks by page in order, the internal page's last as Assets", () => {
    const g = groupChunks([chunk(0), chunk(1, { canvasId: "0:2", canvasName: "Page 2" }), chunk(2, { canvasIsInternal: true, canvasId: "0:9", displayType: "VARIABLE_SET" }), chunk(3)]);
    expect(g.map((x) => [x.name, x.chunks.map((c) => c.index)])).toEqual([
      ["Page 1", [0, 3]],
      ["Page 2", [1]],
      ["Assets", [2]],
    ]);
  });

  it("tags chunks Added / Edited / Removed by their display node's phase", () => {
    expect([changeTag({ phase: "CREATED" }), changeTag({ phase: null }), changeTag({ phase: "REMOVED" })]).toEqual(["Added", "Edited", "Removed"]);
    // Figma's UPDATED_LIBRARY: a library copy the other side updated
    expect(changeTag({ phase: null, libraryUpdate: true })).toBe("Updated library");
  });

  it("says each property's change once, in the panel's words", () => {
    expect(propertyName("fillPaints")).toBe("Fill");
    expect(propertyName("stackPrimarySizing")).toBe("Stack primary sizing");
    expect(detailLines({ phase: "created", fields: [] })).toEqual(["Added"]);
    expect(
      detailLines({
        phase: "updated",
        fields: [
          { field: "fillPaints", change: "changed" },
          { field: "rectangleTopLeftCornerRadius", change: "added" },
          { field: "rectangleTopRightCornerRadius", change: "added" },
          { field: "effects", change: "removed" },
        ],
      }),
    ).toEqual(["Fill changed", "Corner radius added", "Effects removed"]);
  });

  it("picks per chunk, Resolve all, and single conflict picks", () => {
    const p = { chunks: [chunk(0, { conflicts: ["a|x", "a|y"] }), chunk(1), chunk(2, { conflicts: ["b|x"] })] };
    expect(allPicked({}, p)).toBe(false);
    let picks = withPick({}, p.chunks[0], "main");
    expect(pickOf(picks, p.chunks[0])).toBe("main");
    expect(allPicked(picks, p)).toBe(false);
    picks = withPick(picks, p.chunks[2], "branch");
    expect(allPicked(picks, p)).toBe(true);
    expect(picks).toEqual({ "chunk:0": "main", "chunk:2": "branch" });
    // Resolve all
    expect(pickOf(pickAll("branch"), p.chunks[0])).toBe("branch");
    expect(allPicked(pickAll("main"), p)).toBe(true);
    // Conflict-level picks that agree count as the chunk's; a chunk pick replaces them
    expect(pickOf({ "a|x": "main", "a|y": "main" }, p.chunks[0])).toBe("main");
    expect(pickOf({ "a|x": "main", "a|y": "branch" }, p.chunks[0])).toBeNull();
    expect(withPick({ "a|x": "main" }, p.chunks[0], "branch")).toEqual({ "chunk:0": "branch" });
  });

  it("badges, roles and wording", () => {
    const base = { status: "active" as const, review: null };
    expect(branchBadge(base)).toBeNull();
    const review = { id: "r", state: "in-review" as const, requestedBy: null, description: "", createdAt: 0, reviewers: [{ userId: "u2", name: "Ada", verdict: "pending" as const, comment: "", at: null }] };
    expect(branchBadge({ ...base, review })).toBe("In review");
    expect(branchBadge({ ...base, review: { ...review, state: "approved" } })).toBe("Approved");
    expect(branchBadge({ ...base, review: { ...review, state: "changes-suggested" } })).toBe("Changes suggested");
    expect(branchBadge({ status: "merged", review })).toBe("Merged");
    expect(branchBadge({ status: "archived", review: null })).toBe("Archived");
    expect(reviewRole({ createdBy: { id: null, name: null }, review }, { id: null })).toBe("author");
    expect(reviewRole({ createdBy: { id: "u1", name: null }, review }, { id: "u2" })).toBe("reviewer");
    expect(reviewRole({ createdBy: { id: "u1", name: null }, review }, { id: "u3" })).toBe("other");
    expect([sendLabel(1), sendLabel(3)]).toEqual(["Send to 1 reviewer", "Send to 3 reviewers"]);
    expect(branchLink("https://x.test/file/abc?x=1", "def")).toBe("https://x.test/file/abc/branch/def?x=1");
  });
});
