/** Organization and team names and icons (docs/multiplayer.md §14.16): org/icons.ts over the real handler. */
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../api";
import { tableCount } from "../testing/memoryLibraries";
import { sha1, T1, T2, world, type Any, type World } from "../testing/orgWorld";
import { iconType, MAX_ICON_BYTES } from "./iconImage";

let w: World;
beforeEach(async () => {
  w = await world();
});

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A "PNG" (the server checks only the magic) with `seed` after it */
const png = (seed: string) => new Uint8Array([...PNG_MAGIC, ...new TextEncoder().encode(seed)]);
const jpeg = (seed: string) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(seed)]);
const storedOf = async (id: string) => (await w.rows<{ stored_bytes: number }>(`SELECT stored_bytes FROM users WHERE id = ?1`, id))[0].stored_bytes;
const items = async (prefix: string) => (await w.rows<{ item: string; owner_id: string; bytes: number }>(`SELECT item, owner_id, bytes FROM stored_items WHERE item LIKE ?1 ORDER BY item`, `${prefix}%`));
const actions = async (action: string) => (await w.rows<Any>(`SELECT * FROM activity_log WHERE action = ?1 ORDER BY at`, action)).map((r) => ({ ...r, details: JSON.parse(r.details), entity: JSON.parse(r.entity) }));
/** The org object's images (none when the object was never reached) */
const images = () => {
  const o = w.fonts.objects.get(w.orgId);
  return o ? tableCount(o.box, "images") : 0;
};

describe("migration 0020", () => {
  it("adds icon_hash to orgs and teams (node:sqlite runs every migration)", async () => {
    const cols = async (t: string) => (await w.rows<{ name: string }>(`SELECT name FROM pragma_table_info(?1)`, t)).map((c) => c.name);
    expect(await cols("orgs")).toContain("icon_hash");
    expect(await cols("teams")).toEqual(expect.arrayContaining(["icon", "icon_hash"]));
  });
});

describe("the organization's name", () => {
  it("org admins rename it; everyone in it hears; logged org_rename", async () => {
    expect((await w.call("PATCH", `/orgs/${w.orgId}`, w.people.bob.token, { name: "Nope" })).body.code).toBe("not_admin");
    expect((await w.call("PATCH", `/orgs/${w.orgId}`, w.people.alice.token, { name: "  " })).status).toBe(400);
    const r = await w.call("PATCH", `/orgs/${w.orgId}`, w.people.alice.token, { name: " Acme Inc " });
    expect(r.status).toBe(200);
    expect(r.body.org).toMatchObject({ id: w.orgId, name: "Acme Inc", iconUrl: null, role: "admin" });
    expect((await w.call("GET", "/orgs", w.people.bob.token)).body.orgs.find((o: Any) => o.id === w.orgId).name).toBe("Acme Inc");
    expect(w.inbox.filter((m) => m.userId === w.people.bob.id && m.msg.t === "org").map((m) => m.msg)).toEqual(expect.arrayContaining([{ t: "org", what: "orgs" }, { t: "org", what: "org", orgId: w.orgId }]));
    const log = await actions("org_rename");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ entity_type: "org", entity_id: w.orgId, details: { old_name: "Acme" } });
    expect(log[0].entity.name).toBe("Acme Inc");
  });
});

describe("the organization's icon", () => {
  it("org admins upload one: served publicly by hash, immutable; replacing and removing release the bytes", async () => {
    const one = png("one");
    expect((await w.call("PUT", `/orgs/${w.orgId}/icon`, w.people.bob.token, one)).body.code).toBe("not_admin");
    const up = await w.call("PUT", `/orgs/${w.orgId}/icon`, w.people.alice.token, one);
    expect(up.status).toBe(200);
    expect(up.body.org.iconUrl).toBe(`/icons/${w.orgId}/${sha1(one)}`);
    expect((await w.call("GET", "/orgs", w.people.bob.token)).body.orgs[0].iconUrl).toBe(up.body.org.iconUrl);

    // Public: no session, the type sniffed at upload, a year's cache
    const got = await w.call("GET", up.body.org.iconUrl);
    expect(got.status).toBe(200);
    expect([...got.bytes]).toEqual([...one]);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await w.call("GET", `/icons/${w.orgId}/${sha1("never")}`)).status).toBe(404);

    // Counted: one upload, its bytes on the uploader
    expect(await storedOf(w.people.alice.id)).toBe(one.length);
    expect(await items(`o:${w.orgId}:icon:`)).toEqual([{ item: `o:${w.orgId}:icon:${sha1(one)}`, owner_id: w.people.alice.id, bytes: one.length }]);

    // Replaced: the old bytes leave the object and the totals
    const two = jpeg("second icon");
    const re = await w.call("PUT", `/orgs/${w.orgId}/icon`, w.people.alice.token, two);
    expect(re.body.org.iconUrl).toBe(`/icons/${w.orgId}/${sha1(two)}`);
    expect((await w.call("GET", `/icons/${w.orgId}/${sha1(one)}`)).status).toBe(404);
    expect((await w.call("GET", re.body.org.iconUrl)).headers.get("content-type")).toBe("image/jpeg");
    expect(images()).toBe(1);
    expect(await storedOf(w.people.alice.id)).toBe(two.length);

    const gone = await w.call("DELETE", `/orgs/${w.orgId}/icon`, w.people.alice.token);
    expect(gone.body.org.iconUrl).toBeNull();
    expect(images()).toBe(0);
    expect(await storedOf(w.people.alice.id)).toBe(0);
    expect(await items(`o:${w.orgId}:icon:`)).toEqual([]);
    expect((await actions("org_icon_change")).map((a) => a.details)).toEqual([
      { from: null, to: sha1(one) },
      { from: sha1(one), to: sha1(two) },
      { from: sha1(two), to: null },
    ]);
  });

  it("refuses what isn't PNG, JPEG, WebP or GIF, and anything over 1 MB", async () => {
    const svg = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
    const bad = await w.call("PUT", `/orgs/${w.orgId}/icon`, w.people.alice.token, svg);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("only PNG, JPEG, WebP and GIF images can be used as an icon");
    // By its declared length: nothing read
    const declared = await w.call("PUT", `/orgs/${w.orgId}/icon`, w.people.alice.token, png("x"), { "content-length": String(MAX_ICON_BYTES + 1) }).catch(() => null);
    if (declared) expect(declared.status).toBe(413);
    // As it streams in (no length declared)
    const big = new Uint8Array(MAX_ICON_BYTES + 10);
    big.set(PNG_MAGIC);
    const over = await w.call("PUT", `/orgs/${w.orgId}/icon`, w.people.alice.token, big);
    expect(over.status).toBe(413);
    expect(over.body.code).toBe("too_large");
    expect(await storedOf(w.people.alice.id)).toBe(0);
    expect(images()).toBe(0);
    for (const ok of [png("p"), jpeg("j"), new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]), new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1])]) expect(iconType(ok)).not.toBeNull();
  });

  it("stops reading at the first bytes when they aren't an image", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled === 1) c.enqueue(new TextEncoder().encode("GIF00a not an image at all"));
        else if (pulled < 100) c.enqueue(new Uint8Array(1024));
        else c.close();
      },
    });
    const res = await handle(new Request(`https://server.test/orgs/${w.orgId}/icon`, { method: "PUT", headers: { authorization: `Bearer ${w.people.alice.token}` }, body, duplex: "half" } as RequestInit), w.deps);
    expect(res.status).toBe(400);
    expect(pulled).toBeLessThan(5);
  });

  it("counts in the uploader's stored bytes: over their limit, refused", async () => {
    await w.run(`UPDATE users SET quota_overrides = ?2 WHERE id = ?1`, w.people.alice.id, JSON.stringify({ storage_bytes: 10 }));
    const r = await w.call("PUT", `/orgs/${w.orgId}/icon`, w.people.alice.token, png("more than ten bytes"));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "quota_exceeded", kind: "storage_bytes", limit: 10 });
    expect(images()).toBe(0);
  });
});

describe("a team's icon and name", () => {
  it("the team's admins and owner and org admins change it; editors can't; a legacy data: icon is replaced", async () => {
    await w.run(`UPDATE teams SET icon = 'data:image/png;base64,AAAA' WHERE id = ?1`, T2);
    const icon = png("team");
    expect((await w.call("PUT", `/teams/${T2}/icon`, w.people.carol.token, icon)).status).toBe(403); // can edit, not admin
    const up = await w.call("PUT", `/teams/${T2}/icon`, w.people.tara.token, icon); // team admin
    expect(up.status).toBe(200);
    expect(up.body.team).toMatchObject({ id: T2, icon: null, iconUrl: `/icons/${w.orgId}/${sha1(icon)}` });
    expect(await items(`o:${w.orgId}:team:${T2}:icon:`)).toEqual([{ item: `o:${w.orgId}:team:${T2}:icon:${sha1(icon)}`, owner_id: w.people.tara.id, bytes: icon.length }]);
    expect((await w.call("GET", `/orgs/${w.orgId}/teams`, w.people.carol.token)).body.teams.find((t: Any) => t.id === T2).iconUrl).toBe(up.body.team.iconUrl);
    expect((await w.call("GET", `/orgs/${w.orgId}/admin/teams`, w.people.alice.token)).body.items.find((t: Any) => t.id === T2).iconUrl).toBe(up.body.team.iconUrl);
    expect(w.inbox.some((m) => m.userId === w.people.carol.id && m.msg.t === "org" && m.msg.what === "team" && m.msg.teamId === T2)).toBe(true);

    // The same picture on another team (by the org admin): one copy in the object, kept while either uses it
    await w.call("PUT", `/teams/${T1}/icon`, w.people.alice.token, icon);
    expect(images()).toBe(1);
    expect((await w.call("DELETE", `/teams/${T2}/icon`, w.people.tara.token)).body.team).toMatchObject({ icon: null, iconUrl: null });
    expect(images()).toBe(1);
    expect((await w.call("GET", `/icons/${w.orgId}/${sha1(icon)}`)).status).toBe(200);
    expect(await storedOf(w.people.tara.id)).toBe(0);
    await w.call("DELETE", `/teams/${T1}/icon`, w.people.alice.token);
    expect(images()).toBe(0);
    expect((await actions("team_icon_change")).map((a) => [a.team_id, a.details.to])).toEqual([
      [T2, sha1(icon)],
      [T1, sha1(icon)],
      [T2, null],
      [T1, null],
    ]);
  });

  it("an invitation to the team carries its icon, else the org's (the bell's badge)", async () => {
    const orgIcon = png("org");
    await w.call("PUT", `/orgs/${w.orgId}/icon`, w.people.alice.token, orgIcon);
    await w.call("PUT", `/teams/${T2}/members`, w.people.alice.token, { email: "fay@x.co", role: "viewer" });
    const invite = () => w.call("GET", "/notifications", w.people.fay.token).then((r) => r.body.items.find((n: Any) => n.kind === "team_invite"));
    expect((await invite()).placeIconUrl).toBe(`/icons/${w.orgId}/${sha1(orgIcon)}`);
    const teamIcon = png("team");
    await w.call("PUT", `/teams/${T2}/icon`, w.people.alice.token, teamIcon);
    expect((await invite()).placeIconUrl).toBe(`/icons/${w.orgId}/${sha1(teamIcon)}`);
    await w.call("DELETE", `/orgs/${w.orgId}/icon`, w.people.alice.token);
    await w.call("DELETE", `/teams/${T2}/icon`, w.people.alice.token);
    expect((await invite()).placeIconUrl).toBeUndefined();
  });

  it("Rename: the team's admins (team_rename, Figma's), names unique in the org", async () => {
    expect((await w.call("PATCH", `/teams/${T2}`, w.people.carol.token, { name: "Site" })).status).toBe(403);
    expect((await w.call("PATCH", `/teams/${T2}`, w.people.tara.token, { name: "design" })).status).toBe(409);
    expect((await w.call("PATCH", `/teams/${T2}`, w.people.tara.token, { name: "Website" })).body.team.name).toBe("Website");
    expect((await actions("team_rename"))[0]).toMatchObject({ team_id: T2, details: { old_name: "Web" } });
  });

  it("a deleted team's icon isn't served and can't be changed", async () => {
    const icon = png("deleted");
    await w.call("PUT", `/teams/${T2}/icon`, w.people.alice.token, icon);
    await w.call("DELETE", `/teams/${T2}`, w.people.alice.token);
    expect((await w.call("GET", `/icons/${w.orgId}/${sha1(icon)}`)).status).toBe(404);
    expect((await w.call("PUT", `/teams/${T2}/icon`, w.people.alice.token, png("again"))).status).toBe(404);
  });
});
