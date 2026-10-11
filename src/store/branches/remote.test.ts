// Branches of shared files over the server's routes (docs/data.md §15.7), against the contract fake until round 2c.
import { describe, expect, it } from "vitest";
import type { FileKey, VersionRecord } from "../../shared/store/types";
import { FakeBranchServer } from "./fake/server";
import { RemoteBranches, type SyncState } from "./remote";

function setup() {
  const server = new FakeBranchServer();
  const sync = new Map<FileKey, SyncState>([["mainLocal", { key: "main-room", since: 40, acked: 7, connection: "live", pending: 0 }]]);
  const heads = new Map<FileKey, number>([["mainLocal", 7]]);
  const shared: { fileKey: FileKey; key: string; snapshot: Uint8Array }[] = [];
  const remote = new RemoteBranches({
    call: (method, path, body) => server.handle(method, path, body) as never,
    syncState: async (k) => sync.get(k) ?? null,
    shareTo: async (fileKey, input, register, key) => {
      const room = key ?? `room-${fileKey}`;
      const answer = await register(room, "Feature");
      await server.handle("PUT", `/files/${room}/snapshot?seq=0`, input.snapshot);
      shared.push({ fileKey, key: room, snapshot: input.snapshot });
      sync.set(fileKey, { key: room, since: 0, acked: 0, connection: "live", pending: 0 });
      return answer;
    },
    newRoomKey: (base) => `${base}-room`,
    linkedCopies: async () => new Map([...sync].map(([k, s]) => [s.key, k])),
    headSeq: async (k) => heads.get(k) ?? 0,
    signedIn: () => true,
    sleep: async () => {},
  });
  return { server, sync, heads, shared, remote };
}

describe("RemoteBranches (docs/data.md §15.7)", () => {
  it("creates a branch room linked to the local copy, with its snapshot and base", async () => {
    const { server, shared, remote } = setup();
    expect(await remote.isShared("mainLocal")).toBe(true);
    expect(await remote.isShared("other")).toBe(false);
    const snapshot = new Uint8Array([1, 2, 3]);
    const rec = await remote.create({ mainFileKey: "mainLocal", branchFileKey: "branchLocal", name: "Feature", snapshot, localBaseSeq: 7 });
    expect(rec).toMatchObject({ branchFileKey: "branchLocal", mainFileKey: "mainLocal", mainKey: "main-room", branchKey: "branchLocal-room", name: "Feature", status: "active", base: { mainSeq: 40 }, createdBy: { id: "u-me", name: "Me" } });
    expect(shared).toHaveLength(1);
    expect(server.snapshots.get("branchLocal-room")).toEqual(snapshot);
    expect(server.bases.get("branchLocal-room")).toEqual({ seq: 40, bytes: snapshot });
    expect(server.log).toEqual(["POST /files/main-room/branches", "PUT /files/branchLocal-room/snapshot?seq=0", "PUT /branches/branchLocal-room/base?seq=40"]);
    // The branch room's sessions start where main's were; main's jump by 65536.
    expect(server.branches.get("branchLocal-room")!.sessionBase).toBe(1);
    expect(server.sessionCounters.get("main-room")).toBe(65537);
    expect((await remote.list("mainLocal", "active")).map((r) => r.branchFileKey)).toEqual(["branchLocal"]);
    expect(await remote.list("mainLocal", "archived")).toEqual([]);
  });

  it("archive, restore, rename, update, merge, reviews", async () => {
    const { server, sync, heads, remote } = setup();
    const rec = await remote.create({ mainFileKey: "mainLocal", branchFileKey: "b", name: "Feature", snapshot: new Uint8Array([1]), localBaseSeq: 7 });
    expect((await remote.patch(rec, { status: "archived" })).status).toBe("archived");
    expect((await remote.patch(rec, { status: "active", name: "Feature 2" })).name).toBe("Feature 2");
    sync.get("mainLocal")!.since = 55;
    const up = await remote.updated(rec, new Uint8Array([9]));
    expect(up.base.mainSeq).toBe(55);
    expect(up.mainSeenSeq).toBe(55);
    expect(server.bases.get(rec.branchKey!)!.seq).toBe(55);
    // A merge needs main live and caught up, and waits for the room's ack.
    heads.set("mainLocal", 9);
    expect(await remote.caughtUp("mainLocal")).toBe(false);
    sync.get("mainLocal")!.acked = 9;
    expect(await remote.caughtUp("mainLocal")).toBe(true);
    sync.get("mainLocal")!.connection = "offline";
    expect(await remote.caughtUp("mainLocal")).toBe(false);
    sync.get("mainLocal")!.connection = "live";
    heads.set("mainLocal", 10);
    await expect(remote.whenSent("mainLocal", 300)).rejects.toMatchObject({ code: "offline" });
    sync.get("mainLocal")!.acked = 10;
    await remote.whenSent("mainLocal");
    const merged = await remote.merged(rec, { id: "V1" } as VersionRecord);
    expect(merged).toMatchObject({ status: "merged", mergeVersionId: "V1", mergedBy: "u-me" });
    await expect(remote.patch(rec, { status: "active" })).rejects.toMatchObject({ code: "invalid" });
    // Reviews: the requester asks someone else; a reviewer answers.
    const review = await remote.requestReview(rec, ["u-me", "u-2"], "Please look");
    expect(review.reviewers.map((r) => r.verdict)).toEqual(["pending", "pending"]);
    const answered = await remote.answerReview({ ...rec, review }, "approved", "");
    expect(answered.state).toBe("approved");
  });
});
