import { describe, expect, it } from "vitest";
import { accountMenu, signInFailure } from "../account";

const state = { server: "https://s", signingIn: false, user: null };

describe("account menu", () => {
  it("offers Log in when signed out, Cancel while the browser is open, and the email over Log out when signed in", () => {
    expect(accountMenu(null)).toEqual([]);
    expect(accountMenu(state)).toEqual([{ id: "log-in", label: "Log in with Google…" }]);
    expect(accountMenu({ ...state, signingIn: true }).map((e) => (typeof e === "object" && "label" in e ? e.label : e))).toEqual(["Waiting for the browser…", "Cancel"]);
    expect(accountMenu({ ...state, user: { id: "u", email: "me@x.co", name: "Me", picture: null } })).toEqual([{ header: "me@x.co" }, { id: "log-out", label: "Log out" }]);
  });

  it("toasts failures and timeouts, not a cancel", () => {
    expect(signInFailure({ ok: false, error: "cancelled", state })).toBeNull();
    expect(signInFailure({ ok: false, error: "timeout", state })).toMatch(/timed out/);
    expect(signInFailure({ ok: false, error: "failed", state })).toMatch(/Couldn’t log in/);
    expect(signInFailure({ ok: true, state })).toBeNull();
  });
});
