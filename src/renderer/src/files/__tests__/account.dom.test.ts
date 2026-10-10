// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountState, SignInResult } from "@shared/account";
import type { ToastOptions } from "@/ds/components/Toast";
import { $, $$, mount, type Mounted } from "@/ds/__tests__/dom";
import { FileBrowser } from "../FileBrowser";
import type { FilesBackend } from "../storeAccess";
import { MemoryWorkspace } from "./memoryWorkspace";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
  delete (window as unknown as { designer?: unknown }).designer;
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 40)));
const accountButton = () => $("nav button[aria-haspopup='menu']") as HTMLButtonElement | null;
const menuLabels = () => $$("#ds-overlays [role='menuitem'], #ds-overlays [role='presentation']").map((el) => el.textContent?.trim()).filter(Boolean);
const menuItem = (label: string) => $$("#ds-overlays [role='menuitem']").find((el) => el.textContent?.includes(label))!;
const press = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

/** Main's account as the preload exposes it, with a sign-in the test answers. */
function fakeAccount(signInAnswer: (s: AccountState) => SignInResult) {
  let state: AccountState = { server: "https://s", user: null, signingIn: false };
  const listeners = new Set<(s: AccountState) => void>();
  const set = (s: AccountState) => {
    state = s;
    for (const l of listeners) l(s);
  };
  const calls: string[] = [];
  const account = {
    get: async () => state,
    signIn: async () => {
      calls.push("signIn");
      const r = signInAnswer(state);
      set(r.state);
      return r;
    },
    cancelSignIn: async () => (calls.push("cancel"), state),
    signOut: async () => {
      calls.push("signOut");
      set({ ...state, user: null });
      return state;
    },
    onChanged: (cb: (s: AccountState) => void) => (listeners.add(cb), () => listeners.delete(cb)),
  };
  (window as unknown as { designer: unknown }).designer = { account };
  return { calls, set };
}

async function setup() {
  const ws = new MemoryWorkspace({ teamName: "Burak's team" });
  const toasts: ToastOptions[] = [];
  const backend: FilesBackend = { workspace: ws, source: "memory", thumbnailUrl: () => null, importFigBytes: (f, folderId) => ws.importFig(f.name, folderId) };
  m = mount(FileBrowser, { backend, initialLocation: { kind: "drafts" }, toast: (t) => toasts.push(t) });
  await settle();
  return { toasts };
}

const me = { id: "u1", email: "burak@example.com", name: "Burak Koç", picture: null };

describe("Home's account", () => {
  it("in a plain browser, offers the page's own Log in with Google (no desktop preload)", async () => {
    await setup();
    expect(accountButton()).not.toBeNull();
    press(accountButton()!);
    expect(menuLabels()).toEqual(["Log in with Google…"]);
  });

  it("logs in from the account menu and shows the account, then logs out", async () => {
    const fake = fakeAccount((s) => ({ ok: true, state: { ...s, user: me } }));
    await setup();
    expect(accountButton()!.textContent).toContain("Burak");
    press(accountButton()!);
    expect(menuLabels()).toEqual(["Log in with Google…"]);
    press(menuItem("Log in with Google…"));
    await settle();
    expect(fake.calls).toEqual(["signIn"]);
    expect(accountButton()!.textContent).toContain("Burak Koç");
    press(accountButton()!);
    expect(menuLabels()).toContain("burak@example.com");
    press(menuItem("Log out"));
    await settle();
    expect(fake.calls).toEqual(["signIn", "signOut"]);
    expect(accountButton()!.textContent).not.toContain("Koç");
  });

  it("offers Cancel while the browser is open, and toasts a failed log in", async () => {
    const fake = fakeAccount((s) => ({ ok: false, error: "failed", state: s }));
    const { toasts } = await setup();
    act(() => fake.set({ server: "https://s", user: null, signingIn: true }));
    press(accountButton()!);
    press(menuItem("Cancel"));
    await settle();
    expect(fake.calls).toEqual(["cancel"]);
    act(() => fake.set({ server: "https://s", user: null, signingIn: false }));
    press(accountButton()!);
    press(menuItem("Log in with Google…"));
    await settle();
    expect(toasts).toEqual([{ kind: "error", message: "Couldn’t log in. Try again." }]);
  });
});
