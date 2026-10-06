import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codec, type NodeChange } from "../../shared/schema/document.generated";
import { guidKey } from "../../shared/schema/guid";
import { fromHex } from "../../shared/schema/visit";
import type { FileChange } from "../../shared/store/repositories";
import { batch, openTestStore, rect, settle, tempDir, type TestStore } from "../testing/harness";
import { MemoryFirestore, MemoryStorage, type FirebaseDrivers } from "./drivers";
import { startSync, type Replicator, type SyncStatus } from "./replicator";

const CONFIG = { firebase: { apiKey: "k", authDomain: "x.firebaseapp.com", projectId: "x", storageBucket: "x.appspot.com", appId: "1:2:web:3" } };

const stores: TestStore[] = [];
afterEach(async () => {
  for (const t of stores.splice(0)) {
    await t.close().catch(() => {});
    t.dispose();
  }
});

function withConfig(dir = tempDir()): string {
  mkdirSync(join(dir, "firebase"), { recursive: true });
  writeFileSync(join(dir, "firebase", "config.json"), JSON.stringify(CONFIG));
  return dir;
}

async function open(dir: string, deviceOrdinal = 1): Promise<TestStore> {
  const t = await openTestStore({ dir, deviceOrdinal });
  stores.push(t);
  return t;
}

function cloud(): FirebaseDrivers & { firestore: MemoryFirestore; storage: MemoryStorage } {
  return { firestore: new MemoryFirestore(), storage: new MemoryStorage(), signIn: async () => ({ uid: "owner" }) };
}

async function head(t: TestStore, fileKey: string) {
  return (await t.store.files.headTable(fileKey)).table;
}

describe("sync stays off unless configured and turned on", () => {
  it("needs both firebase/config.json and settings.sync.enabled", async () => {
    const plain = await open(tempDir());
    expect(plain.store.sync).toBeNull();
    expect(await startSync(plain.store, { enabled: true, uid: "owner", drivers: cloud() })).toBeNull();

    const configured = await open(withConfig());
    expect(configured.store.sync).not.toBeNull();
    expect(await startSync(configured.store, { enabled: false, uid: "owner", drivers: cloud() })).toBeNull();
    expect((await configured.api.store.info()).sync).toEqual({ configured: true, enabled: false });
    const r = await startSync(configured.store, { enabled: true, idToken: "google-id-token", drivers: cloud() });
    expect(r).not.toBeNull();
    expect((await configured.api.store.info()).sync).toEqual({ configured: true, enabled: true });
    expect(configured.store.ws.workspace.ownerUid).toBe("owner");
    await r!.stop();
  });
});

describe("the Replicator (docs/data.md §12.5)", () => {
  it("pushes records and node documents with per-field clocks, and writes nothing when nothing changed", async () => {
    const a = await open(withConfig());
    const c = cloud();
    const f = await a.api.workspace.createFile({ name: "Synced", folderId: null });
    const o = await a.api.files.open(f.fileKey, { mode: "edit" });
    const s = o.sessionID;
    await a.api.files.append(f.fileKey, batch(s, 1, [rect(s, 1, "!"), rect(s, 2, '"')]));
    await a.api.files.append(f.fileKey, batch(s, 2, [{ guid: { sessionID: s, localID: 2 }, name: "Second", clearedFields: [] }]));
    const r = (await startSync(a.store, { enabled: true, uid: "owner", drivers: c, intervalMs: 60_000 }))!;
    await r.runOnce();

    const wid = a.store.ws.workspace.wid;
    const docs = c.firestore.docs;
    expect(docs.get(`workspaces/${wid}`)).toMatchObject({ wid, ownerUid: "owner" });
    expect(docs.get(`workspaces/${wid}/files/${f.fileKey}`)).toMatchObject({ name: "Synced" });
    expect(docs.get(`workspaces/${wid}/prefs/owner`)).toBeTruthy();
    expect(docs.get(`files/${f.fileKey}`)).toMatchObject({ wid, ownerUid: "owner" });
    const n2 = docs.get(`files/${f.fileKey}/nodes/${s}:2`)!;
    expect(n2).toMatchObject({ name: "Second", type: "ROUNDED_RECTANGLE", parentIndex: { guid: "0:1", position: '"' }, _dev: 1 });
    expect(Object.keys(n2._clk as object).sort()).toEqual(["name", "parentIndex", "size", "transform", "type"]);
    expect(docs.get(`files/${f.fileKey}/nodes/0:1`)).toMatchObject({ type: "CANVAS", name: "Page 1" }); // the head went up whole
    expect([...c.storage.objects.keys()].some((k) => k.startsWith("schemas/"))).toBe(true);
    expect((await a.store.files.syncState(f.fileKey))!.pushedSeq).toBe(2);

    const writes = c.firestore.writes;
    await r.runOnce();
    expect(c.firestore.writes).toBe(writes);
    await r.stop();
  });

  it("converges two devices: field-level last writer wins, deletes, images, records, and the open editor sees a remote frame", async () => {
    const c = cloud();
    const dirA = withConfig();
    const a = await open(dirA, 1);
    const folder = await a.api.workspace.createFolder({ name: "Shared", parentId: null });
    const f = await a.api.workspace.createFile({ name: "Board", folderId: folder.id });
    let oa = await a.api.files.open(f.fileKey, { mode: "edit" });
    let s = oa.sessionID;
    await a.api.files.append(f.fileKey, batch(s, 1, [rect(s, 1, "!"), rect(s, 2, '"')]));
    const ra = (await startSync(a.store, { enabled: true, uid: "owner", drivers: c, intervalMs: 60_000 }))!;
    await ra.runOnce();
    await a.api.files.close(f.fileKey, s);
    await ra.stop();
    await a.close();

    // Device B: the same workspace (as "Download a workspace" will make it), its own ordinal.
    const dirB = tempDir();
    cpSync(dirA, dirB, { recursive: true });
    const b = await open(dirB, 2);
    const a2 = await a.reopen();
    stores.push(a2);
    const rA = (await startSync(a2.store, { enabled: true, uid: "owner", drivers: c, intervalMs: 60_000 }))!;
    const rB = (await startSync(b.store, { enabled: true, uid: "owner", drivers: c, intervalMs: 60_000 }))!;

    oa = await a2.api.files.open(f.fileKey, { mode: "edit" });
    s = oa.sessionID;
    const ob = await b.api.files.open(f.fileKey, { mode: "edit" });
    const sb = ob.sessionID;
    expect(sb).toBeGreaterThanOrEqual(2 * 2 ** 20); // device 2's sessions
    const g1 = { sessionID: 1 * 2 ** 20 + 1, localID: 1 };
    const g2 = { sessionID: 1 * 2 ** 20 + 1, localID: 2 };

    // A renames node 1; B changes node 1's opacity, renames it later (B's clock is ahead), deletes node 2 and adds an image node.
    a2.clock.advance(1000);
    await a2.api.files.append(f.fileKey, batch(s, 1, [{ guid: g1, name: "From A", visible: false }]));
    b.clock.advance(5000);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]);
    const put = await b.api.blobs.put(png);
    const imageNode: NodeChange = { ...rect(sb, 1, "#"), fillPaints: [{ type: "IMAGE", image: { hash: fromHex(put.sha1) }, imageScaleMode: "FILL" }] };
    await b.api.files.append(f.fileKey, batch(sb, 1, [{ guid: g1, opacity: 0.5 }], { blobRefsAdded: [put.sha1] }));
    await b.api.files.append(f.fileKey, batch(sb, 2, [{ guid: g1, name: "From B" }, { guid: g2, phase: "REMOVED" }, imageNode], { blobRefsAdded: [put.sha1] }));
    await b.api.workspace.renameFile(f.fileKey, "Board (B)");
    await a2.api.workspace.updateFolder(folder.id, { color: "teal" });

    const remoteFrames: FileChange[] = [];
    a2.api.files.subscribe(f.fileKey, oa.headSeq + 1, (ch) => remoteFrames.push(ch));
    await rA.runOnce();
    await rB.runOnce();
    await rA.runOnce();
    await rB.runOnce();
    await settle();

    for (const t of [a2, b]) {
      const table = await head(t, f.fileKey);
      expect(table.get(g1)).toMatchObject({ name: "From B", opacity: 0.5, visible: false });
      expect(table.get(g2)).toBeUndefined();
      const img = table.get({ sessionID: sb, localID: 1 })!;
      expect(img.fillPaints![0].image!.hash).toEqual(fromHex(put.sha1));
    }
    expect(await a2.api.blobs.get(put.sha1)).toEqual(png); // the image came down before the frame that uses it
    expect(remoteFrames.map((x) => x.kind)).toContain("remote");
    const pulled = codec.decodeMessage(remoteFrames.find((x) => x.kind === "remote")!.message);
    expect(pulled.nodeChanges!.map((n) => [guidKey(n.guid!), n.phase ?? "update"])).toEqual(expect.arrayContaining([[guidKey(g2), "REMOVED"], [`${sb}:1`, "CREATED"]]));

    // Records: B's rename and A's colour both arrive on the other side (A reads remote records on its next scheduled read).
    expect((await b.api.workspace.listFolders())[0].color).toBe("teal");
    for (let i = 0; i < 15; i++) await rA.runOnce();
    expect((await a2.api.workspace.getFile(f.fileKey)).name).toBe("Board (B)");
    await rA.stop();
    await rB.stop();
  });

  it("backs off from 2 s to 5 min while Firestore fails, and reports the status", async () => {
    const t = await open(withConfig());
    const c = cloud();
    let failing = true;
    const get = c.firestore.transaction.bind(c.firestore);
    c.firestore.transaction = (fn) => (failing ? Promise.reject(new Error("unavailable")) : get(fn));
    const statuses: SyncStatus[] = [];
    const r = (await startSync(t.store, { enabled: true, uid: "owner", drivers: c })) as Replicator;
    r.status.on((st) => statuses.push(st));
    const passesAt: number[] = [];
    r.status.on((st) => st.state === "syncing" && passesAt.push(t.clock.now()));
    const t0 = t.clock.now();
    for (let i = 0; i < 4; i++) {
      await t.timers.advance(10_000);
      await settle();
    }
    expect(statuses.filter((x) => x.state === "offline").at(-1)).toMatchObject({ lastError: "unavailable" });
    expect(passesAt.map((x) => x - t0).slice(0, 4)).toEqual([0, 2000, 6000, 14000]);
    failing = false;
    await t.timers.advance(40_000); // the 6th pass is due 32 s after the 5th

    await settle();
    expect(statuses.at(-1)).toMatchObject({ state: "idle", lastError: null });
    await r.stop();
  });
});
