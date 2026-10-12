/**
 * The SAML routes of an org (docs/multiplayer.md §15.3), no session:
 *
 *   GET  /saml/:tenantId           SP metadata (Figma's "SP Entity ID" is this URL)
 *   GET  /saml/:tenantId/start     ?st= the app's signed state → 302 to the IdP · without it, "log in from the app"
 *   POST /saml/:tenantId/consume   the ACS (HTTP-POST binding): steps 1–8 of §15.3.4
 */
import { emailDomain } from "../../../../src/shared/org/identity";
import type { Deps } from "../../api";
import { claimInvites, settingsOf } from "../../org/db";
import { HttpError } from "../../org/http";
import { bouncePage, fromAppPage, messagePage, ssoFailedPage } from "../pages";
import { accountForEmail, ensureMember, memberRow, setNameFromIdp } from "../people";
import { backWithCode, backWithError, bounceTargets, startAuthn, verifyState, type AppState } from "../sso";
import { d1Cache, idpByTenant, idpForDomain, spConfigOf, type IdpRow } from "./config";
import { MAX_POST_BYTES, assertionEmail, assertionPerson, spMetadata, verifyResponse } from "./sp";

export async function samlRoute(req: Request, url: URL, deps: Deps, parts: string[]): Promise<Response> {
  const idp = parts[1] ? await idpByTenant(deps.db.d1, parts[1]) : null;
  if (!idp) throw new HttpError(404, "no such SAML configuration");
  const m = req.method;
  if (parts.length === 2 && m === "GET") return new Response(spMetadata(url.origin, spConfigOf(idp)), { headers: { "content-type": "application/samlmetadata+xml; charset=utf-8" } });
  if (parts.length === 3 && parts[2] === "start" && m === "GET") {
    const st = url.searchParams.get("st");
    if (st === null) {
      const t = bounceTargets(deps, idp.tenant_id);
      return fromAppPage(t.app, t.web);
    }
    const app = await verifyState(deps, st);
    if (!app) return messagePage(400, "This sign-in link has expired", "Start again from the app.");
    return startAuthn(deps, url.origin, idp, app);
  }
  if (parts.length === 3 && parts[2] === "consume" && m === "POST") return consume(req, url, deps, idp);
  throw new HttpError(404, "not found");
}

/** A failure of the ACS: 403 page, or the app's loopback with the error when its request is known */
function fail(reason: string, app: AppState | null, code: "sso_failed" | "sso_domain" | "google_required" = "sso_failed", text?: string): Response {
  console.warn("saml: refused —", reason);
  return app ? backWithError(app, code) : ssoFailedPage(text);
}

/** §15.3.4, in its order */
async function consume(req: Request, url: URL, deps: Deps, idp: IdpRow): Promise<Response> {
  const d1 = deps.db.d1;
  const now = deps.now();
  // 1. the post itself: size and type before any parsing
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_POST_BYTES + 4096) return fail("post too large", null);
  if (!(req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) return fail("not a form post", null);
  const text = await req.text();
  if (text.length > MAX_POST_BYTES + 4096) return fail("post too large", null);
  const form = new URLSearchParams(text);
  const samlResponse = form.get("SAMLResponse");
  const relayState = form.get("RelayState");
  if (!samlResponse) return fail("no SAMLResponse", null);

  // A failure before the request is consumed still reaches the app when RelayState names a pending request of this org
  // (the app's own flow; it starts again).
  const pendingApp = async (): Promise<AppState | null> => {
    if (!relayState || !/^_[0-9a-f]{32}$/.test(relayState)) return null;
    const r = await d1.prepare(`DELETE FROM saml_requests WHERE id = ?1 AND org_id = ?2 AND expires_at > ?3 RETURNING state`).bind(relayState, idp.org_id, now).first<{ state: string }>();
    return r ? (JSON.parse(r.state) as AppState) : null;
  };

  // 2–3. node-saml's verification and ours (algorithms, encryption, issuer, recipient, destination)
  let verified;
  try {
    verified = await verifyResponse(url.origin, spConfigOf(idp), samlResponse, d1Cache(d1, idp.org_id, deps.now), now);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), await pendingApp());
  }
  const { assertion } = verified;

  // 4. InResponseTo: the signed one consumed atomically — the second of two concurrent posts finds nothing
  if (!assertion.inResponseTo) {
    // Unsolicited (IdP-initiated, decision 3): verified, never a session — one click back into the app's own flow.
    if (!(await recordAssertion(deps, idp.org_id, assertion.id, assertion.expiresAt))) return fail("assertion replayed", null);
    const t = bounceTargets(deps, idp.tenant_id);
    return bouncePage(t.app, t.web);
  }
  const taken = await d1.prepare(`DELETE FROM saml_requests WHERE id = ?1 AND org_id = ?2 AND expires_at > ?3 RETURNING state`).bind(assertion.inResponseTo, idp.org_id, now).first<{ state: string }>();
  if (!taken) return fail("InResponseTo is not a pending request (used, expired or unknown)", null);
  const app = JSON.parse(taken.state) as AppState;

  // 5. replay: an accepted assertion ID is refused until its NotOnOrAfter
  if (!(await recordAssertion(deps, idp.org_id, assertion.id, assertion.expiresAt))) return fail("assertion replayed", app);

  // 6. the email, on a verified domain of this org (decision 4)
  const email = assertionEmail(assertion);
  if (!email) return fail("no email in the assertion", app);
  const domain = emailDomain(email);
  const onDomain = domain ? await d1.prepare(`SELECT 1 AS x FROM org_domains WHERE org_id = ?1 AND domain = ?2 AND verified_at IS NOT NULL`).bind(idp.org_id, domain).first() : null;
  if (!onDomain) return fail(`${email} isn't on a verified domain of the org`, app, "sso_domain");
  // Several IdPs (docs/governance.md §2.9): the domain must be this IdP's (mapped to it, or the org's only IdP)
  const serving = await idpForDomain(d1, idp.org_id, domain);
  if (serving?.tenant_id !== idp.tenant_id) return fail(`${domain} isn't mapped to this identity provider`, app, "sso_domain");

  // 7. the person: the account by email (else a new one), not deactivated by SCIM, JIT, the login method
  const org = await d1.prepare(`SELECT id, name, settings FROM orgs WHERE id = ?1`).bind(idp.org_id).first<{ id: string; name: string; settings: string }>();
  const settings = settingsOf(org);
  if (settings.authMethod === "google") return fail("the org requires Google", app, "google_required");
  const person = assertionPerson(assertion);
  const { user } = await accountForEmail(deps, email, person.name);
  const scim = await d1.prepare(`SELECT active FROM scim_users WHERE org_id = ?1 AND user_id = ?2`).bind(idp.org_id, user.id).first<{ active: number }>();
  if (scim && scim.active === 0) return fail("deactivated by SCIM", app);
  await setNameFromIdp(deps, user.id, person.name);
  await d1.prepare(`UPDATE users SET last_seen_at = ?2 WHERE id = ?1`).bind(user.id, now).run();
  await claimInvites(d1, user);
  const before = await memberRow(deps, idp.org_id, user);
  await ensureMember(deps, idp.org_id, user, {
    role: "member",
    seat: settings.defaultSeat,
    provisionedBy: before && before.role !== "guest" ? undefined : "jit",
    attrs: person.title ? { title: person.title } : undefined,
    actor: null,
    req,
    details: { jit: true },
  });
  // 8. the code for the app's loopback (or web page; `user_sign_in` is logged when the app trades it); the configuration
  // is now tested
  if (idp.tested_at === null) await d1.prepare(`UPDATE idp_configs SET tested_at = ?2 WHERE tenant_id = ?1 AND tested_at IS NULL`).bind(idp.tenant_id, now).run();
  return backWithCode(deps, app, user, "saml", idp.org_id, req);
}

/** False when this assertion ID was already accepted (a replay); expired rows are swept on the way */
async function recordAssertion(deps: Deps, orgId: string, id: string, expiresAt: number): Promise<boolean> {
  const d1 = deps.db.d1;
  await d1.prepare(`DELETE FROM saml_assertions WHERE expires_at < ?1`).bind(deps.now()).run();
  const r = await d1.prepare(`INSERT INTO saml_assertions (id, org_id, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO NOTHING RETURNING id`).bind(id, orgId, Math.max(expiresAt, deps.now() + 60_000)).first();
  return r !== null;
}
