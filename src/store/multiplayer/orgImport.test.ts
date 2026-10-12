/**
 * Home's Import while an org is the space shown (docs/multiplayer.md §5.1): the .fig lands in the org's Drafts or the
 * folder shown as an org file — registered, uploaded with the upload panel following it, no stray local Draft — and
 * in the local space it stays as before. The desktop store against the real server (server/src/api.ts on node:sqlite).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadEvent, UploadProgress } from "../../shared/multiplayer/uploads";
import { StoreError } from "../../shared/store/protocol";
import type { FileMeta, FileSpace } from "../../shared/store/types";
import { RealOrgServer } from "../org/fake/real";
import { openTestStore, type TestStore } from "../testing/harness";
import { importIntoOrg, type OrgImportDeps } from "./orgImport";

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

let t: TestStore | null = null;
afterEach(async () => {
  await t?.close().catch(() => {});
  t?.dispose();
  t = null;
  vi.unstubAllGlobals();
});

async function acmeStore() {
  vi.stubGlobal("WebSocket", NoSocket);
  const srv = new RealOrgServer();
  const alice = await srv.addUser("alice@example.com");
  t = await openTestStore({ fetch: srv.fetch });
  await t.api.multiplayer.setSession({ server: SERVER, token: alice.token });
  const org = await t.api.orgs.create({ name: "Anex Tour" });
  const team = await t.api.teams.create(org.id, { name: "Design" });
  const folder = await t.api.projects.create(team.id, { name: "KOC" });
  const uploads: UploadProgress[] = [];
  t.api.multiplayer.watchUploads((e: UploadEvent) => void ("upload" in e && uploads.push(e.upload)));
  return { srv, t, org, team, folder, uploads };
}

describe("Import into an org", () => {
  it("puts a .fig into the folder shown as an org file, uploaded, named in the upload panel, with no local Draft left", async () => {
    const { srv, t, org, team, folder, uploads } = await acmeStore();
    const meta = await t.api.files.importFigBytes(new Uint8Array(readFileSync(SAMPLE)), "structure.fig", null, { orgId: org.id, projectId: folder.id });
    expect(meta.space).toMatchObject({ orgId: org.id, teamId: team.id, projectId: folder.id });
    // On the server in the folder, with its snapshot
    const row = await srv.file(meta.space!.key);
    expect(row).toMatchObject({ orgId: org.id, teamId: team.id, projectId: folder.id });
    expect(row!.snapshot!.bytes.length).toBeGreaterThan(1000);
    // Listed in the folder, linked to this copy; nowhere in the local space
    expect((await t.api.projects.files(folder.id)).find((f) => f.key === meta.space!.key)?.fileKey).toBe(meta.fileKey);
    expect((await t.api.workspace.listFiles({ in: "drafts" })).map((f) => f.fileKey)).not.toContain(meta.fileKey);
    expect((await t.api.workspace.listFiles({ in: "recents" })).filter((f) => !f.space).length).toBe(0);
    // The upload panel saw it go, to where it went, every byte of it
    const last = uploads.filter((u) => u.fileKey === meta.fileKey).at(-1)!;
    expect(last).toMatchObject({ state: "done", name: meta.name, destination: "Anex Tour › Design › KOC" });
    expect(last.bytesSent).toBe(last.bytesTotal);
    expect(last.bytesTotal).toBe(row!.snapshot!.bytes.length);
  });

  it("puts a .fig into the org's Drafts when they are shown", async () => {
    const { srv, t, org, uploads } = await acmeStore();
    const meta = await t.api.files.importFigBytes(new Uint8Array(readFileSync(SAMPLE)), "structure.fig", null, { orgId: org.id, projectId: null });
    expect(meta.space).toMatchObject({ orgId: org.id, teamId: null, projectId: null });
    expect(await srv.file(meta.space!.key)).toMatchObject({ orgId: org.id, projectId: null });
    expect((await t.api.orgs.drafts(org.id)).map((f) => f.key)).toContain(meta.space!.key);
    expect((await t.api.workspace.listFiles({ in: "drafts" })).map((f) => f.fileKey)).not.toContain(meta.fileKey);
    expect(uploads.filter((u) => u.fileKey === meta.fileKey).at(-1)).toMatchObject({ state: "done", destination: "Anex Tour › Drafts" });
  });

  it("in the local space, imports into the local Drafts or folder as before (nothing uploaded)", async () => {
    const { srv, t, uploads } = await acmeStore();
    const before = srv.log.length;
    const folder = await t.api.workspace.createFolder({ name: "Imports", parentId: null });
    const meta = await t.api.files.importFigBytes(new Uint8Array(readFileSync(SAMPLE)), "structure.fig", folder.id);
    expect(meta.space ?? null).toBeNull();
    expect(meta.folderId).toBe(folder.id);
    expect(srv.log.slice(before)).toEqual([]);
    expect(uploads).toEqual([]);
    const draft = await t.api.files.importFigBytes(new Uint8Array(readFileSync(SAMPLE)), "structure.fig");
    expect((await t.api.workspace.listFiles({ in: "drafts" })).map((f) => f.fileKey)).toContain(draft.fileKey);
  });

  it("leaves nothing behind when the org refuses it (offline before registering), and says so", async () => {
    const { srv, t, org, folder } = await acmeStore();
    srv.online = false;
    await expect(t.api.files.importFigBytes(new Uint8Array(readFileSync(SAMPLE)), "structure.fig", null, { orgId: org.id, projectId: folder.id })).rejects.toMatchObject({ code: "offline" });
    expect((await t.api.workspace.listFiles({ in: "recents" })).length + (await t.api.workspace.listFiles({ in: "drafts" })).length).toBe(0);
  });
});

describe("importIntoOrg", () => {
  const deps = (over: Partial<OrgImportDeps> = {}) => {
    const did: string[] = [];
    const d: OrgImportDeps = {
      mp: {
        signedIn: true,
        newRoomKey: () => "room_1",
        shareTo: (async (_f: string, _i: unknown, register: (k: string, n: string) => Promise<unknown>, key?: string) => register(key!, "Spec")) as never,
        call: (async (m: string, p: string, body: unknown) => void did.push(`${m} ${p} ${JSON.stringify(body)}`)) as never,
      },
      teamOf: async () => "t1",
      importLocal: async (space: FileSpace) => (did.push(`import ${JSON.stringify(space)}`), { fileKey: "local1", name: "Spec", space } as FileMeta),
      headSnapshot: async () => new Uint8Array([1]),
      deleteLocal: async (k) => void did.push(`delete ${k}`),
      filesChanged: (o, p) => void did.push(`changed ${o} ${p}`),
      log: () => {},
      ...over,
    };
    return { d, did };
  };

  it("imports hidden in its org place, registers it there, and drops the copy when the upload is refused before registering", async () => {
    const ok = deps();
    await importIntoOrg(ok.d, { orgId: "o1", projectId: "p1" });
    expect(ok.did).toEqual([`import {"orgId":"o1","key":"room_1","teamId":"t1","projectId":"p1"}`, `POST /files {"key":"room_1","name":"Spec","orgId":"o1","projectId":"p1"}`, "changed o1 p1"]);
    const drafts = deps();
    await importIntoOrg(drafts.d, { orgId: "o1", projectId: null });
    expect(drafts.did[1]).toBe(`POST /files {"key":"room_1","name":"Spec","orgId":"o1"}`);
    const refused = deps({ mp: { ...deps().d.mp, shareTo: (async () => Promise.reject(new StoreError("forbidden", "no seat"))) as never } });
    await expect(importIntoOrg(refused.d, { orgId: "o1", projectId: null })).rejects.toMatchObject({ code: "forbidden" });
    expect(refused.did.at(-1)).toBe("delete local1");
    // Registered, its upload unfinished: the copy is the org file (its link finishes it)
    const pending = deps({ mp: { ...deps().d.mp, shareTo: (async () => Promise.reject(new StoreError("unavailable", "busy", { pendingUpload: true }))) as never } });
    await expect(importIntoOrg(pending.d, { orgId: "o1", projectId: null })).rejects.toMatchObject({ code: "unavailable" });
    expect(pending.did.at(-1)).toBe("changed o1 null");
  });
});
