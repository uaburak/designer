/**
 * Personal Drafts on the server (docs/cloud.md §2): `/me/drafts`, the file routes on a draft (rename, trash, restore,
 * delete forever), the 30-day purge, and moves between the owner's Drafts and an organization.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { P1, world, type World } from "../testing/orgWorld";
import { PERSONAL_TRASH_DAYS, purgePersonalTrash } from "./routes";

let w: World;
beforeEach(async () => {
  w = await world();
});

const DAY = 86_400_000;
const alice = () => w.people.alice.token;
const bob = () => w.people.bob.token;
const drafts = async (token: string, trashed = false) => (await w.call("GET", `/me/drafts${trashed ? "?trashed=1" : ""}`, token)).body.files as { key: string; name: string; trashedAt: number | null }[];

describe("personal drafts", () => {
  it("POST /me/drafts registers a draft (the same key again answers the same draft); GET lists the caller's own", async () => {
    const made = await w.call("POST", "/me/drafts", alice(), { key: "draftAlice01", name: "  Logo  " });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ key: "draftAlice01", name: "Logo", role: "owner", file: { key: "draftAlice01", name: "Logo", trashedAt: null, editorType: "design" } });
    // A lost answer, tried again: the same draft, not a conflict
    const again = await w.call("POST", "/me/drafts", alice(), { key: "draftAlice01", name: "Logo" });
    expect(again.status).toBe(200);
    expect(again.body.key).toBe("draftAlice01");
    // Someone else's key
    expect((await w.call("POST", "/me/drafts", bob(), { key: "draftAlice01" })).status).toBe(409);
    // Without a key the server makes one
    const own = await w.call("POST", "/me/drafts", bob(), {});
    expect(own.status).toBe(201);
    expect(own.body.name).toBe("Untitled");
    expect(own.body.key).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
    expect((await drafts(alice())).map((f) => f.key)).toEqual(["draftAlice01"]);
    expect((await drafts(bob())).map((f) => f.key)).toEqual([own.body.key]);
    expect(await w.rows(`SELECT space, org_id FROM files WHERE key = 'draftAlice01'`)).toEqual([{ space: "personal", org_id: null }]);
    // GET /files/:key says where it lives
    expect((await w.call("GET", "/files/draftAlice01", alice())).body).toMatchObject({ space: "personal", org: null, role: "owner" });
    // Branches and org files never list among Drafts (bob's org draft stays in the org)
    expect((await drafts(bob())).some((f) => f.key === "draft_bob01")).toBe(false);
  });

  it("a Social file is a draft of its own kind (docs/social.md §27): registered so, listed so, converted by PATCH", async () => {
    const made = await w.call("POST", "/me/drafts", alice(), { key: "draftSocial1", name: "Posts", editorType: "buzz" });
    expect(made.status).toBe(201);
    expect(made.body.file).toMatchObject({ editorType: "buzz" });
    expect((await w.call("POST", "/me/drafts", alice(), { key: "draftSlides1", editorType: "slides" })).status).toBe(400);
    // A Design draft converted (or one registered before drafts kept their kind)
    await w.call("POST", "/me/drafts", alice(), { key: "draftDesign1", name: "Old" });
    expect((await w.call("PATCH", "/files/draftDesign1", alice(), { editorType: "buzz" })).status).toBe(200);
    expect((await w.call("PATCH", "/files/draftDesign1", alice(), { editorType: "make" })).status).toBe(400);
    const listed = (await w.call("GET", "/me/drafts", alice())).body.files as { key: string; editorType: string }[];
    expect(Object.fromEntries(listed.map((f) => [f.key, f.editorType]))).toMatchObject({ draftSocial1: "buzz", draftDesign1: "buzz" });
  });

  it("a file shared outside any org (1.0.x's POST /files) is its owner's draft", async () => {
    expect((await w.call("POST", "/files", alice(), { key: "sharedOld01", name: "Old share" })).status).toBe(201);
    expect((await drafts(alice())).map((f) => f.name)).toEqual(["Old share"]);
  });

  it("rename, trash, restore and delete forever go through the file routes; only the owner trashes", async () => {
    await w.call("POST", "/me/drafts", alice(), { key: "draftAlice02", name: "Poster" });
    expect((await w.call("PATCH", "/files/draftAlice02", alice(), { name: "Poster v2" })).status).toBe(200);
    expect((await drafts(alice()))[0].name).toBe("Poster v2");
    // Bob, invited as an editor, can't trash her draft
    expect((await w.call("PUT", "/files/draftAlice02/members", alice(), { email: "bob@x.co", role: "editor" })).status).toBe(200);
    expect((await w.call("POST", "/files/draftAlice02/trash", bob())).status).toBe(403);
    w.now.t += 1000;
    expect((await w.call("POST", "/files/draftAlice02/trash", alice())).status).toBe(200);
    expect(await drafts(alice())).toEqual([]);
    expect((await drafts(alice(), true)).map((f) => [f.key, f.trashedAt])).toEqual([["draftAlice02", w.now.t]]);
    expect((await w.call("POST", "/files/draftAlice02/trash", alice())).status).toBe(409);
    expect((await w.call("POST", "/files/draftAlice02/restore", alice())).status).toBe(200);
    expect((await drafts(alice())).map((f) => f.key)).toEqual(["draftAlice02"]);
    expect((await w.call("DELETE", "/files/draftAlice02", alice())).status).toBe(200);
    expect(await drafts(alice())).toEqual([]);
    expect(await w.rows(`SELECT key FROM files WHERE key = 'draftAlice02'`)).toEqual([]);
    expect(w.rooms.some((r) => r.key === "draftAlice02" && r.path === "/room" && r.method === "DELETE")).toBe(true);
  });

  it("the daily cron deletes drafts trashed more than 30 days ago, nothing else", async () => {
    for (const k of ["draftOld0001", "draftNew0001", "draftLive001"]) await w.call("POST", "/me/drafts", alice(), { key: k, name: k });
    await w.call("POST", "/files/draftOld0001/trash", alice());
    w.now.t += 20 * DAY;
    await w.call("POST", "/files/draftNew0001/trash", alice());
    w.now.t += (PERSONAL_TRASH_DAYS - 20) * DAY + 1;
    expect(await purgePersonalTrash(w.deps)).toBe(1);
    expect((await w.rows(`SELECT key FROM files WHERE key LIKE 'draft%0001' OR key = 'draftLive001' ORDER BY key`)).map((r) => r.key)).toEqual(["draftLive001", "draftNew0001"]);
    expect(w.rooms.some((r) => r.key === "draftOld0001" && r.method === "DELETE")).toBe(true);
    // Org files in a trash keep their own rules (the org's)
    expect(await purgePersonalTrash(w.deps)).toBe(0);
  });

  it("PATCH /files/:key {space} moves a draft into an org folder, and an org draft back to the owner's Drafts", async () => {
    await w.call("POST", "/me/drafts", bob(), { key: "draftBob0002", name: "Icons" });
    // A folder bob can edit (T1 › P1)
    const into = await w.call("PATCH", "/files/draftBob0002", bob(), { space: { orgId: w.orgId, projectId: P1 } });
    expect(into.status, JSON.stringify(into.body)).toBe(200);
    expect(await w.rows(`SELECT org_id, project_id, space FROM files WHERE key = 'draftBob0002'`)).toEqual([{ org_id: w.orgId, project_id: P1, space: null }]);
    expect((await drafts(bob())).some((f) => f.key === "draftBob0002")).toBe(false);
    // Out of a folder: not directly
    expect((await w.call("PATCH", "/files/draftBob0002", bob(), { space: "personal" })).status).toBe(400);
    // Into his org drafts, then back to his personal Drafts
    expect((await w.call("POST", "/files/draftBob0002/move", bob(), { projectId: null })).status).toBe(200);
    // Only the owner (an org draft is private to its owner: the admin doesn't even see it)
    expect([403, 404]).toContain((await w.call("PATCH", "/files/draftBob0002", alice(), { space: "personal" })).status);
    const back = await w.call("PATCH", "/files/draftBob0002", bob(), { space: "personal" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await w.rows(`SELECT org_id, team_id, project_id, space FROM files WHERE key = 'draftBob0002'`)).toEqual([{ org_id: null, team_id: null, project_id: null, space: "personal" }]);
    expect((await drafts(bob())).map((f) => f.key)).toContain("draftBob0002");
    expect((await w.call("PATCH", "/files/draftBob0002", bob(), { space: "elsewhere" })).status).toBe(400);
  });

  it("signed out: 401; a personal access token: 403", async () => {
    expect((await w.call("GET", "/me/drafts")).status).toBe(401);
    const made = await w.call("POST", "/me/tokens", alice(), { description: "CI", expiresInDays: 30, scopes: ["file_content:read"] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await w.call("GET", "/me/drafts", made.body.token)).status).toBe(403);
  });
});
