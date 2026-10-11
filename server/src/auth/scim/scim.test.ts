/**
 * SCIM 2.0 (docs/multiplayer.md §15.5): the token and tenant, discovery, Users (create / filter / PUT / PATCH in Okta's
 * and Entra's shapes / deactivate / reactivate / DELETE) and Groups (linked to a workspace, a billing group, a user
 * group; renames; members). node:sqlite, the real handler.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { SCIM_ENTERPRISE_SCHEMA, SCIM_FIGMA_SCHEMA, SCIM_USER_SCHEMA } from "../../../../src/shared/org/identity";
import { ORIGIN, identityWorld, type IdentityWorld } from "../../testing/identityWorld";

let w: IdentityWorld;
let tenant: string;
let token: string;
beforeEach(async () => {
  w = await identityWorld();
  tenant = await w.addIdp();
  token = (await w.call("POST", `/orgs/${w.orgId}/admin/identity/scim-token`, { token: w.admin.token })).body.token;
});

const scim = (method: string, path: string, body?: unknown, t: string | null = token) =>
  w.call(method, `/scim/v2/${tenant}${path}`, { ...(t ? { token: t } : {}), body, headers: body !== undefined ? { "content-type": "application/scim+json" } : {} });
const member = async (userId: string) => (await w.rows(`SELECT * FROM org_members WHERE org_id = ?1 AND user_id = ?2`, w.orgId, userId))[0];
const actions = async () => (await w.rows<{ action: string; details: string; entity_type: string }>(`SELECT action, details, entity_type FROM activity_log WHERE org_id = ?1 ORDER BY id`, w.orgId)).map((r) => ({ action: r.action, type: r.entity_type, details: JSON.parse(r.details) }));
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/** Okta's create */
const okta = (email: string, extra: Record<string, unknown> = {}) => ({
  schemas: [SCIM_USER_SCHEMA, SCIM_ENTERPRISE_SCHEMA],
  userName: email,
  name: { givenName: "Eve", familyName: "Adams" },
  emails: [{ primary: true, value: email, type: "work" }],
  displayName: "Eve Adams",
  title: "Designer",
  externalId: `00u-${email.toLowerCase()}`,
  active: true,
  roles: [{ type: "seatType", value: "Full", primary: true }],
  [SCIM_ENTERPRISE_SCHEMA]: { department: "Design", manager: { value: "00uBoss", displayName: "Boss" } },
  ...extra,
});

describe("the token, the tenant and discovery", () => {
  it("checks the tenant, the token and its org; answers scim+json errors", async () => {
    expect((await scim("GET", "", undefined, null)).body).toEqual({});
    expect((await w.call("GET", "/scim/v2/999999999999999999")).status).toBe(400);
    const none = await scim("GET", "/Users", undefined, null);
    expect(none.status).toBe(401);
    expect(none.headers.get("content-type")).toContain("application/scim+json");
    expect(none.body).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401" });
    expect((await scim("GET", "/Users", undefined, "dsgn_scim_forged")).status).toBe(401);
    // another org's token on this tenant
    const olga = await w.dev("olga@other.test");
    const org2 = (await w.call("POST", "/orgs", { token: olga.token, body: { name: "Other" } })).body.org.id;
    await w.addIdp(org2);
    const t2 = (await w.call("POST", `/orgs/${org2}/admin/identity/scim-token`, { token: olga.token })).body.token;
    expect((await scim("GET", "/Users", undefined, t2)).status).toBe(401);
    expect((await w.rows(`SELECT last_used_at FROM scim_tokens WHERE org_id = ?1`, w.orgId))[0].last_used_at).toBeNull();
    await scim("GET", "/Users");
    expect((await w.rows(`SELECT last_used_at FROM scim_tokens WHERE org_id = ?1`, w.orgId))[0].last_used_at).toBe(w.now.t);
  });

  it("serves ServiceProviderConfig, Schemas and ResourceTypes", async () => {
    const c = (await scim("GET", "/ServiceProviderConfig")).body;
    expect(c).toMatchObject({ patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 200 }, authenticationSchemes: [{ type: "oauthbearertoken", primary: true }] });
    expect((await scim("GET", "/Schemas")).body.Resources.map((s: { id: string }) => s.id)).toContain(SCIM_FIGMA_SCHEMA);
    expect((await scim("GET", "/ResourceTypes/User")).body.schemaExtensions).toHaveLength(2);
  });
});

describe("Users", () => {
  it("creates a member (Okta's shape): seat from roles, attributes kept, logged with the idp_user entity", async () => {
    const r = await scim("POST", "/Users", okta("Eve@Acme.test"));
    expect(r.status, r.text).toBe(201);
    const u = r.body;
    expect(u).toMatchObject({ userName: "eve@acme.test", active: true, displayName: "Eve Adams", title: "Designer", roles: [{ type: "seatType", value: "Full" }], name: { givenName: "Eve", familyName: "Adams" } });
    expect(u[SCIM_ENTERPRISE_SCHEMA]).toEqual({ department: "Design", manager: { value: "00uBoss", displayName: "Boss" } });
    expect(u[SCIM_FIGMA_SCHEMA]).toEqual({ figmaAdmin: false });
    expect(u.meta.location).toBe(`${ORIGIN}/scim/v2/${tenant}/Users/${u.id}`);
    expect(await member(u.id)).toMatchObject({ role: "member", seat: "full", provisioned_by: "scim" });
    expect((await w.rows(`SELECT google_sub FROM users WHERE id = ?1`, u.id))[0].google_sub).toBe(`none:${u.id}`);
    const log = (await actions()).find((a) => a.action === "idp_user_create")!;
    expect(log.type).toBe("idp_user");
    expect((await scim("POST", "/Users", okta("eve@acme.test"))).body).toMatchObject({ status: "409", scimType: "uniqueness" });
  });

  it("filters by userName or externalId (eq only) and pages", async () => {
    for (const n of ["a", "b", "c"]) await scim("POST", "/Users", okta(`${n}@acme.test`, { externalId: `ext-${n}` }));
    const byName = (await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "B@acme.test"')}`)).body;
    expect(byName).toMatchObject({ totalResults: 1, Resources: [{ userName: "b@acme.test" }] });
    expect((await scim("GET", `/Users?filter=${encodeURIComponent('externalId eq "ext-c"')}`)).body.Resources[0].userName).toBe("c@acme.test");
    expect((await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "nobody@acme.test"')}`)).body.totalResults).toBe(0);
    expect((await scim("GET", `/Users?filter=${encodeURIComponent('title co "x"')}`)).body.scimType).toBe("invalidFilter");
    const page = (await scim("GET", "/Users?startIndex=2&count=1")).body;
    expect(page).toMatchObject({ totalResults: 3, startIndex: 2, itemsPerPage: 1, Resources: [{ userName: "b@acme.test" }] });
  });

  it("PUT replaces every attribute it carries and clears the others", async () => {
    const id = (await scim("POST", "/Users", okta("eve@acme.test"))).body.id;
    const r = await scim("PUT", `/Users/${id}`, { schemas: [SCIM_USER_SCHEMA], userName: "eve@acme.test", name: { givenName: "Eve", familyName: "Brown" }, active: true });
    expect(r.body.title).toBeUndefined();
    expect(r.body.displayName).toBe("Eve Brown");
    expect(r.body[SCIM_ENTERPRISE_SCHEMA]).toEqual({});
    expect(r.body.roles[0].value).toBe("Full"); // roles not sent: the seat stays
  });

  it("PATCH in Okta's shape: deactivate (removed from the org, the link kept), reactivate (back with its seat)", async () => {
    const id = (await scim("POST", "/Users", okta("eve@acme.test", { roles: [{ type: "seatType", value: "Dev" }] }))).body.id;
    const off = await scim("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] });
    expect(off.body.active).toBe(false);
    expect(await member(id)).toBeUndefined();
    expect((await scim("GET", `/Users/${id}`)).body).toMatchObject({ active: false, userName: "eve@acme.test" });
    const on = await scim("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: true } }] });
    expect(on.body.active).toBe(true);
    expect(await member(id)).toMatchObject({ role: "member", seat: "dev", provisioned_by: "scim" });
    const log = (await actions()).map((a) => a.action);
    expect(log).toContain("idp_user_deactivate");
    expect(log).toContain("idp_user_activate");
  });

  it("PATCH in Entra's shape: \"Replace\", \"False\", seatType, enterprise URNs, figmaAdmin; unknown paths refused", async () => {
    const id = (await scim("POST", "/Users", okta("eve@acme.test"))).body.id;
    const ops = (Operations: unknown[]) => scim("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations });
    const r = await ops([
      { op: "Replace", path: 'roles[type eq "seatType"].value', value: "Dev" },
      { op: "Replace", path: `${SCIM_ENTERPRISE_SCHEMA}:department`, value: "Research" },
      { op: "Add", path: "name.givenName", value: "Evelyn" },
      { op: "Replace", path: `${SCIM_FIGMA_SCHEMA}:figmaAdmin`, value: "True" },
      { op: "Remove", path: "title" },
    ]);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ roles: [{ value: "Dev" }], name: { givenName: "Evelyn" }, [SCIM_FIGMA_SCHEMA]: { figmaAdmin: true } });
    expect(r.body.title).toBeUndefined();
    expect(r.body[SCIM_ENTERPRISE_SCHEMA].department).toBe("Research");
    expect(await member(id)).toMatchObject({ role: "admin", seat: "dev" });
    const log = (await actions()).map((a) => a.action);
    for (const a of ["idp_user_update", "org_user_account_type_change", "org_user_permission_change"]) expect(log).toContain(a);
    // Entra's no-path value with URN keys
    const np = await ops([{ op: "replace", value: { [`${SCIM_ENTERPRISE_SCHEMA}:division`]: "EMEA", displayName: "Evelyn Adams" } }]);
    expect(np.body[SCIM_ENTERPRISE_SCHEMA].division).toBe("EMEA");
    expect(np.body.displayName).toBe("Evelyn Adams");
    expect((await ops([{ op: "Replace", path: "active", value: "False" }])).body.active).toBe(false);
    expect((await ops([{ op: "replace", path: "nickName", value: "x" }])).body).toMatchObject({ status: "400", scimType: "invalidPath" });
    expect((await ops([{ op: "replace", path: "active", value: "maybe" }])).body.scimType).toBe("invalidValue");
  });

  it("a new userName changes the account's email, unless another account has it", async () => {
    const id = (await scim("POST", "/Users", okta("eve@acme.test"))).body.id;
    const r = await scim("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: 'emails[type eq "work"].value', value: "eve.adams@acme.test" }] });
    expect(r.body.userName).toBe("eve.adams@acme.test");
    expect((await w.rows(`SELECT email FROM users WHERE id = ?1`, id))[0].email).toBe("eve.adams@acme.test");
    expect((await member(id)).email).toBe("eve.adams@acme.test");
    const taken = await scim("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "userName", value: "alice@acme.test" }] });
    expect(taken.body).toMatchObject({ status: "409", scimType: "uniqueness" });
  });

  it("links existing accounts: a member keeps admin unless told, a guest becomes a member; DELETE keeps the account", async () => {
    const admin = await scim("POST", "/Users", okta("alice@acme.test", { roles: undefined }));
    expect(admin.body.id).toBe(w.admin.id);
    expect((await member(w.admin.id)).role).toBe("admin");
    const gus = await w.dev("gus@elsewhere.test");
    await w.run(`INSERT INTO org_members (org_id, email, user_id, role, seat, created_at) VALUES (?1, 'gus@elsewhere.test', ?2, 'guest', 'view', 1)`, w.orgId, gus.id);
    const g = await scim("POST", "/Users", okta("gus@elsewhere.test"));
    expect(g.body.id).toBe(gus.id);
    expect((await member(gus.id)).role).toBe("member");
    // the last admin can't be demoted or removed by SCIM
    expect((await scim("PATCH", `/Users/${w.admin.id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: `${SCIM_FIGMA_SCHEMA}:figmaAdmin`, value: false }] })).status).toBe(400);
    expect((await scim("DELETE", `/Users/${w.admin.id}`)).status).toBe(400);
    expect((await scim("DELETE", `/Users/${gus.id}`)).status).toBe(204);
    expect(await member(gus.id)).toBeUndefined();
    expect(await w.rows(`SELECT id FROM users WHERE id = ?1`, gus.id)).toHaveLength(1);
    expect((await scim("GET", `/Users/${gus.id}`)).status).toBe(404);
    expect((await actions()).map((a) => a.action)).toContain("idp_user_delete");
  });
});

describe("Groups", () => {
  async function users(...emails: string[]) {
    const ids: string[] = [];
    for (const e of emails) ids.push((await scim("POST", "/Users", okta(e))).body.id);
    return ids;
  }

  it("links to a workspace by its exact name: members join it and its default teams; removal clears it", async () => {
    const t = w.now.t;
    await w.run(`INSERT INTO workspaces (id, org_id, name, created_at, updated_at) VALUES ('wsProduct0000001', ?1, 'Product', ?2, ?2)`, w.orgId, t);
    await w.run(`INSERT INTO teams (id, org_id, workspace_id, name, owner_id, created_at, updated_at) VALUES ('teamDesign000001', ?1, 'wsProduct0000001', 'Design', ?2, ?3, ?3)`, w.orgId, w.admin.id, t);
    await w.run(`INSERT INTO workspace_default_teams (workspace_id, team_id) VALUES ('wsProduct0000001', 'teamDesign000001')`);
    const [eve, bob] = await users("eve@acme.test", "bob@acme.test");
    const g = await scim("POST", "/Groups", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Product", members: [{ value: eve }] });
    expect(g.status, g.text).toBe(201);
    expect(g.body.members).toEqual([expect.objectContaining({ value: eve })]);
    expect((await member(eve)).workspace_id).toBe("wsProduct0000001");
    expect(await w.rows(`SELECT user_id FROM team_members WHERE team_id = 'teamDesign000001'`)).toEqual([{ user_id: eve }]);
    // Okta adds, Entra removes by filter
    await scim("PATCH", `/Groups/${g.body.id}`, { schemas: [PATCH], Operations: [{ op: "add", path: "members", value: [{ value: bob }] }] });
    expect((await member(bob)).workspace_id).toBe("wsProduct0000001");
    await scim("PATCH", `/Groups/${g.body.id}`, { schemas: [PATCH], Operations: [{ op: "Remove", path: `members[value eq "${eve}"]` }] });
    expect((await member(eve)).workspace_id).toBeNull();
    expect((await scim("GET", `/Groups?filter=${encodeURIComponent('displayName eq "Product"')}`)).body.Resources[0].members).toHaveLength(1);
    const log = (await actions()).map((a) => a.action);
    expect(log).toContain("idp_group_create");
    expect(log).toContain("idp_group_connection_add");
  });

  it("links to a billing group, else makes a user group; renames relink; DELETE unlinks", async () => {
    await w.run(`INSERT INTO billing_groups (id, org_id, name, created_at) VALUES ('bgMarketing00001', ?1, 'Marketing', 1)`, w.orgId);
    const [eve] = await users("eve@acme.test");
    const bg = await scim("POST", "/Groups", { displayName: "Marketing", members: [{ value: eve }] });
    expect((await member(eve)).billing_group_id).toBe("bgMarketing00001");
    const ug = await scim("POST", "/Groups", { displayName: "Design Ops", externalId: "okta-g1", members: [{ value: eve }] });
    const [made] = await w.rows(`SELECT * FROM user_groups WHERE external_id = ?1`, ug.body.id);
    expect(made.name).toBe("Design Ops");
    expect(await w.rows(`SELECT user_id FROM user_group_members WHERE group_id = ?1`, made.id)).toEqual([{ user_id: eve }]);
    // a rename to a name that links to nothing: the user group is renamed in place
    await scim("PATCH", `/Groups/${ug.body.id}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { displayName: "DesignOps" } }] });
    expect((await w.rows(`SELECT name FROM user_groups WHERE id = ?1`, made.id))[0].name).toBe("DesignOps");
    // a rename onto the billing group's name: the user group goes, the billing group links
    await w.run(`UPDATE org_members SET billing_group_id = NULL WHERE user_id = ?1`, eve);
    await scim("PUT", `/Groups/${ug.body.id}`, { displayName: "Marketing", externalId: "okta-g1", members: [{ value: eve }] });
    expect(await w.rows(`SELECT id FROM user_groups WHERE id = ?1`, made.id)).toHaveLength(0);
    expect((await member(eve)).billing_group_id).toBe("bgMarketing00001");
    expect((await scim("POST", "/Groups", { displayName: "X", externalId: "okta-g1" })).body.scimType).toBe("uniqueness");
    expect((await scim("POST", "/Groups", { displayName: "Y", members: [{ value: "u_nobody" }] })).body.scimType).toBe("invalidValue");
    expect((await scim("DELETE", `/Groups/${bg.body.id}`)).status).toBe(204);
    expect((await scim("DELETE", `/Groups/${ug.body.id}`)).status).toBe(204);
    expect((await member(eve)).billing_group_id).toBeNull();
    const log = (await actions()).map((a) => a.action);
    for (const a of ["idp_group_rename", "idp_group_delete", "idp_group_connection_remove"]) expect(log).toContain(a);
  });

  it("a deactivated member leaves the user group; reactivated, gets it back", async () => {
    const [eve] = await users("eve@acme.test");
    const ug = await scim("POST", "/Groups", { displayName: "Design Ops", members: [{ value: eve }] });
    const [made] = await w.rows(`SELECT id FROM user_groups WHERE external_id = ?1`, ug.body.id);
    await scim("PATCH", `/Users/${eve}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: false }] });
    expect(await w.rows(`SELECT user_id FROM user_group_members WHERE group_id = ?1`, made.id)).toHaveLength(0);
    await scim("PATCH", `/Users/${eve}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: true }] });
    expect(await w.rows(`SELECT user_id FROM user_group_members WHERE group_id = ?1`, made.id)).toEqual([{ user_id: eve }]);
  });
});
