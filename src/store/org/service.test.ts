/**
 * The store's org spaces (docs/multiplayer.md §14.6) against the contract fake of §14.12 (fake/server.ts — swap in the
 * real handler, server/src/api.ts `handle`, once round 1a lands): the repositories' calls and shapes, the per-org cache
 * answering offline, another account's cache kept apart, org files as linked copies (created in a folder or drafts,
 * a local file moved in, opened by a member), Inbox notices, the server's error codes, the Admin calls; then the same
 * through LocalStore on disk (Workspace/spaces/<orgId>.json) and over the port.
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { MessageChannel } from "node:worker_threads";
import { StoreClient } from "../../shared/store/client";
import { portTransport } from "../../shared/store/protocol";
import { StoreServer } from "../server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgEvent } from "../../shared/org/repositories";
import { encodeMessage, newDocumentMessage } from "../../shared/schema/codec";
import { StoreError } from "../../shared/store/protocol";
import type { FileChange } from "../../shared/store/repositories";
import type { FileKey, FileMeta, FileSpace, Prefs, Workspace } from "../../shared/store/types";
import { defaultPrefs, newMeta, WorkspaceModel } from "../../shared/store/workspaceModel";
import { MultiplayerService, type MultiplayerHost } from "../multiplayer/service";
import { NotificationsService, type OrgNotice } from "../notifications/service";
import { openTestStore, settle, type TestStore } from "../testing/harness";
import { RealOrgServer } from "./fake/real";
import { OrgService, type OrgCache, type OrgHost } from "./service";

const SERVER = "https://org.test";

/** A socket that never connects (the rooms aren't under test here) */
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

/** An installation's records (the real WorkspaceModel, kept in memory) and caches, as a store keeps them */
class Host implements MultiplayerHost, OrgHost {
  deviceOrdinal = 1;
  readonly ws: WorkspaceModel;
  data = new Map<FileKey, Uint8Array>();
  caches = new Map<string, OrgCache>();
  saved: { installationId?: string; links: Record<string, unknown> } = { links: {} };
  private listeners = new Set<(c: FileChange) => void>();
  readonly fileChanges = { on: (l: (c: FileChange) => void) => (this.listeners.add(l), () => this.listeners.delete(l)) };
  private n = 0;
  t = Date.UTC(2026, 9, 11);

  constructor() {
    const workspace: Workspace = { wid: "w", formatVersion: 1, teamName: "Team", createdAt: 0, defaultLibraries: [], ownerUid: null, _clk: {} };
    const prefs: Prefs = defaultPrefs();
    let h = 0;
    this.ws = new WorkspaceModel(workspace, prefs, { hlc: { now: () => String(++h).padStart(9, "0") }, clock: { now: () => this.t }, persist: { workspace: async () => {}, prefs: async () => {}, folder: async () => {}, removeFolder: async () => {}, meta: async () => {} } });
  }
  async addLocal(name: string, space: FileSpace | null = null): Promise<FileMeta> {
    const meta = newMeta(`file${++this.n}xxxxxxxxxxxxxxxx`.slice(0, 22), name, null, this.t);
    if (space) meta.space = space;
    this.data.set(meta.fileKey, encodeMessage(newDocumentMessage()));
    return this.ws.queue.run(() => this.ws.addFile(meta));
  }
  // MultiplayerHost
  async backlog() {
    return [];
  }
  async appendRemote() {
    return { seq: 1 };
  }
  async createSharedFile(input: { name: string; snapshot: Uint8Array; space?: FileSpace | null }) {
    const m = await this.addLocal(input.name, input.space ?? null);
    this.data.set(m.fileKey, input.snapshot);
    return m;
  }
  getMeta(fileKey: FileKey) {
    return this.ws.files.get(fileKey) ?? null;
  }
  async setDeviceOrdinal(o: number) {
    this.deviceOrdinal = o;
  }
  async load() {
    return structuredClone(this.saved);
  }
  async saveInstallationId(id: string) {
    this.saved.installationId = id;
  }
  async saveLink(fileKey: FileKey, link: unknown) {
    if (link) this.saved.links[fileKey] = structuredClone(link);
    else delete this.saved.links[fileKey];
  }
  log() {}
  async hasBlobs(s: string[]) {
    return s.map(() => true);
  }
  async getBlob(): Promise<Uint8Array> {
    throw new Error("no blobs");
  }
  async putBlob() {}
  async headSnapshot(fileKey: FileKey) {
    return this.data.get(fileKey)!;
  }
  // OrgHost
  async loadCache(orgId: string) {
    return structuredClone(this.caches.get(orgId) ?? null);
  }
  async saveCache(orgId: string, cache: OrgCache | null) {
    if (cache) this.caches.set(orgId, structuredClone(cache));
    else this.caches.delete(orgId);
  }
  async cachedOrgIds() {
    return [...this.caches.keys()];
  }
  createOrgFile(input: { name: string; space: FileSpace }) {
    return this.addLocal(input.name, input.space);
  }
  async deleteLocalFile(fileKey: FileKey) {
    this.data.delete(fileKey);
    await this.ws.queue.run(() => this.ws.forgetFile(fileKey));
  }
  async setFileSpace(fileKey: FileKey, space: FileSpace | null) {
    await this.ws.queue.run(() => this.ws.setFileSpace(fileKey, space));
  }
  now() {
    return this.t;
  }
}

class Notices {
  private ls = new Set<(n: OrgNotice) => void>();
  onOrg(l: (n: OrgNotice) => void) {
    this.ls.add(l);
    return () => this.ls.delete(l);
  }
  send(n: Omit<OrgNotice, "t">) {
    for (const l of this.ls) l({ t: "org", ...n });
  }
}

const running: { mp: MultiplayerService; org: OrgService }[] = [];
afterEach(() => {
  for (const r of running.splice(0)) {
    r.org.close();
    r.mp.close();
  }
});

async function installation(srv: RealOrgServer, token: string | null, host = new Host()) {
  const mp = new MultiplayerService(host, { fetch: srv.fetch, WebSocket: NoSocket as never, random: Math.random });
  const notices = new Notices();
  const org = new OrgService(mp, host, notices);
  const events: OrgEvent[] = [];
  org.onEvent((e) => events.push(e));
  running.push({ mp, org });
  if (token) await mp.setSession({ server: SERVER, token });
  return { host, mp, org, notices, events };
}

/** An org with a team, a folder and a file in it, made by its first admin */
async function acme() {
  const srv = new RealOrgServer();
  const alice = await srv.addUser("alice@example.com", "Alice");
  const a = await installation(srv, alice.token);
  const org = await a.org.orgs.create({ name: "Acme" });
  const team = await a.org.teams.create(org.id, { name: "Design" });
  const folder = await a.org.projects.create(team.id, { name: "Web" });
  return { srv, alice, a, org, team, folder };
}

/** The refusal a call ends with (a call that resolves fails the test) */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e: unknown) => e as StoreError,
  );

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e: unknown) => (e instanceof StoreError ? e.code : String(e)),
  );

describe("org spaces", () => {
  it("lists what the server has, in §14.12's shapes, and caches it per org", async () => {
    const { a, org, team, folder } = await acme();
    expect(org).toMatchObject({ name: "Acme", role: "admin", seat: "full", settings: { defaultSeat: "view" } });
    expect(await a.org.orgs.list()).toEqual([{ id: org.id, name: "Acme", iconUrl: null, role: "admin", seat: "full", workspaceId: null }]);
    expect((await a.org.teams.list(org.id)).map((t) => t.name)).toEqual(["Design"]);
    expect((await a.org.projects.list(team.id)).map((p) => [p.name, p.teamId, p.parentId])).toEqual([["Web", team.id, null]]);
    const sub = await a.org.projects.create(team.id, { name: "Icons", parentId: folder.id });
    expect(sub.path.map((x) => x.name)).toEqual(["Web", "Icons"]);
    expect((await a.org.projects.list(team.id, folder.id)).map((p) => p.name)).toEqual(["Icons"]);
    // Writes drop what they change (folder counts included); Home reads again after each
    await a.org.teams.list(org.id);
    await a.org.projects.list(team.id);
    await a.org.idle();
    const cache = a.host.caches.get(org.id)!;
    expect(cache.uid).toBe(a.mp.userId);
    expect(cache.summary?.name).toBe("Acme");
    expect(cache.teams.mine?.map((t) => t.name)).toEqual(["Design"]);
    expect(Object.keys(cache.projects).sort()).toEqual([`${team.id}/`, `${team.id}/${folder.id}`].sort());
    // A write announces itself
    expect(a.events).toContainEqual({ type: "projects.changed", teamId: team.id, parentId: folder.id });
  });

  it("creates a file in a folder as a linked local copy, out of the local Drafts; Recents show it", async () => {
    const { srv, a, org, team, folder } = await acme();
    const { fileKey, file } = await a.org.projects.createFile(folder.id, { name: "Home page" });
    expect(file).toMatchObject({ name: "Home page", orgId: org.id, teamId: team.id, projectId: folder.id, fileKey, editorType: "design" });
    expect(a.host.getMeta(fileKey)?.space).toEqual({ orgId: org.id, key: file.key, teamId: team.id, projectId: folder.id });
    expect(await a.mp.roomKey(fileKey)).toBe(file.key);
    expect((await srv.file(file.key))?.snapshot?.seq).toBe(0);
    expect(srv.log).toContain(`POST /projects/${folder.id}/files`);
    expect((await a.org.projects.files(folder.id)).map((f) => [f.key, f.fileKey])).toEqual([[file.key, fileKey]]);
    // The local space's lists leave it out; Recents and Starred show both spaces
    const local = await a.host.addLocal("Local sketch");
    expect(a.host.ws.listFiles({ in: "drafts" }).map((f) => f.fileKey)).toEqual([local.fileKey]);
    expect(a.host.ws.listFiles({ in: "search", text: "home" })).toEqual([]);
    await a.host.ws.recordViewed(fileKey);
    await a.host.ws.setStarred({ fileKey }, true);
    expect(a.host.ws.listFiles({ in: "recents" }).map((f) => f.space?.teamId)).toEqual([team.id]);
    expect(a.host.ws.listFiles({ in: "starred" }).map((f) => f.fileKey)).toEqual([fileKey]);
    await expect(a.host.ws.moveFiles([fileKey], null)).rejects.toMatchObject({ code: "invalid" });
    // Drafts in the org
    const draft = await a.org.orgs.createDraft(org.id, { name: "Scratch" });
    expect(draft.file).toMatchObject({ teamId: null, projectId: null, fileKey: draft.fileKey });
    expect(a.host.getMeta(draft.fileKey)?.space).toEqual({ orgId: org.id, key: draft.file.key, teamId: null, projectId: null });
    expect((await a.org.orgs.drafts(org.id)).map((f) => f.name)).toEqual(["Scratch"]);
  });

  it("moves a local file into a folder (share with a destination): it leaves the local Drafts", async () => {
    const { srv, a, org, team, folder } = await acme();
    const local = await a.host.addLocal("Brand");
    const moved = await a.org.projects.moveLocalFile(local.fileKey, folder.id, { snapshot: await a.host.headSnapshot(local.fileKey), headSeq: 0 });
    expect(moved).toMatchObject({ name: "Brand", orgId: org.id, teamId: team.id, projectId: folder.id, fileKey: local.fileKey });
    expect(a.host.getMeta(local.fileKey)?.space).toEqual({ orgId: org.id, key: moved.key, teamId: team.id, projectId: folder.id });
    expect(await srv.file(moved.key)).toMatchObject({ orgId: org.id, projectId: folder.id });
    expect(a.host.ws.listFiles({ in: "drafts" })).toEqual([]);
    expect(a.events).toContainEqual({ type: "files.changed", orgId: org.id, projectId: folder.id });
    await expect(a.org.projects.moveLocalFile(local.fileKey, folder.id, { snapshot: new Uint8Array(), headSeq: 0 })).rejects.toMatchObject({ code: "invalid" });
    // Within the org: into another folder, then the mover's drafts; the copy follows
    const other = await a.org.projects.create(team.id, { name: "App" });
    await a.org.projects.moveFiles([moved.key], { projectId: other.id });
    expect(a.host.getMeta(local.fileKey)?.space).toMatchObject({ teamId: team.id, projectId: other.id });
    await a.org.projects.moveFiles([moved.key], { projectId: null });
    expect(a.host.getMeta(local.fileKey)?.space).toMatchObject({ teamId: null, projectId: null });
    expect((await a.org.orgs.drafts(org.id)).map((f) => f.key)).toEqual([moved.key]);
    await a.org.projects.trashFiles([moved.key]);
    expect(await a.org.orgs.drafts(org.id)).toEqual([]);
    await a.org.projects.restoreFiles([moved.key]);
    expect((await a.org.orgs.drafts(org.id)).map((f) => f.key)).toEqual([moved.key]);
  });

  it("a move whose snapshot upload fails part-way: the copy is in the folder, members hear it's still uploading, the next start finishes it", async () => {
    const { srv, alice, a, folder } = await acme();
    const local = await a.host.addLocal("B2C Project");
    // Cloudflare's 1102 page for the snapshot, as on 2026-10-12 (this installation's own fetch; the server is fine)
    let failing = true;
    const flaky: typeof fetch = async (input, init) =>
      failing && init?.method === "PUT" && /\/snapshot\?seq=/.test(String(input)) ? new Response("<!DOCTYPE html><html><body>Error 1102</body></html>", { status: 503, headers: { "content-type": "text/html" } }) : srv.fetch(input, init);
    const host = a.host;
    a.mp.close();
    const mp = new MultiplayerService(host, { fetch: flaky, WebSocket: NoSocket as never, random: Math.random, backoff: () => 60_000, uploadRetryDelays: [0, 0] });
    const org = new OrgService(mp, host, new Notices());
    running.push({ mp, org });
    await mp.setSession({ server: SERVER, token: alice.token });
    const err = await refusal(org.projects.moveLocalFile(local.fileKey, folder.id, { snapshot: await host.headSnapshot(local.fileKey), headSeq: 0 }));
    expect(err).toBeInstanceOf(StoreError);
    expect(err.message).not.toMatch(/DOCTYPE|<html/i);
    expect(err.detail).toMatchObject({ code: "upload_incomplete", pendingUpload: true });
    const key = (await mp.roomKey(local.fileKey))!;
    expect(host.getMeta(local.fileKey)?.space).toMatchObject({ key, projectId: folder.id });
    expect((await srv.file(key))?.snapshot).toBeNull();

    // Another person opening it meanwhile: the room's 404 `no_snapshot` reads as "still uploading", nothing linked
    const bob = await srv.addUser("bob@example.com", "Bob");
    await srv.call("PUT", `/files/${key}/members`, alice.token, { email: "bob@example.com", role: "editor" });
    const b = await installation(srv, bob.token);
    const opening = await refusal(b.mp.openShared(key));
    expect(opening).toMatchObject({ code: "unavailable", message: "This file is still uploading. Try again in a moment." });
    expect(opening.detail).toMatchObject({ code: "no_snapshot" });
    expect(await b.mp.linkedCopies()).toEqual(new Map());

    // The next start, the server well again: the snapshot goes, the link forgets it was pending
    mp.close();
    failing = false;
    const mp2 = new MultiplayerService(host, { fetch: flaky, WebSocket: NoSocket as never, random: Math.random });
    running.push({ mp: mp2, org: new OrgService(mp2, host, new Notices()) });
    await mp2.setSession({ server: SERVER, token: alice.token });
    for (let i = 0; i < 50 && !(await srv.file(key))?.snapshot; i++) await new Promise((r) => setTimeout(r, 5));
    expect((await srv.file(key))?.snapshot).not.toBeNull();
    expect((await b.mp.openShared(key)).fileKey).toBeTruthy();
  });

  it("a member opens an org file: the copy knows its place from GET /files/:key", async () => {
    const { srv, a, org, team, folder } = await acme();
    const { file } = await a.org.projects.createFile(folder.id, { name: "Spec" });
    const bobUser = await srv.addUser("bob@example.com", "Bob");
    await a.org.teams.invite(team.id, { email: "bob@example.com", role: "editor" });
    await srv.acceptInvites(bobUser.token);
    const b = await installation(srv, bobUser.token);
    expect((await b.org.orgs.list()).map((o) => [o.name, o.role, o.seat])).toEqual([["Acme", "member", "view"]]);
    expect((await b.org.teams.list(org.id)).map((t) => t.name)).toEqual(["Design"]);
    expect((await b.org.projects.files(folder.id)).map((f) => f.fileKey)).toEqual([null]);
    const { fileKey } = await b.mp.openShared(file.key);
    expect(b.host.getMeta(fileKey)?.space).toEqual({ orgId: org.id, key: file.key, teamId: team.id, projectId: folder.id });
    expect(b.host.ws.listFiles({ in: "drafts" })).toEqual([]);
    expect((await b.org.projects.files(folder.id)).map((f) => f.fileKey)).toEqual([fileKey]);
    // The file moves on the server (into another folder: an owner's draft would be out of Bob's reach, §14.4): the next listing puts the copy where it is now
    const other = await a.org.projects.create(team.id, { name: "Archive" });
    await srv.exec(`UPDATE files SET project_id = ?2 WHERE key = ?1`, file.key, other.id);
    b.host.t += 10_000;
    await b.org.orgs.search(org.id, "spec");
    expect(b.host.getMeta(fileKey)?.space).toMatchObject({ teamId: team.id, projectId: other.id });
  });

  it("the sharer takes one team member off one file and gives them back: the team's other files stay theirs", async () => {
    const { srv, a, org, team, folder } = await acme();
    const { fileKey, file } = await a.org.projects.createFile(folder.id, { name: "Spec" });
    const { file: other } = await a.org.projects.createFile(folder.id, { name: "Other" });
    const bobUser = await srv.addUser("bob@example.com", "Bob");
    await a.org.teams.invite(team.id, { email: "bob@example.com", role: "editor" });
    await srv.acceptInvites(bobUser.token);
    const b = await installation(srv, bobUser.token);
    const keys = async () => (await b.org.projects.files(folder.id)).map((f) => f.key).sort();
    expect(await keys()).toEqual([file.key, other.key].sort());
    const people = await a.mp.exclusions(fileKey);
    expect(people.find((p) => p.email === "bob@example.com")).toMatchObject({ userId: bobUser.user.id, excluded: false, owner: false });
    expect(people.find((p) => p.email === "alice@example.com")).toMatchObject({ owner: true });

    expect((await a.mp.exclude(fileKey, bobUser.user.id)).find((p) => p.userId === bobUser.user.id)?.excluded).toBe(true);
    b.host.t += 10_000;
    expect(await keys()).toEqual([other.key]);
    expect((await b.org.orgs.files(org.id)).map((f) => f.key)).toEqual([other.key]);
    expect(await codeOf(b.mp.openShared(file.key))).not.toBe("resolved");
    expect(await codeOf(a.mp.exclude(fileKey, a.mp.userId!))).toBe("invalid");

    expect((await a.mp.include(fileKey, bobUser.user.id)).find((p) => p.userId === bobUser.user.id)?.excluded).toBe(false);
    b.host.t += 10_000;
    expect(await keys()).toEqual([file.key, other.key].sort());
  });

  it("answers from the cache offline (cache.stale), refuses writes, and leaves no copy of a file it couldn't create", async () => {
    const { srv, alice, a, org, team, folder } = await acme();
    await a.org.projects.createFile(folder.id, { name: "Spec" });
    await a.org.projects.files(folder.id);
    await a.org.orgs.get(org.id);
    await a.org.teams.list(org.id);
    await a.org.projects.list(team.id);
    await a.org.idle();
    // The app starts again, offline
    srv.online = false;
    const again = await installation(srv, null, a.host);
    await again.mp.setSession({ server: SERVER, token: alice.token });
    expect((await again.org.orgs.list()).map((o) => o.name)).toEqual(["Acme"]);
    expect((await again.org.orgs.get(org.id)).name).toBe("Acme");
    expect((await again.org.teams.list(org.id)).map((t) => t.name)).toEqual(["Design"]);
    expect((await again.org.projects.list(team.id)).map((p) => p.name)).toEqual(["Web"]);
    expect((await again.org.projects.files(folder.id)).map((f) => f.name)).toEqual(["Spec"]);
    await again.org.idle();
    expect(again.events).toContainEqual({ type: "cache.stale", orgId: org.id, offline: true });
    // Not cached: offline
    expect(await codeOf(again.org.teams.members(team.id))).toBe("offline");
    expect(await codeOf(again.org.teams.create(org.id, { name: "New" }))).toBe("offline");
    const before = a.host.ws.files.size;
    expect(await codeOf(again.org.projects.createFile(folder.id, { name: "Never" }))).toBe("offline");
    expect(a.host.ws.files.size).toBe(before);
    // Back online: the reads refresh and say what changed
    srv.online = true;
    await srv.exec(`UPDATE teams SET name = ?2 WHERE id = ?1`, team.id, "Design system");
    a.host.t += 10_000;
    expect((await again.org.teams.list(org.id))[0].name).toBe("Design");
    await again.org.idle();
    expect(again.events).toContainEqual({ type: "teams.changed", orgId: org.id });
    expect((await again.org.teams.list(org.id))[0].name).toBe("Design system");
  });

  it("keeps each account's caches apart, and empty signed out", async () => {
    const { srv, a } = await acme();
    await a.org.idle();
    const carol = await srv.addUser("carol@example.com");
    const c = await installation(srv, null, a.host);
    expect(await c.org.orgs.list()).toEqual([]);
    await c.mp.setSession({ server: SERVER, token: carol.token });
    srv.online = false;
    expect(await c.org.orgs.list()).toEqual([]);
    srv.online = true;
    expect(await c.org.orgs.list()).toEqual([]);
    expect(a.host.caches.size).toBe(1);
  });

  it("refreshes what an Inbox notice names, then tells", async () => {
    const { srv, a, org, team } = await acme();
    expect((await a.org.teams.list(org.id))[0].name).toBe("Design");
    await srv.exec(`UPDATE teams SET name = ?2 WHERE id = ?1`, team.id, "Product");
    a.events.length = 0;
    a.notices.send({ orgId: org.id, what: "teams" });
    await settle();
    await a.org.idle();
    expect(a.events).toEqual([{ type: "teams.changed", orgId: org.id }]);
    // Already refreshed: the cache's answer is the new one
    const n = srv.log.length;
    expect((await a.org.teams.list(org.id))[0].name).toBe("Product");
    expect(srv.log.length).toBe(n);
    // Also as an OrgEvent's own name, and for folders and files
    a.notices.send({ orgId: org.id, what: "files.changed", projectId: null });
    a.notices.send({ orgId: org.id, what: "projects", teamId: team.id, parentId: null });
    await settle();
    await a.org.idle();
    expect(a.events).toContainEqual({ type: "files.changed", orgId: org.id, projectId: null });
    expect(a.events).toContainEqual({ type: "projects.changed", teamId: team.id, parentId: null });
  });

  it("hands on the server's error codes (conflict, forbidden with detail) and seats", async () => {
    const { srv, a, org, team, folder } = await acme();
    const dup = await a.org.teams.create(org.id, { name: "Design" }).catch((e: unknown) => e);
    expect(dup).toMatchObject({ code: "conflict", detail: { code: "conflict" } });
    const bobUser = await srv.addUser("bob@example.com");
    await a.org.teams.invite(team.id, { email: "bob@example.com", role: "editor" });
    await srv.acceptInvites(bobUser.token);
    await a.org.admin.updateSettings(org.id, { teamCreation: "admins", seatApproval: { full: "auto", dev: "manual", collab: "manual" } });
    const b = await installation(srv, bobUser.token);
    expect(await b.org.teams.create(org.id, { name: "Mine" }).catch((e: unknown) => e)).toMatchObject({ code: "forbidden", detail: { code: "admins_only" } });
    // A View seat can't create a design file: refused, and the local copy made for it is gone
    const files = b.host.ws.files.size;
    expect(await b.org.projects.createFile(folder.id).catch((e: unknown) => e)).toMatchObject({ code: "forbidden", detail: { code: "seat_required", seat: "full" } });
    expect(b.host.ws.files.size).toBe(files);
    expect(await b.org.admin.dashboard(org.id).catch((e: unknown) => e)).toMatchObject({ code: "forbidden", detail: { code: "not_admin" } });
    // "Ask to upgrade": approved at once under `auto`
    expect((await b.org.orgs.requestSeat(org.id, "full", "for the redesign")).state).toBe("approved");
    expect(b.events).toContainEqual({ type: "orgs.changed" });
    expect((await b.org.orgs.get(org.id)).seat).toBe("full");
    expect((await b.org.projects.createFile(folder.id)).file.name).toBe("Untitled");
    expect(await codeOf(b.org.teams.get("nope"))).toBe("not-found");
  });

  it("serves the Admin calls", async () => {
    const { srv, alice, a, org } = await acme();
    await a.org.admin.addPeople(org.id, { emails: ["dan@example.com"], role: "member" });
    const dash = await a.org.admin.dashboard(org.id);
    expect(dash).toMatchObject({ members: 2, seats: { full: 1, view: 1 } });
    const page = await a.org.admin.people(org.id, { text: "dan" });
    expect(page.items.map((p) => [p.email, p.seat])).toEqual([["dan@example.com", "view"]]);
    await a.org.admin.updatePeople(org.id, { userIds: [page.items[0].id], seat: "dev" });
    expect((await a.org.admin.people(org.id)).items.find((p) => p.id === page.items[0].id)?.seat).toBe("dev");
    expect(await a.org.admin.exportCsv(org.id, "people")).toContain("dan@example.com,,member,dev");
    expect((await a.org.admin.activity(org.id, { events: ["team_create"] })).activity_logs.map((l) => l.entity.name)).toEqual(["Design"]);
    expect(await a.org.admin.settings(org.id)).toMatchObject({ defaultSeat: "view", teamCreation: "anyone" });
    // Workspaces and billing groups are addressed by their own id: the store finds their org
    const ws = await a.org.admin.createWorkspace(org.id, { name: "EU", adminIds: [] });
    const other = await installation(srv, alice.token);
    expect((await other.org.admin.updateWorkspace(ws.id, { name: "Europe" })).name).toBe("Europe");
    const bg = await a.org.admin.createBillingGroup(org.id, { name: "Marketing" });
    expect((await other.org.admin.updateBillingGroup(bg.id, { name: "Brand" })).name).toBe("Brand");
    await other.org.admin.deleteBillingGroup(bg.id);
    expect(await a.org.admin.billingGroups(org.id)).toEqual([]);
    // User groups (orgs repository)
    const g = await a.org.orgs.createGroup(org.id, { name: "Designers", userIds: [alice.user.id] });
    expect((await a.org.orgs.groups(org.id)).map((x) => [x.name, x.memberCount])).toEqual([["Designers", 1]]);
    await a.org.orgs.updateGroup(g.id, { name: "Design" });
    expect((await a.org.orgs.groups(org.id)).map((x) => x.name)).toEqual(["Design"]);
    expect((await a.org.orgs.people(org.id)).groups.map((x) => x.name)).toEqual(["Design"]);
  });

  it("Prefs.browse.space: the space Home shows", async () => {
    const h = new Host();
    expect((await h.ws.setBrowsePrefs({ space: "org:o1" })).browse).toMatchObject({ space: "org:o1", layout: "grid" });
    expect((await h.ws.setBrowsePrefs({ layout: "list" })).browse).toMatchObject({ space: "org:o1", layout: "list" });
    await expect(h.ws.setBrowsePrefs({ space: "elsewhere" as never })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("the Inbox's org notices", () => {
  it("are handed on by NotificationsService", async () => {
    class Socket {
      static last: Socket;
      readyState = 1;
      onopen: ((e: unknown) => void) | null = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onclose = null;
      onerror = null;
      binaryType = "";
      constructor() {
        Socket.last = this;
        queueMicrotask(() => this.onopen?.({}));
      }
      send() {}
      close() {}
    }
    const mp = { onSession: () => () => {}, signedIn: true, wsUrl: () => "wss://x/notifications/ws", call: async () => ({ items: [], unread: 0, pending: 0, files: [], next: null }) };
    const n = new NotificationsService(mp as never, { WebSocket: Socket as never, pingMs: 0 });
    const got: OrgNotice[] = [];
    const reconnects: number[] = [];
    n.onOrg((x) => got.push(x));
    n.onReconnect(() => reconnects.push(1));
    await settle();
    Socket.last.onmessage?.({ data: JSON.stringify({ t: "org", orgId: "o1", what: "teams" }) });
    expect(got).toEqual([{ t: "org", orgId: "o1", what: "teams" }]);
    expect(reconnects).toEqual([1]);
    n.close();
  });
});

describe("LocalStore's org spaces", () => {
  let t: TestStore | null = null;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (t) {
      await t.close();
      t.dispose();
      t = null;
    }
  });

  it("keeps Workspace/spaces/<orgId>.json, makes org copies on disk, and serves the repositories", async () => {
    vi.stubGlobal("WebSocket", NoSocket);
    const srv = new RealOrgServer();
    const alice = await srv.addUser("alice@example.com");
    t = await openTestStore({ fetch: srv.fetch });
    await t.api.multiplayer.setSession({ server: SERVER, token: alice.token });
    const org = await t.api.orgs.create({ name: "Acme" });
    const team = await t.api.teams.create(org.id, { name: "Design" });
    const folder = await t.api.projects.create(team.id, { name: "Web" });
    const { fileKey, file } = await t.api.projects.createFile(folder.id, { name: "Spec" });
    expect((await t.api.workspace.getFile(fileKey)).space).toEqual({ orgId: org.id, key: file.key, teamId: team.id, projectId: folder.id });
    expect((await t.api.workspace.listFiles({ in: "drafts" })).map((f) => f.fileKey)).not.toContain(fileKey);
    expect((await srv.file(file.key))?.snapshot?.bytes.length).toBeGreaterThan(0);
    await t.api.teams.list(org.id);
    await t.store.org.idle();
    await t.idle();
    const path = join(t.dir, "Workspace", "spaces", `${org.id}.json`);
    expect(existsSync(path)).toBe(true);
    const cache = JSON.parse(readFileSync(path, "utf8")) as OrgCache;
    expect(cache).toMatchObject({ v: 1, orgId: org.id, summary: { name: "Acme" }, teams: { mine: [{ name: "Design" }] } });
    // A restart, offline: the cache answers
    await t.close();
    srv.online = false;
    t = await t.reopen({ fetch: srv.fetch });
    await t.api.multiplayer.setSession({ server: SERVER, token: alice.token });
    expect((await t.api.orgs.list()).map((o) => o.name)).toEqual(["Acme"]);
    expect((await t.api.teams.list(org.id)).map((x) => x.name)).toEqual(["Design"]);
    expect((await t.api.workspace.getFile(fileKey)).space?.key).toBe(file.key);
  });

  it("serves orgs / teams / projects / admin over the port, with the `org` event topic", async () => {
    vi.stubGlobal("WebSocket", NoSocket);
    const srv = new RealOrgServer();
    const alice = await srv.addUser("alice@example.com");
    t = await openTestStore({ fetch: srv.fetch });
    const server = new StoreServer(t.store, { generation: 1 });
    const { port1, port2 } = new MessageChannel();
    server.connect(portTransport(port1), "home");
    const client = new StoreClient();
    client.attach(portTransport(port2));
    await client.whenReady();
    try {
      await t.api.multiplayer.setSession({ server: SERVER, token: alice.token });
      const events: OrgEvent[] = [];
      client.orgs.watch((e) => events.push(e));
      const org = await client.orgs.create({ name: "Acme" });
      const team = await client.teams.create(org.id, { name: "Design" });
      expect((await client.projects.list(team.id)).length).toBe(0);
      expect((await client.admin.settings(org.id)).defaultSeat).toBe("view");
      expect(await client.teams.create(org.id, { name: "Design" }).catch((e: unknown) => e)).toMatchObject({ code: "conflict" });
      expect(await client.workspace.setBrowsePrefs({ space: `org:${org.id}` })).toMatchObject({ browse: { space: `org:${org.id}` } });
      await settle();
      expect(events).toContainEqual({ type: "orgs.changed" });
      expect(events).toContainEqual({ type: "teams.changed", orgId: org.id });
    } finally {
      client.close();
      server.close();
    }
  });
});

describe("names and icons (docs/multiplayer.md §14.16)", () => {
  const png = (seed: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(seed)]);

  it("an org admin renames the org and sets its icon: the cache, the list and the events follow; iconData gives a picture", async () => {
    const { srv, a, org, team } = await acme();
    a.events.length = 0;
    const renamed = await a.org.orgs.update(org.id, { name: "Acme Inc" });
    expect(renamed.name).toBe("Acme Inc");
    expect(a.events).toEqual(expect.arrayContaining([{ type: "orgs.changed" }, { type: "org.updated", orgId: org.id }]));
    expect((await a.org.orgs.list())[0].name).toBe("Acme Inc");

    const icon = png("org icon");
    const withIcon = await a.org.orgs.setIcon(org.id, icon);
    expect(withIcon.iconUrl).toMatch(new RegExp(`^/icons/${org.id}/[0-9a-f]{40}$`));
    expect((await a.org.orgs.list())[0].iconUrl).toBe(withIcon.iconUrl);
    expect((await a.org.orgs.get(org.id)).iconUrl).toBe(withIcon.iconUrl);
    await a.org.idle();
    expect(a.host.caches.get(org.id)?.summary?.iconUrl).toBe(withIcon.iconUrl);
    const data = await a.org.orgs.iconData(withIcon.iconUrl!);
    expect(data).toBe(`data:image/png;base64,${Buffer.from(icon).toString("base64")}`);
    // Kept for the session: asked once
    const asked = srv.log.filter((l) => l.startsWith("GET /icons/")).length;
    await a.org.orgs.iconData(withIcon.iconUrl!);
    expect(srv.log.filter((l) => l.startsWith("GET /icons/")).length).toBe(asked);
    expect(await a.org.orgs.iconData("https://elsewhere.example/x.png")).toBeNull();

    expect((await a.org.orgs.removeIcon(org.id)).iconUrl).toBeNull();
    // Checked before the server is asked
    await expect(a.org.orgs.setIcon(org.id, new TextEncoder().encode("<svg/>"))).rejects.toMatchObject({ code: "invalid" });
    await expect(a.org.orgs.setIcon(org.id, new Uint8Array(1024 * 1024 + 1).fill(0xff))).rejects.toMatchObject({ code: "invalid" });

    // A team's icon: its admins
    const t = await a.org.teams.setIcon(team.id, png("team icon"));
    expect(t.iconUrl).toMatch(/^\/icons\//);
    expect((await a.org.teams.list(org.id)).find((x) => x.id === team.id)?.iconUrl).toBe(t.iconUrl);
    expect(a.events).toContainEqual({ type: "team.updated", teamId: team.id });
    expect((await a.org.teams.removeIcon(team.id)).iconUrl).toBeNull();
  });

  it("a member can't: forbidden", async () => {
    const { srv, a, org, team } = await acme();
    const bobUser = await srv.addUser("bob@example.com", "Bob");
    await a.org.teams.invite(team.id, { email: "bob@example.com", role: "editor" });
    await srv.acceptInvites(bobUser.token);
    const b = await installation(srv, bobUser.token);
    expect(await codeOf(b.org.orgs.update(org.id, { name: "Mine" }))).toBe("forbidden");
    expect(await codeOf(b.org.orgs.setIcon(org.id, png("x")))).toBe("forbidden");
    expect(await codeOf(b.org.teams.setIcon(team.id, png("x")))).toBe("forbidden");
  });
});

describe("Delete organization (docs/multiplayer.md §14.17)", () => {
  it("an admin deletes it with its name typed: gone for good at once, for its admins too", async () => {
    const { srv, a, org, team } = await acme();
    const bobUser = await srv.addUser("bob@example.com", "Bob");
    await a.org.teams.invite(team.id, { email: "bob@example.com", role: "editor" });
    await srv.acceptInvites(bobUser.token);
    const b = await installation(srv, bobUser.token);
    expect((await b.org.orgs.list()).map((o) => o.id)).toEqual([org.id]);
    expect(await codeOf(b.org.orgs.remove(org.id, "Acme"))).toBe("forbidden");
    expect(await codeOf(a.org.orgs.remove(org.id, "Wrong"))).toBe("invalid");
    a.events.length = 0;
    await a.org.orgs.remove(org.id, "Acme");
    expect(a.events).toContainEqual({ type: "orgs.changed" });
    expect(await a.org.orgs.list()).toEqual([]);
    // Bob's list, read again (his app hears the server's notice): the org is gone
    b.notices.send({ what: "orgs" });
    await b.org.idle();
    expect(await b.org.orgs.list()).toEqual([]);
  });

  it("trashed drafts list in the trash and are deleted forever from there", async () => {
    const { a, org } = await acme();
    const { file } = await a.org.orgs.createDraft(org.id, { name: "Sketch" });
    await a.org.projects.trashFiles([file.key]);
    expect(await a.org.orgs.drafts(org.id)).toEqual([]);
    expect((await a.org.orgs.trashedDrafts(org.id)).map((f) => f.key)).toEqual([file.key]);
    await a.org.projects.deleteFilesForever([file.key]);
    expect(await a.org.orgs.trashedDrafts(org.id)).toEqual([]);
  });
});
