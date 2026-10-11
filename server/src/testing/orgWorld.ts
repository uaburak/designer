/**
 * An organization for the libraries', analytics' and fonts' tests (round 3a): the real handler on node:sqlite with
 * in-memory library and font objects, and a small org written straight into D1.
 *
 *   Acme (alice: admin, Full)
 *   ├─ workspace W1 "Product" (wade: workspace admin)
 *   │  ├─ team T1 "Design"  (owner alice; bob editor)                 folder P1 "System" → lib_design1 (the library)
 *   │  │                                                             folder P3 "Secret" (Limited; fay invited) → lib_secret1
 *   │  └─ team T2 "Web"     (owner alice; carol editor, tara admin)   folder P2 "Site" → file_web001 (a consumer)
 *   └─ team T3 "Brand"     (owner alice; no workspace)               folder P4 "Brand" → file_brand1
 *   members: bob, carol, fay (Full, workspace W1 except carol), dan (View, no team), gus (guest, viewer on the library)
 *   drafts: bob's draft_bob01
 */
import { createHash } from "node:crypto";
import { handle, type Deps } from "../api";
import { Db, type D1Like } from "../db";
import { memoryFonts, memoryLibraries } from "./memoryLibraries";
import { sqliteD1 } from "./sqliteD1";

const ORIGIN = "https://designer.example.workers.dev";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

export const sha1 = (b: Uint8Array | string) => createHash("sha1").update(b).digest("hex");

export const W1 = "wsProduct0000001";
export const T1 = "teamDesign000001";
export const T2 = "teamWeb000000001";
export const T3 = "teamBrand0000001";
export const P1 = "projSystem000001";
export const P2 = "projSite00000001";
export const P3 = "projSecret000001";
export const P4 = "projBrand0000001";
export const LIB = "lib_design1";
export const SECRET = "lib_secret1";
export const WEB = "file_web001";
export const BRAND = "file_brand1";
export const DRAFT = "draft_bob01";

export interface World {
  deps: Deps;
  d1: D1Like;
  now: { t: number };
  inbox: { userId: string; msg: Any }[];
  rooms: { key: string; path: string; body: Any }[];
  libs: ReturnType<typeof memoryLibraries>;
  fonts: ReturnType<typeof memoryFonts>;
  call(method: string, path: string, token?: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: Any; headers: Headers; bytes: Uint8Array }>;
  orgId: string;
  people: Record<"alice" | "bob" | "carol" | "dan" | "fay" | "gus" | "wade" | "tara" | "olga", { token: string; id: string }>;
  run(sql: string, ...args: unknown[]): Promise<void>;
  rows<T = Any>(sql: string, ...args: unknown[]): Promise<T[]>;
}

export async function world(): Promise<World> {
  const d1 = sqliteD1();
  const now = { t: Date.UTC(2026, 9, 11, 12) };
  const inbox: World["inbox"] = [];
  const rooms: World["rooms"] = [];
  const libs = memoryLibraries();
  const fonts = memoryFonts();
  const deps: Deps = {
    db: new Db(d1),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1", LIBRARIES: libs.binding, FONTS: fonts.binding } as Deps["env"],
    rooms: {
      async fetch(key, path, init) {
        rooms.push({ key, path, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
        return Response.json({ ok: true, version: { id: "v" } });
      },
    },
    inboxes: {
      async notify(userId, msg) {
        inbox.push({ userId, msg });
      },
      async connect() {
        return new Response(null);
      },
    },
    now: () => now.t,
    fetch: async () => new Response("no", { status: 500 }),
  };
  const call: World["call"] = async (method, path, token, body, headers = {}) => {
    const raw = body instanceof Uint8Array;
    const res = await handle(
      new Request(ORIGIN + path, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
      }),
      deps,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let parsed: Any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // bytes, CSV
    }
    return { status: res.status, body: parsed, headers: res.headers, bytes };
  };
  const run = async (sql: string, ...args: unknown[]) => void (await d1.prepare(sql).bind(...args).run());
  const rows = async <T = Any>(sql: string, ...args: unknown[]) => (await d1.prepare(sql).bind(...args).all<T>()).results;

  const sign = async (email: string) => {
    const r = await call("POST", "/auth/dev", undefined, { email, name: email.split("@")[0] });
    return { token: r.body.token as string, id: r.body.user.id as string };
  };
  const people = {} as World["people"];
  for (const n of ["alice", "bob", "carol", "dan", "fay", "gus", "wade", "tara", "olga"] as const) people[n] = await sign(`${n}@x.co`);
  const orgId = (await call("POST", "/orgs", people.alice.token, { name: "Acme" })).body.org.id as string;
  const t = now.t;
  await run(`INSERT INTO workspaces (id, org_id, name, created_at, updated_at) VALUES (?1, ?2, 'Product', ?3, ?3)`, W1, orgId, t);
  await run(`UPDATE org_members SET workspace_id = ?2 WHERE org_id = ?1`, orgId, W1);
  const member = (p: { id: string }, email: string, role: string, seat: string, ws: string | null) =>
    run(`INSERT INTO org_members (org_id, email, user_id, role, seat, workspace_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`, orgId, email, p.id, role, seat, ws, t);
  await member(people.bob, "bob@x.co", "member", "full", W1);
  await member(people.carol, "carol@x.co", "member", "full", null);
  await member(people.dan, "dan@x.co", "member", "view", null);
  await member(people.fay, "fay@x.co", "member", "full", W1);
  await member(people.gus, "gus@x.co", "guest", "view", null);
  await member(people.wade, "wade@x.co", "member", "full", W1);
  await member(people.tara, "tara@x.co", "member", "full", W1);
  await run(`INSERT INTO workspace_admins (workspace_id, user_id) VALUES (?1, ?2)`, W1, people.wade.id);
  const team = (id: string, name: string, ws: string | null) => run(`INSERT INTO teams (id, org_id, workspace_id, name, owner_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`, id, orgId, ws, name, people.alice.id, t);
  await team(T1, "Design", W1);
  await team(T2, "Web", W1);
  await team(T3, "Brand", null);
  const tm = (teamId: string, p: { id: string }, email: string, role: string, admin = 0) => run(`INSERT INTO team_members (team_id, email, user_id, role, admin, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`, teamId, email, p.id, role, admin, t);
  await tm(T1, people.bob, "bob@x.co", "editor");
  await tm(T2, people.carol, "carol@x.co", "editor");
  await tm(T2, people.tara, "tara@x.co", "editor", 1);
  const project = (id: string, teamId: string, name: string, access = "inherited") => run(`INSERT INTO projects (id, team_id, name, owner_id, access, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`, id, teamId, name, people.alice.id, access, t);
  await project(P1, T1, "System");
  await project(P2, T2, "Site");
  await project(P3, T1, "Secret", "limited");
  await project(P4, T3, "Brand");
  await run(`INSERT INTO project_members (project_id, email, user_id, role, created_at) VALUES (?1, 'fay@x.co', ?2, 'editor', ?3)`, P3, people.fay.id, t);
  const file = (key: string, name: string, owner: string, teamId: string | null, projectId: string | null, type = "design") =>
    run(`INSERT INTO files (key, owner_id, name, created_at, updated_at, org_id, team_id, project_id, editor_type) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8)`, key, owner, name, t, orgId, teamId, projectId, type);
  await file(LIB, "Design System", people.alice.id, T1, P1);
  await file(SECRET, "Secret System", people.alice.id, T1, P3);
  await file(WEB, "Website", people.alice.id, T2, P2);
  await file(BRAND, "Brand board", people.alice.id, T3, P4, "figjam");
  await file(DRAFT, "Bob's draft", people.bob.id, null, null);
  await run(`INSERT INTO members (file_key, email, user_id, role, created_at) VALUES (?1, 'gus@x.co', ?2, 'viewer', ?3)`, LIB, people.gus.id, t);
  return { deps, d1, now, inbox, rooms, libs, fonts, call, orgId, people, run, rows };
}

// ---- publishing ---------------------------------------------------------------------------------------------------

/** A payload: a fig-kiwi container's prelude and some bytes (the object checks the prelude only) */
export const payload = (seed: string) => new Uint8Array([...new TextEncoder().encode("fig-kiwi"), 1, 0, 0, 0, ...new TextEncoder().encode(seed)]);

export interface TestAsset {
  key: string;
  kind: "COMPONENT" | "COMPONENT_SET" | "STYLE" | "VARIABLE_COLLECTION" | "VARIABLE";
  name: string;
  seed: string;
  dependencyOnly?: boolean;
  dependencies?: string[];
  componentSetKey?: string;
  collectionKey?: string;
  thumb?: Uint8Array;
}

export const assetKey = (name: string) => sha1(`asset:${name}`);

export function manifestOf(assets: TestAsset[]) {
  return assets.map((a) => ({
    key: a.key,
    kind: a.kind,
    name: a.name,
    description: "",
    guid: "1:1",
    versionHash: sha1(payload(a.seed)),
    dependencyOnly: a.dependencyOnly ?? false,
    dependencies: a.dependencies ?? [],
    ...(a.componentSetKey ? { componentSetKey: a.componentSetKey } : {}),
    ...(a.collectionKey ? { collectionKey: a.collectionKey } : {}),
    thumbnail: a.thumb ? { sha1: sha1(a.thumb), width: 10, height: 10 } : null,
  }));
}

/** §16.6's three steps: missing → uploads → versions. Returns the versions call's answer (and what was missing). */
export async function publish(w: World, key: string, token: string, assets: TestAsset[], opts: { baseVersion?: number; scope?: "team" | "org"; description?: string; collections?: unknown[]; moves?: unknown[]; skipUpload?: string[] } = {}) {
  const man = manifestOf(assets);
  const missing = await w.call("POST", `/libraries/${key}/missing`, token, { payloads: man.map((a) => ({ key: a.key, versionHash: a.versionHash })), blobs: assets.filter((a) => a.thumb).map((a) => sha1(a.thumb!)) });
  if (missing.status === 200) {
    for (const p of missing.body.payloads as { key: string }[]) {
      if (opts.skipUpload?.includes(p.key)) continue;
      const a = assets.find((x) => x.key === p.key)!;
      await w.call("PUT", `/libraries/${key}/payloads/${a.key}/${sha1(payload(a.seed))}`, token, payload(a.seed));
    }
    for (const s of missing.body.blobs as string[]) {
      const a = assets.find((x) => x.thumb && sha1(x.thumb) === s)!;
      await w.call("PUT", `/libraries/${key}/blobs/${s}`, token, a.thumb!);
    }
  }
  const r = await w.call("POST", `/libraries/${key}/versions`, token, {
    baseVersion: opts.baseVersion ?? 0,
    description: opts.description ?? "",
    scope: opts.scope,
    assets: man,
    changes: { created: man.map((a) => a.key), modified: [], removed: [], moved: [] },
    moves: opts.moves ?? [],
    collections: opts.collections ?? [],
  });
  return { ...r, missing: missing.body };
}
