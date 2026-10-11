// @vitest-environment happy-dom
/**
 * The web app's sign-in (docs/multiplayer.md §15.4, §15.17): Log in with Google goes straight to Google
 * (`method=google`), an org's SSO by its tenant, the IdP's bounce `/?sso=<tenant>` starts the same SP-initiated sign-in,
 * and single sign-on's refusals come back with their texts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_IN_ERROR_TEXT } from "@shared/org/identity";

const TENANT = "123456789012345678";
let assigned: string[] = [];

beforeEach(() => {
  vi.resetModules();
  assigned = [];
  sessionStorage.clear();
  localStorage.clear();
  vi.spyOn(window.location, "assign").mockImplementation((u: string | URL) => void assigned.push(String(u)));
});
afterEach(() => vi.restoreAllMocks());

const load = () => import("../webAccount");
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("the web app's sign-in", () => {
  it("Log in with Google adds method=google; an org's tenant goes to its IdP; a bad tenant is refused", async () => {
    const { webAccount } = await load();
    void webAccount.signIn();
    await settle();
    const google = new URL(assigned[0]);
    expect(google.pathname).toBe("/auth/login");
    expect(google.searchParams.get("method")).toBe("google");
    expect(google.searchParams.get("tenant")).toBeNull();
    expect(google.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(google.searchParams.get("return")).toBe(location.href);
    void webAccount.signIn({ tenant: TENANT });
    await settle();
    const sso = new URL(assigned[1]);
    expect(sso.searchParams.get("tenant")).toBe(TENANT);
    expect(sso.searchParams.get("method")).toBeNull();
    expect(await webAccount.signIn({ tenant: "12" })).toMatchObject({ ok: false, error: "failed" });
    expect(assigned).toHaveLength(2);
  });

  it("the IdP's bounce (/?sso=<tenant>) starts an SP-initiated sign-in and leaves the address clean", async () => {
    history.replaceState(null, "", `/?files&sso=${TENANT}`);
    const { completeWebSignIn } = await load();
    void completeWebSignIn();
    await settle();
    expect(new URL(assigned[0]).searchParams.get("tenant")).toBe(TENANT);
    expect(location.search).toBe("?files=");
    history.replaceState(null, "", "/");
  });

  it("a refused SSO comes back with its text", async () => {
    sessionStorage.setItem("designer.web.signin", JSON.stringify({ state: "st", verifier: "v" }));
    history.replaceState(null, "", "/?auth_error=sso_domain&auth_state=st");
    const { completeWebSignIn, webSignInResult } = await load();
    const r = await completeWebSignIn();
    expect(r).toMatchObject({ ok: false, error: "failed", message: SIGN_IN_ERROR_TEXT.sso_domain });
    expect(await webSignInResult()).toBe(r);
    expect(location.search).toBe("");
  });
});
