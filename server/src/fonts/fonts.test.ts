import { beforeEach, describe, expect, it } from "vitest";
import { tableCount } from "../testing/memoryLibraries";
import { sha1, T2, world, type Any, type World } from "../testing/orgWorld";

let w: World;
beforeEach(async () => {
  w = await world();
});

/** A TrueType file's first bytes (the object checks only the magic) */
const ttf = (seed: string) => new Uint8Array([0, 1, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, ...new TextEncoder().encode(seed)]);
const otf = (seed: string) => new Uint8Array([...new TextEncoder().encode("OTTO"), 0, 4, 0, 0, 0, 0, 0, 0, ...new TextEncoder().encode(seed)]);
const face = (family: string, style: string, weight = 400, italic = false) => ({ family, style, postscriptName: `${family}-${style}`.replace(/\s/g, ""), weight, italic, stretch: 5, variable: false });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

function upload(who: keyof World["people"], bytes: Uint8Array, faces: unknown[], q = "", headers: Record<string, string> = {}) {
  return w.call("PUT", `/orgs/${w.orgId}/fonts${q}`, w.people[who].token, bytes, { "x-font-faces": b64(faces), "x-font-file-name": "Acme Sans.ttf", "x-font-licence": "confirmed", ...headers });
}
const fontsMsgs = (userId: string) => w.inbox.filter((m) => m.userId === userId && m.msg.t === "fonts").map((m) => m.msg);

describe("organization fonts", () => {
  it("org admins upload with the licence confirmed; members (not guests) get them", async () => {
    expect((await upload("alice", ttf("a"), [face("Acme Sans", "Regular")], "", { "x-font-licence": "" })).status).toBe(400);
    expect((await upload("bob", ttf("a"), [face("Acme Sans", "Regular")])).body.code).toBe("not_admin");
    const up = await upload("alice", ttf("regular"), [face("Acme Sans", "Regular"), face("Acme Sans", "Regular")]);
    expect(up.status).toBe(201);
    expect(up.body.uploaded).toMatchObject([{ family: "Acme Sans", style: "Regular", weight: 400, format: "ttf", sha1: sha1(ttf("regular")), fileName: "Acme Sans.ttf", teamId: null, uploadedBy: { id: w.people.alice.id, name: "alice" } }]);
    expect(up.body.replaced).toEqual([]);
    await upload("alice", otf("bold"), [face("Acme Sans Display", "Bold", 700)]);

    const bob = (await w.call("GET", "/me/fonts", w.people.bob.token)).body;
    expect(bob.faces.map((f: Any) => [f.family, f.style, f.format])).toEqual([["Acme Sans", "Regular", "ttf"], ["Acme Sans Display", "Bold", "otf"]]);
    expect(bob.version).toMatch(/^[0-9a-f]{16}$/);
    expect((await w.call("GET", "/me/fonts", w.people.gus.token)).body.faces).toEqual([]); // guests: the owner's default
    expect((await w.call("GET", "/me/fonts", w.people.olga.token)).body.faces).toEqual([]); // another org's person

    const file = await w.call("GET", `/fonts/${sha1(otf("bold"))}`, w.people.bob.token);
    expect(file.headers.get("content-type")).toBe("font/otf");
    expect(file.headers.get("cache-control")).toContain("immutable");
    expect([...file.bytes]).toEqual([...otf("bold")]);
    expect((await w.call("GET", `/fonts/${sha1(otf("bold"))}`, w.people.gus.token)).status).toBe(404);

    expect(fontsMsgs(w.people.bob.id).at(-1)).toEqual({ t: "fonts", orgId: w.orgId, version: bob.version });
    expect(fontsMsgs(w.people.gus.id)).toEqual([]);
    // Admin › Resources › Fonts
    expect((await w.call("GET", `/orgs/${w.orgId}/fonts`, w.people.dan.token)).body.faces).toHaveLength(2);
    expect((await w.call("GET", `/orgs/${w.orgId}/fonts`, w.people.gus.token)).status).toBe(403);
  });

  it("the same family again: 409, then Skip or Replace", async () => {
    await upload("alice", ttf("v1"), [face("Acme Sans", "Regular"), face("Acme Sans", "Italic", 400, true)]);
    expect((await w.call("POST", `/orgs/${w.orgId}/fonts/check`, w.people.alice.token, { families: ["acme sans", "Other"] })).body.conflicts).toEqual([{ family: "acme sans", existing: 2 }]);
    const clash = await upload("alice", ttf("v2"), [face("Acme Sans", "Regular")]);
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ code: "conflict", families: ["Acme Sans"] });
    expect((await upload("alice", ttf("v2"), [face("Acme Sans", "Regular")], "?onConflict=skip")).body).toEqual({ uploaded: [], replaced: [] });
    const box = w.fonts.objects.get(w.orgId)!.box;
    expect(tableCount(box, "fonts")).toBe(1);
    const replaced = await upload("alice", ttf("v2"), [face("Acme Sans", "Regular")], "?onConflict=replace");
    expect(replaced.body.replaced).toEqual(["Acme Sans"]);
    const faces = (await w.call("GET", `/orgs/${w.orgId}/fonts`, w.people.alice.token)).body.faces;
    expect(faces.map((f: Any) => [f.style, f.sha1])).toEqual([["Regular", sha1(ttf("v2"))]]);
    expect(tableCount(box, "fonts")).toBe(1); // v1's bytes went with its last row
  });

  it("refuses collections and web fonts, and removes faces and families", async () => {
    const ttc = new Uint8Array([...new TextEncoder().encode("ttcf"), 0, 1, 0, 0, 0, 0, 0, 0]);
    expect((await upload("alice", ttc, [face("Coll", "Regular")])).status).toBe(400);
    expect((await upload("alice", ttf("x"), [face("Web", "Regular")], "", { "x-font-file-name": "web.woff2" })).status).toBe(400);
    await upload("alice", ttf("r"), [face("Acme Sans", "Regular")]);
    await upload("alice", ttf("m"), [face("Mono", "Regular"), face("Mono", "Bold", 700)]);
    const faces = (await w.call("GET", `/orgs/${w.orgId}/fonts`, w.people.alice.token)).body.faces as Any[];
    const regular = faces.find((f) => f.family === "Acme Sans");
    expect((await w.call("DELETE", `/orgs/${w.orgId}/fonts/${regular.id}`, w.people.bob.token)).status).toBe(403);
    expect((await w.call("DELETE", `/orgs/${w.orgId}/fonts/${regular.id}`, w.people.alice.token)).body.faces.map((f: Any) => f.family)).toEqual(["Mono", "Mono"]);
    expect((await w.call("DELETE", `/orgs/${w.orgId}/fonts?family=mono`, w.people.alice.token)).body.faces).toEqual([]);
    expect(tableCount(w.fonts.objects.get(w.orgId)!.box, "fonts")).toBe(0);
  });
});

describe("team fonts", () => {
  it("the team's admins upload; the team's members get them in their team's files", async () => {
    expect((await upload("carol", ttf("t"), [face("Web Sans", "Regular")], `?team=${T2}`)).body.code).toBe("not_admin");
    const up = await upload("tara", ttf("t"), [face("Web Sans", "Regular")], `?team=${T2}`);
    expect(up.status).toBe(201);
    expect(up.body.uploaded[0].teamId).toBe(T2);
    const has = async (who: keyof World["people"]) => (await w.call("GET", "/me/fonts", w.people[who].token)).body.faces.map((f: Any) => f.family);
    expect(await has("carol")).toEqual(["Web Sans"]);
    expect(await has("bob")).toEqual([]);
    // A guest in the team gets team fonts
    await w.run(`INSERT INTO team_members (team_id, email, user_id, role, created_at) VALUES (?1, 'gus@x.co', ?2, 'viewer', 0)`, T2, w.people.gus.id);
    expect(await has("gus")).toEqual(["Web Sans"]);
    expect(fontsMsgs(w.people.carol.id)).toHaveLength(1);
    expect(fontsMsgs(w.people.bob.id)).toEqual([]);
    expect((await w.call("GET", `/orgs/${w.orgId}/fonts?team=${T2}`, w.people.carol.token)).body.faces).toHaveLength(1);
    expect((await w.call("GET", `/orgs/${w.orgId}/fonts?team=${T2}`, w.people.bob.token)).status).toBe(403);
    // Org fonts and team fonts are separate scopes: the same family in both is no conflict
    expect((await upload("alice", ttf("o"), [face("Web Sans", "Regular")])).status).toBe(201);
  });
});
