/**
 * People and folders (docs/multiplayer.md §16.7 "People and folders"). Teams and folders exist in orgs only (decision 9);
 * a caller sees what `Access` lets them see (a Limited folder only to its people).
 *
 *   GET /v1/me                                        {id, email, handle, img_url}
 *   GET /v2/teams/:team/folders                       {folders: {id, name, parent_folder_id: null}[]}
 *   GET /v2/folders/:id/folders · /files?branch_data  {folders} · {files: {key, name, thumbnail_url, last_modified, branches?}[]}
 *   GET /v2/folders/:id/meta                          {id, name, thumbnail_url, file_count, updated_at, created_at}
 *   GET /v1/teams/:team/projects · /v1/projects/:id/files · /v1/projects/:id/meta   the deprecated twins
 */
import { accessibleFiles, type ProjectRow } from "../org/db";
import { branchesOf } from "./files";
import { RestError, iso, restJson, type RestCtx } from "./http";
import { RENDER_URL_DAYS, signPath, thumbnailPath } from "./signedUrl";

export async function meRoute(ctx: RestCtx): Promise<Response> {
  if (ctx.caller.kind === "plan") throw new RestError(403, "A plan access token has no user");
  const u = ctx.caller.user;
  return restJson({ id: u.id, email: u.email, handle: u.name || u.email, img_url: null });
}

async function folder(ctx: RestCtx, id: string): Promise<ProjectRow> {
  const p = await ctx.acc.project(id);
  if (!p || p.trashed_at !== null) throw new RestError(404, "Not found");
  const a = await ctx.acc.container(p.team_id, p.id);
  if (!a.ok || a.trashed) throw new RestError(404, "Not found");
  return p;
}

async function visibleFolders(ctx: RestCtx, rows: ProjectRow[]) {
  const out: { id: string; name: string; parent_folder_id: string | null }[] = [];
  for (const p of rows) {
    const a = await ctx.acc.container(p.team_id, p.id);
    if (a.ok && !a.trashed) out.push({ id: p.id, name: p.name, parent_folder_id: p.parent_id });
  }
  return out;
}

async function filesIn(ctx: RestCtx, id: string, branchData: boolean) {
  const files = await accessibleFiles(ctx.acc, `f.project_id = ?1 AND f.trashed_at IS NULL`, [id]);
  const out = [];
  for (const f of files) {
    out.push({
      key: f.key,
      name: f.name,
      thumbnail_url: await signPath(ctx.deps, ctx.url.origin, thumbnailPath(f.key), RENDER_URL_DAYS),
      last_modified: iso(f.updatedAt),
      ...(branchData ? { branches: await branchesOf(ctx, f.key) } : {}),
    });
  }
  return out;
}

async function meta(ctx: RestCtx, p: ProjectRow) {
  const c = await ctx.deps.db.d1.prepare(`SELECT COUNT(*) AS n FROM files WHERE project_id = ?1 AND trashed_at IS NULL`).bind(p.id).first<{ n: number }>();
  return { id: p.id, name: p.name, thumbnail_url: null, file_count: c?.n ?? 0, updated_at: iso(p.updated_at), created_at: iso(p.created_at) };
}

export async function teamsRestRoute(ctx: RestCtx): Promise<Response> {
  const { parts, version, url, acc } = ctx;
  if (ctx.caller.kind === "plan") throw new RestError(403, "A plan access token can't list folders");
  const branchData = url.searchParams.get("branch_data") === "true";
  const [a, id, sub] = parts;
  if (a === "teams") {
    const { team } = await acc.requireTeam(id);
    const { results } = await acc.d1.prepare(`SELECT * FROM projects WHERE team_id = ?1 AND parent_id IS NULL AND trashed_at IS NULL ORDER BY name`).bind(team.id).all<ProjectRow>();
    const folders = await visibleFolders(ctx, results);
    if (version === "v2") return restJson({ folders });
    return restJson({ name: team.name, projects: folders.map((f) => ({ id: f.id, name: f.name })) });
  }
  const p = await folder(ctx, id);
  if (sub === "meta") return restJson(await meta(ctx, p));
  if (sub === "files") {
    const files = await filesIn(ctx, p.id, branchData);
    return restJson(version === "v2" ? { files } : { name: p.name, files });
  }
  if (sub === "folders") {
    const { results } = await acc.d1.prepare(`SELECT * FROM projects WHERE parent_id = ?1 AND trashed_at IS NULL ORDER BY name`).bind(p.id).all<ProjectRow>();
    return restJson({ folders: await visibleFolders(ctx, results) });
  }
  throw new RestError(404, "Not found");
}
