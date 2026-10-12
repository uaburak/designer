/**
 * Round 14b — Governance+'s org policy (docs/governance.md §2.1, §2.3, §2.5–§2.7, §2.13, §3, §4) on the real handler
 * over node:sqlite (testing/orgWorld.ts): the add-on switch, the IP allowlist, network ranges, internal policies, 2FA for
 * guests, guest expiration, file exporting, Discovery's room policy and the gates.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { LIB, T1, W1, WEB, world, type Any, type World } from "../testing/orgWorld";
import { sweepExpiredGuests } from "./guests";
import { orgGate } from "./gate";
import { dayOf } from "./ip";

let w: World;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OUT = "203.0.113.9";
const IN = "198.51.100.7";

beforeEach(async () => {
  w = await world();
});

const admin = (method: string, path: string, body?: unknown, ip = IN) => w.call(method, `/orgs/${w.orgId}/admin/${path}`, w.people.alice.token, body, { "cf-connecting-ip": ip });
const settings = (patch: Record<string, unknown>) => admin("PATCH", "settings", patch);
const gPlus = async (on = true) => expect((await admin("PUT", "governance", { governancePlus: on })).status).toBe(200);
const actions = async () => (await w.rows<{ action: string }>(`SELECT action FROM activity_log WHERE org_id = ?1 ORDER BY id`, w.orgId)).map((r) => r.action);
/** Sessions last 30 days: after a long jump in time, everyone signs in again */
const later = async (ms: number) => {
  w.now.t += ms;
  for (const n of Object.keys(w.people) as (keyof World["people"])[]) w.people[n].token = (await w.call("POST", "/auth/dev", undefined, { email: `${n}@x.co`, name: n })).body.token;
};
const as = (who: keyof World["people"], method: string, path: string, ip = IN, body?: unknown, extra: Record<string, string> = {}) => w.call(method, path, w.people[who].token, body, { "cf-connecting-ip": ip, ...extra });

describe("the add-on (§2.1)", () => {
  it("is off by default: G+ routes answer governance_plus_required, the overview still reads", async () => {
    for (const [m, p, b] of [["PUT", "ip-allowlist", { enabled: false, ranges: [] }], ["GET", "policies"], ["POST", "network-ranges", { cidr: "10.1.0.0/16" }], ["PUT", "guests/expiration", { userIds: ["x"], expiresAt: null }]] as const) {
      const r = await admin(m, p, b);
      expect(r.status, p).toBe(403);
      expect(r.body.code).toBe("governance_plus_required");
    }
    const o = await admin("GET", "governance");
    expect(o.status).toBe(200);
    expect(o.body).toMatchObject({ governancePlus: false, callerIp: IN, ipAllowlist: { enabled: false, ranges: [] }, networkRanges: [], policies: [], guestsWithout2fa: 1, ekm: { enabled: false, files: { total: 5, encrypted: 0 } } });
    expect((await settings({ twoFactorForGuests: true })).body.code).toBe("governance_plus_required");
    expect((await settings({ idleSessionTimeoutHours: 0.25 })).status).toBe(400);
    // Only org admins
    expect((await as("bob", "GET", `/orgs/${w.orgId}/admin/governance`)).status).toBe(403);
  });

  it("Add / Remove: logged; idle quarter hours with it, clamped to 12 h on removal; refused while key management is on", async () => {
    await gPlus();
    expect((await settings({ idleSessionTimeoutHours: 0.25 })).body.idleSessionTimeoutHours).toBe(0.25);
    expect((await settings({ idleSessionTimeoutHours: 0.3 })).status).toBe(400);
    expect((await settings({ idleSessionTimeoutHours: 12.5 })).status).toBe(200);
    await gPlus(false);
    const info = await as("alice", "GET", `/orgs/${w.orgId}`);
    expect(info.body.org.settings.idleSessionTimeoutHours).toBe(13);
    expect(info.body.org.governancePlus).toBe(false);
    expect(await actions()).toEqual(expect.arrayContaining(["governance_plus_enable", "governance_plus_disable", "idle_timeout_setting_change"]));
    await gPlus();
    await w.run(`INSERT INTO org_keys (org_id, wrapped_dek, created_at, updated_at) VALUES (?1, 'x', 0, 0)`, w.orgId);
    const r = await admin("PUT", "governance", { governancePlus: false });
    expect(r.status).toBe(409);
    expect((await admin("GET", "governance")).body.ekm).toMatchObject({ enabled: true, source: "managed", state: "ok" });
  });

  it("the stored values stay and stop being enforced when it is removed", async () => {
    await gPlus();
    expect((await admin("PUT", "ip-allowlist", { enabled: true, ranges: [`${IN}/32`] })).status).toBe(200);
    expect((await as("bob", "GET", `/orgs/${w.orgId}/teams`, OUT)).status).toBe(403);
    await gPlus(false);
    expect((await as("bob", "GET", `/orgs/${w.orgId}/teams`, OUT)).status).toBe(200);
    await gPlus();
    expect((await as("bob", "GET", `/orgs/${w.orgId}/teams`, OUT)).status).toBe(403);
  });
});

describe("IP allowlist (§2.3)", () => {
  beforeEach(() => gPlus());

  it("validates, normalizes and diffs the list into one log per range", async () => {
    expect((await admin("PUT", "ip-allowlist", { enabled: true, ranges: ["10.0.0.0/33"] })).status).toBe(400);
    expect((await admin("PUT", "ip-allowlist", { enabled: true, ranges: [] })).status).toBe(400);
    const r = await admin("PUT", "ip-allowlist", { enabled: true, ranges: ["198.51.100.0/24", "2001:DB8::1/32", "192.0.2.5"] });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.ranges.map((x: Any) => x.cidr)).toEqual(["198.51.100.0/24", "2001:db8::/32", "192.0.2.5/32"]);
    expect(r.body.ranges[0].createdBy.id).toBe(w.people.alice.id);
    const r2 = await admin("PUT", "ip-allowlist", { enabled: false, ranges: ["198.51.100.0/24", "203.0.113.0/24"] });
    expect(r2.body).toMatchObject({ enabled: false });
    expect(r2.body.ranges).toHaveLength(2);
    const a = await actions();
    expect(a.filter((x) => x === "ip_allowlist_range_create")).toHaveLength(4);
    expect(a.filter((x) => x === "ip_allowlist_range_delete")).toHaveLength(2);
    expect(a.filter((x) => x === "ip_allowlist_setting_change")).toHaveLength(2);
    // Unverified domains block turning it on (Figma's prerequisite)
    await w.run(`INSERT INTO org_domains (org_id, domain, token, created_at) VALUES (?1, 'x.co', 't', 0)`, w.orgId);
    expect((await admin("PUT", "ip-allowlist", { enabled: true, ranges: ["10.0.0.0/8"] })).body.code).toBe("domain_unverified");
  });

  it("blocks members outside it on org routes, file routes and the socket; admins and guests are exempt; IPv6 works", async () => {
    await admin("PUT", "ip-allowlist", { enabled: true, ranges: ["198.51.100.0/24", "2001:db8::/32"] });
    const r = await as("bob", "GET", `/orgs/${w.orgId}/teams`, OUT);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "ip_not_allowed", gate: { kind: "ip", ip: OUT } });
    expect((await as("bob", "GET", `/orgs/${w.orgId}/teams`, IN)).status).toBe(200);
    expect((await as("bob", "GET", `/orgs/${w.orgId}/teams`, "2001:db8:5::1")).status).toBe(200);
    expect((await as("bob", "GET", `/files/${LIB}`, OUT)).body.code).toBe("ip_not_allowed");
    expect((await as("bob", "GET", `/teams/${T1}`, OUT)).body.code).toBe("ip_not_allowed");
    const before = w.rooms.length;
    expect((await as("bob", "GET", `/files/${LIB}/ws`, OUT, undefined, { upgrade: "websocket" })).status).toBe(403);
    expect(w.rooms.length).toBe(before);
    expect((await as("alice", "GET", `/orgs/${w.orgId}/teams`, OUT)).status).toBe(200);
    expect((await as("gus", "GET", `/files/${LIB}`, OUT)).status).toBe(200);
    // GET /orgs carries the gate (Home prompts before opening the space); GET /orgs/:org isn't gated
    const orgs = await as("bob", "GET", "/orgs", OUT);
    expect(orgs.body.orgs[0].gate).toEqual({ kind: "ip", ip: OUT });
    expect((await as("bob", "GET", `/orgs/${w.orgId}`, OUT)).body.org.gate).toEqual({ kind: "ip", ip: OUT });
    expect((await as("bob", "GET", "/orgs", IN)).body.orgs[0].gate).toBeUndefined();
    // ip_allowlist_rejected: at most once per person per hour
    expect((await actions()).filter((x) => x === "ip_allowlist_rejected")).toHaveLength(1);
    w.now.t += HOUR + 1;
    await as("bob", "GET", `/orgs/${w.orgId}/teams`, OUT);
    expect((await actions()).filter((x) => x === "ip_allowlist_rejected")).toHaveLength(2);
    // The gate's own helper agrees
    expect(await orgGate(w.deps, { id: w.people.bob.id, email: "bob@x.co", name: "bob", picture: null, tokenVersion: 0 }, w.orgId, new Request("https://x/", { headers: { "cf-connecting-ip": IN } }))).toBeNull();
  });
});

describe("network ranges (§2.2, self-serve)", () => {
  beforeEach(() => gPlus());

  it("CRUD with prefix limits, states, shadow counts and the logs", async () => {
    expect((await admin("POST", "network-ranges", { cidr: "10.0.0.0/8" })).status).toBe(400);
    expect((await admin("POST", "network-ranges", { cidr: "2001:db8::/16" })).status).toBe(400);
    const c = await admin("POST", "network-ranges", { cidr: "10.20.0.0/16" });
    expect(c.status).toBe(201);
    expect(c.body.range).toMatchObject({ cidr: "10.20.0.0/16", state: "testing", wouldBlock7d: 0 });
    expect((await admin("POST", "network-ranges", { cidr: "10.20.1.1/16" })).status).toBe(409);
    const id = c.body.range.id;
    const today = dayOf(w.now.t);
    for (const [u, d] of [["a", today], ["b", today - 3], ["a", today - 1], ["c", today - 9]] as const) await w.run(`INSERT INTO network_shadow_hits (range_id, user_id, day) VALUES (?1, ?2, ?3)`, id, u, d);
    expect((await admin("GET", "network-ranges")).body.ranges[0].wouldBlock7d).toBe(2);
    expect((await admin("PATCH", `network-ranges/${id}`, { state: "on" })).status).toBe(400);
    expect((await admin("PATCH", `network-ranges/${id}`, { state: "enforced" })).body.range.state).toBe("enforced");
    expect((await admin("GET", "governance")).body.networkRanges).toHaveLength(1);
    expect((await admin("DELETE", `network-ranges/${id}`)).status).toBe(204);
    expect((await admin("DELETE", `network-ranges/${id}`)).status).toBe(404);
    const a = await actions();
    expect(a).toEqual(expect.arrayContaining(["network_access_restriction_range_create", "network_access_restriction_range_update", "network_access_restriction_range_delete"]));
    expect(a.filter((x) => x === "ip_restriction_change")).toHaveLength(2);
  });
});

describe("internal policies (§2.6)", () => {
  beforeEach(() => gPlus());
  const create = (b: Record<string, unknown>) => admin("POST", "policies", { title: "Acceptable use", text: "Be nice.", audience: "members", cadence: "once", ...b });

  it("prompt once, agree, never edited; disabled stops prompting; audiences", async () => {
    expect((await create({ title: "" })).status).toBe(400);
    expect((await create({ audience: "all" })).status).toBe(400);
    const p = (await create({})).body.policy;
    expect(p).toMatchObject({ title: "Acceptable use", audience: "members", cadence: "once", disabledAt: null, acknowledgedCount: 0 });
    expect(p.enabledAt).toBe(w.now.t);
    const r = await as("bob", "GET", `/orgs/${w.orgId}/teams`);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "policy_acknowledgement_required", gate: { kind: "policy", policies: [{ id: p.id, title: "Acceptable use", text: "Be nice." }] } });
    // Admins are members too; guests aren't in a members' policy
    expect((await as("alice", "GET", `/orgs/${w.orgId}/admin/dashboard`)).status).toBe(403);
    expect((await as("gus", "GET", `/files/${LIB}`)).status).toBe(200);
    expect((await as("bob", "GET", `/orgs/${w.orgId}/policies/pending`)).body.policies).toEqual([{ id: p.id, title: "Acceptable use", text: "Be nice." }]);
    expect((await as("gus", "POST", `/orgs/${w.orgId}/policies/${p.id}/acknowledge`)).status).toBe(404);
    expect((await as("bob", "POST", `/orgs/${w.orgId}/policies/${p.id}/acknowledge`)).status).toBe(204);
    expect((await as("bob", "GET", `/orgs/${w.orgId}/teams`)).status).toBe(200);
    expect((await as("bob", "GET", `/orgs/${w.orgId}/policies/pending`)).body.policies).toEqual([]);
    await later(400 * DAY);
    expect((await as("bob", "GET", `/orgs/${w.orgId}/teams`)).status).toBe(200);
    expect((await as("alice", "POST", `/orgs/${w.orgId}/policies/${p.id}/acknowledge`)).status).toBe(204);
    expect((await admin("PATCH", `policies/${p.id}`, { title: "New" })).status).toBe(400);
    const off = await admin("PATCH", `policies/${p.id}`, { enabled: false });
    expect(off.body.policy).toMatchObject({ acknowledgedCount: 2, disabledAt: w.now.t });
    expect((await as("carol", "GET", `/orgs/${w.orgId}/teams`)).status).toBe(200);
    const a = await actions();
    expect(a).toEqual(expect.arrayContaining(["policy_create", "policy_acknowledge", "policy_update"]));
    const ent = (await w.rows(`SELECT entity_type, entity FROM activity_log WHERE action = 'policy_create'`))[0];
    expect(ent.entity_type).toBe("policy_acknowledgement_config");
    expect(JSON.parse(ent.entity)).toMatchObject({ title: "Acceptable use", audience: "members", cadence: "once", enabled_status: "enabled" });
  });

  it("once a year: asked again 365 days after the last agreement; guests' policies", async () => {
    const p = (await create({ audience: "everyone", cadence: "yearly" })).body.policy;
    await as("gus", "POST", `/orgs/${w.orgId}/policies/${p.id}/acknowledge`);
    expect((await as("gus", "GET", `/files/${LIB}`)).status).toBe(200);
    await later(365 * DAY);
    const r = await as("gus", "GET", `/files/${LIB}`);
    expect(r.body.code).toBe("policy_acknowledgement_required");
    await as("alice", "POST", `/orgs/${w.orgId}/policies/${p.id}/acknowledge`);
    const g = (await create({ title: "Guests", audience: "guests" })).body.policy;
    expect((await as("gus", "GET", `/orgs/${w.orgId}/policies/pending`)).body.policies.map((x: Any) => x.id)).toEqual([p.id, g.id]);
  });
});

describe("2FA for guests (§2.4, §2.5)", () => {
  it("blocks guests without 2FA, not members; People shows it and the CSV's 2FA_enabled", async () => {
    await gPlus();
    expect((await settings({ twoFactorForGuests: true })).status).toBe(200);
    const r = await as("gus", "GET", `/files/${LIB}`);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "two_factor_required", gate: { kind: "two_factor" } });
    expect((await as("bob", "GET", `/files/${LIB}`)).status).toBe(200);
    await w.run(`INSERT INTO user_two_factor (user_id, secret, enabled_at, created_at) VALUES (?1, 's', 1, 1)`, w.people.gus.id);
    expect((await as("gus", "GET", `/files/${LIB}`)).status).toBe(200);
    const people = await admin("GET", "people?role=guest");
    expect(people.body.items[0]).toMatchObject({ email: "gus@x.co", twoFactor: true, guestExpiresAt: null });
    const csv = (await admin("GET", "people?format=csv")).body as string;
    expect(csv.split("\n")[0]).toContain("2FA_enabled");
    expect(csv).toMatch(/gus@x\.co.*,true\n/);
    expect(await actions()).toContain("mfa_required_setting_change");
    expect((await admin("GET", "governance")).body.guestsWithout2fa).toBe(0);
  });
});

describe("guest expiration (§2.13)", () => {
  beforeEach(() => gPlus());

  it("set on join from the default; changed by admins; lazily expired, then removed by the cron", async () => {
    expect((await settings({ guestExpiryDays: 0 })).status).toBe(400);
    expect((await settings({ guestExpiryDays: 30 })).status).toBe(200);
    expect(await actions()).toContain("org_guest_expiration_setting_change");
    await admin("POST", "people", { emails: ["gina@y.co"], role: "guest" });
    const [g] = await w.rows(`SELECT expires_at FROM org_members WHERE email = 'gina@y.co'`);
    expect(g.expires_at).toBe(w.now.t + 30 * DAY);
    // Members get none
    await admin("POST", "people", { emails: ["mia@y.co"], role: "member" });
    expect((await w.rows(`SELECT expires_at FROM org_members WHERE email = 'mia@y.co'`))[0].expires_at).toBeNull();
    // Admin sets gus's date
    expect((await admin("PUT", "guests/expiration", { userIds: [w.people.gus.id], expiresAt: w.now.t - 1 })).status).toBe(400);
    expect((await admin("PUT", "guests/expiration", { userIds: [w.people.bob.id], expiresAt: w.now.t + HOUR })).status).toBe(400);
    expect((await admin("PUT", "guests/expiration", { userIds: [w.people.gus.id], expiresAt: w.now.t + HOUR })).status).toBe(204);
    expect(await actions()).toContain("org_user_guest_expiration_change");
    const orgs = await as("gus", "GET", "/orgs");
    expect(orgs.body.orgs[0]).toMatchObject({ role: "guest", guestExpiresAt: w.now.t + HOUR });
    expect((await admin("GET", "people?role=guest")).body.items.find((p: Any) => p.email === "gus@x.co").guestExpiresAt).toBe(w.now.t + HOUR);
    w.now.t += 2 * HOUR;
    // Lazily: not a member any more
    expect((await as("gus", "GET", "/orgs")).body.orgs).toEqual([]);
    expect((await as("gus", "GET", `/orgs/${w.orgId}`)).status).toBe(404);
    expect((await as("gus", "GET", `/files/${LIB}`)).status).toBe(200); // still a file member (viewer): outside the org now
    expect((await sweepExpiredGuests(w.deps))).toBe(1);
    expect(await w.rows(`SELECT * FROM org_members WHERE user_id = ?1`, w.people.gus.id)).toEqual([]);
    const del = (await w.rows(`SELECT details FROM activity_log WHERE action = 'org_user_delete'`)).map((r) => JSON.parse(r.details));
    expect(del).toEqual([{ role: "guest", reason: "guest_expired" }]);
    expect((await as("gus", "GET", `/files/${LIB}`)).status).toBe(404);
  });

  it("without the add-on nothing expires", async () => {
    await admin("PUT", "guests/expiration", { userIds: [w.people.gus.id], expiresAt: w.now.t + HOUR });
    await gPlus(false);
    w.now.t += 2 * HOUR;
    expect((await as("gus", "GET", "/orgs")).body.orgs).toHaveLength(1);
    expect(await sweepExpiredGuests(w.deps)).toBe(0);
  });
});

describe("file exporting (§2.7)", () => {
  const exportAs = (who: keyof World["people"], key = LIB) => as(who, "POST", `/files/${key}/activity`, IN, { action: "fig_file_export" });
  const canExport = async (who: keyof World["people"], key = LIB) => (await as(who, "GET", `/files/${key}`)).body.access?.canExport;

  beforeEach(async () => {
    // carol: a member who can view the library; olga: outside the org, by the link
    await w.run(`INSERT INTO members (file_key, email, user_id, role, created_at) VALUES (?1, 'carol@x.co', ?2, 'viewer', 0)`, LIB, w.people.carol.id);
    await w.run(`UPDATE files SET link_access = 'viewer' WHERE key = ?1`, LIB);
  });

  it("needs the add-on; guests_blocked stops guests and outside link visitors, viewers_blocked every viewer; editors always", async () => {
    expect((await settings({ fileExporting: "guests_blocked" })).body.code).toBe("governance_plus_required");
    await gPlus();
    expect((await as("carol", "GET", `/files/${LIB}`)).body.policy.fileExporting).toBe("all");
    expect((await settings({ fileExporting: "nobody" })).status).toBe(400);
    expect((await settings({ fileExporting: "guests_blocked" })).status).toBe(200);
    expect(await canExport("gus")).toBe(false);
    expect(await canExport("olga")).toBe(false);
    expect(await canExport("carol")).toBe(true);
    expect(await canExport("bob")).toBe(true);
    const r = await exportAs("gus");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("export_restricted");
    expect((await as("gus", "GET", `/files/${LIB}/snapshot?purpose=export`)).body.code).toBe("export_restricted");
    expect((await exportAs("carol")).status).toBe(204);
    await settings({ fileExporting: "viewers_blocked" });
    expect(await canExport("carol")).toBe(false);
    expect(await canExport("bob")).toBe(true);
    expect((await exportAs("bob")).status).toBe(204);
    expect(await actions()).toContain("file_export_controls_setting_change");
    // The workspace's setting overrides the org's (LIB's team is in W1); WEB's team too
    const ws = await admin("PATCH", `workspaces/${W1}`, { sharing: { fileExporting: "all" } });
    expect(ws.status).toBe(200);
    expect(ws.body.workspace.sharing).toEqual({ fileExporting: "all" });
    expect(await canExport("carol")).toBe(true);
    expect(await canExport("gus")).toBe(true);
    expect(await actions()).toContain("workspace_file_export_controls_setting_change");
    expect(await actions()).not.toContain("workspace_public_link_setting_change");
    expect((await admin("PATCH", `workspaces/${W1}`, { sharing: { fileExporting: "x" } })).status).toBe(400);
    // Removing the add-on lifts the restriction
    await settings({ fileExporting: "viewers_blocked" });
    await admin("PATCH", `workspaces/${W1}`, { sharing: null });
    expect(await canExport("carol")).toBe(false);
    await gPlus(false);
    expect(await canExport("carol")).toBe(true);
    expect((await as("carol", "GET", `/files/${LIB}`)).body.policy.fileExporting).toBeUndefined();
    expect((await admin("PATCH", `workspaces/${W1}`, { sharing: { fileExporting: "all" } })).body.code).toBe("governance_plus_required");
  });
});

describe("Discovery's room policy (§2.11)", () => {
  it("x-policy carries discovery with the add-on and the setting on", async () => {
    await gPlus();
    expect((await settings({ discovery: true })).status).toBe(200);
    expect(w.rooms.filter((r) => r.path === "/room/policy").length).toBeGreaterThan(0);
    await as("carol", "GET", `/files/${WEB}/ws`, IN, undefined, { upgrade: "websocket" });
    expect(w.rooms.at(-1)).toMatchObject({ path: "/room/ws", policy: { cursorChat: true, audio: true, discovery: true } });
    expect(await actions()).toContain("discovery_setting_change");
    await gPlus(false);
    await as("carol", "GET", `/files/${WEB}/ws`, IN, undefined, { upgrade: "websocket" });
    expect(w.rooms.at(-1)!.policy).toEqual({ cursorChat: true, audio: true });
  });
});
