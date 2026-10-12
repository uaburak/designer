/**
 * Two-factor authentication (docs/governance.md §2.4, §4): RFC 6238 through the shared helper and the server's sealed
 * secret, setup / enable / regenerate / disable with the activity in each org, step replay, recovery codes, the
 * rate limit, and the challenge page on Google and SAML sign-ins before `/auth/token` accepts the code. node:sqlite.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ORIGIN, identityWorld, type IdentityWorld } from "../testing/identityWorld";
import { buildResponse, signAssertion, testKeys } from "../testing/samlIdp";
import { base32Decode, totpCode, totpStep, verifyTotp } from "../../../src/shared/org/governance";
import { sha256b64url } from "../tokens";
import { openSecret, sealSecret } from "./twoFactor";

let w: IdentityWorld;
beforeAll(() => void testKeys(), 30_000);
beforeEach(async () => {
  w = await identityWorld();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const codeAt = (secret: Uint8Array, ms = w.now.t) => totpCode(secret, totpStep(ms));
const nextStep = () => void (w.now.t += 30_000);

/** Turns 2FA on for the session → the secret and the recovery codes */
async function enable(token: string): Promise<{ secret: Uint8Array; recoveryCodes: string[] }> {
  const setup = await w.call("POST", "/me/two-factor/setup", { token });
  expect(setup.status, setup.text).toBe(200);
  const secret = base32Decode(setup.body.secret)!;
  const on = await w.call("POST", "/me/two-factor/enable", { token, body: { code: await codeAt(secret) } });
  expect(on.status, on.text).toBe(200);
  return { secret, recoveryCodes: on.body.recoveryCodes };
}

const actions = async (orgId = w.orgId) => (await w.rows<{ action: string; actor_id: string }>(`SELECT action, actor_id FROM activity_log WHERE org_id = ?1 ORDER BY id`, orgId)).map((r) => r.action);

describe("TOTP (RFC 6238, SHA-1, 6 digits, 30 s)", () => {
  it("matches the RFC's vectors through the shared helper and the server's sealed secret", async () => {
    const raw = new TextEncoder().encode("12345678901234567890");
    const sealed = await sealSecret(w.deps, "u1", raw);
    expect(sealed).not.toContain("12345678901234567890");
    const secret = await openSecret(w.deps, "u1", sealed);
    for (const [t, code] of [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]] as const)
      expect(await totpCode(secret, Math.floor(t / 30))).toBe(code);
    // ±1 step, never at or before the last accepted one
    expect(await verifyTotp(secret, "287082", 59_000 + 30_000, 0)).toBe(1);
    expect(await verifyTotp(secret, "287082", 59_000 + 60_000, 0)).toBeNull();
    expect(await verifyTotp(secret, "287082", 59_000, 1)).toBeNull();
    // sealed per user: another user's row can't be opened with it
    await expect(openSecret(w.deps, "u2", sealed)).rejects.toThrow();
  });
});

describe("/me/two-factor", () => {
  it("sets up (pending 10 minutes), enables with a code, regenerates and disables; logs in each of the person's orgs", async () => {
    const t = w.admin.token;
    expect((await w.call("GET", "/me/two-factor", { token: t })).body).toEqual({ enabled: false, enabledAt: null, recoveryCodesLeft: 0 });
    // a second org of alice's
    const other = (await w.call("POST", "/orgs", { token: t, body: { name: "Other" } })).body.org.id as string;
    // a setup that expired
    const old = await w.call("POST", "/me/two-factor/setup", { token: t });
    expect(old.body.otpauthUrl).toBe(`otpauth://totp/Designer%3Aalice%40acme.test?secret=${old.body.secret}&issuer=Designer&algorithm=SHA1&digits=6&period=30`);
    w.now.t += 11 * 60_000;
    const late = await w.call("POST", "/me/two-factor/enable", { token: t, body: { code: await codeAt(base32Decode(old.body.secret)!) } });
    expect(late.status).toBe(409);
    // a wrong code, then the right one
    const setup = await w.call("POST", "/me/two-factor/setup", { token: t });
    const secret = base32Decode(setup.body.secret)!;
    const wrong = await w.call("POST", "/me/two-factor/enable", { token: t, body: { code: "000000" === (await codeAt(secret)) ? "111111" : "000000" } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("two_factor_invalid");
    const on = await w.call("POST", "/me/two-factor/enable", { token: t, body: { code: await codeAt(secret) } });
    expect(on.status).toBe(200);
    expect(on.body.recoveryCodes).toHaveLength(10);
    for (const c of on.body.recoveryCodes) expect(c).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    // stored as hashes only; the secret sealed
    const stored = await w.rows(`SELECT code_hash FROM user_recovery_codes WHERE user_id = ?1`, w.admin.id);
    expect(stored).toHaveLength(10);
    expect(JSON.stringify(stored)).not.toContain(on.body.recoveryCodes[0]);
    expect(JSON.stringify(await w.rows(`SELECT secret FROM user_two_factor`))).not.toContain(setup.body.secret);
    expect((await w.call("GET", "/me/two-factor", { token: t })).body).toEqual({ enabled: true, enabledAt: w.now.t, recoveryCodesLeft: 10 });
    expect((await w.call("POST", "/me/two-factor/setup", { token: t })).status).toBe(409);
    // regenerate: the old codes stop working
    nextStep();
    const again = await w.call("POST", "/me/two-factor/recovery-codes", { token: t, body: { code: await codeAt(secret) } });
    expect(again.status).toBe(200);
    expect(again.body.recoveryCodes).not.toEqual(on.body.recoveryCodes);
    const stale = await w.call("DELETE", "/me/two-factor", { token: t, body: { code: on.body.recoveryCodes[0] } });
    expect(stale.status).toBe(400);
    // disable with a recovery code
    expect((await w.call("DELETE", "/me/two-factor", { token: t, body: { code: again.body.recoveryCodes[3].toUpperCase() } })).status).toBe(204);
    expect((await w.call("GET", "/me/two-factor", { token: t })).body.enabled).toBe(false);
    expect(await w.rows(`SELECT * FROM user_recovery_codes`)).toHaveLength(0);
    for (const org of [w.orgId, other]) {
      const a = await actions(org);
      expect(a.filter((x) => x.startsWith("user_two_factor"))).toEqual(["user_two_factor_enable", "user_two_factor_disable"]);
    }
  });

  it("refuses a step already used (replay) and accepts the next one", async () => {
    const t = w.admin.token;
    const { secret } = await enable(t);
    const used = await codeAt(secret);
    const replay = await w.call("POST", "/me/two-factor/recovery-codes", { token: t, body: { code: used } });
    expect(replay.status).toBe(400);
    // the previous step (inside the ±1 window) is older than the accepted one: refused too
    const before = await totpCode(secret, totpStep(w.now.t) - 1);
    expect((await w.call("POST", "/me/two-factor/recovery-codes", { token: t, body: { code: before } })).status).toBe(400);
    nextStep();
    expect((await w.call("POST", "/me/two-factor/recovery-codes", { token: t, body: { code: await codeAt(secret) } })).status).toBe(200);
  });

  it("answers 429 after 5 failures in 10 minutes, even to the right code, until the window passes", async () => {
    const t = w.admin.token;
    const { secret } = await enable(t);
    nextStep();
    const right = await codeAt(secret);
    const wrong = right === "123456" ? "654321" : "123456";
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await w.call("DELETE", "/me/two-factor", { token: t, body: { code: wrong } })).status);
    expect(statuses).toEqual([400, 400, 400, 400, 429]);
    const locked = await w.call("DELETE", "/me/two-factor", { token: t, body: { code: right } });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("rate_limited");
    w.now.t += 10 * 60_000;
    expect((await w.call("DELETE", "/me/two-factor", { token: t, body: { code: await codeAt(secret) } })).status).toBe(204);
  });

  it("parallel guesses can't pass the limit: each takes its slot before the code is checked (review fix)", async () => {
    const t = w.admin.token;
    const { secret } = await enable(t);
    nextStep();
    const right = await codeAt(secret);
    const wrong = right === "123456" ? "654321" : "123456";
    // 19 wrong guesses and the right code, all at once: the right one comes after the limit
    const statuses = await Promise.all(Array.from({ length: 20 }, (_, i) => w.call("DELETE", "/me/two-factor", { token: t, body: { code: i === 19 ? right : wrong } }).then((r) => r.status)));
    expect(statuses.filter((s) => s === 400)).toHaveLength(4);
    expect(statuses.filter((s) => s === 429)).toHaveLength(16);
    expect((await w.call("GET", "/me/two-factor", { token: t })).body.enabled).toBe(true);
    expect((await w.rows<{ failed_count: number }>(`SELECT failed_count FROM user_two_factor WHERE user_id = ?1`, w.admin.id))[0].failed_count).toBe(5);
    // a success resets the count
    w.now.t += 10 * 60_000;
    expect((await w.call("POST", "/me/two-factor/recovery-codes", { token: t, body: { code: wrong } })).status).toBe(400);
    nextStep();
    const batch = vi.spyOn(w.d1, "batch" as never);
    const again = await w.call("POST", "/me/two-factor/recovery-codes", { token: t, body: { code: await codeAt(secret) } });
    expect(again.status).toBe(200);
    // the new recovery codes replace the old ones in one batch (atomic)
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await w.rows(`SELECT 1 FROM user_recovery_codes WHERE user_id = ?1`, w.admin.id)).toHaveLength(10);
    expect((await w.rows<{ failed_count: number; failed_since: number | null }>(`SELECT failed_count, failed_since FROM user_two_factor WHERE user_id = ?1`, w.admin.id))[0]).toEqual({ failed_count: 0, failed_since: null });
  });

  it("is the session's: a personal access token can't reach it", async () => {
    const pat = await w.call("POST", "/me/tokens", { token: w.admin.token, body: { description: "x", expiresInDays: 30, scopes: ["current_user:read"] } });
    expect(pat.status, pat.text).toBe(201);
    expect((await w.call("GET", "/me/two-factor", { token: pat.body.token })).status).toBe(403);
  });
});

describe("the sign-in challenge (/auth/2fa)", () => {
  /** The Google flow for alice (her account made a Google one) */
  async function google() {
    await w.run(`UPDATE users SET google_sub = 'g-alice' WHERE id = ?1`, w.admin.id);
    return w.googleFlow({ sub: "g-alice", email: "alice@acme.test", name: "Alice" });
  }
  const mtOf = (location: URL) => location.searchParams.get("mt")!;

  it("Google: no code on the loopback until the 6-digit code; then a fresh code a session is made of", async () => {
    const { secret } = await enable(w.admin.token);
    nextStep();
    const g = await google();
    expect(g.res.status).toBe(302);
    expect(g.res.location!.origin + g.res.location!.pathname).toBe(`${ORIGIN}/auth/2fa`);
    expect(g.res.location!.searchParams.has("code")).toBe(false);
    const mt = mtOf(g.res.location!);
    // the pending code exists and /auth/token refuses it
    const pending = await w.rows<{ mfa_pending: number; code_hash: string }>(`SELECT mfa_pending, code_hash FROM auth_codes`);
    expect(pending).toEqual([expect.objectContaining({ mfa_pending: 1 })]);
    await w.deps.db.putAuthCode(await sha256b64url("pending-code"), w.admin.id, await sha256b64url("v".repeat(43)), w.now.t + 60_000, "google", null, true);
    expect((await w.call("POST", "/auth/token", { body: { code: "pending-code", verifier: "v".repeat(43) } })).status).toBe(400);
    // (the same row passed would be accepted)
    await w.run(`UPDATE auth_codes SET mfa_pending = 0 WHERE code_hash = ?1`, await sha256b64url("pending-code"));
    expect((await w.call("POST", "/auth/token", { body: { code: "pending-code", verifier: "v".repeat(43) } })).status).toBe(200);
    // the page
    const page = await w.call("GET", `/auth/2fa?mt=${encodeURIComponent(mt)}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Enter the 6-digit code from your authenticator app");
    // a wrong code: the page again, with the error
    const right = await codeAt(secret);
    const bad = await w.call("POST", "/auth/2fa", { form: { mt, code: right === "000000" ? "111111" : "000000" } });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("That code didn");
    // the right one: the loopback with a code, traded for a session
    const ok = await w.call("POST", "/auth/2fa", { form: { mt, code: right } });
    expect(ok.status).toBe(302);
    expect(ok.location!.origin + ok.location!.pathname).toBe("http://127.0.0.1:50123/callback");
    const s = await w.token(ok.location!, g.verifier);
    expect(s.status, s.text).toBe(200);
    expect(s.body.user.id).toBe(w.admin.id);
    // the challenge is single use
    const twice = await w.call("POST", "/auth/2fa", { form: { mt, code: right } });
    expect(twice.location!.searchParams.get("error")).toBe("two_factor_failed");
    // without 2FA a sign-in goes straight to the loopback
    nextStep();
    await w.call("DELETE", "/me/two-factor", { token: w.admin.token, body: { code: await codeAt(secret) } });
    expect((await google()).res.location!.searchParams.get("code")).toBeTruthy();
  });

  it("accepts a recovery code once; 5 failures lock the page with 429", async () => {
    const { secret, recoveryCodes } = await enable(w.admin.token);
    const g = await google();
    const mt = mtOf(g.res.location!);
    const ok = await w.call("POST", "/auth/2fa", { form: { mt, code: recoveryCodes[0] } });
    expect(ok.location!.searchParams.get("code")).toBeTruthy();
    expect((await w.call("GET", "/me/two-factor", { token: w.admin.token })).body.recoveryCodesLeft).toBe(9);
    // the same recovery code again: refused
    const g2 = await google();
    const mt2 = mtOf(g2.res.location!);
    expect((await w.call("POST", "/auth/2fa", { form: { mt: mt2, code: recoveryCodes[0] } })).status).toBe(400);
    for (let i = 0; i < 3; i++) await w.call("POST", "/auth/2fa", { form: { mt: mt2, code: "zzzz-zzzz" } });
    const fifth = await w.call("POST", "/auth/2fa", { form: { mt: mt2, code: "zzzz-zzzz" } });
    expect(fifth.status).toBe(429);
    nextStep();
    expect((await w.call("POST", "/auth/2fa", { form: { mt: mt2, code: await codeAt(secret) } })).status).toBe(429);
    // an expired or forged challenge
    expect((await w.call("GET", "/auth/2fa?mt=forged")).status).toBe(400);
  });

  it("SAML: the ACS sends the browser to the challenge too", async () => {
    const tenant = await w.addIdp();
    await w.verifiedDomain("acme.test");
    const { secret } = await enable(w.admin.token);
    nextStep();
    const s = await w.samlStart(tenant);
    const xml = signAssertion(buildResponse({ sp: `${ORIGIN}/saml/${tenant}`, inResponseTo: s.requestId, nameId: "alice@acme.test" }));
    const acs = await w.acs(tenant, xml, s.requestId);
    expect(acs.status).toBe(302);
    expect(acs.location!.pathname).toBe("/auth/2fa");
    const ok = await w.call("POST", "/auth/2fa", { form: { mt: mtOf(acs.location!), code: await codeAt(secret) } });
    const session = await w.token(ok.location!, s.verifier);
    expect(session.status).toBe(200);
    expect((await w.call("GET", "/me", { token: session.body.token })).body.session).toMatchObject({ auth: "saml" });
  });
});
