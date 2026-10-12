/**
 * Developer previews on the Worker (docs/multiplayer.md §9, docs/data.md §13): the desktop store publishes a preview
 * package (manifest.json, doc.kiwi, images/<sha1>) here, and anyone with the link opens `/p/<id>` — the viewer, served
 * from the Worker's static assets (out/viewer), which reads the files from `/previews/<id>/…`.
 *
 *   GET    /p/:id                          public   the viewer page (static asset index.html)
 *   GET    /previews/:id/manifest.json     public   the live manifest (404 none, 410 expired)
 *   GET    /previews/:id/doc.kiwi          public   the live document (fig-kiwi container)
 *   GET    /previews/:id/images/:sha1      public   an image the manifest lists
 *   GET    /previews                       signed in   the caller's live previews
 *   POST   /previews/:id/images/missing    owner    {sha1s} → {missing}: images not uploaded yet
 *   PUT    /previews/:id/images/:sha1      owner    an image (bytes checked against the SHA-1)
 *   PUT    /previews/:id/doc               owner    doc.kiwi, staged: readers keep the old one until the manifest
 *   PUT    /previews/:id/manifest          owner    {manifest, fileKey?}: goes live (doc swapped in, unused images
 *                                                   dropped, expiry alarm set) → {id, url, expiresAt}
 *   DELETE /previews/:id                   owner    unpublish: the object's storage and the row deleted
 *
 * The first write to an unused id claims it for the caller (D1 `previews`, migration 0007); someone else's id answers
 * 404. Storage: one `PreviewObject` Durable Object per preview, SQLite rows of 1 MB chunks (as FileRoom's blobs) —
 * no R2. Expiry: the object deletes itself at `expiresAt` (an alarm), reads refuse it from then on (410), the list
 * leaves it out.
 *
 * `PreviewBox` is the object's logic over a narrow SQL interface, so Node's tests run it on node:sqlite.
 */
import { isPreviewManifest, previewExpired, type PreviewManifest } from "../../src/shared/preview/format";
import type { Deps } from "./api";
import type { D1Like, User } from "./db";
import { QUOTA_LIMITS } from "../../src/shared/quota";
import { guardedUpload, pruneStorage, releaseStorage, requirePreviewSlot } from "./quota/quota";
import { throttle } from "./quota/throttle";
import { BoxObjects, boxObjectsHost, type ChunkTable } from "./storage/boxObjects";
import { resolveR2, type StorageEnv } from "./storage/objects";

/** SQLite values hold 2 MB; documents and images are stored in 1 MB rows. */
const CHUNK = 1024 * 1024;
export const MAX_PREVIEW_DOC_BYTES = 64 * 1024 * 1024;
export const MAX_PREVIEW_IMAGE_BYTES = 40 * 1024 * 1024;
/** Live or being published, per owner (the `previews` quota's default, src/shared/quota.ts; the operator may raise it) */
export const MAX_PREVIEWS_PER_USER = QUOTA_LIMITS.previews;
/** Public reads stay in the edge cache this long (seconds); a republish or unpublish purges this location's copy */
const PUBLIC_CACHE_S = 60;
const PREVIEW_ID = /^[0-9A-Za-z]{22}$/;
const SHA1 = /^[0-9a-f]{40}$/;

/** What previews need of the Worker's env (index.ts passes the whole env as `deps.env`). */
export interface PreviewEnv {
  DB?: D1Like;
  /** One PreviewObject per preview id */
  PREVIEWS?: { idFromName(name: string): unknown; get(id: never): { fetch(req: Request): Promise<Response> } };
  /** Workers Static Assets (wrangler.jsonc `assets`): the built viewer, out/viewer/index.html */
  ASSETS?: { fetch(req: Request | string): Promise<Response> };
}

class PreviewHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
/** Public reads are fetched by the viewer page (same origin) or a dev viewer elsewhere (`?src=`). */
const PUBLIC = { "access-control-allow-origin": "*" };

/** Whether api.ts hands the request to `previews` (its one dispatch line). */
export const isPreviewPath = (path: string): boolean => /^\/(p|previews)(\/|$)/.test(path);

/**
 * The routes above. `signedIn` is api.ts's authentication (throws its 401 error); every other refusal is answered here.
 */
export async function previews(req: Request, url: URL, deps: Deps, signedIn: () => Promise<User>): Promise<Response> {
  try {
    return await route(req, url, deps, signedIn);
  } catch (e) {
    if (e instanceof PreviewHttpError) return json({ error: e.message }, e.status);
    throw e;
  }
}

async function route(req: Request, url: URL, deps: Deps, signedIn: () => Promise<User>): Promise<Response> {
  const env = deps.env as PreviewEnv;
  const path = url.pathname.replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean);
  const m = req.method;

  if (parts[0] === "p") {
    if (parts.length !== 2 || !PREVIEW_ID.test(parts[1]) || (m !== "GET" && m !== "HEAD")) throw new PreviewHttpError(404, "not found");
    await throttle(deps, req, "public");
    return viewerPage(url, env);
  }

  // GET /previews: the caller's own
  if (parts.length === 1) {
    if (m !== "GET") throw new PreviewHttpError(405, "method not allowed");
    const user = await signedIn();
    return json({ previews: await listPreviews(d1(env), user.id, deps.now(), url.origin) });
  }

  const id = parts[1];
  if (!PREVIEW_ID.test(id)) throw new PreviewHttpError(400, "bad preview id");
  const rest = parts.slice(2).join("/");

  // Public reads
  if (m === "GET" && (rest === "manifest.json" || rest === "doc.kiwi" || /^images\/[0-9a-f]{40}$/.test(rest))) return publicRead(req, deps, env, id, rest);

  // The owner's writes
  const user = await signedIn();
  const db = d1(env);
  if (rest === "" && m === "DELETE") {
    await ownedOrMissing(db, id, user.id);
    await box(env, id, "/box", { method: "DELETE" });
    await db.prepare(`DELETE FROM previews WHERE id = ?`).bind(id).run();
    await releaseStorage(deps.db.d1, `p:${id}:`);
    await purge(url.origin, id);
    return json({ ok: true });
  }
  if (rest === "images/missing" && m === "POST") {
    const { sha1s } = await readJson<{ sha1s?: unknown }>(req);
    if (!Array.isArray(sha1s) || sha1s.length > 5000 || !sha1s.every((s) => typeof s === "string" && SHA1.test(s))) throw new PreviewHttpError(400, "sha1s");
    await claim(deps, db, id, user.id, deps.now());
    return box(env, id, "/box/images/missing", { method: "POST", body: JSON.stringify({ sha1s }) });
  }
  const image = /^images\/([0-9a-f]{40})$/.exec(rest);
  if (image && m === "PUT") {
    await claim(deps, db, id, user.id, deps.now());
    const up = await guardedUpload(deps, req, user, { ownerId: user.id, item: `p:${id}:i:${image[1]}` }, MAX_PREVIEW_IMAGE_BYTES, "image too large");
    const res = await box(env, id, `/box/images/${image[1]}`, { method: "PUT", body: up.body });
    if (res.ok) await up.commit();
    return res;
  }
  if (rest === "doc" && m === "PUT") {
    await claim(deps, db, id, user.id, deps.now());
    const up = await guardedUpload(deps, req, user, { ownerId: user.id, item: `p:${id}:doc` }, MAX_PREVIEW_DOC_BYTES, "preview too large");
    const res = await box(env, id, "/box/doc", { method: "PUT", body: up.body });
    if (res.ok) await up.commit();
    return res;
  }
  if (rest === "manifest" && m === "PUT") {
    const body = await readJson<{ manifest?: unknown; fileKey?: unknown }>(req);
    const manifest = body.manifest;
    if (!isPreviewManifest(manifest) || manifest.previewId !== id) throw new PreviewHttpError(400, "bad manifest");
    const now = deps.now();
    if (previewExpired(manifest, now)) throw new PreviewHttpError(400, "the manifest has already expired");
    const fileKey = typeof body.fileKey === "string" && /^[0-9A-Za-z]{22}$/.test(body.fileKey) ? body.fileKey : null;
    // A preview of an org file: the org's Governance+ gates (docs/governance.md §2.5) for its people, before it goes live
    const orgId = fileKey ? ((await db.prepare(`SELECT org_id FROM files WHERE key = ?1`).bind(fileKey).first<{ org_id: string | null }>())?.org_id ?? null) : null;
    if (orgId) {
      const { orgGate, gateError } = await import("./governance/gate");
      const gate = await orgGate(deps, user, orgId, req);
      if (gate) {
        const e = gateError(gate, (await db.prepare(`SELECT name FROM orgs WHERE id = ?1`).bind(orgId).first<{ name: string }>())?.name ?? "");
        return json({ error: e.message, code: e.code, ...e.detail }, 403);
      }
    }
    await claim(deps, db, id, user.id, now);
    const res = await box(env, id, "/box/manifest", { method: "PUT", body: JSON.stringify(manifest) });
    if (!res.ok) return res;
    // Images the live manifest no longer lists were dropped by the object: no longer charged
    await pruneStorage(deps, `p:${id}:`, new Set([`p:${id}:doc`, ...manifest.images.map((s) => `p:${id}:i:${s}`)]));
    await purge(url.origin, id);
    await db
      .prepare(`UPDATE previews SET file_key = ?, file_name = ?, updated_at = ?, published_at = COALESCE(published_at, ?), expires_at = ? WHERE id = ?`)
      .bind(fileKey, manifest.fileName.slice(0, 200) || "Untitled", now, now, manifest.expiresAt, id)
      .run();
    return json({ id, url: previewLink(url.origin, id), expiresAt: manifest.expiresAt });
  }
  throw new PreviewHttpError(404, "not found");
}

export const previewLink = (origin: string, id: string): string => `${origin}/p/${id}`;

function d1(env: PreviewEnv): D1Like {
  if (!env.DB) throw new PreviewHttpError(503, "previews aren't set up on this server");
  return env.DB;
}

async function box(env: PreviewEnv, id: string, path: string, init: RequestInit): Promise<Response> {
  const ns = env.PREVIEWS;
  if (!ns) throw new PreviewHttpError(503, "previews aren't set up on this server");
  // A file the object names on R2 (docs/cloud.md §1) is read here straight from R2
  return resolveR2(await ns.get(ns.idFromName(id) as never).fetch(new Request(`https://preview${path}`, init)), env as StorageEnv);
}

/** Delete account (docs/multiplayer.md §12): every preview of the person unpublished — storage and rows. */
export async function deletePreviewsOf(deps: Deps, userId: string): Promise<void> {
  const env = deps.env as PreviewEnv;
  const db = env.DB ?? deps.db.d1;
  const { results } = await db.prepare(`SELECT id FROM previews WHERE owner_id = ?`).bind(userId).all<{ id: string }>();
  for (const { id } of results) {
    if (env.PREVIEWS) await box(env, id, "/box", { method: "DELETE" });
    await releaseStorage(db, `p:${id}:`);
  }
  await db.prepare(`DELETE FROM previews WHERE owner_id = ?`).bind(userId).run();
}

/** The viewer page for `/p/<id>`: the built viewer reads the id from its own path. */
export async function viewerPage(url: URL, env: PreviewEnv): Promise<Response> {
  if (!env.ASSETS) throw new PreviewHttpError(503, "the preview viewer isn't deployed on this server");
  const res = await env.ASSETS.fetch(new Request(new URL("/index.html", url.origin)));
  if (!res.ok) throw new PreviewHttpError(503, "the preview viewer isn't deployed on this server");
  const headers = new Headers(res.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-cache");
  return new Response(res.body, { status: 200, headers });
}

interface PreviewRow {
  id: string;
  owner_id: string;
  file_key: string | null;
  file_name: string;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  expires_at: number | null;
}

async function listPreviews(db: D1Like, userId: string, now: number, origin: string) {
  const { results } = await db
    .prepare(`SELECT * FROM previews WHERE owner_id = ? AND published_at IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC`)
    .bind(userId, now)
    .all<PreviewRow>();
  return results.map((r) => ({ id: r.id, fileKey: r.file_key, fileName: r.file_name, createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at, url: previewLink(origin, r.id) }));
}

/** The id is the caller's: theirs already, or unused and now claimed (within their `previews` quota). Someone else's
 *  answers 404. */
async function claim(deps: Deps, db: D1Like, id: string, userId: string, now: number): Promise<void> {
  const row = await db.prepare(`SELECT owner_id FROM previews WHERE id = ?`).bind(id).first<{ owner_id: string }>();
  if (row) {
    if (row.owner_id !== userId) throw new PreviewHttpError(404, "no such preview");
    return;
  }
  await requirePreviewSlot(deps, db, userId);
  await db.prepare(`INSERT INTO previews (id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`).bind(id, userId, now, now).run();
  const after = await db.prepare(`SELECT owner_id FROM previews WHERE id = ?`).bind(id).first<{ owner_id: string }>();
  if (after?.owner_id !== userId) throw new PreviewHttpError(404, "no such preview");
}

async function ownedOrMissing(db: D1Like, id: string, userId: string): Promise<void> {
  const row = await db.prepare(`SELECT owner_id FROM previews WHERE id = ?`).bind(id).first<{ owner_id: string }>();
  if (!row || row.owner_id !== userId) throw new PreviewHttpError(404, "no such preview");
}

async function readJson<T>(req: Request): Promise<T> {
  try {
    const v = (await req.json()) as T;
    if (v && typeof v === "object") return v;
  } catch {
    // fall through
  }
  throw new PreviewHttpError(400, "expected a JSON object");
}

/**
 * A public read (the viewer's manifest, document and images): throttled per IP, refused for a suspended owner, and
 * kept in the edge cache (Cloudflare's Cache API, where there is one) for PUBLIC_CACHE_S — images, content-addressed,
 * for as long as the browser keeps them.
 */
async function publicRead(req: Request, deps: Deps, env: PreviewEnv, id: string, rest: string): Promise<Response> {
  await throttle(deps, req, "public");
  const cache = edgeCache();
  const key = new Request(req.url, { method: "GET" });
  const hit = cache ? await cache.match(key) : undefined;
  if (hit) return hit;
  const owner = await d1(env).prepare(`SELECT u.suspended_at FROM previews p JOIN users u ON u.id = p.owner_id WHERE p.id = ?1`).bind(id).first<{ suspended_at: number | null }>();
  if (owner && owner.suspended_at != null) throw new PreviewHttpError(404, "no such preview");
  const res = await box(env, id, `/box/${rest}`, { method: "GET" });
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(PUBLIC)) headers.set(k, v);
  if (res.ok && !rest.startsWith("images/")) headers.set("cache-control", `public, max-age=${PUBLIC_CACHE_S}`);
  const out = new Response(res.body, { status: res.status, headers });
  if (cache && res.ok) {
    const put = cache.put(key, out.clone());
    if (deps.waitUntil) deps.waitUntil(put);
    else await put;
  }
  return out;
}

/** Workers' default cache (absent in Node's tests) */
function edgeCache(): { match(r: Request): Promise<Response | undefined>; put(r: Request, res: Response): Promise<void>; delete(r: Request): Promise<boolean> } | null {
  const c = (globalThis as { caches?: { default?: unknown } }).caches?.default;
  return c ? (c as ReturnType<typeof edgeCache>) : null;
}

/** A republished or unpublished preview: this location's cached manifest and document go */
async function purge(origin: string, id: string): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;
  for (const f of ["manifest.json", "doc.kiwi"]) await cache.delete(new Request(`${origin}/previews/${id}/${f}`));
}

// ---------------------------------------------------------------------------------------------------------------------
// The preview's Durable Object, as logic over SQLite (previewObject.ts gives it Cloudflare's storage)
// ---------------------------------------------------------------------------------------------------------------------

/** The part of Durable Object SQLite storage (`ctx.storage.sql`) the box uses; node:sqlite in tests. */
export interface SqlLike {
  exec<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): { toArray(): T[] };
}

export interface BoxHost {
  sql: SqlLike;
  /** All of `fn` or none of it (`ctx.storage.transactionSync`) */
  transaction(fn: () => void): void;
  now(): number;
  /** Schedules the object's deletion at `at` (null: none) */
  setAlarm(at: number | null): Promise<void>;
  /** Deletes everything the object stores */
  deleteAll(): Promise<void>;
  /** R2 (docs/cloud.md §1): the env's buckets and the preview's id (the object's name); absent: rows only */
  env?: StorageEnv;
  name?(): string | null;
}

/** The `files` rows as R2 names them (the lazy migration's table) */
const FILES: ChunkTable = { table: "files", cols: ["name"], name: ([n]) => n };

/**
 * One preview's storage: `meta` (the live manifest as JSON), `files` (name, idx, bytes) with names `doc` (live),
 * `doc:next` (staged by PUT /doc until the manifest) and `img:<sha1>`. On R2 (docs/cloud.md §1) each is one object
 * under `p/<id>/` indexed by the same name (a staged document's own key, renamed to `doc` in the index when it goes
 * live); the rows are what a preview stored before.
 */
export class PreviewBox {
  readonly objects: BoxObjects;
  private stepped = false;

  constructor(private host: BoxHost) {
    this.objects = new BoxObjects(host.sql, (fn) => host.transaction(fn), host.env ? boxObjectsHost(host.env, () => "default", () => (host.name?.() ? `p/${host.name()}/` : null)) : undefined);
  }

  /** The tables, again after a deleteAll (the object lives on with empty storage). */
  private ensure(): void {
    this.host.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.host.sql.exec(`CREATE TABLE IF NOT EXISTS files (name TEXT NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (name, idx))`);
    this.objects.ensure();
  }

  async fetch(req: Request): Promise<Response> {
    this.ensure();
    try {
      return await this.route(req);
    } finally {
      await this.objects.flush();
    }
  }

  private async route(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const m = req.method;
    if (path === "/box" && m === "DELETE") {
      await this.objects.dropAll();
      await this.host.deleteAll();
      return json({ ok: true });
    }
    // One old file moved to R2 per wake
    if (!this.stepped) {
      this.stepped = true;
      void this.objects.step([FILES]).catch((e) => console.error("r2: the preview's migration step failed", e));
    }
    if (path === "/box/doc" && m === "PUT") {
      await this.put("doc:next", new Uint8Array(await req.arrayBuffer()));
      return json({ ok: true });
    }
    if (path === "/box/images/missing" && m === "POST") {
      const { sha1s } = (await req.json()) as { sha1s: string[] };
      return json({ missing: sha1s.filter((s) => SHA1.test(s) && !this.has(`img:${s}`)) });
    }
    if (path === "/box/manifest" && m === "PUT") return this.publish((await req.json()) as PreviewManifest);

    const image = /^\/box\/images\/([0-9a-f]{40})$/.exec(path);
    if (image && m === "PUT") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_PREVIEW_IMAGE_BYTES) return json({ error: "image too large" }, 413);
      // Content-addressed: the bytes must be what the name says.
      if ((await sha1Hex(bytes)) !== image[1]) return json({ error: "the bytes don't match their SHA-1" }, 400);
      await this.put(`img:${image[1]}`, bytes);
      return json({ ok: true });
    }

    if (m !== "GET") return json({ error: "not found" }, 404);
    const manifest = this.manifest();
    if (!manifest) return json({ error: "no such preview" }, 404);
    if (previewExpired(manifest, this.host.now())) return json({ error: "this preview has expired" }, 410);
    if (path === "/box/manifest.json") return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json", "cache-control": "no-cache" } });
    if (path === "/box/doc.kiwi") return this.bytes("doc", "no-cache");
    if (image && manifest.images.includes(image[1])) return this.bytes(`img:${image[1]}`, "public, max-age=31536000, immutable");
    return json({ error: "not found" }, 404);
  }

  /** Expiry's alarm: the preview is gone once its time passed. */
  async alarm(): Promise<void> {
    this.ensure();
    const manifest = this.manifest();
    if (!manifest || previewExpired(manifest, this.host.now())) {
      await this.objects.dropAll();
      await this.host.deleteAll();
    }
    else if (manifest.expiresAt !== null) await this.host.setAlarm(manifest.expiresAt);
  }

  private async publish(manifest: PreviewManifest): Promise<Response> {
    const staged = this.has("doc:next");
    if (!staged && !this.has("doc")) return json({ error: "upload the document first" }, 409);
    const missing = manifest.images.filter((s) => !this.has(`img:${s}`));
    if (missing.length) return json({ error: "images missing", missing }, 409);
    const keep = new Set(manifest.images.map((s) => `img:${s}`));
    this.host.transaction(() => {
      if (staged) {
        this.host.sql.exec(`DELETE FROM files WHERE name = 'doc'`);
        this.host.sql.exec(`UPDATE files SET name = 'doc' WHERE name = 'doc:next'`);
        if (this.objects.hasObject("doc:next")) {
          this.objects.removeObject("doc");
          this.host.sql.exec(`UPDATE r2_index SET name = 'doc' WHERE name = 'doc:next'`);
        }
      }
      for (const name of this.objects.names("img:")) if (!keep.has(name)) this.objects.removeObject(name);
      this.host.sql.exec(`INSERT INTO meta (k, v) VALUES ('manifest', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, JSON.stringify(manifest));
      for (const { name } of this.host.sql.exec<{ name: string }>(`SELECT DISTINCT name FROM files WHERE name LIKE 'img:%'`).toArray()) {
        if (!keep.has(name)) this.host.sql.exec(`DELETE FROM files WHERE name = ?`, name);
      }
    });
    await this.host.setAlarm(manifest.expiresAt);
    return json({ ok: true });
  }

  private manifest(): PreviewManifest | null {
    const r = this.host.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'manifest'`).toArray()[0];
    return r ? (JSON.parse(r.v) as PreviewManifest) : null;
  }

  private has(name: string): boolean {
    return this.objects.hasObject(name) || this.host.sql.exec(`SELECT 1 FROM files WHERE name = ? AND idx = 0`, name).toArray().length > 0;
  }

  private async put(name: string, bytes: Uint8Array): Promise<void> {
    // A staged document has its own key (the live one keeps its own until the manifest swaps them)
    const keyName = name === "doc:next" ? `doc-${this.host.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` : name.replace(/^img:/, "img/");
    if (await this.objects.putObject(name, bytes, () => this.host.sql.exec(`DELETE FROM files WHERE name = ?`, name), keyName)) return;
    this.host.transaction(() => {
      this.host.sql.exec(`DELETE FROM files WHERE name = ?`, name);
      for (let i = 0, idx = 0; i < bytes.length || idx === 0; i += CHUNK, idx++) this.host.sql.exec(`INSERT INTO files (name, idx, bytes) VALUES (?, ?, ?)`, name, idx, bytes.slice(i, i + CHUNK).buffer);
    });
  }

  private bytes(name: string, cacheControl: string): Response {
    const rows = this.host.sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM files WHERE name = ? ORDER BY idx`, name).toArray();
    if (!rows.length) return this.objects.objectResponse(name, { "content-type": "application/octet-stream", "cache-control": cacheControl }) ?? json({ error: "not found" }, 404);
    const out = new Uint8Array(rows.reduce((n, r) => n + r.bytes.byteLength, 0));
    let at = 0;
    for (const r of rows) {
      out.set(new Uint8Array(r.bytes), at);
      at += r.bytes.byteLength;
    }
    return new Response(out, { headers: { "content-type": "application/octet-stream", "cache-control": cacheControl } });
  }
}

async function sha1Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
