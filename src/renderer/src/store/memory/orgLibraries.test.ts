// Org libraries in the browser's dev store (docs/data.md §16.3): the desktop store's registry and router over
// MemoryStore — a publish from an org copy, read back decoded (deflate-raw containers through DecompressionStream),
// the list cached under designer.devStore.v1.libs.<orgId>, analytics queued.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeMessage, encodeMessage, newDocumentMessage } from "../../../../shared/schema/codec";
import { FakeLibraryServer } from "../../../../store/libraries/fake/server";
import { KV_PREFIX, memoryStorage } from "./kv";
import { MemoryStore } from "./memoryStore";

const hex = (s: string) => createHash("sha1").update(s).digest("hex");

afterEach(() => vi.unstubAllGlobals());

describe("org libraries in the dev store (docs/data.md §16.3)", () => {
  it("publishes from an org copy, serves the payloads back, caches the list, queues analytics", async () => {
    const fake = new FakeLibraryServer();
    const alice = fake.addUser("alice@x.test");
    fake.addOrg("o1", [alice.user.id]);
    fake.addTeam("t1", [alice.user.id]);
    fake.addFile("lib_A", { orgId: "o1", teamId: "t1", editors: [alice.user.id] });
    fake.addFile("app_B", { orgId: "o1", teamId: "t1", editors: [alice.user.id] });
    vi.stubGlobal("fetch", fake.fetch);
    const storage = memoryStorage();
    const store = await MemoryStore.open({ storage });
    try {
      const api = store.api({});
      await api.multiplayer.setSession({ server: "https://lib.test", token: alice.token });
      const space = (key: string) => ({ orgId: "o1", key, teamId: "t1", projectId: "p1" });
      await store.addFile({ name: "Design System", folderId: null, snapshot: encodeMessage(newDocumentMessage()), space: space("lib_A") });
      const app = await store.addFile({ name: "App", folderId: null, snapshot: encodeMessage(newDocumentMessage()), space: space("app_B") });
      const message = encodeMessage({ type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: [{ guid: { sessionID: 1048577, localID: 1 }, phase: "CREATED", type: "SYMBOL", name: "Button" }], blobs: [] });
      const button = { key: hex("button"), kind: "COMPONENT" as const, name: "Button", description: "", guid: "1048577:1", versionHash: hex("b@1"), dependencyOnly: false, dependencies: [], payload: message };
      expect((await api.libraries.publish({ libraryFileKey: "lib_A", description: "", assets: [button], moves: [] })).version).toBe(1);
      expect((await api.libraries.listAvailable(app.fileKey)).map((r) => r.libraryFileKey)).toEqual(["lib_A"]);
      expect(storage.get(`${KV_PREFIX}libs.o1`)).toContain("lib_A");
      const got = await api.libraries.getPayloads("lib_A", [{ key: button.key, versionHash: button.versionHash }], { withDependencies: false });
      expect(decodeMessage(got[0].message).nodeChanges![0].name).toBe("Button");
      await api.analytics.record([{ fileKey: app.fileKey, libraryKey: "lib_A", assetKey: button.key, assetType: "component", action: "insert", count: 1, at: Date.now() }]);
      expect(store.analytics.pending()).toHaveLength(1);
      expect((await api.orgLibraries.list("o1")).map((l) => l.key)).toEqual(["lib_A"]);
    } finally {
      store.dispose();
    }
  });
});
