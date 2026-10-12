/**
 * Shared fonts (docs/desktop.md §14.3): organization fonts (org admins upload) and team fonts (the team's admins and
 * owner, and org admins), one D1 row per face (`shared_fonts`, migration 0012), the bytes in the org's `FontObject`.
 *
 *   GET    /me/fonts                                     SharedFontList: every face the caller may use
 *   GET    /orgs/:org/fonts?team=<id>                    {faces}: Admin › Resources › Fonts; "View team's fonts"
 *   POST   /orgs/:org/fonts/check {teamId?, families}    {conflicts: FontConflict[]}
 *   PUT    /orgs/:org/fonts?team=&onConflict=skip|replace   the file; x-font-faces (base64 JSON), x-font-file-name,
 *                                                        x-font-licence: confirmed → FontUploadAnswer; 409 conflict {families}
 *   DELETE /orgs/:org/fonts/:id · DELETE /orgs/:org/fonts?team=&family=   {faces} left in the scope
 *   GET    /fonts/:sha1                                  the file, to whoever may use a face with it
 *
 * Who gets them: org fonts the org's members and admins — not guests (the owner's default, round 3); team fonts the
 * team's members (its own rows, groups invited to it, its owner — guests in the team included). After a change the
 * people concerned hear `{t: "fonts", orgId, version}` (main refreshes its list).
 */
import type { FontConflict, FontUploadAnswer, SharedFontFace, SharedFontFaceInput, SharedFontList } from "../../../src/shared/fonts/sharedTypes";
import type { D1Like } from "../db";
import { body, HttpError, json, randomId, type Ctx } from "../org/http";
import { inboxMessage } from "../notifications";
import { fontObjects, objectFetch } from "../libraries/db";
import { sha1Hex } from "../libraries/libraryBox";
import { MAX_FONT_BYTES } from "./fontBox";
import { chargeStored, guardedUpload, releaseStorage } from "../quota/quota";

/** Ours (Figma states none): faces per org, org and team fonts together */
export const MAX_FACES_PER_ORG = 200;

interface FaceRow {
  id: string;
  org_id: string;
  team_id: string | null;
  family: string;
  style: string;
  postscript_name: string;
  weight: number;
  italic: number;
  stretch: number;
  variable: number;
  sha1: string;
  format: "ttf" | "otf";
  size: number;
  file_name: string;
  uploaded_by: string | null;
  uploaded_at: number;
  uploader_name: string | null;
}

const toFace = (r: FaceRow): SharedFontFace => ({
  id: r.id,
  family: r.family,
  style: r.style,
  postscriptName: r.postscript_name,
  weight: r.weight,
  italic: r.italic === 1,
  stretch: r.stretch,
  variable: r.variable === 1,
  sha1: r.sha1,
  format: r.format,
  size: r.size,
  fileName: r.file_name,
  orgId: r.org_id,
  teamId: r.team_id,
  uploadedAt: r.uploaded_at,
  uploadedBy: r.uploaded_by ? { id: r.uploaded_by, name: r.uploader_name } : null,
});

const SELECT = `SELECT sf.*, u.name AS uploader_name FROM shared_fonts sf LEFT JOIN users u ON u.id = sf.uploaded_by`;

/** Faces `userId` may use: their orgs' org fonts (members and admins) and their teams' fonts */
const USABLE = `((sf.team_id IS NULL AND sf.org_id IN (SELECT m.org_id FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ?1 AND m.role IN ('admin', 'member') AND o.deleted_at IS NULL))
  OR sf.team_id IN (SELECT t.id FROM teams t WHERE t.deleted_at IS NULL AND (t.owner_id = ?1
    OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = ?1)
    OR EXISTS (SELECT 1 FROM group_grants g JOIN user_group_members gm ON gm.group_id = g.group_id WHERE g.resource_type = 'team' AND g.resource_id = t.id AND gm.user_id = ?1))))`;

const ORDER = `ORDER BY sf.family COLLATE NOCASE, sf.weight, sf.italic, sf.style`;

async function versionOf(ids: string[]): Promise<string> {
  return (await sha1Hex(new TextEncoder().encode([...ids].sort().join(",")))).slice(0, 16);
}

/** GET /me/fonts */
export async function meFontsRoute(ctx: Ctx): Promise<Response> {
  if (ctx.parts.length !== 2 || ctx.m !== "GET") throw new HttpError(405, "method not allowed");
  const { results } = await ctx.acc.d1.prepare(`${SELECT} WHERE ${USABLE} ${ORDER}`).bind(ctx.user.id).all<FaceRow>();
  const faces = results.map(toFace);
  const out: SharedFontList = { version: await versionOf(faces.map((f) => f.id)), faces };
  return json(out);
}

/** GET /fonts/:sha1 */
export async function fontFileRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, acc, deps, user } = ctx;
  if (parts.length !== 2 || m !== "GET" || !/^[0-9a-f]{40}$/.test(parts[1])) throw new HttpError(404, "not found");
  const row = await acc.d1.prepare(`${SELECT} WHERE sf.sha1 = ?2 AND ${USABLE} LIMIT 1`).bind(user.id, parts[1]).first<FaceRow>();
  if (!row) throw new HttpError(404, "no such font");
  const res = await objectFetch(fontObjects(deps), row.org_id, `/font/${row.sha1}`, {}, { env: deps.env });
  if (!res.ok) throw new HttpError(404, "no such font");
  return new Response(res.body, { headers: { "content-type": row.format === "otf" ? "font/otf" : "font/ttf", "cache-control": "private, max-age=31536000, immutable" } });
}

/** The scope a request names, and whether the caller may upload to / remove from it */
async function scopeOf(ctx: Ctx, orgId: string, teamId: string | null, write: boolean): Promise<{ teamId: string | null; teamName: string | null }> {
  const { acc } = ctx;
  if (!teamId) {
    if (write) await acc.requireOrgAdmin(orgId);
    else await acc.requireMember(orgId);
    return { teamId: null, teamName: null };
  }
  await acc.requireMember(orgId, { guests: true });
  const { team, rights } = await acc.requireTeam(teamId);
  if (team.org_id !== orgId || team.deleted_at !== null) throw new HttpError(404, "no such team");
  if (write ? !(rights.teamAdmin || rights.owner || rights.orgAdmin) : !(rights.inTeam || rights.admin)) {
    throw new HttpError(403, write ? "only the team's admins can change its fonts" : "only the team's members can see its fonts", write ? "not_admin" : "forbidden");
  }
  return { teamId: team.id, teamName: team.name };
}

const scopeFaces = async (d1: D1Like, orgId: string, teamId: string | null): Promise<SharedFontFace[]> =>
  (await d1.prepare(`${SELECT} WHERE sf.org_id = ?1 AND COALESCE(sf.team_id, '') = ?2 ${ORDER}`).bind(orgId, teamId ?? "").all<FaceRow>()).results.map(toFace);

async function conflictsIn(d1: D1Like, orgId: string, teamId: string | null, families: string[]): Promise<FontConflict[]> {
  if (!families.length) return [];
  const { results } = await d1
    .prepare(`SELECT MIN(family) AS family, COUNT(*) AS n FROM shared_fonts WHERE org_id = ?1 AND COALESCE(team_id, '') = ?2 AND lower(family) IN (SELECT lower(value) FROM json_each(?3)) GROUP BY lower(family)`)
    .bind(orgId, teamId ?? "", JSON.stringify(families))
    .all<{ family: string; n: number }>();
  return results.map((r) => ({ family: families.find((f) => f.toLowerCase() === r.family.toLowerCase()) ?? r.family, existing: r.n }));
}

/** Bytes no row of the org uses any more leave its object */
async function dropUnused(ctx: Ctx, orgId: string, sha1s: Iterable<string>): Promise<void> {
  for (const sha1 of new Set(sha1s)) {
    const used = await ctx.acc.d1.prepare(`SELECT 1 AS x FROM shared_fonts WHERE org_id = ?1 AND sha1 = ?2 LIMIT 1`).bind(orgId, sha1).first();
    if (!used) {
      await objectFetch(fontObjects(ctx.deps), orgId, `/font/${sha1}`, { method: "DELETE" });
      await releaseStorage(ctx.deps.db.d1, `o:${orgId}:font:${sha1}`);
    }
  }
}

/** `{t: "fonts", orgId, version}` to the people the scope's fonts reach */
async function fontsNotice(ctx: Ctx, orgId: string, teamId: string | null): Promise<void> {
  const d1 = ctx.acc.d1;
  const { results } = teamId
    ? await d1
        .prepare(
          `SELECT owner_id AS id FROM teams WHERE id = ?1
           UNION SELECT user_id FROM team_members WHERE team_id = ?1 AND user_id IS NOT NULL
           UNION SELECT gm.user_id FROM group_grants g JOIN user_group_members gm ON gm.group_id = g.group_id WHERE g.resource_type = 'team' AND g.resource_id = ?1`,
        )
        .bind(teamId)
        .all<{ id: string }>()
    : await d1.prepare(`SELECT user_id AS id FROM org_members WHERE org_id = ?1 AND role IN ('admin', 'member') AND user_id IS NOT NULL`).bind(orgId).all<{ id: string }>();
  const version = await versionOf((await scopeFaces(d1, orgId, teamId)).map((f) => f.id));
  await inboxMessage(ctx.deps, results.map((r) => r.id), { t: "fonts", orgId, version });
}

function cleanFaces(v: unknown): SharedFontFaceInput[] {
  if (!Array.isArray(v) || !v.length || v.length > MAX_FACES_PER_ORG) throw new HttpError(400, "x-font-faces lists the file's faces");
  const str = (x: unknown, what: string) => {
    if (typeof x !== "string" || !x.trim() || x.length > 200) throw new HttpError(400, `a face's ${what}`);
    return x.trim();
  };
  return v.map((f: Record<string, unknown>) => {
    const weight = Number(f?.weight);
    const stretch = f?.stretch === undefined ? 5 : Number(f.stretch);
    if (!Number.isInteger(weight) || weight < 1 || weight > 1000) throw new HttpError(400, "a face's weight is 1–1000");
    if (!Number.isInteger(stretch) || stretch < 1 || stretch > 9) throw new HttpError(400, "a face's stretch is 1–9");
    return { family: str(f.family, "family"), style: str(f.style, "style"), postscriptName: str(f.postscriptName, "postscriptName"), weight, italic: f.italic === true, stretch, variable: f.variable === true };
  });
}

/** /orgs/:org/fonts… (api.ts dispatches `parts[2] === "fonts"` here) */
export async function orgFontsRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, url, req, acc, deps, user } = ctx;
  const orgId = parts[1];
  const d1 = acc.d1;
  const teamParam = url.searchParams.get("team") || null;

  if (parts.length === 3 && m === "GET") {
    const s = await scopeOf(ctx, orgId, teamParam, false);
    return json({ faces: await scopeFaces(d1, orgId, s.teamId) });
  }
  if (parts.length === 4 && parts[3] === "check" && m === "POST") {
    const b = await body<{ teamId?: unknown; families?: unknown }>(req);
    const s = await scopeOf(ctx, orgId, typeof b.teamId === "string" ? b.teamId : null, true);
    if (!Array.isArray(b.families) || b.families.length > MAX_FACES_PER_ORG || !b.families.every((f) => typeof f === "string")) throw new HttpError(400, "families is a list of names");
    return json({ conflicts: await conflictsIn(d1, orgId, s.teamId, [...new Set(b.families as string[])]) });
  }
  if (parts.length === 3 && m === "PUT") {
    const s = await scopeOf(ctx, orgId, teamParam, true);
    if (req.headers.get("x-font-licence") !== "confirmed") throw new HttpError(400, "confirm you have the necessary rights and licenses to use the fonts (x-font-licence: confirmed)");
    let faces: SharedFontFaceInput[];
    try {
      faces = cleanFaces(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(req.headers.get("x-font-faces") ?? ""), (c) => c.charCodeAt(0)))));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "x-font-faces is base64 JSON");
    }
    let fileName = req.headers.get("x-font-file-name") ?? "";
    try {
      fileName = decodeURIComponent(fileName);
    } catch {
      // as sent
    }
    fileName = fileName.trim().slice(0, 200);
    if (!fileName) throw new HttpError(400, "x-font-file-name");
    if (/\.(ttc|otc|woff2?)$/i.test(fileName)) throw new HttpError(400, "only .ttf and .otf fonts can be uploaded");
    const onConflict = url.searchParams.get("onConflict");
    if (onConflict !== null && onConflict !== "skip" && onConflict !== "replace") throw new HttpError(400, "onConflict is skip or replace");
    if (Number(req.headers.get("content-length") ?? "0") > MAX_FONT_BYTES) throw new HttpError(413, "the font file is larger than 50 MB");

    // One row per style of a family: a file listing the same style twice keeps the first.
    const seen = new Set<string>();
    faces = faces.filter((f) => {
      const k = `${f.family.toLowerCase()}\u0000${f.style.toLowerCase()}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
    const families = [...new Set(faces.map((f) => f.family))];
    const conflicts = await conflictsIn(d1, orgId, s.teamId, families);
    if (conflicts.length && !onConflict) throw new HttpError(409, "a family with that name was already uploaded", "conflict", { families: conflicts.map((c) => c.family) });
    const clash = new Set(conflicts.map((c) => c.family.toLowerCase()));
    const replaced = onConflict === "replace" ? conflicts.map((c) => c.family) : [];
    if (onConflict === "skip") faces = faces.filter((f) => !clash.has(f.family.toLowerCase()));
    if (!faces.length) {
      const nothing: FontUploadAnswer = { uploaded: [], replaced: [] };
      return json(nothing);
    }
    const count = await d1
      .prepare(`SELECT COUNT(*) AS n FROM shared_fonts WHERE org_id = ?1 AND NOT (COALESCE(team_id, '') = ?2 AND lower(family) IN (SELECT value FROM json_each(?3)))`)
      .bind(orgId, s.teamId ?? "", JSON.stringify(replaced.map((f) => f.toLowerCase())))
      .first<{ n: number }>();
    if ((count?.n ?? 0) + faces.length > MAX_FACES_PER_ORG) throw new HttpError(400, `an organization holds at most ${MAX_FACES_PER_ORG} font styles`);

    // The bytes first (the object checks the format and computes the SHA-1), then the rows.
    // Daily uploads and stored bytes (docs/multiplayer.md §17), charged to the uploader by the font's SHA-1 once known
    const up = await guardedUpload(deps, req, ctx.user, { ownerId: ctx.user.id, item: `o:${orgId}:font:new` }, MAX_FONT_BYTES, "the font file is larger than 50 MB");
    const res = await objectFetch(fontObjects(deps), orgId, "/font", { method: "PUT", body: up.body });
    if (!res.ok) {
      const e = (await res.json().catch(() => ({ error: "the font was refused" }))) as { error: string };
      throw new HttpError(res.status === 413 ? 413 : 400, e.error);
    }
    const stored = (await res.json()) as { sha1: string; format: "ttf" | "otf"; size: number };
    await chargeStored(deps, ctx.user.id, `o:${orgId}:font:${stored.sha1}`, up.body.byteLength);
    let oldSha1s: string[] = [];
    if (replaced.length) {
      const { results } = await d1
        .prepare(`DELETE FROM shared_fonts WHERE org_id = ?1 AND COALESCE(team_id, '') = ?2 AND lower(family) IN (SELECT value FROM json_each(?3)) RETURNING sha1`)
        .bind(orgId, s.teamId ?? "", JSON.stringify(replaced.map((f) => f.toLowerCase())))
        .all<{ sha1: string }>();
      oldSha1s = results.map((r) => r.sha1);
    }
    const now = deps.now();
    const rows = faces.map((f) => ({ id: randomId(16), ...f, italic: f.italic ? 1 : 0, variable: f.variable ? 1 : 0 }));
    await d1
      .prepare(
        `INSERT INTO shared_fonts (id, org_id, team_id, family, style, postscript_name, weight, italic, stretch, variable, sha1, format, size, file_name, uploaded_by, uploaded_at)
         SELECT e.value ->> 'id', ?1, ?2, e.value ->> 'family', e.value ->> 'style', e.value ->> 'postscriptName', e.value ->> 'weight', e.value ->> 'italic',
                e.value ->> 'stretch', e.value ->> 'variable', ?3, ?4, ?5, ?6, ?7, ?8 FROM json_each(?9) AS e`,
      )
      .bind(orgId, s.teamId, stored.sha1, stored.format, stored.size, fileName, user.id, now, JSON.stringify(rows))
      .run();
    await dropUnused(ctx, orgId, oldSha1s.filter((x) => x !== stored.sha1));
    await fontsNotice(ctx, orgId, s.teamId);
    const ids = new Set(rows.map((r) => r.id));
    const answer: FontUploadAnswer = { uploaded: (await scopeFaces(d1, orgId, s.teamId)).filter((f) => ids.has(f.id)), replaced };
    return json(answer, 201);
  }
  if (m === "DELETE" && (parts.length === 4 || parts.length === 3)) {
    let teamId: string | null;
    let gone: { sha1: string }[];
    if (parts.length === 4) {
      const row = await d1.prepare(`SELECT team_id FROM shared_fonts WHERE org_id = ?1 AND id = ?2`).bind(orgId, parts[3]).first<{ team_id: string | null }>();
      if (!row) {
        await acc.requireMember(orgId, { guests: true });
        throw new HttpError(404, "no such font");
      }
      teamId = (await scopeOf(ctx, orgId, row.team_id, true)).teamId;
      gone = (await d1.prepare(`DELETE FROM shared_fonts WHERE org_id = ?1 AND id = ?2 RETURNING sha1`).bind(orgId, parts[3]).all<{ sha1: string }>()).results;
    } else {
      const family = url.searchParams.get("family");
      if (!family) throw new HttpError(400, "family, or a face's id");
      teamId = (await scopeOf(ctx, orgId, teamParam, true)).teamId;
      gone = (await d1.prepare(`DELETE FROM shared_fonts WHERE org_id = ?1 AND COALESCE(team_id, '') = ?2 AND lower(family) = lower(?3) RETURNING sha1`).bind(orgId, teamId ?? "", family).all<{ sha1: string }>()).results;
    }
    if (gone.length) {
      await dropUnused(ctx, orgId, gone.map((g) => g.sha1));
      await fontsNotice(ctx, orgId, teamId);
    }
    return json({ faces: await scopeFaces(d1, orgId, teamId) });
  }
  throw new HttpError(404, "not found");
}
