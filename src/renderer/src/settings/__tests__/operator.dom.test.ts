// @vitest-environment happy-dom
/** Settings › Operator (docs/multiplayer.md §17): only for operators; the sign-up mode, the allowlist, suspend, quota */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountState } from "@shared/account";
import { QUOTA_LIMITS, type OperatorAccount, type OperatorSettings } from "@shared/quota";
import { SPEND_INCLUDED, SPEND_METRICS, SPEND_METRIC_LABEL, type SpendGuardStatus } from "@shared/spendGuard";
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

const guardStatus = (known: boolean): SpendGuardStatus => ({
  mode: "auto",
  warnPercent: 80,
  guardPercent: 95,
  active: false,
  reason: null,
  configured: known,
  month: "2026-10",
  checkedAt: known ? Date.UTC(2026, 9, 12, 12) : null,
  error: known ? null : "CF_API_TOKEN or CF_ACCOUNT_ID isn't set",
  serverStorageBytes: 900 * 1024 * 1024,
  serverStorageCustom: false,
  usage: SPEND_METRICS.map((m) => ({ metric: m, label: SPEND_METRIC_LABEL[m], used: known ? SPEND_INCLUDED[m] * (m === "workers_requests" ? 0.85 : 0.1) : null, included: SPEND_INCLUDED[m], percent: known ? (m === "workers_requests" ? 85 : 10) : null })),
});

function fakeDesigner(operator: boolean, known = true) {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let guard = guardStatus(known);
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
        if (r.path === "/operator/spend-guard" && r.method === "GET") return { status: 200, body: guard };
        if (r.path === "/operator/spend-guard" && r.method === "PATCH") return { status: 200, body: (guard = { ...guard, ...(r.body as Partial<SpendGuardStatus>), active: (r.body as { mode?: string }).mode === "operator_only", reason: (r.body as { mode?: string }).mode === "operator_only" ? "forced" : null }) };
        if (r.path.startsWith("/operator/accounts?")) return { status: 200, body: { accounts: [account], cursor: null } };
        if (r.path === `/operator/accounts/${alice.id}/suspend`) return { status: 200, body: { account: (account = { ...account, suspendedAt: 1, suspendedReason: (r.body as { reason?: string }).reason ?? null }) } };
        if (r.path === `/operator/accounts/${alice.id}/unsuspend`) return { status: 200, body: { account: (account = { ...account, suspendedAt: null, suspendedReason: null }) } };
        return { status: 404, body: { error: "not found" } };
      },
    },
  };
  return { requests };
}

async function open(operator: boolean, tab?: Parameters<typeof openSettings>[0], known = true) {
  const fake = fakeDesigner(operator, known);
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
    expect(row.textContent).toContain("3 files · 5 MB · 1 preview ·");
    await click(row.querySelector("[data-operator-suspend]")!);
    await click($("[data-operator-suspend-confirm]")!);
    await settle();
    expect(fake.requests).toContainEqual({ method: "POST", path: `/operator/accounts/${alice.id}/suspend`, body: { reason: undefined } });
    expect($(`[data-operator-account='${alice.id}']`)?.hasAttribute("data-suspended")).toBe(true);
    await click($("[data-operator-unsuspend]")!);
    await settle();
    expect($(`[data-operator-account='${alice.id}']`)?.hasAttribute("data-suspended")).toBe(false);
  });

  it("has no Community tab, and its text fields are real text inputs that take typing", async () => {
    await open(true, "operator");
    expect($$("[role='tab']").map((t) => t.textContent)).toEqual(["Account", "Notifications", "Security", "AI", "Agents", "Operator"]);
    const email = $("[data-operator-allow-email] input") as HTMLInputElement;
    const search = $("[data-operator-search] input") as HTMLInputElement;
    expect(email.type).toBe("text");
    expect(email.placeholder).toBe("Email");
    expect(search.type).toBe("text");
    expect(search.placeholder).toBe("Search accounts");
    // the field fills the row beside its button
    expect($("[data-operator-allow-email]")!.className).toMatch(/fill/);
    expect($("[data-operator-search]")!.className).toMatch(/fill/);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(email, "bob@x.co");
      email.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(email.value).toBe("bob@x.co");
  });

  it("shows the spend guard: the month's usage, the mode, the thresholds", async () => {
    const fake = await open(true, "operator");
    const table = $("[data-operator-usage]")!;
    expect(table.textContent).toContain("Workers requests");
    expect(table.querySelector("[data-metric='workers_requests']")?.getAttribute("data-level")).toBe("warn");
    expect(table.querySelector("[data-metric='workers_requests']")?.textContent).toContain("8.5M");
    expect($("[data-operator-guard-checked]")?.textContent).toContain("Last checked");
    expect($("[data-operator-guard-state]")?.getAttribute("data-operator-guard-state")).toBe("normal");
    await click($("[data-operator-guard-save]")!);
    await settle();
    expect(fake.requests).toContainEqual({ method: "PATCH", path: "/operator/spend-guard", body: { warnPercent: 80, guardPercent: 95 } });
  });

  it("says usage unknown without the API token", async () => {
    await open(true, "operator", false);
    expect($("[data-operator-usage]")).toBeNull();
    expect($("[data-operator-usage-unknown]")?.textContent).toContain("Usage unknown: CF_API_TOKEN");
  });
});
