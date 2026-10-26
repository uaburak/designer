/**
 * Invitations wait for an answer (docs/multiplayer.md §14.18): Admin › People and a team's Invite make pending rows
 * (no access, not listed) and bell rows with Accept / Decline; a request to join a team is answered from the bell too.
 * New teams are open to the organization unless their creator says otherwise.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { handle, type Deps } from "../api";
import { Db } from "../db";
import { sqliteD1 } from "../testing/sqliteD1";

const ORIGIN = "https://designer.example.workers.dev";

let deps: Deps;
let rooms: { key: string; path: string; method: string }[];
let inbox: { userId: string; msg: Record<string, unknown> }[];
let now: number;

beforeEach(() => {
  now = Date.UTC(2026, 9, 12);
  rooms = [];
  inbox = [];
  deps = {
    db: new Db(sqliteD1()),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1" },
    rooms: {
      async fetch(key, path, init) {
        rooms.push({ key, path, method: init.method ?? "GET" });
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
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await handle(
    new Request(ORIGIN + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    deps,
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Any };
};

const signIn = async (email: string) => (await call("POST", "/auth/dev", undefined, { email, name: email.split("@")[0] })).body as { token: string; user: { id: string } };
const d1 = () => deps.db.d1;

const bell = async (token: string) => (await call("GET", "/notifications", token)).body.items as Any[];
const answer = async (token: string, kind: string, approve: boolean) => {
  const n = (await bell(token)).find((x) => x.kind === kind && x.state === "pending");
  return call("POST", `/notifications/${n.id}/answer`, token, { approve });
};
const orgNames = async (token: string) => ((await call("GET", "/orgs", token)).body.orgs as Any[]).map((o) => o.name);

/** Acme: admin Alice, a closed team "Design" with a folder and a file */
async function acme() {
  const alice = await signIn("alice@x.co");
  const org = (await call("POST", "/orgs", alice.token, { name: "Acme" })).body.org;
  const team = (await call("POST", `/orgs/${org.id}/teams`, alice.token, { name: "Design", orgAccess: "none" })).body.team;
  const folder = (await call("POST", `/teams/${team.id}/projects`, alice.token, { name: "Web" })).body.project;
  const file = (await call("POST", `/projects/${folder.id}/files`, alice.token, { key: "file_web001", name: "Home" })).body.file;
  return { alice, org, team, file };
}

describe("Invitations (§14.18)", () => {
  it("Add people waits for the person's Accept: no org, no access until then", async () => {
    const { alice, org } = await acme();
    const bob = await signIn("bob@x.co");
    const added = (await call("POST", `/orgs/${org.id}/admin/people`, alice.token, { emails: ["bob@x.co"], role: "member", seat: "full" })).body.people;
    expect(added.map((p: Any) => [p.email, p.pending])).toEqual([["bob@x.co", true]]);
    expect(await orgNames(bob.token)).toEqual([]);
    expect((await call("GET", `/orgs/${org.id}`, bob.token)).status).toBe(404);
    const invite = (await bell(bob.token)).find((n) => n.kind === "org_invite");
    expect(invite).toMatchObject({ state: "pending", fileName: "Acme", actor: { id: alice.user.id } });
    expect((await call("GET", "/notifications?filter=requests", bob.token)).body.pending).toBe(1);
    await answer(bob.token, "org_invite", true);
    expect(await orgNames(bob.token)).toEqual(["Acme"]);
    expect((await bell(bob.token)).find((n) => n.kind === "org_invite").state).toBe("approved");
    const me = (await call("GET", `/orgs/${org.id}/admin/people`, alice.token)).body.items.find((p: Any) => p.email === "bob@x.co");
    expect(me).toMatchObject({ id: bob.user.id, pending: false, seat: "full" });
    const logged = (await d1().prepare(`SELECT action FROM activity_log WHERE org_id = ?1 AND action IN ('org_invite_create', 'org_user_create') ORDER BY id`).bind(org.id).all<{ action: string }>()).results.map((r) => r.action);
    expect(logged).toEqual(["org_user_create", "org_invite_create", "org_user_create"]);
  });

  it("Decline drops the invite; the admin can invite again", async () => {
    const { alice, org } = await acme();
    const bob = await signIn("bob@x.co");
    await call("POST", `/orgs/${org.id}/admin/people`, alice.token, { emails: ["bob@x.co"], role: "member" });
    await answer(bob.token, "org_invite", false);
    expect(await orgNames(bob.token)).toEqual([]);
    expect((await bell(bob.token)).find((n) => n.kind === "org_invite").state).toBe("denied");
    expect((await call("GET", `/orgs/${org.id}/admin/people`, alice.token)).body.items.map((p: Any) => p.email)).toEqual(["alice@x.co"]);
    await call("POST", `/orgs/${org.id}/admin/people`, alice.token, { emails: ["bob@x.co"], role: "member" });
    await answer(bob.token, "org_invite", true);
    expect(await orgNames(bob.token)).toEqual(["Acme"]);
  });

  it("someone without an account is told when they sign up, and only then", async () => {
    const { alice, org } = await acme();
    await call("POST", `/orgs/${org.id}/admin/people`, alice.token, { emails: ["carol@x.co"], role: "member" });
    const carol = await signIn("carol@x.co");
    expect(await orgNames(carol.token)).toEqual([]);
    await signIn("carol@x.co");
    expect((await bell(carol.token)).filter((n) => n.kind === "org_invite")).toHaveLength(1);
    await answer(carol.token, "org_invite", true);
    expect(await orgNames(carol.token)).toEqual(["Acme"]);
  });

  it("a team's invite waits too; declining it keeps someone in the org out of that team only", async () => {
    const { alice, org, team, file } = await acme();
    const bob = await signIn("bob@x.co");
    await call("POST", `/orgs/${org.id}/admin/people`, alice.token, { emails: ["bob@x.co"], role: "member", seat: "full" });
    await answer(bob.token, "org_invite", true);
    await call("PUT", `/teams/${team.id}/members`, alice.token, { email: "bob@x.co", role: "editor" });
    expect((await call("GET", `/teams/${team.id}/members`, alice.token)).body.members.map((m: Any) => [m.email, !!m.pending])).toEqual([["alice@x.co", false], ["bob@x.co", true]]);
    expect((await call("GET", `/files/${file.key}`, bob.token)).status).toBe(404);
    expect((await call("GET", `/orgs/${org.id}/teams?filter=mine`, bob.token)).body.teams).toEqual([]);
    await answer(bob.token, "team_invite", true);
    expect((await call("GET", `/files/${file.key}`, bob.token)).body.access.canEdit).toBe(true);
    // Another team, declined: Bob stays in the org and in Design
    const other = (await call("POST", `/orgs/${org.id}/teams`, alice.token, { name: "Brand", orgAccess: "none" })).body.team;
    await call("PUT", `/teams/${other.id}/members`, alice.token, { email: "bob@x.co", role: "viewer" });
    await answer(bob.token, "team_invite", false);
    expect(await orgNames(bob.token)).toEqual(["Acme"]);
    expect((await call("GET", `/orgs/${org.id}/teams?filter=mine`, bob.token)).body.teams.map((t: Any) => t.name)).toEqual(["Design"]);
    expect((await call("GET", `/teams/${other.id}/members`, alice.token)).body.members.map((m: Any) => m.email)).toEqual(["alice@x.co"]);
  });

  it("a team's invite to someone outside the org brings them in with it, once they accept", async () => {
    const { alice, team, file } = await acme();
    const dan = await signIn("dan@y.co");
    await call("PUT", `/teams/${team.id}/members`, alice.token, { email: "dan@y.co", role: "viewer" });
    expect(await orgNames(dan.token)).toEqual([]);
    expect((await bell(dan.token)).map((n) => n.kind)).toEqual(["team_invite"]);
    await answer(dan.token, "team_invite", true);
    expect(await orgNames(dan.token)).toEqual(["Acme"]);
    expect((await call("GET", `/files/${file.key}`, dan.token)).body.role).toBe("viewer");
  });

  it("a request to join a team is approved from the bell by its admins, not by others", async () => {
    const { alice, org, team, file } = await acme();
    const bob = await signIn("bob@x.co");
    await call("POST", `/orgs/${org.id}/admin/people`, alice.token, { emails: ["bob@x.co"], role: "member", seat: "full" });
    await answer(bob.token, "org_invite", true);
    expect((await call("POST", `/teams/${team.id}/join`, bob.token)).body.status).toBe("requested");
    expect((await answer(alice.token, "team_join_request", true)).status).toBe(200);
    expect((await bell(alice.token)).find((n) => n.kind === "team_join_request").state).toBe("approved");
    expect((await call("GET", `/files/${file.key}`, bob.token)).body.access.canEdit).toBe(true);
  });

  it("a new team is open to the organization, can edit, unless its creator says otherwise", async () => {
    const { alice, org } = await acme();
    const bob = await signIn("bob@x.co");
    await call("POST", `/orgs/${org.id}/admin/people`, alice.token, { emails: ["bob@x.co"], role: "member", seat: "full" });
    await answer(bob.token, "org_invite", true);
    const open = (await call("POST", `/orgs/${org.id}/teams`, alice.token, { name: "Open" })).body.team;
    expect([open.orgAccess, open.visibility]).toEqual(["editor", "visible"]);
    const folder = (await call("POST", `/teams/${open.id}/projects`, alice.token, { name: "Web" })).body.project;
    const file = (await call("POST", `/projects/${folder.id}/files`, alice.token, { key: "file_open01", name: "Open" })).body.file;
    expect((await call("GET", `/files/${file.key}`, bob.token)).body.access.canEdit).toBe(true);
    const hidden = (await call("POST", `/orgs/${org.id}/teams`, alice.token, { name: "Hidden", orgAccess: "none", visibility: "hidden" })).body.team;
    expect([hidden.orgAccess, hidden.visibility]).toEqual(["none", "hidden"]);
    expect((await call("POST", `/orgs/${org.id}/teams`, alice.token, { name: "Bad", orgAccess: "owner" })).status).toBe(400);
  });
});
