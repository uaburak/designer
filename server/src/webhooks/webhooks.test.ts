import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_UPDATE_QUIET_MS } from "../roomBox";
import { roomBroadcast } from "../roomBroadcast";
import { restWorld, type RestWorld } from "../testing/restWorld";
import { LIB, P1, SECRET, T1, assetKey, publish, type Any } from "../testing/orgWorld";
import { Db } from "../db";
import { emitFileUpdate } from "./emit";
import { endpointError } from "./routes";
import { SEND_LEASE_MS, deliverRows, sweepWebhooks } from "./deliver";

let w: RestWorld;
let alice: string;

beforeEach(async () => {
  w = await restWorld();
  alice = await w.pat("alice", ["webhooks:read", "webhooks:write"]);
});

const hook = (token: string, body: Record<string, unknown>) => w.rest("POST", "/v2/webhooks", token, { event_type: "FILE_COMMENT", context: "file", context_id: LIB, endpoint: "https://hooks.example.com/a", passcode: "secret-pass", ...body });

describe("Webhooks V2 routes (§16.9)", () => {
  it("creates with Figma's shape and sends PING, signed; who may create; endpoint rules; limits", async () => {
    const r = await hook(alice, { description: "CI" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ event_type: "FILE_COMMENT", context: "FILE", context_id: LIB, team_id: "", plan_api_id: `organization-${w.orgId}`, status: "ACTIVE", client_id: null, passcode: "secret-pass", description: "CI" });
    await w.settle();
    const ping = w.deliveries[0];
    expect(ping.body).toMatchObject({ event_type: "PING", passcode: "secret-pass", webhook_id: String(r.body.id) });
    const [t, v1] = ping.headers["x-designer-signature"].split(",").map((x) => x.split("=")[1]);
    expect(v1).toBe(createHmac("sha256", "secret-pass").update(`${t}.${ping.raw}`).digest("hex"));
    expect(ping.headers["user-agent"]).toBe("DesignerV2-Webhooks/1");
    // gus only views the file; bob isn't a team admin
    const gus = await w.pat("gus", ["webhooks:write"]);
    expect((await hook(gus, {})).status).toBe(403);
    const bob = await w.pat("bob", ["webhooks:write"]);
    expect((await hook(bob, { context: "team", context_id: T1 })).status).toBe(403);
    expect((await hook(alice, { context: "team", context_id: T1 })).body).toMatchObject({ context: "TEAM", team_id: T1 });
    expect((await hook(bob, { context: "project", context_id: P1 })).status).toBe(200);
    expect(endpointError("http://hooks.example.com", false)).toMatch(/https/);
    expect(endpointError("https://10.0.0.4/x", false)).toMatch(/private/);
    expect(endpointError("http://localhost:3000/x", true)).toBeNull();
    expect((await hook(alice, { endpoint: "https://192.168.1.2/" })).status).toBe(400);
    await hook(alice, {});
    await hook(alice, {});
    expect((await hook(alice, {})).body.message).toMatch(/at most 3/);
    expect((await w.rows(`SELECT action FROM activity_log WHERE action LIKE 'webhook_%'`)).length).toBe(5);
  });

  it("reads hide the passcode; PUT, the request log and DELETE; plan tokens list the org's", async () => {
    const id = (await hook(alice, {})).body.id;
    expect((await w.rest("GET", `/v2/webhooks/${id}`, alice)).body.passcode).toBe("");
    const put = await w.rest("PUT", `/v2/webhooks/${id}`, alice, { status: "PAUSED", description: "" });
    expect(put.body).toMatchObject({ status: "PAUSED", description: null });
    await w.settle();
    const reqs = (await w.rest("GET", `/v2/webhooks/${id}/requests`, alice)).body.requests;
    expect(reqs).toMatchObject([{ webhook_id: String(id), request_info: { endpoint: "https://hooks.example.com/a", payload: { event_type: "PING" } }, response_info: { status: "200" }, error_msg: null }]);
    const plan = await w.planToken(["webhooks:read"]);
    expect((await w.rest("GET", `/v2/webhooks?plan_api_id=organization-${w.orgId}`, plan)).body.webhooks.map((h: Any) => h.id)).toEqual([id]);
    expect((await w.rest("GET", `/v2/webhooks?context=file&context_id=${LIB}`, alice)).body.webhooks).toHaveLength(1);
    const dan = await w.pat("dan", ["webhooks:read"]);
    expect((await w.rest("GET", `/v2/webhooks/${id}`, dan)).status).toBe(404);
    expect((await w.rest("DELETE", `/v2/webhooks/${id}`, alice)).body.id).toBe(id);
    expect((await w.rest("GET", `/v2/webhooks/${id}`, alice)).status).toBe(404);
  });

  it("only a 200 counts; retries after 5 min, 30 min and 3 h on the cron's clock, then gives up; the log keeps 7 days", async () => {
    w.answer.status = 500;
    await hook(alice, {});
    await w.settle();
    const row = async () => (await w.rows(`SELECT attempt, next_at, status, error_msg FROM webhook_requests`))[0];
    expect(await row()).toMatchObject({ attempt: 1, next_at: w.now.t + 5 * 60_000, status: 500 });
    const deps = { db: w.deps.db, now: w.deps.now, fetch: w.deps.fetch };
    expect((await sweepWebhooks(deps)).sent).toBe(0);
    for (const [wait, attempt] of [[5, 2], [30, 3], [180, 4]] as const) {
      w.now.t += wait * 60_000;
      expect((await sweepWebhooks(deps)).sent).toBe(1);
      expect((await row()).attempt).toBe(attempt);
    }
    expect((await row()).next_at).toBeNull();
    expect(w.deliveries).toHaveLength(4);
    w.now.t += 8 * 86_400_000;
    await sweepWebhooks(deps);
    expect(await w.rows(`SELECT id FROM webhook_requests`)).toEqual([]);
  });

  it("a row being sent is claimed: the cron in the same minute doesn't send it again; a dead sender's lease expires", async () => {
    const id = (await hook(alice, {})).body.id;
    await w.settle();
    w.deliveries.length = 0;
    // A send that hangs until released, as a slow endpoint during waitUntil
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow = { db: w.deps.db, now: w.deps.now, fetch: (async (...a: Parameters<typeof fetch>) => (calls++, await gate, w.deps.fetch(...a))) as typeof fetch };
    const ids = (await w.rows(`INSERT INTO webhook_requests (webhook_id, endpoint, payload, attempt, next_at, created_at) VALUES (?1, 'https://hooks.example.com/a', '{"event_type":"PING"}', 0, ?2, ?2) RETURNING id`, id, w.now.t)).map((r: Any) => r.id as number);
    const first = deliverRows(slow, ids);
    // (The claim is a database round trip: one macrotask wasn't always enough under the full suite's load.)
    await vi.waitFor(() => expect(calls).toBe(1));
    expect((await sweepWebhooks(slow)).sent).toBe(0);
    await deliverRows(slow, ids);
    expect(calls).toBe(1);
    release();
    await first;
    expect(w.deliveries).toHaveLength(1);
    expect((await w.rows(`SELECT attempt, next_at, sending_until FROM webhook_requests WHERE id = ?1`, ids[0]))[0]).toEqual({ attempt: 1, next_at: null, sending_until: null });
    // A lease left by a sender that never answered frees after SEND_LEASE_MS
    await w.rows(`UPDATE webhook_requests SET next_at = ?1, sending_until = ?2 WHERE id = ?3`, w.now.t, w.now.t + SEND_LEASE_MS, ids[0]);
    expect((await sweepWebhooks(slow)).sent).toBe(0);
    w.now.t += SEND_LEASE_MS;
    expect((await sweepWebhooks(slow)).sent).toBe(1);
    expect(w.deliveries).toHaveLength(2);
  });
});

describe("events (§16.10)", () => {
  it("FILE_COMMENT, reach through folders and teams; Limited folders excluded", async () => {
    await hook(alice, { context: "team", context_id: T1, endpoint: "https://hooks.example.com/team" });
    await hook(alice, { context: "project", context_id: P1, endpoint: "https://hooks.example.com/project" });
    await w.settle();
    w.deliveries.length = 0;
    await w.call("POST", `/files/${LIB}/comments`, w.people.bob.token, { message: "Hi @alice", mentions: [w.people.alice.id], anchor: { pageId: "0:1", x: 1, y: 2 } });
    await w.call("POST", `/files/${SECRET}/comments`, w.people.alice.token, { message: "secret", anchor: { pageId: "0:1", x: 1, y: 2 } });
    await w.settle();
    expect(w.deliveries.map((d) => d.url).sort()).toEqual(["https://hooks.example.com/project", "https://hooks.example.com/team"]);
    expect(w.deliveries[0].body).toMatchObject({ event_type: "FILE_COMMENT", file_key: LIB, file_name: "Design System", comment: [{ text: "Hi @alice" }, { mention: w.people.alice.id }], mentions: [{ id: w.people.alice.id, handle: "alice", img_url: null }], order_id: "1", parent_id: null, triggered_by: { id: w.people.bob.id } });
  });

  it("FILE_VERSION_UPDATE for named versions; LIBRARY_PUBLISH per asset type with node ids written; FILE_DELETE", async () => {
    await hook(alice, { event_type: "FILE_VERSION_UPDATE" });
    await hook(alice, { event_type: "LIBRARY_PUBLISH" });
    await w.settle();
    w.deliveries.length = 0;
    await w.call("PUT", `/files/${LIB}/snapshot?seq=0`, w.people.alice.token, new Uint8Array([1]));
    await w.call("POST", `/files/${LIB}/versions`, w.people.alice.token, { kind: "autosave" });
    const v = (await w.call("POST", `/files/${LIB}/versions`, w.people.alice.token, { kind: "named", title: "Ready", description: "d" })).body.version;
    await w.settle();
    expect(w.deliveries.map((d) => d.body)).toMatchObject([{ event_type: "FILE_VERSION_UPDATE", version_id: v.id, label: "Ready", description: "d", triggered_by: { id: w.people.alice.id } }]);
    w.deliveries.length = 0;
    const r = await publish(w, LIB, w.people.alice.token, [
      { key: assetKey("Button"), kind: "COMPONENT", name: "Button", seed: "b" },
      { key: assetKey("Red"), kind: "STYLE", name: "Red", seed: "r" },
    ], { description: "First" });
    expect(r.status).toBe(201);
    await w.settle();
    // The per-type events are sent at once, so they arrive in any order (the full `npm run check` saw styles first).
    const byType = (b: { created_components?: unknown[] }) => (b.created_components?.length ? 0 : 1);
    expect(w.deliveries.map((d) => d.body as { created_components?: unknown[] }).sort((a, b) => byType(a) - byType(b))).toMatchObject([
      { event_type: "LIBRARY_PUBLISH", description: "First", created_components: [{ key: assetKey("Button"), name: "Button" }], created_styles: [] },
      { event_type: "LIBRARY_PUBLISH", created_components: [], created_styles: [{ key: assetKey("Red"), name: "Red" }] },
    ]);
    expect((await w.rows(`SELECT node_id, created_by FROM library_assets WHERE key = ?1`, assetKey("Button")))[0]).toEqual({ node_id: "1:1", created_by: w.people.alice.id });
    // the REST read of it
    const pat = await w.pat("alice", ["library_content:read", "library_assets:read", "team_library_content:read"]);
    const comps = (await w.rest("GET", `/v1/files/${LIB}/components`, pat)).body;
    expect(comps.meta.components).toMatchObject([{ key: assetKey("Button"), file_key: LIB, node_id: "1:1", name: "Button", user: { id: w.people.alice.id } }]);
    expect((await w.rest("GET", `/v1/styles/${assetKey("Red")}`, pat)).body.meta).toMatchObject({ name: "Red", style_type: "FILL", sort_position: "" });
    expect((await w.rest("GET", `/v1/teams/${T1}/components?page_size=1`, pat)).body.meta).toMatchObject({ components: [{ name: "Button" }], cursor: {} });

    // FILE_DELETE: a file outside orgs, stop sharing
    await w.call("POST", "/files", w.people.bob.token, { key: "solo_file1", name: "Solo" });
    const bob = await w.pat("bob", ["webhooks:write"]);
    await w.rest("POST", "/v2/webhooks", bob, { event_type: "FILE_DELETE", context: "file", context_id: "solo_file1", endpoint: "https://hooks.example.com/d", passcode: "p" });
    await w.settle();
    w.deliveries.length = 0;
    expect((await w.call("DELETE", "/files/solo_file1", w.people.bob.token)).status).toBe(200);
    await w.settle();
    expect(w.deliveries.map((d) => d.body)).toMatchObject([{ event_type: "FILE_DELETE", file_key: "solo_file1", file_name: "Solo", triggered_by: { id: w.people.bob.id } }]);
  });

  it("FILE_UPDATE: the room's alarm 30 minutes after the last edit of a burst", async () => {
    await hook(alice, { event_type: "FILE_UPDATE" });
    await w.settle();
    w.deliveries.length = 0;
    const room = w.mem.get(LIB);
    room.box.edited(true);
    w.now.t += 10 * 60_000;
    room.box.edited(true);
    expect(room.alarm).toBe(w.now.t + FILE_UPDATE_QUIET_MS);
    w.now.t += 10 * 60_000;
    expect(room.box.alarm()).toEqual({ fileUpdate: false });
    w.now.t += 20 * 60_000;
    expect(room.box.alarm()).toEqual({ fileUpdate: true });
    expect(room.box.alarm()).toEqual({ fileUpdate: false });
    const pending: Promise<unknown>[] = [];
    await emitFileUpdate(new Db(w.d1), w.deps.env, LIB, (p) => void pending.push(p), w.deps.fetch);
    await Promise.all(pending);
    expect(w.deliveries.map((d) => d.body)).toMatchObject([{ event_type: "FILE_UPDATE", file_key: LIB, file_name: "Design System" }]);
  });
});

describe("the room (5c's requests)", () => {
  it("broadcasts non-stored notices; refuses changes from anyone but owners and editors", async () => {
    const m = w.mem.join(LIB, w.people.bob.id, "viewer");
    await roomBroadcast(w.deps, LIB, "dev-resources");
    expect(m.texts.at(-1)).toEqual({ t: "dev-resources" });
    w.mem.send(LIB, m, new Uint8Array([1]));
    expect(m.closed).toBe(1008);
  });
});
