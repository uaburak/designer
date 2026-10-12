// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountProfile, AccountState, SessionInfo } from "@shared/account";
import type { UploadedFont } from "@shared/ipc";
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
const button = (label: string) => $$("button").find((b) => b.textContent?.trim() === label)!;

const user = { id: "u1", email: "burak@x.co", name: "burak.koc", picture: null };
const session = (id: string, current: boolean, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, kind: "login", os: "macOS", browser: "Chrome", ip: "1.2.3.4", city: "Antalya", country: "Türkiye", createdAt: 0, lastSeenAt: 0, current, ...extra });

/** The preload's parts Settings uses: the account (with its server requests), uploaded fonts, agents' setup, contrast. */
function fakeDesigner() {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let profile: AccountProfile = { ...user, role: "Design", community: {}, prefs: {}, provider: "google" };
  let sessions = [session("s1", true, { kind: "app", browser: "Wecra Desktop" }), session("s2", false, { os: "iOS (iPhone)", browser: "Safari" })];
  let fonts: UploadedFont[] = [
    { id: "f1", family: "Matter", style: "Bold", weight: 700, italic: false, file: "Matter-1.otf" },
    { id: "f2", family: "Matter", style: "Bold Italic", weight: 700, italic: true, file: "Matter-2.otf" },
  ];
  const contrast: boolean[] = [];
  const state: AccountState = { server: "https://s", user, signingIn: false };
  const account = {
    get: async () => state,
    signIn: async () => ({ ok: true, state }),
    cancelSignIn: async () => state,
    signOut: async () => state,
    onChanged: () => () => {},
    request: async (r: { method: string; path: string; body?: unknown }) => {
      requests.push(r);
      if (r.path === "/me/profile" && r.method === "GET") return { status: 200, body: profile };
      if (r.path === "/me/profile" && r.method === "PATCH") return { status: 200, body: (profile = { ...profile, ...(r.body as object) }) };
      if (r.path === "/me/sessions") return { status: 200, body: { sessions } };
      if (r.path.startsWith("/me/sessions/") && r.method === "DELETE") {
        sessions = sessions.filter((s) => `/me/sessions/${s.id}` !== r.path);
        return { status: 200, body: { ok: true } };
      }
      if (r.path === "/me/tokens" && r.method === "POST") {
        const b = r.body as { description: string; scopes: string[] };
        return { status: 201, body: { token: "dsgn_x", info: { id: "t1", description: b.description, scopes: b.scopes, kind: "personal", orgId: null, createdAt: 0, expiresAt: null, lastUsedAt: null } } };
      }
      if (r.path === "/me/tokens") return { status: 200, body: { tokens: [] } };
      return { status: 404, body: { error: "not found" } };
    },
  };
  const agents = {
    providers: async () => [{ id: "claude-code", kind: "claude-code", label: "Claude Code", available: true, models: ["opus"], auth: { state: "connected" } }],
    settings: async () => ({ providerId: null, models: {}, custom: [] }),
    setSettings: async () => ({ providerId: null, models: {}, custom: [] }),
    mcp: async () => ({ running: true, url: "http://127.0.0.1:1/mcp", connections: [] }),
    onMcpState: () => () => {},
    clients: async () => [{ id: "cursor", label: "Cursor", installed: true, configPath: "~/.cursor/mcp.json", connected: true, connectedAt: Date.now() - 3 * 86_400_000 }],
    disconnect: async () => ({ ok: true, path: "" }),
  };
  (window as unknown as { designer: unknown }).designer = {
    account,
    agents,
    theme: { preference: "dark", resolved: "dark", contrast: false },
    setContrast: async (on: boolean) => (contrast.push(on), { preference: "dark", resolved: "dark", contrast: on }),
    fonts: {
      uploaded: async () => fonts,
      upload: async () => ({ cancelled: true }),
      removeUploaded: async (id: string) => (fonts = fonts.filter((f) => f.id !== id)),
      read: async () => new Uint8Array(),
    },
  };
  return { requests, contrast };
}

async function open(tab?: Parameters<typeof openSettings>[0]) {
  const fake = fakeDesigner();
  m = mount(SettingsHost, {});
  act(() => openSettings(tab));
  await settle();
  return fake;
}

describe("Settings", () => {
  it("has Figma's tabs and ours, AI and Agents after Security, and closes on Escape", async () => {
    await open();
    expect($$("[role='tab']").map((t) => t.textContent)).toEqual(["Account", "Notifications", "Security", "AI", "Agents"]);
    expect($("[role='tab'][aria-selected='true']")?.textContent).toBe("Account");
    await click($("[data-settings-tab='security']")!);
    expect($("[data-settings-panel]")?.getAttribute("data-settings-panel")).toBe("security");
    act(() => {
      $("[data-settings-modal]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect($("[data-settings-modal]")).toBeNull();
  });

  it("Account: the profile, Change name saved on the server, Enhance contrast, the uploaded fonts", async () => {
    const fake = await open();
    expect($("[data-settings-section='name'] p")?.textContent).toBe("burak.koc");
    expect($("[data-settings-section='role'] p")?.textContent).toBe("Design");
    await click(button("Change name"));
    const input = $("[role='dialog'][aria-labelledby] input") as HTMLInputElement;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Burak Koç");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click($("[data-save-name]")!);
    await settle();
    expect(fake.requests).toContainEqual({ method: "PATCH", path: "/me/profile", body: { name: "Burak Koç" } });
    expect($("[data-settings-section='name'] p")?.textContent).toBe("Burak Koç");
    await click($("[data-enhance-contrast]")!);
    await settle();
    expect(fake.contrast).toEqual([true]);
    expect(document.documentElement.getAttribute("data-contrast")).toBeNull(); // the root applies it (useThemeRoot), not the modal
    expect($$("[data-uploaded-font]").map((r) => r.textContent)).toEqual(["MatterBoldRag 123", "MatterBold ItalicRag 123"]);
    await click($$("[data-uploaded-font] button")[0]);
    await settle();
    expect($$("[data-uploaded-font]")).toHaveLength(1);
  });

  it("Security: sessions with Current and Sign out (that session ended), connected apps", async () => {
    const fake = await open("security");
    const rows = $$("[data-session]");
    expect(rows).toHaveLength(2);
    for (const t of ["Antalya, Türkiye", "App · 1.2.3.4", "Wecra Desktop", "Just now", "Current"]) expect(rows[0].textContent).toContain(t);
    for (const t of ["Login · 1.2.3.4", "iOS (iPhone)", "Safari", "Sign out"]) expect(rows[1].textContent).toContain(t);
    await click($("[data-sign-out-session]")!);
    await settle();
    expect(fake.requests).toContainEqual({ method: "DELETE", path: "/me/sessions/s2", body: undefined });
    expect($$("[data-session]")).toHaveLength(1);
    expect($("[data-connected-app='cursor']")?.textContent).toContain("Connected 3 days ago");
  });

  it("Security › Generate new token: round 5's scopes by group with Figma's descriptions, plan-only scopes hidden", async () => {
    const fake = await open("security");
    await click($("[data-new-token-link]")!);
    await settle();
    const dialog = $$("[role='dialog']").at(-1)!;
    const scopes = $$("input[type='checkbox']", dialog).map((i) => i.closest("label")?.textContent?.trim());
    for (const s of ["file_dev_resources:write", "file_variables:write", "file_code_connect:write", "webhooks:write", "org:activity_log_read", "folders:read"]) expect(scopes).toContain(s);
    // Read only with a plan access token (Admin › Settings › Plan access tokens)
    expect(scopes).not.toContain("org:ai_metering_usage_read");
    expect($$("h4", dialog).map((h) => h.textContent)).toEqual(["Users", "Files", "Comments", "Dev resources", "Variables", "Code Connect", "Libraries", "Folders", "Webhooks", "Organization"]);
    expect(dialog.textContent).toContain("Read the contents of files, such as nodes and the editor type.");
    expect(dialog.textContent).toContain("Read organization activity logs. Must be an organization admin.");
    act(() => {
      const input = $("input[aria-label='Token name']", dialog) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "CI");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click($$("label", dialog).find((l) => l.textContent?.trim() === "webhooks:read")!.querySelector("input")!);
    await click($("[data-generate-token]", dialog)!);
    await settle();
    expect(fake.requests).toContainEqual({ method: "POST", path: "/me/tokens", body: { description: "CI", expiresInDays: 30, scopes: ["file_content:read", "webhooks:read"] } });
  });

  it("Notifications › Dev Mode: Status changes / Nothing, under the desktop notifications", async () => {
    await open("notifications");
    await settle();
    const group = $$("[role='radiogroup']").find((g) => g.getAttribute("aria-label") === "Dev Mode")!;
    expect($$("label", group).map((l) => l.textContent?.trim())).toEqual(["Status changes", "Nothing"]);
    expect($("[role='radio'][aria-checked='true']", group)?.closest("label")?.textContent?.trim()).toBe("Status changes");
    await click($$("label", group)[1].querySelector("[role='radio']")!);
    await settle();
    expect($("[role='radio'][aria-checked='true']", group)?.closest("label")?.textContent?.trim()).toBe("Nothing");
  });

  it("Agents: the Agents tab's settings list, with the modal's host", async () => {
    await open("agents");
    await settle();
    expect($("[data-agent-settings]")).not.toBeNull();
    expect($("[data-provider='claude-code']")?.textContent).toContain("Connected");
    expect($("[data-client='cursor']")?.textContent).toContain("Connected");
  });
});
