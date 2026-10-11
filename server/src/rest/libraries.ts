/**
 * Components and styles (docs/multiplayer.md §16.7 "Libraries"): D1's `libraries` and `library_assets` (0012, plus
 * 0015's `node_id` and dates). Org libraries only (the store's local libraries aren't on the server); access is
 * `canUseLibrary` (docs/data.md §16.4).
 *
 *   GET /v1/teams/:team/components|component_sets|styles?page_size&after&before   the team's libraries' items
 *   GET /v1/files/:key/components|component_sets|styles                            the file's library (404: a branch)
 *   GET /v1/components/:key · /v1/component_sets/:key · /v1/styles/:key            one item
 *
 * Every answer is `{status: 200, error: false, meta: …}`. Items published before 0015 answer `node_id: null` and the
 * library's publish dates until they are published again. `containing_frame` isn't stored, so it is left out.
 */
import { canUseLibrary, reachOf } from "../libraries/access";
import { LIB_SELECT, type LibRow } from "../libraries/db";
import { RestError, iso, restJson, restUser, type RestCtx } from "./http";
import { libraryBlobPath, RENDER_URL_DAYS, signPath } from "./signedUrl";

type Kind = "components" | "component_sets" | "styles";
const KINDS: Record<Kind, string> = { components: "COMPONENT", component_sets: "COMPONENT_SET", styles: "STYLE" };

interface AssetRow {
  library_key: string;
  key: string;
  kind: string;
  name: string;
  description: string;
  style_type: string | null;
  thumbnail_sha1: string | null;
  node_id: string | null;
  created_at: number | null;
  updated_at: number | null;
  created_by: string | null;
  first_published_at: number;
  last_published_at: number;
  published_by: string | null;
  u_id: string | null;
  u_name: string | null;
  u_email: string | null;
}

const SELECT = `SELECT a.library_key, a.key, a.kind, a.name, a.description, a.style_type, a.thumbnail_sha1, a.node_id, a.created_at, a.updated_at, a.created_by,
  l.first_published_at, l.last_published_at, l.published_by, u.id AS u_id, u.name AS u_name, u.email AS u_email
  FROM library_assets a JOIN libraries l ON l.key = a.library_key LEFT JOIN users u ON u.id = COALESCE(a.created_by, l.published_by)`;
const LIVE = `a.removed_in IS NULL AND a.dependency_only = 0 AND l.status = 'published'`;

async function item(ctx: RestCtx, r: AssetRow) {
  return {
    key: r.key,
    file_key: r.library_key,
    node_id: r.node_id,
    thumbnail_url: r.thumbnail_sha1 ? await signPath(ctx.deps, ctx.url.origin, libraryBlobPath(r.library_key, r.thumbnail_sha1), RENDER_URL_DAYS) : null,
    name: r.name,
    description: r.description,
    updated_at: iso(r.updated_at ?? r.last_published_at),
    created_at: iso(r.created_at ?? r.first_published_at),
    user: r.u_id ? restUser({ id: r.u_id, name: r.u_name, email: r.u_email }) : null,
    ...(r.kind === "STYLE" ? { style_type: r.style_type ?? "FILL", sort_position: "" } : {}),
  };
}

async function usableLib(ctx: RestCtx, key: string): Promise<LibRow | null> {
  const lib = await ctx.acc.d1.prepare(`${LIB_SELECT} WHERE l.key = ?1`).bind(key).first<LibRow>();
  if (!lib) return null;
  return (await canUseLibrary(ctx.acc, lib)).length ? lib : null;
}

export async function librariesRestRoute(ctx: RestCtx): Promise<Response> {
  const { parts, url, acc } = ctx;
  if (ctx.caller.kind === "plan") throw new RestError(403, "A plan access token can't read libraries");
  const d1 = acc.d1;
  const [a, id, sub] = parts;

  if (a === "components" || a === "component_sets" || a === "styles") {
    if (!/^[0-9a-f]{40}$/.test(id)) throw new RestError(404, "Not found");
    const { results } = await d1.prepare(`${SELECT} WHERE a.key = ?1 AND a.kind = ?2 AND ${LIVE}`).bind(id, KINDS[a]).all<AssetRow>();
    for (const r of results) if (await usableLib(ctx, r.library_key)) return restJson({ status: 200, error: false, meta: await item(ctx, r) });
    throw new RestError(404, "Not found");
  }

  const kind = sub as Kind;
  if (!(kind in KINDS)) throw new RestError(404, "Not found");
  if (a === "files") {
    const f = await acc.fileRow(id);
    const fa = f ? await acc.file(f, { viaLink: true, passOk: false }) : null;
    if (!f || !fa?.ok) throw new RestError(404, "Not found");
    if (await acc.branch(id)) throw new RestError(404, "Branches have no published library");
    const lib = await usableLib(ctx, id);
    if (!lib) return restJson({ status: 200, error: false, meta: { [kind]: [] } });
    const { results } = await d1.prepare(`${SELECT} WHERE a.library_key = ?1 AND a.kind = ?2 AND ${LIVE} ORDER BY a.name COLLATE NOCASE, a.key`).bind(id, KINDS[kind]).all<AssetRow>();
    const items = [];
    for (const r of results) items.push(await item(ctx, r));
    return restJson({ status: 200, error: false, meta: { [kind]: items } });
  }

  // /v1/teams/:team/… — the libraries published from the team's files (team or org scope) the caller can use
  const { team } = await acc.requireTeam(id);
  const reach = await reachOf(acc, team.org_id);
  const { results: libs } = await d1.prepare(`${LIB_SELECT} WHERE f.team_id = ?1 AND l.status = 'published'`).bind(team.id).all<LibRow>();
  const keys: string[] = [];
  for (const lib of libs) if ((await canUseLibrary(acc, lib, reach)).length) keys.push(lib.key);
  const size = Math.max(1, Math.min(1000, Number(url.searchParams.get("page_size")) || 30));
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");
  const { results: all } = await d1
    .prepare(`${SELECT} WHERE a.library_key IN (SELECT value FROM json_each(?1)) AND a.kind = ?2 AND ${LIVE} ORDER BY a.name COLLATE NOCASE, a.key`)
    .bind(JSON.stringify(keys), KINDS[kind])
    .all<AssetRow>();
  // Cursors are positions in the list (Figma's are numbers too)
  let start = after !== null ? Math.max(0, Number(after) || 0) : 0;
  if (before !== null && after === null) start = Math.max(0, (Number(before) || 0) - size);
  const page = all.slice(start, start + size);
  const items = [];
  for (const r of page) items.push(await item(ctx, r));
  const cursor: Record<string, number> = {};
  if (start > 0) cursor.before = start;
  if (start + size < all.length) cursor.after = start + size;
  return restJson({ status: 200, error: false, meta: { [kind]: items, cursor } });
}
