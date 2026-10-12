/**
 * Round 5g — the store's `plugins` repository (docs/plugins.md §6, §10) against round 5c's server handler
 * (server/src/api.ts `handle` on node:sqlite, the org of server/src/testing/orgWorld.ts), through LocalStore and over
 * the port: saved / recents in plugins.json, private plugins published in three steps (only changed parts sent again),
 * bundles downloaded once and cached, lists offline, `allowed` by the org's settings, approvals and workspaces, requests
 * and answers, the `plugins` events.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../../../server/src/api";
import { DRAFT, P2, T2, W1, WEB, world, type World } from "../../../server/src/testing/orgWorld";
import type { PluginBundle, PluginRef, PluginsEvent } from "../../shared/plugins/types";
import { StoreClient } from "../../shared/store/client";
import { portTransport, StoreError } from "../../shared/store/protocol";
import type { FileKey } from "../../shared/store/types";
import { StoreServer } from "../server";
import { openTestStore, settle, tempDir, type TestStore } from "../testing/harness";
import type { MultiplayerService } from "../multiplayer/service";
import { NotificationsService } from "../notifications/service";
import { MAX_RECENTS, PluginsService } from "./service";

const ORIGIN = "https://designer.example.workers.dev";

class NoSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {}
}

let w: World;
let online = true;
const log: string[] = [];
const opened: TestStore[] = [];

async function open(person: keyof World["people"], dir?: string): Promise<TestStore> {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (!online) throw new TypeError("fetch failed");
    const req = new Request(String(input), init);
    log.push(`${person} ${req.method} ${decodeURIComponent(new URL(req.url).pathname)}`);
    return handle(req, w.deps);
  };
  const s = await openTestStore({ fetch, ...(dir ? { dir } : {}) });
  await s.api.multiplayer.setSession({ server: ORIGIN, token: w.people[person].token });
  opened.push(s);
  return s;
}

beforeEach(async () => {
  vi.stubGlobal("WebSocket", NoSocket);
  w = await world();
  online = true;
  log.length = 0;
});

afterEach(async () => {
  for (const s of opened.splice(0)) {
    await s.close().catch(() => undefined);
    s.dispose();
  }
  vi.unstubAllGlobals();
});

const refusal = async (p: Promise<unknown>): Promise<StoreError> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(StoreError);
  return e as StoreError;
};

const dev = (n: number): PluginRef => ({ id: `dev-${n}`, name: `Plugin ${n}`, kind: "plugin", source: { type: "development", path: `/Users/me/p${n}/manifest.json` }, editorTypes: ["figma"] });
const bundle = (code: string, ui2 = "<p>two</p>"): PluginBundle => ({
  manifest: { name: "Lorem", id: "dev-lorem", api: "1.0.0", main: "code.js", ui: { main: "ui.html", second: "two.html" }, editorType: ["figma", "dev"] },
  code,
  ui: { main: "<p>one</p>", second: ui2 },
});

/** A local file that is the copy of an org file (FileMeta.space) */
async function orgCopy(s: TestStore, space: { key: string; teamId: string | null; projectId: string | null }): Promise<FileKey> {
  const f = await s.api.workspace.createFile({ name: "Copy", folderId: null });
  await s.store.ws.queue.run(() => s.store.ws.setFileSpace(f.fileKey, { orgId: w.orgId, ...space }));
  return f.fileKey;
}

describe("saved plugins and recents", () => {
  it("are this installation's, in plugins.json; recents newest first, at most 10; events over the port", async () => {
    const dir = tempDir();
    const t = await open("carol", dir);
    const server = new StoreServer(t.store, { generation: 1 });
    const { port1, port2 } = new MessageChannel();
    server.connect(portTransport(port1), "editor");
    const client = new StoreClient();
    client.attach(portTransport(port2));
    await client.whenReady();
    const events: PluginsEvent[] = [];
    client.plugins.watch((e) => events.push(e));
    try {
      await client.plugins.setSaved(dev(1), true);
      await client.plugins.setSaved(dev(2), true);
      await client.plugins.setSaved(dev(1), false);
      for (let i = 0; i < 12; i++) await client.plugins.ranRecently(dev(i));
      await client.plugins.ranRecently(dev(5));
      const l = await client.plugins.local();
      expect(l.saved.map((r) => r.id)).toEqual(["dev-2"]);
      expect(l.recents.length).toBe(MAX_RECENTS);
      expect(l.recents.slice(0, 3).map((r) => r.id)).toEqual(["dev-5", "dev-11", "dev-10"]);
      expect(await refusal(client.plugins.setSaved({ id: "x", name: "x", kind: "plugin", source: { type: "elsewhere" } } as never, true))).toMatchObject({ code: "invalid" });
      await settle();
      expect(events.filter((e) => e.what === "local").length).toBe(16);
    } finally {
      port1.close();
      port2.close();
    }
    expect(JSON.parse(readFileSync(join(dir, "Workspace", "plugins.json"), "utf8")).saved).toHaveLength(1);
    // Kept across a restart
    await t.close();
    const again = await open("carol", dir);
    expect((await again.api.plugins.local()).saved.map((r) => r.id)).toEqual(["dev-2"]);
  });
});

describe("private plugins (§10.1)", () => {
  it("publish in three steps, update only what changed, download once, list offline, remove", async () => {
    const bob = await open("bob");
    const events: PluginsEvent[] = [];
    bob.store.plugins.onEvent((e) => events.push(e));
    const meta = { name: "Lorem ipsum", description: "Fills text", developmentPath: "/Users/bob/lorem/manifest.json" };
    const v1 = await bob.api.plugins.publish(w.orgId, bundle("figma.closePlugin()"), meta);
    expect(v1).toMatchObject({ orgId: w.orgId, kind: "plugin", name: "Lorem ipsum", description: "Fills text", version: 1, canManage: true, manifest: { id: v1.id } });
    expect(/^[1-9][0-9]{18}$/.test(v1.id)).toBe(true);
    expect(log.filter((l) => l.startsWith("bob PUT")).sort()).toEqual([`bob PUT /plugins/${v1.id}/parts/1/code`, `bob PUT /plugins/${v1.id}/parts/1/ui:main`, `bob PUT /plugins/${v1.id}/parts/1/ui:second`]);
    expect(log).toContain(`bob POST /plugins/${v1.id}/versions/1/commit`);
    expect(events).toContainEqual({ what: "org", orgId: w.orgId });

    // The same folder again: an update of the same plugin, only the changed part sent
    log.length = 0;
    const v2 = await bob.api.plugins.publish(w.orgId, bundle("figma.notify('v2'); figma.closePlugin()"), meta);
    expect([v2.id, v2.version]).toEqual([v1.id, 2]);
    expect(log.filter((l) => l.startsWith("bob PUT"))).toEqual([`bob PUT /plugins/${v1.id}/parts/2/code`]);

    // Another member lists and downloads it once; the cache answers after that, and offline
    const carol = await open("carol");
    expect((await carol.api.plugins.listPrivate(w.orgId)).map((p) => [p.id, p.version, p.canManage])).toEqual([[v1.id, 2, false]]);
    log.length = 0;
    const b = await carol.api.plugins.bundle(v1.id, 2);
    expect(b).toEqual({ manifest: expect.objectContaining({ id: v1.id, main: "code.js" }), code: "figma.notify('v2'); figma.closePlugin()", ui: { main: "<p>one</p>", second: "<p>two</p>" } });
    expect(log.filter((l) => l.includes("/parts/")).length).toBe(3);
    expect(existsSync(join(carol.dir, "Workspace", "spaces", "plugins", v1.id, "2", "code"))).toBe(true);
    log.length = 0;
    online = false;
    expect(await carol.api.plugins.bundle(v1.id, 2)).toEqual(b);
    expect((await carol.api.plugins.listPrivate(w.orgId)).map((p) => p.id)).toEqual([v1.id]);
    expect(await refusal(carol.api.plugins.admin(w.orgId, "plugin"))).toMatchObject({ code: "offline" });
    online = true;
    // An old version that isn't cached is refused with the current one named
    const dan = await open("dan");
    expect(await refusal(dan.api.plugins.bundle(v1.id, 1))).toMatchObject({ code: "conflict", detail: { current: 2 } });

    // Guests can't; carol can't remove bob's; bob can
    const gus = await open("gus");
    expect(await refusal(gus.api.plugins.listPrivate(w.orgId))).toMatchObject({ code: "forbidden" });
    expect(await refusal(carol.api.plugins.removePrivate(v1.id))).toMatchObject({ code: "forbidden" });
    const ref: PluginRef = { id: v1.id, name: v1.name, kind: "plugin", source: { type: "private", orgId: w.orgId, version: 2 }, editorTypes: ["figma"] };
    await bob.api.plugins.setSaved(ref, true);
    await bob.api.plugins.ranRecently(ref);
    await bob.api.plugins.removePrivate(v1.id);
    expect(await bob.api.plugins.listPrivate(w.orgId)).toEqual([]);
    expect(await bob.api.plugins.local()).toEqual({ saved: [], recents: [] });
    // A new publish from the same folder makes a new plugin (the old id is gone)
    const again = await bob.api.plugins.publish(w.orgId, bundle("x"), meta);
    expect(again.id).not.toBe(v1.id);
    expect(again.version).toBe(1);
  });

  it("refuses bad bundles before the server", async () => {
    const bob = await open("bob");
    expect(await refusal(bob.api.plugins.publish(w.orgId, { ...bundle("x"), ui: { "": "a", named: "b" } }, { name: "x", description: "", developmentPath: "/p" }))).toMatchObject({ code: "invalid" });
    expect(await refusal(bob.api.plugins.publish(w.orgId, { ...bundle("x"), ui: { "../x": "a" } }, { name: "x", description: "", developmentPath: "/p" }))).toMatchObject({ code: "invalid" });
    expect(log.filter((l) => l.includes("/plugins"))).toEqual([]);
    // The server's own refusals come back as they are
    const widget = { ...bundle("x"), manifest: { ...bundle("x").manifest, containsWidget: true, widgetApi: "1.0.0" } };
    expect(await refusal(bob.api.plugins.publish(w.orgId, widget, { name: "W", description: "", developmentPath: "/w" }))).toMatchObject({ code: "invalid", message: "Widgets aren't supported in Designer yet" });
  });
});

describe("approval (§10.2) and requests (§10.3)", () => {
  const other: PluginRef = { id: "1234567890123456789", name: "Elsewhere", kind: "plugin", source: { type: "private", orgId: "otherOrg", version: 3 }, editorTypes: ["figma"] };

  it("allowed by the org's settings, approvals for the org or the file's workspace; requests and answers", async () => {
    const alice = await open("alice");
    const settings = (body: unknown) => w.call("PATCH", `/orgs/${w.orgId}/admin/settings`, w.people.alice.token, body);
    const carol = await open("carol");
    const web = await orgCopy(carol, { key: WEB, teamId: T2, projectId: P2 }); // team Web is in workspace W1
    const draft = await orgCopy(carol, { key: DRAFT, teamId: null, projectId: null });
    const local = (await carol.api.workspace.createFile({ name: "Mine", folderId: null })).fileKey;

    // "Allow all plugins" (the default)
    expect(await carol.api.plugins.allowed(web, other)).toEqual({ ok: true });
    expect((await settings({ pluginApproval: "approved" })).status).toBe(200);
    await carol.store.org.notice({ t: "org", what: "org", orgId: w.orgId }); // the Inbox says the org changed
    expect(await carol.api.plugins.allowed(web, other)).toEqual({ ok: false, reason: "approval", canRequest: true });
    // Exempt: outside the org, the org's own private plugins, development plugins
    expect(await carol.api.plugins.allowed(local, other)).toEqual({ ok: true });
    expect(await carol.api.plugins.allowed(web, { ...other, source: { type: "private", orgId: w.orgId, version: 1 } })).toEqual({ ok: true });
    expect(await carol.api.plugins.allowed(web, dev(1))).toEqual({ ok: true });

    // carol asks; asking again isn't offered, and the server refuses a second one
    const events: PluginsEvent[] = [];
    alice.store.plugins.onEvent((e) => events.push(e));
    const req = await carol.api.plugins.request(w.orgId, { pluginId: other.id, kind: "plugin", name: other.name, manifest: { name: "Elsewhere", id: other.id, api: "1.0.0", main: "code.js", networkAccess: { allowedDomains: ["none"] } }, reason: "For our tables", workspaceId: W1 });
    expect(req).toMatchObject({ pluginId: other.id, state: "pending", reason: "For our tables", workspaceId: W1 });
    expect(await carol.api.plugins.allowed(web, other)).toEqual({ ok: false, reason: "approval", canRequest: false });
    expect(await refusal(carol.api.plugins.request(w.orgId, { pluginId: other.id, kind: "plugin", name: other.name, manifest: req.manifest!, reason: "" }))).toMatchObject({ code: "conflict" });

    // alice (admin) sees it and approves it for workspace W1 only
    const admin = await alice.api.plugins.admin(w.orgId, "plugin");
    expect(admin.requests.map((q) => [q.id, q.state])).toEqual([[req.id, "pending"]]);
    expect((await alice.api.plugins.answer(w.orgId, req.id, { approve: true, workspaceIds: [W1] })).state).toBe("approved");
    expect(events).toContainEqual({ what: "org", orgId: w.orgId });
    expect((await alice.api.plugins.admin(w.orgId, "plugin")).approved).toEqual([expect.objectContaining({ pluginId: other.id, scope: { type: "workspace", id: W1 } })]);
    // carol's approved list is kept 30 s: the Inbox's {t: "plugins"} drops it (here: said by hand)
    carol.store.plugins.orgChanged(w.orgId);
    expect(await carol.api.plugins.allowed(web, other)).toEqual({ ok: true });
    // A workspace approval doesn't reach drafts
    expect(await carol.api.plugins.allowed(draft, other)).toEqual({ ok: false, reason: "approval", canRequest: true });

    // Offline: the cached approved list answers
    online = false;
    carol.store.plugins.orgChanged(w.orgId);
    expect(await carol.api.plugins.allowed(web, other)).toEqual({ ok: true });
    online = true;

    // Approved for the whole org, then removed
    await alice.api.plugins.approve(w.orgId, { pluginId: other.id, kind: "plugin", name: other.name, scope: { type: "org" } });
    carol.store.plugins.orgChanged(w.orgId);
    expect(await carol.api.plugins.allowed(draft, other)).toEqual({ ok: true });
    await alice.api.plugins.unapprove(w.orgId, other.id);
    await alice.api.plugins.unapprove(w.orgId, other.id, W1);
    expect((await alice.api.plugins.admin(w.orgId, "plugin")).approved).toEqual([]);
    carol.store.plugins.orgChanged(w.orgId);
    expect(await carol.api.plugins.allowed(web, other)).toEqual({ ok: false, reason: "approval", canRequest: true });

    // Requests off: nothing to ask
    expect((await settings({ pluginRequests: false })).status).toBe(200);
    await carol.store.org.notice({ t: "org", what: "org", orgId: w.orgId });
    expect(await carol.api.plugins.allowed(web, other)).toEqual({ ok: false, reason: "approval", canRequest: false });
    expect(await refusal(carol.api.plugins.request(w.orgId, { pluginId: "x1", kind: "plugin", name: "x", manifest: req.manifest!, reason: "" }))).toMatchObject({ code: "forbidden" });
    // Members can't answer
    expect(await refusal(carol.api.plugins.admin(w.orgId, "plugin"))).toMatchObject({ code: "forbidden" });
  });

  it("guests can't run the org's private plugins", async () => {
    const gus = await open("gus");
    await gus.api.orgs.list();
    const local = (await gus.api.workspace.createFile({ name: "Mine", folderId: null })).fileKey;
    expect(await gus.api.plugins.allowed(local, { ...other, source: { type: "private", orgId: w.orgId, version: 1 } })).toEqual({ ok: false, reason: "guest" });
  });

  it("the Inbox's {t: \"plugins\", orgId} becomes the topic's org event", async () => {
    class Socket {
      static last: Socket | null = null;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        Socket.last = this;
      }
      send() {}
      close() {}
    }
    const mp = { signedIn: true, onSession: () => () => {}, wsUrl: () => "wss://x/notifications/ws", call: async () => ({ items: [], unread: 0, pending: 0, files: [], next: null }) } as unknown as MultiplayerService;
    const notifications = new NotificationsService(mp, { WebSocket: Socket as never, pingMs: 0 });
    const s = new PluginsService({
      server: { signedIn: true, userId: "u", request: async () => new Response("{}") },
      cache: { readJson: async () => null, writeJson: async () => {}, readBytes: async () => null, writeBytes: async () => {} },
      loadLocal: async () => null,
      saveLocal: async () => {},
      getMeta: () => null,
      orgInfo: async () => null,
      teamWorkspace: async () => null,
      notices: notifications,
      now: () => 0,
      log: () => {},
    });
    const events: PluginsEvent[] = [];
    s.onEvent((e) => events.push(e));
    Socket.last!.onmessage!({ data: JSON.stringify({ t: "plugins", orgId: "o1" }) });
    Socket.last!.onmessage!({ data: JSON.stringify({ t: "plugins" }) });
    expect(events).toEqual([{ what: "org", orgId: "o1" }]);
    s.close();
    notifications.close();
  });
});
