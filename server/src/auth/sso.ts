/**
 * Signing in (docs/multiplayer.md §2, §15.4): the login page, routing by email domain to an org's SAML, Google's
 * callback with account linking, domain capture and the login method, and the one-time code the app trades for a
 * session. The app's loopback and PKCE (§2) are unchanged whichever method the person picks in the browser.
 *
 *   GET  /auth/login   port | return, state, challenge — or st (a signed state already made here); method=google|sso; tenant
 *   POST /auth/sso     form {email, st} → 302 to the org's SAML start · JSON {email} → SsoLookup | 404 sso_not_found
 *   GET  /auth/callback  Google's answer
 */
import { emailDomain, type SessionAuth, type SsoLookup } from "../../../src/shared/org/identity";
import type { OrgSettings } from "../../../src/shared/org/types";
import type { Deps } from "../api";
import { authorizeUrl, exchangeCode, GoogleError } from "../google";
import { claimInvites, settingsOf } from "../org/db";
import { errorBody, HttpError } from "../org/http";
import { randomToken, sha256b64url, signToken, verifyToken } from "../tokens";
import { captureAtSignIn } from "./capture";
import { loginPage, messagePage } from "./pages";
import { idpForDomain, type IdpRow, spConfigOf } from "./saml/config";
import type { User } from "../db";
import { authnRedirect } from "./saml/sp";

export const STATE_SECONDS = 600;
export const CODE_MS = 120_000;
export const REQUEST_MS = 10 * 60_000;

/** The app's side of a sign-in: its loopback port (0 for the web app) or page, its own state, its PKCE challenge */
export interface AppState {
  p: number;
  r?: string;
  s: string;
  c: string;
}
type SignedState = AppState & { exp: number };

export function sessionSecret(deps: Deps): string {
  const s = deps.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new HttpError(500, "SESSION_SECRET is not set");
  return s;
}
const seconds = (deps: Deps) => Math.floor(deps.now() / 1000);
export const webOrigins = (deps: Deps) => (deps.env.WEB_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const signState = (deps: Deps, st: AppState) => signToken({ ...st, exp: seconds(deps) + STATE_SECONDS } satisfies SignedState, sessionSecret(deps));
export async function verifyState(deps: Deps, token: string | null): Promise<AppState | null> {
  const p = token ? await verifyToken<SignedState>(token, sessionSecret(deps), seconds(deps)) : null;
  if (!p || typeof p.s !== "string" || typeof p.c !== "string" || typeof p.p !== "number") return null;
  return { p: p.p, s: p.s, c: p.c, ...(typeof p.r === "string" ? { r: p.r } : {}) };
}

/** Where the browser goes back to: the loopback (`code`, `state`, `error`) or the web page (`auth_…`) */
export function appBack(st: AppState, params: Record<string, string>): string {
  const web = typeof st.r === "string";
  const back = web ? new URL(st.r!) : new URL(`http://127.0.0.1:${st.p}/callback`);
  const k = (n: string) => (web ? `auth_${n}` : n);
  back.searchParams.set(k("state"), st.s);
  for (const [n, v] of Object.entries(params)) back.searchParams.set(k(n), v);
  return back.toString();
}
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });
export const backWithError = (st: AppState, error: string) => redirect(appBack(st, { error }));

/**
 * A one-time code for the app (2 minutes, bound to its challenge), and the redirect carrying it. Round 14
 * (docs/governance.md §2.2, §2.4): an account a network access restriction blocks goes back with
 * `error=network_restricted`; with two-factor authentication on, the code is stored pending and the browser goes to
 * `/auth/2fa` first.
 */
export async function backWithCode(deps: Deps, st: AppState, user: Pick<User, "id" | "email">, auth: SessionAuth, orgId: string | null, req: Request): Promise<Response> {
  if (await (await import("../governance/network")).networkCheck(deps, user, req)) return backWithError(st, "network_restricted");
  const code = randomToken();
  const hash = await sha256b64url(code);
  const tf = await import("../governance/twoFactor");
  if (await tf.twoFactorOn(deps, user.id)) {
    await deps.db.putAuthCode(hash, user.id, st.c, deps.now() + tf.CHALLENGE_MS, auth, orgId, true);
    return tf.startChallenge(deps, new URL(req.url).origin, st, hash);
  }
  await deps.db.putAuthCode(hash, user.id, st.c, deps.now() + CODE_MS, auth, orgId);
  return redirect(appBack(st, { code }));
}

/** The app's parameters, checked as §2 step 1 always has */
async function appStateFrom(url: URL, deps: Deps): Promise<AppState> {
  const ret = url.searchParams.get("return");
  const p = ret === null ? Number(url.searchParams.get("port")) : 0;
  const s = url.searchParams.get("state") ?? "";
  const c = url.searchParams.get("challenge") ?? "";
  if (ret !== null) {
    let back: URL | null = null;
    try {
      back = new URL(ret);
    } catch {
      // refused below
    }
    if (!back || !webOrigins(deps).includes(back.origin)) throw new HttpError(400, "return page not allowed");
  } else if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new HttpError(400, "bad port");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(s)) throw new HttpError(400, "bad state");
  if (!/^[A-Za-z0-9_-]{43}$/.test(c)) throw new HttpError(400, "bad challenge");
  return { p, s, c, ...(ret !== null ? { r: ret } : {}) };
}

function googleConfig(url: URL, deps: Deps) {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = deps.env;
  if (!clientId || !clientSecret) throw new HttpError(503, "Google sign-in is not configured");
  return { clientId, clientSecret, redirectUri: `${url.origin}/auth/callback` };
}

/** `GET /auth/login` (§15.4) */
export async function loginRoute(url: URL, deps: Deps): Promise<Response> {
  let st: string;
  const given = url.searchParams.get("st");
  if (given !== null) {
    if (!(await verifyState(deps, given))) return messagePage(400, "This sign-in link has expired", "Start again from the app.");
    st = given;
  } else st = await signState(deps, await appStateFrom(url, deps));
  const method = url.searchParams.get("method");
  const tenant = url.searchParams.get("tenant");
  if (tenant !== null) {
    if (!/^\d{18}$/.test(tenant)) throw new HttpError(400, "bad tenant");
    return redirect(`${url.origin}/saml/${tenant}/start?st=${encodeURIComponent(st)}`);
  }
  if (method === "google") return redirect(authorizeUrl(googleConfig(url, deps), st));
  return loginPage(st, { sso: method === "sso" });
}

/** The org whose verified domain this email is on, with the IdP serving that domain (docs/governance.md §2.9) */
async function ssoFor(deps: Deps, email: string): Promise<{ idp: IdpRow; orgName: string } | null> {
  const domain = emailDomain(email.trim());
  if (!domain) return null;
  const r = await deps.db.d1
    .prepare(`SELECT o.id, o.name FROM org_domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ?1 AND d.verified_at IS NOT NULL`)
    .bind(domain)
    .first<{ id: string; name: string }>();
  const idp = r ? await idpForDomain(deps.db.d1, r.id, domain) : null;
  return idp && r ? { idp, orgName: r.name } : null;
}

/** `POST /auth/sso` (§15.4): the email never travels in a URL */
export async function ssoRoute(req: Request, url: URL, deps: Deps): Promise<Response> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    let email: unknown;
    try {
      email = ((await req.json()) as { email?: unknown })?.email;
    } catch {
      // refused below
    }
    if (typeof email !== "string") throw new HttpError(400, "email");
    const hit = await ssoFor(deps, email);
    if (!hit) return Response.json(errorBody(new HttpError(404, "Single sign-on isn't set up for this email.", "sso_not_found")), { status: 404 });
    return Response.json({ tenantId: hit.idp.tenant_id, orgName: hit.orgName } satisfies SsoLookup);
  }
  const form = await req.formData().catch(() => null);
  const st = form?.get("st");
  const email = form?.get("email");
  if (typeof st !== "string" || !(await verifyState(deps, st))) return messagePage(400, "This sign-in link has expired", "Start again from the app.");
  const hit = typeof email === "string" ? await ssoFor(deps, email) : null;
  if (!hit) return loginPage(st, { sso: true, error: "Single sign-on isn't set up for this email.", email: typeof email === "string" ? email.slice(0, 254) : "" });
  return redirect(`${url.origin}/saml/${hit.idp.tenant_id}/start?st=${encodeURIComponent(st)}`);
}

/**
 * The AuthnRequest of §15.3.3: a `saml_requests` row with the app's state (expired rows swept in the same go), then
 * the IdP with RelayState = the request id.
 */
export async function startAuthn(deps: Deps, origin: string, idp: IdpRow, st: AppState): Promise<Response> {
  const id = `_${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const now = deps.now();
  await deps.db.d1.prepare(`DELETE FROM saml_requests WHERE expires_at < ?1`).bind(now).run();
  await deps.db.d1.prepare(`INSERT INTO saml_requests (id, org_id, state, expires_at) VALUES (?1, ?2, ?3, ?4)`).bind(id, idp.org_id, JSON.stringify(st), now + REQUEST_MS).run();
  return redirect(await authnRedirect(origin, spConfigOf(idp), id));
}

/** The org whose login method decides for this person (the first they joined among those requiring one; decision 6) */
export async function requiredMethod(deps: Deps, userId: string): Promise<{ orgId: string; settings: OrgSettings } | null> {
  const { results } = await deps.db.d1
    .prepare(`SELECT o.id, o.settings FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ?1 AND m.role IN ('admin', 'member') ORDER BY m.created_at, o.id`)
    .bind(userId)
    .all<{ id: string; settings: string }>();
  for (const r of results) {
    const settings = settingsOf(r);
    if (settings.authMethod !== "any") return { orgId: r.id, settings };
  }
  return null;
}

/** `GET /auth/callback` (§2 step 3, §15.4): Google's answer → the account, invites, capture, the login method, the code */
export async function googleCallback(url: URL, deps: Deps, req: Request): Promise<Response> {
  const st = await verifyState(deps, url.searchParams.get("state"));
  if (!st) return messagePage(400, "This sign-in link has expired", "Start again from the app.");
  const code = url.searchParams.get("code");
  if (!code) return backWithError(st, url.searchParams.get("error") ?? "access_denied");
  let profile;
  try {
    profile = await exchangeCode(code, googleConfig(url, deps), deps.fetch, seconds(deps));
  } catch (e) {
    if (!(e instanceof GoogleError)) throw e;
    return backWithError(st, "google_failed");
  }
  // 1. the account (by sub; else a none: account with this verified email is claimed; else a new one)
  const user = await deps.db.upsertUser(profile, deps.now());
  // 2. invites waiting for the email; 3. domain capture
  await claimInvites(deps.db.d1, user);
  await captureAtSignIn(deps, user, req);
  // 4. the login method of the person's org: SAML → on to its IdP with the same app state (the loopback still completes)
  const need = await requiredMethod(deps, user.id);
  // With several IdPs (round 14) SAML applies to members on mapped domains; the others may use Google [G+].
  if (need?.settings.authMethod === "saml") {
    const idp = await idpForDomain(deps.db.d1, need.orgId, emailDomain(user.email), { offDomain: true });
    if (idp) return startAuthn(deps, url.origin, idp, st);
  }
  return backWithCode(deps, st, user, "google", null, req);
}

/** `designer://sign-in?tenant=` from the bounce page, or the web app's own login with the tenant */
export function bounceTargets(deps: Deps, tenantId: string): { app: string; web: string | null } {
  const web = webOrigins(deps)[0];
  return { app: `designer://sign-in?tenant=${tenantId}`, web: web ? `${web}/?sso=${tenantId}` : null };
}
