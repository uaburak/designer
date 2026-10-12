import { beforeEach, describe, expect, it } from "vitest";
import { handle, type Deps } from "../api";
import { Db } from "../db";
import { sqliteD1 } from "../testing/sqliteD1";

const ORIGIN = "https://designer.example.workers.dev";

let deps: Deps;
let rooms: { key: string; path: string; body: unknown; identity?: { role: string } }[];
let inbox: { userId: string; msg: Record<string, unknown> }[];
let now: number;

beforeEach(() => {
  now = Date.UTC(2026, 9, 11);
  rooms = [];
  inbox = [];
  deps = {
    db: new Db(sqliteD1()),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1" },
    rooms: {
      async fetch(key, path, init) {
        rooms.push({ key, path, body: typeof init.body === "string" ? JSON.parse(init.body) : null, identity: init.identity });
        return Response.json({ ok: true });
      },
    },
    inboxes: {
      async notify(userId, msg) {
        inbox.push({ userId, msg: msg as Record<string, unknown> });
      },
      async connect() {
        return new Response(null);
      },
    },
    now: () => now,
    fetch: async () => new Response("no", { status: 500 }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await handle(
    new Request(ORIGIN + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    deps,
  );
  const text = await res.text();
  let parsed: Any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // CSV, HTML
  }
  return { status: res.status, body: parsed as Any };
};

async function signIn(email: string) {
  const r = await call("POST", "/auth/dev", undefined, { email, name: email.split("@")[0] });
  return r.body as { token: string; user: { id: string; email: string } };
}


// The single routes' answers, compared with the page routes'

/** An org with a team "Design", a folder "Web" (a subfolder "Sub", a file in each) by its admin Alice; Bob a member */
async function acme() {
  const alice = await signIn("alice@x.co");
  const bob = await signIn("bob@x.co");
  const carol = await signIn("carol@y.co");
  const org = (await call("POST", "/orgs", alice.token, { name: "Acme" })).body.org;
  await call("POST", `/orgs/${org.id}/admin/people`, alice.token, { emails: ["bob@x.co", "dave@x.co"], role: "member" });
  const team = (await call("POST", `/orgs/${org.id}/teams`, alice.token, { name: "Design" })).body.team;
  const folder = (await call("POST", `/teams/${team.id}/projects`, alice.token, { name: "Web" })).body.project;
  const sub = (await call("POST", `/teams/${team.id}/projects`, alice.token, { name: "Sub", parentId: folder.id })).body.project;
  await call("POST", `/projects/${folder.id}/files`, alice.token, { key: "file_web001", name: "Home" });
  await call("POST", `/projects/${sub.id}/files`, alice.token, { key: "file_sub001", name: "Deep" });
  return { alice, bob, carol, org, team, folder, sub };
}

/** What Home read before the page routes: each part from its own route, a refused part empty (useOrgData's `quiet`) */
async function teamSingles(token: string, teamId: string) {
  const team = await call("GET", `/teams/${teamId}`, token);
  if (team.status !== 200) return { status: team.status };
  const part = async (path: string, key: string) => {
    const r = await call("GET", path, token);
    return r.status === 200 ? r.body[key] : [];
  };
  return {
    status: 200,
    body: {
      team: team.body.team,
      folders: await part(`/teams/${teamId}/projects`, "projects"),
      members: await part(`/teams/${teamId}/members`, "members"),
      requests: await part(`/teams/${teamId}/requests`, "requests"),
    },
  };
}

async function projectSingles(token: string, projectId: string) {
  const project = await call("GET", `/projects/${projectId}`, token);
  if (project.status !== 200) return { status: project.status };
  const p = project.body.project;
  const part = async (path: string, key: string, none: unknown = []) => {
    const r = await call("GET", path, token);
    return r.status === 200 ? r.body[key] : none;
  };
  return {
    status: 200,
    body: {
      project: p,
      team: await part(`/teams/${p.teamId}`, "team", null),
      folders: await part(`/teams/${p.teamId}/projects?parent=${p.id}`, "projects"),
      files: await part(`/projects/${p.id}/files`, "files"),
      members: await part(`/projects/${p.id}/members`, "members"),
    },
  };
}

const page = async (token: string, path: string) => {
  const r = await call("GET", path, token);
  return r.status === 200 ? { status: 200, body: r.body } : { status: r.status };
};

describe("Home's page routes (org/pages.ts)", () => {
  it("a team's page is what its four routes answer, for an admin, a member, a stranger and someone asking to join", async () => {
    const { alice, bob, carol, team } = await acme();
    const dave = await signIn("dave@x.co");
    // Only those invited, visible: Dave asks to join; Alice (an admin) sees the request, Bob doesn't
    await call("PATCH", `/teams/${team.id}`, alice.token, { orgAccess: "none", workspaceAccess: "none" });
    expect((await call("POST", `/teams/${team.id}/join`, dave.token)).body.status).toBe("requested");
    for (const who of [alice, bob, carol, dave]) {
      const want = await teamSingles(who.token, team.id);
      expect(await page(who.token, `/teams/${team.id}/page`), who.user.email).toEqual(want);
    }
    const a = await page(alice.token, `/teams/${team.id}/page`);
    expect(a.body.folders.map((f: Any) => f.name)).toEqual(["Web"]);
    expect(a.body.requests).toHaveLength(1);
    expect((await page(dave.token, `/teams/${team.id}/page`)).body.requests).toEqual([]);
    expect((await page(carol.token, `/teams/${team.id}/page`)).status).toBe(404);
  });

  it("a deleted team's page: the team only, as the routes answer", async () => {
    const { alice, team } = await acme();
    await call("DELETE", `/teams/${team.id}`, alice.token);
    const want = await teamSingles(alice.token, team.id);
    expect(want.status).toBe(200);
    const got = await page(alice.token, `/teams/${team.id}/page`);
    expect(got).toEqual(want);
    expect(got.body).toMatchObject({ folders: [], members: [], requests: [] });
  });

  it("a folder's page is what its five routes answer: admin, member, stranger, a limited folder, folder-only access", async () => {
    const { alice, bob, carol, team, folder, sub } = await acme();
    for (const who of [alice, bob, carol]) {
      for (const p of [folder, sub]) expect(await page(who.token, `/projects/${p.id}/page`), `${who.user.email} ${p.name}`).toEqual(await projectSingles(who.token, p.id));
    }
    const a = await page(alice.token, `/projects/${folder.id}/page`);
    expect(a.body.folders.map((f: Any) => f.name)).toEqual(["Sub"]);
    expect(a.body.files.map((f: Any) => f.name)).toEqual(["Home"]);
    expect(a.body.team.id).toBe(team.id);
    expect(a.body.members.length).toBeGreaterThan(0);
    expect((await page(carol.token, `/projects/${folder.id}/page`)).status).toBe(404);
    // Limited: Bob loses it; then a hidden team where Bob is invited to the folder only
    await call("PATCH", `/projects/${folder.id}`, alice.token, { access: "limited" });
    expect((await page(bob.token, `/projects/${folder.id}/page`)).status).toBe((await projectSingles(bob.token, folder.id)).status);
    await call("PATCH", `/teams/${team.id}`, alice.token, { visibility: "hidden", orgAccess: "none", workspaceAccess: "none" });
    await call("PUT", `/projects/${folder.id}/members`, alice.token, { email: "bob@x.co", role: "viewer" });
    const want = await projectSingles(bob.token, folder.id);
    expect(want.status).toBe(200);
    // The team's own routes refuse Bob: no team, no subfolders
    expect(want.body).toMatchObject({ team: null, folders: [] });
    expect(await page(bob.token, `/projects/${folder.id}/page`)).toEqual(want);
  });

  it("only GET, and the page answers the same status as the folder's and team's own routes", async () => {
    const { alice, carol, team, folder } = await acme();
    for (const who of [alice, carol]) {
      const status = async (path: string) => (await call("GET", path, who.token)).status;
      expect(await status(`/teams/${team.id}/page`)).toBe(await status(`/teams/${team.id}`));
      expect(await status(`/projects/${folder.id}/page`)).toBe(await status(`/projects/${folder.id}`));
    }
    expect((await call("POST", `/teams/${team.id}/page`, alice.token, {})).status).toBe(404);
    expect((await call("POST", `/projects/${folder.id}/page`, alice.token, {})).status).toBe(404);
  });
});
