/**
 * Admin › Settings › Encryption key management (docs/governance.md §2.10, §4) — managed keys only:
 *
 *   GET  /orgs/:org/admin/key-management                EkmStatus (the root key is tried on the org's key: `checkedAt`)
 *   PUT  /orgs/:org/admin/key-management {source}       turns it on (Governance+ only, 403 `governance_plus_required`):
 *                                                       a new DEK wrapped under EKM_ROOT_KEY; `ekm_enable`. Again: as is.
 *   POST /orgs/:org/admin/key-management/encrypt-next   encrypts ONE file not encrypted yet (its room seals its rows);
 *                                                       EkmStatus with `encrypting` = that file (null when none was
 *                                                       left); `fig_file_encrypt`. The Admin page calls it in a loop.
 *
 * Org admins only. Key management can't be turned off (no DELETE). Files are encrypted on their room's next wake anyway
 * (ekm/room.ts); `encrypt-next` is for files nobody opens.
 */
import type { EkmStatus } from "../../../src/shared/org/governance";
import { fileEntity, logActivity } from "../activity";
import { body, HttpError, json, type Ctx } from "../org/http";
import { KeyUnavailable, newWrappedDek, unwrapDek, type EkmEnv } from "./keys";

interface KeyRow {
  source: "managed";
  wrapped_dek: string;
  state: "ok" | "unavailable";
  checked_at: number | null;
}

/** Dispatched by api.ts for `/orgs/:org/admin/key-management…` */
export async function keyManagementRoute(ctx: Ctx): Promise<Response> {
  const { parts, m } = ctx;
  const orgId = parts[1];
  const rest = parts.slice(4);
  await ctx.acc.requireOrgAdmin(orgId);
  if (!rest.length && m === "GET") return json(await ekmStatus(ctx, orgId, null, true));
  if (!rest.length && m === "PUT") {
    const { source } = await body<{ source?: unknown }>(ctx.req);
    if (source !== "managed") throw new HttpError(400, "source is managed");
    return json(await enable(ctx, orgId));
  }
  if (rest[0] === "encrypt-next" && rest.length === 1 && m === "POST") return json(await encryptNext(ctx, orgId));
  if (!rest.length && m === "DELETE") throw new HttpError(405, "key management can't be turned off");
  throw new HttpError(404, "not found");
}

const rootSecret = (ctx: Ctx) => (ctx.deps.env as EkmEnv).EKM_ROOT_KEY;

async function keyRow(ctx: Ctx, orgId: string): Promise<KeyRow | null> {
  return ctx.deps.db.d1.prepare(`SELECT source, wrapped_dek, state, checked_at FROM org_keys WHERE org_id = ?1`).bind(orgId).first<KeyRow>();
}

async function orgName(ctx: Ctx, orgId: string): Promise<string> {
  return (await ctx.deps.db.d1.prepare(`SELECT name FROM orgs WHERE id = ?1`).bind(orgId).first<{ name: string }>())?.name ?? "";
}

/** `check`: try the root key on the org's key and record the answer (state, checked_at) */
export async function ekmStatus(ctx: Ctx, orgId: string, encrypting: string | null, check = false): Promise<EkmStatus> {
  const d1 = ctx.deps.db.d1;
  let k = await keyRow(ctx, orgId);
  if (k && check) {
    const now = ctx.deps.now();
    let state: KeyRow["state"] = "ok";
    try {
      await unwrapDek(rootSecret(ctx), orgId, k.wrapped_dek);
    } catch (e) {
      if (!(e instanceof KeyUnavailable)) throw e;
      state = "unavailable";
    }
    await d1.prepare(`UPDATE org_keys SET state = ?2, checked_at = ?3, updated_at = CASE WHEN state = ?2 THEN updated_at ELSE ?3 END WHERE org_id = ?1`).bind(orgId, state, now).run();
    if (state === "unavailable" && k.state !== "unavailable") {
      await logActivity(ctx.deps, { orgId, action: "ekm_key_unavailable", actor: null, entity: { type: "org", id: orgId, name: await orgName(ctx, orgId) }, details: { source: "managed" }, req: ctx.req });
    }
    k = { ...k, state, checked_at: now };
  }
  const f = await d1.prepare(`SELECT COUNT(*) AS total, COUNT(encrypted_at) AS encrypted FROM files WHERE org_id = ?1`).bind(orgId).first<{ total: number; encrypted: number }>();
  return {
    enabled: !!k,
    source: k ? k.source : null,
    state: k ? k.state : null,
    checkedAt: k ? k.checked_at : null,
    files: { total: f?.total ?? 0, encrypted: k ? (f?.encrypted ?? 0) : 0 },
    encrypting,
  };
}

async function enable(ctx: Ctx, orgId: string): Promise<EkmStatus> {
  const { deps, user } = ctx;
  const d1 = deps.db.d1;
  if (await keyRow(ctx, orgId)) return ekmStatus(ctx, orgId, null);
  const org = await d1.prepare(`SELECT name, governance_plus FROM orgs WHERE id = ?1`).bind(orgId).first<{ name: string; governance_plus: number }>();
  if (!org) throw new HttpError(404, "no such organization");
  if (org.governance_plus !== 1) throw new HttpError(403, "encryption key management needs Governance+", "governance_plus_required");
  let wrapped: string;
  try {
    wrapped = await newWrappedDek(rootSecret(ctx), orgId);
  } catch (e) {
    if (e instanceof KeyUnavailable) throw new HttpError(503, "the server's root key isn't set up (EKM_ROOT_KEY)", "key_unavailable");
    throw e;
  }
  const now = deps.now();
  const { results } = await d1
    .prepare(`INSERT INTO org_keys (org_id, source, wrapped_dek, state, checked_at, created_by, created_at, updated_at) VALUES (?1, 'managed', ?2, 'ok', ?3, ?4, ?3, ?3) ON CONFLICT (org_id) DO NOTHING RETURNING org_id`)
    .bind(orgId, wrapped, now, user.id)
    .all<{ org_id: string }>();
  // Rooms awake now learn it at their hourly check or next wake; encrypt-next asks them at once.
  if (results.length) await logActivity(deps, { orgId, action: "ekm_enable", actor: user, entity: { type: "org", id: orgId, name: org.name }, details: { source: "managed" }, req: ctx.req });
  return ekmStatus(ctx, orgId, null);
}

async function encryptNext(ctx: Ctx, orgId: string): Promise<EkmStatus> {
  const { deps, user } = ctx;
  const d1 = deps.db.d1;
  const k = await keyRow(ctx, orgId);
  if (!k) throw new HttpError(409, "turn on encryption key management first");
  const file = await d1
    .prepare(`SELECT key, name, editor_type, link_access, proto_link_access, team_id FROM files WHERE org_id = ?1 AND encrypted_at IS NULL ORDER BY key LIMIT 1`)
    .bind(orgId)
    .first<{ key: string; name: string; editor_type?: string; link_access?: string; proto_link_access?: string; team_id: string | null }>();
  if (!file) return ekmStatus(ctx, orgId, null);
  const res = await deps.rooms.fetch(file.key, `/room/ekm/encrypt?fileKey=${encodeURIComponent(file.key)}`, { method: "POST" });
  if (res.status === 503) {
    const b = (await res.json().catch(() => ({}))) as { code?: string };
    if (b.code === "moving") throw new HttpError(503, "this file is moving to another region; try again in a moment");
    throw new HttpError(503, "the encryption key is unavailable", "key_unavailable");
  }
  if (!res.ok) throw new HttpError(502, `encrypting ${file.key} failed: ${res.status} ${await res.text().catch(() => "")}`.trim());
  const { sealed } = (await res.json().catch(() => ({}))) as { sealed?: number };
  const { results } = await d1.prepare(`UPDATE files SET encrypted_at = ?2 WHERE key = ?1 AND encrypted_at IS NULL RETURNING key`).bind(file.key, deps.now()).all<{ key: string }>();
  if (results.length) await logActivity(deps, { orgId, action: "fig_file_encrypt", actor: user, entity: fileEntity(file), teamId: file.team_id, details: { source: "managed", trigger: "admin", rows: sealed ?? 0 }, req: ctx.req });
  return ekmStatus(ctx, orgId, file.key);
}
