/**
 * The real server (server/src/api.ts `handle`, round 1a) behind the fake's surface (fake/server.ts): D1 on node:sqlite
 * with every migration, rooms that keep snapshots in memory, dev sign-in for people. The store's org tests run against
 * it, so the two sides of §14.12 are checked together.
 */
import { handle, type Deps } from "../../../../server/src/api";
import { Db, type D1Like } from "../../../../server/src/db";
import { sqliteD1 } from "../../../../server/src/testing/sqliteD1";

export class RealOrgServer {
  /** Requests answered so far, "METHOD /path" */
  readonly log: string[] = [];
  /** Off: every request fails as a network error would */
  online = true;
  readonly d1: D1Like = sqliteD1();
  readonly snapshots = new Map<string, { seq: number; bytes: Uint8Array }>();
  private clock = Date.UTC(2026, 9, 11);
  readonly deps: Deps = {
    db: new Db(this.d1),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1" },
    rooms: {
      fetch: async (key, path, init) => {
        if (path.startsWith("/room/snapshot")) {
          if (init.method === "PUT") {
            const seq = Number(new URL(`https://room${path}`).searchParams.get("seq"));
            this.snapshots.set(key, { seq, bytes: new Uint8Array(init.body as ArrayBuffer) });
            return Response.json({ ok: true, seq, lastSeq: seq });
          }
          const s = this.snapshots.get(key);
          if (!s) return new Response("no snapshot yet", { status: 404 });
          return new Response(s.bytes, { headers: { "x-seq": String(s.seq), "x-last-seq": String(s.seq) } });
        }
        if (path === "/room/blobs/missing") return Response.json({ missing: [] });
        return Response.json({ ok: true });
      },
    },
    now: () => (this.clock += 1000),
    fetch: async () => new Response("no", { status: 500 }),
  };

  /** A person and their session token (dev sign-in) */
  async addUser(email: string, name = email.split("@")[0]): Promise<{ user: { id: string; email: string; name: string }; token: string }> {
    const res = await handle(new Request("https://org.test/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, name }) }), this.deps);
    const out = (await res.json()) as { token: string; user: { id: string; email: string } };
    return { user: { id: out.user.id, email: out.user.email, name }, token: out.token };
  }

  /** The handler, as `fetch` */
  readonly fetch: typeof fetch = async (input, init) => {
    if (!this.online) throw new TypeError("fetch failed");
    const req = new Request(String(input), init);
    this.log.push(`${req.method} ${new URL(req.url).pathname}`);
    return handle(req, this.deps);
  };

  /** A file's row as the store's tests look at it */
  async file(key: string): Promise<{ orgId: string | null; teamId: string | null; projectId: string | null; snapshot: { seq: number; bytes: Uint8Array } | null } | null> {
    const r = await this.d1.prepare(`SELECT org_id, team_id, project_id FROM files WHERE key = ?1`).bind(key).first<{ org_id: string | null; team_id: string | null; project_id: string | null }>();
    return r ? { orgId: r.org_id, teamId: r.team_id, projectId: r.project_id, snapshot: this.snapshots.get(key) ?? null } : null;
  }

  /** A change made behind the store's back (someone else, elsewhere) */
  async exec(sql: string, ...args: unknown[]): Promise<void> {
    await this.d1.prepare(sql).bind(...args).run();
  }
}
