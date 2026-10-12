/**
 * Round 5g — the store's `devMode` repository (docs/editor.md D-1, D-3, D-4, D-6) against round 5c's server handler
 * (server/src/api.ts `handle` on node:sqlite, the org of server/src/testing/orgWorld.ts), through LocalStore and over
 * the port: a shared file's records on the server, a local file's beside its journal, a branch's on its main, the
 * report and the viewers, prototype members, the `devmode` events; MemoryStore's local records; and where a key's
 * records live (branches of shared files map to main's room).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../../../server/src/api";
import { LIB, WEB, world, type World } from "../../../server/src/testing/orgWorld";
import type { DevModeEvent } from "../../shared/devmode/types";
import { StoreClient } from "../../shared/store/client";
import { portTransport, StoreError } from "../../shared/store/protocol";
import type { FileMeta } from "../../shared/store/types";
import { StoreServer } from "../server";
import { openTestStore, settle, type TestStore } from "../testing/harness";
import { DevModeService, type DevModeHost } from "./service";

/* eslint-disable @typescript-eslint/no-explicit-any */

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
let t: TestStore;
const log: string[] = [];

async function open(token: string): Promise<TestStore> {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(String(input), init);
    log.push(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`);
    return handle(req, w.deps);
  };
  // A local file's records: the workspace not the account's cloud cache (docs/cloud.md §2)
  const s = await openTestStore({ fetch, personalDrafts: false });
  await s.api.multiplayer.setSession({ server: ORIGIN, token });
  return s;
}

beforeEach(async () => {
  vi.stubGlobal("WebSocket", NoSocket);
  w = await world();
  log.length = 0;
  t = await open(w.people.alice.token);
});

afterEach(async () => {
  await t.close();
  t.dispose();
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

describe("a shared file's records are the server's", () => {
  it("dev resources: add, list by node, edit, remove; the limit and duplicates; events over the port", async () => {
    // Over the port, as a view reaches it
    const server = new StoreServer(t.store, { generation: 1 });
    const { port1, port2 } = new MessageChannel();
    server.connect(portTransport(port1), "editor");
    const client = new StoreClient();
    client.attach(portTransport(port2));
    await client.whenReady();
    const events: DevModeEvent[] = [];
    client.devMode.watch((e) => events.push(e));
    try {
      const dm = client.devMode;
      const a = await dm.addDevResource(WEB, { nodeId: "1:2", name: "", url: "https://github.com/acme/web/blob/main/Button.tsx" });
      expect(a).toMatchObject({ fileKey: WEB, nodeId: "1:2", name: "github.com/acme/web/blob/main/Button.tsx", createdBy: w.people.alice.id });
      await dm.addDevResource(WEB, { nodeId: "3:4", name: "Storybook", url: "https://storybook.acme.test/?path=/button" });
      expect(log).toContain(`POST /files/${WEB}/dev-resources`);
      expect((await dm.devResources(WEB, ["1:2"])).map((r) => r.id)).toEqual([a.id]);
      expect((await dm.devResources(WEB)).map((r) => r.nodeId)).toEqual(["1:2", "3:4"]);
      expect(log).toContain(`GET /files/${WEB}/dev-resources?nodeIds=1%3A2`);
      expect(await refusal(dm.addDevResource(WEB, { nodeId: "1:2", name: "again", url: a.url }))).toMatchObject({ code: "conflict", message: "This link has already been added." });
      for (let i = 1; i < 10; i++) await dm.addDevResource(WEB, { nodeId: "1:2", name: `L${i}`, url: `https://x.test/${i}` });
      expect(await refusal(dm.addDevResource(WEB, { nodeId: "1:2", name: "11th", url: "https://x.test/11" }))).toMatchObject({ code: "invalid", message: "You can add up to 10 links to a layer." });
      expect(await dm.editDevResource(WEB, a.id, { name: "Button source" })).toMatchObject({ id: a.id, name: "Button source", url: a.url });
      await dm.removeDevResource(WEB, a.id);
      expect((await dm.devResources(WEB, ["1:2"])).some((r) => r.id === a.id)).toBe(false);
      // Checked before the server: a bad URL, a bad node id
      expect(await refusal(dm.addDevResource(WEB, { nodeId: "1:2", name: "", url: "javascript:alert(1)" }))).toMatchObject({ code: "invalid" });
      expect(await refusal(dm.devResources(WEB, ["nope"]))).toMatchObject({ code: "invalid" });
      await settle();
      expect(events.length).toBeGreaterThanOrEqual(12);
      expect(events.every((e) => e.fileKey === WEB && e.what === "resources")).toBe(true);
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("Code Connect UI mappings; the report, viewers and notify; prototype members", async () => {
    const dm = t.api.devMode;
    const m = await dm.setCodeConnect(WEB, { nodeId: "5:6", label: "React", language: "", source: "https://github.com/acme/web/blob/main/Button.tsx", component: "Button", imports: [], nestable: true, instructions: "Use the primary variant" });
    expect(m).toMatchObject({ fileKey: WEB, nodeId: "5:6", label: "React", language: "tsx", origin: "ui", template: null, component: "Button" });
    expect((await dm.codeConnect(WEB)).map((x) => [x.nodeId, x.label])).toEqual([["5:6", "React"]]);
    await dm.removeCodeConnect(WEB, "5:6", "React");
    expect(await dm.codeConnect(WEB)).toEqual([]);
    expect(await refusal(dm.removeCodeConnect(WEB, "5:6", "React"))).toMatchObject({ code: "not-found" });

    await dm.viewed(WEB);
    await dm.setStatusNotifications(WEB, false);
    expect((await w.call("GET", `/files/${WEB}/dev-status/notify`, w.people.alice.token)).body).toEqual({ notify: false, viewed: true });
    await dm.reportStatus(WEB, { nodeId: "1:2", nodeName: "Checkout", status: "READY_FOR_DEV", kind: "ready" });
    expect(log).toContain(`POST /files/${WEB}/dev-status`);
    expect(await refusal(dm.reportStatus(WEB, { nodeId: "1:2", nodeName: "Checkout", status: "NONE", kind: "ready" }))).toMatchObject({ code: "invalid" });

    await dm.invitePrototype(WEB, "Client@Example.test");
    expect(await dm.prototypeMembers(WEB)).toEqual([expect.objectContaining({ email: "client@example.test" })]);
    await dm.removePrototype(WEB, "client@example.test");
    expect(await dm.prototypeMembers(WEB)).toEqual([]);
  });

  it("the server's refusals come back as StoreErrors; signed out is offline", async () => {
    const dan = await open(w.people.gus.token); // a viewer of the library: reads, can't write
    try {
      expect(await refusal(dan.api.devMode.addDevResource(LIB, { nodeId: "1:2", name: "", url: "https://x.test/" }))).toMatchObject({ code: "forbidden" });
      await dan.api.multiplayer.setSession(null);
      expect(await refusal(dan.api.devMode.devResources(WEB))).toMatchObject({ code: "offline" });
    } finally {
      await dan.close();
      dan.dispose();
    }
  });
});

describe("a local file's records are the store's", () => {
  it("dev resources and mappings beside the journal, the server's rules; reports resolve at once; a branch's go to main", async () => {
    const dm = t.api.devMode;
    const file = await t.api.workspace.createFile({ name: "Local", folderId: null });
    const events: DevModeEvent[] = [];
    t.store.devMode.onEvent((e) => events.push(e));
    const before = log.length;

    const a = await dm.addDevResource(file.fileKey, { nodeId: "1:2", name: "", url: "https://jira.acme.test/browse/WEB-1" });
    expect(a).toMatchObject({ fileKey: file.fileKey, nodeId: "1:2", name: "jira.acme.test/browse/WEB-1" });
    const path = join(t.dir, "Workspace", "files", file.fileKey, "dev-resources.json");
    expect(JSON.parse(readFileSync(path, "utf8")).devResources.map((r: any) => r.id)).toEqual([a.id]);
    expect(await refusal(dm.addDevResource(file.fileKey, { nodeId: "1:2", name: "", url: a.url }))).toMatchObject({ code: "conflict", message: "This link has already been added." });
    for (let i = 1; i < 10; i++) await dm.addDevResource(file.fileKey, { nodeId: "1:2", name: "", url: `https://x.test/${i}` });
    expect(await refusal(dm.addDevResource(file.fileKey, { nodeId: "1:2", name: "", url: "https://x.test/11" }))).toMatchObject({ code: "invalid", message: "You can add up to 10 links to a layer." });
    expect(await refusal(dm.editDevResource(file.fileKey, a.id, { url: "https://x.test/1" }))).toMatchObject({ code: "conflict" });
    expect(await dm.editDevResource(file.fileKey, a.id, { name: "Ticket" })).toMatchObject({ id: a.id, name: "Ticket" });
    await dm.removeDevResource(file.fileKey, a.id);
    expect((await dm.devResources(file.fileKey, ["1:2"])).length).toBe(9);
    expect(await refusal(dm.removeDevResource(file.fileKey, a.id))).toMatchObject({ code: "not-found" });

    const m = await dm.setCodeConnect(file.fileKey, { nodeId: "7:8", label: "SwiftUI", language: "", source: "Sources/Button.swift", component: "PrimaryButton", imports: ["import UI"], nestable: false, instructions: "" });
    expect(m).toMatchObject({ language: "swift", origin: "ui", nestable: false });
    await dm.setCodeConnect(file.fileKey, { ...m, component: "Primary" });
    expect((await dm.codeConnect(file.fileKey)).map((x) => x.component)).toEqual(["Primary"]);
    expect(existsSync(join(t.dir, "Workspace", "files", file.fileKey, "code-connect.json"))).toBe(true);

    // One person: nothing to report, nobody to invite
    await dm.reportStatus(file.fileKey, { nodeId: "1:2", nodeName: "Checkout", status: "COMPLETED", kind: "completed" });
    await dm.viewed(file.fileKey);
    expect(await dm.prototypeMembers(file.fileKey)).toEqual([]);
    expect(await refusal(dm.invitePrototype(file.fileKey, "x@y.test"))).toMatchObject({ code: "invalid" });
    expect(log.length).toBe(before);

    // A branch's records are main's (its nodes keep main's GUIDs)
    const b = await t.api.branches.create(file.fileKey, "Feature");
    events.length = 0;
    const viaBranch = await dm.addDevResource(b.branchFileKey, { nodeId: "3:4", name: "From the branch", url: "https://x.test/branch" });
    expect(viaBranch.fileKey).toBe(file.fileKey);
    expect((await dm.devResources(file.fileKey, ["3:4"])).map((r) => r.name)).toEqual(["From the branch"]);
    expect((await dm.devResources(b.branchFileKey, ["3:4"])).map((r) => r.id)).toEqual([viaBranch.id]);
    expect(events).toEqual([
      { fileKey: b.branchFileKey, what: "resources" },
      { fileKey: file.fileKey, what: "resources" },
    ]);
    expect(existsSync(join(t.dir, "Workspace", "files", b.branchFileKey, "dev-resources.json"))).toBe(false);

    // A key with no file here: reads are empty, writes refused
    expect(await dm.devResources("AAAAAAAAAAAAAAAAAAAAAA")).toEqual([]);
    expect(await refusal(dm.addDevResource("AAAAAAAAAAAAAAAAAAAAAA", { nodeId: "1:2", name: "", url: "https://x.test/" }))).toMatchObject({ code: "not-found" });
  });
});

describe("where a key's records live", () => {
  const meta = (fileKey: string): FileMeta => ({ fileKey }) as FileMeta;
  function host(o: { metas: string[]; rooms?: Record<string, string>; branches?: Record<string, { mainFileKey: string; mainKey: string | null }> }): DevModeHost {
    return {
      server: { signedIn: true, userId: "u", request: async () => new Response("{}") },
      getMeta: (k) => (o.metas.includes(k) ? meta(k) : null),
      roomKey: async (k) => o.rooms?.[k] ?? null,
      linkedCopy: async (key) => Object.entries(o.rooms ?? {}).find(([, r]) => r === key)?.[0] ?? null,
      branchOf: async (k) => o.branches?.[k] ?? null,
      readLocal: async () => null,
      writeLocal: async () => {},
      now: () => 0,
    };
  }
  const L = (c: string) => c.repeat(22);

  it("a shared main's branch goes to main's room — by the branch's local key or its room key", async () => {
    const s = new DevModeService(host({ metas: [L("m"), L("b")], rooms: { [L("m")]: "file_main1", [L("b")]: "file_branch1" }, branches: { [L("b")]: { mainFileKey: L("m"), mainKey: "file_main1" } } }));
    expect(await s.recordsOf(L("b"))).toEqual({ remote: true, key: "file_main1" });
    expect(await s.recordsOf("file_branch1")).toEqual({ remote: true, key: "file_main1" });
    expect(await s.recordsOf(L("m"))).toEqual({ remote: true, key: "file_main1" });
    // A library's room key with no copy here; a local library's key
    expect(await s.recordsOf("lib_design1")).toEqual({ remote: true, key: "lib_design1" });
    expect(await s.recordsOf(L("z"))).toEqual({ remote: false, key: L("z") });
    await expect(s.recordsOf("../etc")).rejects.toMatchObject({ code: "invalid" });
  });
});
