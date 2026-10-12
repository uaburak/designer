// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountState, AccountUser, SignInResult } from "@shared/account";
import type { ToastOptions } from "@/ds/components/Toast";
import { $, $$, key, mount, type Mounted } from "@/ds/__tests__/dom";
import { FileBrowser } from "../FileBrowser";
import { useSettingsState } from "../../settings/bridge";
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
const menu = () => $("#ds-overlays [role='menu']") as HTMLElement;
/** The open menu's rows, the header as its name (top level only: a submenu is its own panel) */
const menuLabels = () =>
  $$("#ds-overlays [role='menu']:first-of-type > [role^='menuitem']").map((el) => (el.hasAttribute("data-profile") ? el.querySelector("span:nth-of-type(2)")?.textContent : el.querySelector("span[class*='label']")?.textContent ?? el.textContent)?.trim());
const menuItem = (label: string) => $$("#ds-overlays [role^='menuitem']").find((el) => el.textContent?.includes(label))!;
const press = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

/** Main's account as the preload exposes it, with a sign-in the test answers. */
function fakeAccount(signInAnswer: (s: AccountState) => SignInResult, initial?: Partial<AccountState>) {
  let state: AccountState = { server: "https://s", user: null, signingIn: false, ...initial };
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
      const rest = (state.accounts ?? []).filter((a) => a.id !== state.user?.id);
      set({ ...state, user: rest[0] ?? null, accounts: rest });
      return state;
    },
    switchTo: async (id: string) => {
      calls.push(`switch ${id}`);
      set({ ...state, user: state.accounts?.find((a) => a.id === id) ?? state.user });
      return state;
    },
    signOutAll: async () => {
      calls.push("signOutAll");
      set({ ...state, user: null, accounts: [] });
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

const me: AccountUser = { id: "u1", email: "burak@example.com", name: "Burak Koç", picture: null };
const work: AccountUser = { id: "u2", email: "burak@work.example", name: "Burak (work)", picture: null };

describe("Home's account", () => {
  it("in a plain browser, offers the page's own Log in with Google (no desktop preload)", async () => {
    await setup();
    expect(accountButton()).not.toBeNull();
    press(accountButton()!);
    expect(menuLabels()).toEqual(["Log in with Google…", "Change theme", "Settings"]);
  });

  it("is Figma's account menu: the header (photo, the name as a link, the email), Change theme ›, Settings, Add account, Log out", async () => {
    fakeAccount((s) => ({ ok: true, state: s }), { user: me, accounts: [me] });
    await setup();
    press(accountButton()!);
    expect(menuLabels()).toEqual(["Burak Koç", "Change theme", "Settings", "Add account", "Log out"]);
    expect(menu().textContent).not.toContain("Community");
    // Its own look (300 wide, 32 rows: Files.module.css .accountMenu)
    expect(menu().className).toMatch(/accountMenu/);
    const header = $("#ds-overlays [data-profile]")!;
    expect(header.getAttribute("role")).toBe("menuitem");
    expect(header.querySelector("[data-ds='Avatar']")).not.toBeNull();
    expect(header.textContent).toContain("burak@example.com");
    // Groups as Figma's: the header | Change theme, Settings | Add account, Log out
    expect($$("#ds-overlays [role='menu'] > [role='separator']").length).toBe(2);
    // Add account and Log out carry their glyphs
    expect(menuItem("Add account").querySelector("svg")).not.toBeNull();
    expect(menuItem("Log out").querySelector("svg")).not.toBeNull();
    expect(menuItem("Change theme").querySelector("svg")).not.toBeNull();
    expect(menuItem("Settings").querySelector("svg")).not.toBeNull();
    // Change theme opens Figma's theme choices, the current one checked
    press(menuItem("Change theme"));
    const sub = $$("#ds-overlays [role='menu']")[1];
    expect($$("[role='menuitemcheckbox']", sub).map((el) => [el.textContent?.trim(), el.getAttribute("aria-checked")])).toEqual([
      ["Light", "false"],
      ["Dark", "false"],
      ["Use system setting", "true"],
    ]);
  });

  it("keeps the Menu's keys: ↓ reaches the header first, Enter on it opens Settings › Account", async () => {
    fakeAccount((s) => ({ ok: true, state: s }), { user: me, accounts: [me] });
    await setup();
    let settings: { open: boolean; tab: string } | null = null;
    const Probe = () => ((settings = useSettingsState()), null);
    const probe = mount(Probe, {});
    press(accountButton()!);
    key(menu(), "ArrowDown");
    expect($("#ds-overlays [data-profile]")!.hasAttribute("data-highlighted")).toBe(true);
    key(menu(), "ArrowDown");
    expect(menuItem("Change theme").hasAttribute("data-highlighted")).toBe(true);
    key(menu(), "ArrowUp");
    key(menu(), "Enter");
    expect(settings).toEqual({ open: true, tab: "account" });
    probe.unmount();
  });

  it("logs in from the account menu and shows the account, then logs out", async () => {
    const fake = fakeAccount((s) => ({ ok: true, state: { ...s, user: me, accounts: [me] } }));
    await setup();
    expect(accountButton()!.textContent).toContain("Burak");
    press(accountButton()!);
    press(menuItem("Log in with Google…"));
    await settle();
    expect(fake.calls).toEqual(["signIn"]);
    expect(accountButton()!.textContent).toContain("Burak Koç");
    press(accountButton()!);
    expect(menu().textContent).toContain("burak@example.com");
    press(menuItem("Log out"));
    await settle();
    expect(fake.calls).toEqual(["signIn", "signOut"]);
    expect(accountButton()!.textContent).not.toContain("Koç");
  });

  it("Add account signs in another account; with two, the menu lists both (the current one checked), switches, and logs out of all", async () => {
    const fake = fakeAccount((s) => ({ ok: true, state: { ...s, user: work, accounts: [me, work] } }), { user: me, accounts: [me] });
    await setup();
    press(accountButton()!);
    press(menuItem("Add account"));
    await settle();
    expect(fake.calls).toEqual(["signIn"]);
    expect(accountButton()!.textContent).toContain("Burak (work)");
    press(accountButton()!);
    expect(menuLabels()).toEqual(["Burak (work)", "Change theme", "Settings", "Burak Koç", "Burak (work)", "Add account", "Log out", "Log out of all accounts"]);
    const rows = $$("#ds-overlays [role='menuitemcheckbox']");
    expect(rows.map((el) => [el.querySelector("span[class*='label']")?.textContent, el.getAttribute("aria-checked")])).toEqual([
      ["Burak Koç", "false"],
      ["Burak (work)", "true"],
    ]);
    expect(rows[0].textContent).toContain("burak@example.com");
    // One text edge for every row: no check column (the current account's check is at its end), each row's glyph cell first
    const items = $$("#ds-overlays [role='menu']:first-of-type > [role^='menuitem']:not([data-profile])");
    expect(items.every((el) => /icon/.test((el.firstElementChild as HTMLElement).className))).toBe(true);
    expect(rows.map((el) => !!el.querySelector("[class*='checkEnd'] svg"))).toEqual([false, true]);
    press(rows[0]);
    await settle();
    expect(fake.calls).toEqual(["signIn", "switch u1"]);
    expect(accountButton()!.textContent).toContain("Burak Koç");
    press(accountButton()!);
    press(menuItem("Log out of all accounts"));
    await settle();
    expect(fake.calls).toEqual(["signIn", "switch u1", "signOutAll"]);
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
