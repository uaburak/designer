// @vitest-environment happy-dom
/**
 * Home's Governance+ gates (docs/governance.md §2.5, §2.6, §2.13, §5 "Clients") on the MemoryStore and the org
 * server's contract fake, with the org list's entry carrying the gate (as `GET /orgs` does): an internal policy
 * (Agree acknowledges it and the org's content loads; Cancel goes back to the local Drafts), 2FA for guests (Set up
 * opens Settings › Security), the IP allowlist, a refused read's gate, the account-wide network restriction (the whole
 * window, Log out) and a guest's access ending soon.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountState } from "@shared/account";
import type { OrgGate } from "@shared/org/governance";
import type { OrgSummary } from "@shared/org/types";
import type { OrgEvent } from "@shared/org/repositories";
import { StoreError } from "@shared/store/protocol";
import { $, $$, mount, type Mounted } from "@/ds/__tests__/dom";
import { MemoryStore } from "@/store/memory/memoryStore";
import { FakeOrgServer } from "../../../../store/org/fake/server";
import { closeSettings, useSettingsState } from "../../settings/bridge";
import { FileBrowser } from "../FileBrowser";
import { effectiveGate, gateOfError, isNetworkRestricted } from "../governance";
import { localSnapshot, type FilesBackend } from "../storeAccess";
import { guestDaysLeft } from "../../account/Gates";

const SERVER = "https://org.test";

class NoSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {}
}

let m: Mounted | null = null;
const stores: MemoryStore[] = [];
afterEach(() => {
  m?.unmount();
  m = null;
  act(() => closeSettings());
  document.body.innerHTML = "";
  delete (window as unknown as { designer?: unknown }).designer;
  for (const s of stores.splice(0)) {
    s.org.close();
    s.multiplayer.close();
  }
  vi.unstubAllGlobals();
});

const settle = (ms = 60) => act(async () => new Promise((r) => setTimeout(r, ms)));
const settleLong = async () => {
  for (let i = 0; i < 6; i++) await settle();
};
const press = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
const buttonNamed = (label: string) => $$("button").find((el) => el.textContent?.trim() === label);

/** What the list says about the org, and what the page's reads answer, changed by the test */
interface Knobs {
  gate?: OrgGate;
  guestExpiresAt?: number;
  refuse?: unknown;
  listRefuse?: unknown;
  /** An org whose Drafts never answer (a slow read) */
  hang?: string;
  /** The org is gone from the person's list (removed, left, an expired guest) */
  gone?: boolean;
}

async function setup(knobs: Knobs) {
  vi.stubGlobal("WebSocket", NoSocket);
  const srv = new FakeOrgServer();
  vi.stubGlobal("fetch", srv.fetch);
  const alice = await srv.addUser("alice@example.com", "Alice");
  const store = await MemoryStore.open({ teamName: "Burak's team" });
  stores.push(store);
  await store.multiplayer.setSession({ server: SERVER, token: alice.token });
  const api = store.api();
  const org = await api.orgs.create({ name: "Acme" });
  await api.workspace.setBrowsePrefs({ space: `org:${org.id}` });
  const signedOut: number[] = [];
  const state: AccountState = { server: SERVER, user: { ...alice.user, picture: null }, signingIn: false };
  (window as unknown as { designer: unknown }).designer = { account: { get: async () => state, signIn: async () => ({ ok: true, state }), cancelSignIn: async () => state, signOut: async () => (signedOut.push(1), state), onChanged: () => () => {} } };
  const acknowledged: string[] = [];
  const reads: string[] = [];
  const watchers: ((e: OrgEvent) => void)[] = [];
  const orgs = {
    ...api.orgs,
    watch: (l: (e: OrgEvent) => void) => {
      watchers.push(l);
      const off = api.orgs.watch(l);
      return () => {
        watchers.splice(watchers.indexOf(l), 1);
        off();
      };
    },
    list: async (): Promise<OrgSummary[]> => {
      if (knobs.listRefuse) throw knobs.listRefuse;
      return (await api.orgs.list()).filter((o) => !(knobs.gone && o.id === org.id)).map((o) => (o.id === org.id ? { ...o, gate: knobs.gate, guestExpiresAt: knobs.guestExpiresAt } : o));
    },
    drafts: async (id: string) => {
      reads.push("drafts");
      if (id === knobs.hang) return new Promise<never>(() => {});
      if (knobs.refuse) throw knobs.refuse;
      return api.orgs.drafts(id);
    },
  };
  const backend: FilesBackend = {
    workspace: api.workspace,
    source: "memory",
    thumbnailUrl: () => null,
    org: {
      orgs,
      teams: api.teams,
      projects: api.projects,
      admin: api.admin,
      openShared: (k) => api.multiplayer.openShared(k),
      snapshotOf: (k) => localSnapshot(api.files, k),
      governance: {
        ...api.governance,
        acknowledgePolicy: async (_org, id) => {
          acknowledged.push(id);
          if (knobs.gate?.kind === "policy") knobs.gate = effectiveGate(knobs.gate, new Set([id])) ?? undefined;
        },
      },
    },
  };
  m = mount(FileBrowser, { backend, initialLocation: { kind: "org-drafts" }, toast: () => {} });
  await settleLong();
  const emit = (e: OrgEvent) => act(() => watchers.forEach((l) => l(e)));
  return { api, org, acknowledged, reads, signedOut, knobs, emit };
}

const policy = (id: string, title: string) => ({ id, title, text: `${title} text` });

describe("Home's Governance+ gates", () => {
  it("an internal policy: no content behind it; Agree acknowledges each, then the org's Drafts load", async () => {
    const ctx = await setup({ gate: { kind: "policy", policies: [policy("p1", "Code of conduct"), policy("p2", "NDA")] } });
    expect(ctx.reads).toEqual([]); // a gated org loads no page
    expect($('[role="dialog"]')?.textContent).toContain("Code of conduct");
    expect($("[data-policy='p1']")?.textContent).toBe("Code of conduct text");
    await press($("[data-policy-agree]")!);
    await settle();
    expect($('[role="dialog"]')?.textContent).toContain("NDA");
    await press($("[data-policy-agree]")!);
    await settleLong();
    expect(ctx.acknowledged).toEqual(["p1", "p2"]);
    expect($('[role="dialog"]')).toBeNull();
    expect(ctx.reads).toContain("drafts");
  });

  it("Cancel goes back to the local Drafts", async () => {
    const ctx = await setup({ gate: { kind: "policy", policies: [policy("p1", "Code of conduct")] } });
    await press($("[data-policy-cancel]")!);
    await settleLong();
    expect($('[role="dialog"]')).toBeNull();
    expect((await ctx.api.workspace.getPrefs()).browse.space).toBe("local");
    expect(ctx.acknowledged).toEqual([]);
  });

  it("2FA for guests: the content is replaced, Set up opens Settings › Security", async () => {
    let settings: { open: boolean; tab: string } = { open: false, tab: "" };
    function Probe() {
      settings = useSettingsState();
      return null;
    }
    const ctx = await setup({ gate: { kind: "two_factor" } });
    const probe = mount(Probe, {});
    expect(ctx.reads).toEqual([]);
    const gate = $("[data-gate='two_factor']")!;
    expect(gate.textContent).toContain("Acme requires two-factor authentication for guests.");
    await press(buttonNamed("Set up two-factor authentication")!);
    expect(settings).toEqual({ open: true, tab: "security" });
    probe.unmount();
  });

  it("the IP allowlist, from the list or from a refused read", async () => {
    await setup({ gate: { kind: "ip", ip: "203.0.113.9" } });
    expect($("[data-gate='ip']")?.textContent).toContain("Acme only allows access from approved networks.");
    expect($("[data-gate='ip']")?.textContent).toContain("203.0.113.9");
    m?.unmount();
    m = null;
    const refused = new StoreError("forbidden", "ip_not_allowed", { error: "ip_not_allowed", code: "ip_not_allowed", gate: { kind: "ip", ip: "198.51.100.1" } });
    const ctx = await setup({ refuse: refused });
    expect(ctx.reads).toContain("drafts");
    expect($("[data-gate='ip']")?.textContent).toContain("198.51.100.1");
  });

  it("the network restriction covers the window; Log out signs out", async () => {
    const ctx = await setup({ listRefuse: new StoreError("forbidden", "network_restricted", { code: "network_restricted" }) });
    const w = $("[data-gate='network']")!;
    expect(w.getAttribute("role")).toBe("alertdialog");
    expect(w.textContent).toContain("This network only allows work accounts.");
    await press($("[data-network-log-out]")!);
    await settle();
    expect(ctx.signedOut).toEqual([1]);
    expect($("[data-gate='network']")).toBeNull();
  });

  it("a guest's access ending within 14 days shows a banner", async () => {
    await setup({ guestExpiresAt: Date.now() + 3 * 86_400_000 - 1000 });
    expect($("[data-guest-expiry]")?.textContent).toBe("Your guest access to Acme ends in 3 days.");
  });

  it("the shown org gone from the list (a guest removed): back to the person's own space", async () => {
    const ctx = await setup({});
    expect((await ctx.api.workspace.getPrefs()).browse.space).toBe(`org:${ctx.org.id}`);
    ctx.knobs.gone = true;
    ctx.emit({ type: "orgs.changed" });
    await settleLong();
    expect((await ctx.api.workspace.getPrefs()).browse.space).toBe("local");
    expect(document.body.textContent).not.toContain("Enterprise");
  });

  it("the pure parts", () => {
    const now = 1_000_000_000;
    expect(guestDaysLeft(null, now)).toBeNull();
    expect(guestDaysLeft(now + 15 * 86_400_000, now)).toBeNull();
    expect(guestDaysLeft(now + 60_000, now)).toBe(1);
    expect(guestDaysLeft(now - 1, now)).toBeNull();
    expect(gateOfError(new StoreError("forbidden", "x", { code: "two_factor_required" }))).toEqual({ kind: "two_factor" });
    expect(gateOfError(new StoreError("forbidden", "x", { code: "seat_required" }))).toBeNull();
    expect(gateOfError(new Error("x"))).toBeNull();
    expect(isNetworkRestricted(new StoreError("forbidden", "x", { code: "network_restricted" }))).toBe(true);
    expect(effectiveGate({ kind: "policy", policies: [policy("a", "A")] }, new Set(["a"]))).toBeNull();
  });

  it("the store's access.blocked events: an org's gate, the network restriction; cleared when the orgs are read again", async () => {
    const ctx = await setup({});
    expect($("[data-gate]")).toBeNull();
    ctx.emit({ type: "access.blocked", orgId: ctx.org.id, code: "ip_not_allowed", gate: { kind: "ip", ip: "192.0.2.7" } });
    await settle();
    expect($("[data-gate='ip']")?.textContent).toContain("192.0.2.7");
    ctx.emit({ type: "orgs.changed" });
    await settleLong();
    expect($("[data-gate='ip']")).toBeNull();
    ctx.emit({ type: "access.blocked", orgId: ctx.org.id, code: "policy_acknowledgement_required", gate: { kind: "policy", policies: [policy("p9", "Data handling")] } });
    await settle();
    expect($('[role="dialog"]')?.textContent).toContain("Data handling");
    await press($("[data-policy-agree]")!);
    await settleLong();
    expect(ctx.acknowledged).toEqual(["p9"]);
    expect($('[role="dialog"]')).toBeNull();
    ctx.emit({ type: "access.blocked", orgId: null, code: "network_restricted" });
    await settle();
    expect($("[data-gate='network']")).toBeTruthy();
  });

  it("another org shows no gate the last org's refused read carried", async () => {
    const refused = new StoreError("forbidden", "ip_not_allowed", { error: "ip_not_allowed", code: "ip_not_allowed", gate: { kind: "ip", ip: "198.51.100.1" } });
    const ctx = await setup({ refuse: refused });
    expect($("[data-gate='ip']")).toBeTruthy();
    const other = await act(async () => ctx.api.orgs.create({ name: "Globex" }));
    await settleLong();
    expect($("[data-gate='ip']")).toBeTruthy();
    ctx.knobs.hang = other.id; // its page is still loading
    await act(async () => {
      await ctx.api.workspace.setBrowsePrefs({ space: `org:${other.id}` });
    });
    await settleLong();
    expect(ctx.reads.length).toBeGreaterThan(1);
    expect($("[data-gate='ip']")).toBeNull();
  });
});
