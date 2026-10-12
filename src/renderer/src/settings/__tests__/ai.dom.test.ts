// @vitest-environment happy-dom
/**
 * Settings › AI and the AI balance modal (docs/ai.md §7): the balance meter against Monthly credits (and an org's
 * limit), saving each change through main's `ai:set-settings`, the image keys, the local models' sizes and states, and
 * the usage history — with the store's real ledger (AiService on a memory host) behind a mocked `@/store`.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSetupApi } from "@shared/ai/api";
import { DEFAULT_AI_SETTINGS, type AiModelInfo, type AiModelState, type AiSettings } from "@shared/ai/types";
import { DEFAULT_ORG_SETTINGS, type OrgSettings } from "@shared/org/types";
import { $, $$, mount, type, type Mounted } from "@/ds/__tests__/dom";
import { AiService, type AiStoreHost } from "../../../../store/ai/service";

const files = new Map<string, string>();
let orgs: { id: string; role: "admin" | "member" | "guest"; settings: OrgSettings }[] = [];
const host: AiStoreHost = {
  read: async (n) => files.get(n) ?? null,
  write: async (n, t) => void files.set(n, t),
  remove: async (n) => void files.delete(n),
  list: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
  server: { signedIn: false, userId: null, request: async () => new Response(null, { status: 503 }) },
  getMeta: () => null,
  newId: () => Math.random().toString(36).slice(2, 10),
  now: () => Date.now(),
  timers: { setTimeout: () => 0, clearTimeout: () => {} },
  log: () => {},
};
let ledger = new AiService(host);
vi.mock("@/store", () => ({
  // The modal asks whether the account operates the server (Settings › Operator): no account here
  storeMode: () => "desktop",
  getStoreClient: () => ({
    ai: ledger.repository(),
    orgs: {
      list: async () => orgs.map((o) => ({ id: o.id, name: o.id, role: o.role, seat: "full", workspaceId: null })),
      get: async (id: string) => ({ id, settings: orgs.find((o) => o.id === id)!.settings }),
    },
  }),
}));

const { closeSettings, openSettings } = await import("../bridge");
const { SettingsHost } = await import("../SettingsModal");
const { closeAiBalance } = await import("../AiBalance");

let m: Mounted | null = null;
beforeEach(() => {
  files.clear();
  orgs = [];
  ledger = new AiService(host);
});
afterEach(() => {
  act(() => closeSettings());
  act(() => closeAiBalance());
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
const button = (label: string, root: ParentNode = document) => $$("button", root).find((b) => b.textContent?.trim() === label)!;
const toggle = (label: string) => $$('[role="switch"]').find((s) => s.getAttribute("aria-label") === label) as HTMLButtonElement;
const field = (label: string) => $$("input").find((i) => i.getAttribute("aria-label") === label) as HTMLInputElement;

const INFO: AiModelInfo[] = [
  { id: "isnet", label: "ISNet", use: "Remove background", license: "Apache-2.0", repo: "imgly/isnet-general-onnx", revision: "", files: [], bytes: 88_200_000 },
  { id: "minilm-l6", label: "all-MiniLM-L6-v2", use: "Search", license: "Apache-2.0", repo: "Xenova/all-MiniLM-L6-v2", revision: "", files: [], bytes: 23_000_000 },
];

function fakeAi(opts: { models?: "fail" } = {}) {
  let settings: AiSettings = structuredClone(DEFAULT_AI_SETTINGS);
  const patches: unknown[] = [];
  const keys: [string, string | null][] = [];
  const downloads: string[] = [];
  let stateCb: ((s: AiModelState) => void) | null = null;
  const ai: AiSetupApi = {
    settings: async () => settings,
    setSettings: async (patch) => (patches.push(patch), (settings = { ...settings, ...patch })),
    setImageKey: async (provider, key) => (keys.push([provider, key]), (settings = { ...settings, imageKeys: { ...settings.imageKeys, [provider]: key !== null } })),
    models: async () => (opts.models === "fail" ? Promise.reject(new Error("no")) : { info: INFO, state: [{ id: "isnet", state: "ready", bytes: INFO[0].bytes }] }),
    modelDownload: async (id) => {
      downloads.push(id);
      const s: AiModelState = { id, state: "downloading", received: 11_500_000, bytes: 23_000_000 };
      stateCb?.(s);
      return s;
    },
    modelRemove: async (id) => ({ id, state: "absent", bytes: 0 }),
    onModelState: (cb) => ((stateCb = cb), () => (stateCb = null)),
  };
  const agents = { providers: async () => [{ id: "claude-code", kind: "claude-code", label: "Claude Code", available: true, models: ["opus", "sonnet"] }, { id: "codex", kind: "codex", label: "Codex", available: false, models: [] }] };
  (window as unknown as { designer: unknown }).designer = { ai, agents };
  return { patches, keys, downloads, get settings() { return settings; } };
}

async function openAiTab() {
  m = mount(SettingsHost, {});
  act(() => openSettings("ai"));
  await settle();
  await settle();
}

describe("Settings › AI", () => {
  it("shows the month's credits against Monthly credits, and saves each change at once", async () => {
    const f = fakeAi();
    await ledger.record({ action: "add-interactions", providerId: "claude-code", input: 0, output: 0, images: 0, credits: 20, fileKey: null, orgId: null, local: false, ok: true });
    await openAiTab();
    expect($('[data-settings-tab="ai"]')?.textContent).toBe("AI");
    expect($("[data-ai-used]")?.textContent).toBe("20 of 4,250 credits used this month");
    expect($('[data-ai-meter] [role="meter"]')?.getAttribute("aria-valuenow")).toBe("20");
    // The allowance raised
    const credits = field("Monthly credits");
    act(() => credits.focus());
    type(credits, "10,000");
    await act(async () => credits.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(f.patches).toContainEqual({ monthlyCredits: 10000 });
    expect($("[data-ai-used]")?.textContent).toBe("20 of 10,000 credits used this month");
    // Stop when credits run out: on by default (owner §10.3)
    expect(toggle("Stop when credits run out").getAttribute("aria-checked")).toBe("true");
    click(toggle("Stop when credits run out"));
    await settle();
    expect(f.settings.stopAtLimit).toBe(false);
    click(toggle("Use AI features"));
    await settle();
    expect(f.patches).toContainEqual({ enabled: false });
  });

  it("lowers the allowance to an organization's limit and says so", async () => {
    fakeAi();
    orgs = [{ id: "acme", role: "member", settings: { ...DEFAULT_ORG_SETTINGS, aiCreditLimit: 1000 } }];
    await openAiTab();
    expect($("[data-ai-used]")?.textContent).toBe("0 of 1,000 credits used this month");
    expect($("[data-ai-org]")?.textContent).toBe("Your organization allows 1,000 credits a month.");
  });

  it("saves and removes image keys, lists local models with their sizes and states", async () => {
    const f = fakeAi();
    await openAiTab();
    const openai = $('[data-ai-key="openai"]')!;
    expect(openai.textContent).toContain("Not set");
    type($$("input", openai)[0] as HTMLInputElement, "sk-test");
    await settle();
    click(button("Save", openai));
    await settle();
    expect(f.keys).toEqual([["openai", "sk-test"]]);
    expect($('[data-ai-key="openai"]')!.textContent).toContain("Saved in your keychain");
    click(button("Remove key", $('[data-ai-key="openai"]')!));
    await settle();
    expect(f.keys.at(-1)).toEqual(["openai", null]);
    const rows = $$("[data-ai-model]");
    expect(rows.map((r) => [r.getAttribute("data-ai-model"), r.getAttribute("data-state")])).toEqual([
      ["isnet", "ready"],
      ["minilm-l6", "absent"],
    ]);
    expect(rows[0].textContent).toContain("88.2 MB");
    expect(rows[0].textContent).toContain("Downloaded");
    click(button("Download", rows[1]));
    await settle();
    expect(f.downloads).toEqual(["minilm-l6"]);
    expect($('[data-ai-model="minilm-l6"]')!.textContent).toContain("Downloading… 50%");
  });

  it("says when local models aren't there yet, and when AI runs only in the desktop app", async () => {
    fakeAi({ models: "fail" });
    await openAiTab();
    expect($('[data-ai-models="unavailable"]')?.textContent).toBe("Local models aren't available in this version yet.");
    m?.unmount();
    act(() => closeSettings());
    delete (window as unknown as { designer?: unknown }).designer;
    await openAiTab();
    expect($("[data-settings-panel]")?.textContent).toContain("AI runs in the desktop app.");
  });

  it("opens the AI balance with the credits used, remaining, the reset date and the usage history", async () => {
    fakeAi();
    await ledger.record({ action: "make-image", providerId: "antigravity", model: "gemini-3-pro-image", input: 0, output: 0, images: 1, credits: 16, fileKey: null, orgId: null, local: false, ok: true });
    await ledger.record({ action: "rewrite", providerId: "claude-code", input: 4000, output: 1000, images: 0, credits: 2, fileKey: null, orgId: null, local: false, ok: true });
    await openAiTab();
    click($("[data-ai-open-balance]")!);
    await settle();
    const dialog = $("[data-ai-balance]")!;
    expect($('[data-ai-figure="used"]', dialog)?.textContent).toBe("18");
    expect($('[data-ai-figure="remaining"]', dialog)?.textContent).toBe("4,232");
    expect(dialog.textContent).toMatch(/Resets [A-Z][a-z]+ 1/);
    expect($$("[data-ai-history] tbody tr", dialog).map((r) => r.children[1].textContent)).toEqual(["Rewrite this...", "Make an image"]);
  });
});
