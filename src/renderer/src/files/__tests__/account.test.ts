import { describe, expect, it } from "vitest";
import { SIGN_IN_ERROR_TEXT } from "@shared/org/identity";
import type { MenuEntry, MenuItem } from "@/ds";
import { accountMenu, signInFailure } from "../account";

const state = { server: "https://s", signingIn: false, user: null };

describe("account menu", () => {
  const me = { id: "u", email: "me@x.co", name: "Me", picture: null };
  const other = { id: "v", email: "work@y.co", name: null, picture: "data:image/png;base64,AA" };
  const labels = (entries: MenuEntry[]) => entries.map((e) => (e === "-" ? "-" : "label" in e ? e.label : e.header));

  it("is Figma's when signed in: the header, Change theme and Settings, Add account and Log out — no Community", () => {
    const m = accountMenu({ ...state, user: me, accounts: [me] }, { theme: "dark", multi: true });
    expect(labels(m)).toEqual(["Me", "-", "Change theme", "Settings", "-", "Add account", "Log out"]);
    expect(m[0]).toEqual({ id: "profile", label: "Me", profile: { email: "me@x.co" } });
    const theme = m[2] as MenuItem;
    expect(theme.icon).toBe("24.window.layout");
    expect((m[3] as MenuItem).icon).toBe("24.sliders");
    expect(theme.items).toEqual([
      { id: "theme:light", label: "Light", checked: false },
      { id: "theme:dark", label: "Dark", checked: true },
      { id: "theme:system", label: "Use system setting", checked: false },
    ]);
    expect(m.slice(5)).toEqual([
      { id: "add-account", label: "Add account", icon: "24.plus" },
      { id: "log-out", label: "Log out", icon: "24.log-out" },
    ]);
    expect(JSON.stringify(m)).not.toMatch(/Community/);
  });

  it("lists the accounts with the current one checked, and Log out of all accounts, when more than one is signed in", () => {
    const m = accountMenu({ ...state, user: other, accounts: [me, other] }, { theme: "system", multi: true });
    expect(labels(m)).toEqual(["work@y.co", "-", "Change theme", "Settings", "-", "Me", "work@y.co", "Add account", "Log out", "Log out of all accounts"]);
    expect(m[0]).toEqual({ id: "profile", label: "work@y.co", profile: { email: "work@y.co", picture: other.picture } });
    expect(m[5]).toEqual({ id: "account:u", label: "Me", hint: "me@x.co", avatar: { name: "Me" }, checked: false, checkEnd: true });
    expect(m[6]).toEqual({ id: "account:v", label: "work@y.co", avatar: { name: "work@y.co", picture: other.picture }, checked: true, checkEnd: true });
  });

  it("has no Add account where only one account can be signed in (a browser)", () => {
    expect(labels(accountMenu({ ...state, user: me }, { theme: "system" }))).toEqual(["Me", "-", "Change theme", "Settings", "-", "Log out"]);
  });

  it("offers Log in when signed out, Cancel while the browser is open", () => {
    expect(labels(accountMenu(null))).toEqual(["Change theme", "Settings"]);
    expect(labels(accountMenu(state))).toEqual(["Log in with Google…", "-", "Change theme", "Settings"]);
    expect(labels(accountMenu({ ...state, signingIn: true }))).toEqual(["Waiting for the browser…", "Cancel", "-", "Change theme", "Settings"]);
  });

  it("toasts failures and timeouts, not a cancel", () => {
    expect(signInFailure({ ok: false, error: "cancelled", state })).toBeNull();
    expect(signInFailure({ ok: false, error: "timeout", state })).toMatch(/timed out/);
    expect(signInFailure({ ok: false, error: "failed", state })).toMatch(/Couldn’t log in/);
    expect(signInFailure({ ok: true, state })).toBeNull();
  });

  it("says why single sign-on refused (docs/desktop.md §18.1), not a raw code", () => {
    for (const code of ["sso_failed", "sso_domain", "google_required"] as const) expect(signInFailure({ ok: false, error: "failed", message: SIGN_IN_ERROR_TEXT[code], state })).toBe(SIGN_IN_ERROR_TEXT[code]);
    expect(signInFailure({ ok: false, error: "failed", message: "token exchange 500", state })).toMatch(/Couldn’t log in/);
  });
});
