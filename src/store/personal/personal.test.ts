/**
 * Personal Drafts in the cloud (docs/cloud.md §2): the desktop store against the real server (server/src/api.ts on
 * node:sqlite) — the 1.1 migration of local files (folder prefixes, the trash, idempotent across restarts and lost
 * answers), new files registered first (offline: pending, then registered), drafts from elsewhere as records that
 * download when opened, writes on the server first, the cache's LRU bound, accounts kept apart, moves into an org.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeMessage, newDocumentMessage } from "../../shared/schema/codec";
import type { UploadEvent, UploadProgress } from "../../shared/multiplayer/uploads";
import { StoreError } from "../../shared/store/protocol";
import type { FileMeta } from "../../shared/store/types";
import { RealOrgServer } from "../org/fake/real";
import { openTestStore, type TestStore } from "../testing/harness";

const SERVER = "https://org.test";
const SAMPLE = join(__dirname, "../../../docs/research/figma/samples/structure.fig");

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

const stores: TestStore[] = [];
afterEach(async () => {
  for (const t of stores.splice(0)) {
    await t.close().catch(() => {});
    t.dispose();
  }
  vi.unstubAllGlobals();
});

async function world() {
  vi.stubGlobal("WebSocket", NoSocket);
  const srv = new RealOrgServer();
  const alice = await srv.addUser("alice@example.com");
  const bob = await srv.addUser("bob@example.com");
  const t = await openTestStore({ fetch: srv.fetch, ...(process.env.DBG ? { log: (l: string, m: string, d?: unknown) => console.log(l, m, d instanceof Error ? d.message : d) } : {}) });
  stores.push(t);
  const signIn = async (who: { token: string }, store = t) => {
    await store.api.multiplayer.setSession({ server: SERVER, token: who.token });
    await store.store.personal.idle();
  };
  const serverDrafts = async (who: { token: string }, trashed = false) => (await srv.call("GET", `/me/drafts${trashed ? "?trashed=1" : ""}`, who.token)).body.files as { key: string; name: string; trashedAt: number | null }[];
  const drafts = async (store = t) => (await store.api.workspace.listFiles({ in: "drafts" })).map((f) => f.name).sort();
  return { srv, alice, bob, t, signIn, serverDrafts, drafts };
}

describe("the 1.1 migration of local files", () => {
  it("uploads every local file into the person's Drafts: folders become name prefixes, the trash the server's trash, nothing deleted", async () => {
    const { srv, alice, t, signIn, serverDrafts, drafts } = await world();
    // Before 1.1: local files in Drafts, in nested folders and in the trash
    const koc = await t.api.workspace.createFolder({ name: "KOC", parentId: null });
    const brand = await t.api.workspace.createFolder({ name: "Brand", parentId: koc.id });
    const logo = await t.api.workspace.createFile({ name: "Logo", folderId: koc.id });
    const icon = await t.api.workspace.createFile({ name: "Icon", folderId: brand.id });
    const poster = await t.api.workspace.createFile({ name: "Poster", folderId: null });
    const old = await t.api.workspace.createFile({ name: "Old", folderId: null });
    await t.api.workspace.trash({ files: [old.fileKey] });
    expect(logo.cloud ?? null).toBeNull();
    const uploads: UploadProgress[] = [];
    t.api.multiplayer.watchUploads((e: UploadEvent) => void ("upload" in e && uploads.push(e.upload)));

    await signIn(alice);
    expect((await serverDrafts(alice)).map((f) => f.name).sort()).toEqual(["KOC / Brand / Icon", "KOC / Logo", "Poster"]);
    expect((await serverDrafts(alice, true)).map((f) => f.name)).toEqual(["Old"]);
    // Every one with its document in its room
    for (const f of [...(await serverDrafts(alice)), ...(await serverDrafts(alice, true))]) expect(srv.snapshots.get(f.key)?.bytes.length).toBeGreaterThan(50);
    // The records are the drafts now, in the same files (nothing deleted); Drafts are flat
    for (const k of [logo.fileKey, icon.fileKey, poster.fileKey, old.fileKey]) {
      const m = await t.api.workspace.getFile(k);
      expect(m.cloud).toEqual({ uid: alice.user.id, key: expect.any(String) });
      expect(m.folderId).toBeNull();
    }
    expect(await drafts()).toEqual(["KOC / Brand / Icon", "KOC / Logo", "Poster"]);
    expect((await t.api.workspace.listFiles({ in: "trash" })).map((f) => f.name)).toEqual(["Old"]);
    // The upload panel showed them, destination "Drafts"
    expect(uploads.filter((u) => u.state === "done").map((u) => u.destination)).toEqual(["Drafts", "Drafts", "Drafts", "Drafts"]);
    expect(await t.api.cloud.status()).toMatchObject({ uid: alice.user.id, online: true, migration: null });
  });

  it("is idempotent: offline it waits, a restart finishes it, a lost answer registers no second draft", async () => {
    const { srv, alice, t, signIn, serverDrafts } = await world();
    const a = await t.api.workspace.createFile({ name: "A", folderId: null });
    const b = await t.api.workspace.createFile({ name: "B", folderId: null });
    srv.online = false;
    await signIn(alice);
    // Marked, not uploaded: still here, listed, pending
    const ma = await t.api.workspace.getFile(a.fileKey);
    expect(ma.cloud).toMatchObject({ uid: alice.user.id, pendingCreate: true });
    expect((await t.api.workspace.listFiles({ in: "drafts" })).map((f) => f.name).sort()).toEqual(["A", "B"]);
    expect((await t.api.cloud.status()).online).toBe(false);
    // A's registration landed on the server but its answer was lost (the reserved key went)
    srv.online = true;
    expect((await srv.call("POST", "/me/drafts", alice.token, { key: ma.cloud!.key, name: "A" })).status).toBe(201);
    // Restart: the next start finishes the migration, the same key answering the same draft
    await t.close();
    const t2 = await t.reopen();
    stores.push(t2);
    await signIn(alice, t2);
    const listed = await serverDrafts(alice);
    expect(listed.map((f) => f.name).sort()).toEqual(["A", "B"]);
    expect(listed.find((f) => f.name === "A")!.key).toBe(ma.cloud!.key);
    expect((await t2.api.workspace.getFile(b.fileKey)).cloud).toEqual({ uid: alice.user.id, key: expect.any(String) });
    // Again: nothing more
    await t2.api.multiplayer.setSession(null);
    await signIn(alice, t2);
    expect((await serverDrafts(alice)).length).toBe(2);
    expect((await t2.api.workspace.listFiles({ in: "drafts" })).length).toBe(2);
  });
});

describe("new files", () => {
  it("are drafts on the server first; offline, created here and registered once the server is reached", async () => {
    const { srv, alice, t, signIn, serverDrafts } = await world();
    await signIn(alice);
    const online = await t.api.workspace.createFile({ name: "Wireframes", folderId: null });
    await t.store.personal.idle();
    expect((await serverDrafts(alice)).map((f) => f.name)).toEqual(["Wireframes"]);
    expect((await t.api.workspace.getFile(online.fileKey)).cloud).toEqual({ uid: alice.user.id, key: (await serverDrafts(alice))[0].key });

    srv.online = false;
    const offline = await t.api.workspace.createFile({ name: "On the plane", folderId: null });
    await t.store.personal.idle();
    expect((await t.api.workspace.getFile(offline.fileKey)).cloud).toMatchObject({ pendingCreate: true });
    expect((await t.api.workspace.listFiles({ in: "drafts" })).map((f) => f.name).sort()).toEqual(["On the plane", "Wireframes"]);
    srv.online = true;
    await t.api.cloud.refresh();
    await t.store.personal.idle();
    expect((await serverDrafts(alice)).map((f) => f.name).sort()).toEqual(["On the plane", "Wireframes"]);
    expect((await t.api.workspace.getFile(offline.fileKey)).cloud?.pendingCreate).toBeUndefined();
  });

  it("a Social file keeps its kind through the server (docs/social.md §27): registered as one, another computer's record is one, Convert this file tells the server", async () => {
    const { srv, alice, t, signIn, serverDrafts } = await world();
    await signIn(alice);
    const social = await t.api.workspace.createFile({ name: "Posts", folderId: null, editorType: "buzz" });
    const design = await t.api.workspace.createFile({ name: "Logo", folderId: null });
    await t.store.personal.idle();
    const kinds = async () => Object.fromEntries(((await srv.call("GET", "/me/drafts", alice.token)).body.files as { name: string; editorType: string }[]).map((f) => [f.name, f.editorType]));
    expect(await kinds()).toEqual({ Posts: "buzz", Logo: "design" });
    // Converted here: the server first
    await t.api.workspace.setEditorType(design.fileKey, "buzz");
    expect(await kinds()).toEqual({ Posts: "buzz", Logo: "buzz" });
    // Another computer: the records come as Social files
    const other = await openTestStore({ fetch: srv.fetch });
    stores.push(other);
    await signIn(alice, other);
    const there = await other.api.workspace.listFiles({ in: "drafts" });
    expect(Object.fromEntries(there.map((f) => [f.name, f.editorType]))).toEqual({ Posts: "buzz", Logo: "buzz" });
    expect((await serverDrafts(alice)).length).toBe(2);
    void social;
  });

  it("an imported .fig is a draft registered on the server", async () => {
    const { srv, alice, t, signIn, serverDrafts } = await world();
    await signIn(alice);
    const meta = await t.api.files.importFigBytes(new Uint8Array(readFileSync(SAMPLE)), "structure.fig", null);
    await t.store.personal.idle();
    const [d] = await serverDrafts(alice);
    expect(d.name).toBe(meta.name);
    expect(srv.snapshots.get(d.key)!.bytes.length).toBeGreaterThan(1000);
    expect((await t.api.workspace.getFile(meta.fileKey)).cloud).toEqual({ uid: alice.user.id, key: d.key });
  });
});

describe("drafts from elsewhere, writes, the cache", () => {
  /** A draft made on another computer: its row and its document in its room */
  const elsewhere = async (srv: RealOrgServer, token: string, key: string, name: string) => {
    expect((await srv.call("POST", "/me/drafts", token, { key, name })).status).toBe(201);
    srv.snapshots.set(key, { seq: 0, bytes: encodeMessage(newDocumentMessage()) });
  };

  it("lists them as records that download when opened; offline only the cached ones open", async () => {
    const { srv, alice, t, signIn } = await world();
    await elsewhere(srv, alice.token, "remoteDraft01", "From the laptop");
    await elsewhere(srv, alice.token, "remoteDraft02", "Never opened");
    await signIn(alice);
    const items = await t.api.workspace.listFiles({ in: "drafts" });
    expect(items.map((f) => [f.name, f.cloud?.remote ?? false]).sort()).toEqual([
      ["From the laptop", true],
      ["Never opened", true],
    ]);
    const laptop = items.find((f) => f.name === "From the laptop")!;
    const opened = await t.api.files.open(laptop.fileKey, { mode: "edit" });
    expect(opened.meta.fileKey).toBe(laptop.fileKey);
    await t.api.files.close(laptop.fileKey, opened.sessionID);
    expect((await t.api.workspace.getFile(laptop.fileKey)).cloud).toEqual({ uid: alice.user.id, key: "remoteDraft01" });
    // Offline: the cached one opens, the other can't
    srv.online = false;
    const again = await t.api.files.open(laptop.fileKey, { mode: "edit" });
    await t.api.files.close(laptop.fileKey, again.sessionID);
    const never = items.find((f) => f.name === "Never opened")!;
    const err = await t.api.files.open(never.fileKey, { mode: "edit" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe("offline");
    expect((err as StoreError).message).toContain("isn't available offline");
  });

  it("rename, trash, restore and delete forever reach the server first; offline they're refused; deleted elsewhere goes here", async () => {
    const { srv, alice, t, signIn, serverDrafts } = await world();
    await signIn(alice);
    const f = await t.api.workspace.createFile({ name: "Poster", folderId: null });
    const g = await t.api.workspace.createFile({ name: "Flyer", folderId: null });
    await t.store.personal.idle();
    await t.api.workspace.renameFile(f.fileKey, "Poster v2");
    expect((await serverDrafts(alice)).map((d) => d.name).sort()).toEqual(["Flyer", "Poster v2"]);
    await t.api.workspace.trash({ files: [f.fileKey] });
    expect((await serverDrafts(alice, true)).map((d) => d.name)).toEqual(["Poster v2"]);
    await t.api.workspace.restore({ files: [f.fileKey] });
    expect((await serverDrafts(alice, true)).length).toBe(0);
    srv.online = false;
    expect(((await t.api.workspace.trash({ files: [f.fileKey] }).catch((e: unknown) => e)) as StoreError).code).toBe("offline");
    expect((await t.api.workspace.getFile(f.fileKey)).trashedAt).toBeNull();
    expect(((await t.api.workspace.renameFile(f.fileKey, "Nope").catch((e: unknown) => e)) as StoreError).code).toBe("offline");
    expect((await t.api.workspace.getFile(f.fileKey)).name).toBe("Poster v2");
    srv.online = true;
    await t.api.workspace.trash({ files: [f.fileKey] });
    await t.api.workspace.deleteForever({ files: [f.fileKey] });
    expect(await srv.file((await serverDrafts(alice))[0].key)).not.toBeNull();
    expect((await serverDrafts(alice)).map((d) => d.name)).toEqual(["Flyer"]);
    // Flyer deleted on another computer: the next refresh drops it here
    const flyer = (await serverDrafts(alice))[0].key;
    expect((await srv.call("DELETE", `/files/${flyer}`, alice.token)).status).toBe(200);
    // Renamed elsewhere: the name follows
    await elsewhere(srv, alice.token, "remoteDraft03", "Brief");
    await t.api.cloud.refresh();
    expect((await t.api.workspace.listFiles({ in: "drafts" })).map((d) => d.name)).toEqual(["Brief"]);
    await srv.call("PATCH", "/files/remoteDraft03", alice.token, { name: "Brief v2" });
    await t.api.cloud.refresh();
    expect((await t.api.workspace.listFiles({ in: "drafts" })).map((d) => d.name)).toEqual(["Brief v2"]);
    expect(await t.api.workspace.getFile(g.fileKey).catch((e: StoreError) => e.code)).toBe("not-found");
  });

  it("keeps the cache under its bound, least recently opened first, never an open file; Clear cache empties it", async () => {
    const { srv, alice, t, signIn } = await world();
    await signIn(alice);
    const files: FileMeta[] = [];
    for (const name of ["One", "Two", "Three"]) {
      files.push(await t.api.workspace.createFile({ name, folderId: null }));
      await t.store.personal.idle();
    }
    // Two edited here once (its session counter must outlive its eviction)
    const first = await t.api.files.open(files[1].fileKey, { mode: "edit" });
    await t.api.files.close(files[1].fileKey, first.sessionID);
    // Opened in the order Two, One, Three (Three most recently)
    for (const i of [1, 0, 2]) {
      t.clock.t += 1000;
      await t.api.workspace.recordViewed(files[i].fileKey);
    }
    const info = await t.api.cloud.cacheInfo();
    expect(info).toMatchObject({ files: 3, pinned: 0 });
    const each = info.usedBytes / 3;
    // Room for two: Two (least recently opened) goes
    writeFileSync(join(t.dir, "Workspace", "cloud.json"), JSON.stringify({ v: 1, limitBytes: Math.floor(each * 2.5) }));
    await t.close();
    const t2 = await t.reopen();
    stores.push(t2);
    await signIn(alice, t2);
    await t2.store.personal.evict(false);
    const state = async (k: string) => (await t2.api.workspace.getFile(k)).cloud?.remote ?? false;
    expect([await state(files[0].fileKey), await state(files[1].fileKey), await state(files[2].fileKey)]).toEqual([false, true, false]);
    // Still listed, with its record; it downloads again when opened
    expect((await t2.api.workspace.listFiles({ in: "drafts" })).length).toBe(3);
    // An open file stays; Clear cache takes the rest
    const open = await t2.api.files.open(files[2].fileKey, { mode: "edit" });
    const cleared = await t2.api.cloud.clearCache();
    expect(cleared).toMatchObject({ files: 1, pinned: 1 });
    expect(await state(files[0].fileKey)).toBe(true);
    expect(await state(files[2].fileKey)).toBe(false);
    await t2.api.files.close(files[2].fileKey, open.sessionID);
    const back = await t2.api.files.open(files[1].fileKey, { mode: "edit" });
    expect(await state(files[1].fileKey)).toBe(false);
    // Downloaded again: a new session of this device, never the one used before
    expect(back.sessionID).toBeGreaterThan(first.sessionID);
    await t2.api.files.close(files[1].fileKey, back.sessionID);
    expect(srv.log.filter((l) => l.startsWith("GET /files/") && l.endsWith("/snapshot")).length).toBeGreaterThan(0);
    // The bound from Settings: at least 256 MB
    expect(((await t2.api.cloud.setCacheLimit(1024).catch((e: unknown) => e)) as StoreError).code).toBe("invalid");
    expect((await t2.api.cloud.setCacheLimit(2 * 1024 ** 3)).limitBytes).toBe(2 * 1024 ** 3);
  });
});

describe("accounts and orgs", () => {
  it("each account sees its own Drafts on the same computer", async () => {
    const { alice, bob, t, signIn, drafts } = await world();
    await signIn(alice);
    await t.api.workspace.createFile({ name: "Alice's", folderId: null });
    await t.store.personal.idle();
    await signIn(bob);
    await t.api.workspace.createFile({ name: "Bob's", folderId: null });
    await t.store.personal.idle();
    expect(await drafts()).toEqual(["Bob's"]);
    expect((await t.api.workspace.listFiles({ in: "recents" })).length).toBe(0);
    await signIn(alice);
    expect(await drafts()).toEqual(["Alice's"]);
    // Alice's link stays hers: never started with Bob's session
    expect(t.store.multiplayer.userId).toBe(alice.user.id);
  });

  it("a draft moved into an org folder leaves Drafts and becomes the org file's copy", async () => {
    const { srv, alice, t, signIn, serverDrafts } = await world();
    await signIn(alice);
    const org = await t.api.orgs.create({ name: "Anex Tour" });
    const team = await t.api.teams.create(org.id, { name: "Design" });
    const folder = await t.api.projects.create(team.id, { name: "KOC" });
    const f = await t.api.workspace.createFile({ name: "Logo", folderId: null });
    await t.store.personal.idle();
    const key = (await t.api.workspace.getFile(f.fileKey)).cloud!.key!;
    const moved = await t.api.projects.moveLocalFile(f.fileKey, folder.id, { snapshot: new Uint8Array(), headSeq: 0 });
    expect(moved.key).toBe(key);
    expect(await srv.file(key)).toMatchObject({ orgId: org.id, projectId: folder.id });
    expect(await serverDrafts(alice)).toEqual([]);
    const m = await t.api.workspace.getFile(f.fileKey);
    expect(m.space).toMatchObject({ orgId: org.id, key, projectId: folder.id });
    expect(m.cloud ?? null).toBeNull();
    expect((await t.api.workspace.listFiles({ in: "drafts" })).length).toBe(0);
  });
});
