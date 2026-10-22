// @vitest-environment happy-dom
/**
 * The Agents panel as the owner reads one agent's work (2026-10-22): the steps open by default (each a quiet line with
 * its detail), a group folds to "· N steps"; the run pinned above the composer (header, phases, steps, its bar), folded
 * to one line once over; a message typed during the run queued and sent when it ends; the agents' own marks; the gear's
 * Agent settings inside the panel (its home: This chat, the pages, usage cards; a page and Back; a deep link). On the real engine, with a fake
 * agents backend (window.__designerAgents). And the pinned progress for a manager's three tasks, from a chat as kept.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { fonts } from "@/engine/fonts";
import { $, $$, click, key, mount } from "@/ds/__tests__/dom";
import { DEFAULT_MANAGER_SETTINGS } from "@shared/studio/types";
import type { AgentSettings, AgentsApi, ChatEvent, ProviderInfo, TurnEvent, TurnRequest } from "@shared/agents/types";
import type { ConnectorConsent } from "@shared/ai/types";
import type { Attachment } from "@shared/agents/attachments";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { PROTOTYPE_DOCUMENT } from "../fixtures";
import { AgentsPanel } from "../panels/agents/AgentsPanel";
import { RunDock } from "../panels/agents/RunDock";
import { runProgress } from "../agents/progress";
import type { AgentsService, Chat, ChatTask } from "../agents/service";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
  vi.spyOn(fonts, "missing").mockReturnValue([]);
});

const CLAUDE: ProviderInfo = { id: "claude-code", kind: "claude-code", label: "Claude Code", available: true, models: ["sonnet", "opus"], efforts: ["medium", "high"], auth: { state: "connected" } } as ProviderInfo;
const CODEX: ProviderInfo = { id: "codex", kind: "codex", label: "Codex", available: true, models: ["gpt-5.5"], auth: { state: "connected" } } as ProviderInfo;

const SHOT: Attachment = { id: "a1", name: "Login screenshot.png", mime: "image/png", size: 52_000, path: "/work/c/attachments/a1-Login screenshot.png", thumb: "data:image/png;base64,THUMB" };
const BRIEF: Attachment = { id: "a2", name: "Brief for the mobile version.pdf", mime: "application/pdf", size: 2048, path: "/work/c/attachments/a2-brief.pdf" };

function backend() {
  const listeners = new Set<(e: TurnEvent) => void>();
  const turns: TurnRequest[] = [];
  const stopped: string[] = [];
  let settings: AgentSettings = { providerId: "claude-code", models: {}, custom: [], manager: { ...DEFAULT_MANAGER_SETTINGS, enabled: false } };
  const api = {
    onEvent: (cb: (e: TurnEvent) => void) => (listeners.add(cb), () => void listeners.delete(cb)),
    onToolCall: () => () => {},
    onMcpState: () => () => {},
    onConsent: () => () => {},
    mcp: async () => ({ running: true, url: "http://127.0.0.1:3845/mcp", connections: [] }),
    clients: async () => [],
    providers: async () => [CLAUDE, CODEX],
    settings: async () => settings,
    setSettings: async (patch: Partial<AgentSettings>) => (settings = { ...settings, ...patch }),
    usage: async () => null,
    pickAttachments: async () => ({ attachments: [SHOT, BRIEF], errors: [] }),
    attachmentPreview: async (path: string) => (path === SHOT.path ? "data:image/png;base64,LARGE" : null),
    turn: async (req: TurnRequest) => (turns.push(req), { turnId: `T${turns.length}` }),
    stop: async (turnId: string) => void stopped.push(turnId),
  } as unknown as AgentsApi;
  const emitRaw = (turnId: string, event: ChatEvent) => listeners.forEach((l) => l({ turnId, chatId: "", event }));
  const emit = (turnId: string, event: ChatEvent) => act(() => emitRaw(turnId, event));
  return { api, turns, stopped, emit, emitRaw };
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));

async function setup() {
  const b = backend();
  (window as unknown as { __designerAgents?: AgentsApi }).__designerAgents = b.api;
  localStorage.clear();
  const source = memoryDocumentSource(PROTOTYPE_DOCUMENT, { fileName: `Agents ${Math.random()}` });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const View = () => createElement(EditorContext.Provider, { value: ed }, createElement(AgentsPanel));
  const view = mount(View, {});
  await settle();
  return { ...b, ed, engine, view };
}

function typeInto(el: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const input = () => $("[data-agents-input]") as HTMLTextAreaElement;
const sendText = async (text: string) => {
  typeInto(input(), text);
  key(input(), "Enter");
  await settle();
};
const dockTitle = () => $("[data-dock-title]")?.textContent ?? "";
const phases = () => $$("[data-phase-state]").map((p) => `${p.textContent}:${p.getAttribute("data-phase-state")}`);

describe("the Agents panel: one agent's work in view", () => {
  it("shows the steps open, the run pinned above the composer, and sends a queued message when the run ends", async () => {
    const { turns, emit, view, engine } = await setup();
    await sendText("Make the mobile version");
    expect(turns).toHaveLength(1);
    expect(turns[0].providerId).toBe("claude-code");
    // The answer's name line carries the agent's own mark.
    expect($('[data-agent-name] [data-agent-logo="claude-code"]')).not.toBeNull();
    // Running, before any step: the pinned progress says who works, Started, no count known.
    expect($("[data-run-dock]")?.getAttribute("data-run-dock")).toBe("agent");
    expect(dockTitle()).toBe("Claude Code is working");
    expect(phases()[0]).toBe("Started:on");
    emit("T1", { type: "tool", id: "a", name: "get_design_context", state: "running" });
    emit("T1", { type: "tool", id: "a", name: "get_design_context", state: "done", summary: "Login screen · 1440 wide, 12 layers" });
    emit("T1", { type: "tool", id: "b", name: "create_nodes", state: "running" });
    // The steps are open without a click, each a line with its detail.
    expect($("[data-group-steps]")).not.toBeNull();
    expect($$("[data-group-steps] [data-tool]").map((s) => s.getAttribute("data-tool"))).toEqual(["get_design_context", "create_nodes"]);
    expect($('[data-tool="get_design_context"] [data-tool-detail]')?.textContent).toBe("Login screen · 1440 wide, 12 layers");
    expect($("[data-step-group] [data-agent-logo=claude-code]")).not.toBeNull();
    // Working: the step count so far and an indeterminate bar (no agent says how many steps it will take).
    expect(phases().slice(0, 2)).toEqual(["Started:done", "Working:on"]);
    expect($("[data-dock-count]")?.textContent).toBe("1 step");
    expect($("[data-indeterminate]")).not.toBeNull();
    expect($("[data-dock-pct]")).toBeNull();
    // A message typed now waits: Stop is the button, the queue line shows it, nothing is sent yet.
    expect($("[data-agents-stop]")).not.toBeNull();
    await sendText("Also the tablet one");
    expect($("[data-queued]")?.textContent).toContain("Also the tablet one");
    expect(turns).toHaveLength(1);
    expect(input().value).toBe("");
    emit("T1", { type: "tool", id: "b", name: "create_nodes", state: "done", summary: '{"summary":"create_nodes: everything applied.","created":[]}' });
    expect($('[data-tool="create_nodes"] [data-tool-detail]')?.textContent).toBe("create_nodes: everything applied.");
    emit("T1", { type: "text", delta: "Done: the mobile version is to the right." });
    expect(phases()[3]).toBe("Check:on");
    emit("T1", { type: "done" });
    await settle();
    // The turn over: the queued message went, as the next turn.
    expect(turns).toHaveLength(2);
    expect(turns[1].prompt).toBe("Also the tablet one");
    expect($("[data-queued]")).toBeNull();
    emit("T2", { type: "done" });
    await settle();
    view.unmount();
    engine.destroy();
  });

  it("keeps a queued message while the panel shows settings or the list, and sends it into its chat when the run ends", async () => {
    const { turns, emit, view, engine } = await setup();
    await sendText("Make the mobile version");
    await sendText("Also the tablet one");
    expect($("[data-queued]")?.textContent).toContain("Also the tablet one");
    // Agent settings and back: still queued.
    click($("[data-agents-settings]")!);
    await settle();
    click($("[data-tab-header-back]")!);
    await settle();
    expect($("[data-queued]")?.textContent).toContain("Also the tablet one");
    // The list (the chat's composer gone); the run ends there: the message goes into its chat all the same.
    click($("[data-tab-header-back]")!);
    await settle();
    expect($("[data-chats]")).not.toBeNull();
    emit("T1", { type: "done" });
    await settle();
    expect(turns).toHaveLength(2);
    expect(turns[1].prompt).toBe("Also the tablet one");
    expect(turns[1].chatId).toBe(turns[0].chatId);
    emit("T2", { type: "done" });
    await settle();
    view.unmount();
    engine.destroy();
  });

  it("a turn main ends before its id comes back (AI off) shows its error and isn't left running", async () => {
    const b = await setup();
    // Main refuses the turn at once: its error and done reach the view before turn() resolves.
    (b.api as { turn: AgentsApi["turn"] }).turn = async (req: TurnRequest) => {
      b.turns.push(req);
      const turnId = `T${b.turns.length}`;
      act(() => {
        b.emitRaw(turnId, { type: "error", message: "AI is turned off in Settings › AI." });
        b.emitRaw(turnId, { type: "done" });
      });
      return { turnId };
    };
    await sendText("Make the mobile version");
    await settle();
    const answer = $('[data-message="assistant"]')!;
    expect(answer.getAttribute("data-state")).toBe("error");
    expect(answer.textContent).toContain("AI is turned off");
    expect($("[data-agents-stop]")).toBeNull();
    b.view.unmount();
    b.engine.destroy();
  });

  it("drops a queued message removed with its ✕", async () => {
    const { turns, emit, view, engine } = await setup();
    await sendText("Make the mobile version");
    await sendText("Also the tablet one");
    click($("[data-queued-remove]")!);
    await settle();
    expect($("[data-queued]")).toBeNull();
    emit("T1", { type: "done" });
    await settle();
    expect(turns).toHaveLength(1);
    view.unmount();
    engine.destroy();
  });

  it("folds the pinned run to one line once over; a step group folds to its count", async () => {
    const { emit, view, engine } = await setup();
    await sendText("Rename these layers");
    emit("T1", { type: "tool", id: "a", name: "get_metadata", state: "running" });
    emit("T1", { type: "tool", id: "a", name: "get_metadata", state: "done" });
    emit("T1", { type: "tool", id: "b", name: "update_nodes", state: "running" });
    emit("T1", { type: "tool", id: "b", name: "update_nodes", state: "done" });
    emit("T1", { type: "done" });
    await settle();
    expect(dockTitle()).toMatch(/^Claude Code finished · \d+s$/);
    expect($("[data-dock-phases]")).toBeNull();
    click($("[data-dock-toggle]")!);
    expect(phases().every((p) => p.endsWith(":done"))).toBe(true);
    expect($("[data-dock-count]")?.textContent).toBe("2 steps");
    expect($("[data-dock-pct]")?.textContent).toBe("100%");
    // The group: open, then folded by its chevron to "· 2 steps".
    expect($("[data-group-count]")?.textContent).toBe("· 2 steps");
    click($("[data-group-toggle]")!);
    expect($("[data-group-steps]")).toBeNull();
    click($("[data-group-toggle]")!);
    expect($("[data-group-steps]")).not.toBeNull();
    view.unmount();
    engine.destroy();
  });

  const header = () => $("[data-tab-header]")?.getAttribute("data-tab-header");
  const page = () => $("[data-settings-page]")?.getAttribute("data-settings-page");
  const back = async () => {
    click($("[data-tab-header-back]")!);
    await settle();
  };
  const nav = async (id: string) => {
    click($(`[data-settings-nav="${id}"]`)!);
    await settle();
  };

  it("the gear opens Agent settings in the panel: the pages and the usage cards; a page opens in place, Back returns", async () => {
    const { view, engine, emit } = await setup();
    await sendText("Make the mobile version");
    emit("T1", { type: "usage", usage: { input: 1200, output: 300 } });
    click($("[data-agents-settings]")!);
    await settle();
    // No modal, no popover: the panel's header is Back and "Agent settings", the home in the chat's place.
    expect($('[role="dialog"]')).toBeNull();
    expect(header()).toBe("Agent settings");
    expect($("[data-tab-header-back]")).not.toBeNull();
    expect($("[data-composer]")).toBeNull();
    expect(page()).toBe("home");
    // No "This chat" section: the model and effort are the composer's.
    expect($("[data-chat-settings]")).toBeNull();
    expect($$("[data-settings-nav]").map((r) => r.getAttribute("data-settings-nav"))).toEqual(["agents", "manager", "skills", "connectors", "access", "usage"]);
    // Nav rows: icon, title and chevron — no description line; no boxes anywhere but the usage cards.
    expect($$("[data-settings-nav]").every((r) => !r.querySelector('[class*="mRowDesc"]'))).toBe(true);
    expect($$('[data-agent-settings] [class*="Box"]')).toEqual([]);
    expect($$("[data-settings-list]").length).toBeGreaterThan(0);
    // Usage cards: one under another (a stack, not a grid). Claude Code reports no plan limits here — this chat's tokens; Codex has none to show.
    expect($('[data-usage-stack] [data-chat-usage="claude-code"]')?.parentElement?.className).toMatch(/usageStack/);
    const card = $('[data-chat-usage="claude-code"]')!;
    expect(card.textContent).toContain("1.5k tokens");
    expect($('[data-agent-logo="claude-code"]', card)).not.toBeNull();
    expect($('[data-chat-usage="codex"]')).toBeNull();
    // Agents and models: flat rows — each its mark and a green dot when connected (no "Connected" text, no model or
    // effort select); the whole row opens its page, its Install / Sign in button doesn't.
    await nav("agents");
    expect(header()).toBe("Agents and models");
    expect(page()).toBe("agents");
    expect($('[class*="mAbout"]')).toBeNull();
    const agentsBox = $('[data-settings-box="agents"]')!;
    expect($('[data-provider="claude-code"] [data-agent-logo="claude-code"]', agentsBox)).not.toBeNull();
    expect($('[data-provider="claude-code"] [data-provider-on]', agentsBox)).not.toBeNull();
    expect($('[data-provider="claude-code"]', agentsBox)?.textContent).not.toContain("Connected");
    expect($('[data-provider-model], [data-effort-menu], [role="combobox"], select', agentsBox)).toBeNull();
    expect($('[data-settings-box="local"]')).not.toBeNull();
    click($('[data-provider="codex"]')!);
    await settle();
    expect(page()).toBe("provider:codex");
    expect(header()).toBe("Codex");
    await back();
    expect(page()).toBe("agents");
    await back();
    expect(page()).toBe("home");
    // Manager and Studio, Skills (New skill in the header), Connectors, Access, Usage.
    await nav("manager");
    expect($('[data-settings-box="manager"] [data-manager-agent]')).not.toBeNull();
    expect($('[data-settings-box="parallel"] [data-manager-parallel]')).not.toBeNull();
    await back();
    await nav("skills");
    expect($('[data-settings-box="skills"]')).not.toBeNull();
    expect($("[data-tab-header] [data-new-skill]")).not.toBeNull();
    await back();
    await nav("connectors");
    expect($('[data-settings-box="apps"] [data-settings-row="mcp"]')).not.toBeNull();
    await back();
    await nav("usage");
    expect($('[data-settings-box="usage"] [data-usage-agent="claude-code"]')).not.toBeNull();
    expect($('[data-usage-agent="codex"] [data-usage-today]')).not.toBeNull();
    await back();
    // Back from the home: the chat as it was.
    await back();
    expect($("[data-agent-settings]")).toBeNull();
    expect($("[data-composer]")).not.toBeNull();
    expect(header()).toBe("Make the mobile version");
    emit("T1", { type: "done" });
    await settle();
    view.unmount();
    engine.destroy();
  });

  it("openSetting from elsewhere opens that page in the panel; a detail's Back goes to its page", async () => {
    const { view, engine, ed } = await setup();
    const service = (await import("../agents/service")).agentsOf(ed);
    act(() => service.openSetting("add-skill"));
    await settle();
    expect(page()).toBe("add-skill");
    expect(header()).toBe("Add skill");
    await back();
    expect(page()).toBe("skills");
    act(() => service.openSetting("section:connectors"));
    await settle();
    expect(page()).toBe("connectors");
    await back();
    expect(page()).toBe("home");
    await back();
    expect($("[data-agent-settings]")).toBeNull();
    expect($("[data-composer]")).not.toBeNull();
    view.unmount();
    engine.destroy();
  });
});

describe("attachments in a chat", () => {
  it("shows pictures as thumbnails (✕ on hover in the composer, a click opens them larger) and other files as chips", async () => {
    const { view, engine, turns, emit } = await setup();
    click($("[data-attach] button")!);
    await settle();
    click($$('#ds-overlays [role^="menuitem"]').find((i) => i.textContent?.includes("Add files and photos"))!);
    await settle();
    const composer = $("[data-composer]")!;
    // The picture: a square thumbnail of its own picture, with its ✕; the PDF: a chip with its glyph, name and size.
    const tile = $('[data-attachment-tile]', composer)!;
    expect($("img", tile)?.getAttribute("src")).toBe(SHOT.thumb);
    expect($("[data-attachment-remove]", tile)).not.toBeNull();
    const file = $("[data-attachment-file]", composer)!;
    expect(file.textContent).toContain("Brief for the mobile version.pdf");
    expect($("[data-attachment-size]", file)?.textContent).toBe("2 KB");
    expect($("[data-attachment-tile]", file)).toBeNull();
    // A click opens it larger: the thumbnail first, then main's bigger copy; Esc closes it.
    click($("[data-attachment-open]", tile)!);
    await settle();
    expect($("[data-attachment-lightbox] img")?.getAttribute("src")).toBe("data:image/png;base64,LARGE");
    key(document.body, "Escape");
    await settle();
    expect($("[data-attachment-lightbox]")).toBeNull();
    // ✕ removes one; the message carries the rest, shown the same way without ✕.
    click($("[data-attachment-remove]", file)!);
    await settle();
    expect($("[data-attachment-file]", composer)).toBeNull();
    await sendText("Make this mobile");
    expect(turns[0].attachments?.map((a) => a.name)).toEqual([SHOT.name]);
    const sent = $('[data-message="user"] [data-message-attachments]')!;
    expect($("[data-attachment-tile] img", sent)?.getAttribute("src")).toBe(SHOT.thumb);
    expect($("[data-attachment-remove]", sent)).toBeNull();
    click($("[data-attachment-open]", sent)!);
    await settle();
    expect($("[data-attachment-lightbox]")).not.toBeNull();
    click($("[data-lightbox-close]")!);
    await settle();
    expect($("[data-attachment-lightbox]")).toBeNull();
    emit("T1", { type: "done" });
    await settle();
    view.unmount();
    engine.destroy();
  });
});

describe("the chats list and a chat's header", () => {
  it("rows show a short title, one status line and the time; inside a chat the header is back + its title", async () => {
    const { view, engine, emit } = await setup();
    // A new chat: no list to go back to yet, the header is the tab's.
    expect($("[data-tab-header-back]")).toBeNull();
    await sendText("Can you make the mobile version of this login screen?");
    expect($("[data-tab-header]")?.getAttribute("data-tab-header")).toBe("Make the mobile version");
    expect($("[data-tab-header] [data-agents-settings]")).not.toBeNull();
    emit("T1", { type: "text", delta: "Four designs are ready on the canvas. Each has auto layout." });
    emit("T1", { type: "done" });
    await settle();
    click($("[data-tab-header-back]")!);
    await settle();
    expect($("[data-tab-header]")?.getAttribute("data-tab-header")).toBe("Agents");
    const row = $("[data-chat]")!;
    expect($("[data-chat-title]", row)?.textContent).toBe("Make the mobile version");
    expect($("[data-chat-status]", row)?.textContent).toBe("Four designs are ready on the canvas.");
    expect($("[data-chat-time]", row)?.textContent).not.toBe("");
    view.unmount();
    engine.destroy();
  });

  it("the list's header is search, filter and the gear; search takes the title's place until Esc", async () => {
    const { view, engine, emit } = await setup();
    await sendText("Make the mobile version");
    emit("T1", { type: "done" });
    await settle();
    // Inside a chat: back, its title and the gear — no list buttons, no +.
    expect($("[data-tab-header] [data-chats-search-open]")).toBeNull();
    expect($('[data-tab-header] button[aria-label="New chat"]')).toBeNull();
    click($("[data-tab-header-back]")!);
    await settle();
    const header = $("[data-tab-header]")!;
    const labels = $$("button", header).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Search chats", "Filter chats", "Agent settings"]);
    // No search row over the list any more.
    expect($("[data-chats] [data-chats-search]")).toBeNull();
    click($("[data-chats-search-open]")!);
    await settle();
    expect($("[data-tab-header] h2")).toBeNull();
    const field = $("[data-tab-header] [data-chats-search] input") as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    key(field, "Escape");
    await settle();
    expect($("[data-tab-header] h2")?.textContent).toBe("Agents");
    expect($("[data-chats-search]")).toBeNull();
    view.unmount();
    engine.destroy();
  });

  it("a row has no delete button; its context menu renames it in place or deletes it", async () => {
    const { view, engine, emit } = await setup();
    await sendText("Make the mobile version");
    emit("T1", { type: "done" });
    await settle();
    click($("[data-tab-header-back]")!);
    await settle();
    const row = $("[data-chat]")!;
    expect($("button", row)?.getAttribute("aria-label")).toBeNull();
    expect($$("[data-chat] button").length).toBe(1);
    const menuOn = (el: Element) =>
      act(() => {
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
      });
    const items = () => $$('#ds-overlays [role^="menuitem"]');
    menuOn(row);
    expect(items().map((i) => i.textContent?.trim())).toEqual(["Rename", "Delete"]);
    click(items()[0]);
    await settle();
    const input = $("[data-chat-rename]") as HTMLInputElement;
    expect(input.value).toBe("Make the mobile version");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Login, mobile");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    key(input, "Enter");
    await settle();
    expect($("[data-chat-rename]")).toBeNull();
    expect($("[data-chat] [data-chat-title]")?.textContent).toBe("Login, mobile");
    menuOn($("[data-chat]")!);
    click(items()[1]);
    await settle();
    expect($("[data-chat]")).toBeNull();
    view.unmount();
    engine.destroy();
  });
});

// ---- A manager's run, from a chat as kept ----

const task = (id: string, providerId: string, title: string, state: ChatTask["state"], parts: { name: string; state: "running" | "done" | "error" }[], turnId?: string): ChatTask =>
  ({ id, chatId: "c", messageId: "m", kind: "agent", title, route: { providerId }, state, dependsOn: [], startedAt: Date.now() - 20_000, ...(state === "done" ? { endedAt: Date.now() - 1000 } : {}), worker: { parts: parts.map((p, i) => ({ kind: "tool", id: `${id}${i}`, ...p })), state: state === "running" ? "running" : "done", turnId } }) as ChatTask;

function managerChat(): Chat {
  return {
    id: "c",
    title: "Login",
    updatedAt: 0,
    providerId: "claude-code",
    messages: [
      { id: "u", role: "user", text: "Mobile, tablet and the copy" },
      { id: "m", role: "assistant", manager: true, provider: "Manager", providerId: "claude-code", state: "running", turnId: "TM", startedAt: Date.now() - 30_000, parts: [{ kind: "tool", id: "d", name: "delegate_task", state: "done" }] },
    ],
    tasks: [
      task("t1", "claude-code", "Mobile and tablet versions", "running", [{ name: "get_design_context", state: "done" }, { name: "create_nodes", state: "running" }], "W1"),
      task("t2", "codex", "Copy and the price card", "running", [{ name: "get_metadata", state: "done" }, { name: "publish_library", state: "running" }], "W2"),
      task("t3", "claude-code", "Hero picture", "done", [{ name: "place_image", state: "done" }]),
    ],
  } as Chat;
}

function fakeService(consents: ConnectorConsent[] = []) {
  const stopped: string[] = [];
  const service = {
    get: () => ({ consents, providers: [CLAUDE, CODEX] }),
    cardOpen: () => false,
    managerSettings: () => DEFAULT_MANAGER_SETTINGS,
    stopTask: (id: string) => void stopped.push(id),
  } as unknown as AgentsService;
  return { service, stopped };
}

describe("the pinned progress of a manager's run", () => {
  it("reads the run: agents working, an approval waiting, the tasks done of all", () => {
    const consent = { reqId: 1, turnId: "W2", connectorId: "app", connector: "Wecra", tool: "publish_library", args: {} } as ConnectorConsent;
    const p = runProgress(managerChat(), { running: true, consents: [consent] })!;
    expect(p.manager).toBe(true);
    expect(p.working).toBe(2);
    expect(p.waiting).toBe(1);
    expect(p.phases.map((x) => `${x.label}:${x.state}`)).toEqual(["Planned:done", "Agents working:done", "Approval:on", "Reviewing:todo", "Ready:todo"]);
    expect([p.done, p.total, p.pct, p.unit]).toEqual([1, 3, 33, "tasks"]);
    expect(p.rows.map((r) => [r.title, r.providerId, r.waiting, r.step, r.steps])).toEqual([
      ["Mobile and tablet versions", "claude-code", false, "Creating layers…", 1],
      ["Copy and the price card", "codex", true, "Waiting for approval", 1],
      ["Hero picture", "claude-code", false, "Placed an image", 1],
    ]);
  });

  it("draws a row per agent with its mark, its step and Stop; a click shows its card", () => {
    const { service, stopped } = fakeService();
    const revealed: string[] = [];
    const view = mount(RunDock, { service, chat: managerChat(), running: true, onReveal: (id: string) => void revealed.push(id) });
    expect($("[data-dock-title]")?.textContent).toBe("2 agents working");
    expect($("[data-dock-count]")?.textContent).toBe("1/3 tasks");
    expect($("[data-dock-pct]")?.textContent).toBe("33%");
    const rows = $$("[data-dock-row]");
    expect(rows).toHaveLength(3);
    expect($('[data-agent-logo="codex"]', rows[1])).not.toBeNull();
    expect(rows[0].textContent).toContain("Claude Code ·");
    expect(rows[0].textContent).toContain("Creating layers…");
    expect(rows[2].getAttribute("data-task-state")).toBe("done");
    click($("[data-dock-stop]", rows[1])!);
    expect(stopped).toEqual(["t2"]);
    expect(revealed).toEqual([]);
    click(rows[2]);
    expect(revealed).toEqual(["t3"]);
    view.unmount();
  });
});
