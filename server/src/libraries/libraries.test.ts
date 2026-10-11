import { beforeEach, describe, expect, it } from "vitest";
import { readPayloads } from "./libraryBox";
import { tableCount } from "../testing/memoryLibraries";
import { assetKey, BRAND, DRAFT, LIB, manifestOf, P1, publish, SECRET, sha1, T1, T2, W1, WEB, world, type Any, type TestAsset, type World } from "../testing/orgWorld";

let w: World;
beforeEach(async () => {
  w = await world();
});

const BUTTON: TestAsset = { key: assetKey("Button"), kind: "COMPONENT", name: "Button", seed: "button v1", thumb: new Uint8Array([1, 2, 3]) };
const COLOR: TestAsset = { key: assetKey("Color/Primary"), kind: "VARIABLE", name: "Color/Primary", seed: "color v1", dependencyOnly: true, collectionKey: assetKey("Colors") };
const CARD: TestAsset = { key: assetKey("Card"), kind: "COMPONENT", name: "Card", seed: "card v1", dependencies: [COLOR.key] };
const COLORS: TestAsset = { key: assetKey("Colors"), kind: "VARIABLE_COLLECTION", name: "Colors", seed: "colors v1" };
const COLLECTIONS = [{ collectionKey: COLORS.key, name: "Colors", modes: [{ id: "1:0", name: "Light" }, { id: "1:1", name: "Dark" }] }];

const get = (path: string, who: keyof World["people"]) => w.call("GET", path, w.people[who].token);
const libraryMsgs = (userId: string) => w.inbox.filter((m) => m.userId === userId && m.msg.t === "library").map((m) => m.msg);

describe("publishing (§16.6)", () => {
  it("publishes, refuses a stale base, dedupes payloads, and checks what the manifest names", async () => {
    const a = w.people.alice.token;
    const first = await publish(w, LIB, a, [BUTTON, CARD, COLOR], { description: "First" });
    expect(first.status).toBe(201);
    expect(first.body.version).toMatchObject({ version: 1, libraryFileKey: LIB, description: "First" });
    expect(first.body.library).toMatchObject({ libraryFileKey: LIB, status: "published", latestVersion: 1, counts: { components: 2, styles: 0, variables: 0 }, org: { teamId: T1, teamName: "Design", workspaceId: W1, scope: "team", name: "Design System", via: ["file", "team"] } });
    expect(first.missing.payloads).toHaveLength(3);
    expect(await w.rows(`SELECT version, changes FROM library_versions WHERE library_key = ?1`, LIB)).toEqual([{ version: 1, changes: JSON.stringify({ created: 3, modified: 0, removed: 0, moved: 0 }) }]);
    expect((await w.rows(`SELECT name, dependency_only FROM library_assets WHERE library_key = ?1 ORDER BY name`, LIB)).map((r) => [r.name, r.dependency_only])).toEqual([["Button", 0], ["Card", 0], ["Color/Primary", 1]]);
    // A version history checkpoint in the room (§15.7.1)
    expect(w.rooms.find((r) => r.path === "/room/versions")?.body).toEqual({ kind: "publish", title: "First", libraryVersion: 1 });

    // Someone published meanwhile: 409 conflict, nothing written
    const BUTTON2 = { ...BUTTON, seed: "button v2" };
    const stale = await publish(w, LIB, a, [BUTTON2, CARD, COLOR], { baseVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "conflict", latest: 1 });
    // Only the changed payload was missing (content-addressed); after the refused commit it is stored all the same
    expect(stale.missing.payloads.map((p: Any) => p.key)).toEqual([BUTTON.key]);
    expect(stale.missing.blobs).toEqual([]);
    const second = await publish(w, LIB, a, [BUTTON2, CARD], { baseVersion: 1 });
    expect(second.missing.payloads).toEqual([]);
    expect(second.status).toBe(201);
    expect(second.body.version.version).toBe(2);
    expect((await w.rows(`SELECT key, removed_in FROM library_assets WHERE library_key = ?1 AND removed_in IS NOT NULL`, LIB)).map((r) => r.key)).toEqual([COLOR.key]);

    // A payload the manifest names but nobody uploaded: 400 invalid naming it
    const LOGO: TestAsset = { key: assetKey("Logo"), kind: "COMPONENT", name: "Logo", seed: "logo" };
    const bad = await publish(w, LIB, a, [BUTTON2, LOGO], { baseVersion: 2, skipUpload: [LOGO.key] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid");
    expect(bad.body.missing[0]).toContain(LOGO.key);
    // Not a container
    expect((await w.call("PUT", `/libraries/${LIB}/payloads/${LOGO.key}/${sha1("x")}`, a, new Uint8Array(20))).status).toBe(400);
    // A blob must match its SHA-1
    expect((await w.call("PUT", `/libraries/${LIB}/blobs/${sha1("other")}`, a, new Uint8Array([9]))).status).toBe(400);
  });

  it("drafts, branches, viewers and seats can't publish", async () => {
    await w.run(`UPDATE files SET owner_id = ?2 WHERE key = ?1`, DRAFT, w.people.bob.id);
    expect((await publish(w, DRAFT, w.people.bob.token, [BUTTON])).body.code).toBe("draft_cannot_publish");
    await w.run(`INSERT INTO files (key, owner_id, name, created_at, updated_at, org_id, team_id, project_id) VALUES ('branch_lib1', ?1, 'B', 0, 0, ?2, ?3, ?4)`, w.people.alice.id, w.orgId, T1, P1);
    await w.run(`INSERT INTO branches (key, main_key, name, created_by, created_at, base_seq, main_seen_seq, session_base) VALUES ('branch_lib1', ?1, 'B', ?2, 0, 0, 0, 0)`, LIB, w.people.alice.id);
    expect((await publish(w, "branch_lib1", w.people.alice.token, [BUTTON])).body.code).toBe("branch_cannot_publish");
    // Dan (View seat) can only view; Gus (guest, viewer)
    await w.run(`INSERT INTO team_members (team_id, email, user_id, role, created_at) VALUES (?1, 'dan@x.co', ?2, 'editor', 0)`, T1, w.people.dan.id);
    expect((await publish(w, LIB, w.people.dan.token, [BUTTON])).body.code).toBe("seat_required");
    expect((await publish(w, LIB, w.people.gus.token, [BUTTON])).status).toBe(403);
    expect(await w.rows(`SELECT * FROM libraries`)).toEqual([]);
  });
});

describe("consuming: versions, diff, payloads with dependencies", () => {
  it("serves manifests, diffs copies and sends dependencies with what was asked", async () => {
    await publish(w, LIB, w.people.alice.token, [BUTTON, CARD, COLOR]);
    const bob = w.people.bob.token;
    const latest = await w.call("GET", `/libraries/${LIB}/versions/latest`, bob);
    expect(latest.body.assets.map((x: Any) => x.name)).toEqual(["Button", "Card", "Color/Primary"]);
    expect((await w.call("GET", `/libraries/${LIB}/versions/1`, bob)).body.version).toBe(1);
    expect((await w.call("GET", `/libraries/${LIB}/versions/7`, bob)).status).toBe(404);

    const p = await w.call("POST", `/libraries/${LIB}/payloads`, bob, { wants: [{ key: CARD.key, versionHash: sha1(Buffer.from([...new TextEncoder().encode("fig-kiwi"), 1, 0, 0, 0, ...new TextEncoder().encode("card v1")])) }], withDependencies: true });
    expect(p.headers.get("content-type")).toBe("application/octet-stream");
    const got = readPayloads(p.bytes);
    expect(got.map((g) => g.key)).toEqual([CARD.key, COLOR.key]);
    expect(new TextDecoder().decode(got[1].bytes)).toContain("color v1");
    const without = readPayloads((await w.call("POST", `/libraries/${LIB}/payloads`, bob, { wants: [{ key: CARD.key, versionHash: manifestOf([CARD])[0].versionHash }] })).bytes);
    expect(without.map((g) => g.key)).toEqual([CARD.key]);

    const thumb = await w.call("GET", `/libraries/${LIB}/blobs/${sha1(BUTTON.thumb!)}`, bob);
    expect([...thumb.bytes]).toEqual([1, 2, 3]);
    expect(thumb.headers.get("cache-control")).toContain("immutable");

    await publish(w, LIB, w.people.alice.token, [{ ...BUTTON, seed: "button v2" }, CARD, COLOR], { baseVersion: 1 });
    const have = manifestOf([BUTTON, CARD]).map((a) => ({ key: a.key, versionHash: a.versionHash }));
    const diff = await w.call("POST", `/libraries/${LIB}/diff`, bob, { have: [...have, { key: assetKey("Gone"), versionHash: sha1("g") }] });
    expect(diff.body).toMatchObject({ latestVersion: 2, removed: [assetKey("Gone")] });
    expect(diff.body.updated.map((a: Any) => a.key)).toEqual([BUTTON.key]);

    // Move to this file (§9.5): another library takes Card; the old one's consumers see it moved.
    await w.run(`UPDATE files SET team_id = ?2, project_id = ?3 WHERE key = ?1`, SECRET, T1, P1);
    const moved = await publish(w, SECRET, w.people.alice.token, [{ ...CARD, key: assetKey("Card2") }, COLOR], { moves: [{ key: assetKey("Card2"), fromLibraryFileKey: LIB, fromKey: CARD.key, mode: "move" }] });
    expect(moved.status).toBe(201);
    expect(moved.body.library.movedIn).toMatchObject([{ fromLibraryFileKey: LIB, fromKey: CARD.key, toLibraryFileKey: SECRET, toKey: assetKey("Card2"), version: 1 }]);
    const after = await w.call("POST", `/libraries/${LIB}/diff`, bob, { have });
    expect(after.body.moved).toMatchObject([{ fromKey: CARD.key, toLibraryFileKey: SECRET }]);
  });
});

describe("who can use a library (§16.4)", () => {
  it("file viewers (guests too), direct team members, and org members once published to the org", async () => {
    await publish(w, LIB, w.people.alice.token, [BUTTON]);
    const via = async (who: keyof World["people"]) => {
      const r = await get(`/libraries/${LIB}`, who);
      return r.status === 200 ? r.body.library.org.via : r.status;
    };
    expect(await via("bob")).toEqual(["file", "team"]); // the team's files are open to its members
    expect(await via("gus")).toEqual(["file"]); // a guest invited to the file
    expect(await via("carol")).toBe(404); // another team
    expect(await via("dan")).toBe(404);
    expect(await via("olga")).toBe(404); // not in the org

    // "Allow any member of Acme to access the file"
    const patched = await w.call("PATCH", `/libraries/${LIB}`, w.people.alice.token, { scope: "org" });
    expect(patched.body.library.scope).toBe("org");
    expect((await w.rows(`SELECT org_link_access FROM files WHERE key = ?1`, LIB))[0].org_link_access).toBe("viewer");
    expect(await via("carol")).toEqual(["org"]); // rule 1 doesn't count the link
    expect(await via("dan")).toEqual(["org"]);
    expect(await via("gus")).toEqual(["file"]); // guests only through the file
    // Carol can't change who uses it (she can only view)
    expect((await w.call("PATCH", `/libraries/${LIB}`, w.people.carol.token, { scope: "team" })).status).toBe(403);
  });

  it("a library in a Limited folder: the people invited to it and the team's members", async () => {
    await publish(w, SECRET, w.people.alice.token, [BUTTON]);
    expect((await get(`/libraries/${SECRET}`, "fay")).body.library.org.via).toEqual(["file"]);
    expect((await get(`/libraries/${SECRET}`, "bob")).body.library.org.via).toContain("team");
    expect((await get(`/libraries/${SECRET}`, "dan")).status).toBe(404);
    expect((await get(`/libraries/${SECRET}`, "carol")).status).toBe(404);
  });

  it("lists the libraries usable in a file of the same org, not the file itself", async () => {
    await publish(w, LIB, w.people.alice.token, [BUTTON], { scope: "org" });
    await publish(w, SECRET, w.people.alice.token, [CARD]);
    const forWeb = await get(`/libraries?file=${WEB}`, "carol");
    expect(forWeb.body.libraries.map((l: Any) => l.libraryFileKey)).toEqual([LIB]);
    const forLib = await get(`/libraries?file=${LIB}`, "alice");
    expect(forLib.body.libraries.map((l: Any) => l.libraryFileKey)).toEqual([SECRET]);
    // A file outside any org lists none (Figma's rule, §16.2)
    await w.call("POST", "/files", w.people.carol.token, { key: "local_file1", name: "Mine" });
    expect((await get(`/libraries?file=local_file1`, "carol")).body.libraries).toEqual([]);
  });
});

describe("scope follows the org link (§16.2)", () => {
  it("publishing with the checkbox sets the link; the link set back drops the library to its team", async () => {
    await publish(w, LIB, w.people.alice.token, [BUTTON], { scope: "org" });
    expect((await w.rows(`SELECT scope FROM libraries`))[0].scope).toBe("org");
    expect((await w.rows(`SELECT action FROM activity_log WHERE action = 'fig_file_link_access_change'`)).length).toBe(1);
    w.inbox.length = 0;
    expect((await w.call("PATCH", `/files/${LIB}`, w.people.alice.token, { orgLinkAccess: "none" })).status).toBe(200);
    expect((await w.rows(`SELECT scope FROM libraries`))[0].scope).toBe("team");
    // The org's members drop their cached lists
    expect(w.inbox.some((m) => m.userId === w.people.dan.id && m.msg.t === "org" && m.msg.what === "libraries")).toBe(true);
    // Unchecking the box when publishing sets the link back too
    await w.call("PATCH", `/files/${LIB}`, w.people.alice.token, { orgLinkAccess: "viewer" });
    expect((await publish(w, LIB, w.people.bob.token, [BUTTON], { baseVersion: 1, scope: "team" })).body.library.org.scope).toBe("team");
    expect((await w.rows(`SELECT org_link_access FROM files WHERE key = ?1`, LIB))[0].org_link_access).toBe("none");
    // No scope (PublishRequest.scope is optional): the link decides
    await w.call("PATCH", `/files/${LIB}`, w.people.alice.token, { orgLinkAccess: "editor" });
    expect((await publish(w, LIB, w.people.bob.token, [BUTTON], { baseVersion: 2 })).body.library.org.scope).toBe("org");
  });
});

describe("approved, enabled by default, default modes (§16.5)", () => {
  const put = (who: keyof World["people"], key: string, input: unknown) => w.call("PUT", `/orgs/${w.orgId}/libraries/${key}/settings`, w.people[who].token, input);
  const inWeb = async () => (await get(`/libraries?file=${WEB}`, "carol")).body.libraries.find((l: Any) => l.libraryFileKey === LIB)?.org;

  it("resolves team over workspace over org, per file type, with approvals and drafts", async () => {
    await publish(w, LIB, w.people.alice.token, [BUTTON, COLORS], { scope: "org", collections: COLLECTIONS });
    expect(await inWeb()).toMatchObject({ approved: null, enabledByDefault: false, defaultModes: [] });

    expect((await put("alice", LIB, { scope: { type: "org", id: w.orgId }, approved: true, defaults: { design: true } })).status).toBe(200);
    expect(await inWeb()).toMatchObject({ approved: "org", enabledByDefault: true });
    // A FigJam board in another team: the org's design default doesn't apply
    expect((await get(`/libraries?file=${BRAND}`, "alice")).body.libraries[0].org.enabledByDefault).toBe(false);

    // The workspace turns it off (an override) — the org admins hear of it
    w.inbox.length = 0;
    expect((await put("wade", LIB, { scope: { type: "workspace", id: W1 }, defaults: { design: false } })).status).toBe(200);
    expect(await inWeb()).toMatchObject({ approved: "org", enabledByDefault: false });
    const notice = w.inbox.find((m) => m.userId === w.people.alice.id && m.msg.item?.kind === "library_default_override");
    expect(notice?.msg.item).toMatchObject({ fileName: "Design System", text: "Product" });
    // A workspace can't unapprove what the org approved
    await put("wade", LIB, { scope: { type: "workspace", id: W1 }, approved: false });
    expect((await inWeb()).approved).toBe("org");

    // The team turns it back on, with a default mode
    expect((await put("tara", LIB, { scope: { type: "team", id: T2 }, defaults: { design: true }, defaultModes: [{ collectionKey: COLORS.key, modeId: "1:1" }] })).status).toBe(200);
    expect(await inWeb()).toMatchObject({ enabledByDefault: true, defaultModes: [{ collectionKey: COLORS.key, modeId: "1:1" }] });
    expect((await put("tara", LIB, { scope: { type: "team", id: T2 }, defaultModes: [{ collectionKey: COLORS.key, modeId: "9:9" }] })).status).toBe(400);
    expect((await put("alice", LIB, { scope: { type: "org", id: w.orgId }, defaultModes: [] })).status).toBe(400);
    expect((await put("tara", LIB, { scope: { type: "team", id: T2 }, defaultModes: [{ collectionKey: COLORS.key, modeId: null }] })).status).toBe(200);
    expect((await inWeb()).defaultModes).toEqual([]);

    // A workspace approval alone shows as "workspace"; drafts take their owner's workspace
    await put("alice", LIB, { scope: { type: "org", id: w.orgId }, approved: false });
    await put("wade", LIB, { scope: { type: "workspace", id: W1 }, approved: true, defaults: { design: null } });
    expect((await inWeb()).approved).toBe("workspace");
    const draft = (await get(`/libraries?file=${DRAFT}`, "bob")).body.libraries[0].org;
    expect(draft).toMatchObject({ approved: "workspace", enabledByDefault: true }); // org row's design: true, W1 inherits

    const logged = (await w.rows(`SELECT action FROM activity_log WHERE action LIKE '%library%' ORDER BY id`)).map((r) => r.action);
    expect(logged).toEqual(["org_library_approve", "org_library_setting_change", "workspace_library_setting_change", "org_library_unapprove", "workspace_library_approve", "workspace_library_setting_change"]);
  });

  it("who may change which row", async () => {
    await publish(w, LIB, w.people.alice.token, [BUTTON]);
    // Dan isn't an admin of anything
    expect((await put("dan", LIB, { scope: { type: "org", id: w.orgId }, approved: true })).status).toBe(404);
    // Tara admins T2, but LIB is T1's and not published to the org: she can't see it at all
    expect((await put("tara", LIB, { scope: { type: "team", id: T2 }, defaults: { design: true } })).status).toBe(404);
    expect((await put("wade", LIB, { scope: { type: "org", id: w.orgId }, approved: true })).body.code).toBe("not_admin");
    expect((await put("wade", LIB, { scope: { type: "team", id: T1 }, approved: true })).status).toBe(400);
    // An org default on a team library publishes it to the org (the warning's "changes the file's permissions")
    expect((await put("alice", LIB, { scope: { type: "org", id: w.orgId }, defaults: { design: true } })).body.library).toMatchObject({ scope: "org", defaultIn: { org: ["design"] } });
    expect((await w.rows(`SELECT org_link_access FROM files WHERE key = ?1`, LIB))[0].org_link_access).toBe("viewer");
    // Now Tara may make it T2's default
    expect((await put("tara", LIB, { scope: { type: "team", id: T2 }, defaults: { figjam: true } })).status).toBe(200);
  });

  it("Admin › Libraries, Manage this library, and View team's libraries", async () => {
    await publish(w, LIB, w.people.alice.token, [BUTTON, COLORS], { collections: COLLECTIONS });
    await publish(w, SECRET, w.people.alice.token, [CARD]);
    await put("alice", SECRET, { scope: { type: "org", id: w.orgId }, approved: true });
    const list = (who: keyof World["people"], q = "") => w.call("GET", `/orgs/${w.orgId}/libraries${q}`, w.people[who].token);
    expect((await list("alice")).body.libraries.map((l: Any) => l.name)).toEqual(["Secret System", "Design System"]); // approved first
    expect((await list("alice", "?approved=1")).body.libraries.map((l: Any) => l.key)).toEqual([SECRET]);
    expect((await list("alice", "?text=design")).body.libraries.map((l: Any) => l.key)).toEqual([LIB]);
    expect((await list("wade")).body.libraries).toHaveLength(2); // his workspace's teams
    expect((await list("carol")).body.libraries).toEqual([]);
    expect((await list("bob")).body.libraries).toHaveLength(2); // T1's member

    const info = (await w.call("GET", `/orgs/${w.orgId}/libraries/${LIB}`, w.people.wade.token)).body.library;
    expect(info).toMatchObject({ key: LIB, collections: [{ collectionKey: COLORS.key, name: "Colors", modes: [{ name: "Light" }, { name: "Dark" }] }], canManage: { org: false, workspaceIds: [W1], teamIds: [T1] } });

    const team = await w.call("GET", `/teams/${T2}/libraries`, w.people.carol.token);
    expect(team.body.libraries).toEqual([]); // nothing of T2 and nothing published to the org
    await w.call("PATCH", `/libraries/${LIB}`, w.people.alice.token, { scope: "org" });
    await put("tara", LIB, { scope: { type: "team", id: T2 }, defaults: { design: true } });
    const rows = (await w.call("GET", `/teams/${T2}/libraries`, w.people.carol.token)).body.libraries;
    expect(rows.map((r: Any) => [r.key, r.setting.scopeName, r.setting.defaults.design, r.setting.updatedBy?.email])).toEqual([[LIB, "Web", true, "tara@x.co"]]);
    expect((await w.call("GET", `/teams/${T2}/libraries`, w.people.dan.token)).status).toBe(403);
  });
});

describe("a file's libraries (subscriptions)", () => {
  it("defaults, explicit on / off, and back to the default", async () => {
    await publish(w, LIB, w.people.alice.token, [BUTTON], { scope: "org" });
    await publish(w, SECRET, w.people.alice.token, [CARD], { scope: "org" });
    await w.call("PUT", `/orgs/${w.orgId}/libraries/${LIB}/settings`, w.people.alice.token, { scope: { type: "org", id: w.orgId }, defaults: { design: true } });
    const carol = w.people.carol.token;
    expect((await w.call("GET", `/files/${WEB}/libraries`, carol)).body).toEqual({ enabled: [LIB], defaults: [LIB], overrides: [] });
    expect((await w.call("PUT", `/files/${WEB}/libraries/${LIB}`, carol, { enabled: false })).body).toEqual({ enabled: [], defaults: [LIB], overrides: [{ libraryKey: LIB, enabled: false }] });
    expect((await w.call("PUT", `/files/${WEB}/libraries/${SECRET}`, carol, { enabled: true })).body.enabled).toEqual([SECRET]);
    expect((await w.call("PUT", `/files/${WEB}/libraries/${LIB}`, carol, { enabled: null })).body.enabled).toEqual([SECRET, LIB]);
    // Viewers can't; a library the editor can't use can't be added
    await w.run(`INSERT INTO members (file_key, email, user_id, role, created_at) VALUES (?1, 'dan@x.co', ?2, 'viewer', 0)`, WEB, w.people.dan.id);
    expect((await w.call("PUT", `/files/${WEB}/libraries/${LIB}`, w.people.dan.token, { enabled: false })).status).toBe(403);
    await w.call("PATCH", `/libraries/${SECRET}`, w.people.alice.token, { scope: "team" });
    expect((await w.call("PUT", `/files/${WEB}/libraries/${SECRET}`, carol, { enabled: true })).status).toBe(404);
  });
});

describe("notices and status (§16.6, §16.7)", () => {
  it("tells the library's audience; unpublish, trash, restore and delete forever", async () => {
    await publish(w, LIB, w.people.alice.token, [BUTTON]);
    expect(libraryMsgs(w.people.bob.id)).toEqual([{ t: "library", libraryKey: LIB, version: 1 }]);
    expect(libraryMsgs(w.people.gus.id)).toHaveLength(1); // invited to the file
    expect(libraryMsgs(w.people.carol.id)).toEqual([]);
    await publish(w, LIB, w.people.alice.token, [BUTTON], { baseVersion: 1, scope: "org" });
    expect(libraryMsgs(w.people.carol.id)).toEqual([{ t: "library", libraryKey: LIB, version: 2 }]);
    expect(libraryMsgs(w.people.gus.id)).toHaveLength(2);

    expect((await w.call("POST", `/libraries/${LIB}/unpublish`, w.people.bob.token)).status).toBe(204);
    expect(libraryMsgs(w.people.carol.id).at(-1)).toEqual({ t: "library", libraryKey: LIB, status: "unpublished" });
    expect((await get(`/libraries?file=${WEB}`, "carol")).body.libraries).toEqual([]);
    // Publishing again brings it back
    await publish(w, LIB, w.people.alice.token, [BUTTON], { baseVersion: 2, scope: "org" });
    await w.call("PUT", `/files/${WEB}/libraries/${LIB}`, w.people.carol.token, { enabled: true });

    await w.call("POST", `/files/${LIB}/trash`, w.people.alice.token);
    expect((await w.rows(`SELECT status FROM libraries`))[0].status).toBe("trashed");
    expect((await get(`/libraries?file=${WEB}`, "carol")).body.libraries).toEqual([]);
    expect(libraryMsgs(w.people.carol.id).at(-1)).toEqual({ t: "library", libraryKey: LIB, status: "trashed" });
    await w.call("POST", `/files/${LIB}/restore`, w.people.alice.token);
    expect((await w.rows(`SELECT status FROM libraries`))[0].status).toBe("published");

    const box = w.libs.objects.get(LIB)!.box;
    expect(tableCount(box, "payloads")).toBeGreaterThan(0);
    await w.call("POST", `/files/${LIB}/trash`, w.people.alice.token);
    expect((await w.call("DELETE", `/files/${LIB}`, w.people.alice.token)).status).toBe(200);
    expect(await w.rows(`SELECT status, name FROM libraries`)).toEqual([{ status: "deleted", name: "Design System" }]);
    expect(w.libs.objects.get(LIB)!.wiped).toBe(1);
    expect(await w.rows(`SELECT * FROM library_subscriptions`)).toEqual([]);
    expect(libraryMsgs(w.people.carol.id).at(-1)).toEqual({ t: "library", libraryKey: LIB, status: "deleted" });
  });
});
