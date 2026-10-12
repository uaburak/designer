import { gunzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { validateShape } from "../../../src/shared/rest/variablesPost";
import { canonical } from "./roomJobs";
import { filePart, jsonPart, restWorld, sha1, type RestWorld } from "../testing/restWorld";
import { DRAFT, LIB, P1, P3, T1, WEB, type Any } from "../testing/orgWorld";
import { signPath } from "./signedUrl";

let w: RestWorld;
const png = (s: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new TextEncoder().encode(s)]);

beforeEach(async () => {
  w = await restWorld();
});

describe("auth, scopes and errors (§16.3, §16.5)", () => {
  it("takes X-Figma-Token and Bearer PATs and sessions; refuses bad tokens, missing scopes and plan tokens on files", async () => {
    expect((await w.rest("GET", "/v1/me")).status).toBe(403);
    expect((await w.rest("GET", "/v1/me", "dsgn_nope")).body).toEqual({ status: 403, error: true, message: "Invalid token" });
    const pat = await w.pat("bob", ["current_user:read"]);
    const me = await w.rest("GET", "/v1/me", pat);
    expect(me.body).toEqual({ id: w.people.bob.id, email: "bob@x.co", handle: "bob", img_url: null });
    expect(me.headers.get("access-control-allow-origin")).toBe("*");
    expect(me.headers.get("x-figma-rate-limit-type")).toBe("high");
    expect((await w.call("GET", "/v1/me", pat)).status).toBe(200);
    expect((await w.call("GET", "/v1/me", w.people.bob.token)).status).toBe(200);
    // A /v1/files route answers {status, err}; the scope is named
    const meta = await w.rest("GET", `/v1/files/${LIB}/meta`, pat);
    expect(meta.status).toBe(403);
    expect(meta.body.err).toMatch(/file_metadata:read/);
    const plan = await w.planToken(["webhooks:read"]);
    expect((await w.rest("GET", `/v1/files/${LIB}/meta`, plan)).status).toBe(403);
    // A plan token is no personal token on the private API
    expect((await w.call("GET", "/files", plan)).status).toBe(401);
    expect((await w.rest("GET", "/v1/oauth/token", pat)).status).toBe(404);
    const pre = await w.call("OPTIONS", "/v1/me", undefined, undefined, { origin: "https://example.org" });
    expect([pre.status, pre.headers.get("access-control-allow-origin")]).toEqual([204, "*"]);
  });

  it("plan tokens: org admins only, shown once, allowed scopes, revoked; listed apart from personal tokens", async () => {
    expect((await w.call("POST", `/orgs/${w.orgId}/admin/plan-tokens`, w.people.bob.token, { description: "x", expiresInDays: 30, scopes: ["webhooks:read"] })).status).toBe(403);
    expect((await w.call("POST", `/orgs/${w.orgId}/admin/plan-tokens`, w.people.alice.token, { description: "x", expiresInDays: 30, scopes: ["file_content:read"] })).status).toBe(400);
    expect((await w.call("POST", `/orgs/${w.orgId}/admin/plan-tokens`, w.people.alice.token, { description: "x", expiresInDays: 400, scopes: ["webhooks:read"] })).status).toBe(400);
    const token = await w.planToken(["org:activity_log_read"]);
    expect(token.startsWith("dsgn_plan_")).toBe(true);
    const list = (await w.call("GET", `/orgs/${w.orgId}/admin/plan-tokens`, w.people.alice.token)).body.tokens;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "plan", orgId: w.orgId, scopes: ["org:activity_log_read"] });
    expect(JSON.stringify(list)).not.toContain(token);
    expect((await w.call("GET", "/me/tokens", w.people.alice.token)).body.tokens).toEqual([]);
    expect((await w.rest("GET", "/v1/activity_logs", token)).status).toBe(200);
    expect((await w.rows(`SELECT action FROM activity_log WHERE action LIKE 'plan_access_token%'`)).map((r: Any) => r.action)).toEqual(["plan_access_token_create"]);
    await w.call("DELETE", `/orgs/${w.orgId}/admin/plan-tokens/${list[0].id}`, w.people.alice.token);
    expect((await w.rest("GET", "/v1/activity_logs", token)).status).toBe(403);
  });
});

describe("rate limits (§16.4)", () => {
  it("high seats: 20 Tier 1 calls a minute, then 429 with Figma's headers; the next minute is fresh", async () => {
    const pat = await w.pat("alice", ["file_metadata:read", "file_content:read"]);
    for (let i = 0; i < 20; i++) expect((await w.rest("GET", `/v1/images/${LIB}`, pat)).status).toBe(400);
    const r = await w.rest("GET", `/v1/images/${LIB}`, pat);
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ status: 429, err: "Rate limit exceeded" });
    expect(r.headers.get("x-figma-plan-tier")).toBe("enterprise");
    expect(r.headers.get("x-figma-rate-limit-type")).toBe("high");
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    // Tier 3 counts apart
    expect((await w.rest("GET", `/v1/files/${LIB}/meta`, pat)).status).toBe(200);
    w.now.t += 60_000;
    expect((await w.rest("GET", `/v1/images/${LIB}`, pat)).status).toBe(400);
  });

  it("low seats: Tier 1 is 20 a day, Tier 3 10 a minute; the daily cap is 5,000", async () => {
    const pat = await w.pat("dan", ["file_content:read", "current_user:read"]);
    for (let i = 0; i < 20; i++) await w.rest("GET", `/v1/files/${WEB}`, pat);
    w.now.t += 3_600_000;
    const day = await w.rest("GET", `/v1/files/${WEB}`, pat);
    expect([day.status, day.headers.get("x-figma-rate-limit-type")]).toEqual([429, "low"]);
    expect(Number(day.headers.get("retry-after"))).toBeGreaterThan(60);
    for (let i = 0; i < 10; i++) expect((await w.rest("GET", "/v1/me", pat)).status).toBe(200);
    expect((await w.rest("GET", "/v1/me", pat)).status).toBe(429);
    // The daily cap (anyone)
    const alice = await w.pat("alice", ["current_user:read"]);
    await w.run(`INSERT INTO rest_rate (subject, bucket, window, count) VALUES (?1, 'day', ?2, 5000)`, w.people.alice.id, Math.floor(w.now.t / 86_400_000));
    expect((await w.rest("GET", "/v1/me", alice)).status).toBe(429);
  });
});

describe("signed URLs (decision 10)", () => {
  it("serve without a token until they expire; a changed path or signature is refused", async () => {
    const bytes = png("fill");
    await w.call("PUT", `/files/${LIB}/blobs/${sha1(bytes)}`, w.people.alice.token, bytes);
    const pat = await w.pat("alice", ["file_content:read"]);
    const r = await w.rest("GET", `/v1/files/${LIB}/images`, pat);
    expect(r.body).toMatchObject({ error: false, status: 200 });
    const url = new URL(r.body.meta.images[sha1(bytes)]);
    const got = await w.call("GET", url.pathname + url.search);
    expect([got.status, got.headers.get("content-type"), got.bytes.length]).toEqual([200, "image/png", bytes.length]);
    expect((await w.call("GET", url.pathname.replace(LIB, WEB) + url.search)).status).toBe(403);
    expect((await w.call("GET", url.pathname + url.search.replace(/sig=./, "sig=A"))).status).toBe(403);
    w.now.t += 15 * 86_400_000;
    expect((await w.call("GET", url.pathname + url.search)).status).toBe(403);
    // thumbnails: editors upload a PNG
    expect((await w.call("PUT", `/files/${LIB}/thumbnail`, w.people.alice.token, new Uint8Array([1, 2, 3]))).status).toBe(400);
    expect((await w.call("PUT", `/files/${LIB}/thumbnail`, w.people.gus.token, png("t"))).status).toBe(403);
    expect((await w.call("PUT", `/files/${LIB}/thumbnail`, w.people.alice.token, png("thumb"))).status).toBe(200);
    const t = new URL(await signPath(w.deps, "https://x", `/v1/files/${LIB}/thumbnail`, 30));
    const thumb = await w.call("GET", t.pathname + t.search);
    expect([thumb.status, thumb.bytes.length]).toEqual([200, png("thumb").length]);
  });
});

describe("render jobs (§16.6)", () => {
  const doc = { name: "Design System", lastModified: "2026-10-11T12:00:00Z", editorType: "figma", version: "7", document: { id: "0:0", type: "DOCUMENT", children: [] }, components: {}, componentSets: {}, schemaVersion: 0, styles: {} };

  it("editor idle longest, then viewer, then helper; a timeout falls to the next; per-caller fields come first", async () => {
    const log: string[] = [];
    w.renderer(LIB, "gus", "viewer", { log, answer: () => ({ json: filePart(doc) }) });
    w.renderer(LIB, "bob", "editor", { log, answer: () => null }); // never answers
    w.renderer(LIB, "alice", "editor", { log, helper: true, answer: () => ({ json: filePart(doc) }) });
    const pat = await w.pat("alice", ["file_content:read"]);
    const r = await w.rest("GET", `/v1/files/${LIB}`, pat);
    expect(log).toEqual(["bob:file", "gus:file"]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ...doc, role: "owner" });
    expect(r.body.thumbnailUrl).toMatch(new RegExp(`/v1/files/${LIB}/thumbnail\\?exp=`));
    // gzip passed through to a caller that takes it: two members, role first
    const gz = await w.rest("GET", `/v1/files/${LIB}`, pat, undefined, { "accept-encoding": "gzip" });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(JSON.parse(gunzipSync(gz.bytes).toString())).toMatchObject({ role: "owner", name: "Design System" });
    // the second call was a cache hit: nobody asked again
    expect(log).toEqual(["bob:file", "gus:file"]);
  });

  it("caches by room state: same seq hits, an edit misses; versions are their own key; unknown versions 404", async () => {
    let n = 0;
    const editor = w.renderer(LIB, "bob", "editor", { answer: () => ({ json: filePart({ ...doc, version: String(++n) }) }) });
    const pat = await w.pat("alice", ["file_content:read"]);
    expect((await w.rest("GET", `/v1/files/${LIB}?depth=1`, pat)).body.version).toBe("1");
    expect((await w.rest("GET", `/v1/files/${LIB}?depth=1`, pat)).body.version).toBe("1");
    w.mem.send(LIB, editor, new Uint8Array([1, 2]));
    expect((await w.rest("GET", `/v1/files/${LIB}?depth=1`, pat)).body.version).toBe("2");
    expect((await w.rest("GET", `/v1/files/${LIB}?version=AAAAAAAAAAAAAAAA`, pat)).status).toBe(404);
    expect((await w.rest("GET", `/v1/files/${LIB}?depth=0`, pat)).status).toBe(400);
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(`{"a":[2,{"c":2,"d":1}],"b":1}`);
  });

  it("nobody to render: the file's people are asked for a render helper; a helper that joins answers; else 503", async () => {
    const pat = await w.pat("alice", ["file_content:read"]);
    const none = await w.rest("GET", `/v1/images/${LIB}?ids=1:2,1-3`, pat);
    expect(none.status).toBe(503);
    expect(none.body).toEqual({ status: 503, err: "No client available to render this file. Open the file in Designer and try again.", images: { "1:2": null, "1:3": null } });
    expect(w.mem.wanted).toEqual([{ key: LIB, userIds: [w.people.alice.id] }]);
    w.mem.onWanted = () => void w.renderer(LIB, "alice", "owner", { helper: true, answer: (job: Any) => ({ [job.params.ids[0]]: png("render") }) });
    const r = await w.rest("GET", `/v1/images/${LIB}?ids=1:2,1:3&format=svg&scale=2`, pat);
    expect(r.status).toBe(200);
    expect(r.body.err).toBeNull();
    expect(r.body.images["1:3"]).toBeNull();
    const url = new URL(r.body.images["1:2"]);
    expect(url.pathname).toBe(`/v1/blobs/${LIB}/${sha1(png("render"))}.svg`);
    const got = await w.call("GET", url.pathname + url.search);
    expect([got.status, got.headers.get("content-type")]).toEqual([200, "image/svg+xml"]);
    expect((await w.rest("GET", `/v1/images/${LIB}?ids=1:2&scale=5`, pat)).status).toBe(400);
  });

  it("a client's failure carries its status; a part that wasn't uploaded doesn't count", async () => {
    w.renderer(LIB, "bob", "editor", { answer: () => ({ fail: "404 Node not found" }) });
    const pat = await w.pat("alice", ["file_content:read"]);
    expect((await w.rest("GET", `/v1/files/${LIB}/nodes?ids=9:9`, pat)).body).toEqual({ status: 404, err: "Node not found" });
    expect((await w.rest("GET", `/v1/files/${LIB}/nodes`, pat)).status).toBe(400);
    // Parts are accepted only from the person the job went to
    expect((await w.call("PUT", `/files/${LIB}/rest-jobs/abcdefgh12/parts/json`, w.people.alice.token, new Uint8Array([1]))).status).toBe(404);
  });
});

describe("variables (§16.7, §16.8)", () => {
  it("validates the shape with Figma-style messages", () => {
    expect(validateShape([])).toEqual({ ok: false, message: "Invalid request body" });
    expect(validateShape({ variables: [{ action: "CREATE", id: "t1", name: "a.b", variableCollectionId: "c", resolvedType: "FLOAT" }] })).toMatchObject({ ok: false, message: expect.stringMatching(/Invalid name in variables\[0\]/) });
    expect(validateShape({ variables: [{ action: "CREATE", id: "t1", name: "a", variableCollectionId: "c", resolvedType: "NUMBER" }] })).toMatchObject({ ok: false });
    expect(validateShape({ variables: [{ action: "UPDATE", id: "v", resolvedType: "FLOAT" }] })).toMatchObject({ ok: false, message: expect.stringMatching(/resolvedType can't change/) });
    expect(validateShape({ variableCollections: [{ action: "CREATE", id: "t", name: "C" }], variableModes: [{ action: "CREATE", id: "t", name: "M", variableCollectionId: "t" }] })).toMatchObject({ ok: false, message: expect.stringMatching(/Duplicate temporary id/) });
    expect(validateShape({ variableModeValues: [{ variableId: "v", modeId: "m", value: { r: 2, g: 0, b: 0 } }] })).toMatchObject({ ok: false });
    expect(validateShape({ variableModeValues: [{ variableId: "v", modeId: "m", value: { type: "VARIABLE_ALIAS", id: "x" } }] }).ok).toBe(true);
  });

  it("POST goes to an editor as one job; local is a job; published reads D1; seats and edit access checked", async () => {
    const seen: Any[] = [];
    w.renderer(LIB, "gus", "viewer", { answer: () => ({ json: jsonPart({ wrong: true }) }) });
    w.renderer(LIB, "bob", "editor", {
      answer: (job: Any) => {
        seen.push(job);
        return job.kind === "variables_post" ? { json: jsonPart({ status: 200, error: false, meta: { tempIdToRealId: { t1: "VariableID:1:5" } } }) } : { json: jsonPart({ status: 200, error: false, meta: { variables: {}, variableCollections: {} } }) };
      },
    });
    const pat = await w.pat("alice", ["file_variables:read", "file_variables:write"]);
    const bad = await w.rest("POST", `/v1/files/${LIB}/variables`, pat, { variables: [{ action: "CREATE", id: "t1", name: "x{", variableCollectionId: "c", resolvedType: "FLOAT" }] });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ status: 400, error: true });
    const body = { variables: [{ action: "CREATE", id: "t1", name: "Size", variableCollectionId: "VariableCollectionId:1:1", resolvedType: "FLOAT" }] };
    const r = await w.rest("POST", `/v1/files/${LIB}/variables`, pat, body);
    expect(r.body).toEqual({ status: 200, error: false, meta: { tempIdToRealId: { t1: "VariableID:1:5" } } });
    expect(seen[0]).toEqual({ kind: "variables_post", body, actorUserId: w.people.alice.id });
    expect((await w.rows(`SELECT action FROM activity_log WHERE action = 'file_variables_update'`)).length).toBe(1);
    expect((await w.rest("GET", `/v1/files/${LIB}/variables/local`, pat)).body.meta).toEqual({ variables: {}, variableCollections: {} });
    expect((await w.rest("GET", `/v1/files/${LIB}/variables/published`, pat)).body).toEqual({ status: 200, error: false, meta: { variables: {}, variableCollections: {} } });
    // dan (View seat) can't; gus (guest viewer) can't write
    const dan = await w.pat("dan", ["file_variables:read"]);
    expect((await w.rest("GET", `/v1/files/${WEB}/variables/local`, dan)).status).toBeGreaterThanOrEqual(403);
    const gus = await w.pat("gus", ["file_variables:write"]);
    expect((await w.rest("POST", `/v1/files/${LIB}/variables`, gus, body)).status).toBe(403);
  });
});

describe("files, comments, people and folders, libraries, org (§16.7)", () => {
  it("meta and versions", async () => {
    const pat = await w.pat("bob", ["file_metadata:read", "file_versions:read"]);
    const meta = (await w.rest("GET", `/v1/files/${LIB}/meta`, pat)).body.file;
    expect(meta).toMatchObject({ name: "Design System", folder_name: "System", creator: { id: w.people.alice.id, handle: "alice", img_url: null }, editorType: "figma", role: "editor", link_access: "inherit", url: `https://designer.example.workers.dev/f/${LIB}` });
    // REST reads of org files are logged once an hour per token
    await w.rest("GET", `/v1/files/${LIB}/meta`, pat);
    expect((await w.rows(`SELECT client_name FROM activity_log WHERE action = 'fig_file_view'`)).map((r: Any) => r.client_name)).toEqual(["REST API"]);
    await w.call("PUT", `/files/${LIB}/snapshot?seq=0`, w.people.alice.token, new Uint8Array([1]));
    for (let i = 0; i < 3; i++) await w.call("POST", `/files/${LIB}/versions`, w.people.alice.token, { kind: "named", title: `v${i}` });
    const page = (await w.rest("GET", `/v1/files/${LIB}/versions?page_size=2`, pat)).body;
    expect(page.versions.map((v: Any) => v.label)).toEqual(["v2", "v1"]);
    expect(page.versions[0].user).toEqual({ id: w.people.alice.id, handle: "alice", img_url: null });
    const next = new URL(page.pagination.next_page);
    expect((await w.rest("GET", next.pathname + next.search, pat)).body.versions.map((v: Any) => v.label)).toEqual(["v0"]);
    // Outside the caller's reach: 404
    const fay = await w.pat("dan", ["file_metadata:read"]);
    expect((await w.rest("GET", `/v1/files/${DRAFT}/meta`, fay)).status).toBe(404);
  });

  it("comments: Figma's shape, post, reply, reactions with shortcodes, delete by the author", async () => {
    const pat = await w.pat("bob", ["file_comments:read", "file_comments:write"]);
    const c = await w.rest("POST", `/v1/files/${LIB}/comments`, pat, { message: "Hello", client_meta: { node_id: "1:2", node_offset: { x: 4, y: 5 } } });
    expect(c.body).toMatchObject({ file_key: LIB, parent_id: "", message: "Hello", order_id: "1", client_meta: { node_id: "1:2", node_offset: { x: 4, y: 5 } }, user: { id: w.people.bob.id, handle: "bob", img_url: null }, reactions: [] });
    const reply = await w.rest("POST", `/v1/files/${LIB}/comments`, pat, { message: "Again", comment_id: c.body.id });
    expect(reply.body).toMatchObject({ parent_id: c.body.id, order_id: null, client_meta: null });
    expect((await w.rest("POST", `/v1/files/${LIB}/comments/${c.body.id}/reactions`, pat, { emoji: ":+1:" })).body).toEqual({ status: 200, error: false });
    expect((await w.rest("GET", `/v1/files/${LIB}/comments/${c.body.id}/reactions`, pat)).body.reactions).toMatchObject([{ emoji: ":+1:", user: { id: w.people.bob.id } }]);
    expect((await w.rows(`SELECT emoji FROM comment_reactions`)).map((r: Any) => r.emoji)).toEqual(["👍"]);
    const list = (await w.rest("GET", `/v1/files/${LIB}/comments`, pat)).body.comments;
    expect(list.map((x: Any) => x.message)).toEqual(["Hello", "Again"]);
    const alice = await w.pat("alice", ["file_comments:write"]);
    expect((await w.rest("DELETE", `/v1/files/${LIB}/comments/${reply.body.id}`, alice)).status).toBe(403);
    expect((await w.rest("DELETE", `/v1/files/${LIB}/comments/${reply.body.id}`, pat)).body).toEqual({ status: 200, error: false });
    const read = await w.pat("bob", ["file_comments:read"]);
    expect((await w.rest("POST", `/v1/files/${LIB}/comments`, read, { message: "x" })).status).toBe(403);
  });

  it("teams and folders, v2 and the deprecated v1 twins; Limited folders only to their people", async () => {
    const bob = await w.pat("bob", ["folders:read", "folder_metadata:read"]);
    expect((await w.rest("GET", `/v2/teams/${T1}/folders`, bob)).body.folders.map((f: Any) => f.name).sort()).toEqual(["Secret", "System"]);
    // The Limited folder's file is its people's only
    const carol = await w.pat("carol", ["folders:read"]);
    expect((await w.rest("GET", `/v2/folders/${P3}/files`, carol)).status).toBe(404);
    const fay = await w.pat("fay", ["folders:read"]);
    expect((await w.rest("GET", `/v2/folders/${P3}/files`, fay)).body.files.map((f: Any) => f.name)).toEqual(["Secret System"]);
    const files = (await w.rest("GET", `/v2/folders/${P1}/files?branch_data=true`, bob)).body.files;
    expect(files).toMatchObject([{ key: LIB, name: "Design System", branches: [] }]);
    expect((await w.rest("GET", `/v2/folders/${P1}/meta`, bob)).body).toMatchObject({ id: P1, name: "System", file_count: 1 });
    expect((await w.rest("GET", `/v1/teams/${T1}/projects`, bob)).body).toEqual({ name: "Design", projects: [{ id: P3, name: "Secret" }, { id: P1, name: "System" }] });
    expect((await w.rest("GET", `/v1/projects/${P1}/files`, bob)).body).toMatchObject({ name: "System", files: [{ key: LIB }] });
  });

  it("dev resources reach 5c's routes after the scope check", async () => {
    const pat = await w.pat("alice", ["file_dev_resources:read", "file_dev_resources:write"]);
    const made = await w.rest("POST", "/v1/dev_resources", pat, { dev_resources: [{ name: "Storybook", url: "https://storybook.example.com/button", file_key: LIB, node_id: "1:2" }] });
    expect(made.body.links_created).toMatchObject([{ name: "Storybook", file_key: LIB, node_id: "1:2" }]);
    expect((await w.rest("GET", `/v1/files/${LIB}/dev_resources`, pat)).body.dev_resources).toHaveLength(1);
    const read = await w.pat("alice", ["file_dev_resources:read"]);
    expect((await w.rest("POST", "/v1/dev_resources", read, { dev_resources: [] })).status).toBe(403);
  });

  it("activity logs for admins' PATs and plan tokens; AI usage for plan tokens only", async () => {
    const admin = await w.pat("alice", ["org:activity_log_read", "org:ai_metering_usage_read"]);
    const logs = (await w.rest("GET", `/v1/activity_logs?limit=1`, admin)).body;
    expect(logs).toMatchObject({ status: 200, error: false, i18n: null, meta: { next_page: true } });
    expect(logs.meta.activity_logs).toHaveLength(1);
    const bob = await w.pat("bob", ["org:activity_log_read"]);
    expect((await w.rest("GET", `/v1/activity_logs`, bob)).status).toBe(403);
    expect((await w.rest("GET", `/v1/ai_usage/daily`, admin)).status).toBe(403);
    const plan = await w.planToken(["org:ai_metering_usage_read"]);
    await w.run(`INSERT INTO ai_usage_daily (org_id, user_id, day, editor_type, seat_credits, plan_credits) VALUES (?1, ?2, '2026-10-10', 'design', 3, 1)`, w.orgId, w.people.bob.id);
    const usage = (await w.rest("GET", `/v1/ai_usage/daily?start_date=2026-10-01&end_date=2026-10-11`, plan)).body;
    expect(usage).toMatchObject({ next_cursor: null, has_next_page: false, rows: [{ plan_id: `organization-${w.orgId}`, user_email: "bob@x.co", seat_credits_sum: 3, plan_credits_sum: 1, metering_period_start: "2026-10-01", metering_period_end: "2026-10-31" }] });
  });

  it("library analytics: members who view the file, plan tokens of the org; group_by required", async () => {
    await w.run(`INSERT INTO libraries (key, org_id, name, latest_version, first_published_at, last_published_at) VALUES (?1, ?2, 'Design System', 1, ?3, ?3)`, LIB, w.orgId, w.now.t);
    await w.run(`INSERT INTO library_assets (library_key, key, kind, name, version_hash) VALUES (?1, ?2, 'COMPONENT', 'Button', 'h')`, LIB, "a".repeat(40));
    await w.run(`INSERT INTO library_actions_daily (day, library_key, asset_key, asset_type, file_key, team_id, action, count) VALUES ('2026-10-06', ?1, ?2, 'component', ?3, ?4, 'insert', 3)`, LIB, "a".repeat(40), WEB, "teamWeb000000001");
    const plan = await w.planToken(["library_analytics:read"]);
    expect((await w.rest("GET", `/v1/analytics/libraries/${LIB}/component/actions`, plan)).status).toBe(400);
    const rows = (await w.rest("GET", `/v1/analytics/libraries/${LIB}/component/actions?group_by=component`, plan)).body;
    expect(rows).toEqual({ rows: [{ week: "2026-10-04", insertions: 3, detachments: 0, component_key: "a".repeat(40), component_name: "Button", component_set_key: null, component_set_name: null }], next_page: false, cursor: null });
    const teams = (await w.rest("GET", `/v1/analytics/libraries/${LIB}/component/actions?group_by=team`, plan)).body.rows;
    expect(teams[0]).toMatchObject({ team_name: "Web", insertions: 3 });
    const gus = await w.pat("gus", ["library_analytics:read"]);
    expect((await w.rest("GET", `/v1/analytics/libraries/${LIB}/component/usages?group_by=component`, gus)).status).toBe(403);
  });
});
