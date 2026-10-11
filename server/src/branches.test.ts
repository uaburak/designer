import { beforeEach, describe, expect, it } from "vitest";
import { handle, type Deps } from "./api";
import { Db } from "./db";
import { AUTOSAVE_MAX_WAIT_MS, AUTOSAVE_MS, AUTOSAVE_QUIET_MS, autosaveAlarm, decodeEnvelope, encodeEnvelope, SESSION_BLOCK } from "./roomBox";
import { sqliteD1 } from "./testing/sqliteD1";
import { memoryRooms, type MemoryRooms } from "./testing/memoryRooms";

const ORIGIN = "https://designer.example.workers.dev";

let deps: Deps;
let mem: MemoryRooms;
let inbox: { userId: string; msg: Record<string, unknown> }[];
let now: number;

beforeEach(() => {
  now = Date.UTC(2026, 9, 11, 9);
  inbox = [];
  mem = memoryRooms(() => now);
  deps = {
    db: new Db(sqliteD1()),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1" },
    rooms: mem.rooms,
    inboxes: {
      async notify(userId, msg) {
        inbox.push({ userId, msg: msg as Record<string, unknown> });
      },
      async connect() {
        return new Response(null);
      },
    },
    now: () => now,
    fetch: async () => new Response("no", { status: 500 }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const raw = body instanceof Uint8Array;
  const res = await handle(
    new Request(ORIGIN + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
    }),
    deps,
  );
  const type = res.headers.get("content-type") ?? "";
  if (type.startsWith("application/octet-stream")) return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) as Any, headers: res.headers };
  const text = await res.text();
  let parsed: Any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // text
  }
  return { status: res.status, body: parsed as Any, headers: res.headers };
};

async function signIn(email: string) {
  return (await call("POST", "/auth/dev", undefined, { email, name: email.split("@")[0] })).body as { token: string; user: { id: string; email: string } };
}

const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

/** Alice's shared file with a snapshot at seq 0 and two edits by her; Bob invited as a viewer. */
async function sharedFile() {
  const alice = await signIn("alice@x.co");
  const bob = await signIn("bob@x.co");
  await call("POST", "/files", alice.token, { key: "main_00001", name: "Design system" });
  expect((await call("PUT", "/files/main_00001/snapshot?seq=0", alice.token, bytes("MAIN@0"))).status).toBe(200);
  await call("PUT", "/files/main_00001/members", alice.token, { email: "bob@x.co", role: "viewer" });
  const a = mem.join("main_00001", alice.user.id);
  mem.send("main_00001", a, bytes("main-edit-1"));
  mem.send("main_00001", a, bytes("main-edit-2"));
  return { alice, bob, a };
}

describe("the room's storage (roomBox.ts)", () => {
  it("keeps versions as a snapshot plus frames, serves them, compacts them, and autosaves after 30 minutes of edits", async () => {
    const { alice, a } = await sharedFile();
    // A named version at the head (seq 2): the snapshot at 0 and frames 1–2
    const v1 = (await call("POST", "/files/main_00001/versions", alice.token, { kind: "named", title: "Before tokens", description: "v1" })).body.version;
    expect(v1).toMatchObject({ kind: "named", title: "Before tokens", description: "v1", seq: 2, snapshotSeq: 0, user: { id: alice.user.id, name: "alice" } });
    const snap = await call("GET", `/files/main_00001/versions/${v1.id}/snapshot`, alice.token);
    expect([str(snap.body), snap.headers.get("x-seq"), snap.headers.get("x-snapshot-seq")]).toEqual(["MAIN@0", "2", "0"]);
    const frames = await call("GET", `/files/main_00001/versions/${v1.id}/frames`, alice.token);
    expect(unpack(frames.body).map((f) => [f.seq, str(f.message)])).toEqual([[1, "main-edit-1"], [2, "main-edit-2"]]);
    // The room's snapshot moves on and old frames go: the version still has what it needs
    mem.send("main_00001", a, bytes("main-edit-3"));
    await call("PUT", "/files/main_00001/snapshot?seq=3", alice.token, bytes("MAIN@3"));
    expect(str((await call("GET", `/files/main_00001/versions/${v1.id}/snapshot`, alice.token)).body)).toBe("MAIN@0");
    // A version older than the room's snapshot can't be made; seq in range can
    expect((await call("POST", "/files/main_00001/versions", alice.token, { kind: "named", seq: 1 })).status).toBe(409);
    // The client's own snapshot of v1 replaces its frames; nothing else needs snapshot 0 any more
    const put = await call("PUT", `/files/main_00001/versions/${v1.id}/snapshot`, alice.token, bytes("MAIN@2"));
    expect(put.body.version).toMatchObject({ seq: 2, snapshotSeq: 2, sizeBytes: 6 });
    expect(unpack((await call("GET", `/files/main_00001/versions/${v1.id}/frames`, alice.token)).body)).toEqual([]);
    const sql = mem.get("main_00001").box as Any;
    expect(sql.host.sql.exec(`SELECT DISTINCT seq FROM history_snapshots ORDER BY seq`).toArray()).toEqual([{ seq: 2 }]);
    // Naming an autosave makes it named; restore records where it came from; clients can't write branch kinds
    const auto = (await call("POST", "/files/main_00001/versions", alice.token, { kind: "autosave" })).body.version;
    expect((await call("PATCH", `/files/main_00001/versions/${auto.id}`, alice.token, { title: "Named later" })).body.version).toMatchObject({ kind: "named", title: "Named later" });
    expect((await call("POST", "/files/main_00001/versions", alice.token, { kind: "restore", restoredFrom: v1.id })).body.version).toMatchObject({ kind: "restore", restoredFrom: v1.id });
    expect((await call("POST", "/files/main_00001/versions", alice.token, { kind: "merge" })).status).toBe(400);
    expect((await call("GET", "/files/main_00001/versions", alice.token)).body.versions.map((v: Any) => v.kind)).toEqual(["restore", "named", "named"]);

    // Autosave: the clock restarted with the last version; 30 minutes later an edit sets the alarm 2 s out
    const room = mem.get("main_00001");
    now += 10 * 60_000;
    mem.send("main_00001", a, bytes("e4"));
    expect(room.alarm).toBeNull();
    now += AUTOSAVE_MS;
    mem.send("main_00001", a, bytes("e5"));
    expect(room.alarm).toBe(now + AUTOSAVE_QUIET_MS);
    room.box.alarm();
    const versions = (await call("GET", "/files/main_00001/versions", alice.token)).body.versions;
    expect(versions[0]).toMatchObject({ kind: "autosave", seq: 5, user: { id: null } });
    // Nothing new: the alarm takes nothing
    room.box.alarm();
    expect((await call("GET", "/files/main_00001/versions", alice.token)).body.versions).toHaveLength(versions.length);
  });

  it("autosave waits for a quiet room, 60 s at most once due", () => {
    expect(autosaveAlarm({ lastVersionAt: 0, dueSince: -1 }, AUTOSAVE_MS - 1)).toBeNull();
    expect(autosaveAlarm({ lastVersionAt: 0, dueSince: -1 }, AUTOSAVE_MS)).toBe(AUTOSAVE_MS + AUTOSAVE_QUIET_MS);
    expect(autosaveAlarm({ lastVersionAt: 0, dueSince: AUTOSAVE_MS }, AUTOSAVE_MS + AUTOSAVE_MAX_WAIT_MS - 1)).toBe(AUTOSAVE_MS + AUTOSAVE_MAX_WAIT_MS);
    const env = decodeEnvelope(encodeEnvelope({ mainSeq: 3 }, bytes("batch")));
    expect([env?.meta, str(env!.message)]).toEqual([{ mainSeq: 3 }, "batch"]);
    expect(decodeEnvelope(new Uint8Array([0, 0, 0, 9, 1]))).toBeNull();
  });
});

describe("branches (docs/data.md §15.7)", () => {
  it("creates a branch, updates it from main and merges it back as one frame, with versions and the stale-head check", async () => {
    const { alice, bob, a } = await sharedFile();
    const carol = await signIn("carol@x.co");
    // Bob, a viewer of main, sees no branch yet; a third person can't list them
    expect((await call("GET", "/files/main_00001/branches", bob.token)).body.branches).toEqual([]);
    expect((await call("GET", "/files/main_00001/branches", carol.token)).status).toBe(404);

    // Create branch…: main's session counter jumps a block (Alice's socket was session 1)
    const created = await call("POST", "/files/main_00001/branches", alice.token, { branchKey: "brch_00001", name: "Tokens v2", baseSeq: 2 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ sessionBase: 1, branch: { branchKey: "brch_00001", mainKey: "main_00001", name: "Tokens v2", status: "active", baseSeq: 2, mainSeenSeq: 2, sessionBase: 1, createdBy: { id: alice.user.id, name: "alice" }, review: null } });
    expect(mem.join("main_00001", alice.user.id).sessionID).toBe(1 + SESSION_BLOCK + 1);
    // The branch room: snapshot at 0 is "Branch created"; its sessions start in the block; the base is main at 2
    const up = await call("PUT", "/files/brch_00001/snapshot?seq=0", alice.token, bytes("MAIN@2"));
    expect(up.body.versionId).toMatch(/^[0-9A-Za-z]{16}$/);
    expect((await call("PUT", "/branches/brch_00001/base?seq=2", alice.token, bytes("MAIN@2"))).body).toMatchObject({ staged: false });
    const ab = mem.join("brch_00001", alice.user.id);
    expect(ab.sessionID).toBe(2);
    expect((await call("GET", "/files/brch_00001/versions", alice.token)).body.versions.map((v: Any) => v.kind)).toEqual(["branch"]);
    expect((await call("GET", "/files/main_00001/versions", alice.token)).body.versions).toMatchObject([{ kind: "branch", title: "Tokens v2", seq: 2 }]);
    expect(str((await call("GET", "/branches/brch_00001/base", bob.token)).body)).toBe("MAIN@2");

    // Access goes through main: Bob (viewer) opens it read-only; the branch isn't a file of its own in listings
    expect((await call("GET", "/files/brch_00001", bob.token)).body).toMatchObject({ role: "viewer", branch: { mainKey: "main_00001", mainName: "Design system", name: "Tokens v2", status: "active" } });
    expect((await call("GET", "/files/brch_00001", carol.token)).status).toBe(404);
    expect((await call("GET", "/files", alice.token)).body.files.map((f: Any) => f.key)).toEqual(["main_00001"]);
    expect((await call("GET", "/files/main_00001/branches?tab=yours", alice.token)).body.branches.map((b: Any) => b.branchKey)).toEqual(["brch_00001"]);
    expect((await call("GET", "/files/brch_00001/branches", alice.token)).status).toBe(400);
    expect((await call("POST", "/files/brch_00001/branches", alice.token, { branchKey: "brch_00002", name: "x", baseSeq: 0 })).body.error).toBe("a branch can't be branched");
    expect((await call("POST", "/files/brch_00001/versions", alice.token, { kind: "publish" })).body.code).toBe("branch_cannot_publish");

    // Both sides edit; the notice
    mem.send("brch_00001", ab, bytes("branch-edit-1"));
    mem.send("main_00001", a, bytes("main-edit-3"));
    expect((await call("GET", "/branches/brch_00001/main", bob.token)).body).toEqual({ changed: true, mainHeadSeq: 3, baseSeq: 2, mainSeenSeq: 2 });
    expect((await call("POST", "/branches/brch_00001/seen", bob.token, { mainSeq: 3 })).body.branch.mainSeenSeq).toBe(3);

    // Update from main: Bob can't; a moved head is stale; the base must be staged first
    const upd = (meta: Any, batch = "update-batch") => encodeEnvelope(meta, bytes(batch));
    expect((await call("POST", "/branches/brch_00001/update", bob.token, upd({ mainSeq: 3, branchSeq: 1 }))).status).toBe(403);
    expect((await call("POST", "/branches/brch_00001/update", alice.token, upd({ mainSeq: 2, branchSeq: 1 }))).body).toMatchObject({ code: "stale", mainHeadSeq: 3 });
    expect((await call("POST", "/branches/brch_00001/update", alice.token, upd({ mainSeq: 3, branchSeq: 1 }))).body.code).toBe("conflict");
    expect((await call("PUT", "/branches/brch_00001/base?seq=3", alice.token, bytes("MAIN@3"))).body).toMatchObject({ staged: true });
    expect((await call("POST", "/branches/brch_00001/update", alice.token, upd({ mainSeq: 3, branchSeq: 0 }))).body.code).toBe("stale");
    const updated = await call("POST", "/branches/brch_00001/update", alice.token, upd({ mainSeq: 3, branchSeq: 1, sessionID: ab.sessionID, batch: 7 }));
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ seq: 2, branch: { baseSeq: 3, mainSeenSeq: 3 } });
    // Ordered like any frame: the branch's member got it as its own session's batch 7
    expect(ab.frames.at(-1)).toMatchObject({ seq: 2, sessionID: ab.sessionID, batch: 7 });
    expect(str(ab.frames.at(-1)!.message)).toBe("update-batch");
    expect(str((await call("GET", "/branches/brch_00001/base", alice.token)).body)).toBe("MAIN@3");
    expect((await call("GET", "/files/brch_00001/versions", alice.token)).body.versions.map((v: Any) => v.kind)).toEqual(["update", "branch"]);

    // Review: Alice asks Bob; Bob suggests changes; asked again; Bob approves
    expect((await call("POST", "/branches/brch_00001/reviews", alice.token, { reviewerIds: [carol.user.id], description: "x" })).status).toBe(400);
    const review = (await call("POST", "/branches/brch_00001/reviews", alice.token, { reviewerIds: [bob.user.id], description: "New tokens" })).body.review;
    expect(review).toMatchObject({ state: "in-review", requestedBy: alice.user.id, description: "New tokens", reviewers: [{ userId: bob.user.id, verdict: "pending" }] });
    expect(inbox.filter((i) => i.userId === bob.user.id).map((i) => (i.msg.item as Any)?.kind)).toContain("branch_review_request");
    expect((await call("POST", `/branches/brch_00001/reviews/${review.id}/verdict`, alice.token, { verdict: "approved" })).status).toBe(403);
    expect((await call("POST", `/branches/brch_00001/reviews/${review.id}/verdict`, bob.token, { verdict: "changes-suggested", comment: "Rename it" })).body.review).toMatchObject({ state: "changes-suggested", reviewers: [{ verdict: "changes-suggested", comment: "Rename it" }] });
    const told = inbox.filter((i) => i.userId === alice.user.id).map((i) => i.msg.item as Any).filter(Boolean);
    expect(told.at(-1)).toMatchObject({ kind: "branch_review", state: "changes-suggested", text: "Rename it", fileKey: "brch_00001" });
    const again = (await call("POST", "/branches/brch_00001/reviews", alice.token, { reviewerIds: [bob.user.id], description: "Renamed" })).body.review;
    expect(again).toMatchObject({ id: review.id, state: "in-review", reviewers: [{ verdict: "pending" }] });
    expect((await call("POST", `/branches/brch_00001/reviews/${review.id}/verdict`, bob.token, { verdict: "approved" })).body.review.state).toBe("approved");
    expect((await call("GET", "/branches/brch_00001", bob.token)).body.branch.review).toMatchObject({ state: "approved" });

    // Merge: Bob (approved, but a viewer of main) can't; a moved head on either side is stale (and the branch thaws)
    const mrg = (meta: Any) => encodeEnvelope(meta, bytes("merge-batch"));
    expect((await call("POST", "/branches/brch_00001/merge", bob.token, mrg({ mainSeq: 3, branchSeq: 2 }))).status).toBe(403);
    expect((await call("POST", "/branches/brch_00001/merge", alice.token, mrg({ mainSeq: 3, branchSeq: 1 }))).body.code).toBe("stale");
    expect((await call("POST", "/branches/brch_00001/merge", alice.token, mrg({ mainSeq: 2, branchSeq: 2 }))).body.code).toBe("stale");
    expect(mem.get("brch_00001").box.frozen()).toBe(false);
    const watcher = mem.join("main_00001", bob.user.id, "viewer");
    const merged = await call("POST", "/branches/brch_00001/merge", alice.token, mrg({ mainSeq: 3, branchSeq: 2, title: "Tokens v2", description: "Merged after review" }));
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({ mainSeq: 4, branch: { status: "merged", mergedBy: alice.user.id, mergeVersionId: merged.body.versionId } });
    // The third client got it as a remote frame (session 0: Alice named no session)
    expect(watcher.frames.at(-1)).toMatchObject({ seq: 4, sessionID: 0 });
    expect(str(watcher.frames.at(-1)!.message)).toBe("merge-batch");
    const mainVersions = (await call("GET", "/files/main_00001/versions", alice.token)).body.versions;
    expect(mainVersions.map((v: Any) => [v.kind, v.seq, v.title])).toEqual([["merge", 4, "Tokens v2"], ["autosave", 3, null], ["branch", 2, "Tokens v2"]]);
    expect(merged.body.preVersionId).toBe(mainVersions[1].id);
    expect((await call("GET", "/files/brch_00001/versions", alice.token)).body.versions[0]).toMatchObject({ kind: "merge", id: merged.body.branchVersionId });
    // The branch is read-only now: frozen, its people reconnected as viewers, the creator too
    expect(mem.get("brch_00001").box.frozen()).toBe(true);
    expect(ab.closed).toBe(4003);
    expect((await call("GET", "/files/brch_00001", alice.token)).body.role).toBe("viewer");
    expect((await call("PUT", "/files/brch_00001/snapshot?seq=2", alice.token, bytes("x"))).status).toBe(403);
    // Bob is told it merged; merged branches are Archived and can't be restored
    expect(inbox.filter((i) => i.userId === bob.user.id).map((i) => (i.msg.item as Any)?.kind)).toContain("branch_merged");
    expect((await call("GET", "/files/main_00001/branches?tab=archived", bob.token)).body.branches.map((b: Any) => b.status)).toEqual(["merged"]);
    expect((await call("PATCH", "/branches/brch_00001", alice.token, { status: "active" })).status).toBe(400);
    expect((await call("POST", "/branches/brch_00001/merge", alice.token, mrg({ mainSeq: 4, branchSeq: 2 }))).status).toBe(409);
  });

  it("archives, restores, renames and deletes; viewers branch only when they may copy; the creator edits their branch", async () => {
    const { alice, bob } = await sharedFile();
    await call("PATCH", "/files/main_00001", alice.token, { viewersCanCopy: false });
    expect((await call("POST", "/files/main_00001/branches", bob.token, { branchKey: "brch_bob001", name: "Bob's", baseSeq: 2 })).status).toBe(403);
    await call("PATCH", "/files/main_00001", alice.token, { viewersCanCopy: true });
    const r = await call("POST", "/files/main_00001/branches", bob.token, { branchKey: "brch_bob001", name: "Bob's", baseSeq: 2 });
    expect(r.status).toBe(201);
    // Bob views main but edits his branch
    expect((await call("GET", "/files/brch_bob001", bob.token)).body).toMatchObject({ role: "editor", access: { canEdit: true, canShare: false } });
    expect((await call("PUT", "/files/brch_bob001/snapshot?seq=0", bob.token, bytes("MAIN@2"))).status).toBe(200);
    expect((await call("POST", "/branches/brch_bob001/merge", bob.token, encodeEnvelope({ mainSeq: 2, branchSeq: 0 }, bytes("m")))).status).toBe(403);
    // Rename, archive (read-only, reconnected), restore — by the creator; then delete forever once archived
    const m = mem.join("brch_bob001", bob.user.id);
    expect((await call("PATCH", "/branches/brch_bob001", bob.token, { name: "Bob's tokens" })).body.branch.name).toBe("Bob's tokens");
    expect((await call("DELETE", "/branches/brch_bob001", bob.token)).status).toBe(409);
    expect((await call("PATCH", "/branches/brch_bob001", bob.token, { status: "archived" })).body.branch).toMatchObject({ status: "archived", archivedBy: bob.user.id });
    expect(m.closed).toBe(4003);
    expect((await call("GET", "/files/brch_bob001", bob.token)).body.role).toBe("viewer");
    expect((await call("GET", "/files/main_00001/branches", alice.token)).body.branches).toEqual([]);
    expect((await call("PATCH", "/branches/brch_bob001", bob.token, { status: "active" })).body.branch.status).toBe("active");
    await call("PATCH", "/branches/brch_bob001", alice.token, { status: "archived" });
    expect((await call("DELETE", "/branches/brch_bob001", alice.token)).status).toBe(204);
    expect((await call("GET", "/branches/brch_bob001", alice.token)).status).toBe(404);
    expect((await call("GET", "/files/brch_bob001", alice.token)).status).toBe(404);
    // Deleting main takes its branches
    await call("POST", "/files/main_00001/branches", alice.token, { branchKey: "brch_00009", name: "Later", baseSeq: 2 });
    expect((await call("DELETE", "/files/main_00001", alice.token)).status).toBe(200);
    expect(await deps.db.d1.prepare(`SELECT key FROM files`).all()).toEqual({ results: [] });
  });

  it("in an organization: needs a Full seat, logs the repo's events, invites to a branch give main", async () => {
    const alice = await signIn("alice@x.co");
    const bob = await signIn("bob@x.co");
    const org = (await call("POST", "/orgs", alice.token, { name: "Acme" })).body.org;
    await call("POST", `/orgs/${org.id}/admin/people`, alice.token, { emails: ["bob@x.co"], role: "member" });
    const team = (await call("POST", `/orgs/${org.id}/teams`, alice.token, { name: "Design" })).body.team;
    const folder = (await call("POST", `/teams/${team.id}/projects`, alice.token, { name: "Web" })).body.project;
    await call("POST", `/projects/${folder.id}/files`, alice.token, { key: "file_web001", name: "Home" });
    await call("PUT", "/files/file_web001/snapshot?seq=0", alice.token, bytes("HOME@0"));
    // Bob on a View seat, invited to edit: capped, and can't branch
    await call("PUT", "/files/file_web001/members", alice.token, { email: "bob@x.co", role: "editor" });
    expect((await call("POST", "/files/file_web001/branches", bob.token, { branchKey: "brch_web001", name: "B", baseSeq: 0 })).body).toMatchObject({ code: "seat_required", seat: "full" });
    const made = await call("POST", "/files/file_web001/branches", alice.token, { branchKey: "brch_web001", name: "Hero", baseSeq: 0 });
    expect(made.status).toBe(201);
    // The branch sits with main (same folder) but isn't listed as a file
    expect(await deps.db.d1.prepare(`SELECT project_id FROM files WHERE key = 'brch_web001'`).first()).toEqual({ project_id: folder.id });
    expect((await call("GET", `/projects/${folder.id}/files`, alice.token)).body.files.map((f: Any) => f.key)).toEqual(["file_web001"]);
    // Home's tile counts main's active branches (round 2d)
    expect((await call("GET", `/projects/${folder.id}/files`, alice.token)).body.files[0].branchCount).toBe(1);
    // Inviting Carol (an org member) to the branch writes main's grant too
    const carol = await signIn("carol@x.co");
    await call("POST", `/orgs/${org.id}/admin/people`, alice.token, { emails: ["carol@x.co"], role: "member" });
    expect((await call("PUT", "/files/brch_web001/members", alice.token, { email: "carol@x.co", role: "viewer" })).status).toBe(200);
    expect((await call("GET", "/files/file_web001", carol.token)).body.role).toBe("viewer");
    expect((await call("PUT", "/files/brch_web001/members", alice.token, { email: "out@else.co", role: "viewer" })).status).toBe(400);
    await call("PUT", "/files/brch_web001/snapshot?seq=0", alice.token, bytes("HOME@0"));
    await call("PUT", "/branches/brch_web001/base?seq=0", alice.token, bytes("HOME@0"));
    await call("PATCH", "/branches/brch_web001", alice.token, { status: "archived" });
    await call("PATCH", "/branches/brch_web001", alice.token, { status: "active" });
    await call("POST", "/branches/brch_web001/merge", alice.token, encodeEnvelope({ mainSeq: 0, branchSeq: 0 }, bytes("m")));
    const logs = (await call("GET", `/orgs/${org.id}/admin/activity?events=branch_create,branch_member_add,branch_archive,branch_unarchive,repo_merge_to_source&order=asc`, alice.token)).body.activity_logs;
    expect(logs.map((l: Any) => l.action.type)).toEqual(["branch_create", "branch_member_add", "branch_archive", "branch_unarchive", "repo_merge_to_source"]);
    expect(logs[0].entity).toMatchObject({ type: "file_repo", id: "file_web001", name: "Home", main_file_key: "file_web001" });
    expect(logs[0].action.details).toMatchObject({ branch_key: "brch_web001", branch_name: "Hero" });
  });
});

/** GET …/frames' body: [u32 length][changes-down frame]… */
function unpack(b: Uint8Array) {
  const out: { seq: number; message: Uint8Array }[] = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let at = 0; at < b.length; ) {
    const n = v.getUint32(at);
    const f = b.subarray(at + 4, at + 4 + n);
    const fv = new DataView(f.buffer, f.byteOffset, f.byteLength);
    out.push({ seq: fv.getUint32(1), message: f.subarray(13) });
    at += 4 + n;
  }
  return out;
}
