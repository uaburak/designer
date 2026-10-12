/**
 * Two-factor authentication, our TOTP (docs/governance.md §2.4, §4; ours — Figma's 2FA is for password accounts, and
 * every account here is Google, SAML or dev). RFC 6238 with SHA-1, 6 digits, 30 s, ±1 step (the shared helpers in
 * `src/shared/org/governance.ts`); the secret sealed with AES-GCM under a key derived (HKDF) from SESSION_SECRET; 10
 * recovery codes `xxxx-xxxx` kept as salted SHA-256 hashes.
 *
 *   GET    /me/two-factor                   → TwoFactorStatus
 *   POST   /me/two-factor/setup             → TwoFactorSetup (pending for 10 minutes; 409 when already on)
 *   POST   /me/two-factor/enable {code}     → TwoFactorEnabled (the recovery codes, shown once)
 *   POST   /me/two-factor/recovery-codes {code} → TwoFactorEnabled (the old codes stop working)
 *   DELETE /me/two-factor {code}            → 204
 *   GET    /auth/2fa?mt=                    the sign-in page "Enter the 6-digit code from your authenticator app"
 *   POST   /auth/2fa  form {mt, code}       → 302 to the app's loopback with a fresh code
 *
 * Sign-in: once 2FA is on, Google's callback and the SAML ACS put the app's code in `auth_codes` with `mfa_pending`
 * (which `/auth/token` refuses) and send the browser here with `mt`, a signed token naming that code and the app's
 * state. A right code (or an unused recovery code) takes the pending row and hands the loopback a new code.
 *
 * Every check of a code (sign-in and the routes above) counts failures: TWO_FACTOR_MAX_FAILURES within
 * TWO_FACTOR_FAILURE_WINDOW_MS → 429 until the window passes. A TOTP step once accepted is never accepted again
 * (`last_step`, moved atomically).
 */
import {
  RECOVERY_CODE_COUNT,
  TWO_FACTOR_FAILURE_WINDOW_MS,
  TWO_FACTOR_MAX_FAILURES,
  TWO_FACTOR_SETUP_TTL_MS,
  base32Encode,
  generateRecoveryCode,
  otpauthUrl,
  verifyTotp,
  type TwoFactorEnabled,
  type TwoFactorSetup,
  type TwoFactorStatus,
} from "../../../src/shared/org/governance";
import { logForUserOrgs } from "../activity";
import type { Deps } from "../api";
import type { User } from "../db";
import { HttpError, json, noContent } from "../org/http";
import { b64url, fromB64url, randomToken, sha256b64url, signToken, verifyToken } from "../tokens";
import { messagePage, twoFactorPage } from "../auth/pages";
import { appBack, backWithError, sessionSecret, CODE_MS, type AppState } from "../auth/sso";

/** How long the sign-in challenge (the pending code and `mt`) lives */
export const CHALLENGE_MS = 10 * 60_000;
const SECRET_BYTES = 20;

interface TwoFactorRow {
  user_id: string;
  secret: string;
  enabled_at: number | null;
  pending_expires_at: number | null;
  last_step: number;
  failed_count: number;
  failed_since: number | null;
}

// ---- the sealed secret --------------------------------------------------------------------------------------------

/** CryptoKey, named so both Node's and Workers' typings accept it */
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const keys = new Map<string, Promise<Key>>();
function sealKey(deps: Deps): Promise<Key> {
  const secret = sessionSecret(deps);
  let k = keys.get(secret);
  if (!k) {
    k = (async () => {
      const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("designer/two-factor"), info: new TextEncoder().encode("totp-secret v1") },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keys.set(secret, k);
  }
  return k;
}

export async function sealSecret(deps: Deps, userId: string, raw: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) }, await sealKey(deps), new Uint8Array(raw)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

export async function openSecret(deps: Deps, userId: string, sealed: string): Promise<Uint8Array> {
  const b = fromB64url(sealed);
  if (!b || b.length < 13) throw new HttpError(500, "two-factor secret unreadable");
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12), additionalData: new TextEncoder().encode(userId) }, await sealKey(deps), b.slice(12)));
  } catch {
    throw new HttpError(500, "two-factor secret unreadable");
  }
}

// ---- rows ---------------------------------------------------------------------------------------------------------

const rowOf = (deps: Deps, userId: string) => deps.db.d1.prepare(`SELECT * FROM user_two_factor WHERE user_id = ?1`).bind(userId).first<TwoFactorRow>();

/** Is 2FA on for this account? (one indexed read; sign-in asks it) */
export async function twoFactorOn(deps: Deps, userId: string): Promise<boolean> {
  const r = await deps.db.d1.prepare(`SELECT 1 AS x FROM user_two_factor WHERE user_id = ?1 AND enabled_at IS NOT NULL`).bind(userId).first();
  return r !== null;
}

const recoveryHash = (userId: string, code: string) => sha256b64url(`${userId}:${code}`);
/** "ABCD-efgh", "abcdefgh", " abcd efgh " → "abcd-efgh", or null */
function recoveryForm(code: string): string | null {
  const t = code.trim().toLowerCase().replace(/\s+/g, "");
  const m = /^([a-z0-9]{4})-?([a-z0-9]{4})$/.exec(t);
  return m ? `${m[1]}-${m[2]}` : null;
}

async function newRecoveryCodes(deps: Deps, userId: string): Promise<string[]> {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(generateRecoveryCode());
  const d1 = deps.db.d1;
  await d1.prepare(`DELETE FROM user_recovery_codes WHERE user_id = ?1`).bind(userId).run();
  for (const c of codes) await d1.prepare(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?1, ?2)`).bind(userId, await recoveryHash(userId, c)).run();
  return [...codes];
}

// ---- checking a code ----------------------------------------------------------------------------------------------

const tooMany = () => new HttpError(429, "Too many attempts. Try again in a few minutes.", "rate_limited");
const invalid = () => new HttpError(400, "That code didn't work. Try again.", "two_factor_invalid", { field: "code" });

function lockedOut(r: TwoFactorRow, now: number): boolean {
  return r.failed_since !== null && now - r.failed_since < TWO_FACTOR_FAILURE_WINDOW_MS && r.failed_count >= TWO_FACTOR_MAX_FAILURES;
}

/** Counts a failure (a new window when the last one has passed) → the failures in the window now */
async function recordFailure(deps: Deps, r: TwoFactorRow): Promise<number> {
  const now = deps.now();
  const fresh = r.failed_since === null || now - r.failed_since >= TWO_FACTOR_FAILURE_WINDOW_MS;
  const n = await deps.db.d1
    .prepare(`UPDATE user_two_factor SET failed_count = CASE WHEN ?2 = 1 THEN 1 ELSE failed_count + 1 END, failed_since = CASE WHEN ?2 = 1 THEN ?3 ELSE failed_since END WHERE user_id = ?1 RETURNING failed_count`)
    .bind(r.user_id, fresh ? 1 : 0, now)
    .first<{ failed_count: number }>();
  return n?.failed_count ?? 1;
}

/**
 * Checks `code` against the row: a TOTP code (a step after `last_step`, then moved atomically) or, when `recovery`, an
 * unused recovery code (then used). Throws 429 when locked out, 400 `two_factor_invalid` when wrong (counted).
 */
export async function checkCode(deps: Deps, r: TwoFactorRow, code: unknown, recovery: boolean): Promise<"totp" | "recovery"> {
  const now = deps.now();
  if (lockedOut(r, now)) throw tooMany();
  const d1 = deps.db.d1;
  const c = typeof code === "string" ? code.trim() : "";
  if (/^\d{3}\s?\d{3}$/.test(c)) {
    const step = await verifyTotp(await openSecret(deps, r.user_id, r.secret), c, now, r.last_step);
    if (step !== null) {
      const moved = await d1.prepare(`UPDATE user_two_factor SET last_step = ?2, failed_count = 0, failed_since = NULL WHERE user_id = ?1 AND last_step < ?2 RETURNING user_id`).bind(r.user_id, step).first();
      if (moved) return "totp";
    }
  } else if (recovery) {
    const form = recoveryForm(c);
    const used = form
      ? await d1.prepare(`UPDATE user_recovery_codes SET used_at = ?3 WHERE user_id = ?1 AND code_hash = ?2 AND used_at IS NULL RETURNING user_id`).bind(r.user_id, await recoveryHash(r.user_id, form), now).first()
      : null;
    if (used) {
      await d1.prepare(`UPDATE user_two_factor SET failed_count = 0, failed_since = NULL WHERE user_id = ?1`).bind(r.user_id).run();
      return "recovery";
    }
  }
  if ((await recordFailure(deps, r)) >= TWO_FACTOR_MAX_FAILURES) throw tooMany();
  throw invalid();
}

// ---- /me/two-factor -----------------------------------------------------------------------------------------------

async function status(deps: Deps, userId: string): Promise<TwoFactorStatus> {
  const r = await deps.db.d1
    .prepare(`SELECT t.enabled_at, (SELECT COUNT(*) FROM user_recovery_codes c WHERE c.user_id = t.user_id AND c.used_at IS NULL) AS left_ FROM user_two_factor t WHERE t.user_id = ?1 AND t.enabled_at IS NOT NULL`)
    .bind(userId)
    .first<{ enabled_at: number; left_: number }>();
  return r ? { enabled: true, enabledAt: r.enabled_at, recoveryCodesLeft: r.left_ } : { enabled: false, enabledAt: null, recoveryCodesLeft: 0 };
}

async function readCode(req: Request): Promise<unknown> {
  try {
    const b = (await req.json()) as { code?: unknown } | null;
    return b && typeof b === "object" ? b.code : undefined;
  } catch {
    return undefined;
  }
}

/** `/me/two-factor…` for a session (accountRoute refuses personal access tokens before this) */
export async function twoFactorRoute(req: Request, deps: Deps, user: User, rest: string[]): Promise<Response> {
  const m = req.method;
  const d1 = deps.db.d1;
  const now = deps.now();
  if (!rest.length && m === "GET") return json(await status(deps, user.id));

  if (rest.length === 1 && rest[0] === "setup" && m === "POST") {
    const had = await rowOf(deps, user.id);
    if (had?.enabled_at != null) throw new HttpError(409, "Two-factor authentication is already on", "conflict");
    const raw = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
    const sealed = await sealSecret(deps, user.id, raw);
    await d1
      .prepare(
        `INSERT INTO user_two_factor (user_id, secret, enabled_at, pending_expires_at, last_step, failed_count, failed_since, created_at) VALUES (?1, ?2, NULL, ?3, 0, 0, NULL, ?4)
         ON CONFLICT (user_id) DO UPDATE SET secret = ?2, pending_expires_at = ?3, last_step = 0, created_at = ?4 WHERE enabled_at IS NULL`,
      )
      .bind(user.id, sealed, now + TWO_FACTOR_SETUP_TTL_MS, now)
      .run();
    const secret = base32Encode(raw);
    return json({ secret, otpauthUrl: otpauthUrl(secret, user.email) } satisfies TwoFactorSetup);
  }

  if (rest.length === 1 && rest[0] === "enable" && m === "POST") {
    const code = await readCode(req);
    const r = await rowOf(deps, user.id);
    if (r?.enabled_at != null) throw new HttpError(409, "Two-factor authentication is already on", "conflict");
    if (!r || r.pending_expires_at === null || r.pending_expires_at <= now) throw new HttpError(409, "Set up two-factor authentication again; the key has expired", "conflict");
    await checkCode(deps, r, code, false);
    await d1.prepare(`UPDATE user_two_factor SET enabled_at = ?2, pending_expires_at = NULL WHERE user_id = ?1`).bind(user.id, now).run();
    const recoveryCodes = await newRecoveryCodes(deps, user.id);
    await logForUserOrgs(deps, user, "user_two_factor_enable", req);
    return json({ recoveryCodes } satisfies TwoFactorEnabled);
  }

  if (rest.length === 1 && rest[0] === "recovery-codes" && m === "POST") {
    const code = await readCode(req);
    const r = await rowOf(deps, user.id);
    if (r?.enabled_at == null) throw new HttpError(409, "Two-factor authentication is off", "conflict");
    await checkCode(deps, r, code, true);
    return json({ recoveryCodes: await newRecoveryCodes(deps, user.id) } satisfies TwoFactorEnabled);
  }

  if (!rest.length && m === "DELETE") {
    const code = await readCode(req);
    const r = await rowOf(deps, user.id);
    if (r?.enabled_at == null) return noContent();
    await checkCode(deps, r, code, true);
    await d1.prepare(`DELETE FROM user_recovery_codes WHERE user_id = ?1`).bind(user.id).run();
    await d1.prepare(`DELETE FROM user_two_factor WHERE user_id = ?1`).bind(user.id).run();
    await logForUserOrgs(deps, user, "user_two_factor_disable", req);
    return noContent();
  }
  throw new HttpError(404, "not found");
}

// ---- sign-in ------------------------------------------------------------------------------------------------------

/** `mt`: the pending code's hash and the app's state, signed (CHALLENGE_MS) */
interface ChallengePayload {
  h: string;
  st: AppState;
  exp: number;
}

const seconds = (deps: Deps) => Math.floor(deps.now() / 1000);
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });

/** Sign-in with 2FA on: the code is stored pending and the browser goes to `/auth/2fa` */
export async function startChallenge(deps: Deps, origin: string, st: AppState, codeHash: string): Promise<Response> {
  const mt = await signToken({ h: codeHash, st, exp: seconds(deps) + CHALLENGE_MS / 1000 } satisfies ChallengePayload, sessionSecret(deps));
  return redirect(`${origin}/auth/2fa?mt=${encodeURIComponent(mt)}`);
}

async function readChallenge(deps: Deps, mt: unknown): Promise<ChallengePayload | null> {
  if (typeof mt !== "string" || mt.length > 4096) return null;
  const p = await verifyToken<ChallengePayload>(mt, sessionSecret(deps), seconds(deps));
  return p && typeof p.h === "string" && p.st && typeof p.st.s === "string" ? p : null;
}

const expired = () => messagePage(400, "This sign-in link has expired", "Start again from the app.");

/** `GET|POST /auth/2fa` */
export async function twoFactorSignIn(req: Request, url: URL, deps: Deps): Promise<Response> {
  const now = deps.now();
  if (req.method === "GET") {
    const mt = url.searchParams.get("mt");
    const p = await readChallenge(deps, mt);
    if (!p || !(await deps.db.pendingAuthCode(p.h, now))) return p ? backWithError(p.st, "two_factor_failed") : expired();
    return twoFactorPage(mt!);
  }
  if (req.method !== "POST") throw new HttpError(405, "method not allowed");
  const form = await req.formData().catch(() => null);
  const mt = form?.get("mt");
  const p = await readChallenge(deps, mt);
  if (!p) return expired();
  const pending = await deps.db.pendingAuthCode(p.h, now);
  if (!pending) return backWithError(p.st, "two_factor_failed");
  const r = await rowOf(deps, pending.userId);
  if (r?.enabled_at == null) {
    // 2FA turned off meanwhile: nothing to ask
  } else {
    try {
      await checkCode(deps, r, form?.get("code"), true);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      if (e.status === 429) return twoFactorPage(mt as string, e.message, 429);
      return twoFactorPage(mt as string, e.message, 400);
    }
  }
  const taken = await deps.db.takePendingAuthCode(p.h, now);
  if (!taken) return backWithError(p.st, "two_factor_failed");
  const code = randomToken();
  await deps.db.putAuthCode(await sha256b64url(code), taken.userId, taken.challenge, now + CODE_MS, taken.auth, taken.orgId);
  return redirect(appBack(p.st, { code }));
}
