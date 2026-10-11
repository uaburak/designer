import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handle } from "../../../server/src/api";
import { loadIdp, loadWorld, ORIGIN, type TestIdp, type World } from "./testWorld";
import { SIGN_IN_ERROR_TEXT } from "../../shared/org/identity";
import { loopbackError, signInTenant, signInWithBrowser, SignInError } from "./signIn";

/**
 * The desktop sign-in (docs/multiplayer.md §2, §15.4; docs/desktop.md §18.1) against the Worker's real handler on
 * node:sqlite (round 4a's identity world): the app's loopback is real HTTP, the "browser" follows the server's
 * redirects, plays Google (its token endpoint faked by the world) or the org's IdP (a test IdP signing in Node).
 */

let w: World;
let idp: TestIdp;
/** What the person does at Google: "allow" sends a code back, "deny" an error */
let googleAnswer: "allow" | "deny";
/** Who the IdP says signed in */
let idpUser: string;

beforeAll(async () => {
  idp = await loadIdp();
  idp.testKeys();
}, 30_000);
beforeEach(async () => {
  googleAnswer = "allow";
  idpUser = "eve@acme.test";
  w = await loadWorld();
  Object.assign(w.google, { sub: "g-42", email: "me@example.com", name: "Me" });
});

/** The app's calls to the server go to the Worker's handler; the loopback is real HTTP. */
const appFetch: typeof fetch = (input, init) => {
  const url = String(input);
  return url.startsWith(ORIGIN) ? handle(new Request(url, init), w.deps) : fetch(input, init);
};
const server = (url: string | URL, init?: RequestInit) => handle(new Request(new URL(String(url), ORIGIN), init), w.deps);

/** The system browser: from the app's /auth/login to its loopback, through Google or the org's IdP. */
async function browser(start: string): Promise<string> {
  let url = new URL(start);
  // The login page (HTML) — the person clicks Continue with Google, unless the link went straight to an org's SSO.
  if (!url.searchParams.has("tenant")) url.searchParams.set("method", "google");
  let tenant = "";
  for (let hop = 0; hop < 10; hop++) {
    if (url.hostname === "127.0.0.1") return (await fetch(url)).text();
    tenant = /^\/saml\/(\d{18})\//.exec(url.pathname)?.[1] ?? tenant;
    if (url.href.startsWith(idp.IDP_SSO)) {
      const relay = url.searchParams.get("RelayState")!;
      const sp = `${ORIGIN}/saml/${tenant}`;
      const xml = idp.signAssertion(idp.buildResponse({ sp, inResponseTo: relay, nameId: idpUser }));
      const body = new URLSearchParams({ SAMLResponse: Buffer.from(xml).toString("base64"), RelayState: relay });
      const res = await server(`/saml/${tenant}/consume`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
      url = new URL(res.headers.get("location") ?? `${ORIGIN}/acs-answered-${res.status}`);
      continue;
    }
    const res = await server(url);
    const loc = res.headers.get("location");
    if (!loc) throw new Error(`${url.pathname}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    url = new URL(loc, ORIGIN);
    if (url.href.startsWith("https://accounts.google.com")) {
      const cb = new URL(`${ORIGIN}/auth/callback`);
      cb.searchParams.set("state", url.searchParams.get("state")!);
      if (googleAnswer === "allow") cb.searchParams.set("code", "c");
      else cb.searchParams.set("error", "access_denied");
      url = cb;
    }
  }
  throw new Error("too many redirects");
}

const me = async (token: string) => (await (await appFetch(`${ORIGIN}/me`, { headers: { authorization: `Bearer ${token}` } })).json()) as { email: string; name: string };

describe("signInWithBrowser", () => {
  it("signs in through the browser and the loopback, ending with a session the server accepts", async () => {
    let shown = "";
    const s = await signInWithBrowser({ server: ORIGIN, fetch: appFetch, openBrowser: (u) => void browser(u).then((t) => (shown = t)) });
    expect(s.user.email).toBe("me@example.com");
    expect(s.expiresAt).toBeGreaterThan(Date.now() + 20 * 86400_000);
    expect((await me(s.token)).name).toBe("Me");
    await new Promise((r) => setTimeout(r, 20));
    expect(shown).toContain("You're signed in");
  });

  it("reports a refusal in the browser as cancelled", async () => {
    googleAnswer = "deny";
    await expect(signInWithBrowser({ server: ORIGIN, fetch: appFetch, openBrowser: (u) => void browser(u) })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("ignores a callback with someone else's state, and times out", async () => {
    let loopback = "";
    const p = signInWithBrowser({ server: ORIGIN, fetch: appFetch, timeoutMs: 300, openBrowser: (u) => void (loopback = `http://127.0.0.1:${new URL(u).searchParams.get("port")}`) });
    await new Promise((r) => setTimeout(r, 30));
    const stale = await fetch(`${loopback}/callback?state=${"x".repeat(32)}&code=abc`);
    expect(stale.status).toBe(400);
    await expect(p).rejects.toBeInstanceOf(SignInError);
    await expect(p).rejects.toMatchObject({ code: "timeout" });
  });

  it("can be cancelled", async () => {
    const ac = new AbortController();
    const p = signInWithBrowser({ server: ORIGIN, fetch: appFetch, signal: ac.signal, openBrowser: () => {} });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("single sign-on (docs/desktop.md §18.1)", () => {
  it("a tenant goes on the login URL and straight to the org's IdP; the SAML sign-in ends in a session", async () => {
    const tenant = await w.addIdp();
    await w.verifiedDomain("acme.test");
    let opened = "";
    const s = await signInWithBrowser({ server: ORIGIN, fetch: appFetch, tenant, openBrowser: (u) => void browser((opened = u)) });
    expect(new URL(opened).searchParams.get("tenant")).toBe(tenant);
    expect(new URL(opened).pathname).toBe("/auth/login");
    expect(s.user.email).toBe("eve@acme.test");
    expect((await me(s.token)).email).toBe("eve@acme.test");
  });

  it("an SSO refusal arrives on the loopback with its text (sso_domain) — failed, not cancelled", async () => {
    const tenant = await w.addIdp();
    await w.verifiedDomain("acme.test");
    idpUser = "eve@elsewhere.test";
    let shown = "";
    const p = signInWithBrowser({ server: ORIGIN, fetch: appFetch, tenant, openBrowser: (u) => void browser(u).then((t) => (shown = t)) });
    await expect(p).rejects.toMatchObject({ code: "failed", message: SIGN_IN_ERROR_TEXT.sso_domain });
    await new Promise((r) => setTimeout(r, 20));
    expect(shown).toContain("verified domain");
  });

  it("google_required and sso_failed on the loopback carry their messages", async () => {
    for (const error of ["google_required", "sso_failed"] as const) {
      let port = "";
      let state = "";
      const p = signInWithBrowser({ server: ORIGIN, fetch: appFetch, openBrowser: (u) => void ((port = new URL(u).searchParams.get("port")!), (state = new URL(u).searchParams.get("state")!)) });
      await new Promise((r) => setTimeout(r, 20));
      const failure = p.catch((e: unknown) => e);
      const page = await (await fetch(`http://127.0.0.1:${port}/callback?state=${state}&error=${error}`)).text();
      expect(await failure).toMatchObject({ code: "failed", message: SIGN_IN_ERROR_TEXT[error] });
      expect(page).toContain(SIGN_IN_ERROR_TEXT[error]);
    }
  });

  it("refuses a tenant that isn't 18 digits before opening the browser", async () => {
    let opened = false;
    await expect(signInWithBrowser({ server: ORIGIN, fetch: appFetch, tenant: "12345&x=1", openBrowser: () => void (opened = true) })).rejects.toMatchObject({ code: "failed" });
    expect(opened).toBe(false);
  });

  it("loopbackError: Google's refusal is a cancel, unknown errors stay failed with the raw value", () => {
    expect(loopbackError("access_denied").code).toBe("cancelled");
    expect(loopbackError("server_error")).toMatchObject({ code: "failed", message: "server_error" });
    expect(loopbackError(null)).toMatchObject({ code: "failed", message: "no code" });
    expect(loopbackError("toString")).toMatchObject({ code: "failed", message: "toString" });
  });

  it("the deep link: designer://sign-in?tenant=<18 digits> only", () => {
    expect(signInTenant("designer://sign-in?tenant=123456789012345678")).toBe("123456789012345678");
    expect(signInTenant("designer:///sign-in?tenant=123456789012345678")).toBe("123456789012345678");
    expect(signInTenant("designer://sign-in?tenant=12345")).toBeNull();
    expect(signInTenant("designer://open?key=abc")).toBeNull();
    expect(signInTenant("designerv2://sign-in?tenant=123456789012345678")).toBeNull();
    expect(signInTenant("not a url")).toBeNull();
  });

  it("the server's IdP-initiated bounce links to the scheme the app registers", async () => {
    const tenant = await w.addIdp();
    const res = await w.acs(tenant, idp.signAssertion(idp.buildResponse({ sp: `${ORIGIN}/saml/${tenant}`, inResponseTo: null, nameId: "eve@acme.test" })));
    expect(res.text).toContain(`designer://sign-in?tenant=${tenant}`);
    expect(signInTenant(`designer://sign-in?tenant=${tenant}`)).toBe(tenant);
  });
});
