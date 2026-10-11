/**
 * Private plugins of an organization (docs/plugins.md §10.1; D1 `plugins` and `plugin_chunks`, migration 0015). Any
 * member publishes (no review); the publisher or an org admin updates and deletes (ours: Figma lets only the
 * publisher change access); guests can't list, download or publish.
 *
 * Publishing is three steps, as the libraries' (data.md §16.6):
 *   POST /orgs/:org/plugins {manifest, parts: {name, sha1, size}[], name?, description?, pluginId?}
 *        → {plugin, version, missing: string[]}
 *        Reserves the next version: a new plugin gets its 19-digit id (a version-0 row nobody lists until its first
 *        commit); `pluginId` names one to update. The pending manifest and part list are kept as the version's
 *        `.meta` chunk. Parts unchanged since the current version are copied server-side; the rest are `missing`.
 *   PUT  /plugins/:id/parts/:version/:name   bytes (≤ 10 MB; SHA-1 and size checked) → 204; stored in ≤ 1 MB chunks
 *   POST /plugins/:id/versions/:version/commit                                     → {plugin}
 *        Every part present with its SHA-1 → the version becomes current. Older versions than the previous one are
 *        dropped. Logged `private_plugin_publish` (first) / `private_plugin_update`.
 *
 *   GET    /orgs/:org/plugins?kind=        → {plugins: PrivatePlugin[]}
 *   GET    /plugins/:id                    → {plugin}
 *   GET    /plugins/:id/parts/:version/:name → bytes, immutable (the current or the previous version)
 *   PATCH  /plugins/:id {name?, description?} → {plugin}   (`private_plugin_update`)
 *   DELETE /plugins/:id                    → 204, soft (`deleted_at`; `private_plugin_delete`)
 *
 * Part names: `code`, `ui` (a single ui file) or `ui:<key>` (a `ui` map). Widgets are refused ("Widgets aren't
 * supported in DesignerV2 yet", §11).
 */
import type { PluginKind, PluginManifest, PrivatePlugin } from "../../../src/shared/plugins/types";
import type { ActivityAction } from "../../../src/shared/org/types";
import type { D1Like, User } from "../db";
import type { Deps } from "../api";
import { logActivity } from "../activity";
import { inboxMessage } from "../notifications";
import { body, HttpError, json, noContent, type Ctx } from "../org/http";
import { orgUserIds } from "../org/orgs";

export const MAX_PART_BYTES = 10 * 1024 * 1024;
export const CHUNK_BYTES = 1024 * 1024;
export const MAX_PARTS = 50;
const META = ".meta";
const PART = /^(code|ui|ui:[A-Za-z0-9_.-]{1,64})$/;
export const PLUGIN_ID = /^[1-9][0-9]{18}$/;

export interface PluginRow {
  id: string;
  org_id: string;
  kind: PluginKind;
  name: string;
  description: string;
  manifest: string;
  version: number;
  parts: string;
  published_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  publisher_name?: string | null;
  publisher_email?: string | null;
}

interface PartDecl {
  name: string;
  sha1: string;
  size: number;
}

interface Pending {
  manifest: PluginManifest;
  parts: PartDecl[];
  name: string;
  description: string;
}

/** A 19-digit decimal id, as Figma's plugin ids */
export function newPluginId(): string {
  const b = crypto.getRandomValues(new Uint8Array(19));
  let s = String((b[0] % 9) + 1);
  for (let i = 1; i < 19; i++) s += String(b[i] % 10);
  return s;
}

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const parse = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function toPlugin(r: PluginRow, canManage: boolean): PrivatePlugin {
  return {
    id: r.id,
    orgId: r.org_id,
    kind: r.kind,
    name: r.name,
    description: r.description,
    manifest: parse<PluginManifest>(r.manifest, { name: r.name, id: r.id, api: "1.0.0", main: "code.js" }),
    version: r.version,
    publishedBy: r.published_by ? { id: r.published_by, name: r.publisher_name || r.publisher_email || null } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    canManage,
  };
}

const SELECT = `SELECT p.*, u.name AS publisher_name, u.email AS publisher_email FROM plugins p LEFT JOIN users u ON u.id = p.published_by`;

export async function pluginRow(d1: D1Like, id: string): Promise<PluginRow | null> {
  if (!PLUGIN_ID.test(id)) return null;
  return d1.prepare(`${SELECT} WHERE p.id = ?1`).bind(id).first<PluginRow>();
}

export async function privatePlugins(d1: D1Like, orgId: string, kind: PluginKind | null): Promise<PluginRow[]> {
  const { results } = await d1.prepare(`${SELECT} WHERE p.org_id = ?1 AND p.deleted_at IS NULL AND p.version > 0 AND (?2 IS NULL OR p.kind = ?2) ORDER BY p.name COLLATE NOCASE`).bind(orgId, kind).all<PluginRow>();
  return results;
}

/** The caller manages it: its publisher, or an org admin */
async function canManage(ctx: Ctx, r: PluginRow): Promise<boolean> {
  if (r.published_by === ctx.user.id) return true;
  return (await ctx.acc.membership(r.org_id))?.role === "admin";
}

/** A plugin of an org the caller is a member of (not a guest): 404 otherwise */
async function memberPlugin(ctx: Ctx, id: string, opts: { pending?: boolean } = {}): Promise<PluginRow> {
  const r = await pluginRow(ctx.acc.d1, id);
  if (!r || r.deleted_at !== null || (r.version === 0 && !opts.pending)) throw new HttpError(404, "no such plugin");
  const m = await ctx.acc.membership(r.org_id);
  if (!m) throw new HttpError(404, "no such plugin");
  if (m.role === "guest") throw new HttpError(403, "guests can't use private plugins", "forbidden");
  return r;
}

export const kindParam = (url: URL): PluginKind | null => {
  const k = url.searchParams.get("kind");
  if (k === null) return null;
  if (k !== "plugin" && k !== "widget") throw new HttpError(400, "kind is plugin or widget");
  return k;
};

function cleanManifest(v: unknown): PluginManifest {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "manifest is the plugin's manifest.json");
  const m = v as Record<string, unknown>;
  if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 100) throw new HttpError(400, "manifest.name is required (≤ 100 characters)");
  if (typeof m.main !== "string" || !m.main) throw new HttpError(400, "manifest.main is required");
  if (typeof m.api !== "string" || !m.api) throw new HttpError(400, "manifest.api is required");
  if (m.containsWidget === true || m.widgetApi !== undefined) throw new HttpError(400, "Widgets aren't supported in DesignerV2 yet");
  if (JSON.stringify(m).length > 64 * 1024) throw new HttpError(413, "the manifest is too large");
  return m as unknown as PluginManifest;
}

function cleanParts(v: unknown): PartDecl[] {
  if (!Array.isArray(v) || !v.length || v.length > MAX_PARTS) throw new HttpError(400, `parts is a list of 1–${MAX_PARTS} {name, sha1, size}`);
  const seen = new Set<string>();
  const out: PartDecl[] = [];
  for (const p of v as Record<string, unknown>[]) {
    const name = p?.name;
    if (typeof name !== "string" || !PART.test(name)) throw new HttpError(400, `a part is named code, ui or ui:<key>`);
    if (seen.has(name)) throw new HttpError(400, `part ${name} is listed twice`);
    seen.add(name);
    if (typeof p.sha1 !== "string" || !/^[0-9a-f]{40}$/.test(p.sha1)) throw new HttpError(400, `part ${name}: sha1 is 40 hex digits`);
    if (typeof p.size !== "number" || !Number.isInteger(p.size) || p.size < 0 || p.size > MAX_PART_BYTES) throw new HttpError(413, `part ${name}: at most ${MAX_PART_BYTES} bytes`);
    out.push({ name, sha1: p.sha1, size: p.size });
  }
  if (!seen.has("code")) throw new HttpError(400, "the code part is required");
  return out;
}

async function readChunks(d1: D1Like, id: string, version: number, part: string): Promise<Uint8Array | null> {
  const { results } = await d1.prepare(`SELECT bytes FROM plugin_chunks WHERE plugin_id = ?1 AND version = ?2 AND part = ?3 ORDER BY idx`).bind(id, version, part).all<{ bytes: ArrayBuffer | Uint8Array | number[] }>();
  if (!results.length) return null;
  // D1 answers a BLOB as an ArrayBuffer (or, in older runtimes, an array of numbers); node:sqlite as a Uint8Array
  const parts = results.map((r) => (r.bytes instanceof Uint8Array ? r.bytes : r.bytes instanceof ArrayBuffer ? new Uint8Array(r.bytes) : Uint8Array.from(r.bytes)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function writeChunks(d1: D1Like, id: string, version: number, part: string, bytes: Uint8Array): Promise<void> {
  await d1.prepare(`DELETE FROM plugin_chunks WHERE plugin_id = ?1 AND version = ?2 AND part = ?3`).bind(id, version, part).run();
  for (let i = 0, idx = 0; i < bytes.byteLength || idx === 0; i += CHUNK_BYTES, idx++) {
    await d1.prepare(`INSERT INTO plugin_chunks (plugin_id, version, part, idx, bytes) VALUES (?1, ?2, ?3, ?4, ?5)`).bind(id, version, part, idx, bytes.slice(i, i + CHUNK_BYTES)).run();
  }
}

async function pendingOf(d1: D1Like, r: PluginRow, version: number): Promise<Pending> {
  if (version !== r.version + 1) throw new HttpError(409, `version ${version} isn't being published (the current one is ${r.version})`, "stale");
  const meta = await readChunks(d1, r.id, version, META);
  if (!meta) throw new HttpError(409, "publish the plugin first (POST /orgs/:org/plugins)", "stale");
  return JSON.parse(new TextDecoder().decode(meta)) as Pending;
}

async function log(ctx: Ctx, r: { id: string; name: string; org_id: string; kind: PluginKind }, action: ActivityAction, details: Record<string, unknown> = {}): Promise<void> {
  await logActivity(ctx.deps, { orgId: r.org_id, action, actor: ctx.user, entity: { type: r.kind, id: r.id, name: r.name }, details, req: ctx.req });
}

/** The org's open apps refresh their private plugins (the store's "plugins" topic) */
async function tellOrg(deps: Deps, orgId: string): Promise<void> {
  await inboxMessage(deps, await orgUserIds(deps.db.d1, orgId), { t: "plugins", orgId });
}

/** `/orgs/:org/plugins` GET and POST (the requests are approvals.ts's) */
export async function orgPluginsRoute(ctx: Ctx, orgId: string): Promise<Response> {
  const { m, url, acc, deps, user } = ctx;
  const me = await acc.requireMember(orgId);
  const d1 = acc.d1;
  if (m === "GET") {
    const rows = await privatePlugins(d1, orgId, kindParam(url));
    return json({ plugins: rows.map((r) => toPlugin(r, r.published_by === user.id || me.role === "admin")) });
  }
  if (m !== "POST") throw new HttpError(405, "method not allowed");
  const b = await body<{ manifest?: unknown; parts?: unknown; name?: unknown; description?: unknown; pluginId?: unknown }>(ctx.req);
  const manifest = cleanManifest(b.manifest);
  const parts = cleanParts(b.parts);
  const name = (typeof b.name === "string" && b.name.trim() ? b.name : manifest.name).trim().slice(0, 100);
  const description = typeof b.description === "string" ? b.description.trim().slice(0, 1000) : "";
  const now = deps.now();
  let r: PluginRow;
  if (typeof b.pluginId === "string") {
    const found = await pluginRow(d1, b.pluginId);
    if (!found || found.org_id !== orgId || found.deleted_at !== null) throw new HttpError(404, "no such plugin");
    if (!(await canManage(ctx, found))) throw new HttpError(403, "only its publisher or an admin can update this plugin");
    r = found;
  } else {
    const id = newPluginId();
    await d1
      .prepare(`INSERT INTO plugins (id, org_id, kind, name, description, manifest, version, parts, published_by, created_at, updated_at) VALUES (?1, ?2, 'plugin', ?3, ?4, ?5, 0, '{}', ?6, ?7, ?7)`)
      .bind(id, orgId, name, description, JSON.stringify({ ...manifest, id }), user.id, now)
      .run();
    r = (await pluginRow(d1, id))!;
  }
  const version = r.version + 1;
  // A clean slate for this version (a retried publish), the pending meta, then what is unchanged copied over
  await d1.prepare(`DELETE FROM plugin_chunks WHERE plugin_id = ?1 AND version = ?2`).bind(r.id, version).run();
  const pending: Pending = { manifest: { ...manifest, id: r.id }, parts, name, description };
  await writeChunks(d1, r.id, version, META, new TextEncoder().encode(JSON.stringify(pending)));
  const current = parse<Record<string, { sha1: string; size: number }>>(r.parts, {});
  const missing: string[] = [];
  for (const p of parts) {
    if (r.version > 0 && current[p.name]?.sha1 === p.sha1) {
      await d1.prepare(`INSERT INTO plugin_chunks (plugin_id, version, part, idx, bytes) SELECT plugin_id, ?3, part, idx, bytes FROM plugin_chunks WHERE plugin_id = ?1 AND version = ?2 AND part = ?4`).bind(r.id, r.version, version, p.name).run();
    } else missing.push(p.name);
  }
  return json({ plugin: toPlugin({ ...r, name: r.version === 0 ? name : r.name }, true), version, missing });
}

/** `/plugins/:id…` */
export async function pluginsRoute(ctx: Ctx): Promise<Response> {
  const { m, parts, acc, deps, req } = ctx;
  const d1 = acc.d1;
  const id = parts[1] ?? "";
  if (parts.length === 2) {
    const r = await memberPlugin(ctx, id);
    if (m === "GET") return json({ plugin: toPlugin(r, await canManage(ctx, r)) });
    if (!(await canManage(ctx, r))) throw new HttpError(403, "only its publisher or an admin can change this plugin");
    if (m === "PATCH") {
      const b = await body<{ name?: unknown; description?: unknown }>(req);
      const name = b.name === undefined ? r.name : typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 100) : null;
      if (name === null) throw new HttpError(400, "name is required");
      const description = b.description === undefined ? r.description : typeof b.description === "string" ? b.description.trim().slice(0, 1000) : r.description;
      await d1.prepare(`UPDATE plugins SET name = ?2, description = ?3, updated_at = ?4 WHERE id = ?1`).bind(r.id, name, description, deps.now()).run();
      await log(ctx, { ...r, name }, r.kind === "widget" ? "private_widget_update" : "private_plugin_update", { name, description });
      await tellOrg(deps, r.org_id);
      return json({ plugin: toPlugin((await pluginRow(d1, r.id))!, true) });
    }
    if (m === "DELETE") {
      await d1.prepare(`UPDATE plugins SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1`).bind(r.id, deps.now()).run();
      await d1.prepare(`DELETE FROM plugin_chunks WHERE plugin_id = ?1`).bind(r.id).run();
      await log(ctx, r, r.kind === "widget" ? "private_widget_delete" : "private_plugin_delete");
      await tellOrg(deps, r.org_id);
      return noContent();
    }
    throw new HttpError(405, "method not allowed");
  }
  // /plugins/:id/parts/:version/:name
  if (parts[2] === "parts" && parts.length === 5) {
    const version = Number(parts[3]);
    const name = parts[4];
    if (!Number.isInteger(version) || version < 1 || !PART.test(name)) throw new HttpError(404, "no such part");
    if (m === "GET") {
      const r = await memberPlugin(ctx, id);
      if (version > r.version || version < r.version - 1) throw new HttpError(404, "no such version");
      const bytes = await readChunks(d1, r.id, version, name);
      if (!bytes) throw new HttpError(404, "no such part");
      return new Response(bytes, { headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=31536000, immutable" } });
    }
    if (m === "PUT") {
      const r = await memberPlugin(ctx, id, { pending: true });
      if (!(await canManage(ctx, r))) throw new HttpError(403, "only its publisher or an admin can publish this plugin");
      const pending = await pendingOf(d1, r, version);
      const decl = pending.parts.find((p) => p.name === name);
      if (!decl) throw new HttpError(400, `part ${name} isn't in this version`);
      if (Number(req.headers.get("content-length") ?? "0") > MAX_PART_BYTES) throw new HttpError(413, `at most ${MAX_PART_BYTES} bytes`);
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.byteLength > MAX_PART_BYTES) throw new HttpError(413, `at most ${MAX_PART_BYTES} bytes`);
      if (bytes.byteLength !== decl.size || (await sha1Hex(bytes)) !== decl.sha1) throw new HttpError(400, `part ${name} doesn't match its SHA-1 and size`);
      await writeChunks(d1, r.id, version, name, bytes);
      return noContent();
    }
    throw new HttpError(405, "method not allowed");
  }
  // /plugins/:id/versions/:version/commit
  if (parts[2] === "versions" && parts[4] === "commit" && parts.length === 5 && m === "POST") {
    const r = await memberPlugin(ctx, id, { pending: true });
    if (!(await canManage(ctx, r))) throw new HttpError(403, "only its publisher or an admin can publish this plugin");
    const version = Number(parts[3]);
    if (!Number.isInteger(version)) throw new HttpError(404, "no such version");
    const pending = await pendingOf(d1, r, version);
    const stored: Record<string, { sha1: string; size: number }> = {};
    const missing: string[] = [];
    for (const p of pending.parts) {
      const bytes = await readChunks(d1, r.id, version, p.name);
      if (!bytes || bytes.byteLength !== p.size || (await sha1Hex(bytes)) !== p.sha1) missing.push(p.name);
      else stored[p.name] = { sha1: p.sha1, size: p.size };
    }
    if (missing.length) throw new HttpError(409, `parts missing: ${missing.join(", ")}`, "conflict", { missing });
    const now = deps.now();
    const done = await d1
      .prepare(`UPDATE plugins SET version = ?2, manifest = ?3, parts = ?4, name = ?5, description = ?6, updated_at = ?7, created_at = CASE WHEN version = 0 THEN ?7 ELSE created_at END WHERE id = ?1 AND version = ?8 RETURNING id`)
      .bind(r.id, version, JSON.stringify(pending.manifest), JSON.stringify(stored), pending.name, pending.description, now, version - 1)
      .first();
    if (!done) throw new HttpError(409, "another publish of this plugin finished first", "stale");
    await d1.prepare(`DELETE FROM plugin_chunks WHERE plugin_id = ?1 AND (version < ?2 OR (version = ?3 AND part = ?4))`).bind(r.id, version - 1, version, META).run();
    const first = version === 1;
    await log(ctx, { ...r, name: pending.name }, first ? (r.kind === "widget" ? "private_widget_publish" : "private_plugin_publish") : r.kind === "widget" ? "private_widget_update" : "private_plugin_update", { version });
    await tellOrg(deps, r.org_id);
    return json({ plugin: toPlugin((await pluginRow(d1, r.id))!, true) });
  }
  throw new HttpError(404, "not found");
}

export type { User };
