/**
 * Plan access tokens (docs/multiplayer.md §16.3): made by org admins in Admin › Settings › Plan access tokens, scoped to
 * one org, holding only `org:*`, `library_analytics:read` and `webhooks:*`, valid 1–365 days, shown once. Stored as
 * `access_tokens` rows of kind 'plan' (0015); `user_id` is the admin who made it, kept when they leave.
 *
 *   GET    /orgs/:org/admin/plan-tokens          {tokens: AccessTokenInfo[]}
 *   POST   /orgs/:org/admin/plan-tokens          {description, expiresInDays, scopes} → {token, info}
 *   DELETE /orgs/:org/admin/plan-tokens/:id      {ok: true}
 */
import type { AccessTokenInfo, TokenScope } from "../../../src/shared/account";
import { PLAN_TOKEN_SCOPES, type RestScope } from "../../../src/shared/rest/types";
import { PLAN_TOKEN_PREFIX } from "../account";
import { logActivity, orgEntity } from "../activity";
import { body, HttpError, json, type Ctx } from "../org/http";
import { randomToken, sha256b64url } from "../tokens";

const MAX_PLAN_TOKENS = 50;

export async function planTokensRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, acc, deps, user, req } = ctx;
  const orgId = parts[1];
  await acc.requireOrgAdmin(orgId);
  const org = await acc.org(orgId);
  const d1 = deps.db.d1;
  const now = deps.now();
  if (parts.length === 4 && m === "GET") {
    const { results } = await d1
      .prepare(`SELECT id, description, scopes, created_at, expires_at, last_used_at FROM access_tokens WHERE org_id = ?1 AND kind = 'plan' ORDER BY created_at DESC`)
      .bind(orgId)
      .all<{ id: string; description: string; scopes: string; created_at: number; expires_at: number | null; last_used_at: number | null }>();
    const tokens: AccessTokenInfo[] = results.map((r) => ({ id: r.id, description: r.description, scopes: parseScopes(r.scopes), kind: "plan", orgId, createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at }));
    return json({ tokens });
  }
  if (parts.length === 4 && m === "POST") {
    const b = await body<{ description?: unknown; expiresInDays?: unknown; scopes?: unknown }>(req);
    const description = typeof b.description === "string" ? b.description.trim().slice(0, 100) : "";
    if (!description) throw new HttpError(400, "give the token a name");
    const days = b.expiresInDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, "expiresInDays is 1 to 365");
    const scopes = Array.isArray(b.scopes) ? [...new Set(b.scopes)] : [];
    if (!scopes.length || !scopes.every((s) => PLAN_TOKEN_SCOPES.includes(s as RestScope))) throw new HttpError(400, `a plan access token holds only ${PLAN_TOKEN_SCOPES.join(", ")}`);
    const n = await d1.prepare(`SELECT COUNT(*) AS n FROM access_tokens WHERE org_id = ?1 AND kind = 'plan'`).bind(orgId).first<{ n: number }>();
    if ((n?.n ?? 0) >= MAX_PLAN_TOKENS) throw new HttpError(400, `at most ${MAX_PLAN_TOKENS} plan access tokens`);
    const id = `t_${randomToken(9)}`;
    const token = `${PLAN_TOKEN_PREFIX}${randomToken(32)}`;
    const expiresAt = now + days * 86_400_000;
    await d1
      .prepare(`INSERT INTO access_tokens (id, user_id, description, token_hash, scopes, created_at, expires_at, kind, org_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'plan', ?8)`)
      .bind(id, user.id, description, await sha256b64url(token), JSON.stringify(scopes), now, expiresAt, orgId)
      .run();
    await logActivity(deps, { orgId, action: "plan_access_token_create", actor: user, entity: orgEntity({ id: orgId, name: org?.name ?? "" }), details: { token_id: id, description, scopes }, req });
    const info: AccessTokenInfo = { id, description, scopes: scopes as TokenScope[], kind: "plan", orgId, createdAt: now, expiresAt, lastUsedAt: null };
    return json({ token, info }, 201);
  }
  if (parts.length === 5 && m === "DELETE") {
    const gone = await d1.prepare(`DELETE FROM access_tokens WHERE id = ?1 AND org_id = ?2 AND kind = 'plan' RETURNING id`).bind(parts[4], orgId).first();
    if (gone) await logActivity(deps, { orgId, action: "plan_access_token_delete", actor: user, entity: orgEntity({ id: orgId, name: org?.name ?? "" }), details: { token_id: parts[4] }, req });
    return json({ ok: true });
  }
  throw new HttpError(404, "not found");
}

function parseScopes(s: string): TokenScope[] {
  try {
    return (JSON.parse(s) as unknown[]).filter((x): x is TokenScope => typeof x === "string" && PLAN_TOKEN_SCOPES.includes(x as RestScope));
  } catch {
    return [];
  }
}
