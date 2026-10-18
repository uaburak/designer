/**
 * Domain capture (docs/multiplayer.md §15.7, [F-domain]): accounts on an org's verified domains join it as members
 * with a View seat — every existing one when an admin turns capture on, each new one as it signs in (Google's callback
 * and the ACS). Guests on those domains become members. Turning capture off undoes nothing.
 */
import { emailDomain } from "../../../src/shared/org/identity";
import type { Deps } from "../api";
import type { User } from "../db";
import { notifyOrg } from "../notifications";
import { ensureMember, verifiedDomainOrg } from "./people";

/** At sign-in: the email's domain verified, with capture on, in an org → a member there. Returns that org's id. */
export async function captureAtSignIn(deps: Deps, user: User, req: Request | null): Promise<string | null> {
  const domain = emailDomain(user.email);
  const hit = domain ? await verifiedDomainOrg(deps, domain) : null;
  if (!hit?.capture) return null;
  await ensureMember(deps, hit.orgId, user, { role: "member", seat: "view", actor: null, req, details: { domain_capture: true } });
  return hit.orgId;
}

/** Capture turned on: every account on the org's verified domains that isn't a member becomes one. */
export async function captureExisting(deps: Deps, orgId: string, actor: User, req: Request | null): Promise<number> {
  const d1 = deps.db.d1;
  const { results: domains } = await d1.prepare(`SELECT domain FROM org_domains WHERE org_id = ?1 AND verified_at IS NOT NULL`).bind(orgId).all<{ domain: string }>();
  const org = await d1.prepare(`SELECT name FROM orgs WHERE id = ?1`).bind(orgId).first<{ name: string }>();
  let n = 0;
  for (const { domain } of domains) {
    const { results } = await d1
      .prepare(
        `SELECT u.id, u.email, u.name, u.picture, u.token_version FROM users u
         WHERE u.email LIKE ?2 AND u.google_sub NOT LIKE 'deleted:%'
           AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = ?1 AND m.user_id = u.id AND m.role <> 'guest')`,
      )
      .bind(orgId, `%@${domain}`)
      .all<{ id: string; email: string; name: string | null; picture: string | null; token_version: number }>();
    for (const r of results) {
      const user: User = { id: r.id, email: r.email, name: r.name, picture: r.picture, tokenVersion: r.token_version };
      const done = await ensureMember(deps, orgId, user, { role: "member", seat: "view", actor, req, details: { domain_capture: true } });
      if (done === "kept") continue;
      n++;
      // "You were added to ‹org›" (wording ours, §15.7)
      await notifyOrg(deps, { userId: user.id, kind: "org_domain_captured", actorId: actor.id, orgId, name: org?.name ?? "", text: `You were added to ${org?.name ?? "the organization"}` });
    }
  }
  return n;
}
