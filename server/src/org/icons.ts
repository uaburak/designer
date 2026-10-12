/**
 * Organization and team names and icons (docs/multiplayer.md §14.16; Figma: Admin › Settings' organization name and
 * icon, a team's ⌄ menu → Rename / Change icon — help.figma.com 14949911189399):
 *
 *   PATCH  /orgs/:org {name}            {org: OrgInfo}    org admins; logged `org_rename` (ours)
 *   PUT    /orgs/:org/icon  <bytes>     {org: OrgInfo}    org admins; logged `org_icon_change` (ours)
 *   DELETE /orgs/:org/icon              {org: OrgInfo}
 *   PUT    /teams/:team/icon <bytes>    {team: TeamInfo}  the team's admins and owner, org admins, its workspace's admins
 *   DELETE /teams/:team/icon            {team: TeamInfo}  logged `team_icon_change` (ours); a rename is PATCH /teams/:team
 *   GET    /icons/:org/:sha1            the image — public, immutable (the hash names the bytes), edge-cached
 *
 * An upload is PNG, JPEG, WebP or GIF, ≤ 1 MB (the app sends a 256 × 256 square crop): refused by its declared length,
 * then its first bytes, before the rest is read (iconImage.ts). It counts as one of the uploader's uploads a day and
 * its bytes in their stored bytes (§17) as `o:<org>:icon:<sha1>` / `o:<org>:team:<team>:icon:<sha1>`; the replaced
 * icon's are released. The bytes live in the org's object (fonts/fontBox.ts `/image`), dropped once no row uses them.
 */
import type { OrgInfo, TeamInfo } from "../../../src/shared/org/types";
import { logActivity, orgEntity, teamEntity } from "../activity";
import type { Deps } from "../api";
import type { D1Like } from "../db";
import { fontObjects, objectFetch } from "../libraries/db";
import { orgNotice } from "../notifications";
import { chargeStored, countFor, releaseStorage, reserveStorage } from "../quota/quota";
import { throttle } from "../quota/throttle";
import type { Access, TeamRow } from "./db";
import { body, cleanName, HttpError, json, type Ctx } from "./http";
import { ICON_TOO_LARGE, MAX_ICON_BYTES, readIconBody } from "./iconImage";

/** Where an icon is served: a route of ours, relative to the server (as OrgFile.thumbnailUrl) */
export const iconUrl = (orgId: string, hash: string | null | undefined): string | null => (hash ? `/icons/${orgId}/${hash}` : null);

const orgItem = (orgId: string) => `o:${orgId}:icon:`;
const teamItem = (orgId: string, teamId: string) => `o:${orgId}:team:${teamId}:icon:`;

/**
 * Reads, checks, stores and charges an icon upload: the uploader's daily count and stored bytes (the declared size
 * before the body is read, the size as read after), the body (iconImage.ts), the org's object. → its SHA-1.
 */
async function storeIcon(ctx: Ctx, orgId: string, prefix: string): Promise<string> {
  const { deps, user, req } = ctx;
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_ICON_BYTES) throw new HttpError(413, ICON_TOO_LARGE, "too_large");
  await countFor(deps, user, "uploads_per_day");
  const reservation = await reserveStorage(deps, user.id, `${prefix}new`, declared);
  const { bytes } = await readIconBody(req);
  reservation.check(bytes.length);
  const res = await objectFetch(fontObjects(deps), orgId, "/image", { method: "PUT", body: bytes.slice().buffer as ArrayBuffer });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({ error: "the image was refused" }))) as { error: string };
    throw new HttpError(res.status === 413 ? 413 : 400, e.error);
  }
  const { sha1 } = (await res.json()) as { sha1: string };
  // The replaced icon's bytes leave whoever uploaded it; the new ones are the uploader's
  await releaseStorage(deps.db.d1, prefix);
  await chargeStored(deps, user.id, `${prefix}${sha1}`, bytes.length);
  return sha1;
}

/** An image no org or team row of the org uses any more leaves its object */
async function dropUnused(deps: Deps, orgId: string, hash: string | null | undefined): Promise<void> {
  if (!hash) return;
  const d1 = deps.db.d1;
  const used = await d1
    .prepare(`SELECT 1 AS x FROM orgs WHERE id = ?1 AND icon_hash = ?2 UNION ALL SELECT 1 FROM teams WHERE org_id = ?1 AND icon_hash = ?2 LIMIT 1`)
    .bind(orgId, hash)
    .first();
  if (!used) await objectFetch(fontObjects(deps), orgId, `/image/${hash}`, { method: "DELETE" }).catch(() => undefined);
}

async function orgUserIds(d1: D1Like, orgId: string): Promise<string[]> {
  const { results } = await d1.prepare(`SELECT user_id FROM org_members WHERE org_id = ?1 AND user_id IS NOT NULL`).bind(orgId).all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

/** Everyone in the org hears the list and the org changed (Home's space switcher, sidebar, Admin's header) */
async function tellOrg(deps: Deps, orgId: string): Promise<void> {
  const ids = await orgUserIds(deps.db.d1, orgId);
  await orgNotice(deps, ids, { what: "orgs" });
  await orgNotice(deps, ids, { what: "org", orgId });
}

/** PATCH /orgs/:org, PUT|DELETE /orgs/:org/icon (orgs.ts dispatches here) */
export async function orgSettingsRoute(ctx: Ctx, orgId: string, info: (acc: Access, orgId: string) => Promise<OrgInfo>): Promise<Response> {
  const { parts, m, acc, deps, user } = ctx;
  await acc.requireOrgAdmin(orgId);
  const org = (await acc.org(orgId))!;
  const now = deps.now();
  const log = (action: "org_rename" | "org_icon_change", details: Record<string, unknown>, name = org.name) => logActivity(deps, { orgId, action, actor: user, entity: orgEntity({ id: orgId, name }), details, req: ctx.req });
  if (parts.length === 2 && m === "PATCH") {
    const b = await body<{ name?: unknown }>(ctx.req);
    if (b.name === undefined) throw new HttpError(400, "name");
    const name = cleanName(b.name, "name", 100);
    if (name !== org.name) {
      await acc.d1.prepare(`UPDATE orgs SET name = ?2, updated_at = ?3 WHERE id = ?1`).bind(orgId, name, now).run();
      await log("org_rename", { old_name: org.name }, name);
      acc.reset();
      await tellOrg(deps, orgId);
    }
    return json({ org: await info(acc, orgId) });
  }
  if (parts.length === 3 && parts[2] === "icon" && (m === "PUT" || m === "DELETE")) {
    const old = org.icon_hash ?? null;
    if (m === "PUT") {
      const hash = await storeIcon(ctx, orgId, orgItem(orgId));
      await acc.d1.prepare(`UPDATE orgs SET icon_hash = ?2, updated_at = ?3 WHERE id = ?1`).bind(orgId, hash, now).run();
      if (hash !== old) await dropUnused(deps, orgId, old);
      await log("org_icon_change", { from: old, to: hash });
    } else if (old) {
      await acc.d1.prepare(`UPDATE orgs SET icon_hash = NULL, updated_at = ?2 WHERE id = ?1`).bind(orgId, now).run();
      await releaseStorage(deps.db.d1, orgItem(orgId));
      await dropUnused(deps, orgId, old);
      await log("org_icon_change", { from: old, to: null });
    }
    acc.reset();
    await tellOrg(deps, orgId);
    return json({ org: await info(acc, orgId) });
  }
  throw new HttpError(405, "method not allowed");
}

/** PUT|DELETE /teams/:team/icon (teams.ts dispatches here once the team's admin rights are checked) */
export async function teamIconRoute(ctx: Ctx, team: TeamRow, reread: () => Promise<TeamInfo>, tell: () => Promise<void>): Promise<Response> {
  const { m, acc, deps, user } = ctx;
  const old = team.icon_hash ?? null;
  const now = deps.now();
  const log = (details: Record<string, unknown>) => logActivity(deps, { orgId: team.org_id, action: "team_icon_change", actor: user, entity: teamEntity(team), teamId: team.id, details, req: ctx.req });
  if (m === "PUT") {
    const hash = await storeIcon(ctx, team.org_id, teamItem(team.org_id, team.id));
    // An upload replaces a data: URL icon of before 0020 too
    await acc.d1.prepare(`UPDATE teams SET icon_hash = ?2, icon = NULL, updated_at = ?3 WHERE id = ?1`).bind(team.id, hash, now).run();
    if (hash !== old) await dropUnused(deps, team.org_id, old);
    await log({ from: old, to: hash });
  } else if (m === "DELETE") {
    if (old || team.icon) {
      await acc.d1.prepare(`UPDATE teams SET icon_hash = NULL, icon = NULL, updated_at = ?2 WHERE id = ?1`).bind(team.id, now).run();
      await releaseStorage(deps.db.d1, teamItem(team.org_id, team.id));
      await dropUnused(deps, team.org_id, old);
      await log({ from: old, to: null });
    }
  } else throw new HttpError(405, "method not allowed");
  acc.reset();
  await tell();
  return json({ team: await reread() });
}

/** Workers' default cache (absent in Node's tests) */
function edgeCache(): { match(r: Request): Promise<Response | undefined>; put(r: Request, res: Response): Promise<void> } | null {
  const c = (globalThis as { caches?: { default?: unknown } }).caches?.default;
  return c ? (c as ReturnType<typeof edgeCache>) : null;
}

/**
 * GET /icons/:org/:sha1, before any session: an org's or a team's icon, to anyone who has its URL (invitations reach
 * people outside the org). Only hashes a row of that org uses are served; the answer never changes, so it is cached
 * for a year and at the edge.
 */
export async function publicIconRoute(req: Request, deps: Deps, orgId: string, hash: string): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
  await throttle(deps, req, "public");
  const cache = edgeCache();
  const key = new Request(new URL(req.url).origin + `/icons/${orgId}/${hash}`);
  const hit = cache ? await cache.match(key) : undefined;
  if (hit) return hit;
  const used = await deps.db.d1
    .prepare(`SELECT 1 AS x FROM orgs WHERE id = ?1 AND icon_hash = ?2 UNION ALL SELECT 1 FROM teams WHERE org_id = ?1 AND icon_hash = ?2 AND deleted_at IS NULL LIMIT 1`)
    .bind(orgId, hash)
    .first();
  if (!used) throw new HttpError(404, "no such icon");
  const res = await objectFetch(fontObjects(deps), orgId, `/image/${hash}`);
  if (!res.ok) throw new HttpError(404, "no such icon");
  const out = new Response(res.body, {
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      etag: `"${hash}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "access-control-allow-origin": "*",
    },
  });
  if (cache) {
    const put = cache.put(key, out.clone());
    if (deps.waitUntil) deps.waitUntil(put);
    else await put;
  }
  return out;
}
