/**
 * Governance+ gates (docs/governance.md §2.5). STUBS committed before round 14: they let everything through until
 * 14b fills `orgGate` and 14a fills `networkCheck`. Call sites: every org route, file route of an org file, socket
 * upgrade and `/v1` call on org resources (orgGate); every authenticated route except `GET /me`, sign-out and
 * `/me/sessions/current` (networkCheck).
 */
import type { Deps } from "../api";
import type { User } from "../db";
import type { OrgGate } from "../../../src/shared/org/governance";

/** The block on `user` in `orgId` for this request (2FA for guests, a policy to agree to, the IP allowlist), or null.
 *  Null whenever the org hasn't Governance+. */
export async function orgGate(_deps: Deps, _user: User, _orgId: string, _req: Request): Promise<OrgGate | null> {
  return null;
}

/** True when a network access restriction blocks this account on the request's network (403 `network_restricted`) */
export async function networkCheck(_deps: Deps, _user: User, _req: Request): Promise<boolean> {
  return false;
}
