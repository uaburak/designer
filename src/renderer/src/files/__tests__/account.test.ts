import { describe, expect, it } from "vitest";
import { accountMenu, signInFailure } from "../account";

const state = { server: "https://s", signingIn: false, user: null };

describe("account menu", () => {
  it("offers Log in when signed out, Cancel while the browser is open, the email, Settings and Log out when signed in", () => {
    const settings = { id: "settings", label: "Settings" };
    expect(accountMenu(null)).toEqual([settings]);
    expect(accountMenu(state)).toEqual([{ id: "log-in", label: "Log in with Google…" }, "-", settings]);
    expect(accountMenu({ ...state, signingIn: true }).map((e) => (typeof e === "object" && "label" in e ? e.label : e))).toEqual(["Waiting for the browser…", "Cancel", "-", "Settings"]);
    expect(accountMenu({ ...state, user: { id: "u", email: "me@x.co", name: "Me", picture: null } })).toEqual([{ header: "me@x.co" }, settings, "-", { id: "log-out", label: "Log out" }]);
  });

  it("toasts failures and timeouts, not a cancel", () => {
    expect(signInFailure({ ok: false, error: "cancelled", state })).toBeNull();
    expect(signInFailure({ ok: false, error: "timeout", state })).toMatch(/timed out/);
    expect(signInFailure({ ok: false, error: "failed", state })).toMatch(/Couldn’t log in/);
    expect(signInFailure({ ok: true, state })).toBeNull();
  });
});
