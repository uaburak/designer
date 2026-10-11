// @vitest-environment happy-dom
/**
 * The idle prompt (docs/desktop.md §18.2) on a fake preload account: a `warning` opens it with the countdown, Stay
 * logged in / Log out call the account, `cleared` closes it, `logged-out` toasts once.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { IdleNotice } from "@shared/ipc";
import type { ToastOptions } from "@/ds/components/Toast";
import { $$, mount, type Mounted } from "@/ds/__tests__/dom";
import { IDLE_LOGGED_OUT_TEXT, IdleWarning } from "../IdleWarning";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
  delete (window as unknown as { designer?: unknown }).designer;
});

function fakeAccount() {
  const listeners = new Set<(n: IdleNotice) => void>();
  const calls: string[] = [];
  const state = { server: "https://s", user: null, signingIn: false };
  (window as unknown as { designer: unknown }).designer = {
    account: {
      get: async () => state,
      signIn: async () => ({ ok: false, error: "cancelled", state }),
      cancelSignIn: async () => state,
      signOut: async () => (calls.push("signOut"), state),
      onChanged: () => () => {},
      staySignedIn: async () => (calls.push("stay"), state),
      onIdle: (cb: (n: IdleNotice) => void) => (listeners.add(cb), () => listeners.delete(cb)),
    },
  };
  return { calls, say: (n: IdleNotice) => act(() => listeners.forEach((l) => l(n))) };
}

const dialog = () => document.querySelector("[role='dialog']");
const button = (label: string) => $$("[role='dialog'] button").find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));

describe("IdleWarning", () => {
  it("counts down to the logout; Stay logged in posts the activity and closes it", () => {
    const fake = fakeAccount();
    const toasts: ToastOptions[] = [];
    m = mount(IdleWarning, { toast: (t: ToastOptions) => toasts.push(t) });
    expect(dialog()).toBeNull();
    fake.say({ state: "warning", logoutAt: Date.now() + 42_000 });
    expect(dialog()?.textContent).toContain("Are you still there?");
    expect(dialog()?.textContent).toContain("For your security, you’ll be logged out in 42 seconds because you’ve been inactive.");
    click(button("Stay logged in"));
    expect(fake.calls).toEqual(["stay"]);
    expect(dialog()).toBeNull();
    // Input elsewhere (main clears it in every view)
    fake.say({ state: "warning", logoutAt: Date.now() + 1000 });
    expect(dialog()?.textContent).toContain("in 1 second because");
    fake.say({ state: "cleared" });
    expect(dialog()).toBeNull();
    expect(toasts).toEqual([]);
  });

  it("Log out signs out; the logout itself is said once", () => {
    const fake = fakeAccount();
    const toasts: ToastOptions[] = [];
    m = mount(IdleWarning, { toast: (t: ToastOptions) => toasts.push(t) });
    fake.say({ state: "warning", logoutAt: Date.now() + 30_000 });
    click(button("Log out"));
    expect(fake.calls).toEqual(["signOut"]);
    expect(dialog()).toBeNull();
    fake.say({ state: "logged-out" });
    fake.say({ state: "logged-out" });
    expect(toasts).toEqual([{ message: IDLE_LOGGED_OUT_TEXT }]);
  });
});
