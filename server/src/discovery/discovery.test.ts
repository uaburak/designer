/**
 * Round 14d — Discovery and developer logs (docs/governance.md §1, §2.11, §2.12) on the real handler over node:sqlite
 * (testing/restWorld.ts): recording and dropping, `GET /v1/discovery` and its signed hourly files, the `discovery_text`
 * job diffed into insert / update / delete, cursor chat, client reports, developer logs with Figma's filters, retention.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Room, type Connection } from "../../../src/shared/multiplayer/room";
import type { DiscoveryTextItem } from "../../../src/shared/org/governance";
import { Access } from "../org/db";
import { HttpError, type Ctx } from "../org/http";
import { DRAFT, LIB, W1, WEB, type Any } from "../testing/orgWorld";
import { sqliteStorage } from "../testing/memoryPreviews";
import { jsonPart, restWorld, type RestWorld } from "../testing/restWorld";
import { adminDeveloperLogs, logDeveloperCall, pathPattern } from "../rest/devlog";
import { DISCOVERY_FILE_ROWS } from "./rest";
import { DISCOVERY_EVERY_MS, DISCOVERY_MAX_FAILS, DISCOVERY_QUIET_MS, diffTexts, discoveryAlarm, discoveryDue, discoveryTake, forgetGovernanceOrgs, recordDiscovery, sharedAlarm, sweepGovernanceLogs, type DiscoveryRoom } from "./record";
import { memberReportRoute } from "./routes";

let w: RestWorld;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(async () => {
  w = await restWorld();
});

const admin = (method: string, path: string, body?: unknown) => w.call(method, `/orgs/${w.orgId}/admin/${path}`, w.people.alice.token, body);
async function gPlus(discovery: boolean) {
  expect((await admin("PUT", "governance", { governancePlus: true })).status).toBe(200);
  if (discovery) expect((await admin("PATCH", "settings", { discovery: true })).status).toBe(200);
  forgetGovernanceOrgs(w.d1);
}
const events = () => w.rows(`SELECT * FROM discovery_events ORDER BY id`);
const logs = () => w.rows(`SELECT * FROM developer_logs ORDER BY at, rowid`);
const comment = (who: keyof RestWorld["people"], key: string, message: string, extra: Record<string, unknown> = {}) =>
  w.call("POST", `/files/${key}/comments`, w.people[who].token, { message, anchor: { pageId: "0:1", x: 1, y: 2, nodeId: "1:2", offset: { x: 0, y: 0 } }, ...extra });

async function ctxOf(who: keyof RestWorld["people"], method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Ctx> {
  const req = new Request(`https://designer.example${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const user = (await w.deps.db.user(w.people[who].id))!;
  const url = new URL(req.url);
  return { req, url, deps: w.deps, user, parts: url.pathname.split("/").filter(Boolean), m: method, acc: new Access(w.deps, user, req) };
}

describe("recording (§2.11): off drops everything", () => {
  it("comments, replies, edits, reactions and deletes become events only with Governance+ and Discovery on", async () => {
    expect((await comment("carol", WEB, "before the add-on")).status).toBe(200);
    await gPlus(false);
    await comment("carol", WEB, "add-on, Discovery off");
    expect(await events()).toEqual([]);
    await admin("PATCH", "settings", { discovery: true });
    forgetGovernanceOrgs(w.d1);
    const posted = await comment("carol", WEB, "Ship the header");
    const threadId = posted.body.threads.at(-1).id as string;
    expect((await w.call("POST", `/files/${WEB}/comments`, w.people.alice.token, { threadId, message: "Agreed" })).status).toBe(200);
    const replyId = (await w.rows(`SELECT id FROM comments WHERE thread_id = ?1 AND id <> ?1`, threadId))[0].id as string;
    await w.call("PATCH", `/files/${WEB}/comments/${threadId}`, w.people.carol.token, { message: "Ship the new header" });
    await w.call("PUT", `/files/${WEB}/comments/${replyId}/reactions`, w.people.alice.token, { emoji: "🎉" });
    await w.call("PUT", `/files/${WEB}/comments/${replyId}/reactions`, w.people.alice.token, { emoji: "🎉" });
    await w.call("DELETE", `/files/${WEB}/comments/${replyId}/reactions?emoji=${encodeURIComponent("🎉")}`, w.people.alice.token);
    await w.call("DELETE", `/files/${WEB}/comments/${replyId}`, w.people.alice.token);
    // A file outside orgs records nothing
    await w.run(`UPDATE files SET org_id = NULL WHERE key = ?1`, DRAFT);
    expect((await comment("bob", DRAFT, "private")).status).toBe(200);
    await w.settle();
    const rows = await events();
    expect(rows.map((r: Any) => [r.text_type, r.action_type, r.text, r.user_email])).toEqual([
      ["file_comments", "insert", "Ship the header", "carol@x.co"],
      ["file_comments", "insert", "Agreed", "alice@x.co"],
      ["file_comments", "update", "Ship the new header", "carol@x.co"],
      ["file_comment_reactions", "insert", "🎉", "alice@x.co"],
      ["file_comment_reactions", "delete", "🎉", "alice@x.co"],
      ["file_comments", "delete", "", "alice@x.co"],
    ]);
    expect(rows[0]).toMatchObject({ org_id: w.orgId, file_key: WEB, file_name: "Website", file_workspace_id: W1, node_id: "1:2", resource_id: threadId, parent_comment_id: null, timestamp: Math.floor(w.now.t / 1000), hour: Math.floor(w.now.t / HOUR) });
    expect(rows[1]).toMatchObject({ parent_comment_id: threadId, resource_id: replyId });
    expect(rows[3]).toMatchObject({ resource_id: `${replyId}:🎉`, parent_comment_id: replyId });
  });

  it("dev resources are developer_related_links; recordDiscovery drops another org's rows", async () => {
    await gPlus(true);
    const r = await w.call("POST", `/files/${WEB}/dev-resources`, w.people.alice.token, { nodeId: "1:2", name: "Storybook", url: "https://sb.example/button" });
    expect(r.status).toBe(201);
    const id = r.body.devResource.id as string;
    await w.call("PATCH", `/files/${WEB}/dev-resources/${id}`, w.people.alice.token, { name: "Docs" });
    await w.call("DELETE", `/files/${WEB}/dev-resources/${id}`, w.people.alice.token);
    await recordDiscovery(w.deps, [{ org_id: "someone-else", file_key: "x", text: "t", timestamp: 1, action_type: "insert", file_name: "", file_workspace_id: null, node_id: null, text_type: "in_file", resource_id: null, parent_comment_id: null, user_id: "u", user_email: "", user_billing_group_id: null, feature_entrypoint: null, moderation_failure_flags: null }]);
    await w.settle();
    expect((await events()).map((e: Any) => [e.text_type, e.action_type, e.text, e.node_id, e.resource_id])).toEqual([
      ["developer_related_links", "insert", "Storybook https://sb.example/button", "1:2", id],
      ["developer_related_links", "update", "Docs https://sb.example/button", "1:2", id],
      ["developer_related_links", "delete", "Docs https://sb.example/button", "1:2", id],
    ]);
  });
});

describe("GET /v1/discovery and the hourly files (§1, §2.11)", () => {
  async function seed(hours: number[]) {
    for (const h of hours) {
      w.now.t = Date.UTC(2026, 9, 11, 12) + h * HOUR + 60_000;
      expect((await comment("carol", WEB, `hour ${h}`)).status).toBe(200);
    }
    await w.settle();
    w.now.t = Date.UTC(2026, 9, 11, 12) + 30 * HOUR + 5 * 60_000; // 2026-10-12 18:05
  }
  const base = Date.UTC(2026, 9, 11, 12) / 1000;

  it("validates as Figma, answers the complete hours with signed links, and serves them", async () => {
    const plan = await w.planToken(["org:discovery_read"]);
    const q = (s: string, token = plan) => w.rest("GET", `/v1/discovery?${s}`, token);
    expect((await q(`start_date=${base}`)).body).toMatchObject({ status: 403, error: true, message: "This endpoint requires Governance+" });
    await gPlus(true);
    await seed([0, 1, 1, 3, 29]);
    expect((await q("")).status).toBe(400);
    expect((await q(`start_date=${base + 30 * 3600}`)).body.message).toMatch(/at least 1 hour in the past/);
    expect((await q(`start_date=${base}&end_date=${base + 86_401}`)).body.message).toMatch(/at most 24 hours/);
    expect((await q(`start_date=${base}&end_date=${base}`)).status).toBe(400);
    expect((await q(`start_date=${base}&file_ttl_in_seconds=59`)).status).toBe(400);
    expect((await q(`start_date=${base}&file_ttl_in_seconds=86401`)).status).toBe(400);
    const r = await q(`start_date=${base}&end_date=${base + 4 * 3600}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ error: false, status: 200, i18n: null });
    expect(Object.keys(r.body.meta.urls)).toEqual(["2026/10/11/12", "2026/10/11/13", "2026/10/11/15"]);
    const link = new URL(r.body.meta.urls["2026/10/11/13"][0]);
    expect(link.pathname).toBe(`/v1/discovery/files/${w.orgId}/2026/10/11/13.json`);
    const file = await w.rest("GET", link.pathname + link.search, null);
    expect(file.status).toBe(200);
    expect(file.body.map((e: Any) => e.text)).toEqual(["hour 1", "hour 1"]);
    expect(Object.keys(file.body[0]).sort()).toEqual(
      ["action_type", "feature_entrypoint", "file_key", "file_name", "file_workspace_id", "moderation_failure_flags", "node_id", "parent_comment_id", "resource_id", "text", "text_type", "timestamp", "user_billing_group_id", "user_email", "user_id"].sort(),
    );
    // The hour still running isn't served: 2026/10/12/17 is complete, 18 isn't
    const late = await q(`start_date=${base + 28 * 3600}&end_date=${base + 31 * 3600}`);
    expect(Object.keys(late.body.meta.urls)).toEqual(["2026/10/12/17"]);
    // An org admin's PAT works; a member's doesn't
    expect((await q(`start_date=${base}`, await w.pat("alice", ["org:discovery_read"]))).status).toBe(200);
    expect((await q(`start_date=${base}`, await w.pat("bob", ["org:discovery_read"]))).status).toBe(403);
    expect((await q(`start_date=${base}`, await w.pat("alice", ["file_content:read"]))).status).toBe(403);
  });

  it("links expire after file_ttl_in_seconds; a forged one is refused; a big hour is split", async () => {
    const plan = await w.planToken(["org:discovery_read"]);
    await gPlus(true);
    await seed([2]);
    const rows = Array.from({ length: DISCOVERY_FILE_ROWS }, (_, i) => ({ org_id: w.orgId, file_key: WEB, text: `n${i}`, timestamp: base + 2 * 3600 + 10, action_type: "insert" as const, file_name: "Website", file_workspace_id: null, node_id: `9:${i}`, text_type: "in_file" as const, resource_id: null, parent_comment_id: null, user_id: w.people.bob.id, user_email: "bob@x.co", user_billing_group_id: null, feature_entrypoint: null, moderation_failure_flags: null }));
    await recordDiscovery(w.deps, rows);
    const r = await w.rest("GET", `/v1/discovery?start_date=${base}&file_ttl_in_seconds=60`, plan);
    const links = r.body.meta.urls["2026/10/11/14"] as string[];
    expect(links).toHaveLength(2);
    const second = new URL(links[1]);
    expect(second.pathname.endsWith("/14-1.json")).toBe(true);
    expect((await w.rest("GET", second.pathname + second.search, null)).body).toHaveLength(1);
    const first = new URL(links[0]);
    expect((await w.rest("GET", first.pathname + first.search, null)).body).toHaveLength(DISCOVERY_FILE_ROWS);
    const forged = first.pathname.replace("/14.json", "/13.json") + first.search;
    expect((await w.rest("GET", forged, null)).status).toBe(403);
    w.now.t += 61_000;
    expect((await w.rest("GET", first.pathname + first.search, null)).status).toBe(403);
  });
});

describe("the room's side (§2.11)", () => {
  function roomOf(): DiscoveryRoom & { jobs: number } {
    const st = sqliteStorage();
    const rest = w.mem.get(WEB).rest;
    const room = {
      jobs: 0,
      fileKey: () => WEB,
      sql: st.sql,
      now: () => w.now.t,
      d1: w.d1,
      rest: {
        run: (job: { kind: "discovery_text" }, waitMs: number, wanted: string[]) => {
          room.jobs++;
          return rest.run(job, waitMs, wanted);
        },
        partBytes: (sha1: string): Uint8Array | null | Promise<Uint8Array | null> => rest.partBytes(sha1),
        dropParts: (parts: Any) => rest.dropParts(parts),
      },
    };
    return room;
  }

  it("discovery_text: run when due, diffed into insert / update / delete, stamped at the job, the window's last writer", async () => {
    await gPlus(true);
    let items: DiscoveryTextItem[] = [
      { nodeId: "1:2", textType: "in_file", text: "Hello" },
      { nodeId: "1:3", textType: "dev_mode_annotation", text: "Use 8px" },
    ];
    const log: string[] = [];
    w.renderer(WEB, "alice", "editor", { log, answer: (job) => (job.kind === "discovery_text" ? { json: jsonPart(items) } : null) });
    const room = roomOf();
    const t0 = w.now.t;
    expect(await discoveryTake(room, { chat: [], wrote: { userId: w.people.bob.id, at: t0 } })).toBe(t0 + DISCOVERY_QUIET_MS);
    expect(await discoveryAlarm(room)).toBe(t0 + DISCOVERY_QUIET_MS);
    expect(room.jobs).toBe(0);
    w.now.t = t0 + DISCOVERY_QUIET_MS;
    expect(await discoveryAlarm(room)).toBeNull();
    expect(log).toEqual(["alice:discovery_text"]);
    let rows = await events();
    expect(rows.map((r: Any) => [r.action_type, r.text_type, r.node_id, r.text, r.user_email, r.timestamp])).toEqual([
      ["insert", "in_file", "1:2", "Hello", "bob@x.co", Math.floor(w.now.t / 1000)],
      ["insert", "dev_mode_annotation", "1:3", "Use 8px", "bob@x.co", Math.floor(w.now.t / 1000)],
    ]);
    // Never cached: the part is gone from the room
    expect(await w.mem.get(WEB).rest.partBytes("0".repeat(40))).toBeNull();
    // A later window: one changed, one gone, one new — carol wrote last
    const t1 = w.now.t;
    items = [
      { nodeId: "1:2", textType: "in_file", text: "Hello there" },
      { nodeId: "1:4", textType: "component_documentation_link", text: "https://docs.example" },
    ];
    await discoveryTake(room, { chat: [], wrote: { userId: w.people.bob.id, at: t1 + 1000 } });
    const due = await discoveryTake(room, { chat: [], wrote: { userId: w.people.carol.id, at: t1 + 2000 } });
    expect(due).toBe(t1 + DISCOVERY_EVERY_MS);
    w.now.t = due!;
    await discoveryAlarm(room);
    rows = (await events()).slice(2);
    expect(rows.map((r: Any) => [r.action_type, r.node_id, r.text, r.user_email])).toEqual([
      ["update", "1:2", "Hello there", "carol@x.co"],
      ["insert", "1:4", "https://docs.example", "carol@x.co"],
      ["delete", "1:3", "", "carol@x.co"],
    ]);
    // Nothing written since: no job
    w.now.t += 2 * HOUR;
    expect(await discoveryAlarm(room)).toBeNull();
    expect(room.jobs).toBe(2);
    // Discovery turned off: the change is forgotten, no job
    await admin("PATCH", "settings", { discovery: false });
    forgetGovernanceOrgs(w.d1);
    await discoveryTake(room, { chat: [], wrote: { userId: w.people.bob.id, at: w.now.t } });
    w.now.t += 2 * HOUR;
    expect(await discoveryAlarm(room)).toBeNull();
    expect(room.jobs).toBe(2);
  });

  it("no client: tried again in an hour; the diff itself keeps the table", async () => {
    await gPlus(true);
    const room = roomOf();
    await discoveryTake(room, { chat: [], wrote: { userId: w.people.bob.id, at: w.now.t } });
    w.now.t += DISCOVERY_QUIET_MS;
    const next = await discoveryAlarm(room);
    expect(next).toBe(w.now.t + DISCOVERY_EVERY_MS);
    expect(await events()).toEqual([]);
    const st = sqliteStorage();
    expect((await diffTexts(st.sql, [{ nodeId: "1:1", textType: "in_file", text: "a" }])).map((c) => c.action)).toEqual(["insert"]);
    expect(await diffTexts(st.sql, [{ nodeId: "1:1", textType: "in_file", text: "a" }])).toEqual([]);
    expect((await diffTexts(st.sql, [])).map((c) => c.action)).toEqual(["delete"]);
  });

  it("an unreadable part (e.g. sealed bytes) backs off 1, 2, 4, 8 h, then waits for the next write (review fix)", async () => {
    await gPlus(true);
    w.renderer(WEB, "alice", "editor", { answer: (job) => (job.kind === "discovery_text" ? { json: jsonPart([{ nodeId: "1:2", textType: "in_file", text: "Hello" }]) } : null) });
    const room = roomOf();
    // what the room read before the fix: the part as stored, i.e. ciphertext with key management on
    room.rest.partBytes = async () => new Uint8Array([0x44, 0x56, 0x32, 0x45, 2, 9, 9, 9]);
    await discoveryTake(room, { chat: [], wrote: { userId: w.people.bob.id, at: w.now.t } });
    w.now.t += DISCOVERY_QUIET_MS;
    const gaps: (number | null)[] = [];
    for (let i = 0; i < DISCOVERY_MAX_FAILS; i++) {
      const next = await discoveryAlarm(room);
      gaps.push(next === null ? null : next - w.now.t);
      if (next !== null) w.now.t = next;
    }
    expect(gaps).toEqual([HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, null]);
    expect(room.jobs).toBe(DISCOVERY_MAX_FAILS);
    expect(discoveryDue(room)).toBeNull();
    // the next write arms it again; read opened (as FileRoom's RoomEkm.partBytes does), it records
    room.rest.partBytes = async (sha1: string) => w.mem.get(WEB).rest.partBytes(sha1);
    expect(await discoveryTake(room, { chat: [], wrote: { userId: w.people.bob.id, at: w.now.t } })).not.toBeNull();
    w.now.t = discoveryDue(room)!;
    expect(await discoveryAlarm(room)).toBeNull();
    expect((await events()).map((r: Any) => [r.action_type, r.text])).toEqual([["insert", "Hello"]]);
  });

  it("the shared alarm: whatever else sets it never pushes Discovery's due time later (review fix)", async () => {
    await gPlus(true);
    const room = roomOf();
    expect(sharedAlarm(room, 5000)).toBe(5000);
    expect(sharedAlarm(room, null)).toBeNull();
    const due = (await discoveryTake(room, { chat: [], wrote: { userId: w.people.bob.id, at: w.now.t } }))!;
    expect(sharedAlarm(room, due + 30 * 60_000)).toBe(due);
    expect(sharedAlarm(room, due - 1)).toBe(due - 1);
    expect(sharedAlarm(room, null)).toBe(due);
  });

  it("cursor chat: each message's final text as transient, only with the policy's discovery", async () => {
    await gPlus(true);
    const room = new Room({ nextSessionID: (() => { let n = 0; return () => ++n; })(), lastSeq: () => 0, firstSeq: () => 1, snapshotSeq: () => 0, append: () => {}, readAfter: () => [] }, () => {}, { now: () => w.now.t });
    const conn = (): Connection => ({ send: () => {}, close: () => {} });
    const a = conn();
    const b = conn();
    room.connect(a, { userId: w.people.bob.id, role: "editor", policy: { cursorChat: true, audio: true, discovery: true } });
    room.connect(b, { userId: w.people.carol.id, role: "editor", policy: { cursorChat: true, audio: true } });
    for (const c of [a, b]) room.receive(c, JSON.stringify({ t: "hello", since: 0 }));
    const say = (c: Connection, chat?: string) => room.receive(c, JSON.stringify({ t: "presence", data: { cursor: null, page: "0:1", selection: [], view: null, ...(chat === undefined ? {} : { chat }) } }));
    for (const t of ["", "h", "he", "hel", "hello"]) say(a, t);
    say(b, "not recorded");
    say(b);
    say(a);
    say(a, "second");
    room.leave(a);
    const cap = room.drainDiscovery()!;
    expect(cap.chat.map((c) => c.text)).toEqual(["hello", "second"]);
    expect(room.drainDiscovery()).toBeNull();
    await discoveryTake(roomOf(), cap);
    expect((await events()).map((e: Any) => [e.text_type, e.action_type, e.text, e.user_email])).toEqual([
      ["cursor_chat", "transient", "hello", "bob@x.co"],
      ["cursor_chat", "transient", "second", "bob@x.co"],
    ]);
  });
});

describe("client reports (§2.11, §2.12)", () => {
  it("AI prompts and MCP calls: recorded with the add-on (and Discovery for prompts), dropped otherwise", async () => {
    const prompt = { fileKey: WEB, text: "Make it pop", feature: "first_draft", at: w.now.t };
    const mcp = { calls: [{ tool: "get_design_context", fileKey: WEB, at: w.now.t - 1000 }, { tool: "whoami", fileKey: null, at: w.now.t - 2 * DAY }, { tool: "x", fileKey: "not_a_file", at: w.now.t }] };
    expect((await memberReportRoute(await ctxOf("bob", "POST", `/orgs/${w.orgId}/discovery/ai-prompt`, prompt))).status).toBe(204);
    expect((await memberReportRoute(await ctxOf("bob", "POST", `/orgs/${w.orgId}/developer-logs/mcp`, mcp))).status).toBe(204);
    expect([await events(), await logs()]).toEqual([[], []]);
    await gPlus(true);
    await memberReportRoute(await ctxOf("bob", "POST", `/orgs/${w.orgId}/discovery/ai-prompt`, prompt));
    await memberReportRoute(await ctxOf("bob", "POST", `/orgs/${w.orgId}/discovery/ai-prompt`, { ...prompt, fileKey: null }));
    await memberReportRoute(await ctxOf("bob", "POST", `/orgs/${w.orgId}/developer-logs/mcp`, mcp, { "cf-connecting-ip": "198.51.100.7" }));
    await w.settle();
    expect((await events()).map((e: Any) => [e.text_type, e.action_type, e.text, e.feature_entrypoint, e.file_key, e.file_name])).toEqual([
      ["user_ai_prompts", "transient", "Make it pop", "first_draft", WEB, "Website"],
      ["user_ai_prompts", "transient", "Make it pop", "first_draft", "", ""],
    ]);
    const l = await logs();
    expect(l.map((r: Any) => [r.event_name, r.event_source, r.token_type, r.resource_type, r.resource_name, r.user_email, r.ip_address])).toEqual([
      ["get_design_context", "mcp_server", "session", "file", "Website", "bob@x.co", "198.51.100.7"],
      ["whoami", "mcp_server", "session", "org", "Acme", "bob@x.co", "198.51.100.7"],
    ]);
    // An outsider isn't a member
    await expect(memberReportRoute(await ctxOf("olga", "POST", `/orgs/${w.orgId}/discovery/ai-prompt`, prompt))).rejects.toBeInstanceOf(HttpError);
  });
});

describe("developer logs (§2.12)", () => {
  it("a line per REST call on a G+ org's resource, after the answer; none without the add-on or outside orgs", async () => {
    const pat = await w.pat("bob", ["file_metadata:read", "file_comments:read"]);
    await w.rest("GET", `/v1/files/${WEB}/meta`, pat);
    await w.settle();
    expect(await logs()).toEqual([]);
    await gPlus(false);
    await w.run(`UPDATE files SET org_id = NULL WHERE key = ?1`, DRAFT);
    await w.rest("GET", `/v1/files/${WEB}/meta`, pat, undefined, { "cf-connecting-ip": "203.0.113.9" });
    await w.rest("GET", `/v1/files/${DRAFT}/comments`, pat);
    await w.rest("GET", `/v1/files/${LIB}/comments`, pat);
    await w.settle();
    const l = await logs();
    expect(l.map((r: Any) => [r.event_name, r.event_source, r.token_type, r.token_name, r.user_email, r.resource_type, r.resource_id, r.resource_name])).toEqual([
      ["/v1/files/:file_key/meta", "rest_api", "personal_access_token", "ci", "bob@x.co", "file", WEB, "Website"],
      ["/v1/files/:file_key/comments", "rest_api", "personal_access_token", "ci", "bob@x.co", "file", LIB, "Design System"],
    ]);
    expect(l[0].ip_address).toBe("203.0.113.9");
    expect(pathPattern("v1", ["files", "abcdef", "comments", "c_1", "reactions"])).toBe("/v1/files/:file_key/comments/:comment_id/reactions");
    expect(pathPattern("v1", ["analytics", "libraries", "abcdef", "component", "actions"])).toBe("/v1/analytics/libraries/:file_key/component/actions");
  });

  it("POST /v1/developer_logs: plan tokens only, Figma's filters and answer, pagination, the token filter by hash", async () => {
    await gPlus(false);
    const plan = await w.planToken(["org:developer_log_read", "org:activity_log_read"]);
    const bobPat = await w.pat("bob", ["file_metadata:read"]);
    const carolPat = await w.pat("carol", ["file_metadata:read"]);
    await w.rest("GET", `/v1/files/${WEB}/meta`, bobPat, undefined, { "cf-connecting-ip": "10.0.0.1" });
    w.now.t += 1000;
    await w.rest("GET", `/v1/files/${WEB}/meta`, carolPat, undefined, { "cf-connecting-ip": "10.0.0.2" });
    w.now.t += 1000;
    await w.rest("GET", "/v1/activity_logs", plan, undefined, { "cf-connecting-ip": "192.0.2.1" });
    await logDeveloperCall(w.deps, { orgId: w.orgId, eventName: "old", eventSource: "rest_api", userId: w.people.bob.id, tokenId: null, tokenName: null, tokenType: "session", resource: { type: null, id: null, name: null }, ip: "10.0.0.9", city: null, countryRegion: null, country: null, at: w.now.t - 3 * DAY });
    await w.settle();
    w.now.t += 1000;
    const q = async (body: unknown, token = plan) => (await w.rest("POST", "/v1/developer_logs", token, body)).body;
    // Plan tokens only
    const adminPat = await w.pat("alice", ["org:developer_log_read"]);
    expect(await q({}, adminPat)).toMatchObject({ status: 403, error: true });
    expect((await w.call("POST", "/v1/developer_logs", w.people.alice.token, {})).status).toBe(403);
    expect((await q({ limit: 101 })).status).toBe(400);
    expect((await q({ token_type: "NOPE" })).status).toBe(400);
    // (the developer_logs calls are logged too, without an address here: `ip_address: "1"` leaves them out)
    const all = await q({ ip_address: "1" });
    expect(all).toMatchObject({ status: 200, error: false, meta: { has_more: false, cursor: null } });
    const names = (r: Any) => r.meta.items.map((i: Any) => `${i.action.event_name}@${i.context.ip_address}`);
    // Newest first
    expect(names(all)).toEqual(["/v1/activity_logs@192.0.2.1", "/v1/files/:file_key/meta@10.0.0.2", "/v1/files/:file_key/meta@10.0.0.1", "old@10.0.0.9"]);
    const item = all.meta.items[1];
    expect(item).toMatchObject({
      timestamp: new Date(w.now.t - 2000).toISOString(),
      action: { event_name: "/v1/files/:file_key/meta", event_source: "rest_api" },
      actor: { user_id: w.people.carol.id, user_name: "carol", token_name: "ci", token_type: "personal_access_token", user_email: "carol@x.co" },
      resource: { id_or_key: WEB, name: "Website", type: "file", org_id: w.orgId },
      context: { ip_address: "10.0.0.2", city: null, country_region: null, country: null },
    });
    expect(names(await q({ token: bobPat }))).toEqual(["/v1/files/:file_key/meta@10.0.0.1"]);
    expect(names(await q({ token: `${bobPat},${carolPat}` }))).toHaveLength(2);
    expect(names(await q({ token: "dsgn_unknown" }))).toEqual([]);
    expect(names(await q({ user_email: "car,bo", date_range: "LAST_24H" }))).toEqual(["/v1/files/:file_key/meta@10.0.0.2", "/v1/files/:file_key/meta@10.0.0.1"]);
    expect(names(await q({ ip_address: "10.0.0." }))).toHaveLength(3);
    expect(names(await q({ ip_address: "10.0.0.2,192." }))).toHaveLength(2);
    expect(names(await q({ ip_address: "10.0.0.", date_range: "LAST_24H" }))).toHaveLength(2);
    expect(names(await q({ token_type: "PLAN_ACCESS_TOKEN", ip_address: "1" }))).toEqual(["/v1/activity_logs@192.0.2.1"]);
    expect(names(await q({ token_name: "pla", ip_address: "1" }))).toEqual(["/v1/activity_logs@192.0.2.1"]);
    expect(names(await q({ event_source: "MCP_SERVER" }))).toEqual([]);
    // Pagination
    const p1 = await q({ limit: 2, ip_address: "1" });
    expect([names(p1), p1.meta.has_more]).toEqual([["/v1/activity_logs@192.0.2.1", "/v1/files/:file_key/meta@10.0.0.2"], true]);
    const p2 = await q({ limit: 2, ip_address: "1", cursor: p1.meta.cursor });
    expect(names(p2)[0]).toBe("/v1/files/:file_key/meta@10.0.0.1");
    expect((await q({ cursor: "garbage" })).status).toBe(400);
  });

  it("Admin's GET developer-logs reads the same with query parameters; Governance+ only", async () => {
    const ctx = async (qs: string) => ctxOf("alice", "GET", `/orgs/${w.orgId}/admin/developer-logs?${qs}`);
    await expect(adminDeveloperLogs(await ctx(""), w.orgId)).rejects.toMatchObject({ status: 403 });
    await gPlus(false);
    const pat = await w.pat("bob", ["file_metadata:read"]);
    await w.rest("GET", `/v1/files/${WEB}/meta`, pat);
    await w.settle();
    const r = await adminDeveloperLogs(await ctx("user_email=bob&token_type=PERSONAL_ACCESS_TOKEN&limit=5"), w.orgId);
    const body = (await r.json()) as Any;
    expect(body.meta.items).toHaveLength(1);
    expect(body.meta.items[0].actor.user_email).toBe("bob@x.co");
    await expect(adminDeveloperLogs(await ctx("date_range=LAST_YEAR"), w.orgId)).rejects.toMatchObject({ status: 400 });
  });
});

describe("retention (§2.11, §2.12)", () => {
  it("the daily sweep drops what is older than 30 days", async () => {
    await gPlus(true);
    const ev = (ts: number) => ({ org_id: w.orgId, file_key: WEB, text: String(ts), timestamp: ts, action_type: "insert" as const, file_name: "Website", file_workspace_id: null, node_id: null, text_type: "in_file" as const, resource_id: null, parent_comment_id: null, user_id: w.people.bob.id, user_email: "bob@x.co", user_billing_group_id: null, feature_entrypoint: null, moderation_failure_flags: null });
    const nowS = Math.floor(w.now.t / 1000);
    await recordDiscovery(w.deps, [ev(nowS - 31 * 86_400), ev(nowS - 29 * 86_400)]);
    const line = (at: number) => logDeveloperCall(w.deps, { orgId: w.orgId, eventName: String(at), eventSource: "rest_api", userId: null, tokenId: null, tokenName: null, tokenType: "session", resource: { type: null, id: null, name: null }, ip: "", city: null, countryRegion: null, country: null, at });
    await line(w.now.t - 31 * DAY);
    await line(w.now.t - 29 * DAY);
    await sweepGovernanceLogs(w.d1, w.now.t);
    expect((await events()).map((e: Any) => e.timestamp)).toEqual([nowS - 29 * 86_400]);
    expect((await logs()).map((r: Any) => r.at)).toEqual([w.now.t - 29 * DAY]);
  });
});
