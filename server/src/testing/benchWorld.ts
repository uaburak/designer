/**
 * The CPU bench's world (server/src/testing/cpu.test.ts): a realistic organization on node:sqlite — 5 teams, 20 folders
 * (some nested), 200 files, 20 members, a few branches, team requests and file invites — with Governance+ on or off,
 * and the routes the apps call most (the ones Cloudflare's free plan, 10 ms of CPU per request, must always answer).
 *
 * D1's time is wall time on Cloudflare, not the Worker's CPU: the instrumented D1 here counts the time spent inside
 * node:sqlite so the bench can subtract it (and counts the queries — each one also costs the Worker a little CPU to
 * send and decode).
 */
import { handle, type Deps } from "../api";
import { Db, type D1Like, type D1Stmt } from "../db";
import { sqliteD1 } from "./sqliteD1";

const ORIGIN = "https://designer.example.workers.dev";

/** Time spent in node:sqlite (ms) and the number of statements run, since the last reset */
export interface D1Meter {
  ms: number;
  queries: number;
  /** The statements run (D1 round trips; a batch is one), when `log` is on */
  sql: string[];
  log: boolean;
  reset(): void;
}

/** node:sqlite D1 with a meter around every statement */
export function meteredD1(): { d1: D1Like; meter: D1Meter } {
  const inner = sqliteD1();
  const meter: D1Meter = {
    ms: 0,
    queries: 0,
    sql: [],
    log: false,
    reset() {
      this.ms = 0;
      this.queries = 0;
      this.sql = [];
    },
  };
  const timed = async <T>(f: () => Promise<T>, sql: string): Promise<T> => {
    if (meter.log) meter.sql.push(sql.replace(/\s+/g, " ").slice(0, 200));
    const t = performance.now();
    try {
      return await f();
    } finally {
      // node:sqlite is synchronous: everything between the two reads is SQLite's own work
      meter.ms += performance.now() - t;
      meter.queries++;
    }
  };
  const wrap = (s: D1Stmt, sql: string): D1Stmt & { inner: D1Stmt; sql: string } => ({
    inner: s,
    sql,
    bind: (...v: unknown[]) => wrap(s.bind(...v), sql),
    first: <T>() => timed(() => s.first<T>(), sql),
    all: <T>() => timed(() => s.all<T>(), sql),
    run: () => timed(() => s.run(), sql),
  });
  type Wrapped = ReturnType<typeof wrap>;
  const d1: D1Like = {
    prepare: (sql) => wrap(inner.prepare(sql), sql),
    batch: async (stmts) => timed(() => inner.batch!(stmts.map((s) => (s as Wrapped).inner)), `BATCH[${stmts.map((s) => (s as Wrapped).sql.replace(/\s+/g, " ").slice(0, 60)).join(" | ")}]`),
  };
  return { d1, meter };
}

export interface BenchWorld {
  deps: Deps;
  meter: D1Meter;
  now: { t: number };
  call(method: string, path: string, token?: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: unknown }>;
  orgId: string;
  owner: { token: string; id: string };
  member: { token: string; id: string };
  teams: string[];
  projects: string[];
  /** A file in a folder, one with branches */
  fileKey: string;
  run(sql: string, ...args: unknown[]): Promise<void>;
}

export const BENCH = { teams: 5, foldersPerTeam: 4, filesPerFolder: 10, members: 20 };

/** The bench's organization. `governance`: the Governance+ add-on with a policy, an allowlist and a network range. */
export async function benchWorld(opts: { governance: boolean }): Promise<BenchWorld> {
  const { d1, meter } = meteredD1();
  const now = { t: Date.UTC(2026, 9, 12, 12) };
  const deps: Deps = {
    db: new Db(d1),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1" } as Deps["env"],
    rooms: {
      async fetch(_key, path) {
        if (path.endsWith("/ws")) return new Response(null, { status: 200 });
        return Response.json({ ok: true, version: { id: "v" }, missing: [] });
      },
    },
    inboxes: { notify: async () => undefined, connect: async () => new Response(null) },
    now: () => now.t,
    fetch: async () => new Response("no", { status: 500 }),
  };
  const call: BenchWorld["call"] = async (method, path, token, body, headers = {}) => {
    const res = await handle(
      new Request(ORIGIN + path, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), "cf-connecting-ip": "203.0.113.9", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      deps,
    );
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    return { status: res.status, body: parsed };
  };
  const run = async (sql: string, ...args: unknown[]) => void (await d1.prepare(sql).bind(...args).run());
  const sign = async (email: string, i: number) => {
    // One address each: sign-in is throttled per IP (quota/throttle.ts)
    const r = (await call("POST", "/auth/dev", undefined, { email, name: email.split("@")[0] }, { "cf-connecting-ip": `203.0.113.${100 + i}` })).body as { token: string; user: { id: string } };
    return { token: r.token, id: r.user.id };
  };
  const people: { token: string; id: string; email: string }[] = [];
  for (let i = 0; i < BENCH.members; i++) {
    const email = `person${i}@acme.co`;
    people.push({ ...(await sign(email, i)), email });
  }
  const owner = people[0];
  const member = people[1];
  const orgId = ((await call("POST", "/orgs", owner.token, { name: "Acme" })).body as { org: { id: string } }).org.id;
  const t = now.t;
  for (const p of people.slice(1)) await run(`INSERT INTO org_members (org_id, email, user_id, role, seat, created_at) VALUES (?1, ?2, ?3, 'member', 'full', ?4)`, orgId, p.email, p.id, t);
  const teams: string[] = [];
  const projects: string[] = [];
  let fileN = 0;
  for (let ti = 0; ti < BENCH.teams; ti++) {
    const teamId = `teamBench${String(ti).padStart(7, "0")}`;
    teams.push(teamId);
    await run(`INSERT INTO teams (id, org_id, name, owner_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`, teamId, orgId, `Team ${ti}`, owner.id, t);
    // Every team: the owner's colleagues, a third of the org each, member is in all
    for (const [pi, p] of people.entries()) {
      if (pi === 0 || (pi !== 1 && pi % 3 !== ti % 3)) continue;
      await run(`INSERT INTO team_members (team_id, email, user_id, role, admin, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`, teamId, p.email, p.id, pi % 2 ? "editor" : "viewer", pi === 1 ? 1 : 0, t);
    }
    await run(`INSERT INTO team_requests (team_id, user_id, created_at) VALUES (?1, ?2, ?3)`, teamId, people[19 - ti].id, t);
    let parent: string | null = null;
    for (let fi = 0; fi < BENCH.foldersPerTeam; fi++) {
      const projectId = `projBench${ti}${fi}00000`;
      projects.push(projectId);
      // The last folder of each team is nested in the one before (Figma's folders in folders)
      const nested: boolean = fi === BENCH.foldersPerTeam - 1 && parent !== null;
      await run(`INSERT INTO projects (id, team_id, parent_id, depth, name, owner_id, access, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`, projectId, teamId, nested ? parent : null, nested ? 2 : 1, `Folder ${ti}.${fi}`, owner.id, fi === 1 ? "limited" : "inherited", t);
      for (const p of people.slice(2, 6)) await run(`INSERT INTO project_members (project_id, email, user_id, role, created_at) VALUES (?1, ?2, ?3, 'editor', ?4)`, projectId, p.email, p.id, t);
      parent = projectId;
      for (let k = 0; k < BENCH.filesPerFolder; k++) {
        const key = `fileBench${String(fileN++).padStart(5, "0")}`;
        await run(
          `INSERT INTO files (key, owner_id, name, created_at, updated_at, org_id, team_id, project_id, editor_type, link_access, org_link_access) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
          key, people[(k % 4) + 1].id, `File ${key}`, t - k * 60_000, orgId, teamId, projectId, k % 5 === 4 ? "figjam" : "design", k % 3 === 0 ? "viewer" : "none", k % 2 ? "viewer" : "none",
        );
        for (const p of people.slice(10, 13)) await run(`INSERT INTO members (file_key, email, user_id, role, created_at) VALUES (?1, ?2, ?3, 'viewer', ?4)`, key, p.email, p.id, t);
      }
    }
  }
  const fileKey = "fileBench00000";
  for (let b = 0; b < 5; b++) {
    const key = `branchBench${b}00`;
    await run(`INSERT INTO files (key, owner_id, name, created_at, updated_at, org_id, team_id, project_id) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7)`, key, member.id, `Branch ${b}`, t, orgId, teams[0], projects[0]);
    await run(`INSERT INTO branches (key, main_key, name, status, created_by, created_at, base_seq, main_seen_seq, session_base) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, ?7)`, key, fileKey, `Branch ${b}`, b < 3 ? "active" : "archived", member.id, t, 1000 * (b + 1));
  }
  // Drafts of the member (Home's Drafts)
  for (let k = 0; k < 10; k++) await run(`INSERT INTO files (key, owner_id, name, created_at, updated_at, org_id) VALUES (?1, ?2, ?3, ?4, ?4, ?5)`, `draftBench${k}000`, member.id, `Draft ${k}`, t, orgId);
  if (opts.governance) {
    await run(`UPDATE orgs SET governance_plus = 1 WHERE id = ?1`, orgId);
    await run(`INSERT INTO org_policies (id, org_id, title, text, audience, cadence, enabled_at, created_at) VALUES ('polBench0001', ?1, 'Policy', 'Be nice', 'members', 'yearly', ?2, ?2)`, orgId, t - 1000);
    for (const p of people) await run(`INSERT INTO policy_acknowledgements (policy_id, user_id, at) VALUES ('polBench0001', ?1, ?2)`, p.id, t - 500);
    await run(`INSERT INTO org_ip_ranges (id, org_id, kind, cidr, state, created_at, updated_at) VALUES ('ipBench00001', ?1, 'allowlist', '203.0.113.0/24', 'enforced', ?2, ?2)`, orgId, t);
    await run(`INSERT INTO org_ip_ranges (id, org_id, kind, cidr, state, created_at, updated_at) VALUES ('ipBench00002', ?1, 'network', '198.51.100.0/24', 'enforced', ?2, ?2)`, orgId, t);
  }
  return { deps, meter, now, call, orgId, owner, member, teams, projects, fileKey, run };
}

/** The routes of the incident (2026-10-12's `wrangler tail`) and their neighbours, as the apps call them */
export function benchRoutes(w: BenchWorld): { name: string; method: string; path: string; body?: unknown; headers?: Record<string, string> }[] {
  const team = w.teams[0];
  const project = w.projects[0];
  return [
    { name: "GET /orgs", method: "GET", path: "/orgs" },
    { name: "GET /orgs/:id", method: "GET", path: `/orgs/${w.orgId}` },
    { name: "GET /orgs/:id/teams?filter=mine", method: "GET", path: `/orgs/${w.orgId}/teams?filter=mine` },
    { name: "GET /orgs/:id/libraries", method: "GET", path: `/orgs/${w.orgId}/libraries` },
    { name: "GET /teams/:id", method: "GET", path: `/teams/${team}` },
    { name: "GET /teams/:id/projects", method: "GET", path: `/teams/${team}/projects` },
    { name: "GET /teams/:id/projects?parent=", method: "GET", path: `/teams/${team}/projects?parent=${project}` },
    { name: "GET /teams/:id/members", method: "GET", path: `/teams/${team}/members` },
    { name: "GET /teams/:id/requests", method: "GET", path: `/teams/${team}/requests` },
    { name: "GET /projects/:id", method: "GET", path: `/projects/${project}` },
    { name: "GET /projects/:id/files", method: "GET", path: `/projects/${project}/files` },
    { name: "GET /projects/:id/members", method: "GET", path: `/projects/${project}/members` },
    // Home's pages in one request each (org/pages.ts): what the five routes above answer, together
    { name: "GET /teams/:id/page", method: "GET", path: `/teams/${team}/page` },
    { name: "GET /projects/:id/page", method: "GET", path: `/projects/${project}/page` },
    { name: "GET /files/:key", method: "GET", path: `/files/${w.fileKey}` },
    { name: "GET /files/:key/ws", method: "GET", path: `/files/${w.fileKey}/ws`, headers: { upgrade: "websocket" } },
    { name: "GET /files/:key/branches?tab=active", method: "GET", path: `/files/${w.fileKey}/branches?tab=active` },
    { name: "POST /me/sessions/active", method: "POST", path: `/me/sessions/active`, body: {} },
    { name: "POST /files/:key/blobs/missing", method: "POST", path: `/files/${w.fileKey}/blobs/missing`, body: { sha1s: Array.from({ length: 50 }, (_, i) => i.toString(16).padStart(40, "0")) } },
    // A new file in a folder ("$unique": a fresh key each call — benchBody)
    { name: "POST /files", method: "POST", path: "/files", body: { key: "$unique", name: "New file", orgId: w.orgId, projectId: project } },
  ];
}

let unique = 0;
/** A route's body as sent: "$unique" becomes a fresh file key */
export const benchBody = (body: unknown): unknown =>
  body && typeof body === "object" && (body as { key?: unknown }).key === "$unique" ? { ...body, key: `benchNew${String(++unique).padStart(8, "0")}` } : body;
