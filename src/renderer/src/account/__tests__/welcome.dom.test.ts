// @vitest-environment happy-dom
/**
 * The welcome page (docs/desktop.md §18.6) on a fake account: the splash while the kept session loads and while a
 * signed-in window takes over (never the page for someone signed in), the page signed out, Log in with Google / SSO,
 * "Waiting for Google…" with Cancel, a failure's text.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { welcomeScreen, type AccountState, type SignInMethod, type SignInResult } from "@shared/account";
import { SIGN_IN_ERROR_TEXT } from "@shared/org/identity";
import { $, mount, type Mounted } from "@/ds/__tests__/dom";
import { WELCOME_TEXT, WelcomeScreen, type WelcomeAccount } from "../Welcome";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
});

const base: AccountState = { server: "https://s", user: null, signingIn: false };
const me = { id: "u1", email: "me@example.com", name: "Me", picture: null };

function fakeAccount(initial: AccountState) {
  let state = initial;
  const listeners = new Set<(s: AccountState) => void>();
  const calls: string[] = [];
  let answer: (r: SignInResult) => void = () => {};
  const account: WelcomeAccount = {
    get: async () => state,
    signIn: (opts?: { method?: SignInMethod }) => {
      calls.push(`signIn:${opts?.method}`);
      return new Promise<SignInResult>((r) => (answer = r));
    },
    cancelSignIn: async () => {
      calls.push("cancel");
      state = { ...state, signingIn: false };
      answer({ ok: false, error: "cancelled", state });
      return state;
    },
    onChanged: (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
  };
  return {
    account,
    calls,
    say: (s: AccountState) => act(() => ((state = s), listeners.forEach((l) => l(s)))),
    answer: (r: SignInResult) => act(() => answer(r)),
  };
}

const screen = () => $("[data-welcome]")?.getAttribute("data-welcome");
const text = () => document.body.textContent ?? "";
const click = (sel: string) => act(() => void $(sel).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

describe("welcomeScreen: the no-flash rule", () => {
  it("splash until the session is known and while signed in; the page only for someone known to be signed out", () => {
    expect(welcomeScreen(null)).toBe("splash");
    expect(welcomeScreen({ ...base, loading: true })).toBe("splash");
    expect(welcomeScreen({ ...base, loading: true, signingIn: true })).toBe("splash");
    expect(welcomeScreen({ ...base, user: me })).toBe("splash");
    expect(welcomeScreen(base)).toBe("welcome");
    expect(welcomeScreen({ ...base, signingIn: true })).toBe("signing-in");
  });
});

describe("the welcome page", () => {
  it("shows the splash (the logo alone) while the keychain answers, then the page; a signed-in answer never shows it", async () => {
    const loading = fakeAccount({ ...base, loading: true });
    m = mount(WelcomeScreen, { account: loading.account, version: "1.0.0" });
    await flush();
    expect(screen()).toBe("splash");
    expect(text()).not.toContain(WELCOME_TEXT.google);
    loading.say({ ...base, user: me });
    expect(screen()).toBe("splash");
    expect(text()).not.toContain(WELCOME_TEXT.title);
    m.unmount();

    const out = fakeAccount({ ...base, loading: true });
    m = mount(WelcomeScreen, { account: out.account, version: "1.0.0" });
    await flush();
    out.say(base);
    expect(screen()).toBe("welcome");
    expect(text()).toContain(WELCOME_TEXT.title);
    expect(text()).toContain("Wecra 1.0.0");
    expect($("[data-welcome-google]").textContent).toBe(WELCOME_TEXT.google);
    expect($("[data-welcome-sso]").textContent).toBe(WELCOME_TEXT.sso);
  });

  it("Log in with Google: waiting with Cancel; Cancel goes back to the page without an error", async () => {
    const fake = fakeAccount(base);
    m = mount(WelcomeScreen, { account: fake.account });
    await flush();
    click("[data-welcome-google]");
    expect(fake.calls).toEqual(["signIn:google"]);
    expect(screen()).toBe("signing-in");
    expect(text()).toContain(WELCOME_TEXT.waitingGoogle);
    click("[data-welcome-cancel]");
    await flush();
    expect(fake.calls).toEqual(["signIn:google", "cancel"]);
    expect(screen()).toBe("welcome");
    expect($("[data-welcome-error]")).toBeNull();
  });

  it("Log in with SSO waits for single sign-on; a refusal's text is shown, and goes with the next try", async () => {
    const fake = fakeAccount(base);
    m = mount(WelcomeScreen, { account: fake.account });
    await flush();
    click("[data-welcome-sso]");
    expect(fake.calls).toEqual(["signIn:sso"]);
    expect(text()).toContain(WELCOME_TEXT.waitingSso);
    fake.answer({ ok: false, error: "failed", message: SIGN_IN_ERROR_TEXT.sso_domain, state: base });
    await flush();
    expect(screen()).toBe("welcome");
    expect($("[data-welcome-error]").textContent).toContain(SIGN_IN_ERROR_TEXT.sso_domain);
    click("[data-welcome-google]");
    expect($("[data-welcome-error]")).toBeNull();
    fake.answer({ ok: false, error: "failed", message: "token exchange 500", state: base });
    await flush();
    expect($("[data-welcome-error]").textContent).toContain("Couldn’t log in. Try again.");
  });

  it("signed in: the splash stays until the app window replaces this one", async () => {
    const fake = fakeAccount(base);
    m = mount(WelcomeScreen, { account: fake.account });
    await flush();
    click("[data-welcome-google]");
    fake.answer({ ok: true, state: { ...base, user: me } });
    await flush();
    expect(screen()).toBe("splash");
  });
});
