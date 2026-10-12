/**
 * Round 14 review fixes (docs/governance.md "§9 Review fixes"): the Governance+ gates on `/v1` REST, the org-file
 * routes outside `/files/:key/…` and previews of org files; REST's export restriction; developer logs' filters as own
 * keys only. The real handler over node:sqlite (testing/restWorld.ts).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { LIB, T1, type Any } from "../testing/orgWorld";
import { restWorld, type RestWorld } from "../testing/restWorld";
import { forgetGovernanceOrgs } from "../discovery/record";

let w: RestWorld;
beforeEach(async () => {
  w = await restWorld();
});

const admin = (method: string, path: string, body?: unknown) => w.call(method, `/orgs/${w.orgId}/admin/${path}`, w.people.alice.token, body);

/** Governance+ on and a members' policy nobody agreed to yet: every member is gated */
async function gatedByPolicy(): Promise<string> {
  expect((await admin("PUT", "governance", { governancePlus: true })).status).toBe(200);
  forgetGovernanceOrgs(w.d1);
  const p = await admin("POST", "policies", { title: "Acceptable use", text: "Be nice.", audience: "members", cadence: "once" });
  expect(p.status).toBe(201);
  return p.body.policy.id as string;
}

const SCOPES = ["file_content:read", "file_metadata:read", "folders:read", "library_content:read"];

describe("/v1 REST gates (§2.5)", () => {
  it("a gated member gets 403 with the gate's code on file and team routes; link visitors from outside aren't gated; agreeing opens it", async () => {
    await w.run(`UPDATE files SET link_access = 'viewer' WHERE key = ?1`, LIB);
    const bobPat = await w.pat("bob", SCOPES);
    const olgaPat = await w.pat("olga", SCOPES);
    const before = await w.rest("GET", `/v1/files/${LIB}/meta`, bobPat);
    expect(before.status).toBe(200);
    const id = await gatedByPolicy();
    const meta = await w.rest("GET", `/v1/files/${LIB}/meta`, bobPat);
    expect(meta.status).toBe(403);
    expect(meta.body).toMatchObject({ status: 403, code: "policy_acknowledgement_required", gate: { kind: "policy" } });
    const team = await w.rest("GET", `/v1/teams/${T1}/projects`, bobPat);
    expect(team.status).toBe(403);
    expect(team.body).toMatchObject({ error: true, code: "policy_acknowledgement_required" });
    expect((await w.rest("GET", `/v1/files/${LIB}/components`, bobPat)).body.code).toBe("policy_acknowledgement_required");
    // olga isn't in the org: the link opens it as before
    expect((await w.rest("GET", `/v1/files/${LIB}/meta`, olgaPat)).status).toBe(200);
    expect((await w.call("POST", `/orgs/${w.orgId}/policies/${id}/acknowledge`, w.people.bob.token)).status).toBe(204);
    expect((await w.rest("GET", `/v1/files/${LIB}/meta`, bobPat)).status).toBe(200);
    expect((await w.rest("GET", `/v1/teams/${T1}/projects`, bobPat)).status).toBe(200);
  });

  it("a plan token acts as the org: never gated", async () => {
    const plan = await w.planToken(["org:activity_log_read"]);
    await gatedByPolicy();
    expect((await w.rest("GET", "/v1/activity_logs", plan)).status).toBe(200);
  });
});

describe("REST export restriction (§2.7)", () => {
  it("/v1/images and image fills answer 403 export_restricted when the caller can't export", async () => {
    await w.run(`INSERT INTO members (file_key, email, user_id, role, created_at) VALUES (?1, 'carol@x.co', ?2, 'viewer', 0)`, LIB, w.people.carol.id);
    expect((await admin("PUT", "governance", { governancePlus: true })).status).toBe(200);
    expect((await admin("PATCH", "settings", { fileExporting: "viewers_blocked" })).status).toBe(200);
    const carolPat = await w.pat("carol", SCOPES);
    const render = await w.rest("GET", `/v1/images/${LIB}?ids=1:2`, carolPat);
    expect(render.status).toBe(403);
    expect(render.body).toMatchObject({ status: 403, code: "export_restricted" });
    const fills = await w.rest("GET", `/v1/files/${LIB}/images`, carolPat);
    expect(fills.status).toBe(403);
    expect(fills.body.code).toBe("export_restricted");
    // an editor exports as ever
    const bobPat = await w.pat("bob", SCOPES);
    expect((await w.rest("GET", `/v1/files/${LIB}/images`, bobPat)).status).toBe(200);
  });
});

describe("org-file routes outside /files/:key/… (§2.5)", () => {
  it("/libraries?file=, /files/:key/libraries and a preview of an org file are gated for the org's people", async () => {
    await gatedByPolicy();
    const bob = w.people.bob.token;
    for (const path of [`/libraries?file=${LIB}`, `/files/${LIB}/libraries`]) {
      const r = await w.call("GET", path, bob);
      expect(r.status, path).toBe(403);
      expect(r.body.code, path).toBe("policy_acknowledgement_required");
    }
    // A preview naming an org file (previews' file keys are 22 characters)
    const key = "G".repeat(22);
    await w.run(`INSERT INTO files (key, owner_id, name, created_at, updated_at, org_id, team_id, project_id) SELECT ?1, owner_id, name, created_at, updated_at, org_id, team_id, project_id FROM files WHERE key = ?2`, key, LIB);
    (w.deps.env as Any).DB = w.d1;
    const id = "P".repeat(22);
    const manifest = { format: 1, previewId: id, fileName: "Landing", publishedAt: w.now.t, expiresAt: null, pages: [{ id: "0:1", name: "Page 1", frames: [] }], snapshot: "doc.kiwi", documentFormatVersion: 1, derivedDataVersion: 1, images: [], options: { inspect: true, export: true } };
    const p = await w.call("PUT", `/previews/${id}/manifest`, bob, { manifest, fileKey: key });
    expect(p.status).toBe(403);
    expect(p.body).toMatchObject({ code: "policy_acknowledgement_required", gate: { kind: "policy" } });
  });
});

describe("developer logs' filters (§2.12)", () => {
  it("a filter naming an object's own property (toString) is 400, not 500", async () => {
    expect((await admin("PUT", "governance", { governancePlus: true })).status).toBe(200);
    const plan = await w.planToken(["org:developer_log_read"]);
    for (const body of [{ date_range: "toString" }, { token_type: "constructor" }, { event_source: "__proto__" }, { date_range: 5 }]) {
      const r = await w.rest("POST", "/v1/developer_logs", plan, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });
});
