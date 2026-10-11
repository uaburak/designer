/**
 * Files (docs/multiplayer.md §16.7 "Files"): the document and renders are jobs (§16.6); metadata, image fills and
 * versions come from D1 and the room.
 *
 *   GET /v1/files/:key?version&ids&depth&geometry=paths&plugin_data&branch_data    job `file`
 *   GET /v1/files/:key/nodes?ids&version&depth&geometry&plugin_data                job `nodes`
 *   GET /v1/images/:key?ids&scale&format&svg_*&contents_only&use_absolute_bounds&version   job `images`
 *   GET /v1/files/:key/images            image fills (the room's blobs) → signed URLs
 *   GET /v1/files/:key/meta              D1
 *   GET /v1/files/:key/versions?page_size&before&after   the room's versions
 *
 * The `file` / `nodes` part is the answer's JSON, gzipped, **without its opening `{`** and without `role`,
 * `thumbnailUrl`, `branches` and `mainFileKey`: those depend on the caller or on D1, and the Worker puts them first as a
 * gzip member of its own — so a cached part serves everyone without the Worker reading it.
 */
import type { FileParams, ImagesParams, RestJob } from "../../../src/shared/rest/types";
import type { FileRow } from "../org/db";
import { fileFor, type FileAccess } from "./access";
import { RestError, editorTypeOf, iso, restJson, restUser, type RestCtx } from "./http";
import { backendFor } from "./render";
import { jsonFromPart, NO_CLIENT, partBytes, wantedFor } from "./jobs";
import { blobPath, FILL_URL_DAYS, RENDER_URL_DAYS, signPath, thumbnailPath } from "./signedUrl";

const NODE_ID = /^I?-?\d+:\d+(;-?\d+:\d+)*$/;
const VERSION = /^[0-9A-Za-z]{16}$/;

const list = (v: string | null): string[] => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/** Figma accepts "1-2" in URLs; our ids are "1:2" */
const nodeId = (s: string): string => s.split(";").map((x) => x.replace(/^(I?-?\d+)-(\d+)$/, "$1:$2")).join(";");
const bool = (v: string | null, def: boolean): boolean => (v === null ? def : v === "true" || v === "1");

function fileParams(url: URL): FileParams {
  const p: FileParams = {};
  const ids = list(url.searchParams.get("ids")).map(nodeId);
  if (ids.length) {
    if (ids.length > 1000 || !ids.every((i) => NODE_ID.test(i))) throw new RestError(400, "Invalid ids");
    p.ids = ids;
  }
  const depth = url.searchParams.get("depth");
  if (depth !== null) {
    const d = Number(depth);
    if (!Number.isInteger(d) || d < 1) throw new RestError(400, "Invalid depth");
    p.depth = d;
  }
  const geometry = url.searchParams.get("geometry");
  if (geometry !== null) {
    if (geometry !== "paths") throw new RestError(400, "Invalid geometry");
    p.geometry = "paths";
  }
  const pd = list(url.searchParams.get("plugin_data"));
  if (pd.length) p.plugin_data = pd;
  if (bool(url.searchParams.get("branch_data"), false)) p.branch_data = true;
  return p;
}

function versionParam(url: URL): string | undefined {
  const v = url.searchParams.get("version");
  if (v === null || v === "") return undefined;
  if (!VERSION.test(v)) throw new RestError(400, "Invalid version");
  return v;
}

/** The per-caller fields the Worker writes before the part's own (`{"role":…,"thumbnailUrl":…,…,`) */
async function prefixOf(ctx: RestCtx, fa: FileAccess, branchData: boolean): Promise<string> {
  const { f, a } = fa;
  const fields: Record<string, unknown> = {
    role: a.role === "owner" ? "owner" : a.canEdit ? "editor" : "viewer",
    thumbnailUrl: await signPath(ctx.deps, ctx.url.origin, thumbnailPath(f.key), RENDER_URL_DAYS),
  };
  const branch = await ctx.acc.branch(f.key);
  if (branch) fields.mainFileKey = branch.main_key;
  if (branchData && !branch) fields.branches = await branchesOf(ctx, f.key);
  return `{${Object.entries(fields).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")},`;
}

/** `branch_data=true`: Figma's `{key, name, thumbnail_url, last_modified, link_access}` per active branch */
export async function branchesOf(ctx: RestCtx, mainKey: string) {
  const { results } = await ctx.deps.db.d1
    .prepare(`SELECT b.key, b.name, f.updated_at, f.link_access FROM branches b JOIN files f ON f.key = b.key WHERE b.main_key = ?1 AND b.status = 'active' ORDER BY b.created_at`)
    .bind(mainKey)
    .all<{ key: string; name: string; updated_at: number; link_access: string }>();
  const out = [];
  for (const r of results) out.push({ key: r.key, name: r.name, thumbnail_url: await signPath(ctx.deps, ctx.url.origin, thumbnailPath(r.key), RENDER_URL_DAYS), last_modified: iso(r.updated_at), link_access: linkAccessOf(r.link_access, "none") });
  return out;
}

/** Figma's `link_access`: view | edit | org_view | org_edit | inherit */
export function linkAccessOf(link: string, org: string): string {
  if (link === "editor") return "edit";
  if (link === "viewer") return "view";
  if (org === "editor") return "org_edit";
  if (org === "viewer") return "org_view";
  return "inherit";
}

async function run(ctx: RestCtx, f: FileRow, job: RestJob) {
  return backendFor(ctx.deps, f.key, { wanted: await wantedFor(ctx.deps, f.key) }).run(job);
}

export async function filesRoute(ctx: RestCtx): Promise<Response> {
  const { parts, url, deps } = ctx;
  if (parts[0] === "images") return images(ctx, parts[1]);
  const key = parts[1];
  const sub = parts[2];

  if (!sub || sub === "nodes") {
    const fa = await fileFor(ctx, key);
    const params = fileParams(url);
    if (sub === "nodes" && !params.ids) throw new RestError(400, "ids is required");
    const version = versionParam(url);
    const job: RestJob = sub === "nodes" ? { kind: "nodes", params: params as FileParams & { ids: string[] }, ...(version ? { version } : {}) } : { kind: "file", params, ...(version ? { version } : {}) };
    const r = await run(ctx, fa.f, job);
    if (!r.ok) throw new RestError(r.status, r.err);
    const part = r.parts.find((p) => p.name === "json");
    const bytes = part ? await partBytes(deps, key, part) : null;
    if (!bytes) throw new RestError(500, "The render's result is missing");
    await logRestView(ctx, fa.f);
    return jsonFromPart(ctx.req, bytes, await prefixOf(ctx, fa, params.branch_data === true), ctx.headers ?? {});
  }
  if (sub === "images" && parts.length === 3) {
    const { f } = await fileFor(ctx, key);
    const res = await deps.rooms.fetch(key, `/room/rest-images?fileKey=${key}`, { method: "GET" });
    const { sha1s } = res.ok ? ((await res.json()) as { sha1s: string[] }) : { sha1s: [] };
    const images: Record<string, string> = {};
    for (const s of sha1s) images[s] = await signPath(deps, url.origin, blobPath(f.key, s), FILL_URL_DAYS);
    return restJson({ error: false, status: 200, meta: { images } });
  }
  if (sub === "meta" && parts.length === 3) {
    const { f, a } = await fileFor(ctx, key);
    const d1 = deps.db.d1;
    const folder = f.project_id ? await d1.prepare(`SELECT name FROM projects WHERE id = ?1`).bind(f.project_id).first<{ name: string }>() : null;
    const owner = await deps.db.user(f.owner_id);
    const head = await deps.rooms.fetch(key, "/room/head", { method: "GET" });
    const lastSeq = head.ok ? ((await head.json()) as { lastSeq: number }).lastSeq : 0;
    await logRestView(ctx, f);
    return restJson({
      file: {
        name: f.name,
        folder_name: folder?.name ?? null,
        last_touched_at: iso(f.updated_at),
        creator: owner ? restUser(owner) : null,
        last_touched_by: null,
        thumbnail_url: await signPath(deps, url.origin, thumbnailPath(f.key), RENDER_URL_DAYS),
        editorType: editorTypeOf(f.editor_type),
        version: String(lastSeq),
        role: a.role === "owner" ? "owner" : a.canEdit ? "editor" : "viewer",
        link_access: linkAccessOf(f.link_access, f.org_link_access),
        url: `${url.origin}/f/${f.key}`,
      },
    });
  }
  if (sub === "versions" && parts.length === 3) {
    await fileFor(ctx, key);
    const res = await deps.rooms.fetch(key, "/room/versions", { method: "GET" });
    const all = res.ok ? ((await res.json()) as { versions: { id: string; title: string | null; description: string | null; createdAt: number; user: { id: string | null; name: string | null } }[] }).versions : [];
    const size = Math.max(1, Math.min(50, Number(url.searchParams.get("page_size")) || 30));
    const before = url.searchParams.get("before");
    const after = url.searchParams.get("after");
    let start = 0;
    let end = all.length;
    if (before) {
      const i = all.findIndex((v) => v.id === before);
      start = i < 0 ? all.length : i + 1;
      end = Math.min(all.length, start + size);
    } else if (after) {
      const i = all.findIndex((v) => v.id === after);
      end = i < 0 ? 0 : i;
      start = Math.max(0, end - size);
    } else end = Math.min(all.length, size);
    const page = all.slice(start, end);
    const link = (k: string, v: string) => `${url.origin}/v1/files/${key}/versions?page_size=${size}&${k}=${v}`;
    return restJson({
      versions: page.map((v) => ({ id: v.id, created_at: iso(v.createdAt), label: v.title, description: v.description, user: v.user.id ? restUser({ id: v.user.id, name: v.user.name }) : null, thumbnail_url: "" })),
      pagination: { ...(start > 0 && page.length ? { prev_page: link("after", page[0].id) } : {}), ...(end < all.length && page.length ? { next_page: link("before", page[page.length - 1].id) } : {}) },
    });
  }
  throw new RestError(404, "Not found");
}

async function images(ctx: RestCtx, key: string): Promise<Response> {
  const { url, deps } = ctx;
  const fa = await fileFor(ctx, key);
  const ids = list(url.searchParams.get("ids")).map(nodeId);
  if (!ids.length) throw new RestError(400, "ids is required");
  if (ids.length > 1000 || !ids.every((i) => NODE_ID.test(i))) throw new RestError(400, "Invalid ids");
  const scale = url.searchParams.get("scale") === null ? 1 : Number(url.searchParams.get("scale"));
  if (!Number.isFinite(scale) || scale < 0.01 || scale > 4) throw new RestError(400, "scale is between 0.01 and 4");
  const format = (url.searchParams.get("format") ?? "png").toLowerCase();
  if (format !== "png" && format !== "jpg" && format !== "svg" && format !== "pdf") throw new RestError(400, "format is jpg, png, svg or pdf");
  const q = url.searchParams;
  const params: ImagesParams = {
    ids,
    scale,
    format,
    svg_outline_text: bool(q.get("svg_outline_text"), true),
    svg_include_id: bool(q.get("svg_include_id"), false),
    svg_include_node_id: bool(q.get("svg_include_node_id"), false),
    svg_simplify_stroke: bool(q.get("svg_simplify_stroke"), true),
    contents_only: bool(q.get("contents_only"), true),
    use_absolute_bounds: bool(q.get("use_absolute_bounds"), false),
  };
  const version = versionParam(url);
  const r = await run(ctx, fa.f, { kind: "images", params, ...(version ? { version } : {}) });
  const out: Record<string, string | null> = Object.fromEntries(ids.map((i) => [i, null]));
  if (!r.ok) {
    if (r.status === 503) return restJson({ status: 503, err: NO_CLIENT, images: out }, 503, ctx.headers);
    throw new RestError(r.status, r.err);
  }
  for (const p of r.parts) if (p.name in out) out[p.name] = await signPath(deps, url.origin, blobPath(key, p.sha1, format), RENDER_URL_DAYS);
  await logRestView(ctx, fa.f);
  return restJson({ err: null, images: out }, 200, ctx.headers);
}

/**
 * Reads of org files log `fig_file_view` with `client_name: "REST API"`, at most once per token (or session) per file
 * per hour (§16.5; ours).
 */
export async function logRestView(ctx: RestCtx, f: FileRow): Promise<void> {
  if (!f.org_id) return;
  const d1 = ctx.deps.db.d1;
  const now = ctx.deps.now();
  const who = ctx.caller.tokenId ?? "session";
  try {
    const seen = await d1
      .prepare(`SELECT 1 AS x FROM activity_log WHERE org_id = ?1 AND action = 'fig_file_view' AND entity_id = ?2 AND actor_id = ?3 AND client_name = 'REST API' AND json_extract(details, '$.token_id') = ?4 AND at > ?5 LIMIT 1`)
      .bind(f.org_id, f.key, ctx.caller.user.id, who, now - 3_600_000)
      .first();
    if (seen) return;
    const { fileEntity } = await import("../activity");
    const { type, id, ...fields } = fileEntity(f);
    await d1
      .prepare(
        `INSERT INTO activity_log (org_id, at, action, actor_id, actor_email, actor_name, entity_type, entity_id, entity, details, team_id, ip, client_name)
         VALUES (?1, ?2, 'fig_file_view', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'REST API')`,
      )
      .bind(f.org_id, now, ctx.caller.user.id, ctx.caller.user.email, ctx.caller.user.name, type, id, JSON.stringify(fields), JSON.stringify({ token_id: who }), f.team_id, ctx.req.headers.get("cf-connecting-ip"))
      .run();
  } catch (e) {
    console.error("rest: view not logged", e);
  }
}
