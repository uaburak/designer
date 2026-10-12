// @vitest-environment happy-dom
/** Settings › Operator (docs/multiplayer.md §17): only for operators; the sign-up mode, the allowlist, suspend, quota */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountState } from "@shared/account";
import { QUOTA_LIMITS, type OperatorAccount, type OperatorSettings } from "@shared/quota";
import { $, $$, mount, type Mounted } from "@/ds/__tests__/dom";
import { closeSettings, openSettings } from "../bridge";
import { SettingsHost } from "../SettingsModal";

let m: Mounted | null = null;
afterEach(() => {
  act(() => closeSettings());
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
  delete (window as unknown as { designer?: unknown }).designer;
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));
const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

const user = { id: "u1", email: "design.burakkoc@gmail.com", name: "Burak", picture: null };
const alice: OperatorAccount = { id: "u2", email: "alice@x.co", name: "Alice", createdAt: 0, lastSeenAt: 0, suspendedAt: null, suspendedReason: null, operator: false, sharedFiles: 3, storageBytes: 5 * 1024 * 1024, previews: 1, orgsCreated: 0, overrides: {} };

function fakeDesigner(operator: boolean) {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let settings: OperatorSettings = { signupMode: "open", allowlist: [], defaults: { ...QUOTA_LIMITS }, serverStorageBytes: 0, accounts: 2 };
  let account = alice;
  const state: AccountState = { server: "https://s", user, signingIn: false };
  (window as unknown as { designer: unknown }).designer = {
    account: {
      get: async () => state,
      signIn: async () => ({ ok: true, state }),
      cancelSignIn: async () => state,
      signOut: async () => state,
      onChanged: () => () => {},
      request: async (r: { method: string; path: string; body?: unknown }) => {
        requests.push(r);
        if (r.path === "/me/usage") return { status: 200, body: { usage: {}, limits: {}, operator } };
        if (r.path === "/operator/settings" && r.method === "GET") return { status: 200, body: settings };
        if (r.path === "/operator/settings" && r.method === "PATCH") {
          const b = r.body as { signupMode?: OperatorSettings["signupMode"]; allow?: string };
          settings = { ...settings, ...(b.signupMode ? { signupMode: b.signupMode } : {}), allowlist: b.allow ? [...settings.allowlist, b.allow] : settings.allowlist };
          return { status: 200, body: settings };
        }
        if (r.path.startsWith("/operator/accounts?")) return { status: 200, body: { accounts: [account], cursor: null } };
        if (r.path === `/operator/accounts/${alice.id}/suspend`) return { status: 200, body: { account: (account = { ...account, suspendedAt: 1, suspendedReason: (r.body as { reason?: string }).reason ?? null }) } };
        if (r.path === `/operator/accounts/${alice.id}/unsuspend`) return { status: 200, body: { account: (account = { ...account, suspendedAt: null, suspendedReason: null }) } };
        return { status: 404, body: { error: "not found" } };
      },
    },
  };
  return { requests };
}

async function open(operator: boolean, tab?: Parameters<typeof openSettings>[0]) {
  const fake = fakeDesigner(operator);
  m = mount(SettingsHost, {});
  act(() => openSettings(tab));
  await settle();
  await settle();
  return fake;
}

describe("Settings › Operator", () => {
  it("isn't there for anyone but the server's operators", async () => {
    await open(false);
    expect($$("[role='tab']").map((t) => t.textContent)).not.toContain("Operator");
  });

  it("shows sign-up and the accounts to an operator; suspends and unsuspends", async () => {
    const fake = await open(true, "operator");
    expect($$("[role='tab']").map((t) => t.textContent)).toContain("Operator");
    expect($("[data-settings-operator]")).not.toBeNull();
    expect($("[data-operator-signup-mode]")?.textContent).toContain("Open to everyone");
    const row = $(`[data-operator-account='${alice.id}']`)!;
    expect(row.textContent).toContain("Alice · alice@x.co");
    expect(row.textContent).toContain("3 files · 5 MB · 1 previews");
    await click(row.querySelector("[data-operator-suspend]")!);
    await click($("[data-operator-suspend-confirm]")!);
    await settle();
    expect(fake.requests).toContainEqual({ method: "POST", path: `/operator/accounts/${alice.id}/suspend`, body: { reason: undefined } });
    expect($(`[data-operator-account='${alice.id}']`)?.hasAttribute("data-suspended")).toBe(true);
    await click($("[data-operator-unsuspend]")!);
    await settle();
    expect($(`[data-operator-account='${alice.id}']`)?.hasAttribute("data-suspended")).toBe(false);
  });
});
