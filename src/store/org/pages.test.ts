/**
 * Home's pages, instant (Designer 1.0.3): `teams.page` / `projects.page` are one request each (`GET /teams/:id/page`,
 * `/projects/:id/page`; four or five before), cached stale-while-revalidate in the org's cache — a hit answers at once
 * and refreshes behind (an event when it changed), a write patches the cache and a read from before it isn't stored
 * over it, a refusal on the refresh (gone, a Governance+ gate) drops the page and is said, concurrent reads share one
 * request; `DESIGNER_FAKE_LATENCY_MS` slows the store's requests. Through LocalStore against the real server handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgEvent } from "../../shared/org/repositories";
import { StoreError } from "../../shared/store/protocol";
import { openTestStore, type TestStore } from "../testing/harness";
import { acmeServer, REAL_ORIGIN as ORIGIN } from "./fake/real";

/* eslint-disable @typescript-eslint/no-explicit-any */

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

let w: Awaited<ReturnType<typeof acmeServer>>;
let t: TestStore;
/** "GET /path" of each request the store sent */
let log: string[];
/** While set, requests wait for it (a slow network) */
let hold: Promise<void> | null;
let teamId: string;
let folderId: string;
let events: OrgEvent[];

const settle = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const gets = (re: RegExp) => log.filter((l) => l.startsWith("GET ") && re.test(l));
const slow = () => {
  let release!: () => void;
  hold = new Promise<void>((r) => (release = r));
  return () => {
    hold = null;
    release();
  };
};

beforeEach(async () => {
  vi.stubGlobal("WebSocket", NoSocket);
  w = await acmeServer();
  log = [];
  hold = null;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (hold) await hold;
    log.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    return w.srv.fetch(input, init);
  };
  teamId = (await w.srv.call("POST", `/orgs/${w.orgId}/teams`, w.admin.token, { name: "Design" })).body.team.id;
  folderId = (await w.srv.call("POST", `/teams/${teamId}/projects`, w.admin.token, { name: "Web" })).body.project.id;
  await w.srv.call("POST", `/projects/${folderId}/files`, w.admin.token, { key: "file_web001", name: "Home" });
  t = await openTestStore({ fetch });
  await t.api.multiplayer.setSession({ server: ORIGIN, token: w.admin.token });
  events = [];
  t.store.org.onEvent((e) => events.push(e));
  t.store.governanceEvents.onEvent((e) => events.push(e));
  // Home's first reads: the org and its teams (the sidebar)
  await t.api.orgs.list();
  await t.api.teams.list(w.orgId);
  await t.store.org.idle();
  log.length = 0;
});

afterEach(async () => {
  hold = null;
  await t.close();
  t.dispose();
  vi.unstubAllGlobals();
  delete process.env.DESIGNER_FAKE_LATENCY_MS;
});

describe("Home's pages (stale-while-revalidate)", () => {
  it("a team page is one request; the next visit answers from the cache at once and refreshes behind", async () => {
    const page = await t.api.teams.page!(teamId);
    expect(page.team.name).toBe("Design");
    expect(page.folders.map((f) => f.name)).toEqual(["Web"]);
    expect(page.members.map((m) => m.owner)).toEqual([true]);
    expect(page.requests).toEqual([]);
    expect(gets(/\/teams\//)).toEqual([`GET /teams/${teamId}/page`]);
    // The cache on disk has it: another start shows it without asking first
    await t.store.org.idle();

    // Renamed behind the store's back, the network slow: the cached page comes at once, the refresh lands later
    await w.srv.call("PATCH", `/teams/${teamId}`, w.admin.token, { name: "Design 2" });
    t.clock.advance(10_000);
    const release = slow();
    const again = await t.api.teams.page!(teamId);
    expect(again.team.name).toBe("Design");
    expect(events.filter((e) => e.type === "team.updated")).toEqual([]);
    release();
    await t.store.org.idle();
    expect(events).toContainEqual({ type: "team.updated", teamId });
    expect((await t.api.teams.page!(teamId)).team.name).toBe("Design 2");
    // Its parts are the same cache: the team, its folders, members, requests answer without a request
    log.length = 0;
    expect((await t.api.teams.get(teamId)).name).toBe("Design 2");
    expect((await t.api.projects.list(teamId)).map((p) => p.name)).toEqual(["Web"]);
    expect(await t.api.teams.members(teamId)).toHaveLength(1);
    expect(await t.api.teams.requests(teamId)).toEqual([]);
    expect(log).toEqual([]);
  });

  it("a folder page is one request with the folder, its team, subfolders, files and members", async () => {
    const page = await t.api.projects.page!(folderId);
    expect(page.project.name).toBe("Web");
    expect(page.team?.id).toBe(teamId);
    expect(page.files.map((f) => f.name)).toEqual(["Home"]);
    expect(page.members.length).toBeGreaterThan(0);
    expect(gets(/\/(projects|teams)\//)).toEqual([`GET /projects/${folderId}/page`]);
    log.length = 0;
    t.clock.advance(1000);
    expect((await t.api.projects.page!(folderId)).files.map((f) => f.name)).toEqual(["Home"]);
    expect((await t.api.projects.files(folderId)).map((f) => f.name)).toEqual(["Home"]);
    expect(log).toEqual([]);
  });

  it("writes patch the cache: a new folder shows at once, renamed or trashed too; the refresh reconciles", async () => {
    await t.api.teams.page!(teamId);
    const sub = await t.api.projects.create(teamId, { name: "App" });
    log.length = 0;
    const release = slow();
    // No request waited for: the page answers from the patched cache
    expect((await t.api.teams.page!(teamId)).folders.map((f) => f.name)).toEqual(["App", "Web"]);
    release();
    await t.store.org.idle();
    await t.api.projects.update(sub.id, { name: "Zeta" });
    expect((await t.api.teams.page!(teamId)).folders.map((f) => f.name)).toEqual(["Web", "Zeta"]);
    await t.api.projects.trash(sub.id);
    expect((await t.api.teams.page!(teamId)).folders.map((f) => f.name)).toEqual(["Web"]);
    // Members: the server's answer to the change is the cached list
    await w.srv.addUser("bob@acme.test", "Bob");
    await w.srv.call("POST", `/orgs/${w.orgId}/admin/people`, w.admin.token, { emails: ["bob@acme.test"], role: "member" });
    await t.api.teams.invite(teamId, { email: "bob@acme.test", role: "editor" });
    log.length = 0;
    const release2 = slow();
    expect((await t.api.teams.page!(teamId)).members).toHaveLength(2);
    release2();
    await t.store.org.idle();
  });

  it("an answer to a read sent before a write isn't stored over the write", async () => {
    await t.api.teams.page!(teamId);
    t.clock.advance(10_000);
    // A refresh on its way, slow…
    const release = slow();
    await t.api.teams.page!(teamId);
    await settle();
    // …a folder is made meanwhile (straight to the server: the store's own requests wait)
    hold = null;
    const made = await t.api.projects.create(teamId, { name: "App" });
    expect(made.name).toBe("App");
    release();
    await t.store.org.idle();
    expect((await t.api.teams.page!(teamId)).folders.map((f) => f.name)).toEqual(["App", "Web"]);
  });

  it("concurrent reads with nothing cached share one request (a hover's prefetch, then the click)", async () => {
    const release = slow();
    const a = t.api.teams.page!(teamId);
    const b = t.api.teams.page!(teamId);
    await settle();
    release();
    expect((await a).team.id).toBe((await b).team.id);
    expect(gets(/\/page$/)).toHaveLength(1);
  });

  it("a refresh refused because the page is gone drops it and says so; the next read refuses", async () => {
    await t.api.projects.page!(folderId);
    await w.srv.call("POST", `/projects/${folderId}/trash`, w.admin.token);
    await w.srv.call("DELETE", `/projects/${folderId}`, w.admin.token);
    t.clock.advance(10_000);
    expect((await t.api.projects.page!(folderId)).project.name).toBe("Web");
    await t.store.org.idle();
    expect(events).toContainEqual({ type: "projects.changed", teamId, parentId: folderId });
    const e = await t.api.projects.page!(folderId).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(StoreError);
    expect((e as StoreError).code).toBe("not-found");
  });

  it("a Governance+ gate on the refresh surfaces: access.blocked, the page dropped, the read refused with the gate", async () => {
    await t.api.teams.page!(teamId);
    await t.api.governance.setGovernancePlus(w.orgId, true);
    await t.api.governance.createPolicy(w.orgId, { title: "Acceptable use", text: "Be kind.", audience: "everyone", cadence: "once" });
    events.length = 0;
    t.clock.advance(10_000);
    await t.api.teams.page!(teamId).catch(() => null);
    await t.store.org.idle();
    await settle();
    // Said for the org (the team route's refusal alone can't say whose org it is)
    expect(events.find((e) => e.type === "access.blocked" && e.orgId === w.orgId)).toMatchObject({ code: "policy_acknowledgement_required", gate: { kind: "policy" } });
    const e = (await t.api.teams.page!(teamId).then(
      () => null,
      (err: unknown) => err,
    )) as StoreError;
    expect(e).toBeInstanceOf(StoreError);
    expect((e.detail as any)?.gate).toMatchObject({ kind: "policy" });
  });

  it("an older server (no page routes): the parts one by one, as before — four requests for a team page", async () => {
    const old = w.srv.fetch;
    (w.srv as any).fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      /\/page$/.test(new URL(String(input)).pathname) ? Response.json({ error: "not found" }, { status: 404 }) : old(input, init);
    const page = await t.api.teams.page!(teamId);
    expect(page.folders.map((f) => f.name)).toEqual(["Web"]);
    expect(gets(/\/teams\//).sort()).toEqual([`GET /teams/${teamId}`, `GET /teams/${teamId}/members`, `GET /teams/${teamId}/page`, `GET /teams/${teamId}/projects`, `GET /teams/${teamId}/requests`].sort());
    const folder = await t.api.projects.page!(folderId);
    expect(folder.files.map((f) => f.name)).toEqual(["Home"]);
  });
});

describe("DESIGNER_FAKE_LATENCY_MS", () => {
  it("delays each request; the first visit waits for it, the second doesn't", async () => {
    await t.close();
    t.dispose();
    process.env.DESIGNER_FAKE_LATENCY_MS = "150";
    const fetch: typeof globalThis.fetch = async (input, init) => {
      log.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return w.srv.fetch(input, init);
    };
    t = await openTestStore({ fetch });
    await t.api.multiplayer.setSession({ server: ORIGIN, token: w.admin.token });
    await t.api.teams.list(w.orgId);
    log.length = 0;
    let at = performance.now();
    await t.api.teams.page!(teamId);
    const first = performance.now() - at;
    expect(first).toBeGreaterThanOrEqual(140);
    expect(gets(/\/teams\//)).toEqual([`GET /teams/${teamId}/page`]);
    t.clock.advance(10_000);
    at = performance.now();
    await t.api.teams.page!(teamId);
    expect(performance.now() - at).toBeLessThan(100);
    await t.store.org.idle();
  });
});
