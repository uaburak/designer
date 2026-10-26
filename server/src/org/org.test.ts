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

/** The invitee accepts what waits for them in the bell (docs/multiplayer.md §14.18) */
async function acceptInvites(token: string) {
  for (const n of (await call("GET", "/notifications?filter=requests", token)).body.items as Any[])
    if ((n.kind === "org_invite" || n.kind === "team_invite") && n.state === "pending") await call("POST", `/notifications/${n.id}/answer`, token, { approve: true });
}

const d1 = () => deps.db.d1;
const reauths = () => rooms.filter((r) => r.path === "/room/reauth");
const actions = async (orgId: string) => (await d1().prepare(`SELECT action FROM activity_log WHERE org_id = ?1 ORDER BY id`).bind(orgId).all<{ action: string }>()).results.map((r) => r.action);

/** An org (no import) with a team "Design", a folder "Web" and a file in it, made by its admin Alice; Bob a member on View. */
async function acme() {
  const alice = await signIn("alice@x.co");
  const bob = await signIn("bob@x.co");
  const org = (await call("POST", "/orgs", alice.token, { name: "Acme" })).body.org;
  await call("POST", `/orgs/${org.id}/admin/people`, alice.token, { emails: ["bob@x.co"], role: "member" });
  await acceptInvites(bob.token);
  const team = (await call("POST", `/orgs/${org.id}/teams`, alice.token, { name: "Design", orgAccess: "none" })).body.team;
  const folder = (await call("POST", `/teams/${team.id}/projects`, alice.token, { name: "Web" })).body.project;
  const file = (await call("POST", `/projects/${folder.id}/files`, alice.token, { key: "file_web001", name: "Home" })).body.file;
  return { alice, bob, org, team, folder, file };
}

describe("Create organization (§14.8)", () => {
  it("imports the caller's shared files into a team's 'Shared files', people as members (Full if they edited)", async () => {
    const alice = await signIn("alice@x.co");
    const bob = await signIn("bob@x.co");
    const dan = await signIn("dan@x.co");
    await call("POST", "/files", alice.token, { key: "file_a00001", name: "A" });
    await call("POST", "/files", alice.token, { key: "file_a00002", name: "B" });
    await call("PUT", "/files/file_a00001/members", alice.token, { email: "bob@x.co", role: "editor" });
    await call("PUT", "/files/file_a00002/members", alice.token, { email: "carol@x.co", role: "viewer" });
    await call("POST", "/files", dan.token, { key: "file_d00001", name: "Dan's" });
    await call("PUT", "/files/file_d00001/members", dan.token, { email: "alice@x.co", role: "editor" });

    const r = await call("POST", "/orgs", alice.token, { name: "Acme", importSharedFiles: true });
    expect(r.status).toBe(201);
    const org = r.body.org;
    expect(org).toMatchObject({ name: "Acme", role: "admin", seat: "full", counts: { members: 3, guests: 0, teams: 1 } });
    expect((await call("GET", "/orgs", alice.token)).body.orgs).toEqual([{ id: org.id, name: "Acme", iconUrl: null, role: "admin", seat: "full", workspaceId: null }]);
    const teams = (await call("GET", `/orgs/${org.id}/teams`, alice.token)).body.teams;
    expect(teams.map((t: Any) => [t.name, t.orgAccess, t.visibility, t.me.owner])).toEqual([["Acme", "none", "visible", true]]);
    const folders = (await call("GET", `/teams/${teams[0].id}/projects`, alice.token)).body.projects;
    expect(folders.map((p: Any) => [p.name, p.access, p.fileCount])).toEqual([["Shared files", "inherited", 2]]);
    // Dan's file stays his, outside the org
    expect((await d1().prepare(`SELECT org_id FROM files WHERE key = 'file_d00001'`).first<{ org_id: string | null }>())?.org_id).toBeNull();
    // Bob, who could edit, is a member on Full; Carol (pending) on View; nobody lost access
    expect((await call("GET", "/orgs", bob.token)).body.orgs).toMatchObject([{ role: "member", seat: "full" }]);
    expect((await call("GET", "/files/file_a00001", bob.token)).body).toMatchObject({ role: "editor", access: { canEdit: true, via: ["file"] }, org: { id: org.id, name: "Acme", teamName: "Acme", path: [{ name: "Shared files" }] } });
    const carol = await signIn("carol@x.co");
    expect((await call("GET", "/orgs", carol.token)).body.orgs).toMatchObject([{ role: "member", seat: "view" }]);
    expect((await call("GET", "/files/file_a00002", carol.token)).body.role).toBe("viewer");
    const logged = await actions(org.id);
    expect(logged).toEqual(expect.arrayContaining(["org_user_create", "team_create", "project_create", "fig_file_move", "org_invite_create"]));
    const migrated = await d1().prepare(`SELECT COUNT(*) AS n FROM activity_log WHERE org_id = ?1 AND json_extract(details, '$.migrated') = 1`).bind(org.id).first<{ n: number }>();
    expect(migrated?.n).toBe(logged.filter((a) => a !== "user_sign_in").length);
    // Without the import: just the org, and several per person
    const second = (await call("POST", "/orgs", alice.token, { name: "Side" })).body.org;
    expect(second.counts).toEqual({ members: 1, guests: 0, teams: 0 });
    expect((await call("GET", "/orgs", alice.token)).body.orgs.map((o: Any) => o.name)).toEqual(["Acme", "Side"]);
  });
});

describe("teams (§14.12)", () => {
  it("creates, lists, joins, requests, manages members, transfers, deletes and restores", async () => {
    const { alice, bob, org, team, file } = await acme();
    const carol = await signIn("carol@x.co");
    await call("POST", `/orgs/${org.id}/admin/people`, alice.token, { emails: ["carol@x.co"], role: "member" });
    await acceptInvites(carol.token);
    expect((await call("POST", `/orgs/${org.id}/teams`, alice.token, { name: "design" })).body.code).toBe("conflict");
    // Bob browses: the Visible team is there, not his; the file isn't open to him
    expect((await call("GET", `/orgs/${org.id}/teams?filter=mine`, bob.token)).body.teams).toEqual([]);
    expect((await call("GET", `/orgs/${org.id}/teams?filter=browse`, bob.token)).body.teams.map((t: Any) => [t.name, t.me])).toEqual([["Design", null]]);
    expect((await call("GET", `/files/${file.key}`, bob.token)).status).toBe(404);
    // Only those invited, Visible: he asks to join; the admins are told; Alice approves
    expect((await call("POST", `/teams/${team.id}/join`, bob.token)).body).toEqual({ status: "requested" });
    const n = await d1().prepare(`SELECT kind, state, org_id, team_id, file_key FROM notifications WHERE user_id = ?1`).bind(alice.user.id).first<Any>();
    expect(n).toEqual({ kind: "team_join_request", state: "pending", org_id: org.id, team_id: team.id, file_key: null });
    expect((await call("GET", `/notifications?filter=requests&org=${org.id}`, alice.token)).body.pending).toBe(1);
    expect((await call("GET", `/teams/${team.id}/requests`, alice.token)).body.requests.map((r: Any) => r.person.email)).toEqual(["bob@x.co"]);
    await call("POST", `/teams/${team.id}/requests/${bob.user.id}`, alice.token, { approve: true });
    expect((await call("GET", `/files/${file.key}`, bob.token)).body).toMatchObject({ role: "viewer", access: { role: "editor", canEdit: false, capped: "seat" } });
    // Org access "can view": Carol joins at once
    await call("PATCH", `/teams/${team.id}`, alice.token, { orgAccess: "viewer" });
    expect((await call("POST", `/teams/${team.id}/join`, carol.token)).body).toEqual({ status: "joined" });
    // Members: the owner first; Bob made admin; a group; Carol lowered then removed
    await call("PATCH", `/teams/${team.id}/members/u:${bob.user.id}`, alice.token, { admin: true });
    const members = (await call("GET", `/teams/${team.id}/members`, bob.token)).body.members;
    expect(members.map((x: Any) => [x.email, x.role, x.admin, x.owner])).toEqual([
      ["alice@x.co", "editor", true, true],
      ["bob@x.co", "editor", true, false],
      ["carol@x.co", "viewer", false, false],
    ]);
    rooms.length = 0;
    expect((await call("DELETE", `/teams/${team.id}/members/u:${carol.user.id}`, carol.token)).status).toBe(200);
    expect(reauths()).toEqual([{ key: file.key, path: "/room/reauth", body: { userIds: [carol.user.id] }, identity: undefined }]);
    expect((await call("DELETE", `/teams/${team.id}/members/u:${alice.user.id}`, bob.token)).body.code).toBe("conflict");
    // Visibility, transfer
    await call("PATCH", `/teams/${team.id}`, alice.token, { visibility: "hidden", orgAccess: "none", name: "Design system", description: "All of it" });
    expect((await call("GET", `/orgs/${org.id}/teams?filter=browse`, carol.token)).body.teams).toEqual([]);
    expect((await call("GET", `/teams/${team.id}`, carol.token)).status).toBe(404);
    expect((await call("POST", `/teams/${team.id}/transfer`, bob.token, { userId: bob.user.id })).status).toBe(403);
    expect((await call("POST", `/teams/${team.id}/transfer`, alice.token, { userId: carol.user.id })).body.code).toBe("conflict");
    expect((await call("POST", `/teams/${team.id}/transfer`, alice.token, { userId: bob.user.id })).body.team.ownerId).toBe(bob.user.id);
    // Deleted: only admins see it; its files close
    rooms.length = 0;
    expect((await call("DELETE", `/teams/${team.id}`, bob.token)).status).toBe(204);
    expect(reauths().map((r) => r.body)).toEqual([{}]);
    expect((await call("GET", `/files/${file.key}`, bob.token)).status).toBe(404);
    expect((await call("GET", `/files/${file.key}`, alice.token)).body.access.via).toContain("org-admin");
    expect((await call("POST", `/teams/${team.id}/restore`, alice.token)).body.team.deletedAt).toBeNull();
    expect(await actions(org.id)).toEqual(
      expect.arrayContaining(["team_create", "team_member_add", "team_member_permission_change", "team_member_remove", "team_org_access_change", "team_sharing_audience_control_change", "team_rename", "team_delete", "team_restore"]),
    );
  });

  it("restricts team creation to admins when the org says so; guests can't create", async () => {
    const { alice, bob, org } = await acme();
    await call("PATCH", `/orgs/${org.id}/admin/settings`, alice.token, { teamCreation: "admins" });
    expect((await call("POST", `/orgs/${org.id}/teams`, bob.token, { name: "Mine" })).body.code).toBe("admins_only");
    expect(await actions(org.id)).toContain("org_team_creation_controls");
  });
});

describe("folders (§14.12)", () => {
  it("nest ≤ 10, Limited stops the audience, move, trash, restore, delete forever, members", async () => {
    const { alice, bob, org, team, folder, file } = await acme();
    await call("PATCH", `/teams/${team.id}`, alice.token, { orgAccess: "editor" });
    expect((await call("GET", `/files/${file.key}`, bob.token)).body.access).toMatchObject({ role: "editor", via: ["audience"] });
    // Nesting
    let parent = folder.id;
    for (let i = 2; i <= 10; i++) parent = (await call("POST", `/teams/${team.id}/projects`, alice.token, { name: `L${i}`, parentId: parent })).body.project.id;
    expect((await call("GET", `/projects/${parent}`, alice.token)).body.project).toMatchObject({ depth: 10, path: expect.arrayContaining([{ id: folder.id, name: "Web" }]) });
    expect((await call("POST", `/teams/${team.id}/projects`, alice.token, { name: "L11", parentId: parent })).body.code).toBe("conflict");
    // Limited: Bob (audience only) loses it; a folder grant gives it back
    rooms.length = 0;
    await call("PATCH", `/projects/${folder.id}`, alice.token, { access: "limited" });
    expect(reauths().map((r) => r.key)).toContain(file.key);
    expect((await call("GET", `/files/${file.key}`, bob.token)).status).toBe(404);
    expect((await call("GET", `/projects/${folder.id}`, bob.token)).status).toBe(404);
    await call("PUT", `/projects/${folder.id}/members`, alice.token, { email: "bob@x.co", role: "viewer" });
    expect((await call("GET", `/files/${file.key}`, bob.token)).body.access).toMatchObject({ role: "viewer", via: ["folder"] });
    const members = (await call("GET", `/projects/${folder.id}/members`, bob.token)).body.members;
    expect(members.map((x: Any) => [x.email, x.owner, x.inherited])).toEqual([
      ["alice@x.co", true, false],
      ["bob@x.co", false, false],
    ]);
    // Bob can't write the folder; Alice moves it under another
    expect((await call("PATCH", `/projects/${folder.id}`, bob.token, { name: "X" })).status).toBe(403);
    const other = (await call("POST", `/teams/${team.id}/projects`, alice.token, { name: "Other" })).body.project;
    expect((await call("POST", `/projects/${folder.id}/move`, alice.token, { teamId: team.id, parentId: parent })).body.code).toBe("conflict");
    // Ten levels under Web: nowhere deeper to go
    expect((await call("POST", `/projects/${folder.id}/move`, alice.token, { teamId: team.id, parentId: other.id })).body.code).toBe("conflict");
    expect((await call("POST", `/projects/${other.id}/move`, alice.token, { teamId: team.id, parentId: folder.id })).body.project).toMatchObject({ parentId: folder.id, depth: 2 });
    // Trash: Bob (viewer) loses it; Alice sees it in the team's trash; restore; delete only from the trash
    expect((await call("DELETE", `/projects/${folder.id}`, alice.token)).body.code).toBe("conflict");
    await call("POST", `/projects/${folder.id}/trash`, alice.token);
    expect((await call("GET", `/files/${file.key}`, bob.token)).status).toBe(404);
    const trash = (await call("GET", `/teams/${team.id}/trash`, alice.token)).body;
    expect([trash.projects.map((p: Any) => p.name), trash.files]).toEqual([["Web"], []]);
    expect((await call("POST", `/projects/${folder.id}/restore`, alice.token)).body.project.trashedAt).toBeNull();
    await call("POST", `/projects/${folder.id}/trash`, alice.token);
    rooms.length = 0;
    expect((await call("DELETE", `/projects/${folder.id}`, alice.token)).status).toBe(204);
    expect(rooms.filter((r) => r.path === "/room").map((r) => r.key)).toEqual([file.key]);
    expect(await d1().prepare(`SELECT key FROM files WHERE key = ?1`).bind(file.key).first()).toBeNull();
    expect(await actions(org.id)).toEqual(expect.arrayContaining(["project_create", "project_team_access_change", "project_member_add", "project_move", "project_trash", "project_restore", "project_delete"]));
  });
});

describe("files in an org (§14.12 'Files')", () => {
  it("POST /files with an org, seats, move, trash / restore / delete forever, link settings, exports, views", async () => {
    const { alice, bob, org, team, folder, file } = await acme();
    // Drafts: POST /files {orgId} with no folder; only the owner sees them, admins included
    const draft = await call("POST", "/files", alice.token, { key: "file_draft1", name: "Scratch", orgId: org.id });
    expect(draft.body.file).toMatchObject({ orgId: org.id, projectId: null, teamId: null, access: { role: "owner" } });
    expect((await call("GET", `/orgs/${org.id}/drafts`, alice.token)).body.files.map((f: Any) => f.key)).toEqual(["file_draft1"]);
    // Bob on View can't create a design file — even a draft
    const refused = await call("POST", `/orgs/${org.id}/drafts`, bob.token, { key: "file_bob001", name: "B" });
    expect(refused).toMatchObject({ status: 403, body: { code: "seat_required", seat: "full", current: "view" } });
    expect((await call("POST", `/orgs/${org.id}/drafts`, bob.token, { key: "file_bob001", name: "Board", editorType: "figjam" })).status).toBe(403);
    await call("PATCH", `/orgs/${org.id}/admin/people`, alice.token, { userIds: [bob.user.id], seat: "collab" });
    expect((await call("POST", `/orgs/${org.id}/drafts`, bob.token, { key: "file_bob001", name: "Board", editorType: "figjam" })).body.file.editorType).toBe("figjam");
    expect((await call("GET", "/files/file_bob001", alice.token)).status).toBe(404);
    // Move a legacy file in (Move to… across spaces)
    await call("POST", "/files", alice.token, { key: "file_local1", name: "Local" });
    expect((await call("POST", "/files", alice.token, { key: "file_local1", name: "Local", orgId: org.id, projectId: folder.id })).body.file).toMatchObject({ projectId: folder.id, teamId: team.id });
    // Within the org
    const other = (await call("POST", `/teams/${team.id}/projects`, alice.token, { name: "App" })).body.project;
    rooms.length = 0;
    expect((await call("POST", `/files/${file.key}/move`, alice.token, { projectId: other.id })).status).toBe(200);
    expect(reauths().map((r) => r.key)).toEqual([file.key]);
    expect((await call("GET", `/projects/${other.id}/files`, alice.token)).body.files.map((f: Any) => f.key)).toEqual([file.key]);
    await call("POST", `/files/${file.key}/move`, alice.token, { projectId: null });
    expect((await call("GET", `/orgs/${org.id}/drafts`, alice.token)).body.files.map((f: Any) => f.key)).toContain(file.key);
    await call("POST", `/files/${file.key}/move`, alice.token, { projectId: folder.id });
    // Trash and restore; delete forever only from the trash
    expect((await call("DELETE", `/files/${file.key}`, alice.token)).body.code).toBe("conflict");
    await call("POST", `/files/${file.key}/trash`, alice.token);
    expect((await call("GET", `/files/${file.key}`, alice.token)).body).toMatchObject({ role: "viewer", access: { role: "owner", canEdit: false } });
    expect((await call("GET", `/teams/${team.id}/trash`, alice.token)).body.files.map((f: Any) => f.key)).toEqual([file.key]);
    await call("POST", `/files/${file.key}/restore`, alice.token);
    // Link settings: the org link, an expiry, viewers can't copy
    await call("PATCH", `/files/${file.key}`, alice.token, { orgLinkAccess: "viewer", viewersCanCopy: false });
    expect((await call("GET", `/files/${file.key}`, bob.token)).body.access).toMatchObject({ role: "viewer", via: ["audience"], canExport: false });
    expect((await call("GET", `/files/${file.key}/snapshot?purpose=export`, bob.token)).status).toBe(403);
    expect((await call("GET", `/files/${file.key}/snapshot`, bob.token)).status).toBe(200);
    expect((await call("POST", `/files/${file.key}/activity`, bob.token, { action: "fig_file_export", details: { format: "png" } })).status).toBe(403);
    expect((await call("PATCH", `/files/${file.key}`, alice.token, { linkExpiresAt: now - 1 })).status).toBe(400);
    await call("PATCH", `/files/${file.key}`, alice.token, { linkExpiresAt: now + 60_000 });
    now += 120_000;
    expect((await call("GET", `/files/${file.key}`, bob.token)).body.code).toBe("gone");
    expect((await call("GET", `/files/${file.key}`, alice.token)).body).toMatchObject({ linkExpired: true });
    // Client-reported events
    expect((await call("POST", `/files/${file.key}/activity`, alice.token, { action: "fig_file_export", details: { format: "png", count: 2 } })).status).toBe(204);
    expect((await call("POST", `/files/${file.key}/activity`, alice.token, { action: "fig_file_delete" })).status).toBe(400);
    const exported = await d1().prepare(`SELECT details FROM activity_log WHERE action = 'fig_file_export'`).first<{ details: string }>();
    expect(JSON.parse(exported!.details)).toEqual({ format: "png", count: 2, client_reported: true });
    // A socket: the room gets the role after caps; fig_file_view at most hourly
    await call("PATCH", `/files/${file.key}`, alice.token, { linkExpiresAt: null });
    await call("PUT", `/files/${file.key}/members`, alice.token, { email: "bob@x.co", role: "editor" });
    for (let i = 0; i < 2; i++) await call("GET", `/files/${file.key}/ws`, bob.token, undefined, { upgrade: "websocket" });
    expect(rooms.filter((r) => r.path === "/room/ws").map((r) => r.identity?.role)).toEqual(["viewer", "viewer"]);
    expect((await call("PUT", `/files/${file.key}/snapshot?seq=1`, bob.token)).body.code).toBe("seat_required");
    expect((await actions(org.id)).filter((a) => a === "fig_file_view")).toHaveLength(1);
    // Delete forever
    await call("POST", `/files/${file.key}/trash`, alice.token);
    expect((await call("DELETE", `/files/${file.key}`, alice.token)).status).toBe(200);
    expect(await actions(org.id)).toEqual(
      expect.arrayContaining(["fig_file_create", "fig_file_move", "fig_file_trash", "fig_file_restore", "fig_file_link_access_change", "fig_file_viewer_access_change", "fig_file_link_expiration_change", "fig_file_member_add", "fig_file_permanent_delete", "org_user_account_type_change"]),
    );
    // Files outside any org are not logged
    expect(await d1().prepare(`SELECT COUNT(*) AS n FROM activity_log WHERE entity_id = 'file_local1' AND action = 'fig_file_create'`).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("an outside email invited by a member becomes a guest — or waits for an admin, or is blocked", async () => {
    const { alice, bob, org, folder, file } = await acme();
    await call("PATCH", `/orgs/${org.id}/admin/people`, alice.token, { userIds: [bob.user.id], seat: "full" });
    await call("PUT", `/projects/${folder.id}/members`, alice.token, { email: "bob@x.co", role: "editor" });
    expect((await call("PUT", `/files/${file.key}/members`, bob.token, { email: "gus@y.co", role: "viewer" })).status).toBe(200);
    expect((await call("GET", `/orgs/${org.id}/admin/people?role=guest`, alice.token)).body.items.map((p: Any) => p.email)).toEqual(["gus@y.co"]);
    const gus = await signIn("gus@y.co");
    expect((await call("GET", `/files/${file.key}`, gus.token)).body.access.via).toEqual(["file"]);
    expect((await call("GET", `/orgs/${org.id}/teams?filter=browse`, gus.token)).body.teams).toEqual([]);
    // Require admin approval
    await call("PATCH", `/orgs/${org.id}/admin/settings`, alice.token, { guestMembership: "approval" });
    const held = await call("PUT", `/files/${file.key}/members`, bob.token, { email: "hal@y.co", role: "editor" });
    expect(held).toMatchObject({ status: 202, body: { requested: true } });
    const reqs = (await call("GET", `/orgs/${org.id}/admin/guest-requests`, alice.token)).body.requests;
    expect(reqs.map((r: Any) => [r.email, r.resource.type, r.resource.name, r.invitedBy.email])).toEqual([["hal@y.co", "file", "Home", "bob@x.co"]]);
    await call("POST", `/orgs/${org.id}/admin/guest-requests/${reqs[0].id}`, alice.token, { approve: true });
    const hal = await signIn("hal@y.co");
    expect((await call("GET", `/files/${file.key}`, hal.token)).body.access.role).toBe("editor");
    // Block
    await call("PATCH", `/orgs/${org.id}/admin/settings`, alice.token, { guestMembership: "block" });
    expect((await call("PUT", `/files/${file.key}/members`, bob.token, { email: "ivy@y.co", role: "viewer" })).body.code).toBe("guest_blocked");
    expect(await actions(org.id)).toEqual(expect.arrayContaining(["org_invite_create", "org_guest_invite_setting_change", "org_join_request_approve"]));
  });
});

describe("user groups (§14.1)", () => {
  it("are created, granted on a folder, and their membership changes re-check rooms", async () => {
    const { alice, bob, org, folder, file } = await acme();
    const g = (await call("POST", `/orgs/${org.id}/groups`, bob.token, { name: "Design", userIds: [bob.user.id] })).body.group;
    expect(g).toMatchObject({ name: "Design", memberCount: 1, canManage: true, external: false });
    expect((await call("POST", `/orgs/${org.id}/groups`, alice.token, { name: "design" })).body.code).toBe("conflict");
    await call("PUT", `/projects/${folder.id}/members`, alice.token, { groupId: g.id, role: "viewer" });
    expect((await call("GET", `/files/${file.key}`, bob.token)).body.access.via).toEqual(["folder"]);
    rooms.length = 0;
    await call("POST", `/groups/${g.id}/members`, alice.token, { remove: [bob.user.id] });
    expect(reauths().every((r) => JSON.stringify(r.body) === JSON.stringify({ userIds: [bob.user.id] }))).toBe(true);
    expect((await call("GET", `/files/${file.key}`, bob.token)).status).toBe(404);
    expect((await call("PATCH", `/groups/${g.id}`, alice.token, { name: "Brand" })).body.group.name).toBe("Brand");
    expect((await call("GET", `/orgs/${org.id}/people?text=bo`, alice.token)).body).toMatchObject({ people: [{ email: "bob@x.co" }], groups: [] });
    expect((await call("GET", `/orgs/${org.id}/groups`, alice.token)).body.groups.map((x: Any) => x.name)).toEqual(["Brand"]);
    await call("PATCH", `/orgs/${org.id}/admin/settings`, alice.token, { groupCreation: "admins" });
    expect((await call("POST", `/orgs/${org.id}/groups`, bob.token, { name: "Mine" })).body.code).toBe("admins_only");
    expect((await call("DELETE", `/groups/${g.id}`, alice.token)).status).toBe(204);
    expect(await actions(org.id)).toEqual(expect.arrayContaining(["user_group_create", "user_group_member_add", "user_group_member_remove", "user_group_rename", "user_group_delete", "project_member_add"]));
  });
});

describe("Admin (§14.12)", () => {
  it("dashboard, people (filters, CSV, bulk), seat requests, workspaces with default teams, billing groups, activity, settings", async () => {
    const { alice, bob, org, team } = await acme();
    expect((await call("GET", `/orgs/${org.id}/admin/dashboard`, bob.token)).body.code).toBe("not_admin");
    expect((await call("GET", `/orgs/${org.id}/admin/dashboard`, alice.token)).body).toMatchObject({ members: 2, guests: 0, seats: { full: 1, view: 1 }, teams: 1 });
    // "Ask to upgrade", manual: the admins are told; approved
    await call("PATCH", `/orgs/${org.id}/admin/settings`, alice.token, { seatApproval: { full: "manual" } });
    const asked = (await call("POST", `/orgs/${org.id}/seat-requests`, bob.token, { seat: "full", note: "redesign" })).body.request;
    expect(asked).toMatchObject({ state: "pending", seat: "full", person: { email: "bob@x.co" } });
    expect((await call("GET", `/orgs/${org.id}/admin/seat-requests`, alice.token)).body.requests.map((r: Any) => r.id)).toEqual([asked.id]);
    expect((await call("POST", `/orgs/${org.id}/admin/seat-requests/${asked.id}`, alice.token, { approve: true })).body.request.state).toBe("approved");
    expect((await call("GET", "/orgs", bob.token)).body.orgs[0].seat).toBe("full");
    expect(await d1().prepare(`SELECT kind FROM notifications WHERE user_id = ?1 AND kind LIKE 'seat%'`).bind(bob.user.id).first()).toEqual({ kind: "seat_request_approved" });
    // Under Figma's default (unlimited seats): approved at once
    await call("PATCH", `/orgs/${org.id}/admin/settings`, alice.token, { seatApproval: { dev: "manual_unless_available" } });
    // People: filters and CSV
    await call("POST", `/orgs/${org.id}/admin/people`, alice.token, { emails: ["dan@x.co"], role: "member", seat: "dev" });
    expect((await call("GET", `/orgs/${org.id}/admin/people?seat=dev`, alice.token)).body).toMatchObject({ items: [{ email: "dan@x.co", pending: true }], total: 1, cursor: null });
    expect((await call("GET", `/orgs/${org.id}/admin/people?limit=1`, alice.token)).body.cursor).toBe("1");
    const roster = await call("GET", `/orgs/${org.id}/admin/people?format=csv`, alice.token);
    expect(roster.body).toContain("dan@x.co,,member,dev");
    // Workspaces: default teams take existing and new members; a workspace admin sees their people only
    const ws = (await call("POST", `/orgs/${org.id}/admin/workspaces`, alice.token, { name: "EU", adminIds: [bob.user.id] })).body.workspace;
    await call("PATCH", `/orgs/${org.id}/admin/workspaces/${ws.id}`, alice.token, { defaultTeamIds: [team.id], members: { add: [bob.user.id] } });
    expect((await call("GET", `/orgs/${org.id}/teams?filter=mine`, bob.token)).body.teams.map((t: Any) => t.name)).toEqual(["Design"]);
    expect((await call("GET", `/orgs/${org.id}/admin/people`, bob.token)).body.items.map((p: Any) => p.email)).toEqual(["bob@x.co"]);
    expect((await call("GET", `/orgs/${org.id}/admin/workspaces`, alice.token)).body.workspaces).toMatchObject([{ name: "EU", memberCount: 1, defaultTeamIds: [team.id], admins: [{ email: "bob@x.co" }] }]);
    expect((await call("DELETE", `/orgs/${org.id}/admin/workspaces/${ws.id}`, alice.token)).status).toBe(204);
    // Billing groups
    const bg = (await call("POST", `/orgs/${org.id}/admin/billing-groups`, alice.token, { name: "Marketing", adminIds: [alice.user.id] })).body.billingGroup;
    expect((await call("PATCH", `/orgs/${org.id}/admin/billing-groups/${bg.id}`, alice.token, { name: "Brand", members: { add: [bob.user.id] } })).body.billingGroup).toMatchObject({ name: "Brand", memberCount: 1 });
    expect((await call("GET", `/orgs/${org.id}/admin/billing-groups`, alice.token)).body.billingGroups.map((b: Any) => b.name)).toEqual(["Brand"]);
    expect((await call("DELETE", `/orgs/${org.id}/admin/billing-groups/${bg.id}`, alice.token)).status).toBe(204);
    // Teams (CSV), activity (filters, CSV)
    expect((await call("GET", `/orgs/${org.id}/admin/teams`, alice.token)).body.items).toMatchObject([{ name: "Design", ownerName: "alice", adminCount: 1, fileCount: 1 }]);
    expect((await call("GET", `/orgs/${org.id}/admin/teams?format=csv`, alice.token)).body).toContain("Design,alice");
    const page = (await call("GET", `/orgs/${org.id}/admin/activity?events=team_create,workspace_create&order=asc`, alice.token)).body;
    expect(page.activity_logs.map((l: Any) => [l.action.type, l.entity.type, l.entity.name])).toEqual([
      ["team_create", "team", "Design"],
      ["workspace_create", "workspace", "EU"],
    ]);
    expect(page.activity_logs[0]).toMatchObject({ actor: { type: "user", email: "alice@x.co" }, context: { org_id: org.id, team_id: team.id, is_figma_support_team_action: false }, timestamp: Math.floor(now / 1000) });
    const limited = (await call("GET", `/orgs/${org.id}/admin/activity?limit=2`, alice.token)).body;
    expect(limited).toMatchObject({ next_page: true });
    expect((await call("GET", `/orgs/${org.id}/admin/activity?limit=2&cursor=${limited.cursor}`, alice.token)).body.activity_logs[0].id).not.toBe(limited.activity_logs[0].id);
    expect((await call("GET", `/orgs/${org.id}/admin/activity?format=csv&email=alice@x.co`, alice.token)).body).toMatch(/^timestamp,actor_email/);
    expect(await actions(org.id)).toEqual(
      expect.arrayContaining(["org_user_account_type_upgrade_requested", "org_user_account_type_upgrade_approved", "org_user_account_type_change_to_full", "roster_exported", "workspace_admins_add", "workspace_member_add", "workspace_delete", "license_group_create", "license_group_rename", "license_group_membership_change", "license_group_delete", "org_team_csv_exported"]),
    );
    // The last admin stays
    expect((await call("PATCH", `/orgs/${org.id}/admin/people`, alice.token, { userIds: [alice.user.id], role: "member" })).body.code).toBe("conflict");
    expect((await call("DELETE", `/orgs/${org.id}/me`, alice.token)).body.code).toBe("conflict");
  });

  it("removing someone keeps their drafts as Unassigned drafts, which admins move into a team", async () => {
    const { alice, bob, org, team } = await acme();
    await call("PATCH", `/orgs/${org.id}/admin/people`, alice.token, { userIds: [bob.user.id], seat: "full" });
    await call("POST", `/orgs/${org.id}/drafts`, bob.token, { key: "file_bobd01", name: "Bob's draft" });
    expect((await call("GET", "/files/file_bobd01", alice.token)).status).toBe(404);
    rooms.length = 0;
    expect((await call("POST", `/orgs/${org.id}/admin/people/remove`, alice.token, { userIds: [bob.user.id] })).status).toBe(204);
    expect(reauths().map((r) => r.body)).toContainEqual({ userIds: [bob.user.id] });
    expect((await call("GET", "/orgs", bob.token)).body.orgs).toEqual([]);
    expect((await call("GET", "/files/file_bobd01", bob.token)).status).toBe(404);
    const owners = (await call("GET", `/orgs/${org.id}/admin/drafts`, alice.token)).body.owners;
    expect(owners).toMatchObject([{ owner: { id: bob.user.id, email: "bob@x.co", removedAt: now }, files: [{ key: "file_bobd01" }] }]);
    expect((await call("POST", `/orgs/${org.id}/admin/drafts/move`, alice.token, { ownerId: bob.user.id, to: { teamId: team.id } })).status).toBe(204);
    const folders = (await call("GET", `/teams/${team.id}/projects`, alice.token)).body.projects.map((p: Any) => p.name);
    expect(folders).toContain("bob");
    expect((await call("GET", `/orgs/${org.id}/admin/drafts`, alice.token)).body.owners).toEqual([]);
    expect(await actions(org.id)).toEqual(expect.arrayContaining(["org_user_delete", "fig_file_move"]));
  });
});

describe("sign-in, sessions and the account in orgs (§14.11, §14.7)", () => {
  it("logs sign-ins per org, moves Last active, and deletes an account leaving its org drafts", async () => {
    const { alice, bob, org } = await acme();
    await call("PATCH", `/orgs/${org.id}/admin/people`, alice.token, { userIds: [bob.user.id], seat: "full" });
    await signIn("bob@x.co");
    expect((await actions(org.id)).filter((a) => a === "user_sign_in").length).toBe(1);
    now += 10 * 60_000;
    await call("GET", "/orgs", bob.token);
    expect((await d1().prepare(`SELECT last_active_at FROM org_members WHERE user_id = ?1`).bind(bob.user.id).first<{ last_active_at: number }>())?.last_active_at).toBe(now);
    expect((await call("POST", "/me/sessions/active", bob.token)).status).toBe(200);
    await call("POST", `/orgs/${org.id}/drafts`, bob.token, { key: "file_bobd02", name: "Kept" });
    // The sole admin can't go; Bob can — his draft stays with the org
    expect((await call("DELETE", "/me", alice.token, { confirm: "alice@x.co" })).body.code).toBe("conflict");
    expect((await call("DELETE", "/me", bob.token, { confirm: "bob@x.co" })).status).toBe(200);
    expect(await d1().prepare(`SELECT key FROM files WHERE key = 'file_bobd02'`).first()).toEqual({ key: "file_bobd02" });
    expect((await call("GET", `/orgs/${org.id}/admin/drafts`, alice.token)).body.owners.map((o: Any) => o.owner.name)).toEqual(["Deleted user"]);
    expect((await call("GET", "/me", bob.token)).status).toBe(401);
  });

  it("tells people's apps through the inbox ({t: 'org', what, …})", async () => {
    const { alice, org, team } = await acme();
    inbox.length = 0;
    await call("PATCH", `/teams/${team.id}`, alice.token, { name: "Product" });
    expect(inbox).toContainEqual({ userId: alice.user.id, msg: { t: "org", what: "team", orgId: org.id, teamId: team.id } });
  });
});
