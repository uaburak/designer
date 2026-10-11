/**
 * The real server (server/src/api.ts `handle`, round 3a) behind the surface of the contract fake it replaced: D1 on
 * node:sqlite with every migration, in-memory LibraryObject / FontObject, dev sign-in for people. The store's library
 * tests run against it, so both sides of docs/data.md §16.10 / §17.5 are checked together (as ../../org/fake/real.ts
 * does for the org routes).
 *
 * The fake's setup becomes rows: `addOrg` makes its first member the org's admin (all on Full seats), `addTeam`'s
 * members are direct team members who can view the team's files (the fake's team members can't edit), `addFile`'s
 * editors / viewers are file members, its folder is made on first use.
 */
import { handle, type Deps } from "../../../../server/src/api";
import { Db, type D1Like } from "../../../../server/src/db";
import { objectFetch } from "../../../../server/src/libraries/db";
import { sqliteD1 } from "../../../../server/src/testing/sqliteD1";
import { memoryFonts, memoryLibraries } from "../../../../server/src/testing/memoryLibraries";
import type { CollectionModes, FileUsageSnapshot, LibraryScope, WireUsageEvent } from "../../../shared/libraries/orgTypes";
import type { LibraryVersion } from "../../../shared/store/types";

export class RealLibraryServer {
  /** Requests answered so far, "METHOD /path" */
  readonly log: string[] = [];
  /** Off: every request fails as a network error would */
  online = true;
  /** Answer `POST /analytics/library-events` with this status instead of the handler (tests of the queue) */
  eventsStatus = 200;
  /** Called (and awaited) before each request is answered: a test's "meanwhile" */
  onRequest: ((method: string, path: string) => void | Promise<void>) | null = null;
  clock = Date.UTC(2026, 9, 11, 12);
  readonly d1: D1Like = sqliteD1();
  readonly libs = memoryLibraries();
  readonly fonts = memoryFonts();
  private lastOrg: string | null = null;
  readonly deps: Deps = {
    db: new Db(this.d1),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1", LIBRARIES: this.libs.binding, FONTS: this.fonts.binding } as Deps["env"],
    rooms: { fetch: async () => Response.json({ ok: true, version: { id: "v" } }) },
    now: () => (this.clock += 1),
    fetch: async () => new Response("no", { status: 500 }),
  };

  private run(sql: string, ...args: unknown[]) {
    return this.d1.prepare(sql).bind(...args).run();
  }

  async addUser(email: string, name = email.split("@")[0]): Promise<{ user: { id: string; email: string }; token: string }> {
    const res = await handle(new Request("https://lib.test/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, name }) }), this.deps);
    const out = (await res.json()) as { token: string; user: { id: string; email: string } };
    return { user: { id: out.user.id, email: out.user.email }, token: out.token };
  }

  private async email(id: string): Promise<string> {
    return (await this.d1.prepare(`SELECT email FROM users WHERE id = ?1`).bind(id).first<{ email: string }>())!.email;
  }

  /** The org and its people: the first is its admin; every seat Full */
  async addOrg(orgId: string, members: string[]): Promise<void> {
    await this.run(`INSERT INTO orgs (id, name, created_by, created_at, updated_at) VALUES (?1, ?1, ?2, 0, 0)`, orgId, members[0]);
    for (const [i, id] of members.entries()) {
      await this.run(`INSERT INTO org_members (org_id, email, user_id, role, seat, created_at) VALUES (?1, ?2, ?3, ?4, 'full', 0)`, orgId, await this.email(id), id, i === 0 ? "admin" : "member");
    }
    this.lastOrg = orgId;
  }

  /** A team of the last org, its first member the owner, the others direct members who can view its files */
  async addTeam(teamId: string, members: string[], orgId = this.lastOrg!): Promise<void> {
    await this.run(`INSERT INTO teams (id, org_id, name, owner_id, created_at, updated_at) VALUES (?1, ?2, ?1, ?3, 0, 0)`, teamId, orgId, members[0]);
    for (const id of members.slice(1)) await this.run(`INSERT INTO team_members (team_id, email, user_id, role, created_at) VALUES (?1, ?2, ?3, 'viewer', 0)`, teamId, await this.email(id), id);
  }

  /** A file (owned by its first editor), in a folder of its team (`projectId`, default "p1"), or a draft (null) */
  async addFile(key: string, f: { orgId: string; teamId?: string | null; name?: string; projectId?: string | null; editors?: string[]; viewers?: string[]; orgLinkAccess?: "none" | "viewer" | "editor" }): Promise<void> {
    const editors = f.editors ?? [];
    const owner = editors[0] ?? (await this.d1.prepare(`SELECT created_by FROM orgs WHERE id = ?1`).bind(f.orgId).first<{ created_by: string }>())!.created_by;
    const projectId = f.projectId === undefined ? "p1" : f.projectId;
    if (projectId && !(await this.d1.prepare(`SELECT 1 AS x FROM projects WHERE id = ?1`).bind(projectId).first())) {
      // A folder needs a team: the file's, else a team of its own nobody is in
      let team = f.teamId ?? null;
      if (!team) {
        team = `t_${projectId}`;
        await this.run(`INSERT INTO teams (id, org_id, name, owner_id, created_at, updated_at) VALUES (?1, ?2, ?1, ?3, 0, 0)`, team, f.orgId, owner);
      }
      await this.run(`INSERT INTO projects (id, team_id, name, owner_id, created_at, updated_at) VALUES (?1, ?2, ?1, ?3, 0, 0)`, projectId, team, owner);
    }
    await this.run(
      `INSERT INTO files (key, owner_id, name, created_at, updated_at, org_id, team_id, project_id, org_link_access) VALUES (?1, ?2, ?3, 0, 0, ?4, ?5, ?6, ?7)`,
      key,
      owner,
      f.name ?? key,
      f.orgId,
      f.teamId ?? null,
      projectId,
      f.orgLinkAccess ?? "none",
    );
    for (const [role, ids] of [["editor", editors.slice(1)], ["viewer", f.viewers ?? []]] as const) {
      for (const id of ids) await this.run(`INSERT INTO members (file_key, email, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4, 0)`, key, await this.email(id), id, role);
    }
  }

  /** The handler, as `fetch` */
  readonly fetch: typeof fetch = async (input, init) => {
    if (!this.online) throw new TypeError("fetch failed");
    const req = new Request(String(input), init);
    const path = new URL(req.url).pathname;
    this.log.push(`${req.method} ${path}`);
    await this.onRequest?.(req.method, path);
    if (path === "/analytics/library-events" && this.eventsStatus !== 200) return Response.json({ error: "test", code: "internal" }, { status: this.eventsStatus });
    return handle(req, this.deps);
  };

  // ---- what the tests look at ----

  /** The library's row, with its collections' modes */
  async library(key: string): Promise<{ scope: LibraryScope; status: string; latestVersion: number; collections: CollectionModes[] } | null> {
    const r = await this.d1.prepare(`SELECT scope, status, latest_version FROM libraries WHERE key = ?1`).bind(key).first<{ scope: LibraryScope; status: string; latest_version: number }>();
    if (!r) return null;
    const { results } = await this.d1.prepare(`SELECT key, name, modes FROM library_assets WHERE library_key = ?1 AND kind = 'VARIABLE_COLLECTION' AND removed_in IS NULL ORDER BY name`).bind(key).all<{ key: string; name: string; modes: string | null }>();
    return { scope: r.scope, status: r.status, latestVersion: r.latest_version, collections: results.map((c) => ({ collectionKey: c.key, name: c.name, modes: JSON.parse(c.modes ?? "[]") })) };
  }

  async orgLinkAccess(key: string): Promise<string | null> {
    return (await this.d1.prepare(`SELECT org_link_access FROM files WHERE key = ?1`).bind(key).first<{ org_link_access: string }>())?.org_link_access ?? null;
  }

  /** A payload as the library's object stores it */
  async payload(key: string, assetKey: string, versionHash: string): Promise<Uint8Array | null> {
    const res = await objectFetch(this.libs.binding, key, "/payloads", { method: "POST", body: JSON.stringify({ wants: [{ key: assetKey, versionHash }] }) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) === 0) return null;
    const len = view.getUint32(4, true);
    return bytes.subarray(8 + len);
  }

  /** Someone else publishes the latest version again (a concurrent publish) */
  async bumpVersion(key: string): Promise<void> {
    const latest = (await (await objectFetch(this.libs.binding, key, "/version/latest")).json()) as LibraryVersion;
    await objectFetch(this.libs.binding, key, "/commit", { method: "POST", body: JSON.stringify({ ...latest, baseVersion: latest.version }) });
  }

  /** Accepted insert / detach rows */
  async events(): Promise<WireUsageEvent[]> {
    const { results } = await this.d1.prepare(`SELECT day, file_key AS file, library_key AS library, asset_key AS asset, asset_type AS type, action, count FROM library_actions_daily`).all<WireUsageEvent>();
    return results;
  }

  /** A file's instance snapshot as stored (null: none) */
  async usage(fileKey: string): Promise<Omit<FileUsageSnapshot, "hash"> | null> {
    if (!(await this.d1.prepare(`SELECT 1 AS x FROM library_usage_files WHERE file_key = ?1`).bind(fileKey).first())) return null;
    const { results } = await this.d1.prepare(`SELECT library_key, asset_key, asset_type, instances FROM library_usage WHERE file_key = ?1`).bind(fileKey).all<{ library_key: string; asset_key: string; asset_type: string; instances: number }>();
    return {
      assets: results.filter((r) => r.asset_type !== "mode").map((r) => ({ library: r.library_key, asset: r.asset_key, type: r.asset_type as "component", instances: r.instances })),
      modes: results.filter((r) => r.asset_type === "mode").map((r) => ({ library: r.library_key, collection: r.asset_key.split("/")[0], mode: r.asset_key.split("/")[1], instances: r.instances })),
    };
  }
}
