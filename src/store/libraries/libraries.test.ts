/**
 * Org libraries in the store (docs/data.md §16.3, §16.9, §17.4–§17.5) against the contract fake of round 3a's routes
 * (fake/server.ts — swap in the real handler once 3a merges, as src/store/org/fake/real.ts does): publishing in three
 * steps, consuming with caches and offline answers, subscriptions into `enabledLibraries`, Inbox notices, the router's
 * rules, `orgLibraries`, the analytics queue and instance snapshots; then the same through LocalStore (on disk, over
 * the port), with §16.9's local → org alias.
 */
import { createHash } from "node:crypto";
import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeMessage, encodeMessage, type NodeChange } from "../../shared/schema/codec";
import { StoreClient } from "../../shared/store/client";
import { portTransport, StoreError } from "../../shared/store/protocol";
import type { FontsEvent, LibraryEvent, LibraryRegistry } from "../../shared/store/repositories";
import type { FileKey, FileMeta, FileSpace, PublishAsset } from "../../shared/store/types";
import { newMeta } from "../../shared/store/workspaceModel";
import type { LibraryUsageEvent } from "../../shared/libraries/orgTypes";
import { openTestStore, settle, type TestStore } from "../testing/harness";
import { StoreServer } from "../server";
import { NotificationsService, type LibraryNotice } from "../notifications/service";
import type { MultiplayerService } from "../multiplayer/service";
import { AnalyticsQueue, type AnalyticsQueueState } from "./analyticsQueue";
import { FakeLibraryServer } from "./fake/server";
import { CACHE, OrgLibraries, parsePayloadFrames, writePayloadFrames, type LibraryServer, type OrgLibrariesHost } from "./org";
import { orgLibrariesRepository } from "./orgLibraries";
import { LibraryRouter } from "./router";
import { usageRows, usageSnapshot, UsageReporter, type UsageState } from "./usage";

const SERVER = "https://lib.test";
const hex = (s: string) => createHash("sha1").update(s).digest("hex");
const bytesHex = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");
/** A 1×1 PNG's header is all `pngSize` reads; the rest is never decoded here */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const IMAGE = new Uint8Array([1, 2, 3, 4, 5]);

function payload(name: string, extra: Partial<NodeChange> = {}): Uint8Array {
  return encodeMessage({
    type: "NODE_CHANGES",
    sessionID: 0,
    ackID: 0,
    nodeChanges: [{ guid: { sessionID: 1048577, localID: 1 }, phase: "CREATED", type: "SYMBOL", name, parentIndex: { guid: { sessionID: 0, localID: 1 }, position: "!" }, ...extra }],
    blobs: [],
  });
}

function asset(key: string, name: string, version: string, extra: Partial<PublishAsset> = {}): PublishAsset {
  return { key: hex(key), kind: "COMPONENT", name, description: "", guid: "1048577:1", versionHash: hex(version), dependencyOnly: false, dependencies: [], payload: payload(name), ...extra };
}

/** A collection's payload with two modes, "Dark" sorted after "Light" */
function collection(name: string): PublishAsset {
  const message = encodeMessage({
    type: "NODE_CHANGES",
    sessionID: 0,
    ackID: 0,
    nodeChanges: [
      {
        guid: { sessionID: 1048577, localID: 9 },
        phase: "CREATED",
        type: "VARIABLE_SET",
        name,
        variableSetModes: [
          { id: { sessionID: 1048577, localID: 11 }, name: "Dark", sortPosition: "b" },
          { id: { sessionID: 1048577, localID: 10 }, name: "Light", sortPosition: "a" },
        ],
      },
    ],
    blobs: [],
  });
  return { key: hex(name), kind: "VARIABLE_COLLECTION", name, description: "", guid: "1048577:9", versionHash: hex(`${name}@1`), dependencyOnly: false, dependencies: [], payload: message };
}

/** The signed-in person, as the store's MultiplayerService would carry them */
class Session {
  token: string | null = null;
  uid: string | null = null;
  as(who: { user: { id: string }; token: string } | null): this {
    this.token = who?.token ?? null;
    this.uid = who?.user.id ?? null;
    return this;
  }
}

function serverOf(fake: FakeLibraryServer, s: Session): LibraryServer {
  return {
    get signedIn() {
      return s.token !== null;
    },
    get userId() {
      return s.uid;
    },
    request: async (method, path, body) => {
      if (!s.token) throw new StoreError("offline", "Log in");
      const headers: Record<string, string> = { authorization: `Bearer ${s.token}` };
      let b: RequestInit["body"];
      if (body instanceof Uint8Array) {
        b = body as unknown as RequestInit["body"];
        headers["content-type"] = "application/octet-stream";
      } else if (body !== undefined) {
        b = JSON.stringify(body);
        headers["content-type"] = "application/json";
      }
      try {
        return await fake.fetch(new URL(path, SERVER).toString(), { method, headers, body: b });
      } catch {
        throw new StoreError("offline", "Couldn't reach the server");
      }
    },
  };
}

let n = 0;
const fileKey = () => `F${String(++n).padStart(21, "0")}` as FileKey;

/** An installation's copies, blobs and caches, in memory */
class Host implements OrgLibrariesHost {
  metas = new Map<FileKey, FileMeta>();
  blobMap = new Map<string, Uint8Array>();
  cacheMap = new Map<string, unknown>();
  constructor(public server: LibraryServer) {}
  cache = {
    readJson: async <T>(name: string) => (this.cacheMap.has(name) ? (structuredClone(this.cacheMap.get(name)) as T) : null),
    writeJson: async (name: string, v: unknown) => void this.cacheMap.set(name, structuredClone(v)),
    readBytes: async (name: string) => (this.cacheMap.get(name) as Uint8Array | undefined) ?? null,
    writeBytes: async (name: string, b: Uint8Array) => void this.cacheMap.set(name, b),
  };
  add(name: string, space: FileSpace | null): FileMeta {
    const m = newMeta(fileKey(), name, null, 0);
    if (space) m.space = space;
    this.metas.set(m.fileKey, m);
    return m;
  }
  getMeta = (k: FileKey) => this.metas.get(k) ?? null;
  copyOf = (rk: string) => [...this.metas.values()].find((m) => m.space?.key === rk) ?? null;
  patchFile = async (k: FileKey, patch: Partial<FileMeta>) => {
    const m = { ...this.metas.get(k)!, ...patch };
    this.metas.set(k, m);
    return { ...m };
  };
  blobs = {
    has: async (s: string[]) => s.map((x) => this.blobMap.has(x)),
    get: async (s: string) => {
      const b = this.blobMap.get(s);
      if (!b) throw new StoreError("not-found", "no blob");
      return b;
    },
    put: async (b: Uint8Array) => {
      const sha1 = bytesHex(b);
      this.blobMap.set(sha1, b);
      return { sha1 };
    },
  };
  pngSize = (b: Uint8Array) => (b[0] === 0x89 ? { width: 1, height: 1 } : null);
  encodePayload = (m: Uint8Array) => m;
  decodePayload = async (b: Uint8Array) => b;
  log = () => {};
}

/** One org (o1), its team (t1), a library file and a consumer; alice edits both, bob is in the team */
function world() {
  const fake = new FakeLibraryServer();
  const alice = fake.addUser("alice@x.test");
  const bob = fake.addUser("bob@x.test");
  const carol = fake.addUser("carol@x.test");
  fake.addOrg("o1", [alice.user.id, bob.user.id, carol.user.id]);
  fake.addTeam("t1", [alice.user.id, bob.user.id]);
  fake.addFile("lib_A", { orgId: "o1", teamId: "t1", name: "Design System", editors: [alice.user.id] });
  fake.addFile("app_B", { orgId: "o1", teamId: "t1", name: "App", editors: [alice.user.id, bob.user.id] });
  fake.addFile("app_C", { orgId: "o1", teamId: null, name: "Carol's", editors: [carol.user.id] });
  const client = (who: typeof alice | null) => {
    const session = new Session().as(who);
    const host = new Host(serverOf(fake, session));
    const notices = new Set<(n: LibraryNotice) => void>();
    const org = new OrgLibraries(host, { onLibrary: (l) => (notices.add(l), () => notices.delete(l)) });
    return { session, host, org, notify: (msg: LibraryNotice) => notices.forEach((l) => l(msg)) };
  };
  return { fake, alice, bob, carol, client };
}

const space = (key: string, projectId: string | null = "p1", teamId: string | null = "t1"): FileSpace => ({ orgId: "o1", key, teamId, projectId });

describe("the org registry (docs/data.md §16.3, §16.6)", () => {
  it("publishes in three steps: what is missing, the uploads, the commit; a stale base is a conflict", async () => {
    const { fake, alice, client } = world();
    const a = client(alice);
    a.host.add("Design System", space("lib_A"));
    const events: LibraryEvent[] = [];
    a.org.watch((e) => events.push(e));
    const button = asset("button", "Button", "button@1", { thumbnailPng: PNG, payload: payload("Button", { fillPaints: [{ type: "IMAGE", image: { hash: createHash("sha1").update(IMAGE).digest() } }] }) });
    await a.host.blobs.put(IMAGE);
    const colors = collection("Colors");

    const preview = await a.org.previewPublish("lib_A", [button, colors]);
    expect(preview.created.map((x) => x.name)).toEqual(["Button", "Colors"]);
    fake.log.length = 0;
    const v1 = await a.org.publish({ libraryFileKey: "lib_A", description: "First", assets: [button, colors], moves: [], scope: "org" });
    expect(v1.version).toBe(1);
    expect(fake.log).toEqual([
      "GET /libraries/lib_A/versions/latest",
      "POST /libraries/lib_A/missing",
      `PUT /libraries/lib_A/payloads/${button.key}/${button.versionHash}`,
      `PUT /libraries/lib_A/payloads/${colors.key}/${colors.versionHash}`,
      `PUT /libraries/lib_A/blobs/${bytesHex(PNG)}`,
      `PUT /libraries/lib_A/blobs/${bytesHex(IMAGE)}`,
      "POST /libraries/lib_A/versions",
    ]);
    const lib = fake.libraries.get("lib_A")!;
    expect(lib.scope).toBe("org");
    expect(fake.files.get("lib_A")!.orgLinkAccess).toBe("viewer"); // "Allow any member of ‹org›…" sets the link
    expect(lib.collections).toEqual([{ collectionKey: colors.key, name: "Colors", modes: [{ id: "1048577:10", name: "Light" }, { id: "1048577:11", name: "Dark" }] }]);
    expect(v1.assets.find((x) => x.key === button.key)!.thumbnail).toEqual({ sha1: bytesHex(PNG), width: 1, height: 1 });
    expect(a.host.copyOf("lib_A")!.library).toEqual({ status: "published", latestVersion: 1 });
    expect(events).toEqual([{ type: "published", libraryFileKey: "lib_A", version: 1 }]);

    // Unchanged assets upload nothing the second time.
    fake.log.length = 0;
    const v2 = await a.org.publish({ libraryFileKey: "lib_A", description: "", assets: [{ ...button, thumbnailPng: undefined }, colors], moves: [] });
    expect(v2.version).toBe(2);
    expect(fake.log.filter((l) => l.startsWith("PUT"))).toEqual([]);
    expect(lib.scope).toBe("org"); // absent: the library's current scope

    // Someone else publishes between this preview and its commit: the commit refuses the stale base.
    fake.onRequest = (method, path) => {
      if (path.endsWith("/missing")) lib.versions.push({ ...lib.versions.at(-1)!, version: lib.versions.length + 1 });
    };
    await expect(a.org.publish({ libraryFileKey: "lib_A", description: "", assets: [asset("button", "Button", "button@4")], moves: [] })).rejects.toMatchObject({ code: "conflict" });
    fake.onRequest = null;
    expect(events.at(-1)).toEqual({ type: "published", libraryFileKey: "lib_A", version: 2 });
  });

  it("refuses drafts and people who can't edit with the server's codes; signed out is offline", async () => {
    const { fake, alice, bob, client } = world();
    fake.addFile("draft_D", { orgId: "o1", projectId: null, editors: [alice.user.id] });
    const a = client(alice);
    a.host.add("Draft", space("draft_D", null, null));
    await expect(a.org.publish({ libraryFileKey: "draft_D", description: "", assets: [asset("x", "X", "x@1")], moves: [] })).rejects.toMatchObject({ code: "forbidden", detail: { code: "draft_cannot_publish" } });
    const b = client(bob);
    b.host.add("Design System", space("lib_A"));
    await expect(b.org.publish({ libraryFileKey: "lib_A", description: "", assets: [asset("x", "X", "x@1")], moves: [] })).rejects.toMatchObject({ code: "forbidden" });
    const out = client(null);
    out.host.add("Design System", space("lib_A"));
    await expect(out.org.publish({ libraryFileKey: "lib_A", description: "", assets: [asset("x", "X", "x@1")], moves: [] })).rejects.toMatchObject({ code: "offline" });
  });

  it("consumes: lists relative to the file, subscriptions into enabledLibraries, payloads with dependencies and images, offline from the caches", async () => {
    const { fake, alice, bob, carol, client } = world();
    const a = client(alice);
    a.host.add("Design System", space("lib_A"));
    await a.host.blobs.put(IMAGE);
    const icon = asset("icon", "Icon", "icon@1", { dependencyOnly: true, payload: payload("Icon", { fillPaints: [{ type: "IMAGE", image: { hash: createHash("sha1").update(IMAGE).digest() } }] }) });
    const button = asset("button", "Button", "button@1", { dependencies: [icon.key] });
    await a.org.publish({ libraryFileKey: "lib_A", description: "", assets: [button, icon], moves: [] });

    const b = client(bob);
    const app = b.host.add("App", space("app_B"));
    const list = await b.org.listAvailable(app.fileKey);
    expect(list.map((r) => [r.libraryFileKey, r.org.scope, r.org.via, r.org.enabledByDefault])).toEqual([["lib_A", "team", ["team"], false]]);
    expect(list[0].counts).toEqual({ components: 1, styles: 0, variables: 0 });
    // Team scope: carol (in the org, not the team) doesn't see it.
    const c = client(carol);
    const cf = c.host.add("Carol's", space("app_C", "p2", null));
    expect(await c.org.listAvailable(cf.fileKey)).toEqual([]);

    // Enabled by default at the org (scope becomes org): the file's list follows the server.
    await orgLibrariesRepository(a.host.server).updateSettings("o1", "lib_A", { scope: { type: "org", id: "o1" }, defaults: { design: true } });
    expect(fake.libraries.get("lib_A")!.scope).toBe("org");
    expect((await c.org.listAvailable(cf.fileKey)).map((r) => r.org.via)).toEqual([["org"]]);
    expect(c.host.getMeta(cf.fileKey)!.enabledLibraries).toEqual(["lib_A"]);
    // An explicit off overrides the default; null goes back to it.
    expect((await c.org.setEnabled(cf.fileKey, "lib_A", false)).enabledLibraries).toEqual([]);
    expect((await c.org.setEnabled(cf.fileKey, "lib_A", null)).enabledLibraries).toEqual(["lib_A"]);

    const got = await b.org.getPayloads("lib_A", [{ key: button.key, versionHash: button.versionHash }], { withDependencies: true });
    expect(got.map((p) => p.key)).toEqual([button.key, icon.key]);
    expect(decodeMessage(got[0].message).nodeChanges![0].name).toBe("Button");
    expect(b.host.blobMap.has(bytesHex(IMAGE))).toBe(true); // the image came before the payloads
    expect(b.host.cacheMap.has(CACHE.payload("lib_A", button.key, button.versionHash))).toBe(true);

    // Offline: the caches answer (the manifest read online first, as the editor does).
    await b.org.getVersion("lib_A");
    fake.online = false;
    expect((await b.org.listAvailable(app.fileKey)).map((r) => r.libraryFileKey)).toEqual(["lib_A"]);
    expect((await b.org.getVersion("lib_A")).version).toBe(1);
    expect((await b.org.getRecord("lib_A"))?.latestVersion).toBe(1);
    expect((await b.org.getPayloads("lib_A", [{ key: button.key, versionHash: button.versionHash }], { withDependencies: true })).map((p) => p.key)).toEqual([button.key, icon.key]);
    const offline = await b.org.diff("lib_A", [{ key: button.key, versionHash: hex("old") }]);
    expect(offline.updated.map((x) => x.key)).toEqual([button.key]);
    await expect(b.org.setEnabled(app.fileKey, "lib_A", true)).rejects.toMatchObject({ code: "offline" });
    fake.online = true;

    // Another account's cached lists aren't shown.
    b.session.as(carol);
    fake.online = false;
    expect(await b.org.listAvailable(app.fileKey)).toEqual([]);
  });

  it("turns Inbox notices into LibraryEvents", () => {
    const { client, alice } = world();
    const a = client(alice);
    const events: LibraryEvent[] = [];
    a.org.watch((e) => events.push(e));
    a.notify({ t: "library", libraryKey: "lib_A", version: 3 });
    a.notify({ t: "library", libraryKey: "lib_A", status: "unpublished" });
    a.notify({ t: "library", libraryKey: "AAAAAAAAAAAAAAAAAAAAAA", version: 1 }); // a local key: not the org's
    expect(events).toEqual([
      { type: "published", libraryFileKey: "lib_A", version: 3 },
      { type: "status", libraryFileKey: "lib_A", status: "unpublished" },
    ]);
  });

  it("frames payload answers as §16.10 says", () => {
    const items = [
      { key: hex("a"), versionHash: hex("1"), bytes: new Uint8Array([1, 2, 3]) },
      { key: hex("b"), versionHash: hex("2"), bytes: new Uint8Array([]) },
    ];
    expect(parsePayloadFrames(writePayloadFrames(items))).toEqual(items);
    expect(() => parsePayloadFrames(new Uint8Array([2, 0, 0, 0]))).toThrow(StoreError);
  });
});

describe("the router (docs/data.md §16.3, §16.9)", () => {
  function routed() {
    const w = world();
    const a = w.client(w.alice);
    const calls: string[] = [];
    const local: LibraryRegistry = {
      listAvailable: async (k) => (calls.push(`list ${k}`), []),
      getRecord: async (k) => (calls.push(`record ${k}`), null),
      getVersion: async (k) => (calls.push(`version ${k}`), { libraryFileKey: k, version: 1, publishedAt: 0, description: "", changes: { created: [], modified: [], removed: [], moved: [] }, assets: [] }),
      previewPublish: async () => ({ created: [], modified: [], removed: [], moved: [], unchanged: [] }),
      publish: async (req) => (calls.push(`publish ${req.libraryFileKey}`), { libraryFileKey: req.libraryFileKey, version: 1, publishedAt: 0, description: "", changes: { created: [], modified: [], removed: [], moved: [] }, assets: [] }),
      unpublish: async () => {},
      setEnabled: async (f, k) => (calls.push(`enable ${f} ${k}`), a.host.getMeta(f)!),
      getPayloads: async () => [],
      diff: async (k) => (calls.push(`diff ${k}`), { latestVersion: 1, updated: [], removed: [], moved: [] }),
      watch: () => () => {},
    };
    const moved = new Map<FileKey, { to: string; at: number }>();
    const router = new LibraryRouter(local, a.org, {
      getMeta: a.host.getMeta,
      copyOf: a.host.copyOf,
      patchFile: a.host.patchFile,
      moved: { movedTo: (k) => moved.get(k) ?? null, movedFrom: (to) => [...moved].filter(([, m]) => m.to === to).map(([k]) => k), markMoved: async (k, to) => void moved.set(k, { to, at: 1 }) },
      log: () => {},
    });
    return { ...w, a, router, calls, moved };
  }

  it("sends local keys and local files to the local registry, room keys and org copies to the org one", async () => {
    const { a, router, calls, fake } = routed();
    const localFile = a.host.add("Local", null);
    const orgFile = a.host.add("App", space("app_B"));
    await router.listAvailable(localFile.fileKey);
    await router.listAvailable(orgFile.fileKey);
    await router.getRecord(localFile.fileKey);
    await router.getRecord("lib_A");
    expect(calls).toEqual([`list ${localFile.fileKey}`, `record ${localFile.fileKey}`]);
    expect(fake.log).toContain("GET /libraries");
    expect(fake.log).toContain("GET /libraries/lib_A");
    // Figma's rule: a local file can't add an org library.
    await expect(router.setEnabled(localFile.fileKey, "lib_A", true)).rejects.toMatchObject({ code: "forbidden" });
    // An org copy publishing under its local key publishes its room key.
    a.host.add("Design System", space("lib_A"));
    const libCopy = a.host.copyOf("lib_A")!;
    const v = await router.publish({ libraryFileKey: libCopy.fileKey, description: "", assets: [asset("b", "B", "b@1")], moves: [] });
    expect(v.libraryFileKey).toBe("lib_A");
    expect(calls.filter((c) => c.startsWith("publish"))).toEqual([]);
  });

  it("forwards a moved local library's consumers to the org library and swaps the key on accept (§16.9)", async () => {
    const { a, router, moved } = routed();
    a.host.add("Design System", space("lib_A"));
    const libLocalKey = a.host.copyOf("lib_A")!.fileKey;
    const button = asset("button", "Button", "button@1");
    await router.publish({ libraryFileKey: "lib_A", description: "", assets: [button], moves: [] });
    expect(moved.get(libLocalKey)?.to).toBe("lib_A"); // markMoved after the first org publish
    const consumer = a.host.add("Local consumer", null);
    await a.host.patchFile(consumer.fileKey, { enabledLibraries: [libLocalKey] });
    const d = await router.diff(libLocalKey, [
      { key: button.key, versionHash: hex("button@0") },
      { key: hex("gone"), versionHash: hex("gone@0") },
    ]);
    expect(d.moved).toEqual([{ fromLibraryFileKey: libLocalKey, fromKey: button.key, toLibraryFileKey: "lib_A", toKey: button.key, version: 1, at: 1 }]);
    expect(d.removed).toEqual([hex("gone")]);
    expect((await router.setEnabled(consumer.fileKey, "lib_A", true)).enabledLibraries).toEqual(["lib_A"]);
    // Signed out: the old manifest's answer.
    a.session.as(null);
    expect((await router.diff(libLocalKey, [{ key: button.key, versionHash: hex("button@0") }])).moved).toEqual([]);
  });
});

describe("orgLibraries (docs/data.md §16.5, §16.10)", () => {
  it("lists, reads, changes settings and scope, lists a team's", async () => {
    const { alice, bob, client } = world();
    const a = client(alice);
    a.host.add("Design System", space("lib_A"));
    await a.org.publish({ libraryFileKey: "lib_A", description: "", assets: [collection("Colors")], moves: [] });
    const repo = orgLibrariesRepository(a.host.server);
    expect((await repo.list("o1")).map((l) => [l.key, l.scope, l.counts.variables])).toEqual([["lib_A", "team", 0]]);
    const info = await repo.updateSettings("o1", "lib_A", { scope: { type: "org", id: "o1" }, approved: true });
    expect(info.approved.org).toBe(true);
    expect((await repo.list("o1", { approved: true })).length).toBe(1);
    expect((await repo.get("o1", "lib_A")).collections[0].modes.map((m) => m.name)).toEqual(["Light", "Dark"]);
    const team = await repo.updateSettings("o1", "lib_A", { scope: { type: "team", id: "t1" }, defaults: { design: true }, defaultModes: [{ collectionKey: hex("Colors"), modeId: "1048577:11" }] });
    expect(team.defaultIn.teamIds).toEqual(["t1"]);
    expect((await repo.setScope("lib_A", "org")).scope).toBe("org");
    const rows = await orgLibrariesRepository(client(bob).host.server).teamLibraries("t1");
    expect(rows[0].setting).toMatchObject({ scope: { type: "team", id: "t1" }, defaults: { design: true }, defaultModes: [{ collectionKey: hex("Colors"), modeId: "1048577:11" }] });
    await expect(repo.updateSettings("o1", "lib_A", { scope: { type: "nope" as never, id: "x" } })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("analytics (docs/data.md §17.4–§17.5)", () => {
  class Timers {
    next = 1;
    pending = new Map<number, { fn: () => void; ms: number }>();
    setTimeout = (fn: () => void, ms: number) => (this.pending.set(this.next, { fn, ms }), this.next++);
    clearTimeout = (h: unknown) => void this.pending.delete(h as number);
    async fire(ms: number) {
      for (const [id, t] of [...this.pending]) {
        if (t.ms !== ms) continue;
        this.pending.delete(id);
        t.fn();
      }
      await settle();
    }
  }

  function queued() {
    const w = world();
    const a = w.client(w.alice);
    const timers = new Timers();
    let saved: AnalyticsQueueState | null = null;
    let now = Date.UTC(2026, 9, 11, 12);
    const queue = new AnalyticsQueue({ server: a.host.server, getMeta: a.host.getMeta, load: async () => saved, save: async (s) => void (saved = structuredClone(s)), now: () => now, timers, log: () => {} });
    const file = a.host.add("App", space("app_B"));
    const ev = (extra: Partial<LibraryUsageEvent> = {}): LibraryUsageEvent => ({ fileKey: file.fileKey, libraryKey: "lib_A", assetKey: hex("button"), assetType: "component", action: "insert", count: 1, at: now, ...extra });
    return { ...w, a, timers, queue, file, ev, saved: () => saved, setNow: (t: number) => (now = t) };
  }

  it("aggregates per (day, file, library, asset, type, action), keeps only org files in folders and org libraries", async () => {
    const { a, queue, ev } = queued();
    const draft = a.host.add("Draft", space("draft_D", null, null));
    const local = a.host.add("Local", null);
    const branch = a.host.add("Branch", space("br_E"));
    await a.host.patchFile(branch.fileKey, { branch: { mainFileKey: local.fileKey, name: "b", status: "active" } as never });
    await queue.record([ev(), ev({ count: 2 }), ev({ action: "detach" }), ev({ fileKey: draft.fileKey }), ev({ fileKey: local.fileKey }), ev({ fileKey: branch.fileKey }), ev({ libraryKey: "AAAAAAAAAAAAAAAAAAAAAA" }), ev({ count: 0 }), ev({ at: Date.UTC(2026, 9, 1) })]);
    expect(queue.pending()).toEqual([
      { day: "2026-10-11", file: "app_B", library: "lib_A", asset: hex("button"), type: "component", action: "insert", count: 3 },
      { day: "2026-10-11", file: "app_B", library: "lib_A", asset: hex("button"), type: "component", action: "detach", count: 1 },
    ]);
  });

  it("saves debounced, sends every 10 minutes: 2xx and 4xx take rows out, 5xx keeps them; chunks of 500", async () => {
    const { fake, queue, ev, timers, saved } = queued();
    queue.start();
    await queue.record([ev()]);
    expect(saved()).toBeNull();
    await timers.fire(5000);
    expect(saved()?.rows).toHaveLength(1);
    fake.eventsStatus = 503;
    await timers.fire(10 * 60 * 1000);
    expect(queue.pending()).toHaveLength(1);
    fake.eventsStatus = 200;
    await queue.record(Array.from({ length: 600 }, (_, i) => ev({ assetKey: hex(`a${i}`) })));
    fake.log.length = 0;
    await timers.fire(10 * 60 * 1000);
    expect(fake.log.filter((l) => l === "POST /analytics/library-events")).toHaveLength(2);
    expect(fake.events).toHaveLength(601);
    expect(queue.pending()).toEqual([]);
    expect(saved()?.rows).toEqual([]);
    fake.eventsStatus = 400;
    await queue.record([ev()]);
    await queue.flush();
    expect(queue.pending()).toEqual([]);
  });

  it("drops rows older than 7 days, what another account queued, and queues nothing signed out", async () => {
    const { a, queue, ev, setNow, carol } = queued();
    await queue.record([ev()]);
    setNow(Date.UTC(2026, 9, 20));
    a.host.server.request = async () => {
      throw new StoreError("offline", "x");
    };
    await queue.flush();
    expect(queue.pending()).toEqual([]);
    const b = queued();
    await b.queue.record([b.ev()]);
    b.a.session.as(carol);
    await b.queue.record([]);
    expect(b.queue.pending()).toEqual([]);
    b.a.session.as(null);
    await b.queue.record([b.ev()]);
    expect(b.queue.pending()).toEqual([]);
  });

  it("counts instances, styles, variables and modes of org-library copies, not inside copies (§17.4)", async () => {
    const g = (l: number) => ({ sessionID: 1, localID: l });
    const page = { guid: g(1), phase: "CREATED", type: "CANVAS" } as NodeChange;
    const internal = { guid: g(2), phase: "CREATED", type: "CANVAS" } as NodeChange;
    const copy = (l: number, type: NodeChange["type"], key: string, lib = "lib_A", extra: Partial<NodeChange> = {}): NodeChange => ({ guid: g(l), phase: "CREATED", type, key: hex(key), sourceLibraryKey: lib, parentIndex: { guid: g(2), position: "a" }, ...extra });
    const nodes: NodeChange[] = [
      page,
      internal,
      copy(10, "SYMBOL", "button"),
      copy(11, "INSTANCE", "nested", "lib_A", { parentIndex: { guid: g(10), position: "a" }, symbolData: { symbolID: g(10) } }), // inside a copy
      copy(12, "SYMBOL", "localcopy", "AAAAAAAAAAAAAAAAAAAAAA"),
      copy(13, "RECTANGLE", "fill", "lib_A", { styleType: "FILL" }),
      copy(14, "VARIABLE", "brand"),
      copy(15, "VARIABLE_SET", "colors"),
      { guid: g(20), phase: "CREATED", type: "INSTANCE", parentIndex: { guid: g(1), position: "a" }, symbolData: { symbolID: g(10) }, styleIdForFill: { guid: g(13) }, styleIdForStrokeFill: { guid: g(13) } },
      { guid: g(21), phase: "CREATED", type: "INSTANCE", parentIndex: { guid: g(1), position: "b" }, symbolData: { symbolID: g(10) }, variableModeBySetMap: { entries: [{ variableSetID: { guid: g(15) }, variableModeID: g(99) }] } },
      { guid: g(22), phase: "CREATED", type: "INSTANCE", parentIndex: { guid: g(1), position: "c" }, symbolData: { symbolID: g(12) } }, // a local library: not counted
      {
        guid: g(23),
        phase: "CREATED",
        type: "RECTANGLE",
        parentIndex: { guid: g(1), position: "d" },
        fillPaints: [{ type: "SOLID", colorVar: { value: { alias: { guid: g(14) } }, dataType: "ALIAS" } }],
        parameterConsumptionMap: { entries: [{ variableData: { value: { alias: { guid: g(14) } }, dataType: "ALIAS" }, variableField: "WIDTH" }] },
      } as NodeChange,
    ];
    const rows = usageRows(nodes);
    expect(rows.assets).toEqual(
      [
        { library: "lib_A", asset: hex("button"), type: "component", instances: 2 },
        { library: "lib_A", asset: hex("fill"), type: "style", instances: 1 },
        { library: "lib_A", asset: hex("brand"), type: "variable", instances: 1 },
      ].sort((x, y) => (x.asset < y.asset ? -1 : 1)),
    );
    expect(rows.modes).toEqual([{ library: "lib_A", collection: hex("colors"), mode: "1:99", instances: 1 }]);
    expect((await usageSnapshot(nodes)).hash).toBe((await usageSnapshot([...nodes].reverse())).hash);
  });

  it("snapshots on close or idle, once per UTC day per file, only when the head moved", async () => {
    const { a, fake } = queued();
    const file = a.host.add("App", space("app_B"));
    const timers = new Timers();
    let headSeq = 1;
    let now = Date.UTC(2026, 9, 11, 12);
    let state: UsageState | null = null;
    const nodes: NodeChange[] = [];
    const reporter = new UsageReporter({ server: a.host.server, getMeta: a.host.getMeta, readDocument: async () => ({ nodes, headSeq }), load: async () => state, save: async (s) => void (state = structuredClone(s)), now: () => now, timers, log: () => {} });
    const puts = () => fake.log.filter((l) => l === "PUT /files/app_B/library-usage").length;
    reporter.touched(file.fileKey);
    await timers.fire(5 * 60 * 1000);
    expect(puts()).toBe(1);
    expect(fake.usage.get("app_B")).toMatchObject({ assets: [], modes: [] });
    headSeq = 2;
    reporter.closedFile(file.fileKey);
    await settle();
    expect(puts()).toBe(1); // the same day
    now += 86_400_000;
    reporter.closedFile(file.fileKey);
    await settle();
    expect(puts()).toBe(1); // a new day, same hash: nothing to send
    expect(state!.files[file.fileKey]).toMatchObject({ day: "2026-10-12", headSeq: 2 });
    now += 86_400_000;
    headSeq = 3;
    nodes.push({ guid: { sessionID: 1, localID: 5 }, phase: "CREATED", type: "SYMBOL", key: hex("x"), sourceLibraryKey: "lib_A" }, { guid: { sessionID: 1, localID: 6 }, phase: "CREATED", type: "INSTANCE", symbolData: { symbolID: { sessionID: 1, localID: 5 } } });
    reporter.closedFile(file.fileKey);
    await settle();
    expect(puts()).toBe(2);
  });
});

describe("the Inbox's library and fonts notices (docs/data.md §16.7, docs/desktop.md §14.3)", () => {
  it("are handed on by NotificationsService", async () => {
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
    const s = new NotificationsService(mp, { WebSocket: Socket as never, pingMs: 0 });
    const libs: LibraryNotice[] = [];
    const fonts: unknown[] = [];
    s.onLibrary((l) => libs.push(l));
    s.onFonts((f) => fonts.push(f));
    Socket.last!.onmessage!({ data: JSON.stringify({ t: "library", libraryKey: "lib_A", version: 2 }) });
    Socket.last!.onmessage!({ data: JSON.stringify({ t: "fonts", orgId: "o1", version: "v9" }) });
    expect(libs).toEqual([{ t: "library", libraryKey: "lib_A", version: 2 }]);
    expect(fonts).toEqual([{ t: "fonts", orgId: "o1", version: "v9" }]);
    s.close();
  });
});

describe("LocalStore's org libraries (on disk, over the port)", () => {
  let t: TestStore | null = null;
  afterEach(async () => {
    await t?.close().catch(() => {});
    t?.dispose();
    t = null;
  });

  it("publishes an org copy's library, caches under Workspace/spaces, routes over RPC, moves a local library into the org", async () => {
    const { fake, alice } = world();
    t = await openTestStore({ fetch: fake.fetch });
    await t.api.multiplayer.setSession({ server: SERVER, token: alice.token });
    const { workspace, libraries } = t.api;

    // A local library with a local consumer, then its file moves into the org (§16.9).
    const folder = await workspace.createFolder({ name: "Team", parentId: null });
    const lib = await workspace.createFile({ name: "Design System", folderId: folder.id });
    const button = asset("button", "Button", "button@1");
    await libraries.publish({ libraryFileKey: lib.fileKey, description: "", assets: [button], moves: [] });
    const consumer = await workspace.createFile({ name: "Local app", folderId: null });
    await libraries.setEnabled(consumer.fileKey, lib.fileKey, true);
    await t.store.ws.queue.run(() => t!.store.ws.setFileSpace(lib.fileKey, space("lib_A")));

    // Publishing it now publishes the org library (deflate-raw containers), and writes moved.json.
    const b2 = asset("button", "Button", "button@2");
    const v = await libraries.publish({ libraryFileKey: lib.fileKey, description: "To the org", assets: [b2], moves: [] });
    expect(v).toMatchObject({ libraryFileKey: "lib_A", version: 1 });
    expect(t.store.libraries.movedTo(lib.fileKey)?.to).toBe("lib_A");
    const stored = fake.libraries.get("lib_A")!.payloads.get(`${b2.key}/${b2.versionHash}`)!;
    expect(new TextDecoder().decode(stored.subarray(0, 8))).toMatch(/^fig-/);
    const d = await libraries.diff(lib.fileKey, [{ key: button.key, versionHash: button.versionHash }]);
    expect(d.moved.map((m) => m.toLibraryFileKey)).toEqual(["lib_A"]);
    expect((await libraries.setEnabled(consumer.fileKey, "lib_A", true)).enabledLibraries).toEqual(["lib_A"]);

    // An org consumer over the port: payloads come back decoded, cached on disk.
    const app = await t.store.createOrgFile({ name: "App", space: space("app_B") });
    const { port1, port2 } = new MessageChannel();
    const server = new StoreServer(t.store, { generation: 1 });
    server.connect(portTransport(port1), "editor");
    const client = new StoreClient();
    client.attach(portTransport(port2));
    await client.whenReady();
    expect((await client.libraries.listAvailable(app.fileKey)).map((r) => r.libraryFileKey)).toEqual(["lib_A"]);
    const got = await client.libraries.getPayloads("lib_A", [{ key: b2.key, versionHash: b2.versionHash }], { withDependencies: false });
    expect(decodeMessage(got[0].message).nodeChanges![0].name).toBe("Button");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    await settle();
    expect(existsSync(join(t.store.dirs.root, "spaces", ...CACHE.payload("lib_A", b2.key, b2.versionHash).split("/")))).toBe(true);
    await vi.waitFor(() => expect(existsSync(join(t!.store.dirs.root, "spaces", "library-lists", "o1.json"))).toBe(true));
    expect((await client.orgLibraries.list("o1")).map((l) => l.key)).toEqual(["lib_A"]);
    expect((await client.analytics.overview("lib_A")).libraryKey).toBe("lib_A");
    await client.analytics.record([{ fileKey: app.fileKey, libraryKey: "lib_A", assetKey: b2.key, assetType: "component", action: "insert", count: 1, at: t.clock.now() }]);
    expect(t.store.analytics.pending()).toHaveLength(1);

    // Topics: a library notice and a fonts notice reach the client.
    const events: LibraryEvent[] = [];
    const fontEvents: FontsEvent[] = [];
    client.libraries.watch((e) => events.push(e));
    client.watchFonts((e) => fontEvents.push(e));
    t.store.orgLibraries.notice({ t: "library", libraryKey: "lib_A", version: 2 });
    (t.store.notifications as unknown as { fontsListeners: Set<(n: unknown) => void> }).fontsListeners.forEach((l) => l({ t: "fonts", orgId: "o1", version: "v2" }));
    await settle();
    expect(events).toEqual([{ type: "published", libraryFileKey: "lib_A", version: 2 }]);
    expect(fontEvents).toEqual([{ orgId: "o1", version: "v2" }]);

    // The quit sends what is queued.
    client.close();
    server.close();
    await t.close();
    expect(fake.events).toHaveLength(1);
  });
});
