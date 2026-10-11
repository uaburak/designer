/**
 * The idle session timeout (docs/multiplayer.md §15.8, [F-idle]): a session ends when its person hasn't used the app
 * for longer than the shortest `idleSessionTimeoutHours` (default 21 days) of the orgs where they are a member or
 * admin. `active_at` moves only on the app's activity reports (`POST /me/sessions/active`), never on background
 * requests; `idle_limit_ms` is recomputed at sign-in, in `authenticate`'s 5-minute touch, and for an org's people when
 * the setting changes (which also resets their inactivity — Figma's rule).
 */
import { IDLE_DEFAULT_HOURS } from "../../../src/shared/org/identity";
import { logActivity, userEntity } from "../activity";
import type { Deps } from "../api";
import type { User } from "../db";
import { HttpError } from "../org/http";

/** SQL: the idle limit (ms) of the user bound as `?<n>`, NULL when they are a member of no org */
export const idleLimitSql = (userParam: string) =>
  `(SELECT MIN(COALESCE(json_extract(o.settings, '$.idleSessionTimeoutHours'), ${IDLE_DEFAULT_HOURS})) * 3600000
    FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ${userParam} AND m.role IN ('admin', 'member'))`;

export interface SessionTouch {
  id: string;
  auth_method: "google" | "saml" | "dev";
  active_at: number | null;
  last_seen_at: number;
  idle_limit_ms: number | null;
}

/** True when the session has been idle past its limit */
export const idleExpired = (s: Pick<SessionTouch, "active_at" | "last_seen_at" | "idle_limit_ms">, now: number) => s.idle_limit_ms !== null && now - (s.active_at ?? s.last_seen_at) > s.idle_limit_ms;

const idleError = () => new HttpError(401, "you were logged out after a period of inactivity", "idle_timeout");
/** How long an idle-ended session is remembered: a session token's lifetime (30 days) */
const ENDED_KEPT_MS = 30 * 24 * 3_600_000;

/** `authenticate`'s check: an idle session is deleted, logged in each member org, and refused with `idle_timeout` */
export async function enforceIdle(deps: Deps, s: SessionTouch, user: User, req: Request): Promise<void> {
  if (!idleExpired(s, deps.now())) return;
  await deps.db.d1.prepare(`DELETE FROM sessions WHERE id = ?1`).bind(s.id).run();
  await rememberIdleEnded(deps, s.id, user.id);
  await logIdleTimeout(deps, user, req, "request");
  throw idleError();
}

/**
 * A session ended by the idle timeout is remembered (migration 0014): the first request to find it idle may be a socket
 * upgrade, whose 401 no client reads — later calls with its token then answer `401 idle_timeout` too, so the app says
 * why it signed out (docs/multiplayer.md §15.18's caveat). Old rows go as new ones come.
 */
export async function rememberIdleEnded(deps: Deps, sid: string, userId: string): Promise<void> {
  const now = deps.now();
  await deps.db.d1.prepare(`INSERT OR REPLACE INTO idle_ended_sessions (id, user_id, ended_at) VALUES (?1, ?2, ?3)`).bind(sid, userId, now).run();
  await deps.db.d1.prepare(`DELETE FROM idle_ended_sessions WHERE ended_at < ?1`).bind(now - ENDED_KEPT_MS).run();
}

/** `authenticate`, for a token whose session row is gone: `idle_timeout` when the idle timeout ended it, else nothing */
export async function refuseIfIdleEnded(deps: Deps, sid: string, userId: string): Promise<void> {
  const row = await deps.db.d1.prepare(`SELECT 1 AS x FROM idle_ended_sessions WHERE id = ?1 AND user_id = ?2`).bind(sid, userId).first();
  if (row) throw idleError();
}

/** `user_idle_session_timeout` in each org where the person is a member or admin (guests have no limit) */
export async function logIdleTimeout(deps: Deps, user: Pick<User, "id" | "email" | "name">, req: Request | null, loggedOn: "request" | "client"): Promise<void> {
  const { results } = await deps.db.d1.prepare(`SELECT org_id FROM org_members WHERE user_id = ?1 AND role IN ('admin', 'member')`).bind(user.id).all<{ org_id: string }>();
  for (const { org_id } of results) await logActivity(deps, { orgId: org_id, action: "user_idle_session_timeout", actor: user, entity: userEntity(user), details: { logged_on: loggedOn }, req });
}

/** A change of the org's setting: everyone's limit recomputed and their inactivity reset (§15.8) */
export async function resetOrgSessions(deps: Deps, orgId: string): Promise<void> {
  await deps.db.d1
    .prepare(`UPDATE sessions SET active_at = ?2, idle_limit_ms = ${idleLimitSql("sessions.user_id")} WHERE user_id IN (SELECT user_id FROM org_members WHERE org_id = ?1 AND role IN ('admin', 'member') AND user_id IS NOT NULL)`)
    .bind(orgId, deps.now())
    .run();
}
