// @vitest-environment happy-dom
/**
 * The Agents panel as the owner reads one agent's work (2026-10-22): the steps open by default (each a quiet line with
 * its detail), a group folds to "· N steps"; the run pinned above the composer (header, phases, steps, its bar), folded
 * to one line once over; a message typed during the run queued and sent when it ends; the agents' own marks; the gear's
 * "This chat" popover and All settings' modal with the settings pages moved into it. On the real engine, with a fake
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
    turn: async (req: TurnRequest) => (turns.push(req), { turnId: `T${turns.length}` }),
    stop: async (turnId: string) => void stopped.push(turnId),
  } as unknown as AgentsApi;
  const emit = (turnId: string, event: ChatEvent) => act(() => listeners.forEach((l) => l({ turnId, chatId: "", event })));
  return { api, turns, stopped, emit };
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

  it("the gear opens This chat; All settings opens the modal with the settings pages in it", async () => {
    const { view, engine } = await setup();
    click($("[data-agents-settings]")!);
    await settle();
    const pop = $("[data-chat-settings]")!;
    expect(pop).not.toBeNull();
    expect($("[data-chat-manager]", pop)?.getAttribute("aria-checked")).toBe("false");
    expect($("[data-model-menu]", pop)).not.toBeNull();
    expect($("[data-chat-effort]", pop)).not.toBeNull();
    click($("[data-all-settings]", pop)!);
    await settle();
    expect($("[data-chat-settings]")).toBeNull();
    const modal = $("[data-agent-settings-modal]")!;
    expect(modal).not.toBeNull();
    expect($$("[data-settings-tab]").map((t) => t.getAttribute("data-settings-tab"))).toEqual(["agents", "manager", "skills", "connectors", "access", "usage"]);
    // Agents and models: the agents' rows with their own marks; a row opens its page in place, Back to the section.
    expect($('[data-provider="claude-code"] [data-agent-logo="claude-code"]')).not.toBeNull();
    expect($('[data-provider="codex"] [data-agent-logo="codex"]')).not.toBeNull();
    click($('[data-provider="codex"]')!);
    await settle();
    expect($("[data-settings-page]")?.getAttribute("data-settings-page")).toBe("provider:codex");
    click($('[data-settings-tab="manager"]')!);
    await settle();
    expect($("[data-agent-settings-modal]")?.getAttribute("data-settings-section")).toBe("manager");
    expect($("[data-manager-agent]")).not.toBeNull();
    click($('[data-settings-tab="skills"]')!);
    await settle();
    expect($("[data-settings-page]")?.getAttribute("data-settings-page")).toBe("skills");
    click($('[data-settings-tab="connectors"]')!);
    await settle();
    expect($('[data-settings-row="mcp"]')).not.toBeNull();
    click($('[data-settings-tab="usage"]')!);
    await settle();
    expect($('[data-usage-agent="claude-code"]')).not.toBeNull();
    // The panel stays the chat under it.
    expect($("[data-agents]")?.getAttribute("data-view")).not.toBe("settings");
    expect($("[data-composer]")).not.toBeNull();
    view.unmount();
    engine.destroy();
  });

  it("This chat groups its rows in boxed sections and shows a usage card per agent", async () => {
    const { view, engine, emit } = await setup();
    await sendText("Make the mobile version");
    emit("T1", { type: "usage", usage: { input: 1200, output: 300 } });
    click($("[data-agents-settings]")!);
    await settle();
    const pop = $("[data-chat-settings]")!;
    // Model first, Usage last (Skills between them: the default skills).
    const sections = $$("[data-chat-section]", pop).map((s) => s.getAttribute("data-chat-section"));
    expect(sections[0]).toBe("model");
    expect(sections[sections.length - 1]).toBe("usage");
    expect($('[data-chat-section="model"] [data-chat-manager]', pop)).not.toBeNull();
    // Claude Code reports no plan limits here: this chat's tokens, an empty bar.
    const card = $('[data-chat-usage="claude-code"]', pop)!;
    expect(card.textContent).toContain("1.5k tokens");
    expect($('[data-agent-logo="claude-code"]', card)).not.toBeNull();
    expect($('[data-chat-usage="codex"]', pop)).toBeNull();
    expect($("[data-all-settings]", pop)).not.toBeNull();
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
