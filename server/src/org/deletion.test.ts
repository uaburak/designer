/**
 * Delete organization (docs/multiplayer.md §14.17): who may, the notices, the purge that deletes it for good at once and
 * releases what its people stored there, and the cron that finishes a purge cut short.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { handle, type Deps } from "../api";
import { Db } from "../db";
import { sqliteD1 } from "../testing/sqliteD1";
import { purgeDeletedOrgs } from "./deletion";

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
/** The invitee accepts what waits for them in the bell (docs/multiplayer.md §14.18) */
async function acceptInvites(token: string) {
  for (const n of (await call("GET", "/notifications?filter=requests", token)).body.items as Any[])
    if ((n.kind === "org_invite" || n.kind === "team_invite") && n.state === "pending") await call("POST", `/notifications/${n.id}/answer`, token, { approve: true });
}

const signIn = async (email: string) => (await call("POST", "/auth/dev", undefined, { email, name: email.split("@")[0] })).body as { token: string; user: { id: string } };
const d1 = () => deps.db.d1;
const count = async (sql: string, ...args: unknown[]) => (await d1().prepare(sql).bind(...args).first<{ n: number }>())!.n;

/** Acme: admin Alice, member Bob (Full seat, editor on the team), a team, a folder with a file, Bob's draft. */
async function acme() {
  const alice = await signIn("alice@x.co");
  const bob = await signIn("bob@x.co");
  const org = (await call("POST", "/orgs", alice.token, { name: "Acme" })).body.org;
  await call("POST", `/orgs/${org.id}/admin/people`, alice.token, { emails: ["bob@x.co"], role: "member", seat: "full" });
  const team = (await call("POST", `/orgs/${org.id}/teams`, alice.token, { name: "Design", orgAccess: "none" })).body.team;
  await call("PUT", `/teams/${team.id}/members`, alice.token, { email: "bob@x.co", role: "editor" });
  await acceptInvites(bob.token);
  const folder = (await call("POST", `/teams/${team.id}/projects`, alice.token, { name: "Web" })).body.project;
  const file = (await call("POST", `/projects/${folder.id}/files`, alice.token, { key: "file_web001", name: "Home" })).body.file;
  const draft = (await call("POST", `/orgs/${org.id}/drafts`, bob.token, { key: "file_bob001", name: "Sketch" })).body.file;
  return { alice, bob, org, team, folder, file, draft };
}

describe("Delete organization", () => {
  it("is for org admins, typing the organization's name", async () => {
    const { alice, bob, org } = await acme();
    expect((await call("DELETE", `/orgs/${org.id}`, bob.token, { confirmName: "Acme" })).status).toBe(403);
    expect((await call("DELETE", `/orgs/${org.id}`, alice.token, { confirmName: "acme" })).status).toBe(400);
    expect((await call("DELETE", `/orgs/${org.id}`, alice.token, {})).status).toBe(400);
    expect((await call("DELETE", `/orgs/${org.id}`, alice.token, { confirmName: "Acme" })).status).toBe(204);
    expect((await call("DELETE", `/orgs/${org.id}`, alice.token, { confirmName: "Acme" })).status).toBe(404);
    expect((await call("POST", `/orgs/${org.id}/restore`, alice.token)).status).toBe(404);
  });

  it("tells its people (a bell row that outlives the org) and refreshes their spaces", async () => {
    const { alice, bob, org } = await acme();
    inbox = [];
    await call("DELETE", `/orgs/${org.id}`, alice.token, { confirmName: "Acme" });
    const rows = (await d1().prepare(`SELECT user_id, kind, file_name, org_id FROM notifications WHERE kind = 'org_deleted'`).all()).results;
    expect(rows).toEqual([{ user_id: bob.user.id, kind: "org_deleted", file_name: "Acme", org_id: null }]);
    const notices = inbox.filter((i) => i.msg.t === "org" && i.msg.what === "orgs").map((i) => i.userId);
    expect(new Set(notices)).toEqual(new Set([alice.user.id, bob.user.id]));
  });

  it("deletes it for good at once and releases its people's stored bytes", async () => {
    const { alice, bob, org, team, folder, file, draft } = await acme();
    const other = (await call("POST", "/orgs", alice.token, { name: "Other" })).body.org;
    // What Alice and Bob stored: the files' snapshots, a library's bytes, an org font; the server's running total
    const items: [string, string, number][] = [
      [`f:${file.key}:snap`, alice.user.id, 1000],
      [`l:${file.key}:b:abc`, alice.user.id, 200],
      [`f:${draft.key}:snap`, bob.user.id, 500],
      [`o:${org.id}:font:def`, alice.user.id, 300],
      [`o:${other.id}:icon:123`, alice.user.id, 40],
    ];
    for (const [item, owner, bytes] of items) {
      await d1().prepare(`INSERT INTO stored_items (item, owner_id, bytes) VALUES (?1, ?2, ?3)`).bind(item, owner, bytes).run();
      await d1().prepare(`UPDATE users SET stored_bytes = stored_bytes + ?2 WHERE id = ?1`).bind(owner, bytes).run();
    }
    await d1().prepare(`INSERT INTO quota_counters (subject, kind, window, n) VALUES ('*', 'server_storage_bytes', 0, 2040)`).run();
    rooms = [];
    expect((await call("DELETE", `/orgs/${org.id}`, alice.token, { confirmName: "Acme" })).status).toBe(204);
    expect(await count(`SELECT COUNT(*) AS n FROM orgs WHERE id = ?1`, org.id)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM files WHERE org_id = ?1 OR key IN (?2, ?3)`, org.id, file.key, draft.key)).toBe(0);
    for (const t of ["teams", "org_members", "activity_log"]) expect(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE org_id = ?1`, org.id), t).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM projects`)).toBe(0);
    expect(rooms.filter((r) => r.path === "/room" && r.method === "DELETE").map((r) => r.key).sort()).toEqual([draft.key, file.key].sort());
    // Gone for everyone, its admins too
    expect((await call("GET", "/orgs", bob.token)).body.orgs).toEqual([]);
    expect((await call("GET", "/orgs", alice.token)).body.orgs.map((o: Any) => o.name)).toEqual(["Other"]);
    expect((await call("GET", `/teams/${team.id}`, bob.token)).status).toBe(404);
    expect((await call("GET", `/projects/${folder.id}`, bob.token)).status).toBe(404);
    expect((await call("GET", `/files/${file.key}`, bob.token)).status).toBe(404);
    // Quotas: what was stored in it is released; the other org's icon stays
    expect(await count(`SELECT stored_bytes AS n FROM users WHERE id = ?1`, alice.user.id)).toBe(40);
    expect(await count(`SELECT stored_bytes AS n FROM users WHERE id = ?1`, bob.user.id)).toBe(0);
    expect(await count(`SELECT n FROM quota_counters WHERE subject = '*' AND kind = 'server_storage_bytes'`)).toBe(40);
    expect((await d1().prepare(`SELECT item FROM stored_items`).all<{ item: string }>()).results.map((r) => r.item)).toEqual([`o:${other.id}:icon:123`]);
    // The org no longer counts against its creator's organizations; Bob's bell still says it was deleted
    expect(await count(`SELECT COUNT(*) AS n FROM orgs WHERE created_by = ?1`, alice.user.id)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?1 AND kind = 'org_deleted'`, bob.user.id)).toBe(1);
  });

  it("the cron finishes an org left deleted but not purged (and those from before purges were immediate)", async () => {
    const { bob, org, file } = await acme();
    await d1().prepare(`UPDATE orgs SET deleted_at = ?2, purge_at = ?3 WHERE id = ?1`).bind(org.id, now, now + 14 * 86_400_000).run();
    expect((await call("GET", "/orgs", bob.token)).body.orgs).toEqual([]);
    expect(await purgeDeletedOrgs(deps)).toEqual([org.id]);
    expect(await count(`SELECT COUNT(*) AS n FROM orgs WHERE id = ?1`, org.id)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM files WHERE key = ?1`, file.key)).toBe(0);
    expect(await purgeDeletedOrgs(deps)).toEqual([]);
  });
});

describe("Drafts in the trash", () => {
  it("lists the caller's trashed drafts (to restore or delete forever)", async () => {
    const { alice, bob, org, draft } = await acme();
    expect((await call("POST", `/files/${draft.key}/trash`, bob.token)).status).toBe(200);
    expect((await call("GET", `/orgs/${org.id}/drafts`, bob.token)).body.files).toEqual([]);
    const trashed = (await call("GET", `/orgs/${org.id}/drafts?trashed=1`, bob.token)).body.files;
    expect(trashed.map((f: Any) => [f.key, f.trashedAt !== null])).toEqual([[draft.key, true]]);
    expect((await call("GET", `/orgs/${org.id}/drafts?trashed=1`, alice.token)).body.files).toEqual([]);
    expect((await call("DELETE", `/files/${draft.key}`, bob.token)).status).toBe(200);
    expect((await call("GET", `/orgs/${org.id}/drafts?trashed=1`, bob.token)).body.files).toEqual([]);
  });
});
