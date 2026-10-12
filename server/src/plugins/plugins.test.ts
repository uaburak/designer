/**
 * Private plugins and approval on the server (docs/plugins.md §10; round 5c): publishing in three steps with SHA-1
 * checked parts and chunks, versions, who manages, guests refused; the Extensions settings; approvals for the org and
 * for workspaces; requests, their notifications and answers; Figma's activity actions. node:sqlite, the real handler.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { notificationAction } from "../../../src/shared/notifications";
import { sha1, W1, world, type Any, type World } from "../testing/orgWorld";
import { CHUNK_BYTES, PLUGIN_ID } from "./private";

let w: World;
beforeEach(async () => {
  w = await world();
});

const enc = (s: string) => new TextEncoder().encode(s);
const manifest = (name = "Lorem", extra: Record<string, unknown> = {}) => ({ name, id: "dev-lorem", api: "1.0.0", main: "code.js", ui: "ui.html", editorType: ["figma"], ...extra });
const actions = async () => (await w.rows(`SELECT action, entity_type, entity_id FROM activity_log WHERE action LIKE '%plugin%' OR action LIKE 'widget%' ORDER BY id`)).map((r: Any) => r.action);

/** The store's three steps (§10.1) */
async function publishPlugin(token: string, files: Record<string, Uint8Array>, opts: { pluginId?: string; name?: string; skip?: string[] } = {}) {
  const parts = Object.entries(files).map(([name, b]) => ({ name, sha1: sha1(b), size: b.byteLength }));
  const start = await w.call("POST", `/orgs/${w.orgId}/plugins`, token, { manifest: manifest(opts.name), parts, description: "Fills text", ...(opts.pluginId ? { pluginId: opts.pluginId } : {}) });
  if (start.status !== 200) return { start };
  const { plugin, version, missing } = start.body;
  const uploads = [];
  for (const name of missing as string[]) if (!opts.skip?.includes(name)) uploads.push(await w.call("PUT", `/plugins/${plugin.id}/parts/${version}/${name}`, token, files[name]));
  const commit = await w.call("POST", `/plugins/${plugin.id}/versions/${version}/commit`, token);
  return { start, uploads, commit, id: plugin.id as string, version: version as number, missing: missing as string[] };
}

describe("private plugins (§10.1)", () => {
  it("publish, list, download, update (unchanged parts copied), rename, delete; guests refused", async () => {
    const { bob, carol, gus, alice } = w.people;
    const big = new Uint8Array(CHUNK_BYTES * 2 + 17).map((_, i) => i % 251);
    const p = await publishPlugin(bob.token, { code: big, ui: enc("<p>hi</p>") });
    expect(p.start.status).toBe(200);
    expect(PLUGIN_ID.test(p.id!)).toBe(true);
    expect(p.missing.sort()).toEqual(["code", "ui"]);
    expect(p.uploads!.map((u) => u.status)).toEqual([204, 204]);
    expect(p.commit!.status).toBe(200);
    expect(p.commit!.body.plugin).toMatchObject({ id: p.id, orgId: w.orgId, kind: "plugin", name: "Lorem", description: "Fills text", version: 1, publishedBy: { id: bob.id, name: "bob" }, canManage: true, manifest: { id: p.id, main: "code.js" } });
    expect((await w.rows(`SELECT COUNT(*) AS n FROM plugin_chunks WHERE plugin_id = ?1 AND part = 'code'`, p.id))[0].n).toBe(3);

    // Members list and download; a guest can't
    const list = await w.call("GET", `/orgs/${w.orgId}/plugins`, carol.token);
    expect(list.body.plugins).toEqual([expect.objectContaining({ id: p.id, canManage: false })]);
    const code = await w.call("GET", `/plugins/${p.id}/parts/1/code`, carol.token);
    expect([code.status, sha1(code.bytes), code.headers.get("cache-control")]).toEqual([200, sha1(big), "private, max-age=31536000, immutable"]);
    expect((await w.call("GET", `/orgs/${w.orgId}/plugins`, gus.token)).status).toBe(403);
    expect((await w.call("GET", `/plugins/${p.id}/parts/1/code`, gus.token)).status).toBe(403);
    expect((await w.call("POST", `/orgs/${w.orgId}/plugins`, gus.token, { manifest: manifest(), parts: [{ name: "code", sha1: sha1("x"), size: 1 }] })).status).toBe(403);

    // An update: only the changed part is missing; carol can't update bob's; alice (admin) can
    const v2 = await publishPlugin(bob.token, { code: big, ui: enc("<p>v2</p>") }, { pluginId: p.id });
    expect([v2.missing, v2.version, v2.commit!.body.plugin.version]).toEqual([["ui"], 2, 2]);
    expect((await w.call("GET", `/plugins/${p.id}/parts/2/code`, carol.token)).status).toBe(200);
    expect((await w.call("GET", `/plugins/${p.id}/parts/1/ui`, carol.token)).status).toBe(200); // the previous version stays
    expect((await w.call("POST", `/orgs/${w.orgId}/plugins`, carol.token, { manifest: manifest(), parts: [{ name: "code", sha1: sha1("x"), size: 1 }], pluginId: p.id })).status).toBe(403);
    const v3 = await publishPlugin(alice.token, { code: enc("v3") }, { pluginId: p.id });
    expect(v3.commit!.body.plugin.version).toBe(3);
    expect((await w.call("GET", `/plugins/${p.id}/parts/1/code`, carol.token)).status).toBe(404); // older than the previous

    expect((await w.call("PATCH", `/plugins/${p.id}`, carol.token, { name: "X" })).status).toBe(403);
    expect((await w.call("PATCH", `/plugins/${p.id}`, bob.token, { name: "Lorem ipsum" })).body.plugin.name).toBe("Lorem ipsum");
    expect((await w.call("DELETE", `/plugins/${p.id}`, bob.token)).status).toBe(204);
    expect((await w.call("GET", `/plugins/${p.id}`, bob.token)).status).toBe(404);
    expect((await w.call("GET", `/orgs/${w.orgId}/plugins`, bob.token)).body.plugins).toEqual([]);
    expect(await actions()).toEqual(["private_plugin_publish", "private_plugin_update", "private_plugin_update", "private_plugin_update", "private_plugin_delete"]);
    expect(w.inbox.some((x) => x.userId === carol.id && x.msg.t === "plugins")).toBe(true);
  });

  it("parts are checked: SHA-1 and size, all present at commit, names, widgets refused, stale versions", async () => {
    const { bob } = w.people;
    const p = await publishPlugin(bob.token, { code: enc("a"), ui: enc("b") }, { skip: ["ui"] });
    expect(p.commit!.status).toBe(409);
    expect(p.commit!.body.missing).toEqual(["ui"]);
    expect((await w.call("GET", `/orgs/${w.orgId}/plugins`, bob.token)).body.plugins).toEqual([]); // not committed: unlisted
    expect((await w.call("PUT", `/plugins/${p.id}/parts/1/ui`, bob.token, enc("not b"))).status).toBe(400);
    expect((await w.call("PUT", `/plugins/${p.id}/parts/2/ui`, bob.token, enc("b"))).status).toBe(409);
    expect((await w.call("PUT", `/plugins/${p.id}/parts/1/ui`, bob.token, enc("b"))).status).toBe(204);
    expect((await w.call("POST", `/plugins/${p.id}/versions/1/commit`, bob.token)).status).toBe(200);
    expect((await w.call("POST", `/plugins/${p.id}/versions/1/commit`, bob.token)).status).toBe(409);
    const bad = (parts: unknown, m: unknown = manifest()) => w.call("POST", `/orgs/${w.orgId}/plugins`, bob.token, { manifest: m, parts });
    expect((await bad([{ name: "ui", sha1: sha1("x"), size: 1 }])).body.error).toBe("the code part is required");
    expect((await bad([{ name: "../code", sha1: sha1("x"), size: 1 }])).status).toBe(400);
    expect((await bad([{ name: "code", sha1: sha1("x"), size: 11 * 1024 * 1024 }])).status).toBe(413);
    expect((await bad([{ name: "code", sha1: sha1("x"), size: 1 }], manifest("W", { containsWidget: true, widgetApi: "1.0.0" }))).body.error).toBe("Widgets aren't supported in Designer yet");
  });
});

describe("approval (§10.2) and requests (§10.3)", () => {
  it("the Extensions settings are admins', logged with Figma's names", async () => {
    const { alice, bob } = w.people;
    const patch = (token: string, body: unknown) => w.call("PATCH", `/orgs/${w.orgId}/admin/settings`, token, body);
    expect((await patch(bob.token, { pluginApproval: "approved" })).status).toBe(403);
    expect((await patch(alice.token, { pluginApproval: "some" })).status).toBe(400);
    expect((await patch(alice.token, { pluginApproval: "approved", pluginRequests: false })).body).toMatchObject({ pluginApproval: "approved", pluginRequests: false, widgetApproval: "all" });
    await patch(alice.token, { widgetApproval: "approved" });
    await patch(alice.token, { pluginApproval: "all" });
    expect((await w.rows(`SELECT action, details FROM activity_log WHERE action IN ('plugin_approvelist_enable', 'plugin_approvelist_disable', 'widgets_enabled', 'widgets_disable') ORDER BY id`)).map((r: Any) => r.action)).toEqual(["plugin_approvelist_enable", "widgets_enabled", "plugin_approvelist_disable"]);
  });

  it("members request (when allowed), admins are told and answer; approving answers the covered requests; workspaces", async () => {
    const { alice, bob, carol, gus, wade, fay } = w.people;
    const req = (token: string, body: Record<string, unknown> = {}) => w.call("POST", `/orgs/${w.orgId}/plugins/requests`, token, { pluginId: "1234567890", kind: "plugin", name: "Unsplash", manifest: manifest("Unsplash"), reason: "Photos", ...body });
    const r1 = await req(bob.token);
    expect(r1.status).toBe(201);
    expect(r1.body.request).toMatchObject({ pluginId: "1234567890", name: "Unsplash", state: "pending", requestedBy: { id: bob.id, email: "bob@x.co" }, manifest: { name: "Unsplash" }, reason: "Photos" });
    expect((await req(bob.token)).status).toBe(409); // one pending per person and plugin
    expect((await req(gus.token)).status).toBe(403); // guests
    const n = await w.rows(`SELECT user_id, kind, text, state, file_name FROM notifications WHERE kind = 'plugin_request'`);
    expect(n).toEqual([{ user_id: alice.id, kind: "plugin_request", text: "Unsplash", state: "pending", file_name: "Acme" }]);
    expect(notificationAction({ kind: "plugin_request", count: 1, state: "pending", role: null, text: "Unsplash" })).toBe("Requested approval for Unsplash");

    // A request scoped to W1 also reaches its workspace admin (wade), who sees only W1's requests
    const r2 = await req(fay.token, { workspaceId: W1 });
    expect(r2.status).toBe(201);
    expect((await w.rows(`SELECT user_id FROM notifications WHERE kind = 'plugin_request' AND actor_id = ?1 ORDER BY user_id`, fay.id)).map((r: Any) => r.user_id).sort()).toEqual([alice.id, wade.id].sort());
    const wadeView = await w.call("GET", `/orgs/${w.orgId}/admin/plugins?kind=plugin`, wade.token);
    expect(wadeView.body.requests.map((q: Any) => q.id)).toEqual([r2.body.request.id]);
    expect((await w.call("GET", `/orgs/${w.orgId}/admin/plugins`, bob.token)).status).toBe(403);

    // wade approves fay's for W1 only; can't for the org
    expect((await w.call("POST", `/orgs/${w.orgId}/admin/plugins/requests/${r2.body.request.id}`, wade.token, { approve: true })).status).toBe(403);
    const ok = await w.call("POST", `/orgs/${w.orgId}/admin/plugins/requests/${r2.body.request.id}`, wade.token, { approve: true, workspaceIds: [W1] });
    expect(ok.body.request).toMatchObject({ state: "approved" });
    expect((await w.call("GET", `/orgs/${w.orgId}/plugins/approved`, carol.token)).body.approved).toEqual([expect.objectContaining({ pluginId: "1234567890", scope: { type: "workspace", id: W1 }, addedBy: wade.id })]);
    const answer = (await w.rows(`SELECT kind, state, text FROM notifications WHERE user_id = ?1 AND kind = 'plugin_request_answer'`, fay.id))[0];
    expect(notificationAction({ kind: "plugin_request_answer", count: 1, role: null, ...answer })).toBe("Approved your request for Unsplash");
    expect((await w.rows(`SELECT state FROM notifications WHERE kind = 'plugin_request' AND actor_id = ?1`, fay.id)).map((r: Any) => r.state)).toEqual(["approved", "approved"]);

    // alice declines bob's with a reason; bob may ask again; then alice adds it for the org, answering his new one
    const no = await w.call("POST", `/orgs/${w.orgId}/admin/plugins/requests/${r1.body.request.id}`, alice.token, { approve: false, reason: "Use the DAM" });
    expect(no.body.request).toMatchObject({ state: "declined", declineReason: "Use the DAM" });
    expect((await w.call("POST", `/orgs/${w.orgId}/admin/plugins/requests/${r1.body.request.id}`, alice.token, { approve: true })).status).toBe(409);
    const again = await req(bob.token);
    expect(again.status).toBe(201);
    expect((await w.call("POST", `/orgs/${w.orgId}/admin/plugins/approvals`, alice.token, { pluginId: "1234567890", kind: "plugin", name: "Unsplash", scope: { type: "org" } })).status).toBe(204);
    expect((await w.call("GET", `/orgs/${w.orgId}/plugins/requests`, bob.token)).body.requests.map((q: Any) => q.state)).toEqual(["approved", "declined"]);
    expect((await req(carol.token)).status).toBe(409); // already approved

    // Removing: the workspace row by its admin, the org row by an org admin
    expect((await w.call("DELETE", `/orgs/${w.orgId}/admin/plugins/approvals/1234567890`, wade.token)).status).toBe(403);
    expect((await w.call("DELETE", `/orgs/${w.orgId}/admin/plugins/approvals/1234567890?workspace=${W1}`, wade.token)).status).toBe(204);
    expect((await w.call("DELETE", `/orgs/${w.orgId}/admin/plugins/approvals/1234567890`, alice.token)).status).toBe(204);
    expect((await w.call("DELETE", `/orgs/${w.orgId}/admin/plugins/approvals/1234567890`, alice.token)).status).toBe(404);

    // Requests off: refused
    await w.call("PATCH", `/orgs/${w.orgId}/admin/settings`, alice.token, { pluginRequests: false });
    expect((await req(carol.token)).status).toBe(403);

    expect(await actions()).toEqual([
      "plugin_approvelist_request_org",
      "plugin_approvelist_request_org",
      "plugin_approvelist_add_workspace",
      "plugin_approvelist_request_approve_workspace",
      "plugin_approvelist_request_reject_org",
      "plugin_approvelist_request_org",
      "plugin_approvelist_add",
      "plugin_approvelist_remove_workspace",
      "plugin_approvelist_remove",
      // the requests switch rides with its kind's approval action (approval is "all": disable)
      "plugin_approvelist_disable",
    ]);
  });

  it("widgets: approval rows and requests stored with kind widget, Figma's widget actions", async () => {
    const { alice, bob } = w.people;
    expect((await w.call("POST", `/orgs/${w.orgId}/plugins/requests`, bob.token, { pluginId: "999", kind: "widget", name: "Voting", manifest: {}, reason: "" })).body.request.manifest).toBeNull();
    await w.call("POST", `/orgs/${w.orgId}/admin/plugins/approvals`, alice.token, { pluginId: "999", kind: "widget", name: "Voting", scope: { type: "workspace", ids: [W1] } });
    expect((await w.call("GET", `/orgs/${w.orgId}/admin/plugins?kind=widget`, alice.token)).body.approved).toEqual([expect.objectContaining({ kind: "widget", scope: { type: "workspace", id: W1 } })]);
    expect((await w.call("GET", `/orgs/${w.orgId}/admin/plugins?kind=plugin`, alice.token)).body.approved).toEqual([]);
    expect(await actions()).toEqual(["widget_approvelist_request_org", "widget_approvelist_add_workspace"]);
  });
});
